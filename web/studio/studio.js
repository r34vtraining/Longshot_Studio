/* H3 Long Shot Studio — browser side.
 *
 * Talks to the Studio's own routes (/longshot/...) for building graphs and
 * saving projects, and to ComfyUI's endpoints for everything else:
 * /prompt (queue), /ws (progress), /history/<id> (outputs), /view (files),
 * /interrupt (Stop).
 *
 * A render always queues the chain of active Shots up to the target; Long
 * Shot reuses every unchanged earlier segment from memory.
 */
"use strict";

const $ = (id) => document.getElementById(id);
const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ESC[c]);
const FPS = 24;
const SEED_MAX = 4294967295;           // rerolls draw from 0 … 2^32 − 1
const CORE_NODES = ["MiniMaxH3Shot", "MiniMaxH3Subject", "MiniMaxH3RefPromptBuilder",
  "MiniMaxH3LongShot", "MiniMaxH3SigmaShift", "ImageScaleToMaxDimension", "MiniMaxH3SaveVideo"];

/** Seconds from "13.67", "0:13.67" or "1:02:03.5" (hours:minutes:seconds). */
function parseTC(v) {
  const str = String(v ?? "").trim();
  if (!str) return 0;
  const parts = str.split(":").map((x) => x.trim());
  if (parts.length > 3 || parts.some((x) => !/^\d*\.?\d+$/.test(x))) return NaN;
  return parts.reduce((acc, x) => acc * 60 + Number(x), 0);
}

/** Snapped to a whole frame. */
const toFrame = (t) => Math.round((Number(t) || 0) * FPS) / FPS;

/** Player times, in seconds (0.10.0, like the Shots' Seconds field): 00:13.67. */
function fmt(t) {
  t = Math.max(0, t || 0);
  const m = Math.floor(t / 60), s = t - m * 60;
  return String(m).padStart(2, "0") + ":" + s.toFixed(2).padStart(5, "0");
}

function store(key, value) {           // browser storage: conveniences only
  try {
    if (value === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, value);
  } catch (e) { /* private window etc. */ }
  return null;
}

/** Plan and Queue fold down to one line (kept per browser). */
function applyFolds() {
  let f = {};
  try { f = JSON.parse(store("h3studio.folds") || "{}") || {}; } catch (e) { f = {}; }
  for (const k of ["plan", "queue", "cast", "shots"]) {
    const panel = document.getElementById(k + "-panel"), btn = panel && panel.querySelector("[data-fold]");
    if (!panel) continue;
    panel.classList.toggle("folded", !!f[k]);
    if (btn) { btn.setAttribute("aria-expanded", String(!f[k])); btn.title = f[k] ? "Show everything" : "Show only one line"; }
  }
}
function toggleFold(k) {
  let f = {};
  try { f = JSON.parse(store("h3studio.folds") || "{}") || {}; } catch (e) { f = {}; }
  f[k] = !f[k];
  store("h3studio.folds", JSON.stringify(f));
  applyFolds();
  if (k === "vsr") renderSettings();
  if (k.startsWith("face-")) renderFace();        // 0.15.1: the Face refine cards fold too
}
/** Is this zone folded in this browser? (Plan, Queue, the Upscale settings) */
function folded(k) {
  try { return !!(JSON.parse(store("h3studio.folds") || "{}") || {})[k]; } catch (e) { return false; }
}

// 0.13.0: several Studio tabs at once. Each tab has its own id (ComfyUI sends a run's
// progress to the tab that queued it) and its own queue; "h3studio.tabs" lists the open
// tabs ({id: {t, slug}}, a heartbeat every 2 s) so tabs can tell each other apart.
const TABS_KEY = "h3studio.tabs", TAB_FRESH = 6000;
const OPEN = { slug: null };
function readTabs() {
  try { return JSON.parse(localStorage.getItem(TABS_KEY) || "{}") || {}; } catch (e) { return {}; }
}
function writeTabs(t) { try { localStorage.setItem(TABS_KEY, JSON.stringify(t)); } catch (e) { /* storage off */ } }
const CLIENT_ID = (() => {
  let id = null;
  try { id = sessionStorage.getItem("h3studio.client"); } catch (e) { /* ignore */ }
  // a duplicated tab copies the session (and this id) from a tab that's still open: a new id.
  // (A reload keeps it: the tab takes itself off the list as it goes.)
  const live = id && readTabs()[id];
  if (live && Date.now() - live.t < TAB_FRESH) id = null;
  if (!id) {
    id = "h3studio-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
    try { sessionStorage.setItem("h3studio.client", id); } catch (e) { /* ignore */ }
  }
  return id;
})();

let uidN = 0;
const uid = (p) => p + Date.now().toString(36) + (uidN++).toString(36);

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const S = {
  project: null, projects: [], opts: null, local: false,
  conn: "connecting", open: null, takes: {}, styleOpen: false, audioOpen: false, advOpen: false, refineOpen: false, faceOpen: false, faceScan: {}, faceScanning: false, settingsOpen: true, uploading: {},
  busy: null, error: null, loop: false, dry: null, saveState: "",
  refState: {}, refInfo: {}, inputs: null, segStats: null, conflict: null, checkedFor: null,
  clips: {},       // timeline clips of this project: key -> {dur, made, thumb}
  clipTried: new Set(),   // takes a clip was already asked for (no endless retries)
  focus: null,     // the Shot picked on the timeline (review, loop, jump)
  gen: 0,          // bumped by every re-queue rule, so an edited Shot only returns to its take if nothing else changed
  bad: {},         // "<shot id>:<field>" -> the field holds something that isn't a value yet (typing)
};
const P = () => S.project;

const DEFAULT_SETTINGS = {
  model: "", clip: "", video_vae: "", audio_vae: "",
  turbo: { on: true, lora: "", strength: 1.0 },
  loras: [0, 1, 2].map(() => ({ on: false, name: null, strength: 1.0 })),
  steps: 8, megapixels: 0.6, aspect: "16:9", ref_image_size: "match", ref_resize_px: 1500,
  sampler: "er_sde", scheduler: "beta", overlap: 22, seed: 1722, seed_mode: "increment",
  shift_video: 12, shift_audio: 3, sage_attention: "auto", save_segments: true,
  rtx_vsr: { on: false, scale: 2, quality: "ULTRA", chunk_s: 10 },   // chunk_s: upscale a chunk at a time
  save_png: false, save_noaudio: false,      // Video Combine's side files: deleted after each render
  prores_master: false,                      // Upscale final also writes a 10-bit ProRes 422 HQ .mov
  multi_take: 1,                             // takes per render: the render runs this many times, new seeds
  // 0.10.0: a refine pass with a second model (e.g. fl2va over ref2va takes), Long Shot 1.7.0+
  refine: { on: false, export_only: false, model: null, steps: 10, denoise: 0.3, shift_video: 12,
    turbo: { on: false, lora: null, strength: 1.0 } },
  // 0.14.0: Face refine, small faces redrawn by H3 as close-ups (Long Shot 1.8.0+)
  face: { on: false, model: null, steps: 10, denoise: 0.3, shift_video: 4,
    turbo: { on: false, lora: null, strength: 1.0 },
    max_face: 150, which: "all", work: 640, padding: 0.8, follow: "auto", mask: 1.0, feather: 0.3,
    color: 1.0, hold_audio: true, seed: 0, describe: "", cast: null },
};

function normalize(p) {
  p.version = p.version || 1;
  p.name = p.name || "Untitled";
  p.cast = (p.cast || []).map((c) => ({ id: c.id || uid("c"), label: c.label || "", desc: c.desc || "",
    role: c.role || "appearance", image: c.image || "", subfolder: c.subfolder || "", type: "input",
    size_bytes: c.size_bytes ?? null, sha256: c.sha256 || null,
    original_name: c.original_name || c.image || "", bypassed: !!c.bypassed,
    voice: c.voice || null }));          // voice reference id: "gets its voice timbre from"
  // voice references: audio cards in Cast & Scenes, <Audio N> after the song's vocals
  // 0.8.6: the song's "Voice reference" route (MelBandRoFormer) is gone: voice cards replace it
  if (p.audio && p.audio.voice_ref) { p.audio.voice_ref = false; p.voice_ref_dropped = true; }
  p.refmods = (p.refmods || []).map((m) => ({ id: m.id || uid("m"), name: m.name || "", kind: ["image", "video", "audio"].includes(m.kind) ? m.kind : "image",
    label: m.label || "", desc: m.desc || "", strength: Math.max(0, Math.min(1, m.strength === undefined ? 1 : Number(m.strength) || 0)),
    voice: m.kind !== "audio" && m.voice ? m.voice : null,   // 0.12.0: a picture / video RefMod's voice
    role: REFMOD_ROLES.includes(m.role) ? m.role : null,       // 0.12.1: its definition (null: by kind)
    bypassed: !!m.bypassed }));
  p.voices = (p.voices || []).map((v) => ({ id: v.id || uid("v"), label: v.label || "", file: v.file || "",
    subfolder: v.subfolder || "", type: "input", original_name: v.original_name || v.file || "",
    sha256: v.sha256 || null, size_bytes: v.size_bytes ?? null, start: Math.max(0, Number(v.start) || 0),
    length: Math.max(0, Number(v.length) || 0), bypassed: !!v.bypassed,
    // 0.12.0: what the audio is for. "voice" (a timbre, linked from pictures / RefMods), or a
    // sound of its own (<sfx> of cars driving by): sfx, ambience, music or your own words
    role: AUDIO_ROLES.some(([k]) => k === v.role) ? v.role : "voice", role_text: v.role_text || "",
    desc: v.desc || "", use: v.use === "copy" ? "copy" : "reference" }));
  p.ref_sets = p.ref_sets && typeof p.ref_sets === "object" ? p.ref_sets : {};      // 0.8.13: restore references
  p.take_refs = p.take_refs && typeof p.take_refs === "object" ? p.take_refs : {};
  p.style = Object.assign({ summary: "", retention: "", style_line: "", soundscape: "", music: "N/A",
    task_types: ["reference generation"] }, p.style || {});
  p.shots = (p.shots || []).map((s) => ({ id: s.id || uid("s"), text: s.text || "",
    seconds: Number(s.seconds) || 5, shot_seed: s.shot_seed ?? -1, bypassed: !!s.bypassed,
    // a Shot on auto stays on auto: the seed its take used, and a one-off seed for its next render
    seed_used: hasSeed(s.seed_used) ? Number(s.seed_used) : null,
    seed_pending: hasSeed(s.seed_pending) ? Number(s.seed_pending) : null,
    status: ["approved", "review", "queued"].includes(s.status) ? s.status : "queued",
    was_approved: !!s.was_approved, was_rendered: !!s.was_rendered,
    prev_seeds: Array.isArray(s.prev_seeds) ? s.prev_seeds.slice(-10) : [],
    take: s.take || null, window: s.window || null, take_seconds: s.take_seconds ?? null,
    // what the current take was rendered with: editing back to exactly this brings the take back
    rendered: s.rendered && typeof s.rendered === "object" ? s.rendered
      : s.take && s.status !== "queued" ? { text: s.text || "", seconds: Number(s.seconds) || 5, seed: s.shot_seed ?? -1 } : null,
    edit_from: s.edit_from && typeof s.edit_from === "object" ? Object.assign({}, s.edit_from, { gen: 0 }) : null,
    join: s.join === "cut" || s.join === "context" ? s.join : "bridge",
    context_from: s.context_from || null,     // Context: the take of the Shot before it was rendered from
    kind: s.kind === "clip" ? "clip" : "shot",
    // 0.9.0: trims and move on the film, in frames (non-destructive)
    place: s.place && typeof s.place === "object" && (s.place.in || s.place.out || s.place.shift)
      ? { in: Math.max(0, Math.round(Number(s.place.in) || 0)), out: Math.max(0, Math.round(Number(s.place.out) || 0)),
        shift: Math.round(Number(s.place.shift) || 0) } : null,
    standalone: !!s.standalone && s.kind !== "clip",   // its take was rendered on its own (no pins)
    render_model: s.render_model || null,              // 0.10.0: the model its take was made with
    // 0.11.0: its take's singing against the song: {take, at, offset, conf}
    align: s.align && typeof s.align === "object" && s.align.take ? s.align : null,
    // 0.12.5: lined up by hand with the song ({key}: the take or clip it was for); locks its place
    aligned: s.aligned && typeof s.aligned === "object" && s.aligned.key ? { key: String(s.aligned.key) } : null,
    // 0.14.0: Face refine: its last try ({take, sig, treated, tracks…}) and which faces it exports with
    face: s.face && typeof s.face === "object" ? s.face : null,
    seam: ["ok", "mismatch"].includes(s.seam) ? s.seam : null,   // its left join, as last known
    cleared: !!s.cleared && s.status === "queued",              // Clear render: waiting to render again
    clip: s.kind === "clip" ? Object.assign({ file: "", subfolder: "", original_name: "", sha256: null,
      size_bytes: null, trim_in: 0, frames: 0, duration: null, fps: null, width: null, height: null,
      has_audio: false, audio: "mute" }, s.clip || {}) : null }));
  for (const s of p.shots) if (s.kind === "clip") s.status = "approved";   // clips are never sampled
  p.audio = Object.assign({ file: null, subfolder: "", type: "input", size_bytes: null, sha256: null,
    original_name: null, start: 0, length: 0, lip_sync: false, voice_ref: false,
    final_override: false, melband_model: "Infinite Talk\\MelBandRoformer_fp16.safetensors" }, p.audio || {});
  // 0.9.1: the song is <Audio 1>, a reference audio like the native ref2v node's. The
  // lip-sync and song-in-final routes are off until they're reworked.
  if (p.audio.song_ref === undefined) p.audio.song_ref = !!p.audio.file;
  p.audio.song_ref = !!p.audio.song_ref;
  p.audio.lip_sync = false;     // 0.9.5: the pinned song is gone from the Studio (no effect on lip timing)
  p.audio.final_override = !!p.audio.final_override;
  p.audio.sync_nudge = Math.max(-240, Math.min(240, Math.round(Number(p.audio.sync_nudge) || 0)));
  // 0.11.0: phrase starts in the song (seconds into the file), and how they're found
  p.audio.phrases = (Array.isArray(p.audio.phrases) ? p.audio.phrases : []).map(Number)
    .filter((x) => Number.isFinite(x) && x >= 0).sort((a, b) => a - b);
  p.audio.phrase_gap = Math.max(0.1, Math.min(3, Number(p.audio.phrase_gap) || 0.5));
  p.audio.phrase_sens = Math.max(0, Math.min(1, p.audio.phrase_sens === undefined ? 0.5 : Number(p.audio.phrase_sens) || 0));
  p.audio.phrase_lead = Math.max(0, Math.min(48, Math.round(Number(p.audio.phrase_lead) || 0)));
  const s = Object.assign({}, DEFAULT_SETTINGS, p.settings || {});
  s.turbo = Object.assign({}, DEFAULT_SETTINGS.turbo, s.turbo || {});
  s.rtx_vsr = Object.assign({}, DEFAULT_SETTINGS.rtx_vsr, s.rtx_vsr || {});
  s.refine = Object.assign({}, DEFAULT_SETTINGS.refine, s.refine || {});
  s.refine.turbo = Object.assign({}, DEFAULT_SETTINGS.refine.turbo, s.refine.turbo || {});
  s.face = Object.assign({}, DEFAULT_SETTINGS.face, s.face || {});
  s.face.turbo = Object.assign({}, DEFAULT_SETTINGS.face.turbo, s.face.turbo || {});
  if (![1.5, 2].includes(Number(s.rtx_vsr.scale))) s.rtx_vsr.scale = 2;   // 1.5× or 2× only
  s.loras = [0, 1, 2].map((i) => Object.assign({ on: false, name: null, strength: 1.0 }, (s.loras || [])[i] || {}));
  p.settings = s;
  p.last_output = p.last_output || null;
  // The stitched, decoded video and the plan it shows. Renders now decode each
  // new take on its own, so the last render's plan and the last video can differ.
  const lo = p.last_output;
  if (lo && lo.video && !lo.video_plan) { lo.video_plan = lo.plan; lo.video_chain = lo.chain; }
  p.stats = p.stats || { rate: null, n: 0 };
  return p;
}

const active = () => P().shots.filter((s) => !s.bypassed);
const liveCast = () => P().cast.filter((c) => !c.bypassed);
/** Voice references that are on (and have a file): <Audio N> in card order, after
 *  the song's vocals when Audio → Voice reference is on. Long Shot takes 3 in all. */
const MAX_AUDIO_REFS = 3;
const liveVoices = () => (P().voices || []).filter((v) => !v.bypassed && v.file);
const voiceById = (id) => (P().voices || []).find((v) => v.id === id) || null;
function audioLabelOf(v) {
  const i = v ? liveVoices().indexOf(v) : -1;
  return i < 0 ? null : `<Audio ${songSlot() + i + 1}>`;
}
/** 0.9.1: the song takes <Audio 1> while its switch is on and a file is chosen. */
const songRefOn = () => !!(P() && P().audio && P().audio.song_ref && P().audio.file);
const songSlot = () => (songRefOn() || P().audio.voice_ref ? 1 : 0);
const audioRefCount = () => liveVoices().length + songSlot();
const numOf = (id) => active().findIndex((s) => s.id === id) + 1;
const titleOf = (s) => (s ? "Shot " + numOf(s.id) : "—");
const reviewShot = () => {
  const f = S.focus && active().find((s) => s.id === S.focus && s.status === "review");
  return f || active().find((s) => s.status === "review");
};
const nextQueued = () => active().find((s) => s.status === "queued");

/** The Shot the main button renders: the first queued one, except that a queued
 *  standalone Shot right after it goes first, so the gap can bridge into it. */
function nextToRender() {
  const nx = nextQueued();
  if (!nx || nx.kind === "clip" || nx.standalone) return nx;
  const act = active();
  const after = act[act.indexOf(nx) + 1];
  return after && after.kind !== "clip" && after.standalone && after.status === "queued" ? after : nx;
}

/** A join that's a hard cut: the seam Long Shot reported for this Shot's left
 *  join in the last render that had both Shots (remembered on the Shot, since a
 *  standalone render shows only one Shot). */
/** Not continued from the Shot before: a Cut, or Context (a cut that takes the
 *  last frame of the Shot before as a reference picture). */
const isCut = (s) => !!s && (s.join === "cut" || s.join === "context");
/** 0.12.1: a RefMod's definition ("whose <role> comes from"); the default follows its kind. */
const REFMOD_ROLES = ["appearance", "motion", "action", "expression", "pose", "costume", "style", "scene",
  "environment", "camera and cut structure"];
const refmodRole = (m) => m.kind === "audio" ? "voice timbre" : (m.role || (m.kind === "video" ? "motion" : "appearance"));
/** 0.12.0: what an audio reference is for, and how the prompt says it. */
const AUDIO_ROLES = [["voice", "Voice timbre"], ["sfx", "Sound effect"], ["ambience", "Ambience"], ["music", "Music"], ["other", "Other…"]];
/** 0.11.0: a placeholder — a Shot (not a clip) with an empty prompt and no take in use.
 *  It never renders and holds its exact length on the film. */
const isEmptyShot = (s) => !!s && s.kind !== "clip" && !String(s.text || "").trim() &&
  !((s.status === "approved" || s.status === "review") && s.take);

/** The join chip: what the user wants at this Shot's joins. Its choices come
 *  from the Shots that exist next to it (0.8.3):
 *    none            → Cut
 *    a Shot before   → Cut, Context, Continuous
 *    a Shot after    → Cut, Continuous
 *  Continuous reads "Bridge" when the Shots on both sides are approved. Kept in
 *  s.join ("cut" | "context" | "bridge"; Continuous is the default). Render all
 *  and the main button read it as the join with the Shot before; ▶ on one Shot
 *  applies it to the rendered Shots next to it at that moment (chipPlan). */
function chipNear(s) {
  const act = active(), i = act.indexOf(s);
  return { prev: i > 0 ? act[i - 1] : null, next: i >= 0 ? act[i + 1] || null : null };
}
function chipSides(s) {
  const act = active(), i = act.indexOf(s);
  // 0.9.0: a neighbour under review counts too (its take is pinned as it is); a Shot
  // queued right behind one still rendering sees its take when its own render starts
  const ok = (x) => !!x && !otherSize(x) && (x.kind === "clip" || ((x.status === "approved" || x.status === "review") && !!x.take));
  return { prev: i > 0 && ok(act[i - 1]) ? act[i - 1] : null, next: i >= 0 && ok(act[i + 1]) ? act[i + 1] : null };
}
function chipOptions(s) {
  const { prev, next } = chipNear(s);
  if (prev) return ["bridge", "context", "cut"];
  if (next) return ["bridge", "cut"];
  return ["cut"];
}
function chipJoin(s) {
  const j = s.join || "bridge";
  return chipOptions(s).includes(j) ? j : "cut";
}
function chipName(s, j = chipJoin(s)) {
  if (j === "bridge") { const { prev, next } = chipSides(s); return prev && next ? "Bridge" : "Continuous"; }
  return j === "context" ? "Context" : "Cut";
}
/** What ▶ does for Shot s, worked out when the render starts:
 *  { alone } a standalone render (Cut, Context), or { joins } the joins sent
 *  for this render only (the Shot's start and its next Shot's start). */
// ---------------------------------------------------------------------------
// The film layout (0.9.0): where every Shot sits on the whole film, from H3 Long
// Shot's own planner (so it matches a render exactly), Shots not rendered yet
// included. The song is laid along this film: a Shot's place in the song is its
// place here, plus the Audio panel's Start.
// ---------------------------------------------------------------------------

const LAYOUT = { sig: null, byId: {}, total: 0, fps: FPS, pending: null, error: null };

/** A Shot's edit on the film (0.9.0), in frames: trimmed off its start (in) and end
 *  (out), and moved (shift, + is later). Non-destructive: nothing re-renders. */
function editOf(s) {
  const e = (s && s.place) || {};
  return { in: Math.max(0, Math.round(Number(e.in) || 0)), out: Math.max(0, Math.round(Number(e.out) || 0)),
    shift: Math.round(Number(e.shift) || 0) };
}
const hasEdit = (s) => { const e = effEdit(s); return !!(e.in || e.out || e.shift); };

/** Does the i-th active Shot start a run on the film (0.9.2)? The film's start, a Cut or
 *  Context join, or a clip right after a clip. Shots joined Continuous make one run. */
function runStartAt(act, i) {
  if (i <= 0) return true;
  const s = act[i], pv = act[i - 1];
  return isCut(s) || (s.kind === "clip" && pv.kind === "clip") || isEmptyShot(s) || isEmptyShot(pv);
}

/** The Continuous run a Shot is part of: [first … last]. */
function runOf(s) {
  const act = active();
  let i = act.indexOf(s);
  if (i < 0) return [s];
  let a = i, b = i;
  while (!runStartAt(act, a)) a--;
  while (b + 1 < act.length && !runStartAt(act, b + 1)) b++;
  return act.slice(a, b + 1);
}

/** Free edges: the film's start and end, and joins that are a Cut or Context
 *  (nothing is pinned across them). Continuous joins can't be trimmed. */
function freeEdges(s) {
  const act = active(), i = act.indexOf(s);
  if (i < 0) return { left: false, right: false };
  return { left: runStartAt(act, i), right: i + 1 >= act.length || runStartAt(act, i + 1) };
}

/** The edit that applies now: a trim on an edge that's become Continuous is kept but
 *  set aside. A move belongs to the Shot's run (0.9.2): its first Shot carries it and
 *  the whole run moves. */
function effEdit(s) {
  const e = editOf(s), f = freeEdges(s), r = runOf(s);
  return { in: f.left ? e.in : 0, out: f.right ? e.out : 0, shift: editOf(r[0]).shift };
}

const fmtSec = (frames) => `${(frames / FPS).toFixed(2)} s`;

/** On a Shot card: "✂ 0.40–4.10 s · moved +2 f" and a reset. */
function editTag(s) {
  if (!hasEdit(s)) return "";
  const e = effEdit(s), L = LAYOUT.byId[s.id];
  const bits = [];
  if (e.in || e.out) {
    const len = L ? L.we - L.vs : null;
    bits.push(len ? `✂ ${fmtSec(e.in)}–${fmtSec(len - e.out)}` : `✂ ${fmtSec(e.in)} / ${fmtSec(e.out)}`);
  }
  if (e.shift) bits.push(`moved ${e.shift > 0 ? "+" : ""}${e.shift} f`);
  return ` · <span class="edit-tag" title="Trimmed / moved on the film (nothing re-renders). Alt + ← / → moves it a frame.">${bits.join(" · ")}</span>` +
    ` <span class="linkbtn reset-edit" role="button" tabindex="0" data-action="reset-edit" title="Back to the whole take, in its own place">reset</span>`;
}

/** The frames Long Shot plans a Shot with: a take's or clip's window, else its seconds. */
function plannedWindow(s) {
  if (s.kind === "clip") return s.clip && s.clip.frames ? Number(s.clip.frames) : null;
  if ((s.status === "approved" || s.status === "review") && s.take && s.window) return Number(s.window);
  if (s.window && Number(s.take_seconds) === Number(s.seconds)) return Number(s.window);
  return null;
}

function layoutPieces() {
  const act = active();
  return act.map((s, i) => ({ id: s.id, seconds: s.kind === "clip" ? (Number(s.clip && s.clip.frames) || 0) / FPS
    : Number(s.seconds) || 0, window: plannedWindow(s), cut: i > 0 && runStartAt(act, i),
    hold: isEmptyShot(s) ? Math.max(1, Math.round((Number(s.seconds) || 0) * FPS)) : 0 }));
}

/** Ask for the layout when the Shots changed (debounced); render again when it comes. */
function requestLayout() {
  if (!P() || S.conn !== "ok") return;
  const pieces = layoutPieces();
  if (!pieces.length) { LAYOUT.sig = ""; LAYOUT.byId = {}; LAYOUT.total = 0; return; }
  const overlap = Number(P().settings.overlap) || 22;
  const sig = JSON.stringify([overlap, pieces]);
  if (sig === LAYOUT.sig || sig === LAYOUT.pending) return;
  LAYOUT.pending = sig;
  clearTimeout(LAYOUT.timer);
  LAYOUT.timer = setTimeout(async () => {
    try {
      const r = await api("/longshot/layout", { method: "POST", body: { overlap, pieces } });
      if (LAYOUT.pending !== sig) return;
      LAYOUT.byId = Object.fromEntries(r.pieces.map((x) => [x.id, x]));
      LAYOUT.total = r.total;
      LAYOUT.fps = r.fps || FPS;
      LAYOUT.error = null;
    } catch (e) {
      if (LAYOUT.pending !== sig) return;
      LAYOUT.byId = {};
      LAYOUT.error = e.message;
    }
    LAYOUT.sig = sig;
    LAYOUT.pending = null;
    renderShots();
    renderViewer();
  }, 120);
}

/** 0.15.0: the film layout for the project in place, fetched now if it isn't known yet
 *  (an export's records depend on it: a queue resumed after a restart, or a job for a
 *  project that isn't the open one, used to work them out from a missing or other layout). */
async function layoutReady() {
  if (!P()) return;
  const pieces = layoutPieces();
  if (!pieces.length) { LAYOUT.sig = ""; LAYOUT.byId = {}; LAYOUT.total = 0; return; }
  const overlap = Number(P().settings.overlap) || 22;
  const sig = JSON.stringify([overlap, pieces]);
  if (sig === LAYOUT.sig && !LAYOUT.error && !LAYOUT.pending) return;
  clearTimeout(LAYOUT.timer);
  const r = await api("/longshot/layout", { method: "POST", body: { overlap, pieces } });
  LAYOUT.byId = Object.fromEntries(r.pieces.map((x) => [x.id, x]));
  LAYOUT.total = r.total;
  LAYOUT.fps = r.fps || FPS;
  LAYOUT.error = null;
  LAYOUT.sig = sig;
  LAYOUT.pending = null;
}

/** A Shot's span on the film in frames, with its trims and move (0.9.0), or null. */
function filmSpan(s) {
  const L = LAYOUT.byId[s.id];
  if (!L) return null;
  const e = effEdit(s);
  return { a: L.vs + e.shift + e.in, b: L.we + e.shift - e.out, ws: L.ws, vs: L.vs, we: L.we };
}

const songOn = () => !!(P() && P().audio && P().audio.file && (P().audio.song_ref || P().audio.lip_sync || P().audio.final_override));
const songStart = () => Math.max(0, Number(P().audio.start) || 0);

function fmtSong(t) {
  const neg = t < 0;
  t = Math.abs(t || 0);
  const m = Math.floor(t / 60), sec = t - m * 60;
  return `${neg ? "-" : ""}${m}:${sec.toFixed(2).padStart(5, "0")}`;
}

/** "♪ 0:45.17–0:50.33" on a Shot card: where it sits in the song. */
function songSpanHTML(s) {
  if (!songOn()) return "";
  const sp = filmSpan(s);
  if (!sp) return "";
  // 0.9.2: the part of the song this Shot shows on the film (Audio Start included); a
  // render gives it the song from where its take starts
  const a = songStart() + sp.a / LAYOUT.fps, b = songStart() + sp.b / LAYOUT.fps;
  return ` · <span class="song-at" title="The part of the song under this Shot on the film (Audio Start included). Rendering it gives it the song from here. Shots not rendered yet keep their time.">♪ ${fmtSong(a)}–${fmtSong(b)}</span>`;
}

/** song_gap for each Shot of a render that has Shots left out right before it
 *  (Long Shot 1.6.17): seconds for one not rendered yet, w<frames> for a rendered one. */
function songGaps(project, drop) {
  let gap = [];
  for (const x of project.shots) {
    if (x.bypassed && !drop.has(x.id)) continue;              // bypassed by you: not on the film
    if (drop.has(x.id)) {
      const w = plannedWindow(x);
      gap.push(w && w % 17 === 5 ? "w" + w : String(+(Number(x.kind === "clip" ? (x.clip.frames || 0) / FPS : x.seconds) || 0).toFixed(4)));
      continue;
    }
    if (gap.length) x.song_gap = gap.join(",");
    gap = [];
  }
}

function chipPlan(s) {
  const j = chipJoin(s);
  if (j !== "bridge") return { alone: true, name: chipName(s, j) };
  const { prev, next } = chipSides(s);
  if (!prev && !next) return { alone: true, name: "Continuous", pending: true };   // nothing approved to pin to yet
  const act = active(), i = act.indexOf(s), nx = act[i + 1];
  const joins = { [s.id]: prev ? "bridge" : "cut" };
  if (nx && isRendered(nx)) joins[nx.id] = next ? "bridge" : "cut";
  return { alone: false, joins, prev, next, name: chipName(s, j) };
}
/** After a chip render: a join this render left as a hard cut, though the
 *  Shot's own chip says otherwise, shows as a hard cut. */
function chipSeams(plan, id) {
  const act = active(), s = act.find((x) => x.id === id);
  if (!s || !plan || plan.alone) return;
  const i = act.indexOf(s), pv = act[i - 1], nx = act[i + 1];
  if (plan.joins[s.id] === "cut" && !isCut(s)) {
    s.standalone = i > 0;
    s.seam = pv && isRendered(pv) && pv.kind !== "clip" ? "mismatch" : null;
  }
  if (nx && plan.joins[nx.id] === "cut" && !isCut(nx) && nx.kind !== "clip") nx.seam = "mismatch";
  if (nx && plan.joins[nx.id] === "bridge" && nx.kind !== "clip") nx.seam = "ok";
}

function cutBefore(s) {
  if (!s || s.bypassed || s.status === "queued") return false;
  const act = active(), prev = act[act.indexOf(s) - 1];
  if (!prev || isCut(s) || prev.kind === "clip" || s.kind === "clip" || prev.status === "queued") return false;
  const row = lastRowFor(s.id), lo = last();
  if (row && lo && lo.chain.includes(prev.id) && row.seam) return row.seam === "mismatch";
  return s.seam === "mismatch";
}

/** Remember each join's state from a render, for the Shots it showed. */
function noteSeams(rows, chain, standalone) {
  const byId = new Map(P().shots.map((x) => [x.id, x]));
  rows.forEach((r, i) => {
    const sh = byId.get(chain[i]);
    if (!sh || sh.kind === "clip") return;
    if (i > 0) sh.seam = r.seam === "mismatch" ? "mismatch" : r.seam === "ok" ? "ok" : null;
  });
  if (standalone && chain.length === 1) {
    // a fresh take: nothing leads into it, and the Shot after it no longer follows on
    const act = active(), sh = byId.get(chain[0]), i = act.indexOf(sh);
    const prev = act[i - 1], next = act[i + 1];
    sh.seam = prev && isRendered(prev) && prev.kind !== "clip" && !isCut(sh) ? "mismatch" : null;
    if (next && next.kind !== "clip" && next.status !== "queued" && !isCut(next)) next.seam = "mismatch";
  }
}
/** A run of the open project is going (another project's run doesn't lock this one). */
const busyHere = () => !!P() && ((!!S.busy && S.busy.slug === P().slug) || (!!S.chunking && S.chunking.slug === P().slug));
/** The Shot being sampled now (0.8.3): Long Shot reports each piece as it
 *  starts, so a run of several Shots (Render all) marks the one in progress,
 *  not its last Shot. Before the first report: the first Shot it samples. */
function renderingId() {
  const b = S.busy;
  if (!(busyHere() && b && (b.kind === "render" || b.kind === "reroll"))) return null;
  if (!b.built) return b.target;
  const chain = b.built.chain;
  if (b.current && b.segs[b.current.segment] === "rendering") return b.current.id || chain[b.current.segment - 1] || b.target;
  const waiting = runSampled(b).filter((id) => !segFinished(b, id));
  return waiting[0] || b.target;
}
/** Shots this run samples, in order (not the ones that load their take). */
function runSampled(b) {
  return b.built.chain.filter((id) => { const x = shotById(id); return x && x.kind !== "clip" && x.status === "queued"; });
}
function segFinished(b, id) {
  const st = b.segs[b.built.chain.indexOf(id) + 1];
  return st === "done" || st === "reused";
}
/** A Shot's place in the run going now: "rendering" | "waiting" (with its
 *  place after the one rendering) | "done" (sampled; its clip comes at the end) | null. */
function runState(s) {
  const b = S.busy;
  if (!s || s.kind === "clip" || s.status !== "queued" || !busyHere() || !b || !b.built ||
      !(b.kind === "render" || b.kind === "reroll") || !b.built.chain.includes(s.id)) return null;
  if (segFinished(b, s.id)) return { state: "done" };
  const rid = renderingId();
  if (s.id === rid) return { state: "rendering" };
  const order = runSampled(b), waiting = order.filter((id) => !segFinished(b, id) && id !== rid);
  // "Up next" for the next one, then its place in the whole run ("3rd in this run")
  return { state: "waiting", pos: waiting.indexOf(s.id) + 1, at: order.indexOf(s.id) + 1 };
}
const ORD = (n) => n + (n % 10 === 1 && n % 100 !== 11 ? "st" : n % 10 === 2 && n % 100 !== 12 ? "nd" : n % 10 === 3 && n % 100 !== 13 ? "rd" : "th");
const clock = (iso) => (iso || "").slice(11, 16);

/** Non-bypassed references whose file is gone (or never chosen). */
function missingRefs() {
  const clips = active().filter((s) => s.kind === "clip" &&
    (!s.clip.file || ["missing", "invalid"].includes(S.refState["clip:" + s.id])))
    .map((s) => ({ label: titleOf(s) + "'s clip" }));
  const anchors = anchorKeys().filter((k) => anchorItem(k) && ["missing", "invalid"].includes(S.refState["anchor:" + k]))
    .map((k) => ({ label: anchorTitle(k) }));
  const voices = liveVoices().filter((v) => ["missing", "invalid"].includes(S.refState["voice:" + v.id]))
    .map((v) => ({ label: v.label || audioLabelOf(v) }));
  return liveCast().filter((c) => !c.image || ["missing", "invalid"].includes(S.refState[c.id])).concat(clips, anchors, voices);
}
const audioMissing = () => !!P().audio.file && ["missing", "invalid"].includes(S.refState.audio);

/** The last render: rows, chain ids, video. */
function last() {
  const lo = P().last_output;
  return lo && lo.plan && lo.chain ? lo : null;
}

function lastRowFor(id) {
  const lo = last();
  if (!lo) return null;
  const i = lo.chain.indexOf(id);
  return i >= 0 ? lo.plan[i] : null;
}

// ---------------------------------------------------------------------------
// Server calls
// ---------------------------------------------------------------------------

async function api(path, opts = {}) {
  const init = { method: opts.method || "GET", headers: {} };
  if (opts.body !== undefined) {
    init.body = JSON.stringify(opts.body);
    init.headers["Content-Type"] = "application/json";
  }
  const res = await fetch(path, init);
  let data = null;
  try { data = await res.json(); } catch (e) { /* not JSON */ }
  if (!res.ok) {
    const msg = (data && (data.error && (data.error.message || data.error))) || res.statusText;
    const err = new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
    err.data = data;
    err.status = res.status;
    throw err;
  }
  return data;
}

let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  if (!S.conflict) S.saveState = "Unsaved changes";
  renderSaveState();
  saveTimer = setTimeout(saveNow, 2000);      // autosave 2 s after the last change
}

async function saveNow(force = false) {
  clearTimeout(saveTimer);
  if (!P() || !P().slug || (S.conflict && !force)) return;
  S.saveState = "Saving…";
  renderSaveState();
  try {
    const q = "?base=" + encodeURIComponent(P().saved_at || "") + (force ? "&force=1" : "");
    const res = await api("/longshot/projects/" + P().slug + q, { method: "PUT", body: P() });
    P().saved_at = res.saved_at;
    S.conflict = null;
    S.saveState = "Saved · " + clock(res.saved_at);
  } catch (e) {
    if (e.status === 409) {
      S.conflict = (e.data && e.data.current) || {};
      S.saveState = "Not saved";
    } else {
      S.saveState = "Save failed";
      toast("Couldn't save the project: " + e.message);
    }
  }
  renderSaveState();
  $("conflict").hidden = !S.conflict;
}

async function refreshProjects() {
  try { S.projects = await api("/longshot/projects"); } catch (e) { S.projects = []; }
}

/** A new project starts with empty model fields. Fill each one that has exactly
 *  one obvious MiniMax H3 file in ComfyUI's lists; leave the rest for Settings. */
function autoPickModels(p) {
  const o = S.opts;
  if (!o) return false;
  const s = p.settings;
  const only = (list, ...words) => {
    const hits = (list || []).filter((n) => words.every((w) => n.toLowerCase().includes(w)));
    return hits.length === 1 ? hits[0] : "";
  };
  const picks = {
    model: () => (o.models || []).filter((n) => /minimax_h3/i.test(n) && !/vae|lora|turbo/i.test(n)),
    clip: () => (o.clips || []).filter((n) => /minimax/i.test(n)),
    video_vae: () => [only(o.vaes, "minimax", "video")],
    audio_vae: () => [only(o.vaes, "minimax", "audio")],
  };
  let changed = false;
  for (const [k, f] of Object.entries(picks)) {
    const hits = f().filter(Boolean);
    if (!s[k] && hits.length === 1) { s[k] = hits[0]; changed = true; }
  }
  if (!s.turbo.lora) {
    const t = only(o.loras, "minimax", "turbo");
    if (t) { s.turbo.lora = t; changed = true; }
  }
  return changed;
}

async function loadProject(slug) {
  stopPreview();
  const p = await api("/longshot/projects/" + encodeURIComponent(slug));
  S.gen = 0;
  S.bad = {};
  S.project = normalize(p);
  if (autoPickModels(S.project)) scheduleSave();
  // 0.8.6: beta57 needs RES4LYF; without it, ComfyUI's own beta
  const sch = S.project.settings.scheduler;
  if (S.opts && Array.isArray(S.opts.schedulers) && !S.opts.schedulers.includes(sch) && S.opts.schedulers.includes("beta")) {
    S.project.settings.scheduler = "beta";
    scheduleSave();
  }
  if (S.project.voice_ref_dropped) {
    delete S.project.voice_ref_dropped;
    scheduleSave();
    setTimeout(() => toast("This project used the song as a voice reference. That route is gone: add the vocal as an audio " +
      "reference card in Cast & Scenes and link it in the character's editor."), 800);
  }
  const relinked = relinkModels(S.project);
  if (relinked) {
    scheduleSave();
    toast(`Found ${relinked} model file${relinked > 1 ? "s" : ""} by name in this machine's model folders.`);
  }
  Object.assign(S, { dry: null, error: null, loop: false, conflict: null, refState: {}, refInfo: {},
    segStats: null, checkedFor: null, takes: {}, clips: {}, focus: null, clipTried: new Set(), clipsReady: false });
  $("conflict").hidden = true;
  S.saveState = p.saved_at ? "Saved · " + clock(p.saved_at) : "";
  S.open = (reviewShot() || nextQueued() || {}).id || null;
  store("h3studio.project", P().slug);
  OPEN.slug = P().slug;
  heartbeat();
  loadVideo();
  render();
  await Promise.all([loadInputs(), checkInputs(), loadSegStats(), loadClips(), fetchAllTakes()]);
  render();
  autoCheck();
}

/** Image / audio files: this project's input subfolder first, then the input folder. */
async function loadInputs() {
  const sub = "longshot/" + P().slug;
  try {
    const [root, mine] = await Promise.all([api("/longshot/inputs"),
      api("/longshot/inputs?subfolder=" + encodeURIComponent(sub))]);
    S.inputs = { root, mine };
  } catch (e) { S.inputs = null; }
}

/** B.4: is every saved reference still there, and unchanged? */
async function checkInputs() {
  const p = P();
  const files = p.cast.filter((c) => c.image).map((c) =>
    ({ key: c.id, name: c.image, subfolder: c.subfolder, sha256: c.sha256 }));
  if (p.audio.file) files.push({ key: "audio", name: p.audio.file, subfolder: p.audio.subfolder, sha256: p.audio.sha256 });
  for (const sh of p.shots) {
    if (sh.kind === "clip" && sh.clip.file) {
      files.push({ key: "clip:" + sh.id, name: sh.clip.file, subfolder: sh.clip.subfolder, sha256: sh.clip.sha256 });
    }
    if (sh.anchor_in && sh.anchor_in.file) {
      files.push({ key: "anchor:" + sh.id, name: sh.anchor_in.file, subfolder: sh.anchor_in.subfolder, sha256: sh.anchor_in.sha256 });
    }
  }
  if (p.anchor_end && p.anchor_end.file) {
    files.push({ key: "anchor:end", name: p.anchor_end.file, subfolder: p.anchor_end.subfolder, sha256: p.anchor_end.sha256 });
  }
  for (const v of p.voices || []) {
    if (v.file) files.push({ key: "voice:" + v.id, name: v.file, subfolder: v.subfolder, sha256: v.sha256 });
  }
  if (!files.length) { S.refState = {}; return; }
  let res;
  try { res = await api("/longshot/check-inputs", { method: "POST", body: { files } }); } catch (e) { return; }
  const state = {};
  let adopted = false, changed = [];
  for (const f of res.files) {
    state[f.key] = f.state;
    S.refInfo[f.key] = f;
    const item = f.key === "audio" ? p.audio : f.key.startsWith("clip:") || f.key.startsWith("anchor:") || f.key.startsWith("voice:")
      ? refItem(f.key) : p.cast.find((c) => c.id === f.key);
    if (!item) continue;
    if (f.key.startsWith("anchor:")) {          // a frame anchor: just follow the file
      if (f.state === "ok" || f.state === "changed") { item.sha256 = f.sha256; item.size_bytes = f.size_bytes; adopted = adopted || f.state === "changed"; }
      continue;
    }
    if (f.state === "ok" && f.sha256 && !item.sha256) {      // first check: remember the hash
      item.sha256 = f.sha256;
      item.size_bytes = f.size_bytes;
      adopted = true;
    }
    if (f.state === "changed" && f.key.startsWith("clip:")) {
      const sh = p.shots.find((x) => x.id === f.key.slice(5));
      item.sha256 = f.sha256;
      if (sh && !sh.bypassed) { bridgeAround(sh); p.preview_dirty = true; adopted = true; }
      continue;
    }
    if (f.state === "changed" && !(f.key === "audio" ? false : item.bypassed)) changed.push(f.key);
  }
  S.refState = state;
  const audioMatters = p.audio.voice_ref;
  if (changed.includes("audio") && audioMatters) sharedChanged("The song file");
  else if (changed.some((k) => k !== "audio")) {
    // a reference picture changed on disk: approved Shots may keep their takes
    applyRefChange((await askRefChange("A reference file changed on disk")) || "keep", "A reference file");
  }
  if (adopted) scheduleSave();
  await relinkMissing();
}

/** A missing reference copied back into the project's input folder (or the
 *  input folder) relinks by itself: silently when it's the same file, after
 *  asking when only the name matches (a different picture re-renders). */
let relinking = false;
async function relinkMissing() {
  const p = P();
  if (!p || relinking) return;
  const lost = [];
  for (const [key, st] of Object.entries(S.refState)) {
    if (st !== "missing" && st !== "invalid") continue;
    const item = refItem(key);
    if (item) lost.push({ key, name: item.original_name || refName(key), sha256: item.sha256 });
  }
  if (!lost.length) return;
  relinking = true;
  try {
    let res;
    try { res = await api("/longshot/find-inputs", { method: "POST", body: { project: p.slug, files: lost } }); }
    catch (e) { return; }
    let quiet = 0;
    for (const f of res.files) {
      const item = refItem(f.key);
      if (!item || P() !== p) continue;
      if (f.match === "name") {
        const ok = await confirmBox({ title: `Use ${f.name}?`,
          body: `${refLabel(f.key)} is missing. A file with the same name is in ${f.subfolder ? "input/" + f.subfolder : "the input folder"}, ` +
            "but it isn't the same file that was saved, so it counts as a new picture.",
          yes: "Use it", no: "Not now" });
        if (!ok) continue;
      }
      setRefFile(f.key, f);
      S.refState[f.key] = "ok";
      S.refInfo[f.key] = Object.assign({ state: "ok" }, f);
      if (f.match === "name" && refMatters(f.key)) {
        if (f.key === "audio" || f.key.startsWith("clip:")) sharedChanged(f.key === "audio" ? "Audio" : "Cast & Scenes");
        else applyRefChange((await askRefChange(`${refLabel(f.key)} is a different picture`)) || "keep", "Cast & Scenes");
      } else quiet++;
    }
    if (quiet) toast(`Found ${quiet} missing file${quiet > 1 ? "s" : ""} again — relinked, nothing re-renders.`);
    await loadInputs();
    commit();
  } finally { relinking = false; }
}

function refItem(key) {
  const p = P();
  if (key === "audio") return p.audio;
  if (key.startsWith("clip:")) { const sh = p.shots.find((x) => x.id === key.slice(5)); return sh && sh.clip; }
  if (key.startsWith("anchor:")) return anchorItem(key.slice(7));
  if (key.startsWith("voice:")) return voiceById(key.slice(6));
  return p.cast.find((c) => c.id === key);
}
function refName(key) { const it = refItem(key); return key === "audio" || key.startsWith("clip:") || key.startsWith("anchor:") || key.startsWith("voice:") ? it.file : it.image; }
function refLabel(key) {
  if (key === "audio") return "The song";
  if (key.startsWith("clip:")) { const sh = P().shots.find((x) => x.id === key.slice(5)); return sh ? `${titleOf(sh)}'s clip` : "A clip"; }
  if (key.startsWith("voice:")) { const v = refItem(key); return v && v.label ? v.label : "A voice reference"; }
  const c = refItem(key);
  return c && c.label ? c.label : "A reference";
}
function refMatters(key) {
  const p = P();
  if (key === "audio") return p.audio.voice_ref || p.audio.song_ref || p.audio.lip_sync;
  if (key.startsWith("clip:")) return true;
  const c = refItem(key);
  return c && !c.bypassed;
}
function setRefFile(key, f) {
  const it = refItem(key);
  if (key === "audio") it.file = f.name;
  else if (key.startsWith("clip:")) it.file = f.name;
  else it.image = f.name;
  Object.assign(it, { subfolder: f.subfolder, sha256: f.sha256, size_bytes: f.size_bytes, original_name: f.name });
}

/** After a successful render, the files it used become the saved versions. */
function adoptCurrentFiles() {
  const p = P();
  for (const [key, info] of Object.entries(S.refInfo)) {
    if (!info || info.state !== "changed" || !info.sha256) continue;
    const item = key === "audio" ? p.audio : p.cast.find((c) => c.id === key);
    if (item) { item.sha256 = info.sha256; item.size_bytes = info.size_bytes; }
    S.refState[key] = "ok";
    info.state = "ok";
  }
}

async function loadSegStats() {
  try { S.segStats = await api("/longshot/segments/" + P().slug); } catch (e) { S.segStats = null; }
}

/** A.4: on open, a free dry run (no model loads) shows which finished Shots
 *  come back from disk. Only when ComfyUI is idle, so it never waits in line. */
async function autoCheck() {
  const p = P();
  if (!p || S.checkedFor === p.slug || S.busy || S.queuing || S.chunking || S.applying || waitingJobs().length || S.conn !== "ok") return;
  const done = active().filter((s) => s.status !== "queued");
  if (!done.length || missingRefs().length) { S.checkedFor = p.slug; return; }
  try {
    const q = await api("/queue");
    if ((q.queue_running || []).length || (q.queue_pending || []).length) return;
  } catch (e) { return; }
  S.checkedFor = p.slug;
  const upto = done[done.length - 1].id;
  runNow({ upto, dry: true, kind: "check", label: "Checking saved takes…", note: "Nothing is sampled",
    onDone: ({ rows, built }) => { S.dry = { rows, text: "", chain: built.chain }; } });
}

// ---------------------------------------------------------------------------
// Invalidation rules
// ---------------------------------------------------------------------------

/** With lip sync, anything that moves later Shots on the timeline moves them
 *  against the song: they render again to stay in sync (spec 2.4). */
function syncAfter(s, what) {
  const a = P().audio;
  if (!a.lip_sync || !a.file) return false;
  const after = renderedAfter(s);
  if (!after.length) return false;
  rippleAfter(s);
  const n0 = numOf(after[0].id), n1 = numOf(after[after.length - 1].id);
  toast(`${what} — ${after.length > 1 ? `Shots ${n0}–${n1}` : `Shot ${n0}`} will re-render to stay in sync with the song.`);
  return true;
}

/** Editing a rendered Shot re-renders it in place; the Shots after it keep their takes. */
function editInPlace(s, field) {
  const wasRendered = s.status !== "queued";
  s.status = "queued";
  s.edit_from = null;
  S.dry = null;
  if (field === "seconds" && syncAfter(s, `${titleOf(s)} changed length`)) return;
  const after = renderedAfter(s);
  if (wasRendered && after.length) {
    const n0 = numOf(after[0].id), n1 = numOf(after[after.length - 1].id);
    const range = after.length > 1 ? `Shots ${n0}–${n1}` : `Shot ${n0}`;
    toast(`${titleOf(s)} will re-render in place; ${range} keep${after.length > 1 ? "" : "s"} ${after.length > 1 ? "their takes" : "its take"}.`,
      { label: `Re-render ${range} too`, fn: () => { rippleAfter(s); commit(); } });
  }
}

/** Editing a Shot: it and every Shot after it are queued again. */
function queueFrom(id, includeSelf = true) {
  S.gen++;
  const shots = P().shots;
  const i = shots.findIndex((s) => s.id === id);
  shots.forEach((s, k) => {
    if (k > i || (includeSelf && k === i)) s.status = "queued";
  });
  S.dry = null;
}

/** Anything every Shot shares: everything is queued, approvals kept as a flag. */
function sharedChanged(what, quiet = false) {
  changedDuringRender(what);
  const rendered = active().filter((s) => s.status !== "queued");
  S.dry = null;
  S.gen++;
  if (!rendered.length) return;
  for (const s of P().shots) {
    if (s.status === "approved") s.was_approved = true;
    else if (s.status === "review") s.was_rendered = true;
    s.status = "queued";
  }
  if (!quiet) changeNote(what, `all ${rendered.length} rendered Shot${rendered.length > 1 ? "s" : ""} render again from Shot 1` +
    (rendered.some((s) => s.was_approved) ? " (earlier approvals flagged)" : ""));
}

/** A shared change while the open project renders: the render going now keeps
 *  what it started with; it says so when it lands. */
function changedDuringRender(what) {
  if (!inRenderAny()) return;
  const b = S.busy.built;
  b.changedDuring = [...new Set([...(b.changedDuring || []), what])];
}

/** Approved generated Shots (clips are always "approved" and don't count). */
const approvedShots = () => active().filter((s) => s.kind !== "clip" && s.status === "approved");

/** Cast & Scenes changed with approved Shots: they keep their takes (locked
 *  takes never sample) and the change applies from the next Shot rendered.
 *  Shots under review render again. */
function keepApproved(what, withAction = false) {
  changedDuringRender(what);
  S.dry = null;
  S.gen++;
  const redo = [];
  for (const s of active()) {
    if (s.kind === "clip") continue;
    if (s.status === "review") { s.was_rendered = true; s.status = "queued"; redo.push(s); }
  }
  const n = approvedShots().length;
  const msg = `${what} changed. ${n} approved Shot${n > 1 ? "s keep their takes" : " keeps its take"}; ` +
    `the change applies from the next Shot you render.` +
    (redo.length ? ` ${redo.map(titleOf).join(", ")} will render again.` : "");
  void msg; void withAction;
  changeNote(what, `${n} approved Shot${n > 1 ? "s keep their takes" : " keeps its take"}` +
    (redo.length ? ` · ${redo.map(titleOf).join(", ")} render${redo.length > 1 ? "" : "s"} again` : ""),
    { label: "Re-render everything", fn: () => { sharedChanged(what); commit(); } });
}

/** The notice right of the status bar: what changed and what it means, with
 *  an optional action. It takes no focus and stays until closed (or the next
 *  change replaces it; changes made close together are listed together). */
let NOTE = null;
function changeNote(what, detail, action) {
  const el = $("change-note");
  if (!el) return;
  const fresh = NOTE && Date.now() - NOTE.at < 60000 && NOTE.slug === (P() && P().slug);
  const whats = fresh ? [...new Set([...NOTE.whats, what])] : [what];
  NOTE = { whats, at: Date.now(), slug: P() && P().slug, action };
  el.innerHTML = `<span class="cn-ico" aria-hidden="true">↻</span>
    <span class="cn-txt" title="${esc(whats.join(", ") + " changed · " + detail)}"><b>${esc(whats.join(", "))} changed</b> · ${esc(detail)}</span>
    ${action ? `<button class="cn-act" type="button">${esc(action.label)}</button>` : ""}
    <button class="cn-x" type="button" aria-label="Close">${CROSS}</button>`;
  const close = () => { el.hidden = true; NOTE = null; };
  el.querySelector(".cn-x").addEventListener("click", close);
  const b = el.querySelector(".cn-act");
  if (b) b.addEventListener("click", () => { close(); if (!setupGuard()) action.fn(); });
  el.hidden = false;
}

/** How a Cast & Scenes or settings change treats approved Shots: they keep
 *  their takes ("keep"), with no question; a notice next to the status bar says
 *  so and offers Re-render everything. Nothing approved: "all" (the change
 *  re-renders what's rendered, as before). */
async function askRefChange() {
  return approvedShots().length ? "keep" : "all";
}

/** Settings whose change approved takes don't depend on (item 2, round 5).
 *  Resolution, aspect and overlap aren't here: takes made at another size or
 *  overlap can't be loaded, so those still re-render everything. */
const KEEPABLE = { steps: "steps", sampler: "the sampler", scheduler: "the scheduler",
  shift_video: "the video shift", shift_audio: "the audio shift", seed_mode: "the seed mode",
  sage_attention: "Sage attention", ref_resize_px: "the reference resize", model: "the model",
  clip: "the text encoder", video_vae: "the video VAE", audio_vae: "the audio VAE" };

/** Same choice as for references: keep approved Shots (default) or re-render everything. */
async function askSettingChange(title) {
  return askRefChange(`${title}?`);
}

function applyRefChange(mode, what, quiet = false) {
  if (mode === "keep") keepApproved(what);
  else sharedChanged(what, quiet);
}

/** No dialog (◀ ▶ under a reference): approved Shots are kept, with an undo-style
 *  toast to re-render everything instead. */
function refChangedQuietly(what) {
  if (approvedShots().length) keepApproved(what, true);
  else sharedChanged(what);
}

// ---------------------------------------------------------------------------
// Rendering a step: build → /prompt → /ws progress → /history
// ---------------------------------------------------------------------------

/** Round 2: Shots under review or approved load their take (locked); a Shot
 *  re-rendered without changing its length keeps its exact window. */
/** Seed mode "increment" (the default) works like ComfyUI's "control after
 *  generate": the seed in Settings is the next seed, and every Shot that renders
 *  takes it and moves it up by one. "same" (Fixed) leaves it where it is. */
const seedIncrements = (p = P()) => (p.settings.seed_mode || "increment") !== "same";

/** The next seed off the counter (moving it up), skipping the ones this Shot already used. */
function takeCounterSeed(s) {
  const st = P().settings;
  const used = new Set(s ? [...(s.prev_seeds || []), s.shot_seed].map(Number) : []);
  let seed = (Number(st.seed) || 0) % (SEED_MAX + 1);
  while (used.has(seed)) seed = (seed + 1) % (SEED_MAX + 1);
  st.seed = (seed + 1) % (SEED_MAX + 1);
  return seed;
}

/** A new seed for a reroll / bridge / another take: the counter in Increment
 *  mode, a random one in Fixed mode (the fixed seed would give the same take). */
function freshSeed(s) {
  return seedIncrements() ? takeCounterSeed(s) : Math.floor(Math.random() * (SEED_MAX + 1));
}

/** A real seed (0 or more): null / undefined / "" aren't. */
const hasSeed = (x) => x !== null && x !== undefined && x !== "" && Number(x) >= 0;

/** A Shot's seed: the one typed in (fixed), or the one its current take used (auto). */
const effSeed = (s) => (Number(s.shot_seed) >= 0 ? Number(s.shot_seed) : hasSeed(s.seed_used) ? Number(s.seed_used) : null);
const isAuto = (s) => !(Number(s.shot_seed) >= 0);

/** A Shot about to render again with a new seed (reroll, bridge, another take,
 *  Multi-take). A typed seed changes (it stays typed); a Shot on auto stays on
 *  auto: Increment gives it the counter when it starts, Fixed a one-off random
 *  seed (the fixed seed would give the same take). */
function reseed(s, job = null) {
  if (!isAuto(s)) { s.shot_seed = job ? passSeed(job, s) : freshSeed(s); return; }
  s.seed_pending = seedIncrements() ? null : Math.floor(Math.random() * (SEED_MAX + 1));
}

/** When a render starts: the seeds of the Shots on auto it samples (Increment:
 *  off the counter, which moves up; Fixed: the seed; a one-off seed first).
 *  The Shots stay on auto. Returns {seeds: {id: seed}, undo}. */
function claimAutoSeeds(ids) {
  const p = P(), before = p.settings.seed, seeds = {}, pend = [];
  for (const id of ids) {
    const s = p.shots.find((x) => x.id === id);
    if (!s || s.bypassed || s.kind === "clip" || !isAuto(s)) continue;
    if (hasSeed(s.seed_pending)) { seeds[id] = Number(s.seed_pending); pend.push([s, s.seed_pending]); s.seed_pending = null; }
    else seeds[id] = seedIncrements(p) ? takeCounterSeed(null) : (Number(p.settings.seed) || 0);
  }
  return { seeds, undo: () => { p.settings.seed = before; for (const [x, v] of pend) x.seed_pending = v; } };
}

function sendable(project, claimed = {}) {
  const p = JSON.parse(JSON.stringify(project));
  for (const s of p.shots) {
    if (s.kind === "clip") continue;
    if (claimed[s.id] !== undefined) s.shot_seed = claimed[s.id];                 // renders now
    else if (isAuto(s) && s.status !== "queued" && hasSeed(s.seed_used)) s.shot_seed = s.seed_used;   // its take
    else if (isAuto(s) && hasSeed(s.seed_pending)) s.shot_seed = s.seed_pending;
  }
  // Shots still on auto (not rendering in this run): what they'd get next, in order
  const base = Number(p.settings.seed) || 0;
  let k = 0;
  p.shots.filter((s) => !s.bypassed).forEach((s) => {
    if (s.kind === "clip" || Number(s.shot_seed) >= 0) return;
    s.shot_seed = p.settings.seed_mode === "same" ? base : (base + k++) % (SEED_MAX + 1);
  });
  for (const s of p.shots) {
    if (s.kind === "clip") { s.lock = null; s.frames = null; continue; }
    s.lock = (s.status === "approved" || s.status === "review") && s.take ? s.take : null;
    s.frames = s.window && Number(s.take_seconds) === Number(s.seconds) ? s.window : null;
  }
  return p;
}

const isRendered = (s) => s.kind === "clip" || (s.status !== "queued" && !!s.take);
/** 0.12.7: the size a Shot's take was made at ({width, height}), from Take history; null
 *  when not known (yet). */
function takeSize(s) {
  if (!s || s.kind === "clip" || !s.take) return null;
  const t = (S.takes[s.id] || []).find((x) => x.name === s.take);
  return t && t.width && t.height ? { width: t.width, height: t.height } : null;
}
/** A rendered Shot whose take is another size than Settings make now: it can't be pinned
 *  to (H3 shares latent frames only at one size) and can't be stitched with the rest. */
function otherSize(s) {
  if (!s || s.bypassed || !isRendered(s)) return false;
  const t = takeSize(s), cur = P() && sizeOf(P().settings);
  return !!(t && cur && (t.width !== cur[0] || t.height !== cur[1]));
}
const sizeText = (t) => `${t.width}×${t.height}`;
/** Stitched work (Update preview, the final video, Refine on export) needs one size. */
function mixedSizeGuard(what) {
  const odd = active().filter(otherSize);
  if (!odd.length) return false;
  const cur = sizeOf(P().settings);
  confirmBox({ title: `${what} needs one size`,
    body: `${odd.map((x) => `${titleOf(x)} (${sizeText(takeSize(x))})`).join(", ")} ${odd.length > 1 ? "were" : "was"} made at another size than Settings make now` +
      (cur ? ` (${cur[0]}×${cur[1]})` : "") + `, so the film can't be stitched as one video.\n\n` +
      "Export approved clips works with mixed sizes (each clip at its own). Or set Settings back to their size.",
    yes: "OK" });
  return true;
}

/** The chain reaches past the target to the last rendered Shot, so the target
 *  is pinned to what follows it and the preview shows the whole film. */
function chainEnd(targetId) {
  const act = active();
  let end = act.findIndex((s) => s.id === targetId);
  if (end < 0) return targetId;
  // only the rendered Shots right after it: a later Shot still queued (another
  // gap between standalone Shots) isn't sampled on the way
  while (end + 1 < act.length && isRendered(act[end + 1])) end++;
  return act[end].id;
}

/** Start one ComfyUI run now (the queue's jobs and the Studio's own small jobs:
 *  clips, checks, chunks). One at a time: building a prompt takes a moment, and
 *  two runs started together must not both go out. */
async function runNow(opts) {
  if (S.busy || S.queuing) return;
  S.queuing = true;
  try { return await queueJob(opts); } finally { S.queuing = false; }
}

// ---------------------------------------------------------------------------
// Chunked upscale: an upscaled whole-film render (Upscale final video, or
// Update preview with Upscale previews on) runs once per chunk. The film is
// decoded as usual (ComfyUI keeps the frames between runs); each run upscales
// one chunk and saves it without sound, so only one chunk of upscaled frames is
// in RAM. The server then joins the chunks and the sound (pictures copied).
// ---------------------------------------------------------------------------

const vsrChunkS = () => {
  const v = Number((P().settings.rtx_vsr || {}).chunk_s);
  return v >= 2 && v <= 600 ? v : 10;
};
const filmSeconds = () => active().reduce((a, s) => a + ((lastRowFor(s.id) || {}).seconds || Number(s.seconds) || 0), 0);

/** Decode runs (0.8.5): Shots joined Continuous or Bridge decode in one piece; a
 *  new run starts at each Cut or Context join, and where a Shot is left out (a
 *  preview's gap). Each run decodes alone; the pieces are joined at those cuts. */
function decodeRuns(omit) {
  const skip = new Set(omit || []);
  const runs = [];
  let prevIn = false;
  for (const s of active()) {
    if (skip.has(s.id)) { prevIn = false; continue; }
    if (!runs.length || !prevIn || isCut(s)) runs.push([]);
    runs[runs.length - 1].push(s.id);
    prevIn = true;
  }
  return runs;
}
/** 0.9.0: where each decode run sits on the film. Per run: frames to skip at its
 *  start (a take's hidden shared zone, and the first Shot's trim), frames to keep,
 *  and its first frame on the film. null while the layout isn't known. */
function filmRuns(runs) {
  if (!runs || !runs.length) return null;
  const out = [];
  for (const ids of runs) {
    const f = shotById(ids[0]), l = shotById(ids[ids.length - 1]);
    const Lf = f && LAYOUT.byId[f.id], Ll = l && LAYOUT.byId[l.id];
    if (!Lf || !Ll) return null;
    const w = plannedWindow(f);
    const zone = w && isRendered(f) ? Math.max(0, w - (Lf.we - Lf.vs)) : 0;
    const ef = effEdit(f), el = effEdit(l);
    const used = (Ll.we - Lf.vs) - ef.in - el.out;
    if (used <= 0) return null;
    out.push({ ids, head: zone + ef.in, used, at: Lf.vs + ef.shift + ef.in });
  }
  return out;
}

/** Long Shot 1.6.10+ encodes a run's frames without upscaling (Upscale Chunk at scale 1). */
function runsSupported() {
  const v = String((S.opts || {}).longshot_version || "0").split(".").map(Number);
  const want = [1, 6, 10];
  for (let i = 0; i < 3; i++) { if ((v[i] || 0) !== want[i]) return (v[i] || 0) > want[i]; }
  return true;
}
/** GB of system RAM to decode `ids` in one piece (float32 frames, as ComfyUI holds them). */
function decodeGB(ids) {
  const size = sizeOf(P().settings);
  if (!size) return 0;
  const secs = ids.reduce((a, id) => { const x = shotById(id); return a + ((lastRowFor(id) || {}).seconds || Number(x && x.seconds) || 0); }, 0);
  const frames = Math.round(secs * FPS) + (Number(P().settings.overlap) || 22);
  return frames * size[0] * size[1] * 3 * 4 / 1024 ** 3;
}

/** A whole-film job: run by run (split only at cuts), and in chunks when it
 *  upscales; one file at the end. A film with no cuts and no upscale: one go. */
async function wholeQueue(opts) {
  const v = P().settings.rtx_vsr || {};
  const upscales = opts.kind === "final" || !!v.on;
  const J = S.joinPending;
  if (J && J.slug === P().slug && J.opts.kind === opts.kind) {
    // the chunks of the last run are all saved; only the join failed: join again
    S.joinPending = null;
    J.opts = opts;
    J.jobId = opts.jobId || null;
    S.error = null;
    S.chunking = J;
    return chunkJoin(J, true);
  }
  S.joinPending = null;
  const runs = runsSupported() ? decodeRuns(opts.omit) : null;
  const multi = !!runs && runs.length > 1;
  // RAM: the longest run is decoded in one piece; stop before it, not partway through
  const ram = S.sys && S.sys.ram ? S.sys.ram.total / 1024 ** 3 : 0;
  if (ram) {
    const pieces = runs || [active().filter((x) => !(opts.omit || []).includes(x.id)).map((x) => x.id)];
    const worst = pieces.map((ids) => ({ ids, gb: decodeGB(ids) })).sort((a, b) => b.gb - a.gb)[0];
    if (worst && worst.gb + 6 > ram) {
      const a = numOf(worst.ids[0]), b = numOf(worst.ids[worst.ids.length - 1]);
      S.error = `Shots ${a}–${b} decode in one piece and need about ${Math.round(worst.gb)} GB of RAM; this machine has ` +
        `${Math.round(ram)} GB. Put a Cut or Context join inside that stretch (each starts a new decode run), or lower the resolution.`;
      render();
      return;
    }
  }
  const placed = filmRuns(runs);                   // 0.9.0: the film's edit, gaps and song
  if (!placed && !multi && (!upscales || filmSeconds() <= vsrChunkS() + 0.5)) return runNow(opts);
  const C = { opts, slug: P().slug, jobId: opts.jobId || null, upscales, placed,
    t0: placed ? placed[0].at : 0, firstChunk: [],
    L: upscales ? Math.max(24, Math.round(vsrChunkS() * FPS)) : 10_000_000,
    runs: multi ? runs : [null], r: 0, c: 0, nr: 0, n: 0, k: 0,
    trim: Number(P().settings.overlap) || 22,                       // a run after a cut drops its hidden overlap
    song: !!(P().audio.final_override && P().audio.file),           // the song is the whole film's sound
    files: [], masters: [], audio: null, audios: [], prefix: null, done: null,
    rowsAll: [], chainAll: [], texts: [], offset: 0 };
  S.chunking = C;
  return chunkRun(C);
}

async function chunkRun(C, inCtx = true) {
  if (!inCtx) return inProject(C.slug, () => chunkRun(C, true));
  const i = C.k, o = C.opts, run = C.runs[C.r], pr = C.placed && C.placed[C.r];
  const trim = pr ? pr.head : C.r > 0 ? C.trim : 0;
  const extra = {};
  if (run) {
    extra.omit = active().map((x) => x.id).filter((id) => !run.includes(id));
    extra.upto = run[run.length - 1];
  }
  const span = !run ? "" : run.length === 1 ? `Shot ${numOf(run[0])}` : `Shots ${numOf(run[0])}–${numOf(run[run.length - 1])}`;
  const runTxt = C.runs.length > 1 ? ` · run ${C.r + 1} of ${C.runs.length} (${span})` : "";
  const chunkTxt = C.upscales ? ` · chunk ${C.c + 1}${C.nr ? " of " + C.nr : ""}` : "";
  await runNow(Object.assign({}, o, extra, {
    chunk: { index: i, start: trim + C.c * C.L, length: pr ? Math.min(C.L, pr.used - C.c * C.L) : C.L,
      audio: C.c === 0 && (pr ? !C.song : (C.r === 0 || !C.song)) },
    label: `${o.label}${runTxt}${chunkTxt}`,
    note: C.c > 0 ? "The decoded run is reused · upscaling the next chunk"
      : C.runs.length > 1 ? `Decoding ${span} in one piece (a continuous run)${C.upscales ? ", then upscaling it a chunk at a time" : ""}`
        : "Decoding the film, then upscaling it a chunk at a time",
    onDone: (res) => chunkDone(C, res),
  }));
  if (!S.busy && S.chunking === C && C.k === i) chunkEnd(C, false, S.error || "A chunk didn't start.");   // didn't start
}

function chunkDone(C, { rows, text, outputs, built, sent }) {
  const ui = outputs[built.nodes.chunk] || {};
  const fr = (ui.frame_range || [])[0], v = (ui.chunk_video || [])[0], m = (ui.chunk_master || [])[0];
  if (!fr || !v) throw new Error("The chunk saved no file. Update H3 Long Shot to 1.6.2 or later.");
  const pr = C.placed && C.placed[C.r];
  const trim = pr ? pr.head : C.r > 0 ? C.trim : 0;
  if (C.c === 0) {
    C.firstChunk[C.r] = C.files.length;
    if (pr) C.offset = (pr.at - C.t0) / FPS;           // 0.9.0: where the run sits on the film
    // this run's frames (after the overlap it hides), and its Shots' times on the whole film
    const shown = pr ? pr.used : Math.max(0, fr.total - trim);
    C.nr = Math.max(1, Math.ceil(shown / C.L));
    C.n += C.nr;
    const shift = C.offset - trim / FPS;
    (rows || []).forEach((r, i) => {
      const x = Object.assign({}, r, { start: Math.max(C.offset, r.start + shift), end: r.end + shift });
      if (i === 0 && C.r > 0) x.seam = "cut";
      C.rowsAll.push(x);
    });
    C.chainAll.push(...built.chain);
    if (text) C.texts.push(text);
    if (!pr) C.offset += shown / FPS;
  }
  C.files.push({ filename: v.filename, subfolder: v.subfolder });
  if (m) C.masters.push({ filename: m.filename, subfolder: m.subfolder });
  const a = built.nodes.audio_file && ((outputs[built.nodes.audio_file] || {}).longshot_audio || [])[0];
  if (a) {
    if (pr) C.audios[C.r] = { filename: a.filename, subfolder: a.subfolder, skip: trim / FPS, dur: pr.used / FPS };
    else if (C.song || C.runs.length === 1) C.audio = { filename: a.filename, subfolder: a.subfolder };
    else C.audios.push({ filename: a.filename, subfolder: a.subfolder, skip: trim / FPS });
  }
  C.prefix = built.filename_prefix;
  C.done = { rows, text, built, sent };
  C.c++;
  C.k++;
}

async function chunkNext(C, ok) {
  if (S.chunking !== C) return;
  if (C.stopRequested) { chunkEnd(C, false, "Stopped."); return; }
  if (!ok || !C.done || C.k === 0) { chunkEnd(C, false, S.lastSwapError || S.error || "The film stopped."); return; }
  if (C.c < C.nr) { chunkRun(C, false); return; }
  if (C.r + 1 < C.runs.length) { C.r++; C.c = 0; C.nr = 0; chunkRun(C, false); return; }    // the next run
  chunkJoin(C);
}

/** Every chunk is saved: join them with the sound. If that fails the chunks are
 *  kept, and the same button tries the join again (nothing is upscaled again). */
async function chunkJoin(C, inCtx = false) {
  if (!inCtx) return inProject(C.slug, () => chunkJoin(C, true));
  C.joining = true;
  toast(C.runs.length > 1 ? `Joining ${C.runs.length} runs into one film…` : `Joining ${C.n} chunks…`);
  render();
  const { sent } = C.done;
  // the whole film's Shots and times, run after run
  const built = Object.assign({}, C.done.built, { chain: C.chainAll.length ? C.chainAll : C.done.built.chain });
  const rows = C.rowsAll.length ? C.rowsAll : C.done.rows;
  const text = C.texts.join("\n\n") || C.done.text;
  const job = C.jobId && Q.jobs.find((j) => j.id === C.jobId);
  try {
    const out = await api(`/longshot/chunks/${encodeURIComponent(P().slug)}/join`, { method: "POST",
      body: Object.assign({ prefix: C.prefix, chunks: C.files, audio: C.audio || (C.audios.length ? C.audios : null), masters: C.masters },
        C.placed ? filmJoin(C) : {}) });
    const outputs = { [built.nodes.combine]: { gifs: [out.video] } };
    if (built.nodes.prores && out.master) outputs[built.nodes.prores] = { gifs: [out.master] };
    S.chunking = null;
    C.opts.onDone({ rows, text, outputs, built, sent });
  } catch (e) {
    S.error = `Joining the film's pieces failed: ${e.message} The ${C.n} pieces are kept: ` +
      `click ${C.opts.kind === "final" ? "Upscale final video" : "Update preview"} again to retry the join (nothing is decoded again).`;
    if (S.chunking === C) S.chunking = null;
    C.joining = false;
    S.joinPending = C;
    render();
    if (job) endJob(job, "failed", "Joining the film's pieces failed: " + e.message);
    return;
  }
  render();
  saveNow();
  if (job) endJob(job, "done");
}

/** 0.9.0: the join of a placed film: black between runs where nothing covers the film,
 *  and the sound placed in time (the song itself, or each run's sound with silence). */
function filmJoin(C) {
  const P0 = C.placed, gaps = [], parts = [];
  for (let r = 0; r < P0.length; r++) {
    if (r > 0) {
      const g = P0[r].at - (P0[r - 1].at + P0[r - 1].used);
      if (g > 0) {
        gaps.push({ before: C.firstChunk[r], frames: g });
        parts.push({ silence: g / FPS });
      }
    }
    if (C.audios[r]) parts.push(C.audios[r]);
    else parts.push({ silence: P0[r].used / FPS });
  }
  const last = P0[P0.length - 1], frames = last.at + last.used - C.t0;
  const out = { gaps, codec: (C.done.built.nodes || {}).chunk_codec || "libx264" };
  if (C.song) {
    const a = P().audio;
    out.song = { file: a.file, subfolder: a.subfolder || "", at: songStart() + C.t0 / FPS, seconds: frames / FPS };
    out.audio = null;
  } else out.audio = C.audios.some(Boolean) ? parts : null;
  return out;
}

/** Stopped or failed: nothing half-finished is kept. */
function chunkEnd(C, ok, why) {
  if (S.chunking === C) S.chunking = null;
  if (!ok) {
    api(`/longshot/chunks/${encodeURIComponent(C.slug)}/discard`, { method: "POST", body: {} }).catch(() => {});
    if (C.slug === P().slug && !S.error && C.k > 0) toast("The film stopped; its pieces were removed.");
  }
  const job = C.jobId && Q.jobs.find((j) => j.id === C.jobId);
  if (job) endJob(job, ok ? "done" : /stopp/i.test(why || "") ? "stopped" : "failed", ok ? null : why);
  render();
  setTimeout(queueNext, 0);
}

// ---------------------------------------------------------------------------
// Multi-take: a render runs settings.multi_take times in a row (ComfyUI's batch
// count), each pass with new seeds for the Shots it renders. Every take is kept
// with its own clip; afterwards each Shot shows take 1 of the batch.
// ---------------------------------------------------------------------------

const MULTI_MAX = 8;
const multiTakes = () => Math.max(1, Math.min(MULTI_MAX, Math.round(Number(P() && P().settings.multi_take)) || 1));

/** The warning before a Multi-take render: how many takes (1 = just one), 0 = cancelled. */
async function askMulti(what) {
  const n = multiTakes();
  if (n <= 1) return 1;
  const ans = await confirmBox({ title: `Multi-take is ${n}`,
    body: `${what} renders ${n} times, one after another, take 2 with take 1's seed + 1, take 3 with + 2 and so on (no take repeats), so it takes about ${n}× as long. ` +
      "Every take is kept. Afterwards each Shot shows take 1 of the batch; review the others with ◀ ▶ on the timeline. " +
      "Stop ends the batch.",
    yes: `Render ${n} takes`, alt: "Just 1 take", no: "Cancel" });
  return ans === true ? n : ans === "alt" ? 1 : 0;
}

const TAKE_FIELDS = ["take", "shot_seed", "seed_used", "context_from", "window", "take_seconds", "rendered", "standalone", "seam", "edit_from"];

// ---------------------------------------------------------------------------
// The render queue: every render is a job; jobs run one after another, from any
// project. A job is a plain description (project, what to render), turned into
// a ComfyUI run when it starts, in its own project, whichever project is open.
// Saved in this browser, so a reload picks the queue up again.
// ---------------------------------------------------------------------------

const Q = { jobs: [], groups: {}, paused: false, seq: 0 };
// 0.13.0: one queue per tab (each tab runs its own); an inbox per tab takes jobs another
// tab hands over (a job for the project open here); a closed tab's queue is picked up.
const QPRE = "h3studio.queue.", IPRE = "h3studio.inbox.";
const QKEY = QPRE + CLIENT_ID, INBOX = IPRE + CLIENT_ID;

/** The other Studio tabs open now: [{id, slug}]. */
function otherTabs() {
  const t = readTabs(), now = Date.now();
  return Object.entries(t).filter(([id, v]) => id !== CLIENT_ID && v && now - v.t < TAB_FRESH)
    .map(([id, v]) => ({ id, slug: v.slug || null }));
}
/** The other tab that has project `slug` open, if any. */
const tabWith = (slug) => slug ? otherTabs().find((x) => x.slug === slug) || null : null;
function heartbeat() {
  const t = readTabs(), now = Date.now();
  for (const [id, v] of Object.entries(t)) if (!v || now - v.t > 60000) delete t[id];
  t[CLIENT_ID] = { t: now, slug: OPEN.slug };     // the project shown here (not one swapped in for a job)
  writeTabs(t);
}
window.addEventListener("pagehide", () => {
  const t = readTabs();
  delete t[CLIENT_ID];
  writeTabs(t);
});

function readJSON(key) {
  try { return JSON.parse(localStorage.getItem(key) || "null"); } catch (e) { return null; }
}
/** Jobs from elsewhere (another tab's hand-over, a closed tab's queue) join this queue. */
function mergeJobs(jobs, groups) {
  const have = new Set(Q.jobs.map((j) => j.id));
  const regroup = {};
  for (const [g, v] of Object.entries(groups || {})) {
    const ng = Q.groups[g] ? uid("g") : g;
    regroup[g] = ng;
    Q.groups[ng] = v;
  }
  let n = 0;
  for (const j of jobs || []) {
    if (!j || !liveJob(j)) continue;
    const nj = Object.assign({}, j, { state: "waiting" });
    if (have.has(nj.id)) nj.id = uid("j");
    if (nj.group && regroup[nj.group]) nj.group = regroup[nj.group];
    Q.jobs.push(nj);
    have.add(nj.id);
    n++;
  }
  return n;
}
function takeInbox() {
  const d = readJSON(INBOX);
  if (!d) return;
  try { localStorage.removeItem(INBOX); } catch (e) { /* ignore */ }
  if (mergeJobs(d.jobs, d.groups)) { saveQueue(); renderQueue(); render(); setTimeout(queueNext, 0); }
}
/** Queues of tabs that closed with jobs waiting (and the one queue before 0.13.0). */
function adoptOrphans() {
  const live = new Set([CLIENT_ID, ...otherTabs().map((x) => x.id)]);
  const keys = [];
  try { for (let i = 0; i < localStorage.length; i++) keys.push(localStorage.key(i)); } catch (e) { return; }
  let n = 0;
  for (const k of keys) {
    const legacy = k === "h3studio.queue";
    const id = k.startsWith(QPRE) ? k.slice(QPRE.length) : k.startsWith(IPRE) ? k.slice(IPRE.length) : null;
    if (!legacy && (id === null || live.has(id))) continue;
    const d = readJSON(k);
    try { localStorage.removeItem(k); } catch (e) { /* ignore */ }
    if (d) n += mergeJobs(d.jobs, d.groups);
  }
  if (n) { saveQueue(); renderQueue(); if (S.ready) setTimeout(queueNext, 0); }
  return n;
}
/** Hand a waiting job to the tab that has its project open (it applies the result there,
 *  so the two tabs never save over each other's copy). */
function handOver(job, tab) {
  const key = IPRE + tab.id, d = readJSON(key) || { jobs: [], groups: {} };
  d.jobs.push(Object.assign({}, job, { state: "waiting" }));
  if (job.group && Q.groups[job.group]) d.groups[job.group] = Q.groups[job.group];
  try { localStorage.setItem(key, JSON.stringify(d)); } catch (e) { return false; }
  Q.jobs = Q.jobs.filter((j) => j !== job);
  saveQueue();
  return true;
}
/** Live jobs queued in the other tabs, for the queue panel. */
function othersJobs() {
  const out = [];
  for (const t of otherTabs()) {
    const d = readJSON(QPRE + t.id);
    for (const j of (d && d.jobs) || []) if (liveJob(j)) out.push(j);
  }
  return out;
}
let othersSig = "";
window.addEventListener("storage", (e) => {
  if (!e.key) return;
  if (e.key === INBOX && e.newValue) { takeInbox(); return; }
  if (e.key.startsWith(QPRE) || e.key === TABS_KEY) {
    const sig = othersJobs().map((j) => j.id + j.state).join(",");
    if (sig !== othersSig) { othersSig = sig; renderQueue(); }
  }
});
setInterval(() => { heartbeat(); takeInbox(); }, 2000);
setInterval(() => { if (S.ready) adoptOrphans(); }, 10000);
heartbeat();

function saveQueue() {
  try { localStorage.setItem(QKEY, JSON.stringify({ jobs: Q.jobs, groups: Q.groups, paused: Q.paused, seq: Q.seq })); }
  catch (e) { /* storage full or off: the queue still runs */ }
}
function loadQueue() {
  try {
    const d = JSON.parse(localStorage.getItem(QKEY) || "null");
    if (!d) return;
    Q.jobs = Array.isArray(d.jobs) ? d.jobs : [];
    Q.groups = d.groups || {};
    Q.paused = !!d.paused;
    Q.seq = d.seq || 0;
    // a job that was running when the page closed runs again (finished segments are reused)
    for (const j of Q.jobs) if (j.state === "running") j.state = "waiting";
  } catch (e) { /* a broken entry: start empty */ }
  takeInbox();
  adoptOrphans();
}
const waitingJobs = () => Q.jobs.filter((j) => j.state === "waiting");
const liveJob = (j) => j.state === "waiting" || j.state === "running";
/** The open project's waiting / running job that renders Shot `id`, if any. */
function jobFor(id) {
  return Q.jobs.find((j) => liveJob(j) && j.slug === P().slug && (j.ids || []).includes(id)) || null;
}
const jobPos = (j) => waitingJobs().indexOf(j) + 1;

/** Text for a queue row: "Shot 05 · take 3", "Render all · Shots 1–5 · take 1 of 2"… */
function jobTitle(spec, pass, of, ids) {
  const pad = (id) => "Shot " + String(numOf(id)).padStart(2, "0");
  const takeNo = (id) => {
    const have = (S.takes[id] || []).length;
    return have || pass > 1 ? `take ${have + pass}` : "";
  };
  const ofTxt = of > 1 ? ` (${pass} of ${of})` : "";
  const chipShot = spec.mode === "chip" && P() ? P().shots.find((x) => x.id === spec.target) : null;
  const mode = spec.mode === "alone" ? " · on its own" : chipShot ? ` · ${chipName(chipShot)}`
    : spec.kind === "reroll" ? " · reroll" : "";
  switch (spec.type) {
    case "shot": { const t = takeNo(spec.target); return `${pad(spec.target)}${mode}${t ? " · " + t : ""}${ofTxt}`; }
    case "all": return `Render all · ${ids.length} Shot${ids.length > 1 ? "s" : ""} (${numOf(ids[0])}–${numOf(ids[ids.length - 1])})${of > 1 ? ` · take ${pass} of ${of}` : ""}`;
    case "through": return `Re-render through ${pad(spec.target)}`;
    case "final": return "Upscale final video";
    case "preview": return "Update preview";
    case "export": return "Export approved clips · upscaled";
    case "face": return `Face refine · ${pad(spec.target)}`;
    default: return spec.type;
  }
}

/** Add jobs: `specs` (one or more) × `takes` passes. Several passes share a
 *  group: afterwards every Shot shows take 1 of the batch (Multi-take). */
function enqueue(specs, takes = 1) {
  specs = (Array.isArray(specs) ? specs : [specs]).filter(Boolean);
  if (!specs.length) return;
  const idsOf = (sp) => sp.type === "all" ? sp.ids.slice() : sp.target ? [sp.target] : [];
  let group = null;
  if (takes > 1) {
    group = uid("g");
    Q.groups[group] = { slug: P().slug, ids: [...new Set(specs.flatMap(idsOf))], of: takes, first: {}, seams: null };
  }
  const was = waitingJobs().length + (S.busy || S.chunking ? 1 : 0);
  for (let k = 1; k <= takes; k++) {
    for (const spec of specs) {
      const ids = idsOf(spec);
      Q.jobs.push({ id: uid("j"), slug: P().slug, name: P().name, spec, ids, pass: k, of: takes, group,
        title: jobTitle(spec, k, takes, ids), state: "waiting", added: Date.now() });
    }
  }
  saveQueue();
  renderQueue();
  render();
  if (was > 0 || Q.paused) {
    const n = specs.length * takes;
    toast(`${n === 1 ? "Added" : `Added ${n} jobs`} to the queue${Q.paused ? " (paused)" : ` · ${was} ahead`}.`);
  }
  queueNext();
}

/** Run a function with `slug` as the open project. When it isn't the open one,
 *  it's loaded, the function runs with it (nothing is drawn meanwhile), it's
 *  saved, and the open project comes back exactly as it was. */
const VIEW_KEYS = ["project", "dry", "error", "refState", "refInfo", "segStats", "takes", "clips", "focus", "open",
  "clipTried", "clipsReady", "gen", "bad", "checkedFor", "loop", "saveState", "conflict", "inputs", "joinPending"];
const swapEvents = [];
async function inProject(slug, fn) {
  while (S.applying) await new Promise((r) => setTimeout(r, 60));
  S.applying = true;
  try {
    if (P() && P().slug === slug) return await fn(true);
    const raw = await api("/longshot/projects/" + encodeURIComponent(slug));
    const keep = {};
    for (const k of VIEW_KEYS) keep[k] = S[k];
    const timer = saveTimer;
    clearTimeout(saveTimer);
    S.swapped = true;
    S.project = normalize(raw);
    Object.assign(S, { dry: null, error: null, refState: {}, refInfo: {}, segStats: null, takes: {}, clips: {},
      focus: null, open: null, clipTried: new Set(), clipsReady: false, gen: 0, bad: {}, conflict: null, joinPending: keep.joinPending });
    try {
      await loadClips();             // (no file check here: it could ask a question mid-swap)
      return await fn(false);
    } finally {
      clearTimeout(saveTimer);
      try {
        const res = await api("/longshot/projects/" + encodeURIComponent(slug) + "?base=" + encodeURIComponent(P().saved_at || ""),
          { method: "PUT", body: P() });
        P().saved_at = res.saved_at;
      } catch (e) { /* the next run of this project reports it */ }
      const err = S.error;
      for (const k of VIEW_KEYS) S[k] = keep[k];
      S.lastSwapError = err;
      S.swapped = false;
      if (timer) scheduleSave();
    }
  } finally {
    S.applying = false;
    setTimeout(queueNext, 0);          // whatever ended while this ran can start the next job now
    if (!S.swapped) {
      render();
      renderQueue();
      // typing that landed while another project was in place
      for (const [type, el] of swapEvents.splice(0)) if (el.isConnected) el.dispatchEvent(new Event(type, { bubbles: true }));
    }
  }
}

/** The run options of a job, worked out when it starts, in its own project. */
function jobOpts(job) {
  const sp = job.spec, take = job.of > 1 ? ` · take ${job.pass} of ${job.of}` : "";
  const shot = (id) => P().shots.find((x) => x.id === id && !x.bypassed);
  if (sp.type === "shot" || sp.type === "through") {
    const s = shot(sp.target);
    if (!s || s.kind === "clip") return null;
    const n = numOf(s.id), verb = sp.kind === "reroll" ? "Re-rolling" : "Rendering";
    const seed = sp.kind === "reroll" && Number(s.shot_seed) >= 0 ? ` · seed ${s.shot_seed}` : "";
    if (sp.mode === "chip") {
      const plan = chipPlan(s);
      if (plan.alone) {
        const nbs = chipNear(s), odd = [nbs.prev, nbs.next].filter(otherSize);
        return { upto: s.id, kind: sp.kind, standalone: true, label: `${verb} Shot ${n} · ${plan.pending ? "on its own" : plan.name}${seed}${take}`,
          note: plan.name === "Context" ? "A hard cut · the last frame of the Shot before as a reference"
            : plan.pending && odd.length ? `On its own · ${odd.map(titleOf).join(" and ")} ${odd.length > 1 ? "are" : "is"} another size, so not pinned`
            : plan.pending ? "On its own · no rendered Shot next to it to continue from yet" : "A fresh start from the references",
          onDone: onRendered(s.id, true) };
      }
      const how = plan.prev && plan.next ? `from ${titleOf(plan.prev)} into ${titleOf(plan.next)}`
        : plan.prev ? `from ${titleOf(plan.prev)}` : `into ${titleOf(plan.next)}`;
      return { upto: s.id, kind: sp.kind, trimLeft: true, joins: plan.joins,
        label: `${verb} Shot ${n} · ${plan.name}${seed}${take}`,
        note: `Pinned ${how} · the Shots around it keep their takes`,
        onDone: (args) => { onRendered(s.id)(args); chipSeams(plan, s.id); } };
    }
    if (sp.mode === "alone") {
      return { upto: s.id, kind: sp.kind, standalone: true, label: `${verb} Shot ${n} on its own${seed}${take}`,
        note: "A fresh start from the references · no pins to the Shots around it", onDone: onRendered(s.id, true) };
    }
    if (sp.mode === "pinned") {
      const pin = pinnedNote(s);
      return { upto: s.id, kind: sp.kind, trimLeft: true, label: `${verb} Shot ${n}${pin ? " · " + pin : ""}${seed}${take}`,
        note: "In place · the Shots around it keep their takes", onDone: onRendered(s.id) };
    }
    const others = active().filter((x) => x !== s && isRendered(x)).length;
    return { upto: s.id, kind: sp.kind, label: sp.type === "through" ? `Re-rendering through Shot ${n}` : `${verb} Shot ${n}${seed}${take}`,
      note: sp.type === "through" ? "Kept takes re-continue with their own seeds"
        : others ? `${others} Shot${others > 1 ? "s" : ""} load${others > 1 ? "" : "s"} ${others > 1 ? "their" : "its"} take · only Shot ${n} renders`
          : n > 1 ? `Shots 1–${n - 1} reused · only Shot ${n} renders` : "Rendering Shot 1",
      onDone: onRendered(s.id) };
  }
  if (sp.type === "all") {
    const ids = sp.ids.filter((id) => shot(id));
    if (!ids.length) return null;
    const last = ids[ids.length - 1];
    const others = active().filter((x) => isRendered(x) && !ids.includes(x.id)).length;
    return { upto: last, kind: "render", label: `Rendering all · ${ids.length} Shot${ids.length > 1 ? "s" : ""}${take}`,
      note: others ? `${others} rendered Shot${others > 1 ? "s keep their takes" : " keeps its take"} · each new Shot continues from the one before`
        : "Each Shot continues from the one before",
      onDone: (args) => {
        onRendered(last)(args);
        S.focus = ids[0];                        // review from the first Shot that rendered
        if (!elsewhere(args.built.chain)) S.open = ids[0];
        loadVideo(undefined, ids[0]);
      } };
  }
  if (sp.type === "final") return finalOpts();
  if (sp.type === "preview") return previewOpts(sp.focus);
  if (sp.type === "face") {
    const s = shot(sp.target);
    if (!s || s.kind === "clip" || !s.take) return null;
    return { kind: "face", faceTry: Object.assign({ key: takeStem(s.take), take: s.take }, takeSong(s.take)),
      label: `Face refine · ${titleOf(s)}`, note: "Its take decoded, small faces redrawn as close-ups, saved for A/B",
      extra: { shot: s.id, take: s.take, sig: faceSig() }, onDone: () => {} };
  }
  if (sp.type === "export") {
    const todo = new Set(job.exportTodo || []);
    const items = approvedForExport().filter((x) => !job.exportTodo || todo.has(x.key));
    if (!items.length) return null;
    const v = P().settings.rtx_vsr || {};
    const skipped = active().filter((x) => x.kind !== "clip" && x.status !== "approved").length;
    return { kind: "export", exportClips: items.map((x) => Object.assign({ take: x.take },
        faceRefined(x.s) ? { face_clip: faceKey(x.s), frames: Number(x.s.window) || 0 } : {}, exportCut(x.s))),
      label: `Exporting ${items.length} approved clip${items.length === 1 ? "" : "s"} · upscaled ${v.scale || 2}× ${v.quality || "ULTRA"}`,
      note: "Each approved take decoded on its own, whole, and upscaled a frame at a time",
      extra: { items: items.map((x) => ({ name: x.name, key: x.key, sig: itemSig(x), asig: itemAsig(x) })), skipped, kept: job.exportKept || 0, sig: upSig() },
      onDone: () => {} };
  }
  return null;
}

const Q_ICON = { waiting: "○", running: "◌", done: "✓", failed: "!", stopped: "■", skipped: "–" };

// ---------------------------------------------------------------------------
// Keep awake (0.8.4): while the queue has work, the ComfyUI machine is asked
// not to sleep (a heartbeat; released ~2 min after the tab goes away), and this
// tab keeps its own screen on with the browser's wake lock while it's visible.
// ---------------------------------------------------------------------------
const AW = { on: false, sent: 0, lock: null, held: false, how: "", pending: false };
const queueHasWork = () => !!S.busy || !!S.chunking ||
  Q.jobs.some((j) => j.state === "running" || (j.state === "waiting" && !Q.paused));
async function syncAwake() {
  const want = queueHasWork();
  if (!AW.pending && (want !== AW.on || (want && Date.now() - AW.sent > 25000))) {
    AW.pending = true;
    try {
      const r = await api("/longshot/keep-awake", { method: "POST", body: { on: want } });
      AW.held = !!r.held || want; AW.how = r.how || "";
      AW.on = want; AW.sent = Date.now();
    } catch (e) { /* ComfyUI away: tried again on the next tick */ }
    AW.pending = false;
  }
  try {
    if (want && !AW.lock && navigator.wakeLock && document.visibilityState === "visible") {
      AW.lock = await navigator.wakeLock.request("screen");
      AW.lock.addEventListener("release", () => { AW.lock = null; renderAwake(); });
    } else if (!want && AW.lock) { await AW.lock.release(); AW.lock = null; }
  } catch (e) { AW.lock = null; }      // not allowed here (no HTTPS on another device, battery saver…)
  renderAwake();
}
function renderAwake() {
  const el = $("awake");
  if (!el) return;
  const on = AW.on || !!AW.lock;
  el.hidden = !on;
  el.title = on ? [AW.on ? `The ComfyUI machine stays awake while the queue has work (${AW.how || "requested"}).` : "",
    AW.lock ? "This screen stays on while the tab is visible." : "This screen may sleep (the tab is hidden, or the browser doesn't allow it); the queue runs from this tab, so keep it awake."]
    .filter(Boolean).join(" ") : "";
}
setInterval(syncAwake, 30000);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") syncAwake(); });

function renderQueue() {
  setTimeout(syncAwake, 0);
  if (S.swapped || !$("queue")) return;
  // 0.9.2 ⇅: latest on top (per browser); the run order stays the same
  const flip = store("h3studio.queueNewest") === "1";
  const fb = $("queue-flip");
  if (fb) {
    fb.setAttribute("aria-pressed", flip);
    fb.title = flip ? "Latest on top · click for oldest on top" : "Oldest on top · click for latest on top";
  }

  const wait = waitingJobs().length, live = Q.jobs.filter(liveJob).length;
  $("queue-count").textContent = live ? `· ${live} to go${Q.paused ? " · paused" : ""}` : Q.paused ? "· paused" : "";
  $("queue-pause").textContent = Q.paused ? "Resume" : "Pause";
  $("queue-pause").setAttribute("aria-pressed", Q.paused);
  $("queue-clear").hidden = !Q.jobs.some((j) => !liveJob(j));
  // 0.13.0: what the other Studio tabs have queued (they run their own; ComfyUI takes the
  // runs one at a time, in the order they arrive)
  const others = othersJobs();
  othersSig = others.map((j) => j.id + j.state).join(",");
  const otherRows = others.map((j) => `<div class="q-row other st-${esc(j.state)}" title="Queued in another Studio tab">
      <span class="q-icon" aria-hidden="true">${Q_ICON[j.state] || "·"}</span>
      <span class="q-main"><span class="q-name">${esc(j.name)}</span> · ${esc(j.title)}
        <div class="q-sub">In another tab · ${j.state === "running" ? "rendering" : "waiting"}</div></span><span></span></div>`).join("");
  if (!Q.jobs.length && otherRows) { $("queue").innerHTML = otherRows; return; }
  if (!Q.jobs.length) {
    $("queue").innerHTML = '<div class="q-empty peek">Nothing queued. Every render goes here and runs in order, from any project, so you can line up work and let it run.</div>';
    return;
  }
  const time = (t) => t ? new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
  const offline = S.conn !== "ok";
  const peek = Q.jobs.find((j) => j.state === "running") || Q.jobs.find((j) => j.state === "waiting") || Q.jobs[Q.jobs.length - 1];
  const list = flip ? [...Q.jobs].reverse() : Q.jobs;
  $("queue").innerHTML = list.map((j) => {
    const here = P() && j.slug === P().slug;
    let sub = "", bar = "";
    if (j.state === "running") {
      const b = S.busy && S.busy.jobId === j.id ? S.busy : null;
      const pct = b ? progressOf(b) : 1;
      sub = b ? `${b.label}${b.phase === "queued" && otherTabs().length ? " · waiting for ComfyUI (another tab's run first)" : b.note ? " · " + b.note : ""}` : S.restarting ? "Waiting for ComfyUI to restart…" : "Starting…";
      bar = `<div class="q-bar"><div style="width:${pct}%"></div></div>`;
    } else if (j.state === "waiting") {
      const pos = jobPos(j);
      sub = j.error ? j.error : offline ? "Waits for ComfyUI to be back" : Q.paused ? "Paused" : pos === 1 && (S.busy || S.chunking) ? "Next" : `#${pos} in line`;
    } else if (j.state === "done") sub = `Done · ${time(j.ended)}`;
    else if (j.state === "skipped") sub = j.error || "Skipped";
    else sub = `${j.state === "stopped" ? "Stopped" : "Failed"} · ${time(j.ended)}${j.error ? " · " + j.error : ""}`;
    const w = j.state === "waiting", idx = waitingJobs().indexOf(j);
    const sooner = `data-action="queue-up"${idx <= 0 ? " disabled" : ""}`, later = `data-action="queue-down"${idx < 0 || idx >= wait - 1 ? " disabled" : ""}`;
    const acts = w ? `<button class="ghost sm" ${flip ? later : sooner} aria-label="Move up" title="${flip ? "Run later" : "Run sooner"}">▲</button>
        <button class="ghost sm" ${flip ? sooner : later} aria-label="Move down" title="${flip ? "Run sooner" : "Run later"}">▼</button>
        <button class="ghost sm" data-action="queue-remove" aria-label="Remove from the queue">${CROSS}</button>`
      : j.state === "running" ? `<button class="ghost sm" data-action="queue-stop" title="Stop this job; the queue goes on">Stop</button>`
      : `${j.state === "failed" || j.state === "stopped" ? '<button class="ghost sm" data-action="queue-retry" title="Run it again">↻</button>' : ""}
        <button class="ghost sm" data-action="queue-remove" aria-label="Remove from the list">${CROSS}</button>`;
    return `<div class="q-row st-${j.state}${j === peek ? " peek" : ""}" data-job="${esc(j.id)}">
      <span class="q-icon" aria-hidden="true">${Q_ICON[j.state] || "·"}</span>
      <span class="q-main"><button class="q-name${here ? " here" : ""}" data-action="queue-open" title="${here ? "The open project" : "Open this project"}">${esc(j.name)}</button>
        · ${esc(j.title)}<div class="q-sub">${esc(sub)}</div>${bar}</span>
      <span class="q-act">${acts}</span></div>`;
  }).join("") + otherRows;
}

async function queueAction(action, el) {
  const row = el.closest("[data-job]");
  const job = row && Q.jobs.find((j) => j.id === row.dataset.job);
  if (action === "queue-pause") { Q.paused = !Q.paused; saveQueue(); renderQueue(); if (!Q.paused) queueNext(); return; }
  if (action === "queue-flip") { store("h3studio.queueNewest", store("h3studio.queueNewest") === "1" ? "0" : "1"); renderQueue(); return; }
  if (action === "queue-clear") {
    const gone = Q.jobs.filter((j) => !liveJob(j)).map((j) => j.group);
    Q.jobs = Q.jobs.filter(liveJob);
    for (const g of gone) if (g && Q.groups[g] && !Q.jobs.some((j) => j.group === g)) delete Q.groups[g];
    saveQueue(); renderQueue(); return;
  }
  if (!job) return;
  if (action === "queue-open") { if (job.slug !== P().slug) switchProject(job.slug); return; }
  if (action === "queue-stop") { if (S.busy && S.busy.jobId === job.id) stop(); else if (S.chunking && S.chunking.jobId === job.id) stop(); return; }
  if (action === "queue-retry") { job.state = "waiting"; job.error = null; job.attempts = 0; saveQueue(); renderQueue(); queueNext(); return; }
  if (action === "queue-remove") {
    if (job.state === "running") return;
    Q.jobs = Q.jobs.filter((j) => j !== job);
    const g = job.group;
    saveQueue(); renderQueue(); render();
    if (g && Q.groups[g] && !Q.jobs.some((j) => j.group === g && liveJob(j))) finishGroup(g);
    return;
  }
  if (action === "queue-up" || action === "queue-down") {
    const w = waitingJobs(), i = w.indexOf(job), k = action === "queue-up" ? i - 1 : i + 1;
    if (i < 0 || k < 0 || k >= w.length) return;
    const a = Q.jobs.indexOf(w[i]), b = Q.jobs.indexOf(w[k]);
    [Q.jobs[a], Q.jobs[b]] = [Q.jobs[b], Q.jobs[a]];
    saveQueue(); renderQueue();
  }
}

/** Before a later pass of a Multi-take batch: new seeds for its Shots. */
function preparePass(job) {
  if (!(job.pass > 1)) return;
  for (const id of job.ids) {
    const s = P().shots.find((x) => x.id === id);
    if (!s || s.bypassed || s.kind === "clip") continue;
    rememberTake(s);
    reseed(s, job);
    s.status = "queued";
    s.was_approved = s.was_rendered = false;
    s.edit_from = null;
  }
  S.dry = null;
}

/** A Context Shot needs the take of the Shot before it. When both would render
 *  in one run, this run stops at the Shot before and the rest goes into a job
 *  right after it (which splits again at the next Context Shot). */
function splitAtContext(job) {
  const sp = job.spec, act = active();
  let ids;
  if (sp.type === "all") ids = sp.ids.filter((id) => act.some((x) => x.id === id));
  else if (sp.type === "shot" && sp.mode === "chain") {
    const t = act.findIndex((x) => x.id === sp.target);
    if (t < 0) return;
    ids = act.slice(0, t + 1).filter((x) => x.kind !== "clip" && (x.status === "queued" || x.id === sp.target)).map((x) => x.id);
  } else return;
  let brk = -1;
  for (let k = 1; k < ids.length; k++) {
    const i = act.findIndex((x) => x.id === ids[k]), pv = act[i - 1];
    if (act[i].join === "context" && pv && ids.slice(0, k).includes(pv.id)) { brk = k; break; }
  }
  if (brk < 0) return;
  const before = ids.slice(0, brk), after = ids.slice(brk);
  let first, rest;
  if (sp.type === "all") { first = Object.assign({}, sp, { ids: before }); rest = Object.assign({}, sp, { ids: after }); }
  else { first = { type: "shot", target: before[before.length - 1], kind: "render", mode: "chain" }; rest = sp; }
  job.spec = first;
  job.ids = first.type === "all" ? first.ids.slice() : [first.target];
  job.title = jobTitle(first, job.pass, job.of, job.ids);
  const restIds = rest.type === "all" ? rest.ids.slice() : [rest.target];
  const nj = { id: uid("j"), slug: job.slug, name: job.name, spec: rest, ids: restIds, pass: job.pass, of: job.of,
    group: job.group, title: jobTitle(rest, job.pass, job.of, restIds), state: "waiting", added: Date.now() };
  Q.jobs.splice(Q.jobs.indexOf(job) + 1, 0, nj);
  saveQueue();
}

/** "Another take" queued while the Shot rendered or waited: when it starts, a
 *  Shot that has a take by then rerolls with the next seed. */
function prepareAgain(job) {
  const s = P().shots.find((x) => x.id === job.spec.target);
  if (!s || s.bypassed || s.kind === "clip" || s.status === "queued" || !s.take) return;
  const used = new Set([...(s.prev_seeds || []), effSeed(s)].map(Number));
  rememberTake(s);
  if (isAuto(s)) reseed(s);
  else {
    let seed;
    if (seedIncrements()) seed = takeCounterSeed(s);
    else {
      seed = Number(s.shot_seed);
      do seed = (seed + 1) % (SEED_MAX + 1); while (used.has(seed));
    }
    s.shot_seed = seed;
  }
  s.status = "queued";
  s.was_approved = s.was_rendered = false;
  s.edit_from = null;
  S.dry = null;
}

/** Multi-take: take k of a Shot uses take 1's seed + (k − 1), so no two takes
 *  repeat. Without take 1's seed (it failed), the seed after the last take. */
function passSeed(job, s) {
  if (seedIncrements()) return takeCounterSeed(s);      // the counter: never a repeat
  const g = job.group && Q.groups[job.group];
  const base = g && g.base ? Number(g.base[s.id]) : NaN;
  const prev = Number(s.shot_seed);
  const seed = Number.isFinite(base) && base >= 0 ? base + job.pass - 1
    : Number.isFinite(prev) && prev >= 0 ? prev + 1 : Math.floor(Math.random() * (SEED_MAX + 1));
  return seed % (SEED_MAX + 1);
}

/** After pass 1 of a batch: remember each Shot's take 1 (and the joins). */
function rememberPassOne(job) {
  const g = job.group && Q.groups[job.group];
  if (!g || job.pass !== 1) return;
  for (const id of job.ids) {
    const s = P().shots.find((x) => x.id === id);
    if (s && s.take && s.status !== "queued") g.first[id] = JSON.parse(JSON.stringify(pickFields(s, TAKE_FIELDS)));
    if (s && effSeed(s) !== null) (g.base = g.base || {})[id] = effSeed(s);
  }
  g.seams = Object.assign(g.seams || {}, Object.fromEntries(P().shots.map((x) => [x.id, x.seam === undefined ? null : x.seam])));
  saveQueue();
}

/** A batch is over: every Shot it rendered goes back to its take 1, under review. */
async function finishGroup(gid) {
  const g = Q.groups[gid];
  delete Q.groups[gid];
  saveQueue();
  if (!g || !Object.keys(g.first).length) return;
  let firstId = null;
  await inProject(g.slug, async (here) => {
    for (const id of g.ids) {
      const s = P().shots.find((x) => x.id === id), t = g.first[id];
      if (!s || !t) continue;
      Object.assign(s, JSON.parse(JSON.stringify(t)));
      if (s.status === "queued") s.status = "review";
      s.was_approved = s.was_rendered = false;
      if (!firstId) firstId = id;
    }
    if (firstId && g.seams) for (const s of P().shots) if (s.id in g.seams) s.seam = g.seams[s.id];
    S.dry = null;
    if (here) {
      commit();
      if (firstId) { S.focus = S.open = firstId; loadVideo(undefined, firstId); }
    }
  });
  if (firstId) toast(`${g.of} takes rendered${g.slug !== P().slug ? ` in ${jobProjectName(g.slug)}` : ""}. Each Shot shows take 1 of the batch; ◀ ▶ on the timeline shows the others.`);
}
const jobProjectName = (slug) => (Q.jobs.find((j) => j.slug === slug) || {}).name || slug;

const OOM_RE = /out of memory|outofmemory|not enough memory|cuda error: out of memory|failed to allocate|allocat\w* .*bytes/i;

/** A job is over: done, failed, stopped or skipped. Out of memory: ComfyUI is
 *  restarted and the job runs once more. */
function endJob(job, state, error) {
  if (!job || !liveJob(job)) return;
  if (state === "failed" && OOM_RE.test(error || "") && !(job.attempts >= 1)) {
    job.attempts = (job.attempts || 0) + 1;
    job.state = "waiting";
    job.error = "Out of memory: restarting ComfyUI, then trying again";
    saveQueue();
    renderQueue();
    autoRestart();
    return;
  }
  job.state = state;
  job.error = error || null;
  job.ended = Date.now();
  if (state === "failed" && OOM_RE.test(error || "")) job.error = "Out of memory twice: " + error;
  saveQueue();
  renderQueue();
  if (P() && job.slug === P().slug && !S.swapped) renderShots();    // its yellow ▶ goes back
  const g = job.group;
  if (g && Q.groups[g] && !Q.jobs.some((j) => j.group === g && liveJob(j))) finishGroup(g).then(() => queueNext());
  else setTimeout(queueNext, 0);
}

/** Start the next waiting job when nothing is running. */
async function queueNext() {
  if (!S.ready || S.queueStarting || S.busy || S.queuing || S.chunking || S.applying || S.restarting || Q.paused) return;
  if (S.conn !== "ok") { renderQueue(); return; }
  const job = waitingJobs()[0];
  if (!job) { renderQueue(); return; }
  const owner = (!P() || job.slug !== P().slug) ? tabWith(job.slug) : null;
  if (owner && handOver(job, owner)) {
    toast(`${job.name} is open in another tab: its job went there.`);
    renderQueue();
    setTimeout(queueNext, 0);
    return;
  }
  S.queueStarting = true;
  job.state = "running";
  job.error = null;
  job.started = Date.now();
  saveQueue();
  renderQueue();
  let outcome = null;
  try {
    await inProject(job.slug, async () => {
      if (job.spec.again && !(job.pass > 1)) prepareAgain(job);
      preparePass(job);
      splitAtContext(job);
      if (job.spec.type === "export") {
        await exportPrepare(job);
        if (!job.exportTodo.length) {
          outcome = ["done", null];
          toast(`All ${job.exportKept} approved clip${job.exportKept === 1 ? " is" : "s are"} already upscaled in Approved_Clips` +
            (job.exportRemixed ? `; the sound of ${job.exportRemixed} was mixed again (the song switched on or off, or moved).` : "; nothing to do."));
          return;
        }
      }
      const o = jobOpts(job);
      if (!o) { outcome = ["skipped", "Its Shots were removed or bypassed."]; return; }
      o.jobId = job.id;
      S.error = null;
      if (job.spec.type === "final" || job.spec.type === "preview") await wholeQueue(o);
      else await runNow(o);
      const started = (S.busy && S.busy.jobId === job.id) || (S.chunking && S.chunking.jobId === job.id);
      // (a join retried from saved chunks can be over already)
      if (!started && job.state === "running") outcome = ["failed", S.error || "It didn't start."];
    });
  } catch (e) {
    outcome = ["failed", e.status === 404 ? "Its project was deleted." : e.message];
  } finally {
    S.queueStarting = false;
  }
  if (outcome) endJob(job, outcome[0], outcome[1]);
  renderQueue();
}

/** ComfyUI ran out of memory: restart it; the queue goes on when it's back. */
async function autoRestart() {
  if (S.restarting) return;
  S.restarting = Date.now();
  S.autoRestart = true;
  renderHeader();
  toast("Out of memory: restarting ComfyUI, then the queue goes on.");
  try { await api("/longshot/restart", { method: "POST" }); }
  catch (e) { S.restarting = null; S.autoRestart = false; renderHeader(); setTimeout(queueNext, 2000); }
}

function pickFields(o, keys) {
  const r = {};
  for (const k of keys) r[k] = o[k] === undefined ? null : o[k];
  return r;
}

async function queueJob({ upto, dry, kind, label, note, onDone, final = false, standalone = false, batch = null,
  omit = null, trimLeft = false, takeClips = null, chunk = null, exportClips = null, extra = null, jobId = null,
  joins = null, takeAudio = null, faceTry = null }) {
  if (S.busy) return;
  if (Object.keys(S.uploading).length) { toast("Wait for the image upload to finish."); return; }
  S.error = null;
  const dryBox = () => { if (kind === "dry") showModal("Dry run · it stopped with an error", S.error); };
  if (comfyTooOld()) { S.error = comfyTooOldText(); dryBox(); render(); return; }
  const missing = kind === "clips" || kind === "export" || kind === "align" || kind === "face" ? [] : missingRefs();
  if (missing.length) {
    S.error = `${missing.length} reference${missing.length > 1 ? "s are" : " is"} missing — relink or bypass ${missing.length > 1 ? "them" : "it"}.`;
    dryBox();
    render();
    return;
  }
  const lost = kind === "face" ? missingFaceModels(P()) : missingModels(P());
  if (lost.length) {
    S.error = `Model file${lost.length > 1 ? "s" : ""} not found in ComfyUI's model folders: ${lost.join(", ")}. ` +
      `Choose ${lost.length > 1 ? "them" : "it"} under Advanced (Browse… can also add a folder ComfyUI doesn't know about).`;
    dryBox();
    if (kind === "face" && lost.some((x) => x.startsWith("Face"))) S.faceOpen = true;
    else if (!lost.every((x) => x.startsWith("Vocal"))) S.advOpen = true;
    else S.audioOpen = true;
    render();
    const first = document.querySelector(".pick.missing-file");
    if (first) first.scrollIntoView({ block: "center", behavior: "smooth" });
    return;
  }
  const target = upto;
  if (!standalone && !omit && (kind === "render" || kind === "reroll" || kind === "refresh")) upto = chainEnd(upto);
  // Shots on auto that this run samples take their seeds now (the counter moves up)
  let undoSeeds = () => {}, claimed = {};
  if (!dry && (kind === "render" || kind === "reroll" || kind === "final" || kind === "refresh")) {
    const act = active();
    const end = upto ? act.findIndex((x) => x.id === upto) : act.length - 1;
    const ids = standalone ? [target] : act.slice(0, end + 1).filter((x) => x.status === "queued").map((x) => x.id);
    const c = claimAutoSeeds(ids.filter((id) => !(omit || []).includes(id)));
    undoSeeds = c.undo; claimed = c.seeds;
  }
  let project = sendable(P(), claimed);          // seeds are settled on the whole timeline first
  // 0.9.2: the film's own joins, for where each Shot sits on the film (a render may override them)
  project.shots.forEach((x) => { x.film_join = x.join || "bridge"; });
  // the join chip: the joins this render uses (the project keeps its own)
  if (joins) project.shots.forEach((x) => { if (joins[x.id]) x.join = joins[x.id]; });
  // Shots left out of this render (sent bypassed; the project itself is untouched):
  // omit = given ids (the stitched preview leaves out Shots not rendered yet);
  // trimLeft = everything up to the last Shot before the target that isn't
  // rendered, so a waiting gap further left is never sampled on the way.
  const drop = new Set(omit || []);
  if (trimLeft) {
    const act = active(), ti = act.findIndex((x) => x.id === target);
    let k = -1;
    act.forEach((x, i) => { if (i < ti && !isRendered(x)) k = i; });
    act.slice(0, k + 1).forEach((x) => drop.add(x.id));
  }
  // 0.11.0: Shots with an empty prompt never render: left out, and the Shot after one
  // starts fresh (nothing to continue from)
  const empties = new Set(active().filter(isEmptyShot).map((x) => x.id));
  // 0.12.7: takes made at another size can't be loaded at this size: left out the same
  // way (their time kept), and the Shot after one starts fresh
  if (kind === "render" || kind === "reroll" || kind === "refresh" || kind === "dry" || kind === "check") {
    // 0.12.9: the dry run too (its text shows the Shots that do match)
    active().filter((x) => x.id !== target && otherSize(x)).forEach((x) => empties.add(x.id));
  }
  empties.forEach((id) => drop.add(id));
  if (empties.size) {
    const act = project.shots.filter((x) => !x.bypassed);
    act.forEach((x, i) => { if (i > 0 && empties.has(act[i - 1].id) && !empties.has(x.id)) x.join = "cut"; });
  }
  if (target && empties.has(target) && (kind === "render" || kind === "reroll")) {
    undoSeeds();
    toast(`${titleOf(shotById(target))} has no prompt: it only holds its time on the film. Write a prompt to render it.`);
    return;
  }
  if (!project.shots.some((x) => !x.bypassed && !drop.has(x.id))) {
    undoSeeds();
    toast("Nothing to render: the Shots here have empty prompts (they only hold time).");
    return;
  }
  if (drop.size) {
    songGaps(project, drop);                           // 0.9.0: they keep their place in the song
    project.shots.forEach((x) => { if (drop.has(x.id) && !x.bypassed) { x.bypassed = true; x.left_out = true; } });
  }
  if (audioMissing() && (project.audio.lip_sync || project.audio.voice_ref || project.audio.final_override || project.audio.song_ref)) {
    project = Object.assign({}, project, { audio: Object.assign({}, project.audio,
      { lip_sync: false, voice_ref: false, final_override: false, song_ref: false }) });
    toast("The audio file is missing, so this render runs without the song.");
  }
  let built;
  try {
    // Renders while reviewing don't decode the stitched film: each Shot that
    // gets a new take is decoded on its own into its clip (Long Shot 1.6).
    const clipsFor = !dry && (kind === "render" || kind === "reroll")
      ? project.shots.filter((x) => !x.bypassed && x.kind !== "clip" && !x.lock).map((x) => x.id) : null;
    const body = takeAudio ? { project, take_audio: takeAudio } : takeClips ? { project, take_clips: takeClips } : exportClips ? { project, export_clips: exportClips }
      : faceTry ? { project, face_try: faceTry }
      : { project, upto, dry_run: !!dry, final, standalone, clips_for: clipsFor, chunk };
    built = await api("/longshot/build", { method: "POST", body });
  } catch (e) {
    undoSeeds();
    S.error = e.message;
    if (kind === "dry") showModal("Dry run · it stopped with an error", S.error);
    render();
    return;
  }
  const fresh = (built.warnings || []).filter((w) => !shownWarnings.has(w));
  fresh.forEach((w) => shownWarnings.add(w));
  if (fresh.length) toast(fresh.join(" "));
  let res;
  try {
    await pushLive();
    res = await api("/prompt", { method: "POST", body: { prompt: built.prompt, client_id: CLIENT_ID,
      extra_data: { preview_method: queuePreviewMethod() } } });
  } catch (e) {
    undoSeeds();
    S.error = describeQueueError(e);
    if (kind === "dry") showModal("Dry run · it stopped with an error", S.error);
    render();
    return;
  }
  if (kind === "render" || kind === "reroll" || kind === "final" || kind === "refresh") saveNow();   // approvals / new seed survive a closed tab
  // what each Shot is rendered with, so an edit back to exactly this can bring the take back
  const sent = {};
  for (const sh of project.shots) sent[sh.id] = { text: sh.text || "", seconds: Number(sh.seconds) };
  S.busy = {
    promptId: res.prompt_id, kind, target, label, note, baseNote: note, built, onDone, sent, batch, standalone, extra,
    jobId, slug: P().slug, project: P().name,
    of: built.chain.length, segs: {}, segT0: {}, step: 0, phase: "queued", started: Date.now(),
    refs: refSnapshot(),                             // the references these takes are made with
  };
  if (kind === "render" || kind === "reroll") S.open = target;
  render();
  renderQueue();
  pollLater();
}

function describeQueueError(e) {
  const d = e.data || {};
  const lines = [d.error && d.error.message ? d.error.message : e.message];
  for (const [node, info] of Object.entries(d.node_errors || {})) {
    for (const err of info.errors || []) {
      lines.push(`${info.class_type} (${node}): ${err.message}${err.details ? " — " + err.details : ""}`);
    }
  }
  return lines.join("\n");
}

const shownWarnings = new Set();     // each build warning once per session
let pollTimer = null;
function pollLater() {
  clearTimeout(pollTimer);
  if (!S.busy) return;
  // The websocket normally ends a run; polling covers a dropped socket.
  pollTimer = setTimeout(async () => {
    if (!S.busy) return;
    try {
      const h = await api("/history/" + encodeURIComponent(S.busy.promptId));
      const entry = h[S.busy.promptId];
      if (entry && entry.status && entry.status.completed !== undefined &&
          (entry.status.completed || entry.status.status_str === "error")) {
        return finish(S.busy.promptId, entry);
      }
    } catch (e) { /* try again */ }
    pollLater();
  }, 4000);
}

async function finish(promptId, entry) {
  const b = S.busy;
  if (!b || b.promptId !== promptId || b.finishing) return;
  b.finishing = true;
  clearTimeout(pollTimer);
  if (!entry) {
    for (let i = 0; i < 5 && !entry; i++) {
      try { entry = (await api("/history/" + encodeURIComponent(promptId)))[promptId]; } catch (e) { /* retry */ }
      if (!entry) await new Promise((r) => setTimeout(r, 400));
    }
  }
  S.busy = null;
  clearLive();
  if (b.kind === "render" || b.kind === "reroll") {
    const sh = b.target && P() && P().shots.find((x) => x.id === b.target);
    VIEW.done = sh ? titleOf(sh) : (b.label || "Render");
  }
  renderMini();
  let res = {};
  try {
    // the run's own project, whichever is open now
    res = (await inProject(b.slug || P().slug, () => finishIn(b, promptId, entry))) || {};
  } catch (e) { res = { ok: false, error: e.message }; }
  const job = b.jobId && Q.jobs.find((j) => j.id === b.jobId);
  if (job && !res.more) endJob(job, res.ok ? "done" : res.stopped ? "stopped" : "failed", res.error);
  if (!res.more) setTimeout(queueNext, 0);
  renderQueue();
}

/** What a finished run did, applied to its project (the open one or not). */
async function finishIn(b, promptId, entry) {
  if (b.kind === "render" || b.kind === "reroll" || b.kind === "refresh") S.takes = {};   // take lists changed
  const status = (entry && entry.status) || {};
  const msgs = status.messages || [];
  const failed = msgs.find((m) => m[0] === "execution_error");
  const stopped = msgs.find((m) => m[0] === "execution_interrupted");
  if (failed && b.kind === "check") {
    // the quiet reopen check: a failure here is reported by the next real render
  } else if (failed) {
    const d = failed[1];
    S.error = `${d.node_type || "A node"} failed: ${d.exception_message || "unknown error"}`.trim();
    // 0.12.9: a dry run that fails still opens its box, with the error in it
    if (b.kind === "dry") showModal("Dry run · it stopped with an error", S.error);
  } else if (stopped || b.stopped) {
    toast("Stopped. Finished segments stay in Long Shot's memory.");
  } else if (!entry) {
    S.error = "The render finished but ComfyUI's history has no record of it.";
  } else if (b.kind === "clips") {
    await adoptClips(Object.entries(b.built.nodes.clips || {}).map(([key, node]) => ({ key, node })), entry.outputs || {});
    if (S.exportAfter) { S.exportAfter = false; setTimeout(exportApproved, 0); }
  } else if (b.kind === "export") {
    await exportDone(b, entry.outputs || {});
  } else if (b.kind === "face") {
    await faceDone(b, entry.outputs || {});
  } else if (b.kind === "align") {
    await alignDone(b, entry.outputs || {});
  } else {
    const outputs = entry.outputs || {};
    let ls = outputs[b.built.nodes.longshot] || {};
    const cachedMsg = msgs.find((m) => m[0] === "execution_cached");
    const fromCache = cachedMsg && (cachedMsg[1].nodes || []).includes(b.built.nodes.longshot);
    const prev = last();
    if (!ls.plan_json && fromCache && prev && JSON.stringify(prev.chain) === JSON.stringify(b.built.chain)) {
      // Older ComfyUI drops a cached node's UI. A cache hit means the inputs
      // are identical to the last run, so its plan still applies.
      ls = { plan_json: prev.plan, text: [prev.text || ""] };
    }
    if (!ls.plan_json && fromCache) {
      S.error = "ComfyUI served this render from its cache without Long Shot's plan (an older " +
                "ComfyUI). Change anything, or update ComfyUI, and render again.";
    } else if (!ls.plan_json) {
      S.error = "Long Shot returned no plan data. Update the H3 Long Shot pack to the version " +
                "shipped with the Studio (it adds the plan and progress hooks).";
    } else {
      // ComfyUI can hand back a cached Long Shot's rows without Shot ids; the
      // rows follow the chain the Studio built, so the ids come from there.
      const rows = ls.plan_json;
      if (Array.isArray(rows) && rows.length === b.built.chain.length) {
        rows.forEach((r, i) => { if (r && !r.id) r.id = b.built.chain[i]; });
      }
      try { b.onDone({ rows, text: (ls.text || [""])[0], outputs, built: b.built, sent: b.sent }); }
      catch (e) { S.error = "Couldn't read the result: " + e.message; }
    }
  }
  render();
  if (b.kind === "render" || b.kind === "reroll" || b.kind === "final" || b.kind === "refresh") {
    if (!S.error) adoptCurrentFiles();
    if (entry && !failed) await cleanupOutputs(promptId, entry.outputs);
    if (entry && !failed && b.kind !== "final") {
      await fetchAllTakes();
      const lo = last();
      recordTakeRefs(b, lo);
      if (b.built.nodes.clips && lo) {
        // each new take's own clip: named after its take
        const items = Object.entries(b.built.nodes.clips).map(([sid, node]) => {
          const i = lo.chain.indexOf(sid), r = i >= 0 ? lo.plan[i] : null;
          return r && r.take ? { key: r.take.replace(/\.safetensors$/, ""), node } : null;
        }).filter(Boolean);
        await adoptClips(items, entry.outputs || {});
      }
      renderViewer();
    }
    loadSegStats().then(renderSettings);
    saveNow();                       // save right after every finished render
  } else scheduleSave();
  const ok = !failed && !stopped && !b.stopped && !S.error && !!entry;
  // Multi-take: pass 1's takes are the ones each Shot shows when the batch is over
  const job = b.jobId && Q.jobs.find((j) => j.id === b.jobId);
  if (ok && job) rememberPassOne(job);
  // Chunked upscale: the next chunk, or join them (the job goes on)
  let more = false;
  if (S.chunking && (b.kind === "final" || b.kind === "refresh") && S.chunking.slug === P().slug) {
    more = true;
    const C = S.chunking;
    setTimeout(() => chunkNext(C, ok), 0);
  }
  return { ok, more, stopped: !!(stopped || b.stopped),
    error: ok ? null : S.error || (stopped || b.stopped ? "Stopped." : !entry ? "ComfyUI has no record of the run." : "It failed.") };
}

/** "Update preview" under the timeline: the exact video of every rendered Shot
 *  (Shots not rendered yet left out). Nothing is sampled. */
function updatePreview() {
  if (!active().some(isRendered)) return;
  if (mixedSizeGuard("Update preview")) return;
  if (Q.jobs.some((j) => liveJob(j) && j.slug === P().slug && j.spec.type === "preview")) { toast("Update preview is already in the queue."); return; }
  enqueue({ type: "preview", focus: S.focus || null });
}

/** Item 3 (round 5): every rendered Shot back to "not rendered". */
function clearFields(s) {
  // keeps its seed: a Shot on auto renders once more with the seed its take used
  if (isAuto(s) && hasSeed(s.seed_used)) s.seed_pending = Number(s.seed_used);
  Object.assign(s, { status: "queued", take: null, rendered: null, edit_from: null, standalone: false,
    seam: null, was_approved: false, was_rendered: false, cleared: true });
}

async function clearAll() {
  if (busyGuard()) return;
  const list = active().filter((s) => s.kind !== "clip" && s.status !== "queued");
  if (!list.length) { toast("Nothing is rendered."); return; }
  const ans = await confirmBox({ title: `Clear all ${list.length} rendered Shot${list.length > 1 ? "s" : ""}?`,
    body: "Every Shot goes back to not rendered and keeps its prompt, length and seed. Takes stay in Take history. " +
      "With the same seeds, rendering again brings the same takes back from disk in moments.",
    yes: "Clear all", no: "Cancel", check: "Give every Shot a new random seed" });
  if (!ans || !ans.ok) return;
  for (const s of list) clearFields(s);
  if (ans.checked) {
    for (const s of active()) if (s.kind !== "clip") {
      rememberTake(s);
      if (isAuto(s)) s.seed_pending = seedIncrements() ? null : Math.floor(Math.random() * (SEED_MAX + 1));
      else s.shot_seed = Math.floor(Math.random() * (SEED_MAX + 1));
    }
  }
  S.gen++;
  S.dry = null;
  S.focus = null;
  commit();
  toast(`Cleared ${list.length} Shot${list.length > 1 ? "s" : ""}` + (ans.checked ? " and gave every Shot a new seed." : ". Their takes stay in Take history."));
}

/** Item 3: the preview from every rendered Shot, in order, with the Shots not
 *  rendered yet left out (hard cuts there). Every Shot loads its take. */
/** Update preview: the exact video of every rendered Shot (Shots not rendered
 *  yet left out). Nothing is sampled. The run options, for the queue. */
function previewOpts(focusId) {
  const act = active(), done = act.filter(isRendered);
  if (!done.length) return null;
  const gaps = act.filter((x) => !isRendered(x)).map((x) => x.id);
  return { upto: done[done.length - 1].id, kind: "refresh", omit: gaps,
    label: "Updating the preview · rendered Shots back to back",
    note: gaps.length ? "Nothing is sampled · Shots not rendered yet are left out" : "Nothing is sampled",
    onDone: onRendered(null, false, { gaps: gaps.length > 0, focus: focusId }) };
}

/** Save PNG / Save audio-less MP4 are off: delete those side files of the render
 *  that just finished (the video with sound is the one the player uses). */
async function cleanupOutputs(promptId, outputs) {
  const s = P().settings;
  if (s.save_png && s.save_noaudio) return;
  try {
    await api("/longshot/cleanup-outputs", { method: "POST",
      body: { prompt_id: promptId, png: !s.save_png, noaudio: !s.save_noaudio } });
  } catch (e) { return; }
  if (s.save_png) return;
  const made = new Set();
  for (const o of Object.values(outputs || {})) for (const g of (o && o.gifs) || []) made.add(g.filename);
  for (const o of [P().last_output, P().final_output]) {
    for (const k of ["video", "master"]) if (o && o[k] && made.has(o[k].filename)) o[k].workflow = null;
  }
}

/** Every rendered piece keeps its take, window and (frozen) seed, and what it
 *  was rendered with (text, seconds, seed). */
function adoptRows(rows, sent, standalone = false) {
  const byId = new Map(P().shots.map((x) => [x.id, x]));
  for (const r of rows) {
    const sh = r.id && byId.get(r.id);
    if (!sh || !r.take || sh.kind === "clip") continue;
    sh.take = r.take;
    if (r.status !== "locked") sh.render_model = P().settings.model || null;   // 0.10.0: what made it
    sh.window = r.window_frames;
    sh.take_seconds = Number(sh.seconds);
    // a Shot on auto stays on auto; the seed its take used is kept beside it
    sh.seed_used = r.seed !== null && r.seed !== undefined ? Number(r.seed) : effSeed(sh);
    if (r.status !== "locked") {
      sh.seed_pending = null;
      const act = active(), pv = act[act.indexOf(sh) - 1];
      sh.context_from = sh.join === "context" && pv ? (pv.kind === "clip" ? `clip:${pv.id}` : pv.take || null) : null;
    }
    const was = (sent || {})[sh.id] || { text: sh.text, seconds: Number(sh.seconds) };
    sh.rendered = { text: was.text, seconds: was.seconds, seed: Number(sh.shot_seed) };
    sh.edit_from = null;
    // a new take: standalone or continued (the first Shot has nothing before it either way)
    if (r.status !== "locked") sh.standalone = !!standalone && active()[0] !== sh;
    sh.cleared = false;
  }
}

/** The user has a Shot open that the run didn't touch (e.g. one added while it rendered). */
const elsewhere = (chain) => !!S.open && !chain.includes(S.open) && P().shots.some((x) => x.id === S.open);

function onRendered(targetId, standalone = false, opts = {}) {
  return ({ rows, text, outputs, built, sent }) => {
    const combine = built.nodes.combine ? outputs[built.nodes.combine] || {} : null;
    const video = combine ? (combine.gifs || combine.videos || [])[0] : null;
    if (combine && !video) throw new Error("Video Combine saved no file.");
    adoptRows(rows, sent, standalone);

    if (!opts.gaps) noteSeams(rows, built.chain, standalone);    // joins next to a left-out gap aren't real
    for (const s of P().shots) {
      if (built.chain.includes(s.id) && s.id !== targetId && s.status === "queued") {
        // rendered on the way to the target (or past it, to the last rendered Shot)
        s.status = s.was_approved ? "approved" : "review";
        s.was_approved = s.was_rendered = false;
      }
    }
    const target = targetId && P().shots.find((s) => s.id === targetId);
    if (target) { target.status = "review"; target.was_rendered = false; target.was_approved = false; }
    // a Shot edited while this rendered no longer matches its new take. Only its
    // prompt changed (0.8.6): the take stays for review, flagged, with Re-render.
    for (const s of P().shots) if (s.kind !== "clip" && s.status !== "queued" && s.rendered && !matchesRendered(s) && !promptOnlyChanged(s)) {
      s.edit_from = { status: s.status, was_approved: s.was_approved, was_rendered: s.was_rendered, take: s.take, gen: S.gen };
      s.status = "queued";
    }
    const at = new Date().toISOString();
    const prev = P().last_output || {};
    P().last_output = { video: video || prev.video || null, plan: rows, chain: built.chain, text,
      size: [built.width, built.height], at, source_at: at,
      video_plan: video ? rows : prev.video_plan || null, video_chain: video ? built.chain : prev.video_chain || null };
    if (video) P().preview_dirty = false;
    S.dry = null;
    if (targetId && !elsewhere(built.chain)) S.open = targetId;
    const focus = targetId || opts.focus;
    if (focus) S.focus = focus;
    loadVideo(undefined, focus);
    if (built.staleSize) {
      // the size or overlap changed while it rendered: these takes can't be used now
      for (const s of P().shots) if (built.chain.includes(s.id) && s.kind !== "clip" && s.status !== "queued") {
        if (s.status === "approved") s.was_approved = true; else s.was_rendered = true;
        s.status = "queued";
      }
      if (!S.swapped) changeNote("Size", "the Shots that rendered at the old size render again");
      return;
    }
    if (built.changedDuring && !S.swapped) {
      const done = active().filter((s) => built.chain.includes(s.id) && s.kind !== "clip" && s.status === "review" &&
        (rows.find((r) => r.id === s.id) || {}).status === "render");
      if (done.length) {
        const names = done.map(titleOf).join(", ");
        changeNote(built.changedDuring.join(", "), `${names} rendered with what was set when ${done.length > 1 ? "they" : "it"} started`, {
          label: `Re-render ${done.length > 1 ? "them" : "it"}`,
          fn: () => {
            S.gen++;
            for (const s of done) if (s.status === "review") { s.was_rendered = true; s.status = "queued"; }
            commit();
          } });
      }
    }
    const cuts = rows.filter((r) => r.seam === "mismatch").map((r) => r.index);
    if (cuts.length) {
      toast(`Hard cut before Shot ${cuts.join(", ")}: it was continued from a different take. ` +
            "Reroll that Shot to bridge the join.");
    }
  };
}

/** The preview no longer shows the timeline: a Shot was removed, bypassed,
 *  moved or switched to another take. Updating it samples nothing. */
function previewStale() {
  const lo = last();
  const done = active().filter(isRendered);
  if (!lo || !done.length || active().some((s) => s.status === "queued")) return false;
  if (P().preview_dirty || !lo.video_plan) return true;
  const shown = lo.video_plan.map((r, i) => r.kind === "clip" ? `${lo.video_chain[i]}:clip` : `${lo.video_chain[i] || ""}:${r.take || ""}`).join("|");
  return shown !== done.map((s) => s.kind === "clip" ? `${s.id}:clip` : `${s.id}:${s.take}`).join("|");
}

const refreshPreview = () => updatePreview();

async function primary() {
  const rv0 = reviewShot(), nx0 = nextToRender();
  if (nx0 && jobFor(nx0.id)) { toast(`${titleOf(nx0)} is already in the queue.`); return; }
  let alone = false;
  if (nx0 && nx0.standalone) {
    const mode = await askStandalone(nx0, "Render");
    if (!mode) return;
    alone = mode === "alone";
  }
  const takes = nx0 ? await askMulti(titleOf(nx0)) : 1;
  if (!takes) return;
  const rv = reviewShot(), nx = nextToRender();
  if (rv !== rv0 || nx !== nx0) return;        // something changed while the dialog was open
  if (rv) { rv.status = "approved"; rv.was_approved = false; }
  if (!nx) { scheduleSave(); render(); return; }
  enqueue({ type: "shot", target: nx.id, kind: "render", mode: nx.standalone ? (alone ? "alone" : "pinned") : "chain" }, takes);
}

async function reroll() {
  const rv = reviewShot();
  if (!rv || inRenderGuard(rv)) return;
  let alone = false;
  if (rv.standalone) {
    const mode = await askStandalone(rv, "Reroll");
    if (!mode || reviewShot() !== rv) return;
    alone = mode === "alone";
  }
  const takes = await askMulti(titleOf(rv));
  if (!takes || reviewShot() !== rv || inRenderGuard(rv)) return;
  rememberTake(rv);
  reseed(rv);
  rv.status = "queued";
  enqueue({ type: "shot", target: rv.id, kind: "reroll", mode: alone ? "alone" : "pinned" }, takes);
}

/** A Shot that's part of the run going now can't be changed until it ends. */
function inRenderGuard(s) {
  if (!s || !inRender(s)) return false;
  toast(`${titleOf(s)} is part of the render that's running. Queue it when that's done.`);
  return true;
}

/** Shots the panel buttons would render: not rendered yet, generated, active. */
const toRender = () => active().filter((s) => s.kind !== "clip" && s.status === "queued");
const oddToRender = () => toRender().filter((s) => numOf(s.id) % 2 === 1);

/** ▶ Render all: one run through every Shot not rendered yet, each continued
 *  from the Shot before it (the standard workflow). Rendered Shots keep their
 *  takes, so gaps between them render as bridges. All land under review. */
async function renderAll() {
  const list = toRender().filter((x) => !jobFor(x.id));
  if (!list.length) { toast(toRender().length ? "Those Shots are already in the queue." : "Every Shot is rendered."); return; }
  const takes = await askMulti(`Render all (${list.length} Shot${list.length > 1 ? "s" : ""})`);
  if (!takes) return;
  enqueue({ type: "all", ids: list.map((x) => x.id) }, takes);
}

/** ▶ Render odd Shots: Shots 1, 3, 5… not rendered yet, each on its own, one
 *  render after another. Then Render all (or the main button) bridges the gaps. */
async function renderOdd() {
  const list = oddToRender().filter((x) => !jobFor(x.id));
  if (!list.length) { toast(oddToRender().length ? "Those Shots are already in the queue." : "Every odd Shot is rendered."); return; }
  const takes = await askMulti(`Render odd Shots (${list.length} Shot${list.length > 1 ? "s" : ""})`);
  if (!takes) return;
  // one job per Shot, each on its own; with Multi-take, pass after pass
  enqueue(list.map((x) => ({ type: "shot", target: x.id, kind: "render", mode: "alone" })), takes);
}

/** ▶ on a Shot card: render it the way its join chip says (Multi-take asks first). */
async function renderAloneAction(s) {
  if (!s || s.kind === "clip" || s.bypassed) return;
  if (inRender(s) || jobFor(s.id)) {
    // rendering now or already queued: one more take after it, with the next seed
    const takes = await askMulti(`Another take of ${titleOf(s)}`);
    if (!takes) return;
    enqueue({ type: "shot", target: s.id, kind: "reroll", mode: "chip", again: true }, takes);
    return;
  }
  const takes = await askMulti(titleOf(s));
  if (!takes) return;
  enqueue({ type: "shot", target: s.id, kind: "render", mode: "chip" }, takes);
}

/** Item 4 (round 5): a standalone Shot re-rendering next to rendered Shots —
 *  pinned to them in place (default), or on its own again.
 *  "pinned" | "alone" | null (cancelled). No rendered neighbour: "alone". */
async function askStandalone(s, verb) {
  // a Shot that starts with a Context or Cut join has nothing to flow from: in place, no question
  if (isCut(s)) return "pinned";
  const act = active(), i = act.indexOf(s);
  const prev = act[i - 1] && isRendered(act[i - 1]) ? act[i - 1] : null;
  const nx = act[i + 1];
  const next = nx && isRendered(nx) && !isCut(nx) ? nx : null;
  if (!prev && !next) return "alone";
  const both = prev && next;
  const names = [prev, next].filter(Boolean).map(titleOf).join(" and ");
  const how = [prev ? `continues from the end of ${titleOf(prev)}` : "", next ? `flows into ${titleOf(next)}` : ""]
    .filter(Boolean).join(" and ");
  const ans = await confirmBox({ title: `${verb} ${titleOf(s)}`,
    body: `Pinned: ${titleOf(s)} ${how}, in place. ${names} keep${both ? "" : "s"} ${both ? "their takes" : "its take"}.\n\n` +
      `On its own: ${titleOf(s)} starts fresh from the references, with a hard cut to ${names} until you bridge ${both ? "them" : "it"} again.`,
    yes: `Pinned to ${names}`, alt: "On its own", no: "Cancel" });
  return ans === true ? "pinned" : ans === "alt" ? "alone" : null;
}

function pinnedNote(s) {
  const act = active(), i = act.indexOf(s);
  const nb = [act[i - 1], act[i + 1]].filter((x) => x && isRendered(x));
  return nb.length ? `pinned to ${nb.map(titleOf).join(" and ")}` : "";
}

/** Item 1 (round 5): back to "not rendered", keeping prompt, seconds and seed.
 *  The take stays on disk, in Take history. */
function clearRender(s) {
  if (!s || s.kind === "clip" || listGuard(P().shots.indexOf(s), 1) || s.status === "queued") return;
  clearFields(s);
  S.gen++;
  S.dry = null;
  commit();
  const pin = pinnedNote(s);
  toast(`${titleOf(s)} is cleared. It renders again${pin ? `, ${pin}` : ""}, with the same prompt, length and seed ` +
    "(the same picture unless something around it changed; Reroll for a new one). Its old take stays in Take history.");
}

function dryRun() {
  // 0.12.9: Shots made at another size are left out (Long Shot can't load them at this size)
  const shots = active().filter((x) => !otherSize(x));
  if (!shots.length) {
    showModal("Dry run", active().length ? "Every rendered Shot was made at another size than Settings make now, so there's nothing to plan at this size. Set the size back to see them." : "");
    return;
  }
  if (S.busy || S.chunking) { toast("The dry run starts when ComfyUI is free (a render is running)."); return; }
  runNow({ upto: shots[shots.length - 1].id, dry: true, kind: "dry", label: "Dry run · planning every shot",
    note: "Nothing is sampled", onDone: ({ rows, text, built }) => {
      S.dry = { rows, text, chain: built.chain };
      const odd = active().filter(otherSize);
      showModal("Dry run · full prompts", (odd.length ? `Left out (made at another size than Settings make now): ` +
        odd.map((x) => `${titleOf(x)} (${sizeText(takeSize(x))})`).join(", ") + "\n\n" : "") + text);
    } });
}

async function stop() {
  const b = S.busy;
  if (!b) { if (S.chunking) S.chunking.stopRequested = true; return; }   // between two chunks
  b.stopped = true;
  try { await api("/interrupt", { method: "POST", body: { prompt_id: b.promptId } }); } catch (e) { /* older ComfyUI */ }
  try { await api("/queue", { method: "POST", body: { delete: [b.promptId] } }); } catch (e) { /* not queued */ }
  pollLater();
}

// ---------------------------------------------------------------------------
// Websocket
// ---------------------------------------------------------------------------

let ws = null;
function connect() {
  const url = (location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/ws?clientId=" +
    encodeURIComponent(CLIENT_ID);
  try { ws = new WebSocket(url); } catch (e) { return retry(); }
  ws.onopen = () => {
    S.conn = "ok";
    pushLive();
    if (S.restarting) afterRestart();
    renderHeader(); renderDecision();
    if (P()) renderShots();                     // ▶ on Shot cards follows the connection
    pollStats();
    if (S.busy) pollLater(); else { queueNext(); autoCheck(); }
    renderQueue();
  };
  ws.onclose = () => { S.conn = S.restarting ? "restarting" : "down"; renderHeader(); renderDecision(); renderQueue(); if (P()) renderShots(); retry(); };
  ws.onerror = () => {};
  ws.onmessage = (ev) => {
    if (typeof ev.data !== "string") { onPreviewBytes(ev.data); return; }   // step previews
    let msg;
    try { msg = JSON.parse(ev.data); } catch (e) { return; }
    onMessage(msg.type, msg.data || {});
  };
}
function retry() { setTimeout(connect, 2000); }

function onMessage(type, d) {
  const b = S.busy;
  if (!b) return;
  const mine = d.prompt_id === undefined || d.prompt_id === b.promptId;
  if (!mine) return;
  switch (type) {
    case "execution_start": b.phase = "running"; break;
    case "executing":
      if (d.node === b.built.nodes.combine || d.node === "decode") b.phase = "saving";
      break;
    case "progress":
      if (d.node === b.built.nodes.longshot || d.node === undefined) {
        b.step = d.max ? d.value / d.max : 0;
        b.stepV = d.value;
        b.stepMax = d.max;
        syncLive();
      }
      break;
    case "mmh3.longshot": onSegment(b, d); if (b.slug === (P() && P().slug)) refreshRunRows(b); break;
    case "execution_success": case "execution_error": case "execution_interrupted":
      finish(b.promptId); return;
    default: return;
  }
  renderDecision();
  renderQueue();
  renderMini();
}

function onSegment(b, d) {
  b.of = d.of || b.of;
  b.segs[d.segment] = d.status;
  if (d.status === "reused") (b.sources = b.sources || {})[d.segment] = d.source || "memory";
  if (d.status === "rendering") { b.segT0[d.segment] = Date.now(); b.step = 0; b.current = d; }
  if (d.status === "done" && d.id) (b.doneIds = b.doneIds || new Set()).add(d.id);   // new takes this run
  if (d.status === "done" && b.segT0[d.segment] && d.seconds && b.slug === P().slug) {
    const rate = (Date.now() - b.segT0[d.segment]) / 1000 / d.seconds;   // wall s per video s
    const st = P().stats;
    st.rate = st.rate ? st.rate * 0.6 + rate * 0.4 : rate;
    st.n = (st.n || 0) + 1;
  }
  const reused = Object.entries(b.segs).filter(([, s]) => s === "reused").map(([k]) => +k);
  const cur = b.current && b.segs[b.current.segment] === "rendering" ? b.current.segment : null;
  if (cur) {
    const srcs = [...new Set(reused.map((k) => (b.sources || {})[k] || "memory"))];
    const word = (x) => (x === "take" ? "saved takes" : x);
    const from = srcs.length === 1 ? word(srcs[0]) : "takes, memory and disk";
    const r = reused.length ? (reused.length === 1 ? `Shot ${reused[0]} reused from ${from} · `
      : `Shots ${reused[0]}–${reused[reused.length - 1]} reused from ${from} · `) : "";
    b.note = `${r}Shot ${cur} of ${b.of} rendering`;
  }
}

// ---------------------------------------------------------------------------
// Live preview (0.8.10): while a Shot renders, ComfyUI's step previews show on
// the review screen. The Studio asks for them per render (extra_data
// preview_method): the sharp taeh3 decoder when it's installed, else ComfyUI's
// rough colour preview. Off: "none", so the render spends nothing on them.
// ---------------------------------------------------------------------------

const LIVE = { on: store("h3studio.livePreview") === "1", url: null, prompt: null };

// The preview panel can hide down to one status line (0.8.13). Live preview pauses
// while it's hidden, and comes back when it's shown only if it was switched on.
const VIEW = { hidden: store("h3studio.viewerHidden") === "1", done: null };

function livePreviewMethod() {
  if (!LIVE.on || VIEW.hidden) return "none";
  return S.opts && S.opts.preview_decoder ? "taesd" : "latent2rgb";
}

/** Long Shot 1.6.13+ reads the switch at every step: ComfyUI's own previews stay
 *  off for the Studio's renders and Long Shot makes them while the switch is on. */
const liveSwitch = () => !!(S.opts && S.opts.live_switch);

/** What a render asks ComfyUI for (extra_data.preview_method). */
const queuePreviewMethod = () => (liveSwitch() ? "none" : livePreviewMethod());

/** Tell Long Shot this tab's switch (now, so a running render follows from its next step). */
async function pushLive() {
  if (!liveSwitch() || S.conn !== "ok") return;
  try {
    await api("/longshot/live-preview", { method: "POST", body: { client_id: CLIENT_ID, method: livePreviewMethod() } });
  } catch (e) { /* older Long Shot or ComfyUI restarting: the next render sends it again */ }
}

/** H3 Long Shot is at least version a.b.c. */
function longshotAtLeast(...want) {
  const v = String((S.opts || {}).longshot_version || "0").split(".").map(Number);
  for (let i = 0; i < want.length; i++) { if ((v[i] || 0) !== want[i]) return (v[i] || 0) > want[i]; }
  return true;
}

/** Previews made behind the render (no wait for the GPU): rough from Long Shot 1.6.14,
 *  sharp from 1.6.15. Older versions measured 30-40% slower with the model partly in VRAM. */
function liveCostNote() {
  const sharp = !!(S.opts && S.opts.preview_decoder);
  return (sharp ? longshotAtLeast(1, 6, 15) : longshotAtLeast(1, 6, 14))
    ? "It runs behind the render, so it costs no measurable speed (a little extra VRAM)."
    : "With this H3 Long Shot it can slow renders by 30–40% when the model doesn't fully fit in VRAM; update H3 Long Shot to 1.6.15.";
}

function renderLiveToggle() {
  const sharp = !!(S.opts && S.opts.preview_decoder);
  $("live-preview").checked = LIVE.on;
  $("live-wrap").classList.toggle("on", LIVE.on);
  $("live-wrap").title = "Show the picture forming on this screen while a Shot renders. " + liveCostNote() + " " +
    (liveSwitch() ? "Takes effect at the next step, also mid-render. " : "Takes effect from the next render (update H3 Long Shot to 1.6.13 to switch mid-render). ") +
    (sharp ? "Quality: sharp (taeh3 decoder installed)." : "Quality: rough colours. Settings → Live preview quality installs the sharper decoder.");
}

/** A step preview from ComfyUI's socket: [event u32][image type u32][jpeg|png] (event 1),
 *  or [event 4][meta length u32][meta json][image] (newer clients). */
async function onPreviewBytes(blob) {
  const b = S.busy;
  if (!LIVE.on || !b || !b.promptId || !blob || blob.size < 9) return;
  const head = new DataView(await blob.slice(0, 8).arrayBuffer());
  const ev = head.getUint32(0);
  let img;
  if (ev === 1) img = blob.slice(8, blob.size, head.getUint32(4) === 2 ? "image/png" : "image/jpeg");
  else if (ev === 4) {
    const n = head.getUint32(4);
    let meta = {};
    try { meta = JSON.parse(await blob.slice(8, 8 + n).text()); } catch (e) { /* no meta */ }
    if (meta.prompt_id && meta.prompt_id !== b.promptId) return;
    img = blob.slice(8 + n, blob.size, meta.image_type || "image/jpeg");
  } else return;
  if (S.busy !== b) return;                         // finished meanwhile
  if (LIVE.url) URL.revokeObjectURL(LIVE.url);
  LIVE.url = URL.createObjectURL(img);
  LIVE.prompt = b.promptId;
  $("live-img").src = LIVE.url;
  syncLive();
}

/** Show the preview while this project's render runs and the player isn't playing. */
function syncLive() {
  const b = S.busy;
  const show = LIVE.on && !!LIVE.url && !!b && b.promptId === LIVE.prompt && !PL.playing &&
    (!b.slug || !P() || b.slug === P().slug);
  $("live-img").hidden = !show;
  $("live-label").hidden = !show;
  if (show) {
    const seg = b.current && b.current.segment;
    $("live-label").textContent = "Live" + (seg ? ` · Shot ${seg}${b.of ? " of " + b.of : ""}` : "") +
      (b.stepMax ? ` · step ${b.stepV}/${b.stepMax}` : "");
  }
}

function clearLive() {
  if (LIVE.url) URL.revokeObjectURL(LIVE.url);
  LIVE.url = LIVE.prompt = null;
  $("live-img").removeAttribute("src");
  syncLive();
}

function setLive(on) {
  LIVE.on = !!on;
  store("h3studio.livePreview", LIVE.on ? "1" : "0");
  pushLive();
  if (LIVE.on) {
    toast(`Live preview on: the picture forms on the review screen from the next ${liveSwitch() ? "step" : "render"}. ` +
      liveCostNote());
  } else clearLive();
  renderLiveToggle();
}

/** Settings: download the sharper preview decoder (taeh3) into models/vae_approx. */
async function installPreview() {
  const page = "https://github.com/madebyollin/taehv";
  if (!S.local) {
    showModal("Better live preview", "", `<p>On the machine running ComfyUI, download <code>safetensors/taeh3.safetensors</code> from
      <a href="${page}" target="_blank" rel="noopener">${page}</a> into <code>ComfyUI/models/vae_approx</code>.</p>`);
    return;
  }
  const ok = await confirmBox({ title: "Install the better-quality preview?",
    body: "Downloads madebyollin's taeh3 decoder (22 MB, MIT licence) into ComfyUI's models/vae_approx folder. " +
      "Live previews then show close-to-final frames. No restart needed.", yes: "Download", no: "Cancel" });
  if (!ok) return;
  toast("Downloading the preview decoder…");
  try { await api("/longshot/install-preview", { method: "POST" }); }
  catch (e) {
    showModal("Better live preview", "", `<p>${esc(e.message)}</p>`);
    return;
  }
  try { S.opts = await api("/longshot/options"); } catch (e) { /* keep */ }
  toast("Sharper live preview installed.");
  renderLiveToggle();
  renderSettings();
}

// ---------------------------------------------------------------------------
// Restore references (0.8.13): each take made from now on remembers the references
// it was rendered with (the live pictures, voices and RefMods). Shared sets are
// stored once in p.ref_sets; p.take_refs maps a take to its set.
// ---------------------------------------------------------------------------

const REF_KINDS = [["cast", "picture", "pictures"], ["voices", "voice", "voices"], ["refmods", "RefMod", "RefMods"]];

function refSnapshot(p = P()) {
  const live = (xs) => JSON.parse(JSON.stringify((xs || []).filter((x) => !x.bypassed)));
  return { cast: live(p.cast), voices: live(p.voices), refmods: live(p.refmods) };
}

function refSetKey(set) {
  const txt = JSON.stringify(set);
  let h = 2166136261;
  for (let i = 0; i < txt.length; i++) { h ^= txt.charCodeAt(i); h = Math.imul(h, 16777619); }
  return "r" + (h >>> 0).toString(36) + txt.length.toString(36);
}

/** After a render: the takes it made (not the reused ones) remember its references. */
function recordTakeRefs(b, lo) {
  if (!b || !b.refs || !b.doneIds || !lo || !lo.plan || !lo.chain) return;
  const p = P();
  const key = refSetKey(b.refs);
  let n = 0;
  lo.chain.forEach((sid, i) => {
    const r = lo.plan[i];
    if (!r || !r.take || !b.doneIds.has(sid)) return;
    const k = takeStem(r.take);
    if (p.take_refs[k]) return;
    p.take_refs[k] = key;
    n++;
  });
  if (n) p.ref_sets[key] = b.refs;
}

function refSetFor(s) {
  const p = P(), k = s && s.take ? p.take_refs[takeStem(s.take)] : null;
  return k ? p.ref_sets[k] || null : null;
}

const restoreName = (kind, x) => kind === "refmods" ? (x.label || x.name || "RefMod")
  : (x.label && x.label !== "<new>" ? x.label : (x.original_name || x.image || x.file || "untitled"));

/** Put back the references a Shot's take was made with: removed ones are added again
 *  (where they were), bypassed ones turned on. Nothing else changes. */
async function restoreRefs(s) {
  if (!s || setupGuard()) return;
  const set = refSetFor(s);
  if (!set) { toast(`${titleOf(s)}'s take was made before 0.8.13, so the references it used weren't recorded.`); return; }
  const p = P(), changes = [];
  for (const [kind, one] of REF_KINDS) {
    for (const item of set[kind] || []) {
      const ex = (p[kind] || []).find((x) => x.id === item.id);
      if (ex && ex.bypassed) changes.push({ how: "on", kind, one, ex, name: restoreName(kind, ex) });
      else if (!ex) changes.push({ how: "add", kind, one, item, name: restoreName(kind, item) });
    }
  }
  if (!changes.length) { toast(`All of ${titleOf(s)}'s references are already in Cast & Scenes.`); return; }
  const redo = active().filter((x) => x.kind !== "clip" && x.status === "review");
  const nApproved = approvedShots().length;
  const body = `<p>Puts back what ${esc(titleOf(s))}'s take was made with:</p><ul class="restore-refs-list">` +
    changes.map((c) => `<li>${esc(c.one)} <b>${esc(c.name)}</b> · ${c.how === "on" ? "turned back on" : "added again"}</li>`).join("") +
    `</ul><p class="muted small" style="margin-top:10px">The labels after them renumber (<code>&lt;Picture N&gt;</code>), so every Shot's prompt changes. ` +
    (nApproved ? `${nApproved} approved Shot${nApproved > 1 ? "s keep their takes" : " keeps its take"}. ` : "") +
    (redo.length ? `${redo.map(titleOf).join(", ")} will render again.` : "No Shot under review renders again.") + "</p>";
  const ok = await confirmBox({ title: "Restore references?", body, html: true, yes: "Restore", no: "Cancel" });
  if (!ok) return;
  for (const c of changes) {
    if (c.how === "on") { c.ex.bypassed = false; continue; }
    const list = p[c.kind], order = set[c.kind].map((x) => x.id);
    // after the nearest reference that came before it in the take's set
    let at = 0;
    for (let i = order.indexOf(c.item.id) - 1; i >= 0; i--) {
      const j = list.findIndex((x) => x.id === order[i]);
      if (j >= 0) { at = j + 1; break; }
    }
    list.splice(at, 0, Object.assign(JSON.parse(JSON.stringify(c.item)), { bypassed: false }));
  }
  normalize(p);
  applyRefChange(await askRefChange(), "References restored");
  commit();
  toast(`Restored ${changes.length} reference${changes.length > 1 ? "s" : ""} from ${titleOf(s)}'s take.`);
}

function setViewerHidden(on) {
  VIEW.hidden = !!on;
  store("h3studio.viewerHidden", VIEW.hidden ? "1" : "0");
  if (VIEW.hidden) {
    if (S.theater) setTheater(false);
    if (PL.playing) pausePlayer();
  }
  applyViewerHidden();
  pushLive();                                      // hidden: no previews; shown: the switch as it was
  if (!VIEW.hidden) { layoutStage(); renderViewer(); }
}

function applyViewerHidden() {
  $("viewer-panel").classList.toggle("mini", VIEW.hidden);
  $("viewer-mini").hidden = !VIEW.hidden;
  const fb = $("viewer-fold");
  fb.setAttribute("aria-expanded", String(!VIEW.hidden));
  fb.title = VIEW.hidden ? "Show the video, timeline and controls again"
    : "Fold the video, timeline and controls to one status line (Live preview pauses while it's folded)";
  if (VIEW.hidden) renderMini();
}

/** The status line of the hidden preview: rendering / no Shot queued / Shot completed. */
function renderMini() {
  if (!VIEW.hidden) return;
  const b = S.busy, dot = $("vm-dot"), bar = $("vm-bar");
  let text, pct = null, cls = "";
  if (b) {
    const here = !b.slug || !P() || b.slug === P().slug;
    const seg = b.current && b.current.segment;
    const sh = b.current && b.current.id ? shotById(b.current.id) : null;
    const what = sh ? titleOf(sh) : seg ? `Shot ${seg}` : (b.label || "Render");
    text = b.phase === "queued" ? `${b.label || "Render"} · waiting for ComfyUI`
      : b.phase === "saving" ? `${what} · saving`
        : `Rendering ${what}${b.of > 1 && seg ? ` (${seg} of ${b.of})` : ""}` +
          (b.stepMax ? ` · step ${b.stepV}/${b.stepMax}` : "");
    if (!here) text += ` · in ${b.project || b.slug}`;
    pct = progressOf(b);
    cls = "run";
  } else if (VIEW.done) {
    text = `${VIEW.done} completed`;
    cls = "done";
  } else text = "No Shot queued";
  $("vm-text").textContent = text;
  dot.className = "vm-dot" + (cls ? " " + cls : "");
  bar.hidden = pct === null;
  if (pct !== null) $("vm-fill").style.width = Math.max(0, Math.min(100, pct)) + "%";
}

function progressOf(b) {
  if (b.phase === "saving") return 96;
  const of = b.of || 1;
  let done = 0, cur = 0;
  for (const s of Object.values(b.segs)) {
    if (s === "reused" || s === "done") done++;
    else if (s === "rendering") cur = b.step || 0;
  }
  return Math.max(1, Math.min(95, Math.round(((done + cur) / of) * 95)));
}

function etaOf(b) {
  const rate = P().stats.rate;
  if (!rate || !b.current || b.segs[b.current.segment] !== "rendering") return "";
  const left = rate * b.current.seconds - (Date.now() - b.segT0[b.current.segment]) / 1000;
  if (left <= 0) return "";
  return left < 90 ? ` · about ${Math.ceil(left / 5) * 5}s left` : ` · about ${Math.round(left / 60)} min left`;
}

// ---------------------------------------------------------------------------
// Viewer
// ---------------------------------------------------------------------------

const video = $("video");
let rafId = null;

function viewURL(f) {
  return "/view?filename=" + encodeURIComponent(f.filename) + "&subfolder=" +
    encodeURIComponent(f.subfolder || "") + "&type=" + encodeURIComponent(f.type || "output");
}

// ---------------------------------------------------------------------------
// Timeline player (round 5). The timeline is every active Shot in order.
// When the last preview video is exactly that timeline, it plays that video
// (exact joins). Otherwise each Shot plays its take's clip — cut on the CPU
// from the render that made it — so switching takes never decodes anything;
// Shots not rendered yet are dark gaps of their length.
// ---------------------------------------------------------------------------

let TL = { exact: false, entries: [], total: 0, sig: "" };
const PL = { t: 0, playing: false, src: null, k: -1, gapT: 0, gapWall: 0 };

// ---------------------------------------------------------------------------
// Timeline zoom and scroll. #tl-canvas is the whole film, `z` times the width of
// #tl-view (z = 1: the whole film fits). Blocks, the scrub bar, the loop band and
// the playhead are placed in % of the canvas, so they stay in step at any zoom.
// ---------------------------------------------------------------------------

const TL_MIN_BLOCK = 76;              // px: a thumbnail with ◀ n/m ▶ (narrower blocks pop out on hover)
const TL_MAX_PX = FPS * 18;           // closest zoom: 18 px per frame
const TLV = {
  z: Math.max(1, Number(store("h3studio.tlZoom")) || 1),
  hold: 0,                            // until then the user steers: don't follow the playhead
  lastT: -1, focus: null, raf: 0, w: 0, h: 64, altWheel: false,
};
const tlView = $("tl-view"), tlCanvas = $("tl-canvas");

const tlFitPx = () => (TL.total > 0 ? (tlView.clientWidth || 1) / TL.total : 1);
const tlMaxZ = () => Math.max(1, TL_MAX_PX / tlFitPx());
/** Pixels per second of film at the current zoom. */
const tlPx = () => (TL.total > 0 ? tlCanvas.offsetWidth / TL.total : 1);
const tlUser = () => { TLV.hold = performance.now() + 2500; };

/** Zoom to z (1 = whole film), keeping the moment under view-x `ax` where it is. */
function tlSetZoom(z, ax) {
  if (!TL.total) return;
  const w = tlView.clientWidth;
  if (ax === undefined) ax = w / 2;
  const t = (tlView.scrollLeft + ax) / tlPx();
  TLV.z = Math.min(tlMaxZ(), Math.max(1, z));
  store("h3studio.tlZoom", String(TLV.z));
  tlCanvas.style.width = Math.round(w * TLV.z) + "px";
  tlView.scrollLeft = t * tlPx() - ax;
  layoutTL();
}

const RULER_FRAMES = [1, 2, 3, 6, 12, 24, 48, 120, 240, 360, 720, 1440, 2880, 7200, 14400];

function rulerLabel(f) {
  if (f % FPS) return (f % FPS) + "f";
  const s = f / FPS, m = Math.floor(s / 60);
  return m + ":" + String(s - m * 60).padStart(2, "0");
}

/** The ruler, drawn only for the visible part (plus a margin). */
function drawRuler(px, L, R) {
  const pf = px / FPS;                               // px per frame
  const major = RULER_FRAMES.find((f) => f * pf >= 64) || RULER_FRAMES[RULER_FRAMES.length - 1];
  const minor = RULER_FRAMES.find((f) => f * pf >= 7 && major % f === 0) || major;
  const end = Math.round(TL.total * FPS);
  const a = Math.max(0, Math.floor((L - 80) / pf / minor) * minor);
  const b = Math.min(end, Math.ceil((R + 80) / pf));
  let h = "";
  for (let f = a; f <= b; f += minor) {
    const x = (f * pf).toFixed(1);
    if (f % major === 0) {
      h += `<div class="tl-rt major" style="left:${x}px"></div>` +
        `<div class="tl-rl${f % FPS ? " sub" : ""}" style="left:${x}px">${rulerLabel(f)}</div>`;
    } else h += `<div class="tl-rt" style="left:${x}px"></div>`;
  }
  // 0.11.0: phrase starts, where the song sits under the film
  if (songOn()) {
    const st = songStart();
    for (const t of phrases()) {
      const f = (t - st) * FPS;
      if (f < a - minor || f > b + minor) continue;
      h += `<div class="tl-ph" style="left:${(f * pf).toFixed(1)}px" title="Phrase at ${fmtSong(t)} in the song"></div>`;
    }
  }
  $("tl-ruler").innerHTML = h;
}

/** Playhead line, and its mark on the scroll bar. */
function placeHead(t) {
  const total = TL.total, head = $("tl-head");
  head.hidden = !total;
  if (!total) return;
  const p = Math.max(0, Math.min(100, (t / total) * 100)) + "%";
  head.style.left = p;
  $("tl-smark").style.left = p;
}

function drawSbar() {
  const w = tlView.clientWidth, cw = tlCanvas.offsetWidth || w;
  const th = $("tl-sthumb");
  th.style.left = (tlView.scrollLeft / cw) * 100 + "%";
  th.style.width = Math.min(100, (w / cw) * 100) + "%";
  $("tl-sbar").classList.toggle("full", cw <= w + 1);
}

/** Size the canvas for the zoom, then the parts that depend on what is visible. */
function layoutTL() {
  const w = tlView.clientWidth;
  if (!w) return;
  if (TL.total > 0) TLV.z = Math.min(TLV.z, tlMaxZ());
  const cw = TL.total > 0 ? Math.round(w * TLV.z) : w;
  if (tlCanvas.style.width !== cw + "px") tlCanvas.style.width = cw + "px";
  TLV.w = w;
  const px = tlPx(), L = tlView.scrollLeft, R = L + w;
  // narrow blocks pop out to full size on hover, centred on their spot, inside the view
  const byId = new Map(TL.entries.map((e) => [e.id, e]));
  for (const b of $("tl-strip").children) {
    const e = byId.get(b.dataset.tl);
    if (!e) continue;
    const bw = e.dur * px, narrow = bw < TL_MIN_BLOCK;
    b.classList.toggle("narrow", narrow);
    if (narrow) {
      const x0 = e.start * px;
      let nl = x0 + bw / 2 - TL_MIN_BLOCK / 2;
      nl = Math.max(L, Math.min(R - TL_MIN_BLOCK, nl));
      nl = Math.max(0, Math.min(cw - TL_MIN_BLOCK, nl));
      b.style.setProperty("--pop", (nl - x0).toFixed(1) + "px");
    }
    // a block wider than the view keeps its label and ◀ take ▶ in the visible part
    let in0 = 0, in1 = 0;
    if (!narrow) {
      const x0 = e.start * px, x1 = x0 + bw;
      in0 = Math.max(0, Math.min(L - x0, bw - TL_MIN_BLOCK));
      in1 = Math.max(0, Math.min(x1 - R, bw - TL_MIN_BLOCK - in0));
    }
    b.style.setProperty("--in0", in0.toFixed(1) + "px");
    b.style.setProperty("--in1", in1.toFixed(1) + "px");
  }
  if (TL.total > 0) drawRuler(px, L, R); else $("tl-ruler").innerHTML = "";
  drawSbar();
}

const tlLayoutSoon = () => {
  if (TLV.raf) return;
  TLV.raf = requestAnimationFrame(() => { TLV.raf = 0; layoutTL(); });
};

/** Scroll so time range a..b (seconds) is in view; centred when it has to move. */
function tlRevealRange(a, b) {
  if (!TL.total || TLV.z <= 1.0001) return;
  const px = tlPx(), w = tlView.clientWidth, L = tlView.scrollLeft, pad = Math.min(40, w / 10);
  const x0 = a * px, x1 = Math.max(b * px, x0 + TL_MIN_BLOCK);
  if (x0 >= L + pad && x1 <= L + w - pad) return;
  tlView.scrollLeft = x1 - x0 < w - 2 * pad ? (x0 + x1) / 2 - w / 2 : x0 - pad;
  tlLayoutSoon();
}

/** Bring a Shot's block into view. */
function tlReveal(id) {
  const e = TL.entries.find((x) => x.id === id);
  if (e) tlRevealRange(e.start, e.start + e.dur);
}

/** The view follows the playhead when it moves out of sight (not while the user steers). */
function tlFollow(t) {
  if (t === TLV.lastT) return;
  TLV.lastT = t;
  if (!TL.total || TLV.z <= 1.0001 || performance.now() < TLV.hold) return;
  const px = tlPx(), w = tlView.clientWidth, L = tlView.scrollLeft, x = t * px;
  if (x >= L && x <= L + w - 6) return;
  tlView.scrollLeft = PL.playing ? x - w * 0.08 : x - w / 2;
  tlLayoutSoon();
}

tlView.addEventListener("scroll", tlLayoutSoon, { passive: true });
if (window.ResizeObserver) {
  new ResizeObserver(() => {
    const w = tlView.clientWidth;
    if (!w || w === TLV.w) return;
    const t = TL.total ? tlView.scrollLeft / tlPx() : 0;
    layoutTL();
    if (TL.total) tlView.scrollLeft = t * tlPx();
  }).observe(tlView);
}

// Timeline height (Ctrl + wheel): taller blocks show more of each thumbnail.
const TL_H_MIN = 64, TL_H_MAX = 240;
function tlSetHeight(h) {
  TLV.h = Math.round(Math.min(TL_H_MAX, Math.max(TL_H_MIN, h)));
  $("tl-strip").style.height = TLV.h + "px";
  store("h3studio.tlHeight", String(TLV.h));
}
tlSetHeight(Number(store("h3studio.tlHeight")) || TL_H_MIN);

// Wheel over the timeline: plain = move along the film, Alt = zoom around the
// cursor, Ctrl = timeline height.
tlView.addEventListener("wheel", (e) => {
  const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? tlView.clientWidth : 1;
  const dx = e.deltaX * unit, dy = e.deltaY * unit;
  const d = Math.abs(dx) > Math.abs(dy) ? dx : dy;
  if (e.ctrlKey || e.metaKey) {
    e.preventDefault();                           // not the browser's page zoom
    tlSetHeight(TLV.h * Math.exp(-Math.max(-300, Math.min(300, d)) * 0.002));
    layoutTL();
    return;
  }
  if (!TL.total) return;
  e.preventDefault();
  tlUser();
  if (e.altKey) {
    TLV.altWheel = true;
    const r = tlView.getBoundingClientRect();
    tlSetZoom(TLV.z * Math.exp(-Math.max(-300, Math.min(300, d)) * 0.0025), e.clientX - r.left);
    return;
  }
  tlView.scrollLeft += d;
}, { passive: false });

// Alt + wheel: releasing Alt mustn't then focus the browser's menu (Windows).
window.addEventListener("keydown", (e) => { if (e.key === "Alt" && !e.repeat) TLV.altWheel = false; }, true);
window.addEventListener("keyup", (e) => {
  if (e.key === "Alt" && TLV.altWheel) { e.preventDefault(); TLV.altWheel = false; }
}, true);

// Double-click a Shot's block: its card, with the cursor in the prompt (a clip: its card).
// The first click re-renders the strip, so the browser's dblclick never fires: two
// clicks on the same Shot within the double-click time count instead.
const tlDbl = { id: null, at: 0 };
$("tl-strip").addEventListener("click", (e) => {
  if (e.target.closest(".tl-arrow")) { tlDbl.id = null; return; }
  const b = e.target.closest("[data-tl]");
  if (!b) return;
  const now = performance.now(), id = b.dataset.tl;
  if (tlDbl.id === id && now - tlDbl.at < 450) {
    tlDbl.id = null;
    e.stopPropagation();                          // not a second pick
    tlOpenPrompt(id);
    return;
  }
  tlDbl.id = id;
  tlDbl.at = now;
});

function tlOpenPrompt(id) {
  const sh = shotById(id);
  if (!sh) return;
  if (S.focus !== sh.id || S.open !== sh.id) focusShot(sh.id);
  setTimeout(() => {
    const card = document.querySelector(`.shot[data-shot="${CSS.escape(sh.id)}"]`);
    if (!card) return;
    card.scrollIntoView({ block: "center", behavior: "smooth" });
    const box = sh.kind !== "clip" && card.querySelector('textarea[data-shot-field="text"]');
    if (box) { box.focus({ preventScroll: true }); box.setSelectionRange(box.value.length, box.value.length); }
  }, 0);
}

// Drag anywhere on the timeline (but the scrub bar and the take arrows) to scroll.
// A click without dragging still works: a block picks its Shot, the ruler seeks.
(function tlDrag() {
  let d = null, swallow = 0;
  tlView.addEventListener("click", (c) => {
    if (performance.now() < swallow) { c.stopPropagation(); c.preventDefault(); }
  }, true);
  tlView.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 && e.button !== 1) return;
    if (e.target.closest("#scrub, .tl-arrow, .tl-trim")) return;
    d = { x: e.clientX, s: tlView.scrollLeft, id: e.pointerId, moved: false, ruler: !!e.target.closest("#tl-ruler") };
    if (e.button === 1) e.preventDefault();
  });
  tlView.addEventListener("pointermove", (e) => {
    if (!d || e.pointerId !== d.id) return;
    const dx = e.clientX - d.x;
    if (!d.moved && Math.abs(dx) < 5) return;
    if (!d.moved) {
      d.moved = true;
      tlView.classList.add("panning");
      try { tlView.setPointerCapture(e.pointerId); } catch (err) { /* gone */ }
    }
    tlUser();
    tlView.scrollLeft = d.s - dx;
  });
  const end = (e) => {
    if (!d || e.pointerId !== d.id) return;
    const was = d;
    d = null;
    tlView.classList.remove("panning");
    if (was.moved) {
      swallow = performance.now() + 80;             // the click that follows a drag isn't a pick
    } else if (was.ruler && e.type === "pointerup" && TL.entries.some((x) => x.src)) {
      const r = tlView.getBoundingClientRect();
      if (PL.playing) pausePlayer();
      tlSeek((tlView.scrollLeft + e.clientX - r.left) / tlPx());
    }
  };
  tlView.addEventListener("pointerup", end);
  tlView.addEventListener("pointercancel", end);
})();

// Double-click the ruler: the whole film.
$("tl-ruler").addEventListener("dblclick", (e) => {
  e.preventDefault();
  tlUser();
  tlSetZoom(1);
  tlView.scrollLeft = 0;
});

// The scroll bar: drag the thumb, or press the track to centre the view there.
(function tlSbarDrag() {
  const bar = $("tl-sbar"), thumb = $("tl-sthumb");
  let d = null;
  bar.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    const r = bar.getBoundingClientRect(), cw = tlCanvas.offsetWidth, w = tlView.clientWidth;
    if (cw <= w + 1) return;
    e.preventDefault();
    tlUser();
    if (e.target !== thumb) tlView.scrollLeft = ((e.clientX - r.left) / r.width) * cw - w / 2;
    d = { x: e.clientX, s: tlView.scrollLeft, k: cw / r.width, id: e.pointerId };
    try { bar.setPointerCapture(e.pointerId); } catch (err) { /* gone */ }
  });
  bar.addEventListener("pointermove", (e) => {
    if (!d || e.pointerId !== d.id) return;
    tlUser();
    tlView.scrollLeft = d.s + (e.clientX - d.x) * d.k;
  });
  const end = (e) => { if (d && e.pointerId === d.id) d = null; };
  bar.addEventListener("pointerup", end);
  bar.addEventListener("pointercancel", end);
})();

const shotById = (id) => P().shots.find((x) => x.id === id);

/** A take's (or a Clip Shot's trimmed piece's) clip name on disk. */
function clipKey(s) {
  if (!s) return null;
  if (s.kind === "clip") {
    return `clipshot__${s.id}__${Math.round((Number(s.clip.trim_in) || 0) * 1000)}_${s.clip.frames || 0}`
      .replace(/[^A-Za-z0-9_-]/g, "_");
  }
  return s.take ? s.take.replace(/\.safetensors$/, "") : null;
}
function clipFile(key, ext) {
  const c = S.clips[key] || {};
  return `/view?filename=${encodeURIComponent(key + ext)}&subfolder=${encodeURIComponent("longshot/" + P().slug + "/clips")}` +
    `&type=output&v=${encodeURIComponent(c.made || "")}`;
}

async function loadClips() {
  S.clipsReady = false;
  try { S.clips = await api("/longshot/clips/" + P().slug) || {}; S.clipsReady = true; } catch (e) { S.clips = {}; }
}

/** Every Shot's takes in one call (the timeline shows ◀ ▶ under each block). */
async function fetchAllTakes() {
  if (!P()) return;
  let list = [];
  try { list = (await api(`/longshot/takes/${encodeURIComponent(P().slug)}`)).takes || []; } catch (e) { return; }
  const by = {};
  for (const t of list) {
    const id = t.name.split("__").slice(0, -2).join("__");
    (by[id] = by[id] || []).push(t);
  }
  for (const s of P().shots) if (s.kind !== "clip") S.takes[s.id] = by[s.id.replace(/[^A-Za-z0-9_-]+/g, "_")] || [];
}

/** Clips Video Combine just saved (one per take) become the timeline's clips. */
async function adoptClips(items, outputs) {
  const list = items.map(({ key, node }) => {
    const o = outputs[node] || {};
    const file = (o.gifs || o.videos || [])[0];
    return file ? { key, file } : null;
  }).filter(Boolean);
  if (!list.length) return;
  try {
    S.clips = await api(`/longshot/clips/${P().slug}/adopt`, { method: "POST", body: { items: list } }) || S.clips;
  } catch (e) { toast("Couldn't keep the clips: " + e.message); }
  renderViewer();
}

const takeStem = (name) => (name || "").replace(/\.safetensors$/, "");

/** The Shot a take belongs to. */
function shotOfTake(name) {
  for (const [sid, list] of Object.entries(S.takes)) if ((list || []).some((t) => t.name === name)) return sid;
  const s = P().shots.find((x) => x.take === name);
  return s ? s.id : null;
}

/** A take's window in frames. */
function takeWindow(sid, name) {
  const t = (S.takes[sid] || []).find((x) => x.name === name), s = shotById(sid);
  return Number((t && t.window_frames) || (s && s.take === name ? s.window : 0)) || 0;
}

/** 0.9.0, "Song in final video": the song for a take's whole clip, where the take sits in
 *  the song ({song_at, song_len} in seconds of the song file), or {} when off / unknown. */
function takeSong(name) {
  if (!songMode()) return {};
  const sid = shotOfTake(name), L = sid && LAYOUT.byId[sid], w = sid ? takeWindow(sid, name) : 0;
  if (!L || !w) return {};
  const sh = shotById(sid), shift = sh ? effEdit(sh).shift : 0;
  return { song_at: +(songStart() + (L.we - w + shift) / LAYOUT.fps).toFixed(4), song_len: +(w / LAYOUT.fps).toFixed(4) };
}

/** An approved Shot as the film shows it (0.9.0): with trims, the take's frames from
 *  trim_in for length, and the song under it on the film (its move included). */
function exportCut(s) {
  const L = LAYOUT.byId[s.id], w = takeWindow(s.id, s.take), out = {};
  if (L && w && hasEdit(s)) {
    const e = effEdit(s), t0 = L.we - w;
    out.trim_in = Math.max(0, L.vs - t0 + e.in);
    out.length = Math.max(1, w - out.trim_in - e.out);
    if (songMode()) {
      out.song_at = +(songStart() + (t0 + out.trim_in + e.shift) / LAYOUT.fps).toFixed(4);
      out.song_len = +(out.length / LAYOUT.fps).toFixed(4);
    }
  } else Object.assign(out, takeSong(s.take));
  return out;
}

/** Decode takes on their own into clips (nothing samples, nothing is stitched). */
async function makeClips(takes) {
  const list = takes.filter((t) => t && t.take && !S.clips[takeStem(t.take)]).slice(0, 24);
  if (!list.length || S.busy || S.queuing || !S.clipsReady) return;
  list.forEach((t) => S.clipTried.add(t.take));
  await runNow({ kind: "clips", takeClips: list.map((t) => Object.assign({ key: takeStem(t.take), take: t.take }, takeSong(t.take))),
    label: `Making clip${list.length > 1 ? "s" : ""} · ${list.length} take${list.length > 1 ? "s" : ""}`,
    note: "Each take decoded on its own · nothing is sampled", onDone: () => {} });
  // it didn't start (ComfyUI busy, another job first…): try again later
  if (!S.busy || S.busy.kind !== "clips") list.forEach((t) => S.clipTried.delete(t.take));
}

/** The takes the timeline shows always get a clip (older takes, take switches). */
/** Clips are never made on their own (opening a project, after a render): the
 *  timeline offers "Make N missing clips" instead. Kept as a no-op for callers. */
function ensureClips() {}

/** The takes the timeline shows that have no clip (deleted, or made before 0.6.5). */
function missingClips() {
  if (!P() || !S.clipsReady) return [];
  return active().filter((s) => s.kind !== "clip" && isRendered(s) && s.take && !S.clips[takeStem(s.take)])
    .map((s) => ({ take: s.take }));
}

function makeMissingClips(list) {
  if (S.busy || S.chunking || S.queuing) { toast("ComfyUI is busy. Make the clips when the queue is done."); return; }
  list.forEach((t) => S.clipTried.delete(t.take));
  makeClips(list);
}

// ---------------------------------------------------------------------------
// Export approved clips: each approved Shot's own clip, whole (nothing hidden
// at the joins), numbered as on the timeline, into <project>/Approved_Clips
// ---------------------------------------------------------------------------

function seedOfTake(s) {
  const m = /__(\d+)__/.exec(s.take || "");
  return m ? m[1] : effSeed(s) !== null ? String(effSeed(s)) : "auto";
}

function approvedForExport() {
  const act = active(), width = Math.max(2, String(act.length).length);
  return act.filter((s) => s.kind !== "clip" && s.status === "approved" && s.take).map((s) => ({
    s, key: takeStem(s.take), take: s.take,
    // 0.15.0: a Shot exported refined ends with FR
    name: `Shot ${String(numOf(s.id)).padStart(width, "0")} – seed ${seedOfTake(s)}${faceRefined(s) ? " FR" : ""}`,
  }));
}

/** 0.12.8: what one upscaled export file was made with. 0.13.3: the picture (upscale
 *  settings, refine, that Shot's own trim) and the sound (asig: the song and its place,
 *  or the take's own) apart, so turning the song on or off only mixes the sound again. */
function itemSig(x) {
  const v = P().settings.rtx_vsr || {};
  const c = exportCut(x.s);
  const cut = c.length ? `${c.trim_in}+${c.length}` : "";
  const ref = refineActive() ? JSON.stringify(P().settings.refine) : "";
  const face = faceRefined(x.s) ? "|face:" + (x.s.face.made || x.s.face.sig || "") : "";      // 0.15.0: its refined clip
  const str = cut + "|" + ref + face;
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
  return `${Number(v.scale || 2)}x ${v.quality || "ULTRA"}` + (str !== "|" ? ` · ${(h >>> 0).toString(36)}` : "");
}
function itemAsig(x) {
  const c = exportCut(x.s), a = P().audio;
  return c.song_len ? `song:${a.subfolder || ""}/${a.file}@${c.song_at}+${c.song_len}` : "own";
}
/** An export item as the server needs it to mix its sound again (0.13.3). */
function exportItem(x) {
  const c = exportCut(x.s), it = { key: x.key, name: x.name, sig: itemSig(x), asig: itemAsig(x) };
  if (c.length) it.cut = { start: c.trim_in / FPS, dur: c.length / FPS };
  if (c.song_len) Object.assign(it, { song_at: c.song_at, song_len: c.song_len });
  return it;
}
/** What an upscaled export file was made with: same take + same settings = reuse it. */
const upSig = () => {
  const v = P().settings.rtx_vsr || {};
  // 0.9.0: trims, moves and the song are part of what an upscaled file was made with
  const cuts = approvedForExport().map((x) => JSON.stringify(exportCut(x.s))).join("|");
  let h = 0;
  for (let i = 0; i < cuts.length; i++) h = (h * 31 + cuts.charCodeAt(i)) | 0;
  return `${Number(v.scale || 2)}x ${v.quality || "ULTRA"}` + (cuts.replace(/\{\}|\|/g, "") ? ` · ${(h >>> 0).toString(36)}` : "");
};

/** Before an upscaled export: clips already upscaled from the same take stay
 *  (renamed if their number moved); stale ones leave the folder. */
async function exportPrepare(job) {
  await layoutReady();                           // 0.15.0: the records need this project's layout
  const items = approvedForExport();
  const r = await api(`/longshot/approved/${encodeURIComponent(P().slug)}`, { method: "POST",
    body: { mode: "keep", sig: upSig(), prores: !!P().settings.prores_master, items: items.map(exportItem),
      song: songMode() ? { file: P().audio.file, subfolder: P().audio.subfolder || "" } : null } });
  job.exportTodo = r.todo || [];
  job.exportKept = (r.kept || []).length;
  job.exportRemixed = (r.remixed || []).length;
  saveQueue();
}

function exportedToast(r, skipped, kept = 0) {
  const n = (r.files || []).filter((f) => /\.mp4$/i.test(f)).length;
  const mov = (r.files || []).length - n;
  toast(`Exported ${n} ${kept ? "new " : ""}approved clip${n === 1 ? "" : "s"}${mov ? ` (+${mov} ProRes)` : ""} to Approved_Clips.` +
    (kept ? ` ${kept} already upscaled ${kept === 1 ? "was" : "were"} kept.` : "") +
    (skipped ? ` ${skipped} Shot${skipped === 1 ? " isn't" : "s aren't"} approved yet and ${skipped === 1 ? "was" : "were"} left out.` : ""),
    S.local ? { label: "Open folder", fn: () => api("/longshot/open-folder", { method: "POST",
      body: { which: "output", project: P().slug, subfolder: r.subfolder } }).catch((e) => toast(e.message)) } : undefined);
}

async function exportApproved() {
  if (!P()) return;
  try { await layoutReady(); } catch (e) { toast("Export failed: couldn't place the Shots on the film (" + e.message + ")."); return; }
  const items = approvedForExport();
  if (!items.length) { toast("No approved Shots to export yet."); return; }
  const skipped = active().filter((s) => s.kind !== "clip" && s.status !== "approved").length;
  if (P().settings.export_upscale || refineActive()) {
    if (refineActive() && mixedSizeGuard("Refine on export")) return;
    enqueue({ type: "export" });                 // 0.10.0: with Refine, the export refines first
    return;
  }
  const missing = items.filter((x) => !S.clips[x.key]);   // (a Refined Shot's own clip is there too)
  if (missing.length) {
    S.exportAfter = true;
    toast(`Making ${missing.length} clip${missing.length === 1 ? "" : "s"} first…`);
    missing.forEach((x) => S.clipTried.delete(x.take));
    await makeClips(missing.map((x) => ({ take: x.take })));
    if (!S.busy) S.exportAfter = false;
    return;
  }
  try {
    const r = await api(`/longshot/approved/${encodeURIComponent(P().slug)}`, { method: "POST",
      body: { mode: "copy", song: songMode() ? { file: P().audio.file, subfolder: P().audio.subfolder || "" } : null,
        items: items.map((x) => {
          // 0.15.0: a Shot set to Refined exports its refined clip
          const c = exportCut(x.s), it = { key: faceRefined(x.s) ? faceKey(x.s) : x.key, name: x.name };
          if (c.length) it.cut = { start: c.trim_in / FPS, dur: c.length / FPS };
          if (c.song_len) Object.assign(it, { song_at: c.song_at, song_len: c.song_len });
          return it;
        }) } });
    exportedToast(r, skipped);
  } catch (e) { toast("Export failed: " + e.message); }
}

async function exportDone(b, outputs) {
  const ex = b.built.nodes.export || {};
  const items = (b.extra.items || []).map((it, i) => {
    const nd = ex[String(i + 1)] || {};
    const ui = outputs[nd.video] || {};
    return { name: it.name, key: it.key, sig: it.sig || null, asig: it.asig || "", video: (ui.chunk_video || [])[0] || null, master: (ui.chunk_master || [])[0] || null,
      audio: ((outputs[nd.audio] || {}).longshot_audio || [])[0] || null };
  });
  if (items.some((x) => !x.video)) { S.error = "The export saved no file. Update H3 Long Shot to 1.6.6 or later."; return; }
  try {
    const r = await api(`/longshot/approved/${encodeURIComponent(P().slug)}`, { method: "POST", body: { mode: "mux", items, sig: b.extra.sig || null } });
    exportedToast(r, b.extra.skipped, b.extra.kept);
  } catch (e) { S.error = "Finishing the export failed: " + e.message; }
}

/** Takes in Take history without a clip (made before 0.6.5). */
function takesWithoutClips() {
  const out = [];
  for (const s of active()) {
    if (s.kind === "clip") continue;
    for (const t of S.takes[s.id] || []) if (!S.clips[takeStem(t.name)]) out.push({ take: t.name });
  }
  return out;
}

function buildTL() {
  const lo = last(), act = P() ? active() : [];
  const loUrl = lo && lo.video ? viewURL(lo.video) : null;
  const vplan = lo && lo.video_plan, vchain = lo && lo.video_chain;
  const rowOf = (s) => {           // this Shot's piece of the stitched video, when it shows its take
    if (!vplan || !vchain || !isRendered(s)) return null;
    const i = vchain.indexOf(s.id);
    const r = i >= 0 ? vplan[i] : null;
    return r && (s.kind === "clip" || r.take === s.take) ? r : null;
  };
  const exact = !!loUrl && !!vplan && !!vchain && act.length > 0 && act.length === vchain.length &&
    act.every((s, i) => vchain[i] === s.id && !!rowOf(s)) && !act.some(hasEdit) &&
    !act.some((s, i) => i > 0 && runStartAt(act, i));      // 0.9.2: a Cut shows its whole take
  const half = (Number(P() && P().settings.overlap) || 22) / 24 / 2;
  const entries = [];
  for (const s of act) {
    const r = rowOf(s), key = s.kind !== "clip" && isRendered(s) ? takeStem(s.take) : null;
    const c = key ? S.clips[key] : null;
    let e;
    if (exact) e = { src: loUrl, off: r.start, dur: r.end - r.start, kind: "video" };
    else if (s.kind === "clip" && s.clip.file) {
      e = { src: viewURL({ filename: s.clip.file, subfolder: s.clip.subfolder, type: "input" }),
        off: Number(s.clip.trim_in) || 0, dur: (s.clip.frames || 24) / 24, kind: "source",
        srcOff: Number(s.clip.trim_in) || 0 };
    } else if (c && c.dur > 0) e = { src: clipFile(key, ".mp4"), off: 0, dur: c.dur, kind: "take", clipDur: c.dur };
    else if (r && loUrl) e = { src: loUrl, off: r.start, dur: r.end - r.start, kind: "video" };
    else e = { src: null, off: 0, dur: Math.max(0.5, Number(s.seconds) || 1), kind: "gap" };
    e.thumb = c && c.thumb ? clipFile(key, ".jpg") : null;
    Object.assign(e, { id: s.id, rendered: isRendered(s), noclip: isRendered(s) && !e.src, join: s.join });
    entries.push(e);
  }
  if (!exact) {
    // A take's clip is its whole window, overlap included: at a join between two
    // takes each gives up half of the shared frames, so the length matches the film.
    for (let i = 1; i < entries.length; i++) {
      const a = entries[i - 1], b = entries[i];
      if (a.kind !== "take" || b.kind !== "take" || isCut(b)) continue;
      const h = Math.min(half, a.dur / 3, b.dur / 3);
      a.dur -= h;
      b.off += h;
      b.dur -= h;
    }
  }
  let t = 0;
  const placed = !exact && placeOnFilm(act, entries);
  if (!placed) {
    for (const e of entries) {
      e.start = exact ? e.off : t;
      t = e.start + e.dur;
    }
  } else t = placed;
  const sig = JSON.stringify(entries.map((e) => [e.id, e.src, e.off, e.dur, e.start]));
  const changed = sig !== TL.sig;
  TL = { exact, entries, total: t, sig };
  return changed;
}

/** 0.9.0: put each Shot where it sits on the film (Long Shot's layout), with its trims
 *  and move, and black where nothing covers the film. Returns the film's end in
 *  seconds, or 0 (use the old end-to-end layout) while the layout isn't known. */
function placeOnFilm(act, entries) {
  if (!act.length || !act.every((s) => LAYOUT.byId[s.id])) return 0;
  const fps = LAYOUT.fps, half = Math.round((Number(P().settings.overlap) || 22) / 2);
  const byId = new Map(entries.map((e) => [e.id, e]));
  const list = [];
  act.forEach((s, i) => {
    const e = byId.get(s.id);
    if (!e) return;
    const L = LAYOUT.byId[s.id];
    let fa = L.vs, fb = L.we, off;
    if (e.kind === "take") off = (L.vs - (L.we - Math.round(e.clipDur * fps))) / fps;
    else if (e.kind === "source") off = e.srcOff + (L.vs - L.ws) / fps;
    else off = e.off;                                 // a piece of the last stitched video, or a gap
    // two takes joined Continuous: switch halfway through the frames they share
    const pv = list.length ? list[list.length - 1] : null;
    if (pv && pv.e.kind === "take" && e.kind === "take" && !isCut(s) && pv.s === act[i - 1]) {
      pv.fb -= half;
      fa -= half;
      off -= half / fps;
    }
    const ed = effEdit(s);
    fa += ed.in + ed.shift;
    off += ed.in / fps;
    fb += ed.shift - ed.out;
    list.push({ s, e, fa, fb, off });
  });
  const out = [];
  let end = 0;
  for (const x of list) {
    if (x.fa > end) out.push({ src: null, off: 0, dur: (x.fa - end) / fps, kind: "black", id: null, start: end / fps });
    const fa = Math.max(x.fa, end);                   // never on top of the one before
    if (x.fb <= fa) continue;
    Object.assign(x.e, { start: fa / fps, off: x.off + (fa - x.fa) / fps, dur: (x.fb - fa) / fps });
    out.push(x.e);
    end = x.fb;
  }
  entries.length = 0;
  entries.push(...out);
  return end / fps;
}

// ---------------------------------------------------------------------------
// Trims and moves on the timeline (0.9.0). Non-destructive: a trim hides frames
// of a take (or clip) at a free edge and can be dragged back out any time; a move
// (Alt + ← / →) shifts a Shot a frame along the film, overwriting: frames it
// covers on its neighbour become that neighbour's trim, the side it leaves is
// black. Shots not rendered yet: dragging the right edge sets their seconds.
// ---------------------------------------------------------------------------

const MIN_SHOWN = 6;                       // frames a trimmed Shot keeps at least

/** Which edges of a block can be dragged, and what dragging does. */
function trimEdges(s) {
  if (!LAYOUT.byId[s.id] || busyHere()) return { left: null, right: null };
  if (s.kind === "clip" || isRendered(s)) {
    const f = freeEdges(s);
    return { left: f.left ? "in" : null, right: f.right ? "out" : null };
  }
  return { left: null, right: "seconds" };
}

function trimHandles(s) {
  const e = trimEdges(s);
  const tip = { in: "Drag to trim the start (nothing re-renders)", out: "Drag to trim the end (nothing re-renders)",
    seconds: "Drag to change this Shot's seconds (not rendered yet)" };
  return (e.left ? `<span class="tl-trim l" data-trim="${e.left}" title="${tip[e.left]}"></span>` : "") +
    (e.right ? `<span class="tl-trim r${e.right === "seconds" ? " sec" : ""}" data-trim="${e.right}" title="${tip[e.right]}"></span>` : "");
}

/** Frames a Shot shows before trims (its place on the film). */
function shownFrames(s) {
  const L = LAYOUT.byId[s.id];
  return L ? L.we - L.vs : 0;
}

const TRIM = { drag: null, swallow: 0 };

function trimReadout(x, y, text) {
  const r = $("tl-readout");
  r.hidden = false;
  r.textContent = text;
  r.style.left = Math.min(window.innerWidth - r.offsetWidth - 8, x + 12) + "px";
  r.style.top = (y - 34) + "px";
}

$("tl-strip").addEventListener("pointerdown", (e) => {
  const h = e.target.closest(".tl-trim");
  if (!h || e.button !== 0) return;
  const b = h.closest("[data-tl]"), s = b && shotById(b.dataset.tl);
  if (!s || setupGuard()) return;
  if (inRender(s)) { toast("This shot is part of the render in progress; edit it when it finishes."); return; }
  e.preventDefault();
  e.stopPropagation();
  const ed = editOf(s);
  TRIM.drag = { s, kind: h.dataset.trim, x: e.clientX, in: ed.in, out: ed.out, seconds: Number(s.seconds) || 0,
    moved: false };
  document.body.classList.add("trimming");
});

document.addEventListener("pointermove", (e) => {
  const d = TRIM.drag;
  if (!d) return;
  const df = Math.round((e.clientX - d.x) / (tlPx() / FPS));
  if (!d.moved && Math.abs(e.clientX - d.x) < 3) return;
  d.moved = true;
  const s = d.s, len = shownFrames(s);
  if (d.kind === "seconds") {
    s.seconds = isEmptyShot(s) ? Math.max(12, Math.round(d.seconds * FPS) + df) / FPS        // frame-exact
      : Math.max(0.5, Math.round((d.seconds + df / FPS) * 100) / 100);
    trimReadout(e.clientX, e.clientY, `${s.seconds.toFixed(2)} s`);
  } else {
    const pl = Object.assign({ in: 0, out: 0, shift: 0 }, s.place || {});
    if (d.kind === "in") pl.in = Math.max(0, Math.min(d.in + df, len - pl.out - MIN_SHOWN));
    else pl.out = Math.max(0, Math.min(d.out - df, len - pl.in - MIN_SHOWN));
    s.place = pl.in || pl.out || pl.shift ? pl : null;
    trimReadout(e.clientX, e.clientY,
      `in ${fmtSec(pl.in)} · out ${fmtSec(len - pl.out)} · ${fmtSec(len - pl.in - pl.out)} long`);
  }
  renderViewer();
});

document.addEventListener("pointerup", () => {
  const d = TRIM.drag;
  if (!d) return;
  TRIM.drag = null;
  document.body.classList.remove("trimming");
  $("tl-readout").hidden = true;
  if (!d.moved) return;
  TRIM.swallow = performance.now() + 120;         // the click after a drag isn't a pick
  if (d.kind === "seconds") {
    if (Number(d.s.seconds) !== d.seconds) {
      shotEdited(d.s, "seconds");
      if (songOn() && active().slice(active().indexOf(d.s) + 1).some(isRendered)) {
        toast("The Shots after it move along the song: re-render them to keep their lip sync.");
      }
    }
  }
  commit();
});

$("tl-view").addEventListener("click", (e) => {
  if (performance.now() < TRIM.swallow) { e.stopPropagation(); e.preventDefault(); }
}, true);

/** 0.11.0: an empty Shot (placeholder) before the run takes up the move — it gets
 *  longer or shorter, frame-exact — and an empty Shot after it gives the frames back,
 *  so nothing else on the film moves. A rendered Shot after it stays where it is: the
 *  run covers its start (a trim) or leaves black. Returns false when there's no
 *  placeholder before the run (the usual move then applies). */
function absorbMove(run, d) {
  const act = active(), first = run[0], last = run[run.length - 1];
  const before = act[act.indexOf(first) - 1], after = act[act.indexOf(last) + 1];
  if (!before || !isEmptyShot(before)) return false;
  if (busyHere() && run.some(inRender)) { toast("This run is part of the render in progress; move it when it finishes."); return true; }
  const MIN = 12;                                          // half a second, at least
  const bf = Math.round((Number(before.seconds) || 0) * FPS) + d;
  if (bf < MIN) { toast(`${titleOf(before)} can't get any shorter.`); return true; }
  if (after && isEmptyShot(after)) {
    const af = Math.round((Number(after.seconds) || 0) * FPS) - d;
    if (af < MIN) { toast(`${titleOf(after)} can't get any shorter.`); return true; }
    after.seconds = af / FPS;
  } else if (after) {
    // a rendered Shot after: it keeps its place on the film; the run covers its start or leaves black
    const ar = runOf(after), head = ar[0];
    const pl = Object.assign({ in: 0, out: 0, shift: 0 }, head.place || {});
    if (d > 0 && shownFrames(head) - (pl.in + d) - pl.out < MIN_SHOWN) { toast(`${titleOf(head)} can't be covered any further.`); return true; }
    pl.shift -= d;
    if (d > 0) pl.in += d;
    else pl.in = Math.max(0, pl.in + d);
    head.place = pl.in || pl.out || pl.shift ? pl : null;
  }
  before.seconds = bf / FPS;
  commit();
  return true;
}

/** Alt + ← / →: move a Shot one frame along the film, overwriting its neighbour. Shots
 *  joined Continuous move together as one run (0.9.2). */
function moveShot(s, d) {
  const run = runOf(s);
  const locked = run.find(isAligned);
  if (locked) {
    toast(`${titleOf(locked)} is marked aligned, so it stays put. Unmark aligned to move it.`);
    return;
  }
  if (run.length === 1 && isEmptyShot(run[0])) {
    toast(`${titleOf(s)} has no prompt: it holds time. Move the Shot next to it, and this one makes room.`);
    return;
  }
  if (absorbMove(run, d)) return;
  if (busyHere() && run.some(inRender)) { toast("This run is part of the render in progress; move it when it finishes."); return; }
  if (!run.some((x) => x.kind === "clip" || isRendered(x))) { toast(`Render ${titleOf(s)} first; then Alt + ← / → moves it.`); return; }
  const act = active(), first = run[0], last = run[run.length - 1];
  const sa = filmSpan(first), sb = filmSpan(last);
  if (!sa || !sb) { toast("One moment: working out where the Shots sit…"); return; }
  if (sa.a + d < 0) { toast(`${titleOf(first)} is at the start of the film.`); return; }
  // what the run would cover on its neighbour becomes that neighbour's trim
  const nb = d > 0 ? act[act.indexOf(last) + 1] : act[act.indexOf(first) - 1];
  const q = nb && filmSpan(nb);
  if (q) {
    const over = d > 0 ? sb.b + d - q.a : q.b - (sa.a + d);
    if (over > 0) {
      const side = d > 0 ? "in" : "out";
      const pl = Object.assign({ in: 0, out: 0, shift: 0 }, nb.place || {});
      if (shownFrames(nb) - pl.in - pl.out - over < MIN_SHOWN) {
        toast(`${run.length > 1 ? `Shots ${numOf(first.id)}–${numOf(last.id)} can't` : `${titleOf(s)} can't`} cover more of ${titleOf(nb)}.`);
        return;
      }
      pl[side] += over;
      nb.place = pl;
    }
  }
  const pl = Object.assign({ in: 0, out: 0, shift: 0 }, first.place || {});
  pl.shift += d;
  first.place = pl.in || pl.out || pl.shift ? pl : null;
  commit();
}

const totalSeconds = () => TL.total;

function entryAt(t) {
  let k = -1;
  TL.entries.forEach((e, i) => { if (k < 0 || t >= e.start - 1e-6) k = i; });
  return k;
}

function tlTime() {
  const e = TL.entries[PL.k];
  if (!e) return PL.t;
  if (e.src && PL.src === e.src && video.readyState >= 1) return Math.min(e.start + e.dur, e.start + Math.max(0, video.currentTime - e.off));
  if (!e.src && PL.playing) {
    // 0.9.2: nothing rendered here: the song (when it plays under the film) is the clock
    if (songClock()) return Math.max(e.start, songEl.currentTime - songStart());
    return PL.gapT + (performance.now() - PL.gapWall) / 1000;
  }
  return PL.t;
}

function showEntry(e) {
  const any = TL.entries.some((x) => x.src);
  if (e && e.kind === "black") {                   // a gap a trim or move left: black, no words
    video.style.visibility = "hidden";
    $("placeholder").hidden = true;
    return;
  }
  video.style.visibility = e && e.src ? "visible" : "hidden";
  $("placeholder").hidden = !!(e && e.src);
  const sh = e && shotById(e.id);
  $("ph-shot").textContent = !any || !sh ? "Nothing rendered yet"
    : e.noclip ? (S.busy && S.busy.kind === "clips" ? `${titleOf(sh)} · making this take's clip…`
      : `${titleOf(sh)} · no clip yet: "Make missing clips" under the timeline`) : `${titleOf(sh)} · not rendered yet`;
}

function safePlay() {
  const p = video.play();
  if (p && p.catch) p.catch(() => { /* reported by the error handler */ });
}

/** Go to timeline time t (seconds). */
function tlSeek(t) {
  t = Math.max(0, Math.min(TL.total || 0, Number(t) || 0));
  PL.t = t;
  PL.k = entryAt(t);
  const e = TL.entries[PL.k];
  showEntry(e);
  if (e && e.src) {
    const at = e.off + (t - e.start);
    PL.at = at;                                    // the latest target wins once the file loads
    if (PL.src !== e.src) {
      PL.src = e.src;
      video.src = e.src;
      video.addEventListener("loadedmetadata", () => {
        if (PL.src !== e.src) return;
        video.currentTime = Math.min(PL.at, video.duration || PL.at);
        if (PL.playing) safePlay();
        layoutStage();
      }, { once: true });
    } else if (video.readyState >= 1) {
      video.currentTime = at;
      if (PL.playing && video.paused) safePlay();
    }
  } else {
    video.pause();
    PL.gapT = t;
    PL.gapWall = performance.now();
  }
  updateTime();
}

function play() {
  if (!TL.entries.length) return;
  if (tlTime() >= TL.total - 0.05) tlSeek(0);
  PL.playing = true;
  setPlayIcon(true);
  $("play").setAttribute("aria-label", "Pause");
  stopPreview();
  const e = TL.entries[PL.k];
  if (e && e.src) safePlay();
  else { PL.gapT = PL.t; PL.gapWall = performance.now(); }
  cancelAnimationFrame(rafId);
  rafId = requestAnimationFrame(tick);
  syncLive();                                      // playing: the player, not the preview
  applyVolume();
  syncSong(true);
}

function pausePlayer() {
  PL.t = tlTime();
  PL.playing = false;
  video.pause();
  setPlayIcon(false);
  $("play").setAttribute("aria-label", "Play");
  updateTime();
  syncLive();
  syncSong(true);
}

function togglePlay() {
  if (!TL.entries.some((e) => e.src)) return;
  if (PL.playing) pausePlayer(); else play();
}

function nextEntry() {
  const e = TL.entries[PL.k], n = TL.entries[PL.k + 1];
  if (!n) { pausePlayer(); PL.t = TL.total; updateTime(); return; }
  if (e && n.src && n.src === e.src && PL.src === n.src && Math.abs(n.off - (e.off + e.dur)) < 0.05) {
    PL.k++;                                       // the same video file just continues
    showEntry(n);
  } else tlSeek(n.start);
}

function tick() {
  if (!PL.playing) return;
  const e = TL.entries[PL.k];
  const t = tlTime();
  const L = S.loop ? loopRange() : null;
  if (L && (t >= L.b - 0.02 || t < L.a - 0.1)) tlSeek(L.a);
  else if (e && t >= e.start + e.dur - 0.02) nextEntry();
  else PL.t = t;
  updateTime();
  syncSong();
  rafId = requestAnimationFrame(tick);
}

/** Loop range: halfway into the Shot before → end of the Shot picked on the
 *  timeline (or under review). */
function loopRange() {
  const sh = (S.focus && active().find((x) => x.id === S.focus && isRendered(x))) || reviewShot();
  if (!sh) return null;
  const k = TL.entries.findIndex((e) => e.id === sh.id);
  const e = TL.entries[k];
  if (!e || !e.src) return null;
  const pe = TL.entries[k - 1], prev = pe && pe.src ? pe : null;
  return { a: prev ? prev.start + prev.dur / 2 : e.start, b: e.start + e.dur, i: k, prev: !!prev,
    prevTitle: prev ? titleOf(shotById(prev.id)) : "", shot: sh };
}

/** The Shot number of the i-th piece of a preview (a stitched preview skips Shots). */
function rowNum(lo, i) {
  const n = lo && lo.chain ? numOf(lo.chain[i]) : 0;
  return n > 0 ? n : i + 1;
}

function updateTime() {
  const t = PL.playing ? tlTime() : PL.t, total = TL.total;
  $("scrub").value = String(t);
  placeHead(t);
  tlFollow(t);
  const e = TL.entries[entryAt(t)];
  $("tc-overlay").textContent = (e ? "S" + numOf(e.id) + " · " : "") + fmt(t);
  $("tc-label").textContent = fmt(t) + " / " + fmt(total);
}

/** Pick a Shot on the timeline: jump there; it's the one Approve, Reroll and Loop act on. */
function focusShot(id) {
  const e = TL.entries.find((x) => x.id === id);
  S.focus = id;
  S.open = id;
  if (e) { if (PL.playing) pausePlayer(); tlSeek(e.start + 0.04); }
  renderShots();
  renderDecision();
  renderViewer();
  renderFace();                                    // 0.14.1: the Face refine panel follows the selection
  tlReveal(id);
}

/** (Re)load the timeline: at time `at`, or at the start of Shot focusId. */
function loadVideo(at, focusId) {
  const lo = last();
  if (lo && lo.size) $("screen").style.aspectRatio = lo.size[0] + " / " + lo.size[1];
  if (lo && lo.video) {
    $("download").href = viewURL(lo.video);
    $("download").setAttribute("download", lo.video.filename);
  }
  if (PL.playing) pausePlayer();
  buildTL();
  PL.src = null;                                   // the file may be new: load it again
  if (!TL.entries.some((e) => e.src)) { video.removeAttribute("src"); video.load(); }
  let t = at !== undefined ? at : PL.t;
  const fe = focusId && TL.entries.find((e) => e.id === focusId);
  if (fe) t = fe.start + 0.04;
  renderViewer();
  tlSeek(t);
}

video.addEventListener("seeked", updateTime);
video.addEventListener("ended", () => { if (PL.playing) nextEntry(); });
$("scrub").addEventListener("input", (e) => { tlSeek(parseFloat(e.target.value) || 0); });

function setPlayIcon(playing) {
  $("play-icon").innerHTML = playing
    ? '<path d="M4 2.5v9M10 2.5v9"/>'
    : '<path d="M3 2l9 5-9 5z"/>';
}

// Volume: a speaker button (mute) and a slider, remembered in this browser.
const VOL_PATHS = {
  muted: '<path d="M2 6h2.5L8 3v10L4.5 10H2z"/><path d="M11 6l4 4M15 6l-4 4"/>',
  low: '<path d="M2 6h2.5L8 3v10L4.5 10H2z"/><path d="M10.5 6.2a2.5 2.5 0 0 1 0 3.6"/>',
  high: '<path d="M2 6h2.5L8 3v10L4.5 10H2z"/><path d="M10.5 6.2a2.5 2.5 0 0 1 0 3.6"/><path d="M12.3 4.3a5.2 5.2 0 0 1 0 7.4"/>',
};

// Volume (0.9.0): what you set, kept here and remembered in this browser. With
// "Song in final video" the song file plays under the film and the video's own
// sound is muted; the same controls set the song's volume.
const VOL = (() => {
  const v = Number(store("h3studio.volume"));
  return { volume: Number.isFinite(v) && v >= 0 && v <= 1 && store("h3studio.volume") !== null ? v : 1,
    muted: store("h3studio.muted") === "1" };
})();
const songEl = $("song-audio");

function applyVolume() {
  const song = songMode();
  video.volume = VOL.volume;
  video.muted = VOL.muted || song;
  songEl.volume = VOL.volume;
  songEl.muted = VOL.muted;
  store("h3studio.volume", String(VOL.volume));
  store("h3studio.muted", VOL.muted ? "1" : "0");
  if (VOL.volume > 0) store("h3studio.volumeBeforeMute", String(VOL.volume));
  renderVolume();
}

function renderVolume() {
  const silent = VOL.muted || VOL.volume === 0;
  $("vol-icon").innerHTML = silent ? VOL_PATHS.muted : VOL.volume < 0.5 ? VOL_PATHS.low : VOL_PATHS.high;
  $("mute-btn").setAttribute("aria-pressed", silent);
  $("mute-btn").setAttribute("aria-label", silent ? "Unmute (M)" : "Mute (M)");
  $("mute-btn").title = (silent ? "Unmute (M)" : "Mute (M)") + (songMode() ? " · the song plays under the film" : "");
  $("volume").value = String(VOL.muted ? 0 : VOL.volume);
}

function toggleMute() {
  if (VOL.muted || VOL.volume === 0) {
    VOL.muted = false;
    if (VOL.volume === 0) VOL.volume = Number(store("h3studio.volumeBeforeMute")) || 0.8;
  } else VOL.muted = true;
  applyVolume();
}

$("volume").addEventListener("input", (e) => {
  const v = Number(e.target.value);
  VOL.volume = v;
  VOL.muted = v === 0;
  applyVolume();
});

// ---------------------------------------------------------------------------
// The song under the film (0.9.0): with "Song in final video" on, the timeline
// plays the song file at the film's time (Audio Start included), so trims and
// moves are heard against the music as they'll be in the final video.
// ---------------------------------------------------------------------------

function songMode() {
  const a = P() && P().audio;
  return !!(a && a.final_override && a.file && !audioMissing());
}

/** 0.12.6: the song for playback, as a WAV (made from an mp3 / m4a once by the server):
 *  browsers jump into a compressed file by estimate, which put the song late after a
 *  click on the timeline. */
function songSrc() {
  const a = P().audio;
  return "/longshot/song-preview?" + new URLSearchParams({ file: a.file, subfolder: a.subfolder || "" });
}

/** Keep the song where the film is: start it, move it, stop it. 0.9.2: a seek takes
 *  a while on a compressed file, so the song is only moved when it's well off (and
 *  never again while a seek is still going): re-seeking at every small drift made it
 *  stutter. Where nothing is rendered, the song is the clock (see tlTime). */
const SONG_SYNC = { last: 0 };
function songClock() {
  return songMode() && PL.playing && !songEl.paused && !songEl.seeking && songEl.readyState >= 2;
}
function syncSong(force = false) {
  if (!P() || !songMode() || !TL.entries.length) {
    if (!songEl.paused) songEl.pause();
    return;
  }
  const src = songSrc();
  if (songEl.dataset.src !== src) { songEl.dataset.src = src; songEl.src = src; }
  const want = songStart() + (PL.playing ? tlTime() : PL.t);
  const seek = (t) => {
    SONG_SYNC.last = performance.now();
    if (songEl.readyState >= 1) songEl.currentTime = Math.max(0, t);
    else songEl.addEventListener("loadedmetadata", () => { songEl.currentTime = Math.max(0, songStart() + tlTime()); }, { once: true });
  };
  if (!PL.playing) {
    if (!songEl.paused) songEl.pause();
    if (force) seek(want);
    return;
  }
  const e = TL.entries[PL.k];
  const onVideo = !!(e && e.src);
  if (force) seek(want);
  else if (onVideo && !songEl.seeking && performance.now() - SONG_SYNC.last > 600 &&
           Math.abs(songEl.currentTime - want) > 0.08) seek(want);
  if (songEl.paused) songEl.play().catch(() => { /* the browser wants a click first */ });
}

applyVolume();



video.addEventListener("error", () => {
  if (!video.getAttribute("src")) return;
  toast("This browser can't play the video file. Open the output folder" +
        (S.local ? "" : " or download it") + " to watch it in a player.");
});

function stepFrame(dir) {
  if (!TL.entries.some((e) => e.src)) return;
  pausePlayer();
  tlSeek(PL.t + dir / FPS);
}

// ---------------------------------------------------------------------------
// Render: header, panels
// ---------------------------------------------------------------------------

// Item 10: a click must always land. Rebuilding a button between pointerdown and
// click (e.g. a blur commits a field and re-renders) swallows the click, so
// rebuilds wait until the pointer is released and its click has fired.
let pointerHeld = false, heldTimer = null;
const deferred = new Set();
document.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  pointerHeld = true;
  clearTimeout(heldTimer);
  heldTimer = setTimeout(releasePointer, 4000);      // never stay frozen if an up event is lost
}, true);
function releasePointer() {
  if (!pointerHeld) return;
  pointerHeld = false;
  clearTimeout(heldTimer);
  setTimeout(flushDeferred, 0);                      // after the click event of this press
}
document.addEventListener("pointerup", releasePointer, true);
document.addEventListener("pointercancel", releasePointer, true);
document.addEventListener("pointermove", (e) => { if (pointerHeld && e.buttons === 0) releasePointer(); }, true);
window.addEventListener("blur", releasePointer);
function deferIfHeld(what) {
  if (!pointerHeld) return false;
  deferred.add(what);
  return true;
}
function flushDeferred() {
  if (pointerHeld || !deferred.size) return;
  const d = new Set(deferred);
  deferred.clear();
  if (d.has("all")) { render(); return; }
  if (d.has("shots")) renderShots();
  if (d.has("decision")) renderDecision();
}

function render() {
  if (!P()) return;
  if (deferIfHeld("all")) return;
  renderHeader();
  renderCast();
  renderStyle();
  renderShots();
  renderViewer();
  renderDecision();
  renderAudio();
  renderSettings();
  renderAdvanced();
  renderRefine();
  renderFace();
  renderPlan();
  renderQueue();
}

function renderSaveState() { $("save-state").textContent = S.saveState; }

/** ComfyUI older than 0.35.0: no native H3 guides at any frame, so every render would fail. */
function comfyTooOld() { return !!(S.opts && S.opts.comfy && S.opts.comfy.ok === false); }
function comfyTooOldText() {
  const c = S.opts.comfy;
  return `This ComfyUI${c.version ? " (" + c.version + ")" : ""} is too old for MiniMax H3 Long Shot: ` +
    `update ComfyUI to ${c.min} or later, then restart it. (ComfyUI Desktop updates with the app.)`;
}

function renderHeader() {
  const dot = $("conn-dot");
  const st = S.restarting ? "restarting" : S.conn;
  dot.className = "dot " + (st === "ok" ? "ok" : st === "down" ? "down" : st === "restarting" ? "restarting" : "");
  $("conn-label").textContent = st === "restarting" ? "Restarting ComfyUI…"
    : st === "ok" ? "ComfyUI connected · " + location.host
      : st === "down" ? "ComfyUI disconnected — retrying…" : "Connecting…";
  $("restart-btn").disabled = !!S.restarting || S.conn !== "ok";
  const memOff = !!S.busy || !!S.restarting || S.conn !== "ok" || !!S.freeing;
  for (const id of ["free-vram", "free-ram", "clear-cache"]) $(id).disabled = memOff;
  if (!P()) return;
  const act = active();
  const approved = act.filter((s) => s.status === "approved").length;
  const lo = last();
  const rendered = lo && lo.plan.length ? lo.plan[lo.plan.length - 1].end : 0;
  $("header-stats").textContent = `${approved} of ${act.length} shots approved · ${fmt(rendered)} rendered`;
  $("project-title").textContent = P().name;
  $("project-btn").title = `${P().name} · project file ${P().slug}.json`;
  renderSaveState();
  const missing = S.opts ? CORE_NODES.filter((c) => S.opts.nodes && S.opts.nodes[c] === false) : [];
  const banner = $("banner");
  if (comfyTooOld()) {
    banner.hidden = false;
    banner.textContent = comfyTooOldText();
  } else if (missing.length) {
    banner.hidden = false;
    banner.textContent = "ComfyUI is missing nodes the Studio needs: " +
      missing.map((c) => `${c} (${(S.opts.packs || {})[c] || "core"})`).join(", ") +
      ". Install the pack(s) and restart ComfyUI.";
  } else banner.hidden = true;
}

const PLUS = '<span class="plus"><svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M7 2v10M2 7h10"/></svg></span>';
const POWER = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M7 1.5v5"/><path d="M3.8 3.6a4.6 4.6 0 1 0 6.4 0"/></svg>';
const PENCIL = '<svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M2 12l.6-2.8L9.8 2l2.2 2.2-7.2 7.2z"/><path d="M8.6 3.2l2.2 2.2"/></svg>';
const CROSS = '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M2.5 2.5l7 7M9.5 2.5l-7 7"/></svg>';

const sameFile = (a, b) => !!a && !!b && a.replace(/\\/g, "/") === b.replace(/\\/g, "/");

function fileOptions(list, current, blank) {
  const items = (list || []).slice();
  // A name saved on another OS ("H3\\x" vs "H3/x") is the same file.
  const twin = current && !items.includes(current) ? items.find((f) => sameFile(f, current)) : null;
  if (twin) current = twin;
  let out = blank ? `<option value="">${esc(blank)}</option>` : "";
  if (current && !items.includes(current)) out += `<option value="${esc(current)}" selected>${esc(current)} (missing)</option>`;
  // grouped by subfolder: "H3", "H3 / Speed"…, each line just the file name
  const groups = new Map();
  for (const f of items) {
    const parts = f.split(/[\\/]/), name = parts.pop(), folder = parts.join(" / ");
    if (!groups.has(folder)) groups.set(folder, []);
    groups.get(folder).push([f, name]);
  }
  const opt = ([f, name]) => `<option value="${esc(f)}" title="${esc(f)}"${f === current ? " selected" : ""}>${esc(name)}</option>`;
  if (groups.size === 1 && groups.has("")) return out + groups.get("").map(opt).join("");
  const order = [...groups.keys()].sort((x, y) => (y === "") - (x === "") || x.localeCompare(y, undefined, { sensitivity: "base" }));
  for (const folder of order) {
    out += `<optgroup label="${esc(folder || "Top level")}">${groups.get(folder).map(opt).join("")}</optgroup>`;
  }
  return out;
}

/** Input files as <option>s: this project's subfolder first, then the input folder.
 *  Values are "subfolder|name". */
function inputOptions(kind, sub, name, blank) {
  const cur = name ? (sub || "") + "|" + name : "";
  const groups = [];
  const seen = new Set();
  const add = (label, folder, list) => {
    const opts = (list || []).map((f) => {
      const v = (folder || "") + "|" + f;
      seen.add(v);
      return `<option value="${esc(v)}"${v === cur ? " selected" : ""}>${esc(f)}</option>`;
    }).join("");
    if (opts) groups.push(`<optgroup label="${esc(label)}">${opts}</optgroup>`);
  };
  if (S.inputs) {
    add(`This project · input/${S.inputs.mine.subfolder}`, S.inputs.mine.subfolder, S.inputs.mine[kind]);
    add("Input folder", "", S.inputs.root[kind]);
  } else if (S.opts) add("Input folder", "", S.opts[kind]);
  let out = `<option value="">${esc(blank)}</option>`;
  if (cur && !seen.has(cur)) out += `<option value="${esc(cur)}" selected>${esc((sub ? sub + "/" : "") + name)} (not found)</option>`;
  return out + groups.join("");
}

function splitChoice(v) {
  const i = v.indexOf("|");
  return i < 0 ? ["", v] : [v.slice(0, i), v.slice(i + 1)];
}

/** Images in the same list and order as a reference's file dropdown: this
 *  project's input folder first, then the input folder. [{sub, name}] */
function refChoices() {
  if (S.inputs) {
    return (S.inputs.mine.images || []).map((name) => ({ sub: S.inputs.mine.subfolder || "", name }))
      .concat((S.inputs.root.images || []).map((name) => ({ sub: "", name })));
  }
  return ((S.opts || {}).images || []).map((name) => ({ sub: "", name }));
}

/** One line for the folded Cast & Scenes panel: "4 pictures · 2 voices · 1 RefMod". */
function castSummary(p = P()) {
  const part = (list, one, many) => {
    const on = (list || []).filter((x) => !x.bypassed).length, off = (list || []).length - on;
    if (!on && !off) return "";
    return `${on} ${on === 1 ? one : many}` + (off ? ` (+${off} off)` : "");
  };
  return [part(p.cast, "picture", "pictures"), part(p.voices, "voice", "voices"), part(p.refmods, "RefMod", "RefMods")]
    .filter(Boolean).join(" · ") || "no references yet";
}

function renderCast() {
  $("cast-summary").textContent = castSummary();
  let n = 0;
  const choices = refChoices();
  const cards = P().cast.map((c) => {
    const pic = c.bypassed ? "bypassed" : `<Picture ${++n}>`;
    const state = S.refState[c.id];
    const missing = !!c.image && (state === "missing" || state === "invalid");
    const thumb = missing
      ? `<span>Missing:<br>${esc(c.original_name || c.image)}</span>`
      : c.image ? `<img alt="" src="${esc(viewURL({ filename: c.image, subfolder: c.subfolder, type: "input" }))}" loading="lazy">`
        : "<span>Drop an image<br>or click</span>";
    const badge = state === "changed"
      ? '<span class="ref-badge changed" title="This file changed since the project was saved. Every Shot will render again on the next run.">Changed since saved</span>' : "";
    const tools = missing && !c.bypassed ? `<div class="missing-tools">
        <button class="ghost" data-action="relink" title="Pick the file again from the input folder">Relink…</button>
        <button class="ghost" data-action="bypass-cast">Bypass</button></div>` : "";
    const up = S.uploading[c.id] ? '<div class="drop-busy">Uploading…</div>' : "";
    const steps = choices.length ? `<div class="ref-step">
        <button class="icon xs" data-action="ref-step" data-dir="-1" title="Previous image in the list" aria-label="Previous image for ${esc(c.label)}">◀</button>
        <button class="icon xs" data-action="ref-step" data-dir="1" title="Next image in the list" aria-label="Next image for ${esc(c.label)}">▶</button></div>` : "";
    return `<div class="card${c.bypassed ? " off" : ""}${missing && !c.bypassed ? " missing" : ""}${S.uploading[c.id] ? " uploading" : ""}" data-cast="${esc(c.id)}">${up}
      <div class="thumb-col"><button class="thumb${missing ? " missing" : ""}${c.image ? "" : " empty"}" data-action="${c.image ? "view-image" : "pick-image"}" title="${missing ? "File not found" : c.image ? "Open full size · drop an image on this card to replace it" : "Choose an image, or drop one here"}" aria-label="${c.image ? `Open ${esc(c.label)} full size` : `Choose an image for ${esc(c.label)}`}">${thumb}</button>${steps}</div>
      <div class="card-body">
        <div class="card-top"><span class="pic">${esc(pic)}</span>
          <button class="label-view" data-action="edit-cast" title="Edit label and description">${esc(c.label) || '<i class="muted">no label</i>'}</button></div>
        ${badge ? `<div>${badge}</div>` : ""}${voiceTag(c)}
        <button class="desc-view" data-action="edit-cast" title="Edit label and description">${esc(c.desc) || "<i>Add a description…</i>"}</button>
        <select data-relink="cast" aria-label="Reference image file">${inputOptions("images", c.subfolder, c.image, "Choose an image…")}</select>
        ${tools}
      </div>
      <div class="card-tools">
        <button class="icon" data-action="edit-cast" title="Edit label and description" aria-label="Edit ${esc(c.label)}">${PENCIL}</button>
        <button class="icon${c.bypassed ? " on" : ""}" data-action="bypass-cast" aria-pressed="${c.bypassed}" title="${c.bypassed ? "Turn back on" : "Bypass"}">${POWER}</button>
        <button class="icon x" data-action="remove-cast" title="Remove" aria-label="Remove ${esc(c.label)}">${CROSS}</button>
      </div></div>`;
  });
  // rows (0.8.6): pictures, then audio references, then RefMods, each starting its own row
  cards.push(`<button class="addtile" data-action="add-cast" data-drop="add">${PLUS} <span>Add reference · ${esc(`<Picture ${n + 1}>`)}<br><span class="muted small">or drop images here</span></span></button>`);
  cards.push('<div class="cast-break"></div>');
  for (const v of P().voices || []) cards.push(voiceCard(v));
  const nextA = songSlot() + liveVoices().length + 1;
  cards.push(`<button class="addtile voice-add" data-action="add-voice">${PLUS} <span>Add audio reference · ${esc(`<Audio ${nextA}>`)}<br><span class="muted small">a voice or a sound · or drop audio here</span></span></button>`);
  cards.push('<div class="cast-break"></div>');
  for (const m of P().refmods || []) cards.push(refmodCard(m));
  cards.push(hasPack("refmod")
    ? `<button class="addtile refmod-add" data-action="add-refmod">${PLUS} <span>Add RefMod<br><span class="muted small">a saved character, style or motion</span></span></button>`
    : `<div class="addtile refmod-add install"><span><b>RefMods</b> · reusable characters, styles and motions saved as RefMods<br>${installBtn("refmod", "(Load H3 RefMods)")}</span></div>`);
  $("cast").innerHTML = cards.join("");
}

/** Optional packs (0.8.6): present when ComfyUI has their node. */
const PACK_NODE = { turbo: "MiniMaxH3TurboLoRA", rtx: "RTXVideoSuperResolution", refmod: "MiniMaxH3RefModsLoader" };
const PACK_WHAT = { turbo: "full Turbo support", rtx: "RTX upscaling", refmod: "RefMod support" };
const hasPack = (k) => !S.opts || !S.opts.nodes || S.opts.nodes[PACK_NODE[k]] !== false;
function packInfo(k) { return ((S.opts || {}).optional_packs || {})[k] || { folder: "", url: "" }; }
function installBtn(k, note) {
  return `<button class="install-btn" data-action="install-pack" data-pack="${k}">Click to install ${PACK_WHAT[k]}</button>` +
    `<span class="muted small"> · installs ${esc(packInfo(k).folder)}${note ? " " + esc(note) : ""}</span>`;
}
async function installPack(k) {
  const info = packInfo(k);
  if (!S.local) {
    showModal(`Install ${PACK_WHAT[k]}`, "", `<p>On the machine running ComfyUI, in <code>ComfyUI/custom_nodes</code>:</p>
      <pre class="copy-line">git clone ${esc(info.url)}</pre><p class="muted small">Then restart ComfyUI and refresh this page.</p>`);
    return;
  }
  const ok = await confirmBox({ title: `Install ${PACK_WHAT[k]}?`,
    body: `Clones ${info.folder} into ComfyUI's custom_nodes folder (and installs its Python requirements), then ComfyUI needs a restart.`,
    yes: "Install", no: "Cancel" });
  if (!ok) return;
  toast(`Installing ${info.folder}…`);
  try { await api("/longshot/install-pack", { method: "POST", body: { pack: k } }); }
  catch (e) {
    showModal(`Install ${PACK_WHAT[k]}`, "", `<p>${esc(e.message)}</p><pre class="copy-line">git clone ${esc(info.url)}</pre>`);
    return;
  }
  if (await confirmBox({ title: `${info.folder} is installed`, body: "Restart ComfyUI now to load it?", yes: "Restart ComfyUI", no: "Later" })) restartComfy();
}

/** On a picture card: the voice reference it gets its voice timbre from. */
/** A voice key: a voice reference's id, or "refmod:<id>" for an audio RefMod (0.12.0).
 *  {label: "<Audio N>", name, there: still on} */
function voiceSource(key) {
  if (!key) return null;
  if (String(key).startsWith("refmod:")) {
    const m = (P().refmods || []).find((x) => x.id === key.slice(7));
    return { label: m ? refmodLabelOf(m) : null, name: m ? m.label || m.name : "", there: !!m };
  }
  const v = voiceById(key), isVoice = !!v && (v.role || "voice") === "voice";
  return { label: isVoice ? audioLabelOf(v) : null, name: v ? v.label || v.original_name || "" : "", there: isVoice };
}
/** Every voice a picture or RefMod can take: voice references, then audio RefMods. */
function voiceChoices() {
  const out = (P().voices || []).filter((v) => (v.role || "voice") === "voice")
    .map((v) => ({ key: v.id, label: audioLabelOf(v), name: v.label || v.original_name || "" }));
  for (const m of P().refmods || []) {
    if (m.kind === "audio") out.push({ key: "refmod:" + m.id, label: refmodLabelOf(m), name: (m.label || m.name) + " (RefMod)" });
  }
  return out;
}
function voiceTag(c) {
  if (!c.voice) return "";
  const v = voiceSource(c.voice), a = v && v.label;
  if (a) return `<div><span class="voice-tag" title="Gets its voice timbre from ${esc(a)}${v.name ? " " + esc(v.name) : ""}">🔊 ${esc(a)}</span></div>`;
  return `<div><span class="voice-tag missing" title="Its voice reference is ${v && v.there ? "bypassed" : "removed"}, so the prompt leaves the voice out. Pick another in its editor.">🔊 voice ${v && v.there ? "off" : "removed"}</span></div>`;
}

/** An audio reference card: <Audio N>, label, what it's for, a player. Click to edit (0.12.0). */
function audioRoleText(v) {
  const r = v.role || "voice";
  return r === "other" ? (v.role_text || "audio") : (AUDIO_ROLES.find(([k]) => k === r) || [, "Voice timbre"])[1].toLowerCase();
}
function voiceCard(v) {
  const a = audioLabelOf(v), state = S.refState["voice:" + v.id];
  const missing = !!v.file && (state === "missing" || state === "invalid");
  const role = v.role || "voice";
  const who = [...liveCast().filter((c) => c.voice === v.id).map((c) => c.label || picOf(c)),
    ...(P().refmods || []).filter((m) => !m.bypassed && m.voice === v.id).map((m) => m.label || m.name)];
  const over = !v.bypassed && a && Number(a.match(/\d+/)[0]) > MAX_AUDIO_REFS;
  const src = v.file && !missing ? viewURL({ filename: v.file, subfolder: v.subfolder, type: "input" }) : "";
  const up = S.uploading["voice:" + v.id] ? '<div class="drop-busy">Uploading…</div>' : "";
  const what = role === "voice" ? (who.length ? `Voice timbre of ${esc(who.join(", "))}` : "Voice timbre · not linked to a picture yet")
    : `${esc(audioRoleText(v))} · ${v.use === "copy" ? "copied" : "reference"}`;
  return `<div class="card voice-card${v.bypassed ? " off" : ""}${missing && !v.bypassed ? " missing" : ""}" data-voice="${esc(v.id)}">${up}
      <div class="thumb-col"><button class="thumb voice-thumb" data-action="voice-replace" title="Choose another audio file, or drop one on this card" aria-label="Replace the audio of ${esc(v.label || a || "this audio")}">🔊</button></div>
      <div class="card-body">
        <div class="card-top"><span class="pic">${esc(v.bypassed ? "bypassed" : a || "—")}</span>
          <button class="label-view" data-action="edit-voice" title="Edit this audio reference">${esc(v.label) || '<i class="muted">no label</i>'}</button></div>
        <div class="muted small">${over ? '<span class="warn">Long Shot takes 3 reference audios: bypass one.</span>' : what}</div>
        ${v.desc ? `<button class="desc-view" data-action="edit-voice" title="Edit this audio reference">${esc(v.desc)}</button>` : ""}
        ${missing ? `<div class="missing">Missing: ${esc(v.original_name || v.file)}</div>`
          : src ? `<audio class="voice-play" controls preload="none" src="${esc(src)}"></audio>` : ""}
        <div class="muted small voice-file" title="${esc((v.subfolder ? v.subfolder + "/" : "") + v.file)}">${esc(v.original_name || v.file)}${v.start || v.length ? ` · from ${Number(v.start || 0).toFixed(2)} s${v.length ? ` for ${Number(v.length).toFixed(2)} s` : ""}` : ""}</div>
      </div>
      <div class="card-tools">
        <button class="icon" data-action="edit-voice" title="Edit" aria-label="Edit ${esc(v.label || a || "this audio reference")}">${PENCIL}</button>
        <button class="icon${v.bypassed ? " on" : ""}" data-action="bypass-voice" aria-pressed="${v.bypassed}" title="${v.bypassed ? "Turn back on" : "Bypass"}">${POWER}</button>
        <button class="icon x" data-action="remove-voice" title="Remove" aria-label="Remove ${esc(v.label || "this audio reference")}">${CROSS}</button>
      </div></div>`;
}
/** RefMods (0.8.6): <Picture|Video|Audio N>, numbered after the references of that kind. */
const REFMOD_ICON = { image: "🖼", video: "🎞", audio: "🔊" };
const liveRefmods = () => (P().refmods || []).filter((m) => !m.bypassed && m.name && m.strength > 0);
function refmodLabelOf(m) {
  const i = liveRefmods().indexOf(m);
  if (i < 0) return null;
  const counts = { image: liveCast().length, video: 0, audio: songSlot() + liveVoices().length };
  let label = null;
  liveRefmods().slice(0, i + 1).forEach((x) => { counts[x.kind] += 1; label = `<${{ image: "Picture", video: "Video", audio: "Audio" }[x.kind]} ${counts[x.kind]}>`; });
  return label;
}
function refmodCard(m) {
  const a = refmodLabelOf(m), v = m.voice ? voiceSource(m.voice) : null;
  return `<div class="card refmod-card${m.bypassed ? " off" : ""}" data-refmod="${esc(m.id)}">
      <div class="thumb-col"><button class="thumb refmod-thumb" data-action="edit-refmod" title="RefMod (${esc(m.kind)}) · edit">${REFMOD_ICON[m.kind] || "🖼"}</button></div>
      <div class="card-body">
        <div class="card-top"><span class="pic">${esc(m.bypassed ? "bypassed" : a || "—")}</span>
          <button class="label-view" data-action="edit-refmod" title="Edit this RefMod">${esc(m.label) || '<i class="muted">no label</i>'}</button></div>
        ${v ? `<div>${v.label ? `<span class="voice-tag" title="Gets its voice timbre from ${esc(v.label)} ${esc(v.name)}">🔊 ${esc(v.label)}</span>` : '<span class="voice-tag missing">🔊 voice off</span>'}</div>` : ""}
        <button class="desc-view" data-action="edit-refmod" title="Edit this RefMod">${esc(m.desc) || "<i>Add a description…</i>"}</button>
        <div class="muted small refmod-name">RefMod · ${esc(m.name)} · ${esc(refmodRole(m))} · strength ${Number(m.strength).toFixed(2)}</div>
      </div>
      <div class="card-tools">
        <button class="icon" data-action="edit-refmod" title="Edit" aria-label="Edit ${esc(m.label || m.name)}">${PENCIL}</button>
        <button class="icon${m.bypassed ? " on" : ""}" data-action="bypass-refmod" aria-pressed="${m.bypassed}" title="${m.bypassed ? "Turn back on" : "Bypass"}">${POWER}</button>
        <button class="icon x" data-action="remove-refmod" title="Remove" aria-label="Remove ${esc(m.label || m.name)}">${CROSS}</button>
      </div></div>`;
}
function refmodOf(el) { const c = el.closest("[data-refmod]"); return c && (P().refmods || []).find((x) => x.id === c.dataset.refmod); }
/** Pick a saved RefMod (Load H3 RefMods' list, with each one's kind). */
async function pickRefmod() {
  if (setupGuard()) return;
  let lib = [];
  try { lib = await api("/refmods/library"); } catch (e) { toast("Couldn't list the RefMods: " + e.message); return; }
  const rows = (lib || []).map((x) => x.kind === "bundle"
    ? `<div class="take-row"><span class="mono">${esc(x.name)}</span><span class="muted small">bundle · not supported yet</span></div>`
    : `<div class="take-row"><span>${REFMOD_ICON[x.kind] || "🖼"} <span class="mono">${esc(x.name)}</span></span>
        <span class="muted small">${esc(x.kind)}${x.description ? " · " + esc(x.description) : ""}</span>
        <button class="ghost sm" data-action="use-refmod" data-name="${esc(x.name)}" data-kind="${esc(x.kind)}">Add</button></div>`).join("")
    || '<div class="muted">No RefMods saved yet. Make one with the Extract H3 RefMod node (it saves into ComfyUI/models/mods).</div>';
  showModal("Add a RefMod", "", `<div class="take-list">${rows}</div>`);
}

function voiceOf(el) { const c = el.closest("[data-voice]"); return c && voiceById(c.dataset.voice); }

/** Dropping (or choosing) audio on Cast & Scenes: one voice reference per file,
 *  or a new file for the card it was dropped on. */
async function addVoices(fileList, targetId) {
  const p = P();
  const files = [...fileList].filter((x) => AUDIO_RE.test(x.name || ""));
  if (!files.length) { toast("Drop an audio file for a voice reference (WAV, MP3, FLAC, OGG, M4A, AAC, Opus)."); return; }
  if (setupGuard()) return;
  const target = targetId ? voiceById(targetId) : null;
  const list = target ? files.slice(0, 1) : files;
  const cards = list.map((f) => {
    if (target) return target;
    const v = { id: uid("v"), label: "<" + (f.name || "voice").replace(/\.[^.]+$/, "").slice(0, 24) + ">", file: "", subfolder: "",
      type: "input", original_name: "", sha256: null, size_bytes: null, start: 0, length: 0, bypassed: false };
    p.voices.push(v);
    return v;
  });
  cards.forEach((v) => { S.uploading["voice:" + v.id] = true; });
  render();
  const failed = [];
  const uploaded = await Promise.all(list.map(async (f) => {
    try { return await uploadFile(f, "audio"); } catch (e) { failed.push(`${f.name}: ${e.message}`); return null; }
  }));
  let changed = false;
  uploaded.forEach((info, i) => {
    const v = cards[i];
    delete S.uploading["voice:" + v.id];
    if (!info) { if (!target) p.voices.splice(p.voices.indexOf(v), 1); return; }
    const same = !!v.sha256 && info.sha256 === v.sha256;
    Object.assign(v, { file: info.name, subfolder: info.subfolder, original_name: info.name, sha256: info.sha256, size_bytes: info.size_bytes });
    S.refState["voice:" + v.id] = "ok";
    if (!same && !v.bypassed) changed = true;
  });
  await loadInputs();
  if (changed) applyRefChange((await askRefChange()) || "keep", "Voice references");
  commit();
  const notes = [];
  if (failed.length) notes.push(`Couldn't upload ${failed.join("; ")}`);
  if (audioRefCount() > MAX_AUDIO_REFS) notes.push(`Long Shot takes ${MAX_AUDIO_REFS} reference audios (the song's voice counts as one): bypass some before rendering.`);
  else if (!target && !failed.length) notes.push("Link it to a character: open the picture's editor and pick it under \"gets its voice timbre from\".");
  if (notes.length) toast(notes.join(" "));
}

function pickVoices(targetId) {
  if (setupGuard()) return;
  const inp = document.createElement("input");
  inp.type = "file";
  inp.accept = "audio/*";
  inp.multiple = !targetId;
  inp.addEventListener("change", () => { if (inp.files.length) addVoices(inp.files, targetId); });
  inp.click();
}

const STYLE_FIELDS = [["summary", "Summary", 2], ["retention", "Retention", 1], ["style_line", "Style line", 3],
  ["soundscape", "Soundscape", 2], ["music", "Music", 1]];

function renderStyle() {
  $("style").hidden = !S.styleOpen;
  $("style-chev").textContent = S.styleOpen ? "Hide ▴" : "Show ▾";
  $("style-toggle").setAttribute("aria-expanded", S.styleOpen);
  if (!S.styleOpen) return;
  const st = P().style;
  $("style").innerHTML = STYLE_FIELDS.map(([k, label, rows]) =>
    (k === "summary" ? taskTypesHTML() : "") +
    `<label for="f-${k}">${label}</label><textarea class="fit" id="f-${k}" data-style="${k}" rows="${rows}">${esc(st[k])}</textarea>`).join("");
  fitAll($("style"));
}

/** 0.12.4: the summary's task types (the prompt compiler's), toggled in click order. */
const TASK_TYPES = ["keyframe completion", "reference generation", "video editing", "video continuation",
  "audio reuse", "audio reference"];
const MAX_TASK_TYPES = 3;
/** Added by the Studio itself: the song as <Audio 1>, or an audio reference set to Copy. */
function autoAudioReuse() {
  return songRefOn() || (P().voices || []).some((v) => !v.bypassed && v.file && (v.role || "voice") !== "voice" && v.use === "copy");
}
/** The types as the prompt writes them: yours, then "audio reuse" when it's automatic. */
function taskTypesOut() {
  const t = (P().style.task_types || []).filter((x) => TASK_TYPES.includes(x)).slice(0, MAX_TASK_TYPES);
  const out = t.length ? t.slice() : ["reference generation"];
  if (autoAudioReuse() && !out.includes("audio reuse") && out.length < MAX_TASK_TYPES) out.push("audio reuse");
  return out;
}
function taskTypesHTML() {
  const on = P().style.task_types || [];
  const auto = autoAudioReuse() && !on.includes("audio reuse") && on.length < MAX_TASK_TYPES;
  const typed = (P().style.summary || "").trim().startsWith("[");
  const chips = TASK_TYPES.map((t) => {
    const isOn = on.includes(t), isAuto = t === "audio reuse" && auto;
    return `<button class="tt-chip${isOn ? " on" : ""}${isAuto ? " auto" : ""}" data-action="task-type" data-t="${esc(t)}" aria-pressed="${isOn}"
      title="${isAuto ? "Added automatically (the song as <Audio 1>, or an audio reference set to Copy). Click to keep it on yourself." : isOn ? "Click to remove" : "Click to add"}">${esc(t)}${isAuto ? " · auto" : ""}</button>`;
  }).join("");
  return `<label>Task types</label><div class="tt-cell"><div class="tt-row">${chips}
      <button class="ghost sm" data-action="task-types-clear"${on.length ? "" : " disabled"}>Clear</button></div>
    <div class="muted small tt-preview">${typed
      ? '<span class="warn">Your Summary starts with [ … ], so the prompt uses it as written and these buttons are ignored.</span>'
      : `The summary starts with <span class="mono">[${esc(taskTypesOut().join(" + "))}]</span>${on.length ? "" : " (the default)"}` +
        (autoAudioReuse() && !on.includes("audio reuse") && on.length >= MAX_TASK_TYPES
          ? ' <span class="warn">· no room for the automatic "audio reuse": remove one.</span>' : "")}</div></div>`;
}
async function setTaskTypes(next) {
  if (setupGuard()) return;
  const mode = await askSettingChange("Change the task types");
  if (!mode) return;
  P().style.task_types = next;
  applyRefChange(mode, "Style & Sound");
  commit();
}

/** Retention: with the mouse resting on the field, the markers it takes (0.8.4).
 *  Read-only: it never edits the text; gone on moving off or typing. */
const RET_HINT = `<div class="rh-h">Pictures and subjects</div>
  <div class="rh-row"><code>fully_preserved</code><span>kept exactly: face, outfit, shape, colours</span></div>
  <div class="rh-row"><code>partially_preserved</code><span>kept, with some features free to change</span></div>
  <div class="rh-row"><code>attribute_transfer</code><span>only some attributes carried over (style, colour, costume)</span></div>
  <div class="rh-row"><code>weak_reference</code><span>loose guidance only</span></div>
  <div class="rh-h">Audio</div>
  <div class="rh-row"><code>fully_copy</code><span>the sound used as is</span></div>
  <div class="rh-row"><code>partially_copy</code><span>part of it used as is</span></div>
  <div class="rh-row"><code>reference</code><span>its timbre, style or rhythm only</span></div>
  <div class="rh-row"><code>weak_reference</code><span>loose guidance only</span></div>
  <div class="rh-h">One line per label</div>
  <div class="rh-ex"><code>&lt;Luma&gt; (appears in [Shot 1]): fully_preserved - face and pajamas.</code></div>
  <div class="rh-note">Never write (S1) here.</div>`;
let rhTimer = null;
function hideRetHint() { clearTimeout(rhTimer); const h = $("ret-hint"); if (h) h.hidden = true; }
document.addEventListener("mousemove", (e) => {
  const el = e.target && e.target.id === "f-retention" ? e.target : null;
  clearTimeout(rhTimer);
  const h = $("ret-hint");
  if (!el) { if (h && !h.hidden && !(e.target.closest && e.target.closest("#ret-hint"))) h.hidden = true; return; }
  if (h && !h.hidden) return;                    // already showing: stays while the mouse is on the field
  rhTimer = setTimeout(() => {
    let box = $("ret-hint");
    if (!box) { box = document.createElement("div"); box.id = "ret-hint"; box.className = "ret-hint"; document.body.appendChild(box); }
    box.innerHTML = RET_HINT;
    const r = el.getBoundingClientRect();
    box.hidden = false;
    const w = box.offsetWidth, hh = box.offsetHeight;
    let top = r.bottom + 6, left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
    if (top + hh > window.innerHeight - 8) top = Math.max(8, r.top - hh - 6);
    box.style.top = top + "px";
    box.style.left = left + "px";
  }, 500);
});
document.addEventListener("keydown", (e) => { if (e.target && e.target.id === "f-retention") hideRetHint(); }, true);
document.addEventListener("scroll", hideRetHint, true);

/** Style & Sound and Shot prompt boxes: as tall as their text (the rows attribute
 *  is the least), on open, while typing and after every redraw. */
function fitText(el) {
  if (!el || !el.isConnected || !el.offsetParent) return;
  el.style.height = "auto";
  const cs = getComputedStyle(el);
  const border = parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
  el.style.height = el.scrollHeight + border + "px";
}
function fitAll(root) {
  for (const el of (root || document).querySelectorAll("textarea.fit")) fitText(el);
}

const LOOK = {
  approved: { icon: "✓", label: "Approved", dot: "#2E5C48", fg: "#9FE0C2", chipBg: "#1C3A2E", chipFg: "#9FE0C2" },
  review: { icon: "●", label: "Reviewing", dot: "#6B4A12", fg: "#FFD08A", chipBg: "#3D2C10", chipFg: "#FFD08A" },
  rendering: { icon: "◌", label: "Rendering…", dot: "#3A3D44", fg: "#E9E7E2", chipBg: "#2A2C31", chipFg: "#E9E7E2" },
  queued: { icon: "○", label: "Queued", dot: "#24262B", fg: "#8E9198", chipBg: "transparent", chipFg: "#A3A6AD" },
  bypassed: { icon: "⏻", label: "Bypassed", dot: "#2B2240", fg: "#C9B6FF", chipBg: "#2B2240", chipFg: "#C9B6FF" },
  clip: { icon: "▶", label: "Clip", dot: "#1E3A4A", fg: "#8FD3F0", chipBg: "#16303D", chipFg: "#8FD3F0" },
};

/** The marker between two pieces when one of them is a clip: Bridge ↔ / Cut |. */
function joinMark(prev, s) {
  const both = prev.kind === "clip" && s.kind === "clip";
  const cut = both || s.join === "cut";
  const why = both ? "Two clips always meet with a cut." : cut
    ? "Hard cut: the Shots keep their takes." : "Bridge: the generated Shot flows into / out of the clip.";
  return `<div class="join-mark${cut ? " cut" : ""}" data-shot="${esc(s.id)}">
    <button class="join-btn" data-action="toggle-join"${both ? " disabled" : ""} title="${esc(why)} Click to switch.">${cut ? "Cut |" : "Bridge ↔"}</button>
    <span class="muted small">${esc(why)}</span></div>`;
}

/** The open project has a Shot render going. */
const inRenderAny = () => busyHere() && !!S.busy && !!S.busy.built && S.busy.kind !== "dry" && S.busy.kind !== "check";

/** A Shot in the render that's running can't be edited until it finishes. */
const inRender = (s) => busyHere() && !!S.busy && S.busy.kind !== "dry" && S.busy.kind !== "check" &&
  !!S.busy.built && S.busy.built.chain.includes(s.id);

const CHIP_HELP = {
  cut: "a fresh start from the references; nothing pinned.",
  context: "a hard cut; the last frame of the Shot before goes in as a reference picture (same characters, place and light).",
  from: "continues from the end of the Shot before; its end is free.",
  pending: "continues from the Shot before in Render all. ▶ on this Shot alone pins it to the rendered Shots next to it (approved or under review; one still rendering is waited for); with none rendered yet it renders on its own.",
  into: "a fresh start that flows into the start of the Shot after.",
  bridge: "pinned at both ends: flows from the Shot before into the Shot after.",
};
function chipKey(s) {
  const j = chipJoin(s);
  if (j !== "bridge") return j;
  const { prev, next } = chipSides(s);
  return prev && next ? "bridge" : prev ? "from" : next ? "into" : "pending";
}

/** The always-visible row of a (generated) Shot card: status, title, preview, tools. */
function shotRowHTML(s) {
  const rid = renderingId();
  const run = !s.bypassed ? runState(s) : null;
  const state = s.bypassed ? "bypassed" : s.id === rid ? "rendering" : s.status;
  const L0 = LOOK[state];
  // in a run of several Shots: which one is sampling, which come next, which are done
  const L = run && run.state === "waiting" ? Object.assign({}, L0, { label: run.pos === 1 ? "Up next" : `${ORD(run.at)} in this run` })
    : run && run.state === "done" ? Object.assign({}, L0, { label: "Sampled · clip at the end", fg: "#9FE0C2" }) : L0;
  const title = s.bypassed ? "Bypassed" : "Shot " + numOf(s.id);
  const seed = !isAuto(s) ? String(s.shot_seed)
    : s.status !== "queued" && hasSeed(s.seed_used) ? `auto · ${s.seed_used}` : "auto";
  const open = S.open === s.id;
  const chipBorder = state === "queued" ? "#33363C" : "transparent";
  const edited = s.status === "queued" && s.edit_from && !s.bypassed;
  const flag = edited ? '<span class="flag edited" title="Edited since its take was rendered. Change it back to exactly what it was to keep that take.">edited</span>'
    : s.was_approved && s.status !== "approved" ? '<span class="flag" title="Approved before; re-renders with its seed">was ✓</span>'
      : s.was_rendered && s.status === "queued" ? '<span class="flag" title="Rendered before; re-renders with its seed">was ●</span>' : "";
  const canReroll = !s.bypassed && s.status === "approved" && (!!s.take || !!lastRowFor(s.id));
  const row = lastRowFor(s.id);
  const cut = cutBefore(s)
    ? (s.standalone
      ? '<span class="flag cut" title="Rendered on its own, so it doesn\'t follow on from the Shot before it. Render the Shot before it with its chip on Continuous or Bridge to join them.">↯ hard cut · standalone</span>'
      : '<span class="flag cut" title="This Shot doesn\'t follow on from the take of the Shot before it, so the join is a hard cut.">↯ hard cut</span>') : "";
  // the prompt can be edited while the Shot renders (0.8.6): say what the take has
  const sentText = inRender(s) && S.busy && S.busy.sent && S.busy.sent[s.id] ? S.busy.sent[s.id].text : null;
  const promptFlag = sentText !== null && sentText !== s.text
    ? `<span class="flag edited" title="Rendering with:\n${esc(sentText)}">✎ Prompt changed · not in this render</span>`
    : s.status !== "queued" && !s.bypassed && promptOnlyChanged(s)
      ? `<span class="flag edited" title="This take was rendered with:\n${esc(s.rendered.text)}\n\nChange the text back to that, or Re-render.">✎ Prompt changed since this take</span>` : "";
  const promptBtn = sentText === null && s.status !== "queued" && !s.bypassed && promptOnlyChanged(s)
    ? `<button class="ghost sm bridge" data-action="context-redo" title="Render ${title} again in place with the new prompt (the Shots around it keep their takes)">Re-render</button>` : "";
  const standaloneTag = !cut && s.standalone && s.status !== "queued" && !s.bypassed
    ? '<span class="flag standalone" title="Rendered on its own, from the references. The Shot before it bridges into it.">standalone</span>' : "";
  // rendering now or waiting in the queue: ▶ (yellow) queues another take after it
  const live = !s.bypassed && s.kind !== "clip" && (s.id === rid || inRender(s) || !!jobFor(s.id));
  const canAlone = (state === "queued" || live) && s.kind !== "clip" && !s.bypassed;
  const aloneOff = S.conn !== "ok" || missingRefs().length > 0;
  const play = !canAlone ? "" : live
    ? `<button class="sdot sdot-play again" data-action="render-alone"${aloneOff ? " disabled" : ""}
      title="${s.id === rid ? "Rendering now" : "In the queue"}. Click to queue another take of ${title} after it (next seed)." aria-label="Queue another take of ${title}">▶</button>`
    : `<button class="sdot sdot-play" data-action="render-alone"${aloneOff ? " disabled" : ""}
      title="Render ${title} · ${chipName(s)}: ${esc(CHIP_HELP[chipKey(s)])}" aria-label="Render ${title} (${chipName(s)})">▶</button>`;
  // the join chip: how ▶ renders it, from the rendered Shots next to it
  const actR = active(), prevR = !s.bypassed ? actR[actR.indexOf(s) - 1] : null;
  const cj = chipJoin(s), opts = chipOptions(s);
  const icon = { bridge: "↔", context: "⧉", cut: "|" }[cj];
  const joinChip = !s.bypassed && s.kind !== "clip"
    ? `<button class="join-chip j-${esc(cj)}${opts.length < 2 ? " only" : ""}" data-action="cycle-join" title="${esc(chipName(s) + ": " + CHIP_HELP[chipKey(s)])}${
      (() => { const nb = chipNear(s), odd = [nb.prev, nb.next].filter(otherSize);
        return odd.length ? esc(` ${odd.map(titleOf).join(" and ")} ${odd.length > 1 ? "are" : "is"} another size, so not pinned to (a hard cut there).`) : ""; })()}${
      opts.length < 2 ? " No Shot next to it, so Cut is the only choice." : ` Click to switch: ${opts.map((o) => chipName(s, o)).join(" → ")}.`}">${icon} ${chipName(s)}</button>` : "";
  const ctxStale = s.join === "context" && s.status !== "queued" && s.context_from && prevR &&
    (prevR.kind === "clip" ? `clip:${prevR.id}` : prevR.take) !== s.context_from;
  const ctxFlag = ctxStale ? `<span class="flag cut" title="The Shot before has a different take now. Re-render ${title} to take its new last frame.">context changed</span>` : "";
  const ctxBtn = ctxStale ? `<button class="ghost sm bridge" data-action="context-redo" title="Re-render ${title} from the new last frame of the Shot before (the Shots after it keep their takes)">Re-render</button>` : "";
  return `${play}<button class="shot-head${play ? " has-play" : ""}" data-action="toggle-shot" aria-expanded="${open}">
          ${play ? "" : `<span class="sdot" style="background:${L.dot};color:${L.fg}">${L.icon}</span>`}
          <span class="stitle">${title}</span>
          <span class="smeta">${isEmptyShot(s) ? `${(Number(s.seconds) || 0).toFixed(2)}s · <span class="hold-tag" title="No prompt: it holds its time on the film and never renders. Moving the Shot next to it makes it longer or shorter.">holds time</span>`
            : `${esc(s.seconds)}s · seed ${esc(seed)}`}${songSpanHTML(s)}${editTag(s)}${phraseTag(s)}${alignedTag(s)}${sizeTag(s)}</span>
          <span class="snotes">${flag}${cut}${standaloneTag}${ctxFlag}
          <span class="chip" style="background:${L.chipBg};color:${L.chipFg};border-color:${chipBorder}">${L.label}</span></span>
        </button>
        <div class="shot-tools">
          ${promptFlag}${promptBtn}${joinChip}${ctxBtn}
          ${canReroll ? `<button class="icon lg reroll" data-action="reroll-shot" title="Reroll ${title} (new seed)" aria-label="Reroll ${title}">⟳</button>` : ""}
          <button class="icon lg${s.bypassed ? " on" : ""}" data-action="bypass-shot" aria-pressed="${s.bypassed}" title="${s.bypassed ? "Turn shot back on" : "Bypass shot"}">${POWER}</button>
          <button class="icon lg x" data-action="remove-shot" title="Remove" aria-label="Remove ${title}">${CROSS}</button>
        </div>
        <button class="sprev${play ? " has-play" : ""}" data-action="toggle-shot" tabindex="-1" aria-hidden="true">${esc(s.text) || '<i class="muted">empty</i>'}</button>`;
}

/** A run's progress moved on: the rows of the Shots in it (fields untouched). */
function refreshRunRows(b) {
  if (!b || !b.built) return;
  for (const id of b.built.chain) { const x = shotById(id); if (x && x.kind !== "clip") refreshShotRow(x); }
  renderViewer();
}

/** While typing: only the Shot's row changes, never its fields. */
function refreshShotRow(s) {
  const el = document.querySelector(`.shot[data-shot="${CSS.escape(s.id)}"]`);
  if (!el || s.kind === "clip") return;
  const row = el.querySelector(":scope > .shot-row");
  if (row) row.innerHTML = shotRowHTML(s);
  el.classList.toggle("review", !s.bypassed && s.status === "review");
}

// ---------------------------------------------------------------------------
// Frame anchors: an image at a join (before Shot 1, between two Shots, after
// the last). It's the last frame of the Shot before and the first frame of the
// Shot after; each of them gets it as its next <Picture N>, after the Cast.
// Kept on the Shot after the join (anchor_in), or the project (anchor_end).
// ---------------------------------------------------------------------------

/** Joins that can take an anchor: before each generated Shot whose neighbour
 *  before it isn't a clip, and after the last Shot when it's generated. */
function anchorKeys() {
  const act = active(), out = [];
  act.forEach((s, i) => { if (s.kind !== "clip" && !(act[i - 1] && act[i - 1].kind === "clip")) out.push(s.id); });
  if (act.length && act[act.length - 1].kind !== "clip") out.push("end");
  return out;
}
function anchorItem(key) {
  const a = key === "end" ? P().anchor_end : (P().shots.find((x) => x.id === key) || {}).anchor_in;
  return a && a.file ? a : null;
}
/** The Shots on either side of a join: [before, after] (either may be null). */
function anchorSides(key) {
  const act = active();
  if (key === "end") return [act[act.length - 1] || null, null];
  const i = act.findIndex((x) => x.id === key);
  return [i > 0 ? act[i - 1] : null, i >= 0 ? act[i] : null];
}
function anchorTitle(key) {
  const [a, b] = anchorSides(key);
  return !a ? `First frame of ${titleOf(b)}` : !b ? `Last frame of ${titleOf(a)}` : `Frame between ${titleOf(a)} and ${titleOf(b)}`;
}
/** <Picture N> of an anchor for the Shot before it (its end) and after it (its start). */
function anchorPictures(key) {
  const k = liveCast().length;
  const [a, b] = anchorSides(key);
  const out = [];
  if (a) out.push(`${titleOf(a)}: <Picture ${k + 1 + (a.anchor_in && a.anchor_in.file && anchorKeys().includes(a.id) ? 1 : 0)}> (its end)`);
  if (b) out.push(`${titleOf(b)}: <Picture ${k + 1}> (its start)`);
  return out.join(" · ");
}

/** A tile in the Anchors column, straddling the join it belongs to ("top" of
 *  the card after it, or "bottom" of the last card for the end anchor). */
function anchorSlot(key, edge = "top") {
  const it = anchorItem(key);
  const miss = it && ["missing", "invalid"].includes(S.refState["anchor:" + key]);
  const thumb = it && !miss ? `<img class="anchor-thumb" alt="" draggable="false" src="${esc(viewURL({ filename: it.file, subfolder: it.subfolder || "", type: "input" }))}">` : "";
  const tip = anchorTitle(key) + (it ? `\n${miss ? "Missing: " : ""}${it.file}\n${anchorPictures(key).split(" · ").join("\n")}`
    : "\nFrame anchor (optional): click to upload, or drop an image here");
  return `<div class="anchor-slot ${edge}${it ? " set" : ""}${miss ? " missing" : ""}" data-anchor="${esc(key)}" title="${esc(tip)}">
    ${thumb ? `<button class="anchor-face" data-action="anchor-pick" aria-label="${esc(anchorTitle(key))}: upload a new image">${thumb}</button>`
      : `<button class="anchor-face anchor-add" data-action="anchor-pick" aria-label="${esc(anchorTitle(key))}: upload an image">${miss ? "!" : PLUS}</button>`}
    <span class="anchor-tools">
      <span class="anchor-swap" title="Choose a file from the input folder">⇄<select class="anchor-sel" data-anchor-file aria-label="${esc(anchorTitle(key))}: choose a file">${inputOptions("images", it ? it.subfolder : "", it ? it.file : "", it ? "None" : "Choose a file…")}</select></span>
      ${it ? `<button class="anchor-x" data-action="anchor-clear" title="Remove this frame anchor" aria-label="Remove this frame anchor">${CROSS}</button>` : ""}
    </span>
  </div>`;
}

/** An anchor changed: the Shots touching it render again, or keep their takes. */
async function anchorChanged(key) {
  const touched = anchorSides(key).filter((x) => x && x.kind !== "clip" && x.status !== "queued");
  S.dry = null;
  if (touched.length) {
    // the takes are kept; the notice offers to re-render them on the new frame
    const names = touched.map(titleOf).join(" and ");
    changeNote("Frame anchor", `${names} keep${touched.length > 1 ? "" : "s"} ${touched.length > 1 ? "their takes" : "its take"}`, {
      label: `Re-render ${names}`,
      fn: () => {
        S.gen++;
        for (const x of touched) {
          if (x.status === "queued") continue;
          if (x.status === "approved") x.was_approved = true; else x.was_rendered = true;
          x.status = "queued";
        }
        commit();
      } });
  }
  commit();
  checkInputs().then(render);
}

function setAnchor(key, info) {
  const p = P();
  const val = info ? { file: info.name || info.file, subfolder: info.subfolder || "", sha256: info.sha256 || null } : null;
  if (key === "end") p.anchor_end = val;
  else { const sh = p.shots.find((x) => x.id === key); if (!sh) return; sh.anchor_in = val; }
  if (val) S.refState["anchor:" + key] = "ok";
  anchorChanged(key);
}

async function anchorUpload(key, fileList) {
  const f = [...fileList].find(isImageFile);
  if (!f) { toast("A frame anchor is an image (PNG, JPG, WebP…)."); return; }
  if (setupGuard()) return;
  try { setAnchor(key, await uploadImage(f)); await loadInputs(); render(); }
  catch (e) { toast("Upload failed: " + e.message); }
}

function anchorPick(key) {
  if (setupGuard()) return;
  const inp = document.createElement("input");
  inp.type = "file";
  inp.accept = "image/*";
  inp.addEventListener("change", () => { if (inp.files.length) anchorUpload(key, inp.files); });
  inp.click();
}

function renderShots() {
  requestLayout();
  if (deferIfHeld("shots")) return;
  let prevActive = null;
  const slots = new Set(anchorKeys());
  const lastId = active().length ? active()[active().length - 1].id : null;
  /** The Anchors column tiles that sit on this card's edges. */
  const tiles = (s) => s.bypassed ? "" : (slots.has(s.id) ? anchorSlot(s.id, "top") : "") +
    (s.id === lastId && slots.has("end") ? anchorSlot("end", "bottom") : "");
  $("shots-panel").classList.toggle("has-anchors", slots.size > 0);
  {                                                  // 0.12.3: the one line when Shots is folded
    const act = active().filter((s) => !isEmptyShot(s));
    const ok = act.filter((s) => s.status === "approved").length;
    $("shots-summary").textContent = `${act.length} Shot${act.length === 1 ? "" : "s"} · ${ok} approved`;
  }
  // ⇅ (0.8.5): newest Shot on top; display only, kept per browser
  const flip = store("h3studio.flipShots") === "1";
  $("shots-panel").classList.toggle("flipped", flip);
  $("flip-shots").setAttribute("aria-pressed", String(flip));
  $("flip-shots").title = flip ? "Shot 1 on top again" : "Flip the list: newest Shot on top, Shot 1 at the bottom";
  $("shots-panel").classList.toggle("anchor-end", slots.has("end"));
  $("shots").innerHTML = P().shots.map((s) => {
    let mark = "";
    if (!s.bypassed) {
      if (prevActive && (prevActive.kind === "clip" || s.kind === "clip")) mark = joinMark(prevActive, s);
      prevActive = s;
    }
    if (s.kind === "clip") return mark + clipCard(s);
    const rid = renderingId();
    const state = s.bypassed ? "bypassed" : s.id === rid ? "rendering" : s.status;
    const title = s.bypassed ? "Bypassed" : "Shot " + numOf(s.id);
    const open = S.open === s.id;
    const canReroll = !s.bypassed && s.status === "approved" && (!!s.take || !!lastRowFor(s.id));
    const takes = !s.bypassed && s.status !== "queued" ? takeNav(s) : "";
    const ro = inRender(s) ? ' readonly title="Part of the render in progress; edit it when it finishes"' : "";
    const body = open ? `<div class="shot-body">
        <textarea class="field fit" data-shot-field="text" rows="3" aria-label="${title} text">${esc(s.text)}</textarea>
        <div class="shot-opts">
          <label class="lbl-row">Seconds <input type="number" step="0.1" min="0.1" data-shot-field="seconds" value="${esc(s.seconds)}" style="width:72px"${ro}></label>
          <label class="lbl-row">Seed <input class="mono" data-shot-field="shot_seed" value="${s.shot_seed < 0 ? "" : esc(s.shot_seed)}" placeholder="auto${isAuto(s) && s.status !== "queued" && hasSeed(s.seed_used) ? ` · ${s.seed_used}` : ""}" style="width:120px"${ro}></label>${seedStepHTML("shot-seed-step", !!ro, isAuto(s) ? "On auto: gives this Shot its own seed, one from its last take's" : "")}
          <button class="ghost sm" data-action="wrap" data-before="&lt;d&gt;[English] " data-after="&lt;/d&gt;">Wrap &lt;d&gt; dialogue</button>
          <button class="ghost sm" data-action="wrap" data-before="&quot;" data-after="&quot;">Wrap "on-screen text"</button>
          ${canReroll ? '<button class="ghost sm" data-action="reroll-shot">⟳ Reroll this Shot</button>' : ""}
        </div>
        <div class="shot-opts shot-more">
          ${takes}
          <span class="push"></span>
          ${!s.bypassed && s.status !== "queued" ? `<button class="ghost sm" data-action="clear-render"${inRender(s) ? " disabled" : ""}
            title="Back to not rendered: keeps the prompt, length and seed. The take stays in Take history.">Clear render</button>` : ""}
          ${s.kind !== "clip" && s.take ? `<button class="ghost sm" data-action="restore-refs"
            title="${refSetFor(s) ? "Put back the references this take was made with: removed ones are added again, bypassed ones turned on. Others stay as they are."
              : "This take was made before 0.8.13, so the references it used weren't recorded."}">Restore references</button>` : ""}
          <button class="ghost sm" data-action="insert-before" title="Insert a new Shot before this one">⊕ Shot before</button>
          <button class="ghost sm" data-action="insert-after" title="Insert a new Shot after this one">⊕ Shot after</button>
          <button class="ghost sm" data-action="insert-clip-after" title="Insert a video clip after this Shot">⊕ Clip after</button>
          <button class="ghost sm" data-action="replace-clip" title="Put a video clip in this Shot's place (the Shot is kept, bypassed)">Replace with clip</button>
        </div>
        </div>` : "";
    return mark + `<div class="shot${state === "review" ? " review" : ""}${s.bypassed ? " off" : ""}" data-shot="${esc(s.id)}">${tiles(s)}
      <div class="shot-row">${shotRowHTML(s)}</div>${body}</div>`;
  }).join("");
  $("add-shot").innerHTML = `${PLUS} Add Shot ${active().length + 1}`;
  const off = S.conn !== "ok" || missingRefs().length > 0;
  const nAll = toRender().filter((x) => !jobFor(x.id)).length, nOdd = oddToRender().filter((x) => !jobFor(x.id)).length;
  $("render-all").textContent = `▶ Render all${nAll ? ` (${nAll})` : ""}`;
  $("render-all").disabled = off || !nAll;
  $("render-odd").textContent = `▶ Render odd Shots${nOdd ? ` (${nOdd})` : ""}`;
  $("render-odd").disabled = off || !nOdd;
  $("clear-all").disabled = busyHere() || !active().some((s) => s.kind !== "clip" && s.status !== "queued");
  const first = $("add-first");
  first.hidden = !P().shots.length;
  first.innerHTML = `${PLUS} Add shot before Shot 1`;
  $("add-first-clip").hidden = !P().shots.length;
  fitAll($("shots"));
}

function clipCard(s) {
  const state = s.bypassed ? "bypassed" : "clip";
  const L = LOOK[state];
  const title = s.bypassed ? "Bypassed" : "Shot " + numOf(s.id);
  const open = S.open === s.id;
  const missing = ["missing", "invalid"].includes(S.refState["clip:" + s.id]);
  const row = lastRowFor(s.id);
  const cut = !s.bypassed && row && row.seam === "mismatch"
    ? '<span class="flag cut" title="The Shot before this clip doesn\'t lead into it yet. Render it (or switch this join to Cut).">↯ not bridged</span>' : "";
  return `<div class="shot clip${s.bypassed ? " off" : ""}${missing ? " missing" : ""}" data-shot="${esc(s.id)}">
    <div class="shot-row">
      <button class="shot-head" data-action="toggle-shot" aria-expanded="${open}">
        <span class="sdot" style="background:${L.dot};color:${L.fg}">${L.icon}</span>
        <span class="stitle">${title}</span>
        <span class="smeta">${(s.clip.frames / 24).toFixed(2)}s · clip${songSpanHTML(s)}${editTag(s)}</span>
        <span class="sprev">${missing ? '<span class="missing">Missing: </span>' : ""}${esc(s.clip.original_name || s.clip.file) || '<i class="muted">no video</i>'}</span>
        ${cut}
        <span class="chip" style="background:${L.chipBg};color:${L.chipFg}">${L.label}</span>
      </button>
      <div class="shot-tools">
        <button class="icon lg${s.bypassed ? " on" : ""}" data-action="bypass-shot" aria-pressed="${s.bypassed}" title="${s.bypassed ? "Turn the clip back on" : "Bypass clip"}">${POWER}</button>
        <button class="icon lg x" data-action="remove-shot" title="Remove" aria-label="Remove ${title}">${CROSS}</button>
      </div>
    </div>${open ? clipCardBody(s, title) : ""}</div>`;
}

function renderViewer() {
  if (!P()) return;
  if (buildTL()) tlSeek(PL.t);                    // takes / renders changed: same time, new pieces
  const has = TL.entries.some((e) => e.src);
  const lo = last();
  $("tc-overlay").hidden = !has;
  showEntry(TL.entries[entryAt(PL.t)]);
  const total = TL.total;
  const scrub = $("scrub");
  scrub.max = String(total || 0);
  scrub.disabled = !TL.entries.length || !has;
  $("ticks").innerHTML = "";
  // the timeline: one block per Shot, its thumbnail, ◀ take ▶ under it
  $("tl-strip").innerHTML = total ? TL.entries.map((e) => {
    const sh = shotById(e.id);
    if (!sh) return "";
    const off = takesLocked(sh);
    const st = sh.kind === "clip" ? "clip" : sh.status;
    const list = sh.kind !== "clip" && sh.take ? S.takes[sh.id] : null;
    const i = list ? list.findIndex((t) => t.name === sh.take) : -1;
    const nav = list && list.length > 1 ? `<div class="tl-takes">
        <button class="tl-arrow" data-action="tl-take" data-dir="-1"${i <= 0 || off ? " disabled" : ""} aria-label="Previous take of ${esc(titleOf(sh))}">◀</button>
        <span>${i + 1}/${list.length}</span>
        <button class="tl-arrow" data-action="tl-take" data-dir="1"${i < 0 || i >= list.length - 1 || off ? " disabled" : ""} aria-label="Next take of ${esc(titleOf(sh))}">▶</button></div>` : "";
    const why = !e.rendered ? "not rendered yet" : e.noclip ? "its clip is being made" : st;
    return `<div class="tl-block st-${st}${S.focus === e.id ? " focus" : ""}${e.src ? "" : " gap"}" data-tl="${esc(e.id)}"
        style="left:${(e.start / total) * 100}%;width:${(e.dur / total) * 100}%">
      <button class="tl-pick" data-action="tl-pick" title="${esc(titleOf(sh))} · ${esc(why)} · click to go there"
        ${e.thumb ? `style="background-image:url('${esc(e.thumb)}')"` : ""}><span class="tl-num">${sh.kind === "clip" ? "▶" : "S"}${numOf(sh.id)}${isAligned(sh) ? ' <span class="tl-aligned" title="Aligned">✓</span>' : ""}</span></button>
      ${nav}${trimHandles(sh)}</div>`;
  }).join("") : "";
  const approx = !TL.exact && TL.entries.some((e) => e.rendered);
  $("tl-approx").hidden = !approx;
  const off = busyHere();
  $("tl-update").disabled = S.conn !== "ok";
  const miss = missingClips().length, older = takesWithoutClips().length;
  $("tl-make").hidden = !miss && !older;
  $("tl-make").textContent = miss ? `Make ${miss} missing clip${miss === 1 ? "" : "s"}`
    : `Make clips for ${older} older take${older === 1 ? "" : "s"}`;
  $("tl-make").title = miss ? "Shots on the timeline whose take has no clip (deleted, or made before 0.6.5): decode each take on its own. Nothing is sampled."
    : "Takes in Take history that have no clip yet: decode each on its own (nothing is sampled).";
  $("tl-approx-main").hidden = !approx;
  $("tl-approx").hidden = !approx && $("tl-make").hidden;
  $("tl-make").disabled = off || S.conn !== "ok";
  const nApproved = active().filter((s) => s.kind !== "clip" && s.status === "approved" && s.take).length;
  $("tl-export").hidden = !nApproved;
  $("tl-export-btn").textContent = `Export ${nApproved} approved clip${nApproved === 1 ? "" : "s"}`;
  $("tl-export-btn").disabled = S.conn !== "ok";
  const vsrOk = !S.opts || !S.opts.nodes || S.opts.nodes.RTXVideoSuperResolution !== false;
  $("tl-export-up").checked = vsrOk && !!P().settings.export_upscale;
  $("tl-export-up").disabled = !vsrOk;
  // loop band + note
  const L = loopRange();
  const band = $("loop-band"), note = $("loop-note");
  if (S.loop && L && total) {
    band.hidden = false;
    band.style.left = (L.a / total) * 100 + "%";
    band.style.width = ((L.b - L.a) / total) * 100 + "%";
    note.hidden = false;
    note.textContent = `Looping ${fmt(L.a)} → ${fmt(L.b)}` + (L.prev
      ? ` · last half of ${L.prevTitle}, the seam, then ${titleOf(L.shot)}` : ` · ${titleOf(L.shot)}`);
  } else {
    band.hidden = true;
    note.hidden = true;
  }
  $("jump").textContent = "Jump to " + (L ? titleOf(L.shot) : titleOf(reviewShot()));
  $("jump").disabled = !has || !L;
  $("loop").setAttribute("aria-pressed", S.loop && !!L);
  $("loop").disabled = !has || !L;
  const hasFile = !!(lo && lo.video);
  // Open output folder always works (local only): the latest video, else the clips folder
  for (const el of document.querySelectorAll('[data-which="output"]')) {
    el.removeAttribute("disabled");
    el.title = "Open Approved_Clips with the Shot in focus selected (before any export: " +
      (hasFile ? "the latest video)" : "the clips folder)");
  }
  $("download").toggleAttribute("disabled", !hasFile);
  $("download").hidden = S.local || !hasFile;
  layoutTL();
  applyVolume();
  renderLiveToggle();
  syncLive();
  if (S.focus !== TLV.focus) { TLV.focus = S.focus; if (S.focus) tlReveal(S.focus); }
  updateTime();
}

function renderDecision() {
  const el = $("decision");
  if (!P()) return;
  if (deferIfHeld("decision")) return;
  const errBox = S.error ? `<div class="err" role="alert"><span>${esc(S.error)}</span>
      <button class="icon x" data-action="dismiss-error" aria-label="Dismiss">${CROSS}</button></div>` : "";
  const b = busyHere() ? S.busy : null;
  if (b) {
    const pct = progressOf(b);
    const label = b.phase === "queued" ? b.label + " · waiting in ComfyUI's queue"
      : b.phase === "saving" ? b.label + " · decoding & saving" : b.label;
    el.innerHTML = `${errBox}<div class="busy-top"><span>${esc(label)}</span><span class="mono muted">${pct}%</span></div>
      <div class="bar"><div style="width:${pct}%"></div></div>
      <div class="busy-foot"><span class="busy-note">${esc(b.note + etaOf(b))}</span>
      <button class="stop" data-action="stop">Stop</button></div>`;
    layoutStage();
    return;
  }
  const rv = reviewShot(), nx = nextToRender(), lo = last();
  let line;
  if (rv && nx) line = `Happy with ${titleOf(rv)}? Continue approves it and renders ${titleOf(nx)}.`;
  else if (rv && renderedAfter(rv).length) line = `Happy with this take of ${titleOf(rv)}? Approve keeps it; the Shots after it are unchanged.`;
  else if (rv) line = `${titleOf(rv)} is the last shot. Approve it to finish the chain.`;
  else if (nx && numOf(nx.id) === 1 && !active().some((s) => s.status === "approved")) {
    line = nx.was_approved ? "A shared change needs every shot rendered again. Render Shot 1 to start."
      : "Render Shot 1 to start. Each Continue approves the shot you're reviewing and renders the next.";
  } else if (nx && nx.cleared) line = `${titleOf(nx)} was cleared. Render it${pinnedNote(nx) ? ` (${pinnedNote(nx)})` : ""}, or press its ▶ to render it on its own.`;
  else if (nx && nx.edit_from) line = `${titleOf(nx)} was edited. Render it, or change it back exactly to keep its take.`;
  else if (nx && nx.standalone && !pinnedNote(nx)) line = `${titleOf(nx)} renders on its own first, so the Shot before it can bridge into it.`;
  else if (nx && nx.standalone) line = `${titleOf(nx)} is standalone. Render it pinned to the Shots around it, or on its own again.`;
  else if (nx && lastRowFor(nx.id)) line = `${titleOf(nx)} needs rendering again — it or a shot before it changed.`;
  else if (nx) line = `${titleOf(nx)} is next. Render it when you're ready.`;
  else if (active().length) line = "All shots approved. Add a shot to keep going.";
  else line = "Add a shot to start.";
  if (rv && rv.was_approved) line += " (You approved it before the shared change.)";
  const thr = throughTarget();
  if (thr && rv) line = `Happy with ${titleOf(rv)}? Continue renders ${titleOf(nx)}, or re-render through ${titleOf(thr)} to bring back your kept takes.`;
  else if (thr) line += ` Or re-render through ${titleOf(thr)} in one go: kept takes re-render with their seeds.`;
  const missing = missingRefs();
  if (missing.length) line = `${missing.length} reference${missing.length > 1 ? "s are" : " is"} missing — relink or bypass ${missing.length > 1 ? "them" : "it"}.`;
  const allDone = !rv && !nx && active().length > 0;
  const vsrOk = !S.opts || !S.opts.nodes || S.opts.nodes.RTXVideoSuperResolution !== false;
  const fin = finalState();
  if (allDone) {
    line = fin ? `All shots approved. Final video saved: ${fin.video.filename}`
      : vsrOk ? "All shots approved. Upscale the final video, or add a shot to keep going."
        : "All shots approved. Install ComfyUI-NVIDIA-RTX-VSR-Pro to upscale the final video.";
  }
  const v = P().settings.rtx_vsr;
  // the timeline shows every take; the exact stitched video is Update preview's
  // (under the timeline) or the final's job, so it never blocks the next step
  const stale = !nx && previewStale() && !vsrOk;
  if (stale && !rv) line = "The timeline changed since the last preview. Update it: every Shot loads its take, nothing is sampled.";
  // [ ✓ Approve 25% ][ main action 50% ][ ⟳ Reroll 25% ]
  let mainLabel, mainAction, mainOff = false;
  const reviews = active().filter((s) => s.status === "review");
  if (rv && reviews.length > 1) {
    // several Shots rendered at once (Render all / Render odd Shots): review them one by one
    if (!missing.length) line = `${reviews.length} Shots to review. Happy with ${titleOf(rv)}? Approve it and go on to ${titleOf(reviews.find((x) => x !== rv))}.`;
    mainLabel = `✓ Approve & review ${titleOf(reviews.find((x) => x !== rv))}`;
    mainAction = "approve-next";
  } else if (rv && nx) { mainLabel = `✓ Approve & render ${titleOf(nx)}`; mainAction = "primary"; }
  else if (rv && stale) { mainLabel = "✓ Approve & update preview"; mainAction = "primary"; }
  else if (rv && vsrOk) { mainLabel = `✓ Approve & upscale final (${v.scale}×)`; mainAction = "approve-final"; }
  else if (rv) { mainLabel = "✓ Approve & finish"; mainAction = "primary"; }
  else if (nx) { mainLabel = "▶ Render " + titleOf(nx) + (nx.standalone && !pinnedNote(nx) ? " on its own" : ""); mainAction = "primary"; }
  else if (stale) { mainLabel = "▶ Update preview"; mainAction = "primary"; }
  else if (allDone && vsrOk) { mainLabel = `⤢ Upscale final video (${v.scale}× ${v.quality})${fin ? " again" : ""}`; mainAction = "final"; }
  else { mainLabel = "All done"; mainAction = "primary"; mainOff = true; }
  const off = missing.length > 0;
  const nxJob = nx && jobFor(nx.id), rvJob = rv && jobFor(rv.id);
  if (nxJob && mainAction === "primary") {
    if (!rv) line = `${titleOf(nx)} is in the queue (${nxJob.state === "running" ? "rendering" : "#" + jobPos(nxJob)}).`;
    if (mainAction === "primary" && nx) mainOff = true;
  }
  if (rvJob) line = `${titleOf(rv)} has more takes in the queue (${rvJob.state === "running" ? "rendering" : "#" + jobPos(rvJob)}). Review them when they're done.`;
  if (mainAction === "final" && Q.jobs.some((j) => liveJob(j) && j.slug === P().slug && j.spec.type === "final")) mainOff = true;
  if (S.conn !== "ok") line = "ComfyUI isn't connected. Renders you start wait in the queue until it's back.";
  const sub = [rv ? takeNav(rv) : "",
    thr ? `<button class="ghost sm through" data-action="render-through"${off ? " disabled" : ""}>⟳ Re-render through ${esc(titleOf(thr))}</button>` : ""].filter(Boolean).join("");
  el.innerHTML = `${errBox}<div class="dec-line">${esc(line)}</div>
    <div class="dec-row3">
      <button class="ghost approve" data-action="approve" title="Approve ${esc(titleOf(rv))} without rendering anything"${!rv || off ? " disabled" : ""}>✓ Approve</button>
      <button class="primary go" data-action="${mainAction}"${mainOff || off ? " disabled" : ""}>${esc(mainLabel)}</button>
      <button class="ghost" data-action="reroll" title="Reroll ${esc(titleOf(rv))}"${!rv || off || rvJob ? " disabled" : ""}>⟳ Reroll</button>
    </div>${sub ? `<div class="dec-sub">${sub}</div>` : ""}`;
  layoutStage();
}

/** After a reroll of an earlier Shot (or a shared change), the kept takes that
 *  follow the next Shot can re-render in one queue. Returns the last of that
 *  run, when it's more than just the next Shot. */
function throughTarget() {
  const act = active(), nx = nextToRender();
  if (!nx || nx.standalone) return null;
  let i = act.indexOf(nx), lastKept = null;
  // stops before a standalone Shot: it renders on its own, not continued
  while (i < act.length && act[i].status === "queued" && (act[i].was_approved || act[i].was_rendered) &&
         !act[i].standalone) lastKept = act[i++];
  return lastKept && act.indexOf(lastKept) > act.indexOf(nx) ? lastKept : null;
}

// 0.9.1: one route. The song goes into every Shot as <Audio 1>, a reference audio like
// the native Reference to Video node's; the sound of the video is H3's own. (Lip sync
// to song and Song in final video are off until they're reworked.)
const ROUTES = [["song_ref", "Song as <Audio 1>", "each Shot gets the part of the song under it as reference audio; H3 lip-syncs to it", "reference"],
  ["final_override", "Song in final video", "the song replaces H3's sound in clips, previews and exports", "output"]];

function switchHTML(on, attrs, sm) {
  return `<button class="switch${sm ? " sm" : ""}" role="switch" aria-checked="${!!on}" ${attrs}><span></span></button>`;
}

// Audio preview: plays input/<file> from Start for Length, like the render's trim.
const PLAY_ICON = '<svg width="12" height="12" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true"><path d="M3 2l9 5-9 5z"/></svg>';
const STOP_ICON = '<svg width="12" height="12" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true"><rect x="3" y="3" width="8" height="8" rx="1"/></svg>';
const preview = { el: new Audio(), src: "", start: 0, end: Infinity, raf: null, on: false };
preview.el.preload = "none";
const previewing = () => preview.on;

function apLabel() {
  const el = preview.el;
  const total = isFinite(preview.end) ? preview.end - preview.start
    : (isFinite(el.duration) ? el.duration - preview.start : 0);
  return `${fmt(el.currentTime - preview.start)} / ${total ? fmt(total) : "—"}`;
}

function stopPreview() {
  if (!preview.on) return;
  preview.on = false;
  if (!preview.el.ended && preview.el.currentTime < preview.end) SCRUB.pos = preview.el.currentTime;
  preview.el.pause();
  cancelAnimationFrame(preview.raf);
  if (P()) renderAudio();
}

function previewTick() {
  if (!preview.on) return;
  const el = preview.el;
  if (el.currentTime >= preview.end || el.ended) { SCRUB.pos = preview.start; stopPreview(); return; }
  if (!SCRUB.drag) SCRUB.pos = el.currentTime;
  const t = $("ap-time");
  if (t) t.textContent = apLabel();
  updateScrub();
  preview.raf = requestAnimationFrame(previewTick);
}

function startPreview() {
  const a = P().audio;
  if (!a.file || audioMissing()) return;
  const el = preview.el;
  const src = songSrc();
  if (preview.src !== src) { el.src = src; preview.src = src; }
  const r = scrubRange();
  preview.start = r.a;
  preview.end = isFinite(r.b) ? r.b : Infinity;
  let from = scrubPos();
  if (isFinite(r.b) && from >= r.b - 0.05) from = r.a;      // at the end: from the top
  SCRUB.pos = from;
  if (PL.playing) pausePlayer();
  el.volume = video.volume;
  preview.on = true;
  renderAudio();
  const go = () => {
    if (!preview.on) return;
    if (isFinite(el.duration) && preview.start >= el.duration) {
      toast(`Start (${preview.start}s) is past the end of the file (${el.duration.toFixed(1)}s).`);
      stopPreview();
      return;
    }
    el.currentTime = from;
    el.play().then(() => { preview.raf = requestAnimationFrame(previewTick); })
      .catch((err) => { if (preview.on) { toast("Couldn't play the audio: " + err.message); stopPreview(); } });
  };
  if (el.readyState >= 1) go();
  else {
    el.preload = "auto";
    el.addEventListener("loadedmetadata", go, { once: true });
    el.addEventListener("error", () => { if (preview.on) { toast("Couldn't load the audio file."); stopPreview(); } }, { once: true });
    el.load();
  }
}

// ---------------------------------------------------------------------------
// Phrase markers (0.11.0): where singing starts after a pause, in seconds into the
// song file. Press M while the song plays (or with the scrub bar focused) to mark
// one; drag a marker to move it, double-click to delete it. Detect suggests them
// from the full mix (the centre channel in the voice range). A Shot card's
// "Start on the next phrase" moves the Shot onto the next one.
// ---------------------------------------------------------------------------

const PH = { drag: null };

function phrases() { return (P() && P().audio.phrases) || []; }

function setPhrases(list) {
  const a = P().audio;
  a.phrases = [...new Set(list.map((t) => Math.round(Math.max(0, t) * FPS) / FPS))].sort((x, y) => x - y);
  commit();
}

function markPhrase(t) {
  const at = t !== undefined ? t : previewing() ? preview.el.currentTime : scrubPos();
  if (!P().audio.file) return;
  if (phrases().some((x) => Math.abs(x - at) < 0.1)) { toast("There's a marker there already."); return; }
  setPhrases([...phrases(), at]);
  toast(`Phrase marked at ${fmtSong(at)} (${phrases().length} in all).`);
}

function drawPhraseMarks() {
  const bar = $("ascrub");
  if (!bar) return;
  bar.querySelectorAll(".ph-mark").forEach((x) => x.remove());
  const r = scrubRange();
  if (!isFinite(r.b) || r.b <= r.a) return;
  phrases().forEach((t, i) => {
    if (t < r.a || t > r.b) return;
    const m = document.createElement("div");
    m.className = "ph-mark";
    m.dataset.ph = String(i);
    m.style.left = ((t - r.a) / (r.b - r.a) * 100) + "%";
    m.title = `Phrase at ${fmtSong(t)} · drag to move, double-click to delete`;
    bar.appendChild(m);
  });
}

document.addEventListener("pointerdown", (e) => {
  const m = e.target.closest && e.target.closest(".ph-mark");
  if (!m || e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  PH.drag = { i: Number(m.dataset.ph), el: m };
}, true);
document.addEventListener("pointermove", (e) => {
  if (!PH.drag) return;
  const bar = $("ascrub"), r = scrubRange();
  if (!bar || !isFinite(r.b)) return;
  const box = bar.getBoundingClientRect();
  const t = r.a + (r.b - r.a) * Math.max(0, Math.min(1, (e.clientX - box.left) / box.width));
  PH.drag.t = t;
  PH.drag.el.style.left = ((t - r.a) / (r.b - r.a) * 100) + "%";
  trimReadout(e.clientX, e.clientY, fmtSong(t));
});
document.addEventListener("pointerup", () => {
  const d = PH.drag;
  if (!d) return;
  PH.drag = null;
  $("tl-readout").hidden = true;
  if (d.t === undefined) return;
  const list = phrases().slice();
  list[d.i] = d.t;
  setPhrases(list);
});
document.addEventListener("dblclick", (e) => {
  const m = e.target.closest && e.target.closest(".ph-mark");
  if (!m) return;
  const list = phrases().slice();
  list.splice(Number(m.dataset.ph), 1);
  setPhrases(list);
});

async function detectPhrases() {
  const a = P().audio;
  if (!a.file || audioMissing()) return;
  if (phrases().length && !confirm(`Replace the ${phrases().length} phrase marker${phrases().length === 1 ? "" : "s"} with detected ones?`)) return;
  S.detecting = true;
  renderAudio();
  try {
    const r = await api("/longshot/phrases", { method: "POST", body: { file: a.file, subfolder: a.subfolder || "",
      min_gap: a.phrase_gap, sensitivity: a.phrase_sens } });
    setPhrases(r.phrases || []);
    toast(r.phrases && r.phrases.length ? `${r.phrases.length} phrases found. Check them on the scrub bar: drag to move, double-click to delete, M to add.`
      : "No clear phrase starts found. Lower Min pause or raise Sensitivity, or mark them with M.");
  } catch (e) { toast("Couldn't detect phrases: " + e.message); }
  finally { S.detecting = false; renderAudio(); }
}

function phraseHTML(a) {
  const ok = a.file && !audioMissing(), n = phrases().length;
  return `<div class="ph-row">
      <span class="small"><b>Phrases</b> <span class="muted">${n ? `${n} marked` : "none yet"} · M marks one while the song plays</span></span>
      <span class="ph-btns">
        <button class="ghost sm" data-action="phrase-mark"${ok ? "" : " disabled"} title="Mark a phrase at the playhead (M while the song plays)">+ Mark</button>
        <button class="ghost sm" data-action="phrase-detect"${ok && !S.detecting ? "" : " disabled"} title="Suggest phrase starts from the song (the centre channel in the voice range)">${S.detecting ? "Detecting…" : "Detect"}</button>
        <button class="ghost sm" data-action="phrase-clear"${n ? "" : " disabled"}>Clear</button>
      </span>
    </div>
    <div class="shot-opts ph-opts">
      <label class="lbl-row" title="How long the singing has to stop before the next start counts as a new phrase">Min pause <input type="number" min="0.1" max="3" step="0.1" data-audio="phrase_gap" value="${esc(a.phrase_gap)}" style="width:64px"> s</label>
      <label class="lbl-row" title="Higher finds quieter phrase starts (and more false ones)">Sensitivity <input type="range" min="0" max="1" step="0.05" data-audio="phrase_sens" value="${esc(a.phrase_sens)}" style="width:90px"></label>
      <label class="lbl-row" title="Start on the next phrase starts the Shot this many frames before the word">Lead-in <input type="number" min="0" max="48" step="1" data-audio="phrase_lead" value="${esc(a.phrase_lead)}" style="width:56px"> frames</label>
    </div>`;
}

// ---------------------------------------------------------------------------
// Align to song (0.11.0): decode a take's own audio (H3's performance of the song),
// compare it with the song where the take sits, and move the take by the difference.
// ---------------------------------------------------------------------------

/** Where a Shot's take starts in the song now (seconds), and how long it is. */
function takeSongPlace(s) {
  const L = LAYOUT.byId[s.id];
  if (!L) return null;
  return { at: songStart() + (L.ws + effEdit(s).shift) / LAYOUT.fps, seconds: (L.we - L.ws) / LAYOUT.fps };
}

async function checkAlign(s) {
  if (!s || !s.take || !isRendered(s)) return;
  if (!P().audio.file || audioMissing()) { toast("Choose the song in the Audio panel first."); return; }
  if (S.busy || S.chunking || S.queuing) { toast("ComfyUI is busy: check the sync when the queue is done."); return; }
  const place = takeSongPlace(s);
  if (!place) { toast("One moment: working out where the Shots sit…"); return; }
  await runNow({ kind: "align", takeAudio: { take: s.take }, extra: { sid: s.id, take: s.take, at: place.at, seconds: place.seconds },
    label: `Checking ${titleOf(s)} against the song`, note: "Its own audio decoded · nothing is sampled", onDone: () => {} });
}

async function alignDone(b, outputs) {
  const x = b.extra || {}, sh = shotById(x.sid);
  const wav = ((outputs[b.built.nodes.audio] || {}).longshot_audio || [])[0];
  if (!sh || !wav) { S.error = "The take's audio wasn't saved. Update H3 Long Shot."; return; }
  try {
    const a = P().audio;
    const r = await api("/longshot/align", { method: "POST", body: { audio: { filename: wav.filename, subfolder: wav.subfolder || "" },
      song: { file: a.file, subfolder: a.subfolder || "" }, at: x.at, seconds: x.seconds } });
    sh.align = { take: x.take, at: x.at, offset: r.offset, conf: r.confidence };
    scheduleSave();
    if (r.offset === null || r.confidence < 1.15) toast(`${titleOf(sh)}: no clear match with the song (too little singing to compare?).`);
  } catch (e) { toast("Couldn't compare with the song: " + e.message); }
}

function alignTag(s) {
  if (!isRendered(s) || !s.take || s.kind === "clip") return "";
  const al = s.align, place = takeSongPlace(s);
  const fresh = al && al.take === s.take && place && Math.abs(al.at - place.at) < 0.5 / FPS;
  if (!fresh) return ` · <span class="linkbtn" role="button" tabindex="0" data-action="align-check" title="Compare this take's own singing with the song where it sits (its audio is decoded; nothing is sampled)">check sync</span>`;
  if (al.offset === null || al.conf < 1.15) return ` · <span class="muted" title="Too little singing to compare, or it doesn't match the song here">no clear match</span>`;
  const f = Math.round(al.offset * FPS);
  if (!f) return ` · <span class="sync-ok" title="Its singing lines up with the song">in sync ✓</span>`;
  const run = runOf(s);
  return ` · <span class="sync-off">sung ${Math.abs(al.offset).toFixed(2)} s ${al.offset > 0 ? "early" : "late"}</span> ` +
    `<span class="linkbtn" role="button" tabindex="0" data-action="align-apply" title="Move ${run.length > 1 ? "its whole run" : "it"} ${Math.abs(f)} frames ${f > 0 ? "later" : "earlier"} so its singing sits on the song (the empty Shot before it makes room)">align</span>`;
}

function applyAlign(s) {
  const al = s && s.align;
  if (!al || al.offset === null) return;
  const f = Math.round(al.offset * FPS), first = runOf(s)[0];
  const before = filmSpan(first);
  moveShot(first, f);
  const after = filmSpan(first);
  if (before && after && after.a !== before.a) {
    const moved = after.a - before.a;
    al.at += moved / FPS;
    al.offset -= moved / FPS;
    scheduleSave();
    renderShots();
  }
}

/** On a Shot card: "▸ next phrase" (and, for a rendered Shot, Align to song). */
function phraseTag(s) {
  if (!songOn() || isEmptyShot(s)) return "";
  let h = "";
  if (phrases().length && runOf(s)[0] === s && nextPhraseFrame(s) !== null) {
    h += ` · <span class="linkbtn" role="button" tabindex="0" data-action="phrase-next" title="Move this Shot so it starts on the next phrase marker (the empty Shot before it makes room)">▸ next phrase</span>`;
  }
  return h;
}

/** 0.12.7: "1056×608" on a Shot made at another size than Settings make now. */
function sizeTag(s) {
  if (!otherSize(s)) return "";
  const t = takeSize(s), cur = sizeOf(P().settings);
  return ` · <span class="size-tag" title="Made at ${sizeText(t)}; Settings make ${cur[0]}×${cur[1]} now. Shots of another size aren't pinned to it (a hard cut there), and the film can't be stitched until every Shot is one size. Export approved clips works.">${sizeText(t)}</span>`;
}

/** 0.12.5: "aligned ✓": the user lined this Shot up with the song by hand. It's for the
 *  take (or clip) it has now; a new take needs lining up again. */
const alignKey = (s) => s.kind === "clip" ? (s.clip && s.clip.file) || "" : s.take || "";
const isAligned = (s) => !!(s && s.aligned && isRendered(s) && alignKey(s) && s.aligned.key === alignKey(s));
function alignedTag(s) {
  if (!isRendered(s) || isEmptyShot(s)) return "";
  return isAligned(s)
    ? ` · <span class="aligned-btn on" role="button" tabindex="0" data-action="aligned" aria-pressed="true" title="Lined up with the song: Alt + ← / → won't move it. Click to unmark.">aligned ✓</span>`
    : ` · <span class="aligned-btn" role="button" tabindex="0" data-action="aligned" aria-pressed="false" title="Mark this Shot as lined up with the song (it then stays put)">aligned</span>`;
}

/** The next phrase after a Shot's start on the film, as a film frame (null: none). */
function nextPhraseFrame(s) {
  const sp = filmSpan(s);
  if (!sp) return null;
  const lead = Number(P().audio.phrase_lead) || 0, st = songStart();
  for (const t of phrases()) {
    const f = Math.round((t - st) * FPS) - lead;
    if (f > sp.a) return f;
  }
  return null;
}

/** Start on the next phrase: move the Shot (its run) so it starts on the next marker. */
function startOnPhrase(s) {
  const f = nextPhraseFrame(s), sp = filmSpan(s);
  if (f === null || !sp) { toast(phrases().length ? "No phrase marker after this Shot's start." : "Mark the phrases first (Audio panel: M while the song plays, or Detect)."); return; }
  const run = runOf(s);
  if (run[0] !== s) { toast(`${titleOf(s)} continues from the Shot before; move the first Shot of the run.`); return; }
  moveShot(s, f - sp.a);
}

// ---------------------------------------------------------------------------
// Audio scrub bar (0.9.1): the song from Start for Length (both 0: the whole song),
// with its waveform. Click or drag to move the playhead; Play plays from there.
// Set start / Set end put Start or the end (Length) at the playhead.
// ---------------------------------------------------------------------------

const SCRUB = { pos: null, dur: null, peaks: null, src: "", drag: false, loading: false };

function scrubSrc() {
  const a = P().audio;
  return a.file ? viewURL({ filename: a.file, subfolder: a.subfolder || "", type: "input" }) : "";
}

/** The stretch the bar shows: Start → Start + Length (Length 0: to the end of the song). */
function scrubRange() {
  const a = P().audio;
  const start = Math.max(0, Number(a.start) || 0), len = Math.max(0, Number(a.length) || 0);
  const dur = SCRUB.dur || (isFinite(preview.el.duration) ? preview.el.duration : null);
  const b = len ? start + len : (dur || Infinity);
  return { a: start, b: dur ? Math.min(b, Math.max(dur, start)) : b, dur };
}

function scrubPos() {
  const r = scrubRange();
  const p = SCRUB.pos == null ? r.a : SCRUB.pos;
  return Math.max(r.a, isFinite(r.b) ? Math.min(p, r.b) : p);
}

/** Load the song once: its length and a waveform (peaks over the whole song). */
function ensureScrub() {
  const src = scrubSrc();
  if (!src || audioMissing() || SCRUB.src === src) return;
  Object.assign(SCRUB, { src, dur: null, peaks: null, pos: null, loading: true });
  const Ctx = window.AudioContext || window.webkitAudioContext;
  fetch(src).then((r) => { if (!r.ok) throw new Error(r.status); return r.arrayBuffer(); })
    .then((buf) => new Promise((res, rej) => {
      const ctx = new Ctx();
      ctx.decodeAudioData(buf, (d) => { ctx.close(); res(d); }, (e) => { ctx.close(); rej(e); });
    }))
    .then((d) => {
      if (SCRUB.src !== src) return;
      const n = 4000, ch = [];
      for (let c = 0; c < Math.min(2, d.numberOfChannels); c++) ch.push(d.getChannelData(c));
      const step = Math.max(1, Math.floor(d.length / n)), peaks = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        let m = 0;
        const from = i * step, to = Math.min(d.length, from + step);
        for (const data of ch) for (let j = from; j < to; j += 8) { const v = Math.abs(data[j]); if (v > m) m = v; }
        peaks[i] = m;
      }
      SCRUB.dur = d.duration;
      SCRUB.peaks = peaks;
    })
    .catch(() => {
      // no waveform: the length comes from the player instead
      const el = preview.el;
      if (preview.src !== src) { el.src = src; preview.src = src; }
      el.preload = "metadata";
      el.addEventListener("loadedmetadata", () => { if (SCRUB.src === src) { SCRUB.dur = el.duration; drawScrub(); } },
        { once: true });
      el.load();
    })
    .finally(() => { if (SCRUB.src === src) { SCRUB.loading = false; drawScrub(); } });
}

function drawScrub() {
  const cv = $("ascrub-wave");
  if (!cv) return;
  const w = cv.clientWidth, h = cv.clientHeight, dpr = window.devicePixelRatio || 1;
  cv.width = Math.max(1, Math.round(w * dpr));
  cv.height = Math.max(1, Math.round(h * dpr));
  const g = cv.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  const r = scrubRange();
  if (SCRUB.peaks && SCRUB.dur && isFinite(r.b) && r.b > r.a) {
    const n = SCRUB.peaks.length, col = getComputedStyle(cv).color;
    g.fillStyle = col;
    for (let x = 0; x < w; x++) {
      const t0 = r.a + (r.b - r.a) * x / w, t1 = r.a + (r.b - r.a) * (x + 1) / w;
      const i0 = Math.floor(t0 / SCRUB.dur * n), i1 = Math.max(i0 + 1, Math.ceil(t1 / SCRUB.dur * n));
      let m = 0;
      for (let i = i0; i < i1 && i < n; i++) if (SCRUB.peaks[i] > m) m = SCRUB.peaks[i];
      const bh = Math.max(1, m * (h - 4));
      g.fillRect(x, (h - bh) / 2, 1, bh);
    }
  }
  updateScrub();
}

function updateScrub() {
  const bar = $("ascrub");
  if (!bar) return;
  const r = scrubRange(), pos = scrubPos(), span = isFinite(r.b) ? r.b - r.a : 0;
  const f = span > 0 ? Math.max(0, Math.min(1, (pos - r.a) / span)) : 0;
  $("ascrub-head").style.left = (f * 100) + "%";
  $("ascrub-fill").style.width = (f * 100) + "%";
  bar.setAttribute("aria-valuemin", r.a.toFixed(2));
  bar.setAttribute("aria-valuemax", isFinite(r.b) ? r.b.toFixed(2) : r.a.toFixed(2));
  bar.setAttribute("aria-valuenow", pos.toFixed(2));
  bar.setAttribute("aria-valuetext", `${fmtSong(pos)} in the song`);
  $("ascrub-a").textContent = fmtSong(r.a);
  $("ascrub-b").textContent = isFinite(r.b) ? fmtSong(r.b) : (SCRUB.loading ? "loading…" : "—");
  $("ascrub-pos").textContent = `${fmtSong(pos)} in the song · ${(pos - r.a).toFixed(2)} s after Start`;
  drawPhraseMarks();
}

function scrubTo(t) {
  const r = scrubRange();
  SCRUB.pos = Math.max(r.a, isFinite(r.b) ? Math.min(t, r.b) : t);
  if (preview.on) preview.el.currentTime = SCRUB.pos;
  updateScrub();
}

function scrubFromX(e) {
  const bar = $("ascrub"), r = scrubRange();
  if (!bar || !isFinite(r.b)) return;
  const box = bar.getBoundingClientRect();
  scrubTo(r.a + (r.b - r.a) * Math.max(0, Math.min(1, (e.clientX - box.left) / box.width)));
}

/** Set start / Set end: Start, or the end (Length), at the playhead. */
function scrubSet(which) {
  if (setupGuard()) return;
  const a = P().audio, pos = toFrame(scrubPos());
  const len = Math.max(0, Number(a.length) || 0), end = len ? (Number(a.start) || 0) + len : null;
  if (which === "start") {
    a.start = pos;
    if (end != null) a.length = end > pos + 0.05 ? toFrame(end - pos) : 0;
    SCRUB.pos = pos;
  } else {
    if (pos <= (Number(a.start) || 0) + 0.05) { toast("Move the playhead after Start first."); return; }
    a.length = toFrame(pos - (Number(a.start) || 0));
    SCRUB.pos = null;
  }
  stopPreview();
  S.dry = null;
  commit();
}

document.addEventListener("pointerdown", (e) => {
  const bar = e.target.closest && e.target.closest("#ascrub");
  if (!bar || e.button !== 0) return;
  e.preventDefault();
  bar.focus();
  SCRUB.drag = true;
  scrubFromX(e);
});
/** 0.12.2: the Audio panel is selected after a click in it, until a click anywhere else;
 *  then Space plays / pauses the song only. */
let audioSel = false;
const audioSelected = () => audioSel && !!$("audio-panel");
document.addEventListener("pointerdown", (e) => {
  const inside = !!(e.target.closest && e.target.closest("#audio-panel"));
  if (inside === audioSel) return;
  audioSel = inside;
  $("audio-panel").classList.toggle("selected", inside);
}, true);
document.addEventListener("pointermove", (e) => { if (SCRUB.drag) scrubFromX(e); });
document.addEventListener("pointerup", () => { SCRUB.drag = false; });
document.addEventListener("keydown", (e) => {
  if (!e.target.closest || !e.target.closest("#ascrub")) return;
  const step = e.shiftKey ? 1 : 0.1, r = scrubRange();
  let t = null;
  if (e.key === "ArrowLeft" || e.key === "ArrowDown") t = scrubPos() - step;
  else if (e.key === "ArrowRight" || e.key === "ArrowUp") t = scrubPos() + step;
  else if (e.key === "Home") t = r.a;
  else if (e.key === "End" && isFinite(r.b)) t = r.b;
  else if (e.key === " " || e.key === "Enter") { previewing() ? stopPreview() : startPreview(); }
  else return;
  e.preventDefault();
  e.stopImmediatePropagation();                     // not the video player too
  e.stopPropagation();
  if (t != null) scrubTo(t);
}, true);
window.addEventListener("resize", () => { if ($("ascrub-wave")) drawScrub(); });

function scrubHTML(a) {
  const ok = a.file && !audioMissing();
  return `<div class="ascrub-row">
      <div class="ascrub-col">
        <div class="ascrub${ok ? "" : " off"}" id="ascrub" role="slider" tabindex="${ok ? 0 : -1}" aria-label="Song playhead"
          title="Click or drag to move the playhead. ← / → 0.1 s (Shift: 1 s), Space plays from here">
          <canvas id="ascrub-wave" aria-hidden="true"></canvas>
          <div class="ascrub-fill" id="ascrub-fill"></div><div class="ascrub-head" id="ascrub-head"></div>
        </div>
        <div class="ascrub-times mono muted small"><span id="ascrub-a"></span><span id="ascrub-b"></span></div>
      </div>
      <button class="ghost sm" data-action="audio-set-start"${ok ? "" : " disabled"} title="Start the song here (the end stays put)">Set start</button>
      <button class="ghost sm" data-action="audio-set-end"${ok ? "" : " disabled"} title="End the song here: sets Length">Set end</button>
    </div>
    <div class="mono small" id="ascrub-pos" aria-live="off"></div>`;
}


video.addEventListener("volumechange", () => { preview.el.volume = video.volume; });

function renderAudio() {
  const a = P().audio;
  const on = [songRefOn() ? "song as <Audio 1>" : "", a.file && a.final_override ? "song in final" : ""].filter(Boolean);
  $("audio-summary").textContent = on.length ? "On: " + on.join(" · ") : "Off · generated audio only";
  $("audio-chev").textContent = S.audioOpen ? "Hide ▴" : "Show ▾";
  $("audio").hidden = !S.audioOpen;
  if (!S.audioOpen) { stopPreview(); return; }
  $("audio").innerHTML = `<div class="note-ref2v" role="note"><b>Lip sync:</b> the ref2va model finds where the singing starts by itself. With fl2va, start each singing Shot on a sung word: it sings from the Shot's first frame. Phrase markers and “Start on the next phrase” help with that; “Align to song” lines up a take afterwards.</div>
    <div style="margin-top:12px">
      <div class="lbl">Audio file <span class="muted small">· drop a song anywhere on this panel</span>
        <div class="pick"><select class="field" data-relink="audio" aria-label="Audio file">${inputOptions("audio", a.subfolder, a.file, "No audio")}</select>
          <button class="ghost sm browse" data-action="pick-audio"${S.uploading.audio ? " disabled" : ""}>${S.uploading.audio ? "Uploading…" : "Upload…"}</button></div></div>
      ${audioMissing() ? `<div class="err" style="margin-top:8px"><span>Missing: ${esc(a.original_name || a.file)}. Renders run without the song until you pick the file again.</span></div>`
        : S.refState.audio === "changed" ? '<div class="warnbox" style="margin-top:8px"><span>The audio file changed since it was saved.</span></div>' : ""}
      <div class="shot-opts" style="margin-top:10px">
        <label class="lbl-row" title="Where the film's 0:00 sits in the song. Each Shot rendered from now on gets the part of the song under it.">Start <input class="field mono" type="text" inputmode="decimal" spellcheck="false" data-audio="start" value="${esc((Number(a.start) || 0).toFixed(2))}" style="width:80px" aria-label="Start in seconds"> s</label>
        <label class="lbl-row" title="How much of the song the scrub bar and Play cover (0: to the end). Renders cut each Shot's own part.">Length <input class="field mono" type="text" inputmode="decimal" spellcheck="false" data-audio="length" value="${esc((Number(a.length) || 0).toFixed(2))}" style="width:80px" aria-label="Length in seconds"> s</label>
        <button class="ghost sm audio-play" data-action="audio-preview" aria-pressed="${previewing()}"${a.file && !audioMissing() ? "" : " disabled"}
          title="${a.file ? "Play the clip the render will use: from Start, for Length (0 = to the end)" : "Choose an audio file first"}"
          aria-label="${previewing() ? "Stop audio preview" : "Play audio preview"}">${previewing() ? STOP_ICON : PLAY_ICON}<span>${previewing() ? "Stop" : "Play"}</span></button>
        <span class="mono muted small" id="ap-time">${previewing() ? apLabel() : ""}</span>
      </div>
      ${scrubHTML(a)}
      ${phraseHTML(a)}
      <div style="display:flex;flex-direction:column;gap:2px;margin-top:14px">
      ${ROUTES.map(([k, t, r, badge]) => `<div class="route">${switchHTML(a[k], `data-action="audio-route" data-key="${k}" aria-label="${esc(t)}"`)}
        <span class="route-text"><b>${esc(t)}</b><i>${esc(r)}</i></span><span class="badge">${badge}</span></div>`).join("")}
      ${a.song_ref ? `<div class="muted small" style="margin-top:4px">The Studio adds “audio reuse” to the summary and this retention line: <span class="mono">&lt;Audio 1&gt; (the song): fully_copy</span>. Each Shot's card shows ♪ where it sits in the song.</div>` : ""}
      <div class="shot-opts" style="margin-top:10px">
        <label class="lbl-row" title="H3 sings a little late? Each Shot's song slice starts this many frames later in the song, so the singing lands on time. Negative: earlier. For Shots rendered from now on.">Sync nudge <input class="field" type="number" step="1" min="-240" max="240" data-audio="sync_nudge" value="${esc(Number(a.sync_nudge) || 0)}" style="width:72px"> frames</label>
      </div>
      </div>
      ${a.voice_ref ? `<div style="margin-top:10px">${modelField("Vocal separation model (MelBand RoFormer)", "diffusion_models", "melband",
        `<select data-melband aria-label="Vocal separation model">${fileOptions((S.opts || {}).melband, a.melband_model, "Choose…")}</select>`)}</div>` : ""}<div class="muted small" style="margin-top:8px">Pick from audio files in ComfyUI's input folder, or this project's input/longshot/${esc(P().slug)} folder.</div></div>`;
  ensureScrub();
  requestAnimationFrame(drawScrub);
}

function sizeOf(s) {
  const sizes = S.opts ? S.opts.sizes : null;
  const key = Number(s.megapixels).toString() + "|" + s.aspect;
  return sizes && sizes[key] ? sizes[key] : null;
}

function select(attrs, list, current, blank) {
  return `<select ${attrs}>${fileOptions(list, current, blank)}</select>`;
}

const even = (x) => 2 * Math.round(x / 2);

/** ComfyUI holds every frame in RAM as float32, before and after the upscale. */
function vsrRamNote(size, scale) {
  const secs = filmSeconds(), frames = Math.round(secs * FPS);
  const per = size[0] * size[1] * 3 * 4 / 1024 ** 3;                    // GB per decoded frame (float32)
  // One decoded copy of the film (ComfyUI keeps it between chunks); the upscale
  // then works a frame at a time next to it (Long Shot 1.6.5).
  const gb = per * frames + 1;
  const f = (x) => x < 10 ? x.toFixed(1) : Math.round(x);
  return `Needs about ${f(gb)} GB of system RAM (the decoded ${secs.toFixed(0)} s film); ` +
    `the ${scale}× upscale adds little, a frame at a time.`;
}

function browseBtn(kind, target, disabled) {
  return `<button class="ghost sm browse" data-action="browse-model" data-kind="${kind}" data-target="${esc(target)}"` +
    ` title="Find the file, or add the folder it's in"${disabled ? " disabled" : ""}>Browse…</button>`;
}

const OPT_LIST = { diffusion_models: "models", text_encoders: "clips", vae: "vaes", loras: "loras" };

/** True when a chosen model file isn't among ComfyUI's files on this machine. */
function modelMissing(kind, target) {
  if (!S.opts) return false;
  const v = currentFor(target);
  return !!v && !matchModel(v, S.opts[target === "melband" ? "melband" : OPT_LIST[kind]]);
}

function modelField(label, kind, target, selectHTML) {
  const miss = modelMissing(kind, target);
  return `<div class="lbl" data-model-field="${esc(target)}">${esc(label)}${miss ? ' <span class="missing small">· not found on this machine</span>' : ""}` +
    `<div class="pick${miss ? " missing-file" : ""}">${selectHTML}${browseBtn(kind, target)}</div></div>`;
}

function renderSettings() {
  const s = P().settings, o = S.opts || {};
  const vsr = s.rtx_vsr;
  const vsrOk = !S.opts || !S.opts.nodes || S.opts.nodes.RTXVideoSuperResolution !== false;
  const vsrFold = folded("vsr");
  const size = sizeOf(s);
  const t = s.turbo;
  $("settings-summary").textContent = S.settingsOpen ? "" : [`seed ${s.seed}`,
    `${s.steps} steps`, size ? `${size[0]}×${size[1]}` : `${s.megapixels} MP ${s.aspect}`,
    vsr.on && vsrOk ? `RTX ${vsr.scale}×` : ""].filter(Boolean).join(" · ");
  $("settings-chev").textContent = S.settingsOpen ? "Hide ▴" : "Show ▾";
  $("settings-toggle").setAttribute("aria-expanded", String(!!S.settingsOpen));
  $("settings").hidden = !S.settingsOpen;
  if (!S.settingsOpen) return;
  const t2 = s.turbo;
  const warn = !t2.on && s.steps < 20 ? `<div class="warnbox" role="alert" style="margin-top:12px">
      <span style="flex:1">Turbo is off (Advanced) and steps are at ${esc(s.steps)}. Without Turbo, H3 needs about 20 steps or more. Expect a soft, unfinished result.</span>
      <button class="ghost sm" data-action="steps20">Set 20 steps</button></div>` : "";
  const mp = (o.megapixels || [0.4, 0.6, 0.9, 1.2]).map((m) =>
    `<option value="${m}"${Number(m) === Number(s.megapixels) ? " selected" : ""}>${m} MP</option>`).join("");
  const asp = (o.aspects || ["16:9"]).map((a) => `<option${a === s.aspect ? " selected" : ""}>${a}</option>`).join("");
  $("settings").innerHTML = `
    <div class="seed-row">
      <label class="lbl">Seed <span class="seed-field"><input class="mono" data-base-seed inputmode="numeric" value="${esc(s.seed)}" aria-describedby="seed-help" title="Drag left / right to change it (Shift: by 10), or click and type">${seedStepHTML("base-seed-step", false, "Shots on auto follow it")}</span></label>
      <label class="lbl seed-mode" title="Increment: the seed goes up by one for every Shot rendered, like ComfyUI's control after generate. Fixed: it stays.">Seed mode
        <select data-set="seed_mode" aria-label="Seed mode"><option value="increment"${s.seed_mode !== "same" ? " selected" : ""}>Increment</option><option value="same"${s.seed_mode === "same" ? " selected" : ""}>Fixed</option></select></label>
      <button class="ghost sm reset-seeds" data-action="reset-seeds"${P().shots.some((x) => x.kind !== "clip" && Number(x.shot_seed) >= 0) ? "" : " disabled"}
        title="Put the Shots' own seeds back to auto, so they follow this seed again">Reset Shot seeds</button>
      <label class="lbl multi-take" title="Each render runs this many times, each with a new seed, like ComfyUI's batch count. The Shot shows take 1 afterwards; flip through the rest with ◀ ▶ on the timeline.">Multi-take
        <input type="number" min="1" max="${MULTI_MAX}" step="1" data-multi value="${esc(multiTakes())}"></label>
      <span class="muted small" id="seed-help">${s.seed_mode === "same" ? "Fixed: every Shot on auto renders with this seed. Reroll and Multi-take still pick new ones."
  : "Increment: the next seed. Each Shot that renders (Render, Reroll, Multi-take…) takes it and it goes up by one."}</span>
    </div>
    <div class="grid3">
      <label class="lbl">Steps <input type="number" min="1" max="200" data-set="steps" data-num value="${esc(s.steps)}"></label>
      <label class="lbl">Resolution <select data-set="megapixels" data-num>${mp}</select></label>
      <label class="lbl">Aspect <select data-set="aspect">${asp}</select></label>
    </div>${warn}
    <div class="size-out">${size ? `→ ${size[0]} × ${size[1]} output` : "→ size unknown"}${size && vsr.on && vsrOk
      ? ` · <span class="vsr-size">${even(size[0] * vsr.scale)} × ${even(size[1] * vsr.scale)} after RTX Super Resolution</span>` : ""}</div>
    <div class="vsr-row vsr-zone${vsr.on && vsrOk ? "" : " off"}${vsrFold ? " folded" : ""}">
      ${switchHTML(vsr.on && vsrOk, `data-action="vsr-on" aria-label="RTX Super Resolution"${vsrOk ? "" : " disabled"}`, true)}
      <button class="fold vsr-fold" data-action="fold" data-fold="vsr" aria-expanded="${!vsrFold}"
        title="${vsrFold ? "Show the upscale settings" : "Show only the switch"}"><span class="fold-ch" aria-hidden="true">▾</span>RTX Super Resolution${vsrFold && vsr.on && vsrOk ? ` <span class="muted small">· ${vsr.scale}× ${esc(vsr.quality)}</span>` : ""}</button>
      <div class="vsr-text"><div>Upscale previews</div>
        <div class="muted small">${!vsrOk ? installBtn("rtx", "(needs an RTX GPU)")
          : vsr.on ? "Every render is upscaled (slower as the chain grows). Never re-renders Shots."
            : "Off: previews stay fast. Upscale final video (when every Shot is approved) always upscales with this scale and quality."}</div>
        ${vsrOk && size ? `<div class="muted small">${vsrRamNote(size, vsr.scale)}</div>` : ""}</div>
      <label class="lbl-row">Scale <select data-vsr="scale"${vsrOk ? "" : " disabled"}>${[1.5, 2].map((x) =>
        `<option value="${x}"${Number(vsr.scale) === x ? " selected" : ""}>${x}×</option>`).join("")}</select></label>
      <label class="lbl-row">Quality <select data-vsr="quality"${vsrOk ? "" : " disabled"}>${["LOW", "MEDIUM", "HIGH", "ULTRA"].map((q) =>
        `<option${vsr.quality === q ? " selected" : ""}>${q}</option>`).join("")}</select></label>
      <label class="lbl-row" title="The upscale is saved in pieces of this many seconds, counted in the status line, then joined. RAM use doesn't depend on it.">Chunks <input type="number" min="2" max="600" step="1" data-vsr="chunk_s" value="${esc(vsrChunkS())}"${vsrOk ? "" : " disabled"} style="width:64px"> s</label>
    </div>
    <label class="check-row prores-row${vsrOk ? "" : " off"}"><input type="checkbox" data-outfile="prores_master"${s.prores_master ? " checked" : ""}${vsrOk ? "" : " disabled"}>
      <span>Final video: also save a ProRes master <span class="muted small">· 10-bit ProRes 422 HQ .mov with sound, next to the upscaled MP4 (large files)</span></span></label>
    <div class="live-q-row"><span>Live preview quality <span class="muted small">· ${o.preview_decoder
      ? "sharp (taeh3 decoder installed)" : "rough colours"}</span></span>${o.preview_decoder ? ""
      : `<button class="install-btn" data-action="install-preview">Install better-quality preview</button><span class="muted small">downloads the taeh3 decoder (22 MB) into models/vae_approx</span>`}</div>
    ${P().shots.some((x) => x.kind === "clip" && !x.bypassed) ? `<div class="vsr-row${s.clip_pixels ? "" : " off"}">
      ${switchHTML(!!s.clip_pixels, 'data-action="clip-pixels" aria-label="Original clip pixels in the final video"', true)}
      <div class="vsr-text"><div>Final video: original clip pixels</div>
        <div class="muted small">${s.clip_pixels ? "Upscale final video puts each clip's original frames back: sharper clips, with a possible faint seam at their edges."
          : "Off: clips come out of the decoder like everything else (seamless joins, slightly softer clips)."}</div></div></div>` : ""}
    <div style="margin-top:14px"><div class="muted small" style="margin-bottom:6px">Reference image size</div>
      <div class="seg" role="group" aria-label="Reference image size">
        <button data-action="ref-size" data-v="match" aria-pressed="${s.ref_image_size === "match"}">Match · lighter on VRAM</button>
        <button data-action="ref-size" data-v="max" aria-pressed="${s.ref_image_size === "max"}">Max · best identity</button>
      </div></div>
    <div class="out-files">
      <div class="muted small">Videos are saved in output/longshot/${esc(P().slug)}/videos.</div>
    </div>
    <div class="seg-store">
      <span class="grow">Saved takes: ${S.segStats ? `${S.segStats.files} file${S.segStats.files === 1 ? "" : "s"} · ${(S.segStats.bytes / 1048576).toFixed(1)} MB` : "—"}
        <span class="muted"> · output/longshot/${esc(P().slug)}/takes</span></span>
      <button class="ghost sm local-only" data-action="clear-segments"${S.segStats && S.segStats.files ? "" : " disabled"}>Delete all takes</button>
    </div>`;
}

/** Sampler, scheduler, overlap… — its own section under Settings. */
// ---------------------------------------------------------------------------
// Refine (0.10.0): resample each take with a second model, e.g. the sharper fl2va
// model over takes made with ref2va (for lip sync). Long Shot does it right after a
// Shot is sampled (the refined take is the take), or only for exports. Takes made
// with the refine model itself are never refined.
// ---------------------------------------------------------------------------

function lsAtLeast(...want) {
  const v = String((S.opts || {}).longshot_version || "0").split(".").map(Number);
  for (let i = 0; i < want.length; i++) { if ((v[i] || 0) !== want[i]) return (v[i] || 0) > want[i]; }
  return true;
}
const shortModel = (m) => (m || "").split(/[\\/]/).pop().replace(/\.(safetensors|gguf|ckpt|pt)$/i, "");

/** The refine pass applies: on, a model chosen that isn't the render model, Long Shot 1.7.0+. */
function refineActive() {
  const s = P() && P().settings, r = s && s.refine;
  return !!(r && r.on && r.model && r.model !== s.model && lsAtLeast(1, 7, 0));
}

/** The model a Shot's current take was made with (null: unknown, an older take). */
function takeModel(s) {
  const t = (S.takes[s.id] || []).find((x) => x.name === s.take);
  return (t && t.model) || s.render_model || null;
}

function renderRefine() {
  const s = P().settings, r = s.refine, o = S.opts || {}, t = r.turbo;
  const rendered = active().filter((x) => x.kind !== "clip" && x.take && isRendered(x));
  const todo = rendered.filter((x) => takeModel(x) !== r.model);
  $("refine-summary").textContent = !r.on ? "Off" : !r.model ? "On · choose a model"
    : `On · ${shortModel(r.model)} · ${r.steps} steps · denoise ${Number(r.denoise).toFixed(2)}${r.export_only ? " · on export" : ""}`;
  $("refine-chev").textContent = S.refineOpen ? "Hide ▴" : "Show ▾";
  $("refine-toggle").setAttribute("aria-expanded", String(!!S.refineOpen));
  $("refine").hidden = !S.refineOpen;
  if (!S.refineOpen) return;
  let note;
  if (!lsAtLeast(1, 7, 0)) note = "Update H3 Long Shot to 1.7.0 or later for the refine pass.";
  else if (r.model && r.model === s.model) note = "That's the render model: nothing to refine. Choose the other model.";
  else if (!r.model) note = "Choose the model that refines, e.g. the fl2va model when you render with ref2va.";
  else if (r.export_only) note = `Renders stay as they are. Export approved clips and Upscale final refine ${todo.length} of ${rendered.length} rendered take${rendered.length === 1 ? "" : "s"} (takes made with ${esc(shortModel(r.model))} are left as they are); refined takes are kept for the next export.`;
  else note = `Each new take is refined right after it's sampled, and that's the take you review. Takes made with ${esc(shortModel(r.model))} are left as they are. Export and Upscale final also refine older takes still unrefined.`;
  const dis = r.on ? "" : " disabled";
  $("refine").innerHTML = `
    <div class="route" style="margin-top:12px">${switchHTML(r.on, 'data-action="refine-on" aria-label="Refine"')}
      <span class="route-text"><b>Refine each take</b><i>resample it with a second model, e.g. fl2va over ref2va for a sharper picture</i></span></div>
    <div class="route">${switchHTML(r.export_only, `data-action="refine-export" aria-label="Refine on export only"${dis}`)}
      <span class="route-text"><b>Refine on export only</b><i>renders stay quick; Export approved clips and Upscale final refine</i></span></div>
    <div class="model-files" style="margin-top:10px">
      ${modelField("Refine model", "diffusion_models", "refine_model", `<select data-refine="model" aria-label="Refine model"${dis}>${fileOptions(o.models, r.model, "Choose a model…")}</select>`)}
    </div>
    <div class="grid3" style="margin-top:10px">
      <label class="lbl">Steps <input type="number" min="1" max="200" step="1" data-refine="steps" value="${esc(r.steps)}"${dis}></label>
      <label class="lbl" title="How much of each take is redrawn: lower keeps the motion and lip timing, higher lets the refine model change more">Denoise <input type="number" min="0.05" max="1" step="0.05" data-refine="denoise" value="${esc(r.denoise)}"${dis}></label>
      <label class="lbl" title="ModelSamplingMiniMaxH3 for the refine model. Lower (3–5) makes the same denoise a lighter touch">Video shift <input type="number" min="0.5" max="100" step="0.5" data-refine="shift_video" value="${esc(r.shift_video)}"${dis}></label>
    </div>
    <div class="box" style="margin-top:10px">
      <div class="box-row">
        ${switchHTML(t.on, `data-action="refine-turbo-on" aria-label="Refine Turbo LoRA"${dis}`)}
        <div style="flex:1;min-width:140px"><div>Turbo LoRA (refine model)</div>
          <div class="pick" style="margin-top:4px"><select data-refine="turbo.lora" aria-label="Refine Turbo LoRA file"${t.on && r.on ? "" : " disabled"}>${fileOptions(o.loras, t.lora, "Choose…")}</select></div></div>
        <label class="strength" style="flex:1 1 180px">Strength
          <input type="range" min="0" max="2" step="0.05" data-refine="turbo.strength" value="${esc(t.strength)}"${t.on && r.on ? "" : " disabled"}><output>${Number(t.strength).toFixed(2)}</output></label>
      </div>
    </div>
    <div class="muted small" style="margin-top:10px">${note}</div>`;
}

// ---------------------------------------------------------------------------
// Face refine (0.14.0, Long Shot 1.8.0): faces too small to come out well are
// redrawn by H3 as steady close-ups (the fl2va model by default) and blended back
// in, on Export approved clips and Upscale final video. "Try on this Shot" makes
// one take's version for the A/B viewer; each Shot can keep its original faces.
// ---------------------------------------------------------------------------

/** Face refine applies: on, a model chosen, Long Shot 1.8.0 with its node, the detector there. */
function faceActive() {
  const f = P() && P().settings.face, o = S.opts || {};
  return !!(f && f.on && f.model && lsAtLeast(1, 8, 0) && !(o.nodes && o.nodes.MiniMaxH3FaceRefine === false)
    && o.face_detector !== false);
}
function faceNodeReady() {
  const o = S.opts || {};
  return lsAtLeast(1, 8, 0) && !(o.nodes && o.nodes.MiniMaxH3FaceRefine === false);
}
const isFl2va = (m) => /fl2v/i.test(m || "");
/** The fl2va model in ComfyUI's list (the default redraw model), or null. */
const fl2vaModel = () => ((S.opts || {}).models || []).find((m) => isFl2va(m)) || null;

function hash36(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
/** What a face-refined result depends on (settings, prompt, identity picture). */
function faceSig() {
  const s = P().settings, f = s.face, t = f.turbo;
  const who = faceIdentity();
  return hash36(JSON.stringify([f.model, f.steps, f.denoise, f.shift_video, t.on ? [t.lora, t.strength] : 0,
    f.max_face, f.which, f.work, f.padding, f.follow, f.mask, f.feather, f.color, f.hold_audio, f.seed,
    (f.describe || "").trim(), who ? [who.image, who.subfolder, who.label] : 0, s.clip, s.video_vae,
    s.shift_audio, s.scheduler, s.sampler]));
}
/** The Cast member whose picture is the face's identity (only with a ref2va model). */
function faceIdentity() {
  const f = P().settings.face;
  if (!f.cast || isFl2va(f.model)) return null;
  return (P().cast || []).find((c) => c.id === f.cast && c.image && !c.bypassed) || null;
}
const faceKey = (s) => s && s.take ? takeStem(s.take) + "__face" : null;
/** 0.15.0: the Shot is set to Refined and has a refined clip of its current take. */
const faceRefined = (s) => !!(s && s.take && s.face && s.face.keep === "refined" && s.face.take === s.take &&
  S.clips[faceKey(s)]);
const faceKeepsOriginal = (s) => !faceRefined(s);
/** A refined clip of the Shot's current take exists (so it can be set to Refined). */
const faceHasClip = (s) => !!(s && s.take && s.face && s.face.take === s.take && S.clips[faceKey(s)]);
/** The Shot the panel talks about: the one in the viewer, else the one in review. */
function faceShot() {
  const pick = (id) => { const s = id && shotById(id); return s && !s.bypassed && s.kind !== "clip" && s.take && isRendered(s) ? s : null; };
  return pick(S.focus) || pick(S.open) || pick((reviewShot() || {}).id) ||
    active().find((x) => x.kind !== "clip" && x.take && isRendered(x)) || null;
}

/** A take's faces, in render pixels: [{size, cx, cy, w, hh, px}] biggest first (null: unknown). */
function faceSizes(s) {
  const r = s && s.take ? S.faceScan[takeStem(s.take)] : undefined;
  if (!r || typeof r !== "object") return r === null ? [] : null;
  const size = sizeOf(P().settings), h = (size && size[1]) || r.h;
  return (r.faces || []).map((x) => Object.assign({}, x, { px: Math.round(x.size * h / (r.h || h)) }));
}
const smallFaces = (s) => (faceSizes(s) || []).filter((x) => x.px < Number(P().settings.face.max_face || 150));

/** Look for faces in the rendered Shots' clips (CPU, a few seconds each), a few at a time. */
async function faceScanMore() {
  if (S.faceScanning || !P() || !S.faceOpen || !(S.opts || {}).face_detector || !faceNodeReady()) return;
  const keys = active().filter((x) => x.kind !== "clip" && x.take && isRendered(x) && S.clips[takeStem(x.take)]
    && S.faceScan[takeStem(x.take)] === undefined).map((x) => takeStem(x.take)).slice(0, 4);
  if (!keys.length) return;
  S.faceScanning = true;
  const slug = P().slug;
  keys.forEach((k) => { S.faceScan[k] = "pending"; });
  try {
    const r = await api(`/longshot/faces/${encodeURIComponent(slug)}`, { method: "POST", body: { keys } });
    if (P() && P().slug === slug) for (const k of keys) S.faceScan[k] = r[k] === undefined ? null : r[k];
  } catch (e) {
    keys.forEach((k) => { if (S.faceScan[k] === "pending") delete S.faceScan[k]; });
    if (P() && P().slug === slug) S.faceScanError = e.message;
  } finally { S.faceScanning = false; }
  if (P() && P().slug === slug) { renderFace(); setTimeout(faceScanMore, 50); }
}

async function installFaceDetector() {
  const page = "https://pypi.org/project/facenet-pytorch/2.6.0/";
  if (!S.local) {
    showModal("Face detector", "", `<p>On the machine running ComfyUI, open H3 Long Shot Studio there and download it, or get
      facenet_pytorch-2.6.0's wheel from <a href="${page}" target="_blank" rel="noopener">${page}</a> and copy
      <code>pnet.pt</code>, <code>rnet.pt</code> and <code>onet.pt</code> from its <code>facenet_pytorch/data</code> folder into
      <code>ComfyUI/models/facedetect/mtcnn</code>.</p>`);
    return;
  }
  const ok = await confirmBox({ title: "Download the face detector?",
    body: "Downloads the facenet-pytorch package from PyPI (1.9 MB) and keeps only its three MTCNN face detector files " +
      "(MIT licence) in ComfyUI's models/facedetect/mtcnn folder. Nothing is installed into Python. No restart needed.",
    yes: "Download", no: "Cancel" });
  if (!ok) return;
  toast("Downloading the face detector…");
  try { await api("/longshot/install-face-detector", { method: "POST" }); }
  catch (e) { showModal("Face detector", "", `<p>${esc(e.message)}</p>`); return; }
  try { S.opts = await api("/longshot/options"); } catch (e) { /* keep */ }
  toast("Face detector installed.");
  renderFace();
  faceScanMore();
}

function renderFaceSummary() { if (P()) $("face-summary").textContent = faceSummaryText(); }

function faceSummaryText() {
  const f = P().settings.face;
  if (!f.on) return "Off";
  if (!f.model) return "On · choose a model";
  const n = active().filter(faceRefined).length;
  return `On · ${shortModel(f.model)} · under ${f.max_face} px · denoise ${Number(f.denoise).toFixed(2)}` +
    ` · ${n ? `${n} Shot${n === 1 ? "" : "s"} refined` : "no Shot refined yet"}`;
}

function renderFace() {
  if (!P()) return;
  const s = P().settings, f = s.face, o = S.opts || {}, t = f.turbo;
  $("face-summary").textContent = faceSummaryText();
  $("face-chev").textContent = S.faceOpen ? "Hide ▴" : "Show ▾";
  $("face-toggle").setAttribute("aria-expanded", String(!!S.faceOpen));
  $("face").hidden = !S.faceOpen;
  if (!S.faceOpen) return;
  setTimeout(faceScanMore, 0);
  if (!faceNodeReady()) {
    $("face").innerHTML = `<div class="muted small" style="margin-top:12px">Update H3 Long Shot to 1.8.0 or later (and restart ComfyUI) for Face refine.</div>`;
    return;
  }
  const dis = f.on ? "" : " disabled";
  const detector = o.face_detector ? "" : `<div class="box face-get">
      <div class="box-row"><div style="flex:1;min-width:200px"><div>The face detector isn't installed</div>
        <div class="muted small">MTCNN, about 2 MB, into models/facedetect/mtcnn. It finds and follows the faces.</div></div>
      <button class="ghost sm" data-action="face-detector">Download face detector</button></div></div>`;
  const castOpts = (P().cast || []).filter((c) => c.image && !c.bypassed)
    .map((c) => `<option value="${esc(c.id)}"${f.cast === c.id ? " selected" : ""}>${esc(c.label || "Cast member")}</option>`).join("");
  const fl = isFl2va(f.model);
  const advOpen = !folded("face-adv");
  const modelOpen = !folded("face-model");
  const rendered = active().filter((x) => x.kind !== "clip" && x.take && isRendered(x));
  const known = rendered.filter((x) => Array.isArray(faceSizes(x)));
  const withSmall = known.filter((x) => smallFaces(x).length);
  const pending = rendered.filter((x) => S.faceScan[takeStem(x.take)] === "pending" ||
    (S.clips[takeStem(x.take)] && S.faceScan[takeStem(x.take)] === undefined)).length;
  const noClip = rendered.filter((x) => !S.clips[takeStem(x.take)]).length;
  let film = "";
  if (o.face_detector && rendered.length) {
    film = `Small faces in <b>${withSmall.length}</b> of ${known.length} Shot${known.length === 1 ? "" : "s"} looked at` +
      (pending ? ` · looking at ${pending} more` : "") + (noClip ? ` · ${noClip} without a clip yet` : "") + (pending ? "…" : ".");
  }
  const refinedNow = active().filter(faceRefined);
  const refinedList = refinedNow.length ? `<div class="muted small" style="margin-top:8px">Exporting refined: ${refinedNow.map((x) => esc(titleOf(x))).join(", ")}</div>` : "";
  const sh = faceShot();
  let shotHTML = "";
  if (sh) {
    const sizes = faceSizes(sh), small = smallFaces(sh), fk = faceKey(sh);
    const have = faceHasClip(sh), old = !!(fk && S.clips[fk]) && !have;
    const stale = have && sh.face.sig !== faceSig();
    let faces;
    if (!o.face_detector) faces = "Install the face detector to look for faces.";
    else if (!S.clips[takeStem(sh.take)]) faces = "No clip of this take yet (Make missing clips under the timeline).";
    else if (sizes === null) faces = "Looking for faces…";
    else if (!sizes.length) faces = "No faces found.";
    else faces = `${sizes.length} face${sizes.length === 1 ? "" : "s"} · ` + sizes.slice(0, 4).map((x) =>
      `<span class="${x.px < f.max_face ? "face-small" : ""}">${x.px} px</span>`).join(", ") +
      (small.length ? ` · ${small.length} to redraw` : " · none under the size");
    const keep = faceRefined(sh) ? "refined" : "original";
    const busy = Q.jobs.some((j) => liveJob(j) && j.slug === P().slug && j.spec.type === "face" && j.spec.target === sh.id);
    shotHTML = `<div class="box face-shot">
      <div class="box-row"><label class="face-pick"><span class="muted small">Shot</span>
        <select data-face-shot aria-label="Shot to try Face refine on">${rendered.map((x) =>
          `<option value="${esc(x.id)}"${x.id === sh.id ? " selected" : ""}>${esc(titleOf(x))}${smallFaces(x).length ? " · small face" : ""}</option>`).join("")}</select></label>
        <span class="muted small">${faces}</span></div>
      ${have ? `<div class="muted small" style="margin-top:6px">Refined: ${sh.face.treated || 0} face${sh.face.treated === 1 ? "" : "s"} redrawn${sh.face.cached ? " (kept from before)" : ""}.${stale ? " Made with other settings than these: Refine again to use them." : ""}</div>`
        : old ? `<div class="muted small" style="margin-top:6px">⚠ The refined version was made from an older take. Refine this Shot again.</div>` : ""}
      <div class="box-row" style="margin-top:10px">
        <button class="ghost sm" data-action="face-try" data-shot="${esc(sh.id)}"${f.on && f.model && o.face_detector && !busy ? "" : " disabled"}>${busy ? "In the queue…" : have ? "Refine again" : "Refine this Shot"}</button>
        <button class="ghost sm" data-action="face-ab" data-shot="${esc(sh.id)}"${have && S.clips[takeStem(sh.take)] ? "" : " disabled"}>Compare A/B</button>
        <span class="push muted small">Export uses</span>
        <div class="seg seg-sm" role="group" aria-label="Which version this Shot exports">
          <button data-action="face-keep" data-v="refined" data-shot="${esc(sh.id)}" aria-pressed="${keep === "refined"}"${have ? "" : ' disabled title="Refine this Shot first"'}>Refined</button>
          <button data-action="face-keep" data-v="original" data-shot="${esc(sh.id)}" aria-pressed="${keep === "original"}">Original</button>
        </div>
      </div></div>`;
  }
  $("face").innerHTML = `${detector}
    <div class="route" style="margin-top:12px">${switchHTML(f.on, 'data-action="face-on" aria-label="Face refine"')}
      <span class="route-text"><b>Redraw small faces</b><i>refine the Shots you choose: H3 redraws each small face as a steady close-up and blends it back in</i></span></div>
    ${shotHTML}
    ${refinedList}
    <div class="box face-card" style="margin-top:12px">
      <button class="fold" data-action="fold" data-fold="face-model" aria-expanded="${modelOpen}">
        <span>Face model and faces${modelOpen ? "" : `<span class="muted small"> · ${esc(f.model ? shortModel(f.model) : "no model")} · ${esc(f.steps)} steps · denoise ${Number(f.denoise).toFixed(2)} · under ${esc(f.max_face)} px</span>`}</span>
        <span class="muted chev">${modelOpen ? "Hide ▴" : "Show ▾"}</span></button>
      ${modelOpen ? `<div class="model-files" style="margin-top:10px">
      ${modelField("Face model", "diffusion_models", "face_model", `<select data-face="model" aria-label="Face refine model"${dis}>${fileOptions(o.models, f.model, "Choose a model…")}</select>`)}
    </div>
    <div class="grid3" style="margin-top:10px">
      <label class="lbl">Steps <input type="number" min="1" max="200" step="1" data-face="steps" value="${esc(f.steps)}"${dis}></label>
      <label class="lbl" title="How much of the face is redrawn: lower keeps the expression and mouth closer to the take, higher draws more new detail">Denoise <input type="number" min="0.05" max="1" step="0.05" data-face="denoise" value="${esc(f.denoise)}"${dis}></label>
      <label class="lbl" title="ModelSamplingMiniMaxH3 for the face model. Lower (3–5) makes the same denoise a lighter touch">Video shift <input type="number" min="0.5" max="100" step="0.5" data-face="shift_video" value="${esc(f.shift_video)}"${dis}></label>
    </div>
    <div class="box" style="margin-top:10px">
      <div class="box-row">
        ${switchHTML(t.on, `data-action="face-turbo-on" aria-label="Face refine Turbo LoRA"${dis}`)}
        <div style="flex:1;min-width:140px"><div>Turbo LoRA (face model)</div>
          <div class="pick" style="margin-top:4px"><select data-face="turbo.lora" aria-label="Face refine Turbo LoRA file"${t.on && f.on ? "" : " disabled"}>${fileOptions(o.loras, t.lora, "Choose…")}</select></div></div>
        <label class="strength" style="flex:1 1 180px">Strength
          <input type="range" min="0" max="2" step="0.05" data-face="turbo.strength" value="${esc(t.strength)}"${t.on && f.on ? "" : " disabled"}><output>${Number(t.strength).toFixed(2)}</output></label>
      </div>
    </div>
    <div class="grid2" style="margin-top:12px">
      <label class="lbl" title="Faces shorter than this, in pixels of the render, are redrawn; bigger ones are left alone">Redraw faces under (px)
        <input type="number" min="16" max="2000" step="10" data-face="max_face" value="${esc(f.max_face)}"${dis}></label>
      <div class="lbl">Which faces
        <div class="seg" role="group" aria-label="Which faces">
          <button data-action="face-which" data-v="all" aria-pressed="${f.which !== "largest"}"${dis}>All small faces</button>
          <button data-action="face-which" data-v="largest" aria-pressed="${f.which === "largest"}"${dis}>Largest only</button>
        </div></div>
    </div>
    <div class="grid2" style="margin-top:12px">
      <label class="lbl" title="${fl ? "The fl2va model takes no reference pictures: the face keeps the identity it has in the take" : "The ref2va model gets this Cast picture as the face's identity (<Picture 1>)"}">Identity picture${fl ? " (ref2va only)" : ""}
        <select data-face="cast"${f.on && !fl ? "" : " disabled"}><option value="">None · keep the take's face</option>${castOpts}</select></label>
      <label class="lbl" title="Added to the close-up's prompt, e.g. a young woman with freckles and red lipstick">Describe the face (optional)
        <input type="text" data-face="describe" value="${esc(f.describe || "")}" placeholder="e.g. a young woman with freckles"${dis}></label>
    </div>` : ""}
    </div>
    <div class="box" style="margin-top:12px">
      <button class="fold" data-action="fold" data-fold="face-adv" aria-expanded="${advOpen}">
        <span>Close-up and blending</span><span class="muted chev">${advOpen ? "Hide ▴" : "Show ▾"}</span></button>
      ${advOpen ? `<div class="grid3">
        <label class="lbl" title="The close-up's size while H3 redraws it (square). Bigger: more detail, slower">Close-up size
          <select data-face="work"${dis}>${[512, 640, 768, 896, 1024].map((v) => `<option value="${v}"${Number(f.work) === v ? " selected" : ""}>${v} px</option>`).join("")}</select></label>
        <label class="lbl" title="Room around the face on each side, as a share of its size (0.8: the close-up is 2.6× the face)">Room around the face
          <input type="number" min="0.2" max="3" step="0.1" data-face="padding" value="${esc(f.padding)}"${dis}></label>
        <label class="lbl" title="Auto: the crop follows a face that moves, and stays put for one that doesn't">Crop
          <select data-face="follow"${dis}>${[["auto", "Auto"], ["fixed", "Fixed"], ["follow", "Follows the face"]].map(([v, l]) => `<option value="${v}"${f.follow === v ? " selected" : ""}>${l}</option>`).join("")}</select></label>
        <label class="lbl" title="How much of the face area is blended in (1: brow to chin, a little of the hair line)">Mask size
          <input type="number" min="0.5" max="2.5" step="0.05" data-face="mask" value="${esc(f.mask)}"${dis}></label>
        <label class="lbl" title="How softly the redrawn face fades into the picture">Feather
          <input type="number" min="0.02" max="1" step="0.02" data-face="feather" value="${esc(f.feather)}"${dis}></label>
        <label class="lbl" title="Brings the redrawn face's broad colour and shading back to the take's, keeping its new detail">Colour match
          <input type="number" min="0" max="1" step="0.1" data-face="color" value="${esc(f.color)}"${dis}></label>
        <label class="lbl">Seed <input type="number" min="0" step="1" data-face="seed" value="${esc(f.seed)}"${dis}></label>
      </div>
      <div class="route" style="margin-top:6px">${switchHTML(f.hold_audio, `data-action="face-hold" aria-label="Hold the Shot's sound"${dis}`)}
        <span class="route-text"><b>Hold the Shot's sound</b><i>the mouth is redrawn against the take's own sound (its timing stays)</i></span></div>` : ""}
    </div>
    ${film ? `<div class="muted small" style="margin-top:10px">${film}</div>` : ""}
    ${S.faceScanError ? `<div class="muted small" style="margin-top:6px">Couldn't look for faces: ${esc(S.faceScanError)}</div>` : ""}`;
}

/** Try on this Shot: its take decoded, faces refined, saved as its own clip. */
function faceTry(s) {
  if (!s || !s.take) return;
  if (!faceActive()) { toast(!(S.opts || {}).face_detector ? "Download the face detector first." : "Turn Redraw small faces on and choose the face model first."); return; }
  if (Q.jobs.some((j) => liveJob(j) && j.slug === P().slug && j.spec.type === "face" && j.spec.target === s.id)) {
    toast("This Shot is already in the queue to be refined."); return;
  }
  enqueue({ type: "face", target: s.id });
}

// ---------------------------------------------------------------------------
// A/B viewer (0.14.0): a Shot's take (A) against its face-refined version (B),
// played in sync: wipe, flip or side by side, frame steps, zoom to the face.
// ---------------------------------------------------------------------------

const AB = { shot: null, mode: "wipe", split: 50, flip: false, zoom: false, boxes: false, loop: true, raf: 0, held: false };

function openAB(s) {
  if (!s || !s.take) return;
  const a = takeStem(s.take), b = faceKey(s);
  if (!S.clips[a] || !faceHasClip(s)) { toast(!faceHasClip(s) ? "Refine this Shot first." : "This take has no clip yet."); return; }
  AB.shot = s.id;
  AB.flip = false;
  try { AB.mode = store("h3studio.abmode") || "wipe"; } catch (e) { /* default */ }
  if (!["wipe", "flip", "side"].includes(AB.mode)) AB.mode = "wipe";
  $("ab").hidden = false;
  renderAB(true);
  const btn = $("ab").querySelector(".ab-close");
  if (btn) btn.focus();
}

function closeAB() {
  cancelAnimationFrame(AB.raf);
  AB.raf = 0;
  for (const v of $("ab").querySelectorAll("video")) { try { v.pause(); } catch (e) { /* gone */ } }
  $("ab").hidden = true;
  $("ab").innerHTML = "";
  AB.shot = null;
}

const abVideos = () => [$("ab-a"), $("ab-b")];

/** The face to zoom to at time t: the biggest redrawn face's box (fractions of the picture). */
function abFaceAt(s, t) {
  const f = s.face || {};
  const tracks = f.tracks || [];
  if (!tracks.length || !f.w || !f.h) {
    const sz = faceSizes(s) || [];
    const x = smallFaces(s)[0] || sz[0];
    return x ? { cx: x.cx, cy: x.cy, hh: x.hh } : null;
  }
  const treated = new Set((f.crops || []).map((c) => c.track));
  const tr = tracks.filter((x) => treated.has(x.id)).sort((a, b) => b.size - a.size)[0] ||
    tracks.slice().sort((a, b) => b.size - a.size)[0];
  const rows = tr.boxes || [];
  if (!rows.length) return null;
  const fr = t * FPS;
  let k = rows.findIndex((r) => r[0] > fr);
  if (k < 0) k = rows.length;
  const r0 = rows[Math.max(0, k - 1)], r1 = rows[Math.min(rows.length - 1, k)];
  const u = r1[0] === r0[0] ? 0 : Math.max(0, Math.min(1, (fr - r0[0]) / (r1[0] - r0[0])));
  const lerp = (i) => r0[i] + (r1[i] - r0[i]) * u;
  return { cx: lerp(1) / f.w, cy: lerp(2) / f.h, hh: lerp(4) / f.h };
}

/** Boxes of every face at time t (fractions), for the overlay. */
function abBoxesAt(s, t) {
  const f = s.face || {};
  if (!f.w || !f.h) return [];
  const fr = t * FPS, treated = new Set((f.crops || []).map((c) => c.track));
  const out = [];
  for (const tr of f.tracks || []) {
    const rows = tr.boxes || [];
    if (!rows.length || fr < rows[0][0] - 2 || fr > rows[rows.length - 1][0] + 4) continue;
    let best = rows[0];
    for (const r of rows) if (Math.abs(r[0] - fr) < Math.abs(best[0] - fr)) best = r;
    out.push({ x: (best[1] - best[3] / 2) / f.w, y: (best[2] - best[4] / 2) / f.h, w: best[3] / f.w, h: best[4] / f.h,
      redrawn: treated.has(tr.id), size: Math.round(tr.size) });
  }
  return out;
}

function renderAB(fresh) {
  const s = AB.shot && shotById(AB.shot);
  if (!s || $("ab").hidden) return;
  const keep = faceKeepsOriginal(s) ? "original" : "refined";
  const a = takeStem(s.take), b = faceKey(s);
  const stale = s.face && s.face.sig !== faceSig();
  if (fresh) {
    $("ab").innerHTML = `<div class="ab-dialog">
      <div class="ab-head">
        <div class="ab-title"><h3 id="ab-title">${esc(titleOf(s))} · Face refine</h3>
          <span class="muted small">A: the take as it is · B: small faces redrawn${s.face && s.face.treated ? ` (${s.face.treated})` : ""} · Export approved clips uses the one you pick</span></div>
        <button class="ghost close ab-close" data-ab="close" aria-label="Close">
          <svg width="14" height="14" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M2.5 2.5l7 7M9.5 2.5l-7 7"/></svg></button>
      </div>
      <div class="ab-stage-wrap"><div class="ab-stage" id="ab-stage">
        <div class="ab-view ab-a"><div class="ab-zoom"><video id="ab-a" playsinline preload="auto" src="${esc(clipFile(a, ".mp4"))}"></video><svg class="ab-boxes" viewBox="0 0 1 1" preserveAspectRatio="none"></svg></div><span class="ab-tag">A · Original</span></div>
        <div class="ab-view ab-b"><div class="ab-zoom"><video id="ab-b" playsinline muted preload="auto" src="${esc(clipFile(b, ".mp4"))}"></video><svg class="ab-boxes" viewBox="0 0 1 1" preserveAspectRatio="none"></svg></div><span class="ab-tag">B · Refined</span></div>
        <div class="ab-divider" id="ab-divider" role="slider" tabindex="0" aria-label="Wipe position" aria-valuemin="0" aria-valuemax="100"></div>
      </div></div>
      <div class="ab-bar">
        <button class="ghost sm ab-play" data-ab="play" aria-label="Play">▶</button>
        <button class="ghost sm" data-ab="back" aria-label="One frame back" title="One frame back (←)">◀︎ 1f</button>
        <button class="ghost sm" data-ab="fwd" aria-label="One frame forward" title="One frame forward (→)">1f ▶︎</button>
        <input type="range" class="ab-scrub" id="ab-scrub" min="0" max="1000" step="1" value="0" aria-label="Position">
        <span class="mono small ab-time" id="ab-time">0.00 s · f 0</span>
      </div>
      <div class="ab-bar">
        <div class="seg seg-sm" role="group" aria-label="Compare">
          <button data-ab="mode" data-v="wipe">Wipe</button>
          <button data-ab="mode" data-v="flip">Flip</button>
          <button data-ab="mode" data-v="side">Side by side</button>
        </div>
        <button class="ghost sm" data-ab="swap" id="ab-swap" title="Show the other one (hold F)">Showing B</button>
        <button class="ghost sm" data-ab="zoom" id="ab-zoom-btn" title="Zoom to the face (Z)">Zoom to face</button>
        <button class="ghost sm" data-ab="boxes" id="ab-boxes-btn" title="Face boxes (B)">Face boxes</button>
        <button class="ghost sm" data-ab="loop" id="ab-loop" title="Loop">Loop</button>
        <span class="push muted small">Export uses</span>
        <div class="seg seg-sm" role="group" aria-label="Faces this Shot exports with">
          <button data-ab="keep" data-v="refined">Refined</button>
          <button data-ab="keep" data-v="original">Original</button>
        </div>
      </div>
      <div class="muted small ab-keys">${stale ? "B was made with other settings than the panel's now. " : ""}Space play · ← → one frame · hold F to flip · Z zoom · B boxes · Esc close</div>
    </div>`;
    const [va, vb] = abVideos();
    va.loop = vb.loop = AB.loop;
    va.addEventListener("loadedmetadata", () => { abFit(); abTick(); });
    va.addEventListener("seeked", () => { if (va.paused) vb.currentTime = va.currentTime; abTick(); });
    va.addEventListener("play", () => { vb.play().catch(() => {}); renderABState(); });
    va.addEventListener("pause", () => { vb.pause(); vb.currentTime = va.currentTime; renderABState(); });
    va.addEventListener("ended", () => { vb.pause(); renderABState(); });
    $("ab-scrub").addEventListener("input", (e) => {
      const d = va.duration || 0;
      if (d) { va.currentTime = (Number(e.target.value) / 1000) * d; vb.currentTime = va.currentTime; }
    });
    const stage = $("ab-stage");
    const setSplit = (ev) => {
      const r = stage.getBoundingClientRect();
      AB.split = Math.max(0, Math.min(100, ((ev.clientX - r.left) / Math.max(1, r.width)) * 100));
      abLayout();
    };
    stage.addEventListener("pointerdown", (ev) => {
      if (AB.mode !== "wipe" || ev.button !== 0) return;
      stage.setPointerCapture(ev.pointerId);
      setSplit(ev);
      const move = (e2) => setSplit(e2);
      const up = () => { stage.removeEventListener("pointermove", move); stage.removeEventListener("pointerup", up); };
      stage.addEventListener("pointermove", move);
      stage.addEventListener("pointerup", up);
    });
    $("ab-divider").addEventListener("keydown", (ev) => {
      if (ev.key === "ArrowLeft" || ev.key === "ArrowRight") {
        AB.split = Math.max(0, Math.min(100, AB.split + (ev.key === "ArrowLeft" ? -5 : 5)));
        abLayout();
        ev.preventDefault();
        ev.stopPropagation();
      }
    });
    cancelAnimationFrame(AB.raf);
    const loop = () => { abTick(); AB.raf = requestAnimationFrame(loop); };
    AB.raf = requestAnimationFrame(loop);
  }
  for (const btn of $("ab").querySelectorAll('[data-ab="keep"]')) btn.setAttribute("aria-pressed", String(btn.dataset.v === keep));
  renderABState();
}

/** The stage keeps the video's shape (so face boxes and zoom line up). */
function abFit() {
  const va = $("ab-a");
  const stage = $("ab-stage");
  if (!va || !stage) return;
  const ar = va.videoWidth && va.videoHeight ? va.videoWidth / va.videoHeight : 16 / 9;
  stage.style.setProperty("--ar", String(ar));
}

function abLayout() {
  const stage = $("ab-stage");
  if (!stage) return;
  stage.dataset.mode = AB.mode;
  stage.classList.toggle("show-a", AB.mode === "flip" && (AB.flip !== AB.held));
  stage.style.setProperty("--split", AB.split + "%");
  const d = $("ab-divider");
  if (d) d.setAttribute("aria-valuenow", String(Math.round(AB.split)));
}

function renderABState() {
  if ($("ab").hidden) return;
  const [va] = abVideos();
  for (const btn of $("ab").querySelectorAll('[data-ab="mode"]')) btn.setAttribute("aria-pressed", String(btn.dataset.v === AB.mode));
  const play = $("ab").querySelector(".ab-play");
  if (play && va) { play.textContent = va.paused ? "▶" : "❚❚"; play.setAttribute("aria-label", va.paused ? "Play" : "Pause"); }
  const sw = $("ab-swap");
  if (sw) { sw.hidden = AB.mode !== "flip"; sw.textContent = (AB.flip !== AB.held) ? "Showing A" : "Showing B"; }
  const z = $("ab-zoom-btn"); if (z) z.setAttribute("aria-pressed", String(AB.zoom));
  const bx = $("ab-boxes-btn"); if (bx) bx.setAttribute("aria-pressed", String(AB.boxes));
  const lp = $("ab-loop"); if (lp) lp.setAttribute("aria-pressed", String(AB.loop));
  abLayout();
  abTick();
}

/** Every frame: B follows A, the time, the scrubber, the zoom and the boxes. */
function abTick() {
  const s = AB.shot && shotById(AB.shot);
  const [va, vb] = abVideos();
  if (!s || !va || !vb) return;
  if (!va.paused && Math.abs(vb.currentTime - va.currentTime) > 0.06) vb.currentTime = va.currentTime;
  const t = va.currentTime || 0, d = va.duration || 0;
  const tm = $("ab-time");
  if (tm) tm.textContent = `${t.toFixed(2)} s · f ${Math.round(t * FPS)}${d ? ` / ${Math.round(d * FPS)}` : ""}`;
  const sc = $("ab-scrub");
  if (sc && d && document.activeElement !== sc) sc.value = String(Math.round((t / d) * 1000));
  let tf = "none";
  if (AB.zoom) {
    const fc = abFaceAt(s, t);
    if (fc && fc.hh > 0) {
      const z = Math.max(1, Math.min(8, 0.42 / fc.hh));
      tf = `translate(${(50 - z * fc.cx * 100).toFixed(3)}%, ${(50 - z * fc.cy * 100).toFixed(3)}%) scale(${z.toFixed(4)})`;
    }
  }
  const boxes = AB.boxes ? abBoxesAt(s, t) : [];
  const svg = boxes.map((b) => `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" class="${b.redrawn ? "redrawn" : ""}" vector-effect="non-scaling-stroke"></rect>`).join("");
  for (const z of $("ab").querySelectorAll(".ab-zoom")) {
    if (z.style.transform !== tf) z.style.transform = tf === "none" ? "" : tf;
    const g = z.querySelector(".ab-boxes");
    if (g && g.dataset.k !== svg) { g.innerHTML = svg; g.dataset.k = svg; }
  }
}

function abStep(n) {
  const [va, vb] = abVideos();
  if (!va) return;
  va.pause();
  const d = va.duration || 0;
  va.currentTime = Math.max(0, Math.min(d ? d - 1 / FPS / 2 : 1e9, (Math.round(va.currentTime * FPS) + n) / FPS));
  vb.currentTime = va.currentTime;
}

function abAction(el) {
  const k = el.dataset.ab, [va, vb] = abVideos();
  switch (k) {
    case "close": closeAB(); return;
    case "play": if (va) { if (va.paused) va.play().catch(() => {}); else va.pause(); } return;
    case "back": abStep(-1); return;
    case "fwd": abStep(1); return;
    case "mode": AB.mode = el.dataset.v; try { store("h3studio.abmode", AB.mode); } catch (e) { /* fine */ } break;
    case "swap": AB.flip = !AB.flip; break;
    case "zoom": AB.zoom = !AB.zoom; break;
    case "boxes": AB.boxes = !AB.boxes; break;
    case "loop": AB.loop = !AB.loop; if (va) va.loop = vb.loop = AB.loop; break;
    case "keep": {
      const s = shotById(AB.shot);
      if (!s || setupGuard()) return;
      if (el.dataset.v === "refined" && !faceHasClip(s)) { toast("Refine this Shot again first (its take changed)."); return; }
      s.face = Object.assign({}, s.face || {}, { keep: el.dataset.v === "original" ? "original" : "refined" });
      commit();
      renderAB();
      return;
    }
    default: return;
  }
  renderABState();
}

document.addEventListener("click", (e) => {
  const el = e.target.closest && e.target.closest("[data-ab]");
  if (!el || $("ab").hidden || !$("ab").contains(el)) return;
  e.preventDefault();
  e.stopPropagation();
  abAction(el);
}, true);

$("ab").addEventListener("click", (e) => { if (e.target === $("ab")) closeAB(); });

document.addEventListener("keydown", (e) => {
  if ($("ab").hidden) return;
  const tag = (e.target.tagName || "").toLowerCase();
  if (tag === "input" && e.target.type !== "range") return;
  const [va] = abVideos();
  let used = true;
  if (e.key === "Escape") closeAB();
  else if (e.key === " " || e.code === "Space") { if (va) { if (va.paused) va.play().catch(() => {}); else va.pause(); } }
  else if (e.key === "ArrowLeft" && e.target.id !== "ab-divider") abStep(-1);
  else if (e.key === "ArrowRight" && e.target.id !== "ab-divider") abStep(1);
  else if (e.key === "f" || e.key === "F") { if (!e.repeat) { if (AB.mode !== "flip") AB.mode = "flip"; AB.held = true; renderABState(); } }
  else if (e.key === "z" || e.key === "Z") { AB.zoom = !AB.zoom; renderABState(); }
  else if (e.key === "b" || e.key === "B") { AB.boxes = !AB.boxes; renderABState(); }
  else if (e.key === "Tab") {
    const items = [...$("ab").querySelectorAll("button:not([hidden]), input, [tabindex='0']")].filter((x) => x.offsetParent);
    if (items.length) {
      const i = items.indexOf(document.activeElement);
      items[(i + (e.shiftKey ? -1 : 1) + items.length) % items.length].focus();
    }
  } else used = false;
  if (used) { e.preventDefault(); e.stopPropagation(); }
}, true);

document.addEventListener("keyup", (e) => {
  if ($("ab").hidden) return;
  if ((e.key === "f" || e.key === "F") && AB.held) { AB.held = false; renderABState(); e.stopPropagation(); }
}, true);

async function faceDone(b, outputs) {
  await adoptClips(Object.entries(b.built.nodes.clips || {}).map(([key, node]) => ({ key, node })), outputs);
  const s = shotById(b.extra.shot);
  if (!s) return;
  let rep = {};
  try { rep = JSON.parse(((outputs[b.built.nodes.face] || {}).face_report || [])[0] || "{}"); } catch (e) { rep = {}; }
  const tracks = (rep.tracks || []).slice(0, 6).map((t) => ({ id: t.id, size: t.size, boxes: t.boxes }));
  s.face = { take: b.extra.take, sig: b.extra.sig,
    keep: (s.face && s.face.take === b.extra.take && s.face.keep) || "original",
    treated: rep.treated || 0, cached: (rep.crops || []).length > 0 && (rep.crops || []).every((c) => c.cached),
    w: rep.width || 0, h: rep.height || 0, crops: (rep.crops || []).map((c) => ({ track: c.track, start: c.start, frames: c.frames, side: c.side })),
    tracks, note: rep.note || "", made: Date.now() };
  scheduleSave();
  if (!rep.treated) toast(rep.note === "no small faces" ? `${titleOf(s)}: no faces under ${P().settings.face.max_face} px, nothing redrawn.` : `${titleOf(s)}: nothing redrawn.`);
  else if (!S.swapped && P().shots.includes(s)) { renderFace(); openAB(s); }
}

function renderAdvanced() {
  const s = P().settings, o = S.opts || {};
  const modelShort = (s.model || "no model").split(/[\\/]/).pop().replace(/\.(safetensors|gguf|ckpt|pt)$/i, "");
  $("adv-summary").textContent = [modelShort, s.turbo.on ? "Turbo" : "no Turbo", s.sampler, s.scheduler, `overlap ${s.overlap}`]
    .filter(Boolean).join(" · ");
  $("adv-chev").textContent = S.advOpen ? "Hide ▴" : "Show ▾";
  $("adv-toggle").setAttribute("aria-expanded", String(!!S.advOpen));
  $("advanced").hidden = !S.advOpen;
  if (!S.advOpen) return;
  const t = s.turbo;
  const loras = s.loras.map((l, i) => `<div class="lora${l.on ? "" : " off"}">
      ${switchHTML(l.on, `data-action="lora-on" data-i="${i}" aria-label="LoRA ${i + 1}"`, true)}
      <div class="pick" style="flex:1 1 160px"><select data-lora="${i}" data-k="name" aria-label="LoRA ${i + 1} file"${l.on ? "" : " disabled"}>${fileOptions(o.loras, l.name, "Choose a LoRA…")}</select>${browseBtn("loras", "lora:" + i, !l.on)}</div>
      <label class="strength"><input type="range" min="0" max="2" step="0.05" data-lora="${i}" data-k="strength" value="${esc(l.strength)}"${l.on ? "" : " disabled"} aria-label="LoRA ${i + 1} strength"><output>${Number(l.strength).toFixed(2)}</output></label>
    </div>`).join("");
  const overlaps = [5, 22, 39, 56, 73].map((v) => `<option value="${v}"${v === Number(s.overlap) ? " selected" : ""}>${v}</option>`).join("");
  const sage = (o.sage_modes && o.sage_modes.length ? o.sage_modes : ["disabled", "auto"]);
  $("advanced").innerHTML = `    <div class="model-files">
      ${modelField("Model", "diffusion_models", "model", select('data-set="model" aria-label="Model"', o.models, s.model, "Choose a model…"))}
      <div class="model-grid">
        ${modelField("Text encoder", "text_encoders", "clip", select('data-set="clip" aria-label="Text encoder"', o.clips, s.clip, "Choose…"))}
        ${modelField("Video VAE", "vae", "video_vae", select('data-set="video_vae" aria-label="Video VAE"', o.vaes, s.video_vae, "Choose…"))}
        ${modelField("Audio VAE", "vae", "audio_vae", select('data-set="audio_vae" aria-label="Audio VAE"', o.vaes, s.audio_vae, "Choose…"))}
      </div>
    </div>
    <div class="box">
      <div class="box-row">
        ${switchHTML(t.on, 'data-action="turbo-on" aria-label="Turbo LoRA"')}
        <div style="flex:1;min-width:140px"><div>Turbo LoRA</div>
          <div class="pick" style="margin-top:4px"><select data-turbo="lora" aria-label="Turbo LoRA file"${t.on ? "" : " disabled"}>${fileOptions(o.loras, t.lora, "Choose…")}</select>${browseBtn("loras", "turbo", !t.on)}</div></div>
        <label class="strength" style="flex:1 1 180px">Strength
          <input type="range" min="0" max="2" step="0.05" data-turbo="strength" value="${esc(t.strength)}"${t.on ? "" : " disabled"}><output>${Number(t.strength).toFixed(2)}</output></label>
      </div>
      ${hasPack("turbo") ? "" : `<div class="pack-note muted small">Using ComfyUI's stock LoRA loader. ${installBtn("turbo")}</div>`}
    </div>
    <div class="loras">${loras}</div>
    <div class="adv-sub">Sampling</div>
    <div class="grid2">
      <label class="lbl">Sampler ${select('data-set="sampler"', o.samplers, s.sampler)}</label>
      <label class="lbl">Scheduler ${select('data-set="scheduler"', o.schedulers, s.scheduler)}</label>
      <label class="lbl">Overlap frames <select data-set="overlap" data-num>${overlaps}</select></label>
      <label class="lbl">Sage attention ${select('data-set="sage_attention"', sage, s.sage_attention)}</label>
      <label class="lbl">Reference resize (px) <input data-set="ref_resize_px" data-num type="number" min="64" step="2" value="${esc(s.ref_resize_px)}"></label>
      <label class="lbl">Shift video <input data-set="shift_video" data-num type="number" step="0.5" value="${esc(s.shift_video)}"></label>
      <label class="lbl">Shift audio <input data-set="shift_audio" data-num type="number" step="0.5" value="${esc(s.shift_audio)}"></label>
    </div>`;
}

function pinText(r) {
  if (!r) return "";
  const bits = [];
  if (r.pins && r.pins.end) {
    bits.push(r.pins.end.kind === "old_tail" ? `pinned to Shot ${r.pins.end.to}` : `leads into Shot ${r.pins.end.to}`);
  }
  if (r.join === "cut") bits.push("cut");
  if (r.seam === "mismatch") bits.push("hard cut before it");
  return bits.length ? " · " + bits.join(" · ") : "";
}

function renderPlan() {
  const rid = renderingId();
  const act = active();
  if (!act.length) { $("plan").innerHTML = '<div class="plan-empty peek">No active shots.</div>'; return; }
  // folded, the Plan shows one line: the Shot rendering, else the next to render, else the last
  const peekId = (act.find((x) => x.id === rid) || act.find((x) => x.kind !== "clip" && x.status === "queued") || act[act.length - 1]).id;
  const dryRow = (id) => {
    if (!S.dry) return null;
    const i = S.dry.chain.indexOf(id);
    return i >= 0 ? S.dry.rows[i] : null;
  };
  const what = (r) => (r.status === "locked" ? `take · seed ${r.seed}`
    : r.status === "reused" ? `reused (${r.source}) · seed ${r.seed}` : `will render (${r.reason}) · seed ${r.seed}`);
  $("plan").innerHTML = act.map((s, k) => {
    const row = lastRowFor(s.id), dry = dryRow(s.id);
    let len, status, color;
    if (s.kind === "clip") {
      const r = dry || row;
      len = (r ? r.seconds : s.clip.frames / 24).toFixed(2) + "s";
      status = `clip · ${s.clip.original_name || s.clip.file || "no video"}${r && r.seam === "mismatch" ? " · not bridged yet" : ""}${r && r.join === "cut" ? " · cut" : ""}`;
      return `<div class="plan-row${s.id === peekId ? " peek" : ""}"><span>Seg ${k + 1}</span><span class="muted">${esc(len)}</span><span style="color:#8FD3F0">${esc(status)}</span></div>`;
    }
    if (s.id === rid) { len = (row ? row.seconds.toFixed(2) : s.seconds) + "s"; status = "rendering…"; color = "#E9E7E2"; }
    else if (s.status === "approved" && (row || dry)) {
      const r = dry || row;
      len = r.seconds.toFixed(2) + "s";
      status = dry ? what(dry) + pinText(dry)
        : `${row.locked ? "take" : row.status === "render" ? "rendered" : "reused"} · seed ${row.seed}${pinText(row)}`;
      color = dry && dry.status === "render" ? "#A3A6AD" : "#9FE0C2";
    }
    else if (s.status === "review" && row) {
      len = row.seconds.toFixed(2) + "s";
      status = `rendered${dry && dry.status !== "render" ? ` (${dry.status === "locked" ? "take" : dry.source})` : ""} · seed ${row.seed}${pinText(dry || row)}`;
      color = "#FFD08A";
    }
    else {
      len = (dry ? dry.seconds.toFixed(2) : s.seconds) + "s";
      status = dry ? what(dry) + pinText(dry) : "will render";
      color = "#A3A6AD";
    }
    if (s.status !== "queued" && !row && !dry && s.take) {
      // not in the last render (it showed one standalone Shot): its take is still there
      len = s.seconds + "s";
      status = `take · seed ${effSeed(s)}`;
      color = s.status === "approved" ? "#9FE0C2" : "#FFD08A";
    }
    if (s.standalone && s.status !== "queued") status += " · standalone";
    if (s.join === "context") status = status.replace(/ · cut\b/g, "") + " · context";
    else if (s.join === "cut" && !/ · cut\b/.test(status)) status += " · cut";
    if (cutBefore(s) && !/hard cut/.test(status)) status += " · cut before it";
    if (((dry || row) && (dry || row).seam === "mismatch") || cutBefore(s)) color = "#FFB4A8";
    return `<div class="plan-row${s.id === peekId ? " peek" : ""}"><span>Seg ${k + 1}</span><span class="muted">${esc(len)}</span><span style="color:${color}">${esc(status)}</span></div>`;
  }).join("") + runsLine();
}

/** The Plan's last line: how the whole film decodes (0.8.5). */
function runsLine() {
  if (!runsSupported()) return "";
  const runs = decodeRuns(active().filter((x) => !isRendered(x)).map((x) => x.id));
  if (runs.length < 2) return "";
  const r = (ids) => { const a = numOf(ids[0]), b = numOf(ids[ids.length - 1]); return a === b ? `${a}` : `${a}–${b}`; };
  return `<div class="plan-runs muted small" title="Shots joined Continuous or Bridge decode together; each Cut or Context join starts a new run. One video file at the end.">` +
    `Whole-film decode in ${runs.length} runs: Shots ${runs.map(r).join(" · ")}</div>`;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

function castOf(el) { const c = el.closest("[data-cast]"); return c && P().cast.find((x) => x.id === c.dataset.cast); }
function shotOf(el) { const c = el.closest("[data-shot]"); return c && P().shots.find((x) => x.id === c.dataset.shot); }

document.addEventListener("click", async (e) => {
  if (S.swapped) return;                     // a moment while a queue job saves into its project
  const el = e.target.closest("[data-action]");
  if (!el || el.disabled) return;
  const a = el.dataset.action;
  const p = P();
  switch (a) {
    case "primary": primary(); break;
    case "fold": toggleFold(el.dataset.fold); break;
    case "approve": { const rv = reviewShot(); if (rv && !shotGuard(rv)) { rv.status = "approved"; rv.was_approved = false; commit(); } break; }
    case "approve-next": {
      const rv = reviewShot();
      if (!rv || shotGuard(rv)) break;
      rv.status = "approved"; rv.was_approved = false;
      const nextRv = reviewShot();
      const wasPlaying = PL.playing;
      commit();
      if (nextRv) {
        // jump the player to the start of the next Shot (after any redraw this click deferred)
        const go = () => {
          focusShot(nextRv.id);
          if (wasPlaying) play();
        };
        go();
        setTimeout(() => { if (S.focus === nextRv.id && !PL.playing) focusShot(nextRv.id); }, 0);
      }
      break;
    }
    case "approve-final": { const rv = reviewShot(); if (rv) { rv.status = "approved"; rv.was_approved = false; } upscaleFinal(); break; }
    case "bridge": bridgeShot(shotOf(el)); break;
    case "render-alone": renderAloneAction(shotOf(el)); break;
    case "clear-render": clearRender(shotOf(el)); break;
    case "render-all": renderAll(); break;
    case "render-odd": renderOdd(); break;
    case "reroll": reroll(); break;
    case "stop": stop(); break;
    case "dry-run": dryRun(); break;
    case "dismiss-error": S.error = null; renderDecision(); break;
    case "toggle": S[el.dataset.key] = !S[el.dataset.key]; render(); break;
    case "face-on": case "face-turbo-on": case "face-hold": {
      if (setupGuard()) return;
      const f = p.settings.face;
      if (a === "face-on") { f.on = !f.on; if (f.on && !f.model) f.model = fl2vaModel(); }
      else if (a === "face-turbo-on") f.turbo.on = !f.turbo.on;
      else f.hold_audio = !f.hold_audio;
      commit();
      break;
    }
    case "face-which": if (setupGuard()) return; p.settings.face.which = el.dataset.v === "largest" ? "largest" : "all"; commit(); break;
    case "face-detector": installFaceDetector(); break;
    case "face-try": faceTry(shotById(el.dataset.shot)); break;
    case "face-ab": openAB(shotById(el.dataset.shot)); break;
    case "face-keep": {
      const sh = shotById(el.dataset.shot);
      if (!sh || setupGuard()) return;
      if (el.dataset.v === "refined" && !faceHasClip(sh)) { toast("Refine this Shot first."); return; }
      sh.face = Object.assign({}, sh.face || {}, { keep: el.dataset.v === "original" ? "original" : "refined" });
      commit();
      if (!$("ab").hidden) renderAB();
      break;
    }
    case "refine-on": case "refine-export": case "refine-turbo-on": {
      if (setupGuard()) return;
      const r = p.settings.refine;
      if (a === "refine-on") r.on = !r.on;
      else if (a === "refine-export") r.export_only = !r.export_only;
      else r.turbo.on = !r.turbo.on;
      S.dry = null;
      commit();
      break;
    }
    case "toggle-shot": { const s = shotOf(el); S.open = S.open === s.id ? null : s.id; renderShots(); break; }
    case "bypass-shot": {
      const s = shotOf(el);
      if (listGuard(p.shots.indexOf(s))) return;
      s.bypassed = !s.bypassed;
      S.dry = null;
      if (!syncAfter(s, `${s.bypassed ? "Bypassing" : "Turning on"} a Shot`) && renderedAfter(s).length && s.take) {
        toast("The Shots after it keep their takes. If a join looks wrong, reroll the Shot after it to bridge it.");
      }
      commit();
      break;
    }
    case "remove-shot": {
      const s = shotOf(el);
      if (listGuard(p.shots.indexOf(s))) return;
      if (s.text && !confirm(`Remove ${s.bypassed ? "this bypassed shot" : titleOf(s)}? Its text is deleted.`)) return;
      if (!s.bypassed) syncAfter(s, "Removing a Shot");
      S.dry = null;
      p.shots = p.shots.filter((x) => x.id !== s.id);
      commit();
      break;
    }
    case "add-shot": insertShot(p.shots.length); break;
    case "add-first": insertShot(0); break;
    case "add-first-clip": pickClip(P().shots[0] ? P().shots[0].id : null, false, true); break;
    case "insert-clip-after": pickClip(shotOf(el).id, false); break;
    case "replace-clip": pickClip(shotOf(el).id, true); break;
    case "pick-clip-file": pickClipFile(shotOf(el)); break;
    case "toggle-join": toggleJoin(shotOf(el)); break;
    case "cycle-join": cycleJoin(shotOf(el)); break;
    case "context-redo": redoInPlace(shotOf(el)); break;
    case "insert-before": case "insert-after": {
      const s = shotOf(el);
      insertShot(p.shots.indexOf(s) + (a === "insert-after" ? 1 : 0));
      break;
    }
    case "take-step": { const s = shotOf(el) || reviewShot(); stepTake(s, +el.dataset.dir); break; }
    case "takes": manageTakes(shotOf(el) || reviewShot()); break;
    case "use-take": { $("modal").hidden = true; const s = P().shots.find((x) => x.id === el.dataset.shot); useTake(s, el.dataset.name); break; }
    case "delete-take": deleteTake(el.dataset.shot, el.dataset.name); break;
    case "refresh": refreshPreview(); break;
    case "browse-model": browseModels(el.dataset.kind, el.dataset.target); break;
    case "mb-pick": mbPick(el.dataset.name); break;
    case "mb-folders": MB.mode = "folders"; MB.path = ""; renderMB(); break;
    case "mb-cd": MB.path = el.dataset.path; renderMB(); break;
    case "mb-back": MB.mode = "files"; renderMB(); break;
    case "mb-add": if (MB.shown) mbChangeFolders("add", MB.shown); break;
    case "mb-remove": if (confirm("Stop looking for models in this folder? The files stay where they are.")) mbChangeFolders("remove", el.dataset.path); break;
    case "wrap": wrap(el); break;
    case "bypass-cast": {
      if (setupGuard()) return;
      const c = castOf(el);
      const mode = await askRefChange(`${c.bypassed ? "Turn on" : "Bypass"} ${c.label || "this reference"}?`);
      if (!mode) return;
      c.bypassed = !c.bypassed;
      applyRefChange(mode, "Cast & Scenes");
      commit();
      break;
    }
    case "remove-cast": {
      if (setupGuard()) return;
      const c = castOf(el);
      if (!confirm(`Remove ${c.label || "this reference"}?`)) return;
      const mode = await askRefChange();
      p.cast = p.cast.filter((x) => x.id !== c.id);
      if (!c.bypassed) applyRefChange(mode, "Cast & Scenes");
      commit();
      break;
    }
    case "add-cast": {
      if (setupGuard()) return;
      p.cast.push({ id: uid("c"), label: "<new>", desc: "", role: "appearance", image: "", bypassed: false });
      // an empty card changes nothing yet; choosing its picture asks about approved Shots
      if (approvedShots().length) { S.dry = null; S.gen++; } else sharedChanged("Cast & Scenes");
      commit();
      break;
    }
    case "ref-step": stepRef(castOf(el), +el.dataset.dir); break;
    case "flip-shots": store("h3studio.flipShots", store("h3studio.flipShots") === "1" ? "0" : "1"); renderShots(); break;
    case "add-voice": pickVoices(null); break;
    case "install-pack": installPack(el.dataset.pack); break;
    case "install-preview": installPreview(); break;
    case "viewer-hide": setViewerHidden(true); break;
    case "viewer-fold": setViewerHidden(!VIEW.hidden); break;
    case "viewer-show": setViewerHidden(false); break;
    case "restore-refs": restoreRefs(shotOf(el)); break;
    case "reset-edit": {
      const sh = shotOf(el);
      if (!sh) break;
      const lk = runOf(sh).find(isAligned);
      if (lk && editOf(runOf(sh)[0]).shift) { toast(`${titleOf(lk)} is marked aligned, so it stays put. Unmark aligned first.`); break; }
      sh.place = null;
      const first = runOf(sh)[0];                       // the run's move, too
      if (first !== sh && first.place) { first.place.shift = 0; if (!first.place.in && !first.place.out) first.place = null; }
      commit();
      break;
    }
    case "add-refmod": pickRefmod(); break;
    case "use-refmod": {
      $("modal").hidden = true;
      if (setupGuard()) return;
      p.refmods.push({ id: uid("m"), name: el.dataset.name, kind: ["image", "video", "audio"].includes(el.dataset.kind) ? el.dataset.kind : "image",
        label: "<" + el.dataset.name.replace(/[^A-Za-z0-9 _-]/g, "").slice(0, 20) + ">", desc: "", strength: 1, bypassed: false });
      applyRefChange((await askRefChange()) || "keep", "RefMods");
      commit();
      break;
    }
    case "bypass-refmod": {
      if (setupGuard()) return;
      const m = refmodOf(el);
      if (!m) return;
      const mode = await askRefChange();
      m.bypassed = !m.bypassed;
      applyRefChange(mode, "RefMods");
      commit();
      break;
    }
    case "remove-refmod": {
      if (setupGuard()) return;
      const m = refmodOf(el);
      if (!m || !confirm(`Remove ${m.label || m.name}?`)) return;
      const mode = await askRefChange();
      p.refmods = p.refmods.filter((x) => x.id !== m.id);
      if (!m.bypassed) applyRefChange(mode, "RefMods");
      commit();
      break;
    }
    case "voice-replace": { const v = voiceOf(el); if (v) pickVoices(v.id); break; }
    case "bypass-voice": {
      if (setupGuard()) return;
      const v = voiceOf(el);
      if (!v) return;
      const mode = await askRefChange();
      v.bypassed = !v.bypassed;
      applyRefChange(mode, "Voice references");
      commit();
      break;
    }
    case "remove-voice": {
      if (setupGuard()) return;
      const v = voiceOf(el);
      if (!v || !confirm(`Remove ${v.label || "this voice reference"}? Pictures linked to it lose their voice.`)) return;
      const mode = await askRefChange();
      p.voices = p.voices.filter((x) => x.id !== v.id);
      if (!v.bypassed) applyRefChange(mode, "Voice references");
      commit();
      break;
    }
    case "reset-seeds": resetShotSeeds(); break;
    case "free-vram": freeMemory("vram"); break;
    case "free-ram": freeMemory("ram"); break;
    case "clear-cache": freeMemory("cache"); break;
    case "audio-preview": previewing() ? stopPreview() : startPreview(); break;
    case "pick-audio": pickAudio(); break;
    case "pick-image": { const c = castOf(el); if (c) pickImages(c.id); break; }
    case "view-image": { const c = castOf(el); if (c && c.image && !["missing", "invalid"].includes(S.refState[c.id])) openLightbox(c.id); break; }
    case "edit-cast": openEditor(castOf(el)); break;
    case "editor-save": editorSave(); break;
    case "editor-cancel": closeEditor(); break;
    case "editor-zoom": if (editing && editing.kind === "cast") openLightbox(editing.id); break;
    case "edit-voice": openVoiceEditor(voiceOf(el)); break;
    case "task-type": {
      const t = el.dataset.t, cur = (p.style.task_types || []).filter((x) => TASK_TYPES.includes(x));
      if (cur.includes(t)) { setTaskTypes(cur.filter((x) => x !== t)); break; }
      if (cur.length >= MAX_TASK_TYPES) { toast(`The summary takes ${MAX_TASK_TYPES} task types at most: remove one first.`); break; }
      setTaskTypes([...cur, t]);
      break;
    }
    case "task-types-clear": setTaskTypes([]); break;
    case "edit-refmod": openRefmodEditor(refmodOf(el)); break;
    case "ed-set-start": case "ed-set-end": {
      const pl = $("ed-player"), alt = $("editor-alt");
      if (!pl) break;
      const t = Math.round(pl.currentTime * 100) / 100;
      const st = alt.querySelector("[data-ed=start]"), ln = alt.querySelector("[data-ed=length]");
      if (a === "ed-set-start") st.value = String(t);
      else ln.value = String(Math.max(0, Math.round((t - (Number(st.value) || 0)) * 100) / 100) || "");
      break;
    }
    case "lb-close": closeLightbox(); break;
    case "reroll-shot": rerollShot(shotOf(el)); break;
    case "use-seed": useSeed(shotOf(el), Number(el.dataset.seed)); break;
    case "shot-seed-step": stepShotSeed(shotOf(el), Number(el.dataset.d) || 0); break;
    case "base-seed-step": {
      const inp = document.querySelector("[data-base-seed]");
      if (!inp) break;
      inp.value = String(Math.max(0, Math.min(SEED_MAX, (Number(P().settings.seed) || 0) + (Number(el.dataset.d) || 0))));
      await changeBaseSeed(inp);
      renderSettings();
      break;
    }
    case "render-through": renderThrough(); break;
    case "theater": setTheater(!S.theater); break;
    case "fullscreen": toggleFullscreen(); break;
    case "restart": restartComfy(); break;
    case "mute": toggleMute(); break;
    case "vsr-on": p.settings.rtx_vsr.on = !p.settings.rtx_vsr.on; commit(); break;
    case "clip-pixels": p.settings.clip_pixels = !p.settings.clip_pixels; commit(); break;
    case "final": upscaleFinal(); break;
    case "audio-route": {
      if (setupGuard()) return;
      const k = el.dataset.key;
      p.audio[k] = !p.audio[k];
      if (k === "song_ref" || k === "lip_sync") S.dry = null;   // for Shots rendered from now on: nothing re-queues
      else if (k !== "final_override") sharedChanged("Audio");
      commit();
      break;
    }
    case "audio-set-start": scrubSet("start"); break;
    case "phrase-mark": markPhrase(); break;
    case "phrase-detect": detectPhrases(); break;
    case "phrase-clear": if (confirm("Delete all phrase markers?")) setPhrases([]); break;
    case "phrase-next": { const sh = shotOf(el); if (sh) startOnPhrase(sh); break; }
    case "aligned": {
      const sh = shotOf(el);
      if (!sh || !isRendered(sh)) break;
      sh.aligned = isAligned(sh) ? null : { key: alignKey(sh) };
      commit();                                       // a mark only: nothing re-renders
      break;
    }
    case "audio-set-end": scrubSet("end"); break;
    case "turbo-on": {
      if (setupGuard()) return;
      const mode = await askSettingChange(p.settings.turbo.on ? "Turn Turbo off" : "Turn Turbo on");
      if (!mode) return;
      p.settings.turbo.on = !p.settings.turbo.on;
      applyRefChange(mode, "Turbo");
      commit();
      break;
    }
    case "lora-on": {
      if (setupGuard()) return;
      const l = p.settings.loras[+el.dataset.i];
      let mode = "all";
      if (l.name || l.on) { mode = await askSettingChange(`${l.on ? "Turn off" : "Turn on"} LoRA ${+el.dataset.i + 1}`); if (!mode) return; }
      l.on = !l.on;
      if (l.name || !l.on) applyRefChange(mode, "LoRAs");
      commit();
      break;
    }
    case "steps20": {
      const mode = await askSettingChange("Set 20 steps");
      if (!mode) return;
      p.settings.steps = 20;
      applyRefChange(mode, "Steps");
      commit();
      break;
    }
    case "ref-size": {
      if (setupGuard() || p.settings.ref_image_size === el.dataset.v) return;
      const mode = await askSettingChange("Change the reference image size");
      if (!mode) return;
      p.settings.ref_image_size = el.dataset.v;
      applyRefChange(mode, "Reference image size");
      commit();
      break;
    }
    case "play": togglePlay(); break;
    case "step": stepFrame(+el.dataset.dir); break;
    case "jump": {
      const L = loopRange();
      if (L) { if (PL.playing) pausePlayer(); TLV.hold = 0; tlSeek(TL.entries[L.i].start + 0.04); tlReveal(L.shot.id); }
      break;
    }
    case "loop": {
      const L = loopRange();
      S.loop = !S.loop && !!L;
      if (S.loop) { tlSeek(L.a); play(); }
      renderViewer();
      break;
    }
    case "tl-pick": { const b = el.closest("[data-tl]"); if (b) focusShot(b.dataset.tl); break; }
    case "tl-take": { const b = el.closest("[data-tl]"); const sh = b && shotById(b.dataset.tl); if (sh) { S.focus = sh.id; stepTake(sh, +el.dataset.dir); tlReveal(sh.id); } break; }
    case "update-preview": updatePreview(); break;
    case "make-clips": makeMissingClips(missingClips().length ? missingClips() : takesWithoutClips()); break;
    case "clear-all": clearAll(); break;
    case "open-folder": openFolder(el.dataset.which); break;
    case "export-approved": exportApproved(); break;
    case "queue-pause": case "queue-clear": case "queue-open": case "queue-stop": case "queue-retry":
    case "queue-remove": case "queue-up": case "queue-down": case "queue-flip": queueAction(a, el); break;
    case "anchor-pick": { const k = el.closest("[data-anchor]"); if (k) anchorPick(k.dataset.anchor); break; }
    case "anchor-clear": { const k = el.closest("[data-anchor]"); if (k && !setupGuard()) setAnchor(k.dataset.anchor, null); break; }
    case "menu": toggleMenu(); break;
    case "new-project": closeMenu(); newProject(); break;
    case "open-list": closeMenu(); openList(); break;
    case "open-project": $("modal").hidden = true; switchProject(el.dataset.slug); break;
    case "save": closeMenu(); saveNow(); break;
    case "save-as": closeMenu(); saveAs(); break;
    case "rename": closeMenu(); renameProject(); break;
    case "duplicate": closeMenu(); duplicateProject(); break;
    case "delete-project": closeMenu(); deleteDialog(); break;
    case "export-project": closeMenu(); exportDialog(); break;
    case "import-project": closeMenu(); pickImport(); break;
    case "export-go": exportGo(); break;
    case "confirm-delete": confirmDelete(); break;
    case "conflict-reload": S.conflict = null; loadProject(P().slug); break;
    case "conflict-keep": saveNow(true); break;
    case "relink": { const sel = el.closest("[data-cast]").querySelector("select[data-relink]"); if (sel) { sel.focus(); if (sel.showPicker) try { sel.showPicker(); } catch (e) { /* not allowed */ } } break; }
    case "clear-segments": clearSegments(); break;
    case "close-modal": $("modal").hidden = true; break;
    default: break;
  }
});

/** Where the part of the Shots list that's rendering ends: the index of its
 *  last Shot, -1 when the open project isn't rendering, Infinity when the run
 *  has no Shot chain (then the whole list waits). */
function runEnd() {
  if (!busyHere()) return -1;
  const ch = S.busy && S.busy.built && S.busy.built.chain;
  if (!ch || S.chunking) return Infinity;
  const shots = P().shots;
  return Math.max(-1, ...ch.map((id) => shots.findIndex((x) => x.id === id)));
}
/** Changes to the list itself (add, insert, remove, bypass, clips) are fine
 *  after the Shots that are rendering; inside them they wait. `at` is the
 *  index the change happens at; `gap` asks for one free Shot in between. */
function listGuard(at, gap = 0) {
  if (S.applying && S.swapped) { toast("One moment: saving a render from the queue…"); return true; }
  const end = runEnd();
  if (end < 0 || at > end + gap) return false;
  toast(end === Infinity ? "Wait for the render to finish (or Stop it) first."
    : "That part of the Shots list is rendering. Add, remove or change Shots after it, or wait for the render to finish.");
  return true;
}
/** A Shot that isn't part of the render going now can be reviewed and changed. */
function shotGuard(s) {
  if (S.applying && S.swapped) { toast("One moment: saving a render from the queue…"); return true; }
  if (!busyHere()) return false;
  const end = runEnd();
  if (end !== Infinity && s && !inRender(s)) return false;
  return busyGuard();
}

/** A Shot's take can't switch while it (or the Shot just before it) is rendering. */
const takesLocked = (s) => busyHere() && runEnd() >= P().shots.indexOf(s) - 1;

/** Setting things up (references, settings, audio, new projects) goes on while
 *  a render runs; only the moment a queue job saves into a project waits. */
function setupGuard() {
  if (S.applying && S.swapped) { toast("One moment: saving a render from the queue…"); return true; }
  return false;
}

function busyGuard() {
  if (S.applying && S.swapped) { toast("One moment: saving a render from the queue…"); return true; }
  if (!busyHere()) return false;
  toast("Wait for the render to finish (or Stop it) first.");
  return true;
}

function commit() { render(); scheduleSave(); }

/** Text fields: typing updates the project quietly; leaving the field commits
 *  (and applies the re-render rules). */
document.addEventListener("input", (e) => {
  if (S.swapped) { swapEvents.push(["input", e.target]); return; }   // replayed when it's back
  const el = e.target;
  const p = P();
  if (!p) return;
  if (el.id === "mb-q" && MB) {
    MB.q = el.value;
    const pos = el.selectionStart;
    renderMB();
    const q = $("mb-q");
    if (q) { q.focus(); q.setSelectionRange(pos, pos); }
    return;
  }
  if (el.id === "editor-desc") autoGrow(el);
  else if (el.dataset.style) { p.style[el.dataset.style] = el.value; fitText(el); scheduleSave(); }
  else if (el.dataset.shotField) { shotInput(el); if (el.tagName === "TEXTAREA") fitText(el); }
  else if (el.type === "range" && el.nextElementSibling && el.nextElementSibling.tagName === "OUTPUT") {
    el.nextElementSibling.textContent = Number(el.value).toFixed(2);
  }
});

const committed = new WeakMap();      // element -> value when focused, to see real changes
document.addEventListener("focusin", (e) => { committed.set(e.target, e.target.value); });

document.addEventListener("change", async (e) => {
  if (S.swapped) { swapEvents.push(["change", e.target]); return; }
  const el = e.target;
  const p = P();
  if (!p) return;
  const before = committed.get(el);
  const changed = before === undefined || before !== el.value;
  committed.set(el, el.value);
  if (el.dataset.relink) { relinkFromSelect(el); return; }
  if (el.dataset.refmodField) {
    const m = refmodOf(el), k = el.dataset.refmodField;
    if (!m) return;
    if (setupGuard()) { render(); return; }
    const val = k === "strength" ? Math.max(0, Math.min(1, Number(el.value) || 0)) : el.value;
    if (val === m[k]) return;
    m[k] = val;
    if (!m.bypassed) applyRefChange((await askRefChange()) || "keep", "RefMods");
    return commit();
  }
  if (el.dataset.voiceField) {
    const v = voiceOf(el), k = el.dataset.voiceField;
    if (!v) return;
    if (setupGuard()) { render(); return; }
    if (k === "label") { v.label = el.value; return commit(); }    // not in the prompt: nothing re-renders
    const val = Math.max(0, Number(el.value) || 0);
    if (val === Number(v[k] || 0)) return;
    v[k] = val;
    if (!v.bypassed) applyRefChange((await askRefChange()) || "keep", "Voice references");
    return commit();
  }
  if (el.id === "tl-export-up") { p.settings.export_upscale = el.checked; return commit(); }
  if (el.id === "live-preview") { setLive(el.checked); return; }
  if (el.dataset.anchorFile !== undefined) {
    const k = el.closest("[data-anchor]");
    if (!k || setupGuard()) { render(); return; }
    const [sub, name] = el.value ? el.value.split("|") : ["", ""];
    setAnchor(k.dataset.anchor, name ? { name, subfolder: sub } : null);
    return;
  }
  if (el.dataset.baseSeed !== undefined) { changeBaseSeed(el); return; }
  if (el.dataset.multi !== undefined) {   // takes per render: nothing re-renders
    p.settings.multi_take = Math.max(1, Math.min(MULTI_MAX, Math.round(Number(el.value)) || 1));
    el.value = String(p.settings.multi_take);
    return commit();
  }
  if (el.dataset.outfile) {        // which files a render keeps: nothing re-renders
    p.settings[el.dataset.outfile] = el.checked;
    return commit();
  }
  if (el.dataset.vsr) {            // post-process only: no Shot re-renders
    const k = el.dataset.vsr;
    if (k === "chunk_s") {
      p.settings.rtx_vsr.chunk_s = Math.max(2, Math.min(600, Math.round(Number(el.value)) || 10));
      el.value = String(p.settings.rtx_vsr.chunk_s);
    } else p.settings.rtx_vsr[k] = k === "scale" ? Number(el.value) : el.value;
    return commit();
  }
  if (el.dataset.field) {
    const c = castOf(el);
    c[el.dataset.field] = el.value;
    if (changed && !c.bypassed) applyRefChange((await askRefChange("Change this reference?")) || "keep", "Cast & Scenes");
    return commit();
  }
  if (el.dataset.style) {
    const k = el.dataset.style;
    if (changed) {
      const mode = await askSettingChange("Change Style & Sound");
      if (!mode) {                                  // put the text back as it was
        if (before !== undefined) { p.style[k] = before; el.value = before; committed.set(el, before); }
        return commit();
      }
      p.style[k] = el.value;
      applyRefChange(mode, "Style & Sound");
    } else p.style[k] = el.value;
    return commit();
  }
  if (el.dataset.shotField) {
    const s = shotOf(el);
    if (inRender(s)) {
      toast("This shot is part of the render in progress; edit it when it finishes.");
      return render();
    }
    // The value is already in the project (typing commits it, item 9). Leaving
    // the field only tidies an unfinished number; it never rebuilds the page,
    // so a click on Render right from the field lands the first time (item 10).
    const k = el.dataset.shotField;
    if (S.bad[s.id + ":" + k]) {
      delete S.bad[s.id + ":" + k];
      if (k === "seconds") { el.value = s.seconds; }
      else if (k === "shot_seed") { el.value = s.shot_seed < 0 ? "" : s.shot_seed; }
      liveEdit(s);
    }
    if (changed && !s.bypassed) shotEdited(s, k);
    scheduleSave();
    return;
  }
  if (el.dataset.clipFile !== undefined) {
    const sh = shotOf(el);
    if (!el.value) return;
    const [sub, name] = splitChoice(el.value);
    setClipFile(sh, sub, name, null);
    return;
  }
  if (el.dataset.clip) {
    const sh = shotOf(el), c = sh.clip, k = el.dataset.clip;
    if (k === "audio") c.audio = el.value;
    else if (k === "trim_in") {
      c.trim_in = Math.max(0, Math.min(parseFloat(el.value) || 0, Math.max(0, (c.duration || 0) - 0.25)));
      c.frames = clipFrames(Math.min(c.frames / 24, (c.duration || 1e9) - c.trim_in)) || c.frames;
    } else if (k === "length") {
      c.frames = clipFrames(Math.min(parseFloat(el.value) || 0, (c.duration || 1e9) - c.trim_in)) || c.frames;
    }
    sh.seconds = c.frames / 24;
    if (changed) clipChanged(sh);
    return commit();
  }
  if (el.dataset.faceShot !== undefined) {         // 0.14.1: pick the Shot (moves the viewer there too)
    if (el.value && shotById(el.value)) focusShot(el.value);
    return;
  }
  if (el.dataset.face) {
    const f = p.settings.face, k = el.dataset.face;
    const num = (lo, hi, d, int) => { const v = Number(el.value); const x = Number.isFinite(v) && el.value !== "" ? v : d; return Math.max(lo, Math.min(hi, int ? Math.round(x) : x)); };
    if (k === "model") f.model = el.value || null;
    else if (k === "turbo.lora") f.turbo.lora = el.value || null;
    else if (k === "turbo.strength") f.turbo.strength = num(0, 2, 1);
    else if (k === "steps") f.steps = num(1, 200, 10, true);
    else if (k === "denoise") f.denoise = num(0.05, 1, 0.3);
    else if (k === "shift_video") f.shift_video = num(0.5, 100, 4);
    else if (k === "max_face") f.max_face = num(16, 2000, 150, true);
    else if (k === "work") f.work = num(256, 1536, 640, true);
    else if (k === "padding") f.padding = num(0.2, 3, 0.8);
    else if (k === "mask") f.mask = num(0.5, 2.5, 1);
    else if (k === "feather") f.feather = num(0.02, 1, 0.3);
    else if (k === "color") f.color = num(0, 1, 1);
    else if (k === "seed") f.seed = num(0, 2 ** 53, 0, true);
    else if (k === "follow") f.follow = ["auto", "fixed", "follow"].includes(el.value) ? el.value : "auto";
    else if (k === "cast") f.cast = el.value || null;
    else if (k === "describe") { f.describe = el.value.slice(0, 300); scheduleSave(); renderFaceSummary(); return; }
    return commit();
  }
  if (el.dataset.refine) {
    const r = p.settings.refine, k = el.dataset.refine;
    if (k === "model") r.model = el.value || null;
    else if (k === "turbo.lora") r.turbo.lora = el.value || null;
    else if (k === "turbo.strength") r.turbo.strength = Math.max(0, Math.min(2, Number(el.value) || 0));
    else if (k === "steps") r.steps = Math.max(1, Math.min(200, Math.round(Number(el.value) || 10)));
    else if (k === "denoise") r.denoise = Math.max(0.05, Math.min(1, Number(el.value) || 0.3));
    else if (k === "shift_video") r.shift_video = Math.max(0.5, Math.min(100, Number(el.value) || 12));
    S.dry = null;
    return commit();
  }
  if (el.dataset.melband !== undefined) {
    p.audio.melband_model = el.value || null;
    if (changed && p.audio.voice_ref) sharedChanged("Audio");
    return commit();
  }
  if (el.dataset.audio) {
    const k = el.dataset.audio;
    if (k === "sync_nudge") {
      p.audio.sync_nudge = Math.max(-240, Math.min(240, Math.round(Number(el.value) || 0)));
    } else if (k === "phrase_gap" || k === "phrase_sens" || k === "phrase_lead") {
      const v = Number(el.value) || 0;
      p.audio[k] = k === "phrase_gap" ? Math.max(0.1, Math.min(3, v)) : k === "phrase_sens" ? Math.max(0, Math.min(1, v))
        : Math.max(0, Math.min(48, Math.round(v)));
      return commit();
    } else {
      const v = parseTC(el.value);
      if (!Number.isFinite(v)) { toast("Type the time in seconds, e.g. 13.67."); render(); return; }
      p.audio[k] = toFrame(Math.max(0, v));
    }
    stopPreview();
    SCRUB.pos = null;
    S.dry = null;
    if (changed && p.audio.voice_ref) sharedChanged("Audio");
    return commit();
  }
  if (el.dataset.set) {
    const k = el.dataset.set;
    const v = el.dataset.num !== undefined ? Number(el.value) : el.value;
    if (k === "seed_mode") {         // only decides the next seeds: nothing rendered changes
      p.settings.seed_mode = v;
      S.dry = null;
      return commit();
    }
    if (changed && KEEPABLE[k]) {
      // approved takes don't depend on it: they can be kept (item 2, round 5)
      const mode = await askSettingChange(`Change ${KEEPABLE[k]}`);
      if (!mode) return render();
      p.settings[k] = v;
      applyRefChange(mode, KEEPABLE[k][0].toUpperCase() + KEEPABLE[k].slice(1));
      return commit();
    }
    // size and overlap: old takes can't be used, everything renders again
    if (changed && (k === "megapixels" || k === "aspect") && approvedShots().length) {
      // 0.12.7: approved Shots keep their takes at their own size
      const nxt = Object.assign({}, p.settings, { [k]: v }), sz = sizeOf(nxt), was = sizeOf(p.settings);
      const ok = await confirmBox({ title: `Change the ${k === "aspect" ? "aspect ratio" : "resolution"}?`,
        body: `Approved Shots keep their takes${was ? ` at ${was[0]}×${was[1]}` : ""}; new renders are ${sz ? `${sz[0]}×${sz[1]}` : "the new size"}. ` +
          "Shots under review render again.\n\nMixed sizes: Shots of different sizes aren't pinned to each other (a hard cut there), and " +
          "Update preview, the final video and Refine on export need every Shot at one size. Export approved clips works. " +
          "Setting the size back makes them match again.",
        yes: "Change size", no: "Keep as is" });
      if (!ok) return render();
      p.settings[k] = v;
      if (S.busy && busyHere() && S.busy.built) S.busy.built.staleSize = true;
      keepApproved(k === "megapixels" ? "Resolution" : "Aspect ratio");
      layoutStage();
      return commit();
    }
    if (changed && (k === "megapixels" || k === "aspect")) {
      const rendered = active().filter((x) => x.kind !== "clip" && x.status !== "queued");
      if (rendered.length || inRenderAny()) {
        const est = estimateFor(rendered);
        const ok = await confirmBox({ title: `Change the ${k === "aspect" ? "aspect ratio" : "resolution"}?`,
          body: (rendered.length ? `All ${rendered.length} rendered Shot${rendered.length > 1 ? "s" : ""} render again at the new size` +
            (est ? `, ${est}` : "") + "; their takes can't be used at another size (they stay in Take history). " : "") +
            (inRenderAny() ? "The render going now finishes at the old size; its Shots then render again too. " : "") +
            "Approvals are kept as a flag.",
          yes: "Change and re-render", no: "Keep as is" });
        if (!ok) return render();
      }
    }
    p.settings[k] = v;
    if (changed) {
      if (S.busy && busyHere() && S.busy.built) S.busy.built.staleSize = true;   // its takes come back at the old size
      sharedChanged(k === "megapixels" ? "Resolution" : k === "aspect" ? "Aspect ratio" : "Settings");
    }
    return commit();
  }
  if (el.dataset.turbo) {
    const k = el.dataset.turbo;
    let mode = "all";
    if (changed) { mode = await askSettingChange(k === "strength" ? "Change the Turbo strength" : "Change the Turbo LoRA"); if (!mode) return render(); }
    p.settings.turbo[k] = k === "strength" ? Number(el.value) : el.value;
    if (changed) applyRefChange(mode, "Turbo LoRA");
    return commit();
  }
  if (el.dataset.lora !== undefined) {
    const l = p.settings.loras[+el.dataset.lora];
    let mode = "all";
    if (changed && l.on) { mode = await askSettingChange(`Change LoRA ${+el.dataset.lora + 1}`); if (!mode) return render(); }
    l[el.dataset.k] = el.dataset.k === "strength" ? Number(el.value) : el.value || null;
    if (changed && l.on) applyRefChange(mode, "LoRAs");
    return commit();
  }
});

/** Item 9: a Shot's text, seconds or seed take effect while typing. A Shot that
 *  no longer matches its take shows "▶ Render Shot N"; typing it back to
 *  exactly what was rendered brings back its take and its state. */
function shotInput(el) {
  const s = shotOf(el);
  if (!s || el.readOnly) return;
  const k = el.dataset.shotField, key = s.id + ":" + k;
  delete S.bad[key];
  if (k === "text") s.text = el.value;
  else if (k === "seconds") {
    const v = parseFloat(el.value);
    if (Number.isFinite(v) && v >= 0.1) s.seconds = v; else S.bad[key] = true;
  } else if (k === "shot_seed") {
    const v = el.value.trim().toLowerCase();
    const n = v === "" || v === "auto" ? -1 : /^\d+$/.test(v) ? Number(v) : NaN;
    if (Number.isSafeInteger(n) && n >= -1) s.shot_seed = n; else S.bad[key] = true;
  }
  liveEdit(s);
  scheduleSave();
}

/** Only the prompt differs from what the take was rendered with (seconds and seed match). */
function promptOnlyChanged(s) {
  const r = s && s.rendered;
  return !!r && s.text !== r.text && Number(s.seconds) === Number(r.seconds) && Number(s.shot_seed) === Number(r.seed) &&
    !Object.keys(S.bad).some((k) => k.startsWith(s.id + ":"));
}

function matchesRendered(s) {
  const r = s.rendered;
  if (!r || Object.keys(S.bad).some((k) => k.startsWith(s.id + ":"))) return false;
  return s.text === r.text && Number(s.seconds) === Number(r.seconds) && Number(s.shot_seed) === Number(r.seed);
}

function liveEdit(s) {
  if (!s.bypassed && s.kind !== "clip") {
    const same = matchesRendered(s);
    const f = s.edit_from;
    if (s.status !== "queued" && !same) {
      s.edit_from = { status: s.status, was_approved: s.was_approved, was_rendered: s.was_rendered, take: s.take, gen: S.gen };
      s.status = "queued";
      S.dry = null;
    } else if (s.status === "queued" && same && f && f.gen === S.gen && f.take === s.take && s.take) {
      Object.assign(s, { status: f.status, was_approved: f.was_approved, was_rendered: f.was_rendered, edit_from: null });
      S.dry = null;
    }
  }
  refreshShotRow(s);
  renderDecision();
  renderPlan();
  renderHeader();
  renderViewer();
}

/** Leaving an edited Shot's field: say what the edit will do (once per edit). */
function shotEdited(s, field) {
  if (s.status !== "queued" || !s.edit_from || s.edit_from.told) return;
  s.edit_from.told = true;
  if (field === "seconds" && syncAfter(s, `${titleOf(s)} changed length`)) { render(); return; }
  const after = renderedAfter(s);
  if (after.length) {
    const n0 = numOf(after[0].id), n1 = numOf(after[after.length - 1].id);
    const range = after.length > 1 ? `Shots ${n0}–${n1}` : `Shot ${n0}`;
    toast(`${titleOf(s)} will re-render in place; ${range} keep${after.length > 1 ? "" : "s"} ${after.length > 1 ? "their takes" : "its take"}.`,
      { label: `Re-render ${range} too`, fn: () => { rippleAfter(s); commit(); } });
  }
}

function wrap(btn) {
  const box = btn.closest("[data-shot]").querySelector("textarea");
  if (!box) return;
  const before = btn.dataset.before, after = btn.dataset.after;
  const a = box.selectionStart ?? 0, b = box.selectionEnd ?? 0, v = box.value;
  if (a === b) {                     // nothing selected: an empty pair at the caret
    box.value = v.slice(0, a) + before + after + v.slice(a);
    box.selectionStart = box.selectionEnd = a + before.length;
  } else {
    const rep = before + v.slice(a, b).trim() + after;
    box.value = v.slice(0, a) + rep + v.slice(b);
    box.selectionStart = a;
    box.selectionEnd = a + rep.length;
  }
  box.focus();
  box.dispatchEvent(new Event("input", { bubbles: true }));
}

document.addEventListener("keydown", (e) => {
  if (S.swapped) return;
  if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "s") {
    e.preventDefault();
    saveNow();
    return;
  }
  if (!$("confirm").hidden) { if (e.key === "Escape") { e.preventDefault(); confirmDone(false); } return; }
  if (!$("lightbox").hidden) { lightboxKey(e); return; }
  if (!$("editor").hidden) {
    if (e.key === "Escape") { e.preventDefault(); closeEditor(); }
    else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); editorSave(); }
    return;
  }
  if (e.key === "Escape" && !$("menu").hidden) { closeMenu(); return; }
  if (e.key === "Escape" && !$("modal").hidden) { $("modal").hidden = true; return; }
  if (e.key === "Escape" && S.theater && !document.fullscreenElement) { setTheater(false); return; }
  const t = e.target;
  // the timeline scrubber is the player itself: Space and ← → act on it there too
  const onScrub = t.id === "scrub";
  if (!onScrub && t.closest && t.closest("input, textarea, select, [contenteditable]")) return;
  if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
    e.preventDefault();                             // not the browser's Back / Forward
    const sh = shotById(S.focus || S.open || "");
    if (sh) moveShot(sh, e.key === "ArrowLeft" ? -1 : 1);
    return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === "m" || e.key === "M") {
    e.preventDefault();
    if (previewing() && S.audioOpen) markPhrase();       // 0.11.0: M while the song plays marks a phrase
    else toggleMute();
  }
  else if (e.key === "f" || e.key === "F") { e.preventDefault(); toggleFullscreen(); }
  else if (e.key === "t" || e.key === "T") { e.preventDefault(); setTheater(!S.theater); }
  else if (e.key === " ") {
    e.preventDefault();
    if (audioSelected()) { previewing() ? stopPreview() : startPreview(); }   // 0.12.2: the song only
    else togglePlay();
  }
  else if (e.key === "ArrowLeft") { e.preventDefault(); stepFrame(-1); }
  else if (e.key === "ArrowRight") { e.preventDefault(); stepFrame(1); }
});

$("modal").addEventListener("click", (e) => { if (e.target === $("modal")) $("modal").hidden = true; });

// ---------------------------------------------------------------------------
// Projects, folders, toast
// ---------------------------------------------------------------------------

async function switchProject(slug) {
  while (S.applying) await new Promise((r) => setTimeout(r, 100));     // a queue job being saved
  if (P() && P().slug === slug) return;
  if (tabWith(slug)) {
    // 0.13.0: two tabs editing one project would save over each other
    toast("That project is open in another Studio tab. Switch to that tab, or open another project there first.");
    return;
  }
  await saveNow();
  try { await loadProject(slug); } catch (e) { toast("Couldn't open that project: " + e.message); }
}

function toggleMenu() {
  const m = $("menu");
  m.hidden = !m.hidden;
  $("project-btn").setAttribute("aria-expanded", !m.hidden);
  if (!m.hidden) m.querySelector("button").focus();
}
function closeMenu() { $("menu").hidden = true; $("project-btn").setAttribute("aria-expanded", "false"); }
document.addEventListener("click", (e) => {
  if (!$("menu").hidden && !e.target.closest(".project-menu")) closeMenu();
}, true);

function copyForNew() {
  const c = JSON.parse(JSON.stringify(P()));
  delete c.slug; delete c.saved_at;
  return c;
}

async function createProject(name, project) {
  if (setupGuard()) return;
  await saveNow();
  try {
    const made = await api("/longshot/projects", { method: "POST", body: { name, project } });
    await refreshProjects();
    await loadProject(made.slug);
  } catch (e) { toast("Couldn't create the project: " + e.message); }
}

async function newProject() {
  const name = (prompt("Name for the new project:", "New long shot") || "").trim();
  if (!name) return;
  const settings = JSON.parse(JSON.stringify(P() ? P().settings : DEFAULT_SETTINGS));
  createProject(name, { settings, cast: [], shots: [{ id: uid("s"), text: "", seconds: 5, status: "queued" }] });
}

async function saveAs() {
  const name = (prompt("Save a copy as:", P().name + " copy") || "").trim();
  if (name) createProject(name, Object.assign(copyForNew(), { name }));
}

async function duplicateProject() {
  createProject(P().name + " copy", Object.assign(copyForNew(), { name: P().name + " copy" }));
}

async function renameProject() {
  if (busyGuard()) return;
  const name = (prompt("Rename the project. Its input, takes and videos folders are renamed too:", P().name) || "").trim();
  if (!name || name === P().name) return;
  await saveNow();
  let res;
  try {
    res = await api(`/longshot/projects/${encodeURIComponent(P().slug)}/rename`,
      { method: "POST", body: { name, base: P().saved_at } });
  } catch (e) { toast(e.message); return; }
  const old = P().slug;
  for (const j of Q.jobs) if (j.slug === old) { j.slug = res.slug; j.name = name; }
  for (const g of Object.values(Q.groups)) if (g.slug === old) g.slug = res.slug;
  saveQueue();
  await loadProject(res.slug);
  await refreshProjects();
  renderHeader();
  toast(res.slug === old ? "Renamed." : `Renamed. Its files moved to input/longshot/${res.slug} and output/longshot/${res.slug}.`);
}

async function openList() {
  await refreshProjects();
  const when = (iso) => iso ? new Date(iso.slice(0, 19)).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "never";
  const rows = S.projects.map((p) => {
    const v = p.video;
    const thumb = v && v.workflow
      ? `<img alt="" loading="lazy" src="${esc(viewURL({ filename: v.workflow, subfolder: v.subfolder, type: v.type || "output" }))}" onerror="this.replaceWith(document.createTextNode('no preview'))">`
      : v && v.filename ? `<video muted playsinline preload="metadata" src="${esc(viewURL(v))}#t=0.5"></video>` : "no video";
    return `<button class="proj-row${p.slug === P().slug ? " current" : ""}" data-action="open-project" data-slug="${esc(p.slug)}">
      <span class="proj-thumb">${thumb}</span>
      <span class="proj-meta"><b>${esc(p.name)}</b>
        <span class="muted small">Saved ${esc(when(p.saved_at))} · ${p.approved} of ${p.shots} shots approved</span>
        ${p.slug !== P().slug && tabWith(p.slug) ? '<span class="missing-tag" title="Open in another Studio tab: switch to that tab to work on it.">open in another tab</span>' : ""}
        ${p.files_missing ? '<span class="missing-tag" title="Its input or output folder was deleted. Delete the project, or put the folder back.">files missing</span>' : ""}</span></button>`;
  }).join("") || '<div class="muted">No saved projects yet.</div>';
  showModal("Open project", null, rows);
}

function deleteDialog() {
  const local = S.local;
  showModal(`Delete "${P().name}"?`, null, `<p style="margin:0;color:var(--sub)">The project file is deleted. This can't be undone.</p>
    <div class="checks">
      <label${local ? "" : " hidden"}><input type="checkbox" id="del-segments"> Also delete its saved takes (output/longshot/${esc(P().slug)}/takes)</label>
      <label${local ? "" : " hidden"}><input type="checkbox" id="del-inputs"> Also delete its input folder (input/longshot/${esc(P().slug)})</label>
      <label${local ? "" : " hidden"}><input type="checkbox" id="del-videos"> Also delete its videos (output/longshot/${esc(P().slug)}/videos and its timeline clips)</label>
      ${local ? "" : '<span class="muted small">Files can only be deleted from the machine running ComfyUI.</span>'}
    </div>
    <div class="dialog-actions"><button class="ghost" data-action="close-modal">Keep it</button>
    <button class="danger-btn" data-action="confirm-delete">Delete</button></div>`);
}

// ---------------------------------------------------------------------------
// Export / import (on the machine running ComfyUI)
// ---------------------------------------------------------------------------

const mbSize = (b) => (b >= 1073741824 ? (b / 1073741824).toFixed(1) + " GB" : Math.max(0.1, b / 1048576).toFixed(1) + " MB");

async function exportDialog() {
  if (setupGuard()) return;
  await saveNow();
  let est = { references: 0, takes: 0, videos: 0, video_files: 0 };
  try { est = await api(`/longshot/export/${encodeURIComponent(P().slug)}/estimate`); } catch (e) { /* sizes unknown */ }
  showModal(`Export · ${P().name}`, "", `
    <p class="muted small">One .zip with the project and every file it uses: reference images, the song and video clips. Model files aren't included; the other machine finds its own by name.</p>
    <label class="check-row"><input type="checkbox" checked disabled> Project and references <span class="muted small">· ${mbSize(est.references)}</span></label>
    <label class="check-row"><input type="checkbox" id="exp-takes" checked> Include takes <span class="muted small">· ${mbSize(est.takes)} · approved Shots open already rendered, with their take history</span></label>
    <label class="check-row"><input type="checkbox" id="exp-video"${est.video_files ? "" : " disabled"}> Include videos <span class="muted small">· ${est.video_files
      ? `${est.video_files} file${est.video_files === 1 ? "" : "s"} · ${mbSize(est.videos)} · everything in output/longshot/${esc(P().slug)}/videos` : "none yet"}</span></label>
    <div class="dialog-actions"><button class="ghost" data-action="close-modal">Cancel</button>
      <button class="primary sm-primary" data-action="export-go">Export .zip</button></div>`);
}

function exportGo() {
  const q = `takes=${$("exp-takes").checked ? 1 : 0}&video=${$("exp-video").checked ? 1 : 0}`;
  const a = document.createElement("a");
  a.href = `/longshot/export/${encodeURIComponent(P().slug)}?${q}`;
  a.download = "";
  document.body.appendChild(a);
  a.click();
  a.remove();
  $("modal").hidden = true;
  toast("Preparing the export… your browser downloads it when it's ready.");
}

function pickImport() {
  if (setupGuard()) return;
  const inp = document.createElement("input");
  inp.type = "file";
  inp.accept = ".zip,application/zip";
  inp.addEventListener("change", () => { if (inp.files.length) importZip(inp.files[0]); });
  inp.click();
}

async function importZip(file) {
  if (!S.local) { toast("Projects can only be imported on the machine running ComfyUI."); return; }
  if (setupGuard()) return;
  await saveNow();
  toast(`Importing ${file.name}…`);
  const fd = new FormData();
  fd.append("file", file, file.name);
  let data = null;
  try {
    const res = await fetch("/longshot/import", { method: "POST", body: fd });
    try { data = await res.json(); } catch (e) { /* not JSON */ }
    if (!res.ok) throw new Error((data && data.error) || res.statusText);
  } catch (e) { toast("Import failed: " + e.message); return; }
  await refreshProjects();
  await loadProject(data.slug);
  const miss = (data.missing || []).length;
  toast(`Imported "${P().name}": ${data.files} file${data.files === 1 ? "" : "s"}` +
    (data.takes ? `, ${data.takes} take${data.takes === 1 ? "" : "s"}` : "") +
    (data.videos ? `, ${data.videos} video${data.videos === 1 ? "" : "s"}` : "") +
    (miss ? `. ${miss} file${miss > 1 ? "s were" : " was"} missing from the export.` : "."));
}

async function confirmDelete() {
  if (busyGuard()) return;
  const q = [];
  if ($("del-segments") && $("del-segments").checked) q.push("segments=1");
  if ($("del-inputs") && $("del-inputs").checked) q.push("inputs=1");
  if ($("del-videos") && $("del-videos").checked) q.push("videos=1");
  const slug = P().slug;
  clearTimeout(saveTimer);
  try {
    await api("/longshot/projects/" + slug + (q.length ? "?" + q.join("&") : ""), { method: "DELETE" });
  } catch (e) { toast("Couldn't delete: " + e.message); return; }
  // its waiting jobs can't run any more
  for (const j of Q.jobs) if (j.slug === slug && j.state === "waiting") { j.state = "skipped"; j.error = "Its project was deleted."; }
  saveQueue();
  renderQueue();
  $("modal").hidden = true;
  await refreshProjects();
  const next = S.projects[0];
  if (next) await loadProject(next.slug);
  else {
    const made = await api("/longshot/projects", { method: "POST", body: { name: "Untitled",
      project: { settings: P().settings, shots: [{ id: uid("s"), text: "", seconds: 5 }] } } });
    await refreshProjects();
    await loadProject(made.slug);
  }
  toast("Project deleted.");
}

/** Picking a file for a reference or the song. The same file (same hash),
 *  even moved to another folder, re-links silently with nothing to re-render. */
async function relinkFromSelect(el) {
  const p = P();
  const isAudio = el.dataset.relink === "audio";
  if (isAudio) stopPreview();
  const item = isAudio ? p.audio : castOf(el);
  const key = isAudio ? "audio" : item.id;
  if (setupGuard()) { render(); return; }
  if (!el.value) {
    let mode = "all";
    if (!isAudio && !item.bypassed) {
      mode = await askRefChange(`Clear ${item.label || "this reference"}'s picture?`);
      if (!mode) { render(); return; }
    }
    if (isAudio) { p.audio.file = null; p.audio.subfolder = ""; p.audio.sha256 = null; }
    else { item.image = ""; }
    S.refState[key] = undefined;
    if (!isAudio && !item.bypassed) applyRefChange(mode, "Cast & Scenes");
    if (isAudio && p.audio.voice_ref) sharedChanged("Audio");
    return commit();
  }
  const [sub, name] = splitChoice(el.value);
  let info = { state: "ok" };
  try { info = (await api("/longshot/check-inputs", { method: "POST", body: { files: [{ key, name, subfolder: sub }] } })).files[0]; }
  catch (e) { /* treat as ok; the render will say if not */ }
  const same = !!item.sha256 && info.sha256 === item.sha256;
  let mode = "all";
  if (!isAudio && !same && !item.bypassed) {
    mode = await askRefChange(`Use ${name} for ${item.label || "this reference"}?`);
    if (!mode) { render(); return; }
  }
  if (isAudio) {
    if (!item.file) item.song_ref = true;
    if (item.file !== name) item.phrases = [];             // markers belong to the song they were made on
    Object.assign(item, { file: name }); SCRUB.pos = null;
  }
  else Object.assign(item, { image: name });
  Object.assign(item, { subfolder: sub, original_name: name, sha256: info.sha256 || null,
    size_bytes: info.size_bytes ?? null });
  S.refState[key] = info.state === "missing" || info.state === "invalid" ? info.state : "ok";
  S.refInfo[key] = info;
  if (same) toast("Relinked — it's the same file, so nothing re-renders.");
  else if (isAudio) { if (p.audio.voice_ref) sharedChanged("Audio"); }
  else if (!item.bypassed) applyRefChange(mode, "Cast & Scenes");
  commit();
}

/** Item 7: ◀ ▶ under a reference step through the same list as its dropdown,
 *  wrapping at both ends. Approved Shots are kept (toast offers re-render all). */
const stepSeq = {};
async function stepRef(c, dir) {
  if (!c || setupGuard() || S.uploading[c.id]) return;
  const list = refChoices();
  if (!list.length) return;
  const cur = c.image ? list.findIndex((x) => x.sub === (c.subfolder || "") && x.name === c.image) : -1;
  const i = cur < 0 ? (dir > 0 ? 0 : list.length - 1) : (cur + dir + list.length) % list.length;
  const pick = list[i];
  const before = c.sha256;
  Object.assign(c, { image: pick.name, subfolder: pick.sub, original_name: pick.name, sha256: null, size_bytes: null });
  S.refState[c.id] = "ok";
  const seq = (stepSeq[c.id] = (stepSeq[c.id] || 0) + 1);
  renderCast();
  let info = null;
  try {
    info = (await api("/longshot/check-inputs", { method: "POST",
      body: { files: [{ key: c.id, name: pick.name, subfolder: pick.sub }] } })).files[0];
  } catch (e) { /* the render will say if the file is unreadable */ }
  if (stepSeq[c.id] !== seq || !P().cast.includes(c)) return;      // a later step took over
  if (info) {
    Object.assign(c, { sha256: info.sha256 || null, size_bytes: info.size_bytes ?? null });
    S.refState[c.id] = info.state === "missing" || info.state === "invalid" ? info.state : "ok";
    S.refInfo[c.id] = info;
  }
  const same = !!before && !!info && info.sha256 === before;
  if (!same && !c.bypassed) refChangedQuietly("Cast & Scenes");
  commit();
  if (editing && editing.id === c.id) showEditorImage(c);
}

// ---------------------------------------------------------------------------
// Dropping (or choosing) reference images: uploaded to input/longshot/<slug>/
// ---------------------------------------------------------------------------

const IMAGE_RE = /\.(png|jpe?g|webp|bmp|gif|tiff?)$/i;
const isImageFile = (f) => IMAGE_RE.test(f.name || "");

async function uploadImage(file) { return uploadFile(file, "images"); }

async function uploadFile(file, kind) {
  const fd = new FormData();
  fd.append("project", P().slug);
  fd.append("kind", kind);
  fd.append("file", file, file.name);
  const res = await fetch("/longshot/upload", { method: "POST", body: fd });
  let data = null;
  try { data = await res.json(); } catch (e) { /* not JSON */ }
  if (!res.ok) {
    throw new Error((data && data.error) || (res.status === 413
      ? "Too large for ComfyUI's upload limit (--max-upload-size)." : res.statusText || "upload failed"));
  }
  return data;
}

/** Point a reference at an uploaded file. True when it's the same picture it had. */
function applyUpload(c, info) {
  const same = !!c.sha256 && info.sha256 === c.sha256;
  Object.assign(c, { image: info.name, subfolder: info.subfolder, original_name: info.name,
    sha256: info.sha256, size_bytes: info.size_bytes });
  S.refState[c.id] = "ok";
  S.refInfo[c.id] = Object.assign({ state: "ok" }, info);
  return same;
}

/** targetId: replace that reference's image. None: add a reference per image. */
async function addImages(fileList, targetId) {
  const p = P();
  if (!p) return;
  const files = [...fileList];
  const imgs = files.filter(isImageFile);
  if (!imgs.length) { toast("Only image files can be references (PNG, JPG, WebP, BMP, GIF, TIFF)."); return; }
  if (setupGuard()) return;
  const target = targetId ? p.cast.find((x) => x.id === targetId) : null;
  if (target && S.uploading[target.id]) return;
  const list = target ? imgs.slice(0, 1) : imgs;
  const cards = list.map(() => {
    if (target) return target;
    const c = { id: uid("c"), label: "<new>", desc: "", role: "appearance", image: "", bypassed: false };
    p.cast.push(c);
    return c;
  });
  cards.forEach((c) => { S.uploading[c.id] = true; });
  render();
  let shared = false, same = 0, mode = "all";
  const failed = [];
  if (target && editing && editing.id === target.id) showEditorImage(target);
  const uploaded = await Promise.all(list.map(async (f, i) => {
    try { return await uploadImage(f); }
    catch (e) { failed.push(`${f.name}: ${e.message}`); return null; }
  }));
  // a different picture with approved Shots: keep them (default) or re-render all
  const changes = uploaded.some((info, i) => info && !(target && !!target.sha256 && info.sha256 === target.sha256) && !cards[i].bypassed);
  if (changes) mode = (await askRefChange(target ? `Replace ${target.label || "this reference"}'s picture?`
    : `Add ${uploaded.filter(Boolean).length > 1 ? "these references" : "this reference"}?`)) || (target ? null : "keep");
  uploaded.forEach((info, i) => {
    const c = cards[i];
    delete S.uploading[c.id];
    if (!info || (target && !mode)) {
      if (!target) p.cast.splice(p.cast.indexOf(c), 1);
      return;
    }
    const unchanged = applyUpload(c, info);
    if (target && unchanged) same++;            // a new reference always changes the prompt
    else if (!c.bypassed) shared = true;
  });
  await loadInputs();
  if (shared) applyRefChange(mode || "keep", "Cast & Scenes");
  commit();
  if (target && editing && editing.id === target.id) showEditorImage(target);
  const notes = [];
  if (target && changes && !mode) notes.push("Kept the picture it had.");
  if (failed.length) notes.push(`Couldn't upload ${failed.join("; ")}`);
  else if (target && same) notes.push("Same picture as before, so nothing re-renders.");
  else if (list.length > 1 && !shared) notes.push(`Added ${list.length} references.`);
  if (files.length > imgs.length) notes.push(`Skipped ${files.length - imgs.length} file${files.length - imgs.length > 1 ? "s" : ""} that ${files.length - imgs.length > 1 ? "aren't images" : "isn't an image"}.`);
  if (target && imgs.length > 1) notes.push("Only the first image replaced it; drop several on Add reference to add each one.");
  if (notes.length) toast(notes.join(" "));
  if (!target && list.length === 1 && !failed.length) openEditor(cards[0]);   // name the new reference
}

/** Dropping (or choosing) a song: it becomes the project's audio file. */
async function addAudio(fileList) {
  const p = P();
  const files = [...fileList];
  const f = files.find((x) => AUDIO_RE.test(x.name || ""));
  if (!f) { toast("Drop an audio file here (MP3, WAV, FLAC, OGG, M4A, AAC, Opus)."); return; }
  if (setupGuard()) return;
  S.audioOpen = true;
  stopPreview();
  S.uploading.audio = true;
  render();
  let info;
  try { info = await uploadFile(f, "audio"); }
  catch (e) { toast(`Couldn't upload ${f.name}: ${e.message}`); return; }
  finally { delete S.uploading.audio; }
  const same = !!p.audio.sha256 && info.sha256 === p.audio.sha256;
  if (!p.audio.file) p.audio.song_ref = true;
  if (p.audio.file !== info.name) p.audio.phrases = [];
  SCRUB.pos = null;
  Object.assign(p.audio, { file: info.name, subfolder: info.subfolder, original_name: info.name,
    sha256: info.sha256, size_bytes: info.size_bytes });
  S.refState.audio = "ok";
  S.refInfo.audio = Object.assign({ state: "ok" }, info);
  await loadInputs();
  if (!same && p.audio.voice_ref) sharedChanged("Audio");
  commit();
  toast(same ? "Same song as before — nothing re-renders." : `${info.name} is the project's audio now.`);
}

function pickAudio() {
  if (setupGuard()) return;
  const inp = document.createElement("input");
  inp.type = "file";
  inp.accept = "audio/*";
  inp.addEventListener("change", () => { if (inp.files.length) addAudio(inp.files); });
  inp.click();
}

function pickImages(targetId) {
  if (setupGuard()) return;
  const inp = document.createElement("input");
  inp.type = "file";
  inp.accept = "image/*";
  inp.multiple = !targetId;
  inp.addEventListener("change", () => { if (inp.files.length) addImages(inp.files, targetId); });
  inp.click();
}

const dragHasFiles = (e) => !!e.dataTransfer && [...e.dataTransfer.types].includes("Files");
let dropEl = null;

/** Where a drop would land: a card (replace) or the panel / Add tile (add). */
const AUDIO_RE = /\.(mp3|wav|flac|ogg|m4a|aac|opus|wma)$/i;
const VIDEO_RE = /\.(mp4|mov|webm|mkv|m4v|avi)$/i;
const DROP_PANELS = ["#cast-panel", "#audio-panel", "#shots-panel"];

/** Where a drop would land: a reference card (replace) or Cast & Scenes (add),
 *  the Audio panel (the song), or the Shots list (a video clip). */
function dropTargetOf(e) {
  if (!P() || !e.target.closest) return null;
  if (editing && editing.kind === "cast" && !$("editor").hidden) {
    // Item 8: anywhere on the open editor replaces its image; nothing behind it
    return e.target.closest("#editor") ? { zone: "cast", el: $("editor").querySelector(".editor"), id: editing.id } : null;
  }
  const cast = e.target.closest("#cast-panel");
  if (cast) {
    const vc = e.target.closest("[data-voice]");
    if (vc) return { zone: "cast", el: vc, id: null, voice: vc.dataset.voice };
    const card = e.target.closest("[data-cast]");
    return card ? { zone: "cast", el: card, id: card.dataset.cast }
      : { zone: "cast", el: cast.querySelector("[data-drop=add]") || cast, id: null };
  }
  const audio = e.target.closest("#audio-panel");
  if (audio) return { zone: "audio", el: audio, id: null };
  const slot = e.target.closest("[data-anchor]");
  if (slot) return { zone: "anchor", el: slot, id: slot.dataset.anchor };
  const shots = e.target.closest("#shots-panel");
  if (shots) {
    const card = e.target.closest("[data-shot]");
    return card ? { zone: "shots", el: card, id: card.dataset.shot } : { zone: "shots", el: shots, id: null };
  }
  return null;
}

function clearDrop() {
  if (dropEl) dropEl.classList.remove("drop-target");
  dropEl = null;
  DROP_PANELS.forEach((sel) => { const el = document.querySelector(sel); if (el) el.classList.remove("dragging"); });
}

window.addEventListener("dragover", (e) => {
  if (!dragHasFiles(e)) return;
  e.preventDefault();                 // a missed drop must never replace the Studio page with the file
  const t = dropTargetOf(e);
  e.dataTransfer.dropEffect = "copy";        // a project .zip can go anywhere
  DROP_PANELS.forEach((sel) => { const el = document.querySelector(sel); if (el) el.classList.add("dragging"); });
  const el = t ? t.el : null;
  if (el !== dropEl) {
    if (dropEl) dropEl.classList.remove("drop-target");
    if (el) el.classList.add("drop-target");
    dropEl = el;
  }
});
window.addEventListener("dragleave", (e) => { if (!e.relatedTarget) clearDrop(); });
window.addEventListener("dragend", clearDrop);
window.addEventListener("drop", (e) => {
  if (!dragHasFiles(e)) return;
  e.preventDefault();
  const zip = [...e.dataTransfer.files].find((x) => /\.zip$/i.test(x.name || ""));
  if (zip) { clearDrop(); importZip(zip); return; }
  const t = dropTargetOf(e);
  clearDrop();
  if (!t) return;
  if (t.zone === "cast") {
    const fl = [...e.dataTransfer.files];
    // audio files on Cast & Scenes are voice references (a voice card: replace its file)
    if (t.voice || (fl.some((x) => AUDIO_RE.test(x.name || "")) && !fl.some(isImageFile))) addVoices(fl, t.voice || null);
    else addImages(e.dataTransfer.files, t.id);
  }
  else if (t.zone === "audio") addAudio(e.dataTransfer.files);
  else if (t.zone === "shots") addClipFiles(e.dataTransfer.files, t.id);
  else if (t.zone === "anchor") anchorUpload(t.id, e.dataTransfer.files);
});

async function clearSegments() {
  if (busyGuard()) return;
  const st = S.segStats || { files: 0, bytes: 0 };
  if (!confirm(`Delete all ${st.files} saved take file${st.files === 1 ? "" : "s"} (${(st.bytes / 1048576).toFixed(1)} MB) for "${P().name}"? ` +
      "Rendered Shots keep their status, but every Shot has to render again (Shots still in ComfyUI's memory come back until it restarts).")) return;
  try { S.segStats = await api("/longshot/clear-segments", { method: "POST", body: { project: P().slug } }); }
  catch (e) { toast(e.message); return; }
  for (const x of P().shots) { x.take = null; }
  S.takes = {};
  S.dry = null;
  commit();
  toast("All takes deleted.");
}

async function openFolder(which) {
  const lo = last();
  let select = null, subfolder = null, fallback = null;
  if (which === "output") {
    // 0.8.4: Approved_Clips first, with the focused Shot's exported clip selected
    const s = shotById(S.focus) || reviewShot();
    const ap = s ? approvedForExport().find((x) => x.s.id === s.id) : null;
    subfolder = `longshot/${P().slug}/Approved_Clips`;
    select = ap ? ap.name + ".mp4" : null;
    // nothing exported yet: the latest video, else the clips folder with the focused Shot's clip
    if (lo && lo.video) fallback = { subfolder: lo.video.subfolder, select: lo.video.filename };
    else {
      const key = s && s.kind !== "clip" && s.take ? takeStem(s.take) : null;
      fallback = { subfolder: `longshot/${P().slug}/clips`, select: key && S.clips[key] ? key + ".mp4" : null };
    }
  }
  try {
    await api("/longshot/open-folder", { method: "POST", body: { which, project: P().slug, select, subfolder, fallback } });
  } catch (e) { toast(e.message); }
}

let toastTimer = null;
let toastAction = null;
function toast(msg, action) {
  const t = $("toast");
  t.textContent = msg;
  toastAction = null;
  if (action) {
    const b = document.createElement("button");
    b.className = "toast-act";
    b.textContent = action.label;
    b.addEventListener("click", () => { t.hidden = true; action.fn(); });
    t.appendChild(b);
    toastAction = action;
  }
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, action ? 10000 : 6000);
}

function showModal(title, text, html) {
  $("modal-title").textContent = title;
  const body = $("modal-body");
  if (html !== undefined) body.innerHTML = html;
  else {
    body.innerHTML = '<pre class="plan-text"></pre>';
    body.firstChild.textContent = text || "";
  }
  $("modal").hidden = false;
}

// ---------------------------------------------------------------------------
// Confirm dialog and estimates
// ---------------------------------------------------------------------------

let confirmResolve = null;
function confirmBox({ title, body, yes = "Continue", no = "Cancel", check = null, alt = null, html = false }) {
  return new Promise((resolve) => {
    if (confirmResolve) confirmDone(false);           // only one question at a time
    $("confirm-title").textContent = title;
    if (html) $("confirm-body").innerHTML = body;     // built from escaped text only
    else $("confirm-body").textContent = body;
    $("confirm-alt").hidden = !alt;                   // a second answer: resolves "alt"
    $("confirm-alt").textContent = alt || "";
    const row = $("confirm-check-row");
    row.hidden = !check;
    if (check) { $("confirm-check-label").textContent = check; $("confirm-check").checked = false; }
    $("confirm-yes").textContent = yes;
    $("confirm-no").textContent = no;
    confirmResolve = resolve;
    const host = document.fullscreenElement || document.querySelector(".app");
    host.appendChild($("confirm"));
    $("confirm").hidden = false;
    $("confirm-yes").focus();
  });
}
function confirmDone(v) {
  $("confirm").hidden = true;
  const r = confirmResolve;
  confirmResolve = null;
  const asked = !$("confirm-check-row").hidden;
  if (r) r(asked ? { ok: v, checked: v && $("confirm-check").checked } : v);
}
$("confirm-yes").addEventListener("click", () => confirmDone(true));
$("confirm-no").addEventListener("click", () => confirmDone(false));
$("confirm-alt").addEventListener("click", () => confirmDone("alt"));
$("confirm").addEventListener("click", (e) => { if (e.target === $("confirm")) confirmDone(false); });

/** "about N min" for re-rendering these Shots, from measured speed. */
function estimateFor(shots) {
  const rate = P().stats.rate;
  if (!rate) return "";
  const secs = shots.reduce((a, s) => a + ((lastRowFor(s.id) || {}).seconds || Number(s.seconds) || 0), 0);
  const min = (rate * secs) / 60;
  return min < 1 ? "under a minute" : `about ${Math.round(min)} min`;
}

/** Shared changes: confirm when rendered Shots would render again. */
async function confirmShared(what, shots) {
  const rendered = shots || active().filter((s) => s.status !== "queued");
  if (!rendered.length) return true;
  const est = estimateFor(rendered);
  const approved = rendered.filter((s) => s.status === "approved").length;
  return confirmBox({ title: `Change ${what}?`,
    body: `This re-renders all ${rendered.length} rendered Shot${rendered.length > 1 ? "s" : ""}` +
      (approved ? ` (${approved} approved)` : "") + (est ? `, ${est}` : "") +
      ". Approvals are kept as a flag so you can re-render through them in one go.",
    yes: "Re-render", no: "Keep as is" });
}

// ---------------------------------------------------------------------------
// C.1 Base seed
// ---------------------------------------------------------------------------

/** Drag the Seed field left / right to step the seed down / up (one per 4 px,
 *  ten with Shift held). A click without dragging types in it as usual. */
document.addEventListener("pointerdown", (e) => {
  const el = e.target.closest && e.target.closest("[data-base-seed]");
  if (!el || e.button !== 0) return;
  const x0 = e.clientX, v0 = Number(el.value) || 0;
  let dragging = false;
  const move = (ev) => {
    const dx = ev.clientX - x0;
    if (!dragging && Math.abs(dx) < 4) return;
    if (!dragging) { dragging = true; el.blur(); document.body.classList.add("seed-dragging"); }
    ev.preventDefault();
    const step = ev.shiftKey ? 10 : 1;
    el.value = String(Math.max(0, Math.min(SEED_MAX, v0 + Math.round(dx / 4) * step)));
  };
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", up);
    document.body.classList.remove("seed-dragging");
    if (dragging) changeBaseSeed(el).then(() => renderSettings());
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", up);
});

/** ▲ ▼ next to a seed: one up or down (0.9.2). */
function seedStepHTML(action, disabled, note) {
  const dis = disabled ? " disabled" : "";
  const tip = (d) => `Seed ${d > 0 ? "+1" : "−1"}${note ? ` (${note})` : ""}`;
  return `<span class="seed-step"><button type="button" class="ghost xs" data-action="${action}" data-d="1"${dis} title="${esc(tip(1))}" aria-label="${esc(tip(1))}">▲</button>` +
    `<button type="button" class="ghost xs" data-action="${action}" data-d="-1"${dis} title="${esc(tip(-1))}" aria-label="${esc(tip(-1))}">▼</button></span>`;
}

/** A Shot's seed ±1. On auto, it takes its own seed from the one its last take used
 *  (or the next it would get) and stops following Settings. */
function stepShotSeed(s, d) {
  if (!s || s.kind === "clip") return;
  let cur = Number(s.shot_seed);
  if (!(cur >= 0)) cur = hasSeed(s.seed_used) ? Number(s.seed_used)
    : hasSeed(s.seed_pending) ? Number(s.seed_pending) : Number(P().settings.seed) || 0;
  useSeed(s, Math.max(0, Math.min(SEED_MAX, cur + d)));
}

async function changeBaseSeed(el) {
  const s = P().settings;
  const v = el.value.trim();
  const n = Number(v);
  if (!/^\d+$/.test(v) || !Number.isSafeInteger(n)) {
    toast("The seed is a whole number, 0 or more.");
    el.value = s.seed;
    return;
  }
  if (n === Number(s.seed)) return;
  if (setupGuard()) { el.value = s.seed; return; }
  // The next seed a Shot on auto takes: nothing rendered changes
  s.seed = n;
  S.dry = null;
  commit();
}

// ---------------------------------------------------------------------------
// C.3 Reference editor and lightbox
// ---------------------------------------------------------------------------

let editing = null;
function picOf(c) {
  if (c.bypassed) return "bypassed";
  return `<Picture ${liveCast().indexOf(c) + 1}>`;
}

function openEditor(c) {
  if (!c) return;
  editing = { kind: "cast", id: c.id };
  $("editor-cast").hidden = false;
  $("editor-alt").hidden = true;
  $("editor-title").textContent = "Edit reference";
  $("editor-pic").textContent = picOf(c);
  $("editor-label").value = c.label;
  $("editor-desc").value = c.desc;
  fillEditorVoice(c);
  showEditorImage(c);
  $("editor").hidden = false;
  autoGrow($("editor-desc"));
  const d = $("editor-desc");
  d.focus();
  d.selectionStart = d.selectionEnd = d.value.length;
}

/** 0.12.0: the same pop-out editor for an audio reference or a RefMod. */
function voiceOptions(current, skip) {
  const ch = voiceChoices().filter((x) => x.key !== skip);
  return `<option value="">None</option>` + ch.map((x) =>
    `<option value="${esc(x.key)}"${x.key === current ? " selected" : ""}>${esc(x.label || "(off)")} ${esc(x.name)}</option>`).join("")
    + (current && !ch.some((x) => x.key === current) ? `<option value="${esc(current)}" selected>(removed)</option>` : "");
}
function openAltEditor(kind, id, html, title) {
  editing = { kind, id };
  $("editor-cast").hidden = true;
  const alt = $("editor-alt");
  alt.hidden = false;
  alt.innerHTML = html;
  $("editor-title").textContent = title;
  $("editor").hidden = false;
  const f = alt.querySelector("[data-ed=label]");
  if (f) { f.focus(); f.selectionStart = f.selectionEnd = f.value.length; }
  editorAltSync();
}
function openVoiceEditor(v) {
  if (!v) return;
  const a = audioLabelOf(v), state = S.refState["voice:" + v.id];
  const missing = !!v.file && (state === "missing" || state === "invalid");
  const src = v.file && !missing ? viewURL({ filename: v.file, subfolder: v.subfolder, type: "input" }) : "";
  const role = v.role || "voice";
  const pics = [...P().cast.map((c) => ({ key: "cast:" + c.id, name: (c.bypassed ? "(off) " : picOf(c) + " ") + (c.label || ""), on: c.voice === v.id })),
    ...(P().refmods || []).filter((m) => m.kind !== "audio").map((m) => ({ key: "refmod:" + m.id, name: (refmodLabelOf(m) || "(off)") + " " + (m.label || m.name) + " · RefMod", on: m.voice === v.id }))];
  openAltEditor("voice", v.id, `
    <div class="ed-form">
      <div><span class="pic">${esc(v.bypassed ? "bypassed" : a || "—")}</span> <span class="muted small">set automatically from the order of active audio</span></div>
      <label class="lbl">Label <input class="field" data-ed="label" value="${esc(v.label)}" placeholder="<sfx>" spellcheck="false"></label>
      <div class="ed-row">
        <label class="lbl">What it is
          <select class="field" data-ed="role">${AUDIO_ROLES.map(([k, t]) => `<option value="${k}"${k === role ? " selected" : ""}>${esc(t)}</option>`).join("")}</select></label>
        <label class="lbl ed-other">Its role, in your words <input class="field" data-ed="role_text" value="${esc(v.role_text)}" placeholder="sound" spellcheck="false"></label>
        <label class="lbl ed-sound">Use
          <select class="field" data-ed="use"><option value="reference"${v.use !== "copy" ? " selected" : ""}>Reference (the character of the sound)</option>
            <option value="copy"${v.use === "copy" ? " selected" : ""}>Copy (reuse the audio as it is)</option></select></label>
      </div>
      <label class="lbl ed-sound">Description <textarea class="field" data-ed="desc" rows="3" placeholder="cars driving by">${esc(v.desc)}</textarea></label>
      <div class="muted small ed-sound ed-preview"></div>
      ${missing ? `<div class="missing">Missing: ${esc(v.original_name || v.file)}</div>`
        : src ? `<audio class="ed-player" id="ed-player" controls preload="metadata" src="${esc(src)}"></audio>` : ""}
      <div class="ed-row">
        <label class="lbl-row">Start <input type="number" min="0" step="0.01" data-ed="start" value="${esc(v.start || 0)}" style="width:78px"> s</label>
        <button class="ghost sm" data-action="ed-set-start" title="Start where the player is">Set start</button>
        <label class="lbl-row">Length <input type="number" min="0" step="0.01" data-ed="length" value="${v.length ? esc(v.length) : ""}" placeholder="all" style="width:78px"> s</label>
        <button class="ghost sm" data-action="ed-set-end" title="End where the player is">Set end</button>
      </div>
      <div class="muted small">${esc(v.original_name || v.file || "No file")} <button class="ghost sm" data-action="voice-replace" data-voice="${esc(v.id)}">Replace file…</button></div>
      <div class="ed-voice">
        <div class="lbl">Voice timbre of</div>
        ${pics.length ? `<div class="ed-links">${pics.map((x) => `<label class="lbl-row"><input type="checkbox" data-ed-link="${esc(x.key)}"${x.on ? " checked" : ""}> ${esc(x.name)}</label>`).join("")}</div>`
          : '<div class="muted small">No pictures or RefMods yet.</div>'}
      </div>
    </div>`, "Edit audio reference");
}
function openRefmodEditor(m) {
  if (!m) return;
  openAltEditor("refmod", m.id, `
    <div class="ed-form">
      <div><span class="pic">${esc(m.bypassed ? "bypassed" : refmodLabelOf(m) || "—")}</span> <span class="muted small">RefMod · ${esc(m.kind)}</span></div>
      <label class="lbl">Label <input class="field" data-ed="label" value="${esc(m.label)}" placeholder="<name>" spellcheck="false"></label>
      <label class="lbl">Description <textarea class="field" data-ed="desc" rows="5" placeholder="Add a description…">${esc(m.desc)}</textarea></label>
      <div class="ed-row">
        <label class="lbl">RefMod <select class="field" data-ed="name"><option value="${esc(m.name)}" data-kind="${esc(m.kind)}">${esc(m.name)}</option></select></label>
        <label class="lbl">Kind <input class="field" data-ed="kind" value="${esc(m.kind)}" readonly tabindex="-1" style="width:90px"></label>
        <label class="lbl">Strength <input class="field" type="number" min="0" max="1" step="0.05" data-ed="strength" value="${esc(m.strength)}" style="width:90px"></label>
      </div>
      <label class="lbl ed-mrole">Definition: whose … comes from ${esc(refmodLabelOf(m) || "it")}
        <select class="field" data-ed="role">${REFMOD_ROLES.map((r) => `<option value="${r}"${r === refmodRole(m) ? " selected" : ""}>${r}</option>`).join("")}</select></label>
      <div class="editor-voice ed-mvoice">
        <label class="lbl-row" for="ed-mvoice">gets its voice timbre from</label>
        <select id="ed-mvoice" data-ed="voice">${voiceOptions(m.voice || "", "refmod:" + m.id)}</select>
      </div>
    </div>`, "Edit RefMod");
  api("/refmods/library").then((lib) => {      // the names to swap to, same as Add RefMod lists
    const sel = $("editor-alt").querySelector("[data-ed=name]");
    if (!sel || !editing || editing.id !== m.id) return;
    const rows = (lib || []).filter((x) => x.kind !== "bundle");
    if (!rows.some((x) => x.name === m.name)) rows.unshift({ name: m.name, kind: m.kind });
    const cur = sel.value;
    sel.innerHTML = rows.map((x) => `<option value="${esc(x.name)}" data-kind="${esc(x.kind)}">${esc(x.name)} (${esc(x.kind)})</option>`).join("");
    sel.value = cur;
  }).catch(() => {});
}
/** Show or hide the parts that depend on what's picked. */
function editorAltSync() {
  const alt = $("editor-alt");
  if (!editing || editing.kind === "cast") return;
  const g = (k) => alt.querySelector(`[data-ed=${k}]`);
  if (editing.kind === "voice") {
    const role = g("role").value;
    alt.querySelectorAll(".ed-sound").forEach((x) => { x.hidden = role === "voice"; });
    alt.querySelectorAll(".ed-other").forEach((x) => { x.hidden = role !== "other"; });
    alt.querySelectorAll(".ed-voice").forEach((x) => { x.hidden = role !== "voice"; });
    const v = voiceById(editing.id), pv = alt.querySelector(".ed-preview");
    if (pv && v) pv.textContent = role === "voice" ? "" : "In the prompt: " + soundLine({ label: g("label").value, desc: g("desc").value,
      role, role_text: g("role_text").value }, audioLabelOf(v) || "<Audio N>");
  } else {
    const opt = g("name").selectedOptions[0];
    const kind = (opt && opt.dataset.kind) || g("kind").value;
    g("kind").value = kind;
    alt.querySelector(".ed-mvoice").hidden = kind === "audio";
    alt.querySelector(".ed-mrole").hidden = kind === "audio";
  }
}
/** "<sfx> is cars driving by, whose sound comes from <Audio 2>." — same as the prompt writes. */
function soundLine(v, a) {
  const word = { sfx: "sound", ambience: "ambience", music: "music" }[v.role] || (v.role_text || "sound").trim() || "sound";
  return `${(v.label || "").trim() || a} is ${(v.desc || "").trim() || "this audio"}, whose ${word} comes from ${a}.`;
}
function editorAltValues() {
  const out = {};
  $("editor-alt").querySelectorAll("[data-ed]").forEach((el) => { out[el.dataset.ed] = el.value; });
  out.links = {};
  $("editor-alt").querySelectorAll("[data-ed-link]").forEach((el) => { out.links[el.dataset.edLink] = el.checked; });
  return out;
}
/** The edits as changes: [[object, key, value]] where the value differs. */
function editorAltChanges() {
  const val = editorAltValues(), ch = [];
  if (editing.kind === "voice") {
    const v = voiceById(editing.id);
    if (!v) return [];
    for (const k of ["label", "role", "role_text", "desc", "use"]) if ((val[k] ?? "") !== (v[k] ?? "")) ch.push([v, k, val[k]]);
    for (const k of ["start", "length"]) {
      const n = Math.max(0, Number(val[k]) || 0);
      if (n !== Number(v[k] || 0)) ch.push([v, k, n]);
    }
    if (val.role === "voice") {
      for (const [key, on] of Object.entries(val.links)) {
        const [kind, id] = key.split(/:(.*)/s);
        const o = kind === "cast" ? P().cast.find((x) => x.id === id) : (P().refmods || []).find((x) => x.id === id);
        if (!o) continue;
        if (on && o.voice !== v.id) ch.push([o, "voice", v.id]);
        if (!on && o.voice === v.id) ch.push([o, "voice", null]);
      }
    }
  } else {
    const m = (P().refmods || []).find((x) => x.id === editing.id);
    if (!m) return [];
    for (const k of ["label", "desc", "name", "kind"]) if ((val[k] ?? "") !== (m[k] ?? "")) ch.push([m, k, val[k]]);
    const st = Math.max(0, Math.min(1, Number(val.strength) || 0));
    if (st !== m.strength) ch.push([m, "strength", st]);
    if (val.kind !== "audio" && val.role !== refmodRole(m)) ch.push([m, "role", val.role]);
    const vo = val.kind === "audio" ? null : (val.voice || null);
    if (vo !== (m.voice || null)) ch.push([m, "voice", vo]);
  }
  return ch;
}

/** The editor's picture (and file name), e.g. after an image is dropped on it. */
function showEditorImage(c) {
  const missing = ["missing", "invalid"].includes(S.refState[c.id]);
  $("editor-img").innerHTML = S.uploading[c.id] ? "<span>Uploading…</span>"
    : c.image && !missing
      ? `<img alt="" src="${esc(viewURL({ filename: c.image, subfolder: c.subfolder, type: "input" }))}">`
      : `<span>${missing ? "Missing: " + esc(c.original_name || c.image) : "No image chosen"}</span>`;
  $("editor-file").textContent = c.image ? (c.subfolder ? c.subfolder + "/" : "") + c.image +
    " · drop an image here to replace it" : "Drop an image here to use it";
}

/** "gets its voice timbre from": None, or one of the voice references. */
function fillEditorVoice(c) {
  const sel = $("editor-voice");
  const n = voiceChoices().length;
  sel.innerHTML = voiceOptions(c.voice || "");
  sel.value = c.voice || "";
  $("editor-voice-row").classList.toggle("empty", !n);
  $("editor-voice-hint").textContent = n ? "" : "Add an audio reference (voice timbre) or an audio RefMod first.";
}

function editorDirty() {
  if (!editing) return false;
  if (editing.kind !== "cast") return editorAltChanges().length > 0;
  const c = P().cast.find((x) => x.id === editing.id);
  return !!c && ($("editor-label").value !== c.label || $("editor-desc").value !== c.desc ||
    ($("editor-voice").value || null) !== (c.voice || null));
}

function closeEditor() {
  const pl = $("ed-player");
  if (pl) pl.pause();
  $("editor").hidden = true;
  $("editor-alt").innerHTML = "";
  editing = null;
}

async function editorSave() {
  if (editing && editing.kind !== "cast") return editorAltSave();
  const c = editing && P().cast.find((x) => x.id === editing.id);
  if (!c) return closeEditor();
  if (!editorDirty()) return closeEditor();
  if (setupGuard()) return;
  const mode = await askRefChange();
  c.label = $("editor-label").value;
  c.desc = $("editor-desc").value;
  c.voice = $("editor-voice").value || null;
  if (!c.bypassed) applyRefChange(mode, "Cast & Scenes");
  closeEditor();
  commit();
}

async function editorAltSave() {
  const ch = editorAltChanges();
  if (!ch.length) return closeEditor();
  if (setupGuard()) return;
  const own = editing.kind === "voice" ? voiceById(editing.id) : (P().refmods || []).find((x) => x.id === editing.id);
  // a voice reference's label isn't in the prompt (its pictures' labels are); everything else is
  const quiet = ch.every(([o, k]) => o === own && k === "label" && editing.kind === "voice" && (own.role || "voice") === "voice");
  const live = own && !own.bypassed;
  const mode = !quiet && live ? await askRefChange() : "keep";
  for (const [o, k, val] of ch) o[k] = val;
  if (!quiet && live) applyRefChange(mode || "keep", editing.kind === "voice" ? "Audio references" : "RefMods");
  closeEditor();
  commit();
}

$("editor-alt").addEventListener("input", () => editorAltSync());
$("editor-alt").addEventListener("change", () => editorAltSync());
$("editor").addEventListener("click", async (e) => {
  if (e.target !== $("editor")) return;
  if (editorDirty() && !(await confirmBox({ title: "Discard your edits?",
    body: "The label and description changes in this dialog haven't been saved.",
    yes: "Discard", no: "Keep editing" }))) return;
  closeEditor();
});

let fitTimer = null;
window.addEventListener("resize", () => { clearTimeout(fitTimer); fitTimer = setTimeout(() => fitAll(), 60); });

function autoGrow(el) {
  el.style.height = "auto";
  el.style.height = Math.max(180, el.scrollHeight + 2) + "px";
}

let lb = null;
function lightboxList() {
  return P().cast.filter((c) => c.image && !["missing", "invalid"].includes(S.refState[c.id]));
}
function openLightbox(id) {
  const list = lightboxList();
  const i = list.findIndex((c) => c.id === id);
  if (i < 0) return;
  lb = { i, s: 1, x: 0, y: 0, fit: 1 };
  $("lightbox").hidden = false;
  showLightbox();
}
function showLightbox() {
  const list = lightboxList();
  const c = list[lb.i];
  $("lb-pic").textContent = picOf(c);
  $("lb-title").textContent = c.label;
  $("lb-file").textContent = `${c.subfolder ? c.subfolder + "/" : ""}${c.image} · fits ${P().settings.ref_resize_px} × ${P().settings.ref_resize_px} for H3`;
  const img = $("lb-img");
  img.onload = () => {
    const st = $("lb-stage").getBoundingClientRect();
    lb.fit = Math.min(st.width / img.naturalWidth, st.height / img.naturalHeight, 1);
    Object.assign(lb, { s: lb.fit, x: 0, y: 0 });
    applyLightbox();
  };
  img.src = viewURL({ filename: c.image, subfolder: c.subfolder, type: "input" });
}
function applyLightbox() {
  const img = $("lb-img");
  const w = img.naturalWidth * lb.s, h = img.naturalHeight * lb.s;
  img.style.width = w + "px";
  img.style.height = h + "px";
  img.style.transform = `translate(${-w / 2 + lb.x}px, ${-h / 2 + lb.y}px)`;
}
function closeLightbox() { $("lightbox").hidden = true; lb = null; }
function lightboxKey(e) {
  const n = lightboxList().length;
  if (e.key === "Escape") { e.preventDefault(); closeLightbox(); }
  else if (e.key === "ArrowRight" && n) { e.preventDefault(); lb.i = (lb.i + 1) % n; showLightbox(); }
  else if (e.key === "ArrowLeft" && n) { e.preventDefault(); lb.i = (lb.i - 1 + n) % n; showLightbox(); }
}
$("lb-stage").addEventListener("wheel", (e) => {
  if (!lb) return;
  e.preventDefault();
  const r = $("lb-stage").getBoundingClientRect();
  const cx = e.clientX - r.left - r.width / 2, cy = e.clientY - r.top - r.height / 2;
  const s2 = Math.min(8, Math.max(lb.fit * 0.5, lb.s * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
  lb.x = cx - (cx - lb.x) * (s2 / lb.s);
  lb.y = cy - (cy - lb.y) * (s2 / lb.s);
  lb.s = s2;
  applyLightbox();
}, { passive: false });
$("lb-stage").addEventListener("pointerdown", (e) => {
  if (!lb) return;
  const st = $("lb-stage");
  st.setPointerCapture(e.pointerId);
  st.classList.add("dragging");
  const start = { x: e.clientX, y: e.clientY, ox: lb.x, oy: lb.y };
  const move = (ev) => { lb.x = start.ox + ev.clientX - start.x; lb.y = start.oy + ev.clientY - start.y; applyLightbox(); };
  const up = () => { st.classList.remove("dragging"); st.removeEventListener("pointermove", move); st.removeEventListener("pointerup", up); };
  st.addEventListener("pointermove", move);
  st.addEventListener("pointerup", up);
});
$("lb-stage").addEventListener("dblclick", () => { if (lb) { Object.assign(lb, { s: lb.fit, x: 0, y: 0 }); applyLightbox(); } });
$("lightbox").addEventListener("click", (e) => { if (e.target === $("lightbox")) closeLightbox(); });

// ---------------------------------------------------------------------------
// C.4 Theater and full screen
// ---------------------------------------------------------------------------

S.theater = false;
function setTheater(on) {
  const st = $("stage");
  if (document.fullscreenElement) return;
  if (on) $("theater-slot").appendChild(st);
  else document.querySelector(".col-right").prepend(st);
  st.classList.toggle("theater", on);
  S.theater = on;
  $("theater-btn").setAttribute("aria-pressed", on);
  layoutStage();
  if (on) window.scrollTo({ top: 0 });
}

async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await $("stage").requestFullscreen();
  } catch (e) { toast("Full screen isn't available here."); }
}

// Full screen: the bar shows while the mouse is near the bottom (or over the bar,
// dragging the scrubber, or a control has the keyboard focus) and hides shortly
// after it leaves; the cursor hides after a moment without moving.
const FS = { hideT: null, idleT: null, y: null };
const fsOn = () => document.fullscreenElement === $("stage");
function fsShow(on) {
  $("stage").classList.toggle("fs-hide", !on);
}
function fsKeep() {
  const st = $("stage"), a = document.activeElement;
  const barTop = window.innerHeight - (parseFloat(st.style.getPropertyValue("--bar-h")) || 160) - 40;
  return pointerHeld || (FS.y !== null && FS.y >= barTop) ||
    (a && a !== document.body && st.contains(a) && a.matches(":focus-visible")) ||
    !$("confirm").hidden;
}
function fsCheck(delay = 700) {
  clearTimeout(FS.hideT);
  if (!fsOn()) return;
  if (fsKeep()) { fsShow(true); return; }
  FS.hideT = setTimeout(() => { if (fsOn() && !fsKeep()) fsShow(false); }, delay);
}
$("stage").addEventListener("mousemove", (e) => {
  if (!fsOn()) return;
  FS.y = e.clientY;
  const st = $("stage");
  st.classList.remove("fs-idle");
  clearTimeout(FS.idleT);
  FS.idleT = setTimeout(() => { if (fsOn() && !fsKeep()) st.classList.add("fs-idle"); }, 2000);
  fsCheck();
});
$("stage").addEventListener("mouseleave", () => { FS.y = null; fsCheck(); });
$("stage").addEventListener("focusin", () => fsCheck());
document.addEventListener("pointerup", () => setTimeout(() => fsCheck(), 0), true);

document.addEventListener("fullscreenchange", () => {
  const on = document.fullscreenElement === $("stage");
  $("fs-btn").setAttribute("aria-pressed", on);
  const st = $("stage");
  clearTimeout(FS.hideT); clearTimeout(FS.idleT);
  st.classList.remove("fs-hide", "fs-idle");
  if (on) { FS.y = null; FS.hideT = setTimeout(() => { if (fsOn() && !fsKeep()) fsShow(false); }, 2000); }
  // toasts and confirmations must live inside the full-screen element to be seen
  (on ? $("stage") : document.querySelector(".app")).appendChild($("toast"));
  layoutStage();
});
window.addEventListener("resize", () => layoutStage());
video.addEventListener("loadedmetadata", () => layoutStage());

/** Full screen: the video takes the whole screen, centred; controls and the
 *  decision panel sit in a translucent bar at the bottom that hides until the
 *  mouse comes to the bottom of the screen (fsBar below). */
function layoutStage() {
  const st = $("stage");
  const lo = P() && last();
  // 0.12.7: the screen keeps the Settings aspect; a clip of another size is scaled to fit
  // inside it (black bars when its aspect differs)
  const cur = P() && sizeOf(P().settings);
  const ar = cur ? cur[0] / cur[1] : video.videoWidth ? video.videoWidth / video.videoHeight
    : lo && lo.size ? lo.size[0] / lo.size[1] : 16 / 9;
  st.style.setProperty("--ar", ar);
  if (document.fullscreenElement !== st) return;
  const W = window.innerWidth, H = window.innerHeight;
  const vc = $("vcontrols"), dec = $("decision");
  const narrow = W <= 900;
  const barH = narrow ? vc.offsetHeight + dec.offsetHeight + 38 : Math.max(vc.offsetHeight, dec.offsetHeight) + 28;
  st.style.setProperty("--bar-h", barH + "px");
  st.style.setProperty("--dec-h", dec.offsetHeight + "px");
  const fitH = Math.min(H, W / ar);
  const top = (H - fitH) / 2;                    // centred: the bar hides until the mouse comes down
  st.style.setProperty("--vid-top", top + "px");
  st.style.setProperty("--vid-h", fitH + "px");
}

// ---------------------------------------------------------------------------
// RAM / GPU / VRAM of the ComfyUI machine, in the top bar
// ---------------------------------------------------------------------------

const fmtGB = (b) => (b / 1073741824).toFixed(b >= 10 * 1073741824 ? 0 : 1);
let statsTimer = null;

async function pollStats() {
  clearTimeout(statsTimer);
  if (document.visibilityState === "visible" && S.conn === "ok") {
    try { renderStats(await api("/longshot/stats")); } catch (e) { /* ComfyUI busy or restarting */ }
  }
  statsTimer = setTimeout(pollStats, 2000);
}

function renderStats(d) {
  S.sys = d;
  const el = $("sysstats");
  const chip = (label, value, frac, title) =>
    `<span class="stat${frac !== null && frac >= 0.9 ? " hot" : ""}" title="${esc(title)}">${label} <b>${value}</b></span>`;
  const out = [];
  if (d.ram) out.push(chip("RAM", `${fmtGB(d.ram.used)}/${fmtGB(d.ram.total)} GB`, d.ram.used / d.ram.total, "System memory in use on the ComfyUI machine"));
  if (d.gpu && d.gpu.util !== null && d.gpu.util !== undefined) out.push(chip("GPU", `${Math.round(d.gpu.util)}%`, d.gpu.util / 100, d.gpu.name || "GPU load"));
  if (d.gpu) out.push(chip("VRAM", `${fmtGB(d.gpu.vram_used)}/${fmtGB(d.gpu.vram_total)} GB`, d.gpu.vram_used / d.gpu.vram_total, `Video memory in use on ${d.gpu.name || "the GPU"}`));
  el.innerHTML = out.join("");
  el.hidden = !out.length;
}

/** Item 5. ComfyUI handles /free flags in its prompt worker when idle, so the
 *  chips are refreshed a few times over the next seconds. */
async function freeMemory(what) {
  if (busyGuard() || S.freeing) return;
  S.freeing = true;
  renderHeader();
  try {
    if (what === "cache") {
      const r = await api("/longshot/clear-cache", { method: "POST" });
      toast(r.cleared ? `Cleared ${r.cleared} Shot piece${r.cleared > 1 ? "s" : ""} from Long Shot's memory. Saved takes on disk stay.`
        : "Long Shot's memory was already empty.");
    } else {
      await api("/free", { method: "POST", body: what === "ram" ? { unload_models: true, free_memory: true } : { unload_models: true } });
      toast(what === "ram" ? "Models unloaded and ComfyUI's cache cleared. The next render loads the models from disk."
        : "Models moved out of VRAM. They stay in RAM, so the next render starts quickly.");
    }
  } catch (e) { toast(e.message); }
  S.freeing = false;
  renderHeader();
  for (let i = 1; i <= 6; i++) {
    setTimeout(async () => { try { renderStats(await api("/longshot/stats")); } catch (e) { /* busy */ } }, i * 500);
  }
}

/** Item 2: Shots' own seeds back to auto. */
async function resetShotSeeds() {
  if (setupGuard()) return;
  const shots = P().shots.filter((s) => s.kind !== "clip");
  if (!shots.some((s) => Number(s.shot_seed) >= 0)) { toast("Every Shot is already on auto."); return; }
  const act = active().filter((s) => s.kind !== "clip");
  const approved = act.filter((s) => s.status === "approved" && !isAuto(s));
  // approved Shots keep their seeds and takes (the notice offers all Shots);
  // Shots in the render going now keep theirs
  const keep = (s) => (all ? false : s.status === "approved" && !s.bypassed) || inRender(s);
  let all = false;
  const which = shots.filter((s) => !isAuto(s) && !keep(s));
  if (approved.length) {
    changeNote("Shot seeds", `${approved.length} approved Shot${approved.length > 1 ? "s keep their seeds and takes" : " keeps its seed and take"}`,
      { label: "Reset approved Shots too", fn: () => { all = true; resetSeeds(shots.filter((s) => !isAuto(s) && !keep(s))); } });
  }
  resetSeeds(which);
}

function resetSeeds(which) {
  S.gen++;
  S.dry = null;
  let again = 0;
  for (const s of which) {
    if (s.take) s.seed_used = effSeed(s);
    s.shot_seed = -1;
    s.edit_from = null;
    delete S.bad[s.id + ":shot_seed"];
    if (s.status !== "queued" && !s.bypassed) {
      if (s.status === "approved") s.was_approved = true; else s.was_rendered = true;
      s.status = "queued";
      again++;
    }
  }
  commit();
  const n = which.filter((s) => !s.bypassed).length;
  toast(`Seeds back to auto on ${n} Shot${n === 1 ? "" : "s"}` + (again ? `; ${again} will render again.` : "."));
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  pollStats();
  if (P() && !S.busy && Object.values(S.refState).some((st) => st === "missing" || st === "invalid")) {
    loadInputs().then(checkInputs).then(render);
  }
});
window.addEventListener("focus", () => {
  if (P() && !S.busy && Object.values(S.refState).some((st) => st === "missing" || st === "invalid")) {
    loadInputs().then(checkInputs).then(render);
  }
});

// ---------------------------------------------------------------------------
// Model files: matching by name, and the model browser
// ---------------------------------------------------------------------------

/** The listed name for a saved model name (mirrors the server): the same
 *  name, the other OS's separators, or the one listed file with that file name. */
function matchModel(value, names) {
  if (!value) return null;
  names = names || [];
  if (names.includes(value)) return value;
  const norm = value.replace(/\\/g, "/");
  const twin = names.find((n) => n.replace(/\\/g, "/") === norm);
  if (twin) return twin;
  const base = norm.split("/").pop().toLowerCase();
  const hits = names.filter((n) => n.replace(/\\/g, "/").split("/").pop().toLowerCase() === base);
  return hits.length === 1 ? hits[0] : null;
}

/** [label, kind, get, set] for every model file the project uses. */
function modelSlots(p) {
  const s = p.settings, a = p.audio;
  const out = [
    ["Model", "models", () => s.model, (v) => { s.model = v; }],
    ["Text encoder", "clips", () => s.clip, (v) => { s.clip = v; }],
    ["Video VAE", "vaes", () => s.video_vae, (v) => { s.video_vae = v; }],
    ["Audio VAE", "vaes", () => s.audio_vae, (v) => { s.audio_vae = v; }],
  ];
  if (s.turbo.on) out.push(["Turbo LoRA", "loras", () => s.turbo.lora, (v) => { s.turbo.lora = v; }]);
  s.loras.forEach((l, i) => { if (l.on && l.name) out.push([`LoRA ${i + 1}`, "loras", () => l.name, (v) => { l.name = v; }]); });
  if (a.voice_ref) out.push(["Vocal separation model", "melband", () => a.melband_model, (v) => { a.melband_model = v; }]);
  return out;
}

/** On open: a project saved on another machine finds its model files here by
 *  name, even in a different subfolder. Nothing re-renders: same files. */
function relinkModels(p) {
  if (!S.opts) return 0;
  let n = 0;
  for (const [, kind, get, set] of modelSlots(p)) {
    const v = get();
    const m = matchModel(v, S.opts[kind]);
    if (v && m && m !== v) { set(m); n++; }
  }
  return n;
}

/** 0.14.0: the files a Face refine try loads (its own model and LoRA, the text encoder and VAEs). */
function missingFaceModels(p) {
  if (!S.opts) return [];
  const s = p.settings, f = s.face;
  const slots = [["Face model", "models", f.model], ["Text encoder", "clips", s.clip], ["Video VAE", "vaes", s.video_vae],
    ["Audio VAE", "vaes", s.audio_vae]];
  if (f.turbo.on) slots.push(["Face Turbo LoRA", "loras", f.turbo.lora]);
  return slots.filter(([, kind, v]) => !matchModel(v, S.opts[kind])).map(([label, , v]) => `${label}${v ? ` (${v})` : ""}`);
}

function missingModels(p) {
  if (!S.opts) return [];
  return modelSlots(p).filter(([, kind, get]) => !matchModel(get(), S.opts[kind]))
    .map(([label, , get]) => `${label}${get() ? ` (${get()})` : ""}`);
}

let MB = null;            // model browser state
const MB_TITLES = { diffusion_models: "diffusion_models", text_encoders: "text_encoders", vae: "vae", loras: "loras" };

async function browseModels(kind, target) {
  if (setupGuard()) return;
  MB = { kind, target, q: "", mode: "files", data: null, path: "" };
  showModal("Choose a model file", "", '<div class="muted">Loading…</div>');
  await loadMB();
}

async function loadMB() {
  try { MB.data = await api("/longshot/models?kind=" + encodeURIComponent(MB.kind)); }
  catch (e) { MB.data = { folders: [], files: [], error: e.message }; }
  renderMB();
}

function currentFor(target) {
  const p = P(), s = p.settings;
  if (target === "turbo") return s.turbo.lora;
  if (target === "melband") return p.audio.melband_model;
  if (target === "refine_model") return s.refine.model;
  if (target === "face_model") return s.face.model;
  if (target.startsWith("lora:")) return s.loras[+target.slice(5)].name;
  return s[target];
}

function renderMB() {
  if (!MB || $("modal").hidden) return;
  const body = $("modal-body");
  if (MB.mode === "folders") return renderMBFolders(body);
  const d = MB.data || { folders: [], files: [] };
  const cur = currentFor(MB.target);
  const q = MB.q.trim().toLowerCase();
  const files = d.files.filter((f) => !q || f.name.toLowerCase().includes(q));
  const mb = (b) => (b ? (b > 1e9 ? (b / 1073741824).toFixed(1) + " GB" : Math.round(b / 1048576) + " MB") : "");
  const rows = files.map((f) => {
    const parts = f.name.replace(/\\/g, "/").split("/");
    const file = parts.pop();
    const sub = parts.length ? parts.join("/") + "/" : "";
    return `<button class="mb-file${f.name === cur ? " current" : ""}" data-action="mb-pick" data-name="${esc(f.name)}" title="${esc((f.folder || "") + " · " + f.name)}">
      <span class="mb-name"><span class="muted">${esc(sub)}</span>${esc(file)}</span><span class="muted small">${mb(f.bytes)}</span></button>`;
  }).join("") || `<div class="muted">${d.files.length ? "No file matches." : "ComfyUI found no files in these folders."}</div>`;
  const folders = d.folders.map((f) => `<div class="mb-folder${f.exists ? "" : " gone"}">
      <span class="mono small">${esc(f.path)}</span>${f.studio ? '<span class="chip">added here</span>' : ""}${f.exists ? "" : '<span class="chip">not found</span>'}
      ${f.studio ? `<button class="ghost sm local-only" data-action="mb-remove" data-path="${esc(f.path)}">Remove</button>` : ""}</div>`).join("");
  body.innerHTML = `${d.error ? `<div class="err"><span>${esc(d.error)}</span></div>` : ""}
    <input class="field" id="mb-q" type="search" placeholder="Search ${d.files.length} ${esc(MB_TITLES[MB.kind])} files…" value="${esc(MB.q)}" autocomplete="off">
    <div class="mb-list">${rows}</div>
    <div class="mb-where"><div class="small muted">Where ComfyUI looks for ${esc(MB_TITLES[MB.kind])}:</div>${folders}
      <div class="mb-add">${S.local ? `<button class="ghost sm" data-action="mb-folders">Add a folder…</button>
        <span class="muted small">for models kept anywhere else on this machine</span>`
        : '<span class="muted small">Models kept elsewhere: add their folder from the machine running ComfyUI, or list it in ComfyUI\'s extra_model_paths.yaml.</span>'}</div></div>`;
  const q2 = $("mb-q");
  if (q2 && document.activeElement !== q2 && MB.focus !== false) { q2.focus(); q2.setSelectionRange(q2.value.length, q2.value.length); }
}

async function renderMBFolders(body) {
  let d;
  try { d = await api("/longshot/browse?path=" + encodeURIComponent(MB.path || "")); }
  catch (e) { d = { error: e.message, dirs: [], path: MB.path }; }
  if (!MB || MB.mode !== "folders") return;
  const crumbs = d.path ? `<span class="mono small">${esc(d.path)}</span>` : '<span class="muted">This computer</span>';
  body.innerHTML = `${d.error ? `<div class="err"><span>${esc(d.error)}</span></div>` : ""}
    <div class="mb-path">${d.parent !== null && d.parent !== undefined ? `<button class="ghost sm" data-action="mb-cd" data-path="${esc(d.parent)}">↑ Up</button>`
      : d.path ? '<button class="ghost sm" data-action="mb-cd" data-path="">↑ Drives</button>' : ""} ${crumbs}</div>
    <div class="mb-list">${d.dirs.map((x) => `<button class="mb-file" data-action="mb-cd" data-path="${esc(d.path ? (d.path.replace(/[\\/]$/, "") + (d.path.includes("\\") ? "\\" : "/") + x) : x)}">📁 ${esc(x)}</button>`).join("")
      || '<div class="muted">No folders here.</div>'}</div>
    <div class="dialog-actions">
      <span class="muted small" style="margin-right:auto">${d.path ? `${d.models} model file${d.models === 1 ? "" : "s"} directly in this folder (subfolders are searched too)` : ""}</span>
      <button class="ghost" data-action="mb-back">Back</button>
      <button class="primary sm-primary" data-action="mb-add"${d.path ? "" : " disabled"}>Use this folder for ${esc(MB_TITLES[MB.kind])}</button>
    </div>`;
  MB.shown = d.path;
}

async function mbChangeFolders(action, path) {
  try {
    MB.data = await api("/longshot/model-folders", { method: "POST", body: { kind: MB.kind, path, action } });
    S.opts = await api("/longshot/options");
  } catch (e) { toast(e.message); return; }
  MB.mode = "files";
  renderMB();
  render();
  if (action === "add") toast("Folder added. ComfyUI lists its files now, and the Studio adds it again after a restart.");
}

async function mbPick(name) {
  const p = P(), s = p.settings, t = MB.target;
  const before = currentFor(t);
  $("modal").hidden = true;
  MB = null;
  if (before === name) return;
  if (t === "melband") { p.audio.melband_model = name; if (p.audio.voice_ref) sharedChanged("Audio"); return commit(); }
  if (t === "refine_model") { s.refine.model = name; S.dry = null; return commit(); }
  if (t === "face_model") { s.face.model = name; return commit(); }
  const matters = t === "turbo" ? s.turbo.on : t.startsWith("lora:") ? s.loras[+t.slice(5)].on : true;
  const what = t === "turbo" ? "the Turbo LoRA" : t.startsWith("lora:") ? `LoRA ${+t.slice(5) + 1}` : KEEPABLE[t] || "the model";
  let mode = "all";
  if (matters) { mode = await askSettingChange(`Change ${what}`); if (!mode) return render(); }
  if (t === "turbo") s.turbo.lora = name;
  else if (t.startsWith("lora:")) s.loras[+t.slice(5)].name = name;
  else s[t] = name;
  if (matters) applyRefChange(mode, what[0].toUpperCase() + what.slice(1));
  commit();
}

// ---------------------------------------------------------------------------
// Clip Shots: real video in the timeline
// ---------------------------------------------------------------------------

const ZONE_S = () => (Number(P().settings.overlap) || 22) / 24;

/** The longest valid clip length (17k + 5 frames at 24 fps) within `sec`. */
function clipFrames(sec) {
  const n = Math.floor(Math.max(0, Number(sec) || 0) * 24 + 1e-6);
  return n < 5 ? 0 : Math.floor((n - 5) / 17) * 17 + 5;
}

/** The generated Shots joined to `s` by a Bridge re-render in place, so they
 *  lead into it and out of it. (A Cut leaves them as they are.) */
function bridgeAround(s) {
  const act = active();
  const i = act.indexOf(s);
  if (i < 0) return [];
  const out = [];
  const prev = act[i - 1], next = act[i + 1];
  S.gen++;
  if (prev && prev.kind !== "clip" && !isCut(s) && prev.status !== "queued") { prev.status = "queued"; out.push(prev); }
  if (next && next.kind !== "clip" && !isCut(next) && next.status !== "queued") { next.status = "queued"; out.push(next); }
  S.dry = null;
  return out;
}

function bridgeNote(shots) {
  if (!shots.length) return "";
  const names = shots.map((x) => titleOf(x)).join(" and ");
  return ` ${names} will re-render to ${shots.length > 1 ? "lead into and out of it" : "join it"}.`;
}

async function addClipFiles(fileList, nearId, replace, atIndex) {
  const p = P();
  const f = [...fileList].find((x) => VIDEO_RE.test(x.name || ""));
  if (!f) { toast("Drop a video file (MP4, MOV, WebM, MKV) to add a clip."); return; }
  {
    const near = nearId ? P().shots.findIndex((x) => x.id === nearId) : -1;
    if (listGuard(atIndex !== undefined ? atIndex : near < 0 ? P().shots.length : near + (replace ? 0 : 1), 1)) return;
  }
  S.uploading.clip = true;
  toast(`Uploading ${f.name}…`);
  let info;
  try { info = await uploadFile(f, "video"); }
  catch (e) { toast(`Couldn't upload ${f.name}: ${e.message}`); return; }
  finally { delete S.uploading.clip; }
  await loadInputs();
  const near = nearId ? p.shots.findIndex((x) => x.id === nearId) : -1;
  const at = atIndex !== undefined ? atIndex : near < 0 ? p.shots.length : near + (replace ? 0 : 1);
  if (listGuard(at, 1)) return;
  await insertClip(at, info, replace && near >= 0 ? p.shots[near] : null);
}

/** A new Clip Shot from a file already in the input folder. */
async function insertClip(at, info, replacing) {
  const p = P();
  let pr;
  try { pr = await api(`/longshot/probe?name=${encodeURIComponent(info.name)}&subfolder=${encodeURIComponent(info.subfolder || "")}`); }
  catch (e) { toast("Couldn't read the video: " + e.message); return; }
  const want = replacing && replacing.window ? replacing.window / 24 : Math.min(pr.duration, 10);
  const frames = clipFrames(Math.min(want, pr.duration));
  if (!frames) { toast("That clip is too short (it needs at least a quarter of a second)."); return; }
  const s = { id: uid("k"), kind: "clip", status: "approved", join: "bridge", bypassed: false, text: "",
    seconds: frames / 24, shot_seed: -1, prev_seeds: [], take: null, window: null, take_seconds: null,
    clip: { file: info.name, subfolder: info.subfolder || "", original_name: info.name, sha256: info.sha256 || null,
      size_bytes: info.size_bytes || null, trim_in: 0, frames, duration: pr.duration, fps: pr.fps,
      width: pr.width, height: pr.height, has_audio: pr.has_audio, audio: pr.has_audio ? "clip" : "mute" } };
  p.shots.splice(Math.max(0, Math.min(at, p.shots.length)), 0, s);
  S.refState["clip:" + s.id] = "ok";
  if (replacing) replacing.bypassed = true;
  const redo = bridgeAround(s);
  p.preview_dirty = true;
  S.open = s.id;
  commit();
  toast((replacing ? `${titleOf(s)} is now a clip; the Shot it replaced is bypassed, so you can switch back.`
    : `Clip added as ${titleOf(s)}.`) + bridgeNote(redo) +
    (replacing && replacing.window && frames !== replacing.window ? ` Trimmed to ${(frames / 24).toFixed(2)} s to match.` : ""));
}

function pickClip(nearId, replace, before) {
  const near = nearId ? P().shots.findIndex((x) => x.id === nearId) : -1;
  if (listGuard(before ? 0 : near < 0 ? P().shots.length : near + (replace ? 0 : 1), 1)) return;
  const inp = document.createElement("input");
  inp.type = "file";
  inp.accept = "video/*,.mkv,.webm,.mov";
  inp.addEventListener("change", () => {
    if (!inp.files.length) return;
    if (before) addClipFiles(inp.files, null, false, 0);
    else addClipFiles(inp.files, nearId, replace);
  });
  inp.click();
}

/** Upload a different video for an existing clip card. */
function pickClipFile(s) {
  if (!s || listGuard(P().shots.indexOf(s), 1)) return;
  const inp = document.createElement("input");
  inp.type = "file";
  inp.accept = "video/*,.mkv,.webm,.mov";
  inp.addEventListener("change", async () => {
    if (!inp.files.length) return;
    let info;
    try { info = await uploadFile(inp.files[0], "video"); } catch (e) { toast(e.message); return; }
    await loadInputs();
    await setClipFile(s, info.subfolder || "", info.name, info);
  });
  inp.click();
}

async function setClipFile(s, sub, name, info) {
  let pr;
  try { pr = await api(`/longshot/probe?name=${encodeURIComponent(name)}&subfolder=${encodeURIComponent(sub)}`); }
  catch (e) { toast("Couldn't read the video: " + e.message); return; }
  const c = s.clip;
  Object.assign(c, { file: name, subfolder: sub, original_name: name, duration: pr.duration, fps: pr.fps,
    width: pr.width, height: pr.height, has_audio: pr.has_audio, trim_in: 0,
    sha256: info ? info.sha256 : null, size_bytes: info ? info.size_bytes : null });
  if (!pr.has_audio) c.audio = "mute";
  c.frames = clipFrames(Math.min(c.frames / 24 || 10, pr.duration)) || clipFrames(pr.duration);
  s.seconds = c.frames / 24;
  S.refState["clip:" + s.id] = "ok";
  clipChanged(s);
  commit();
}

/** Trim, length, audio or file of a clip changed: its bridged neighbours re-render. */
function clipChanged(s) {
  P().preview_dirty = true;
  const redo = bridgeAround(s);
  if (redo.length) toast(`${titleOf(s)}'s clip changed.` + bridgeNote(redo));
}

/** Continuous → Context → Cut, between two generated Shots. A rendered Shot
 *  keeps its take; the notice offers to render it again the new way. */
function cycleJoin(s) {
  if (!s || listGuard(P().shots.indexOf(s))) return;
  const order = chipOptions(s);
  if (order.length < 2) {
    toast(`${titleOf(s)} has no Shot next to it, so it renders on its own (Cut). ` +
      "Add a Shot before or after it for Continuous or Context.");
    return;
  }
  const wasJ = chipJoin(s), was = chipName(s, wasJ);
  s.join = order[(order.indexOf(wasJ) + 1) % order.length];
  const name = { [s.join]: chipName(s, s.join) };
  P().preview_dirty = true;
  S.dry = null;
  if (s.status !== "queued" && s.take) {
    changeNote(`${titleOf(s)}'s join`, `now ${name[s.join]}; its take was made ${was}`,
      { label: `Re-render ${titleOf(s)}`, fn: () => redoInPlace(s) });
  }
  commit();
}

/** Render a Shot again in its place (the Shots around it keep their takes). */
function redoInPlace(s) {
  if (!s || s.kind === "clip" || inRenderGuard(s)) return;
  if (jobFor(s.id)) { toast(`${titleOf(s)} is already in the queue.`); return; }
  rememberTake(s);
  if (s.status === "approved") s.was_approved = true; else if (s.status === "review") s.was_rendered = true;
  s.status = "queued";
  S.dry = null;
  enqueue({ type: "shot", target: s.id, kind: "render", mode: "chip" });
}

function toggleJoin(s) {
  if (!s || listGuard(P().shots.indexOf(s))) return;
  const act = active();
  const prev = act[act.indexOf(s) - 1];
  if (!prev || (prev.kind === "clip" && s.kind === "clip")) return;
  s.join = s.join === "cut" ? "bridge" : "cut";
  P().preview_dirty = true;
  if (s.join === "bridge") {
    // the generated side of the join re-renders so it meets the clip
    const gen = s.kind === "clip" ? prev : s;
    if (gen.kind !== "clip" && gen.status !== "queued") {
      gen.status = "queued";
      toast(`Bridge: ${titleOf(gen)} will re-render to flow ${gen === prev ? "into" : "out of"} the clip.`);
    }
  } else {
    toast("Cut: the Shots stay as they are and meet with a hard cut. Update the preview to see it.");
  }
  S.dry = null;
  commit();
}

function clipCardBody(s, title) {
  const c = s.clip;
  const missing = ["missing", "invalid"].includes(S.refState["clip:" + s.id]);
  const secs = c.frames / 24;
  const zone = ZONE_S().toFixed(2);
  const act = active(), i = act.indexOf(s);
  const prev = act[i - 1], next = act[i + 1];
  const shared = [];
  if (prev) shared.push(s.join === "cut" ? `its first ${zone} s is hidden behind ${titleOf(prev)} (cut)` : `its first ${zone} s is where ${titleOf(prev)} flows in`);
  const strip = c.file && !missing ? `/longshot/filmstrip?name=${encodeURIComponent(c.file)}&subfolder=${encodeURIComponent(c.subfolder)}` +
    `&in=${c.trim_in}&out=${(c.trim_in + secs).toFixed(3)}` : "";
  return `<div class="shot-body clip-body">
      ${strip ? `<img class="filmstrip" alt="" src="${esc(strip)}" loading="lazy">` : `<div class="filmstrip empty">${missing ? "Missing: " + esc(c.original_name || c.file) : "No video chosen"}</div>`}
      <div class="shot-opts">
        <label class="lbl-row">Video <select data-clip-file aria-label="${title} video">${inputOptions("videos", c.subfolder, c.file, "Choose a video…")}</select></label>
        <button class="ghost sm" data-action="pick-clip-file">Upload…</button>
      </div>
      <div class="shot-opts">
        <label class="lbl-row">Start <input type="number" step="0.1" min="0" data-clip="trim_in" value="${esc(c.trim_in)}" style="width:72px"> s</label>
        <label class="lbl-row">Length <input type="number" step="0.1" min="0.25" data-clip="length" value="${esc(secs.toFixed(2))}" style="width:72px"> s</label>
        <span class="mono small muted">→ ${secs.toFixed(2)} s · ${c.frames} frames</span>
        <label class="lbl-row">Sound <select data-clip="audio"><option value="clip"${c.audio === "clip" ? " selected" : ""}${c.has_audio ? "" : " disabled"}>Clip's own${c.has_audio ? "" : " (none)"}</option>
          <option value="mute"${c.audio !== "clip" ? " selected" : ""}>Mute</option></select></label>
      </div>
      <div class="muted small">${c.duration ? `Source: ${c.width || "?"}×${c.height || "?"} · ${c.fps ? c.fps + " fps" : "?"} · ${c.duration.toFixed(2)} s. ` : ""}Resized and centre-cropped to the film's size, at 24 fps.${shared.length ? " In the film, " + shared.join("; ") + "." : ""}</div>
      <div class="shot-opts shot-more">
        <span class="push"></span>
        <button class="ghost sm" data-action="insert-before">⊕ Shot before</button>
        <button class="ghost sm" data-action="insert-after">⊕ Shot after</button>
        <button class="ghost sm" data-action="insert-clip-after">⊕ Clip after</button>
      </div></div>`;
}

// ---------------------------------------------------------------------------
// Round 2: inserting Shots and take history
// ---------------------------------------------------------------------------

function insertShot(at) {
  if (listGuard(at)) return;
  const p = P();
  const s = { id: uid("s"), text: "", seconds: 5, shot_seed: -1, bypassed: false, status: "queued",
    was_approved: false, join: "bridge", take: null, window: null, take_seconds: null, prev_seeds: [] };
  p.shots.splice(Math.max(0, Math.min(at, p.shots.length)), 0, s);
  S.open = s.id;
  S.dry = null;
  syncAfter(s, "Inserting a Shot");
  commit();
  setTimeout(() => { const t = document.querySelector(`[data-shot="${s.id}"] textarea`); if (t) t.focus(); }, 0);
}

const takesLoading = new Set();
async function fetchTakes(id) {
  if (!P() || takesLoading.has(id)) return;
  takesLoading.add(id);
  try {
    const r = await api(`/longshot/takes/${encodeURIComponent(P().slug)}?shot=${encodeURIComponent(id)}`);
    S.takes[id] = r.takes || [];
  } catch (e) { S.takes[id] = []; }
  takesLoading.delete(id);
  renderShots();
  renderDecision();
  renderViewer();
}

/** "Take 2 of 4 ◀ ▶" for a rendered Shot with more than one take. */
function takeNav(s) {
  if (!s || !s.take) return "";
  const list = S.takes[s.id];
  if (!list) { fetchTakes(s.id); return ""; }
  if (list.length < 2) return "";
  const i = list.findIndex((t) => t.name === s.take);
  const off = takesLocked(s);
  return `<span class="take-nav" data-shot="${esc(s.id)}">
    <button class="icon" data-action="take-step" data-dir="-1" aria-label="Previous take"${i <= 0 || off ? " disabled" : ""}>◀</button>
    <button class="take-label" data-action="takes" title="All takes of ${esc(titleOf(s))}">Take ${i + 1} of ${list.length}</button>
    <button class="icon" data-action="take-step" data-dir="1" aria-label="Next take"${i < 0 || i >= list.length - 1 || off ? " disabled" : ""}>▶</button></span>`;
}

function stepTake(s, dir) {
  const list = s && S.takes[s.id];
  if (!list) return;
  const i = list.findIndex((t) => t.name === s.take);
  const t = list[i + dir];
  if (!t) return;
  useTake(s, t.name);
  if (s.take !== t.name) return;                 // not switched (locked)
  // review it: the scrubber goes to the start of this Shot's piece
  buildTL();
  const e = TL.entries.find((x) => x.id === s.id);
  if (e) { if (PL.playing) pausePlayer(); tlSeek(e.start + 0.04); }
}

/** Switching takes is instant: the take is a file, so nothing samples. */
function useTake(s, name) {
  if (!s || listGuard(P().shots.indexOf(s), 1)) return;
  const t = (S.takes[s.id] || []).find((x) => x.name === name);
  if (!t) return;
  s.take = t.name;
  if (t.seed !== null && t.seed !== undefined) { if (isAuto(s)) s.seed_used = Number(t.seed); else s.shot_seed = t.seed; }
  s.window = t.window_frames;
  s.take_seconds = Number(s.seconds);
  s.rendered = { text: s.text, seconds: Number(s.seconds), seed: Number(s.shot_seed) };
  s.edit_from = null;
  Object.keys(S.bad).forEach((k) => { if (k.startsWith(s.id + ":")) delete S.bad[k]; });
  if (s.status === "queued") s.status = "review";
  S.dry = null;
  commit();               // the timeline swaps in that take's clip; nothing is decoded
  // a take without a clip (made before 0.6.5, or its clip was deleted): just that one
  if (!S.clips[takeStem(s.take)] && !S.busy && !S.chunking && !waitingJobs().length) makeClips([{ take: s.take }]);
}

function manageTakes(s) {
  if (!s) return;
  const list = S.takes[s.id];
  if (!list) { fetchTakes(s.id).then(() => manageTakes(s)); return; }
  const rows = list.map((t, i) => {
    const cur = t.name === s.take;
    return `<div class="take-row${cur ? " current" : ""}">
      <span class="mono">Take ${i + 1}</span>
      <span class="muted small">seed ${esc(t.seed)} · ${esc((t.created || "").replace("T", " ").slice(0, 16))} · ${t.seconds ? t.seconds.toFixed(2) + " s · " : ""}${(t.bytes / 1048576).toFixed(1)} MB</span>
      ${cur ? '<span class="chip">In use</span>' : `<button class="ghost sm" data-action="use-take" data-shot="${esc(s.id)}" data-name="${esc(t.name)}">Use</button>
        <button class="ghost sm local-only" data-action="delete-take" data-shot="${esc(s.id)}" data-name="${esc(t.name)}">Delete</button>`}
    </div>`;
  }).join("") || '<div class="muted">No saved takes yet.</div>';
  showModal(`Takes · ${titleOf(s)}`, "", `<div class="take-list">${rows}</div>
    <p class="muted small">Switching takes samples nothing. Deleting frees disk space; the take in use can't be deleted.${S.local ? "" : " Deleting works only on the machine running ComfyUI."}</p>`);
}

async function deleteTake(id, name) {
  try { S.segStats = await api(`/longshot/takes/${encodeURIComponent(P().slug)}/${encodeURIComponent(name)}`, { method: "DELETE" }); }
  catch (e) { toast(e.message); return; }
  delete S.takes[id];
  await fetchTakes(id);
  renderSettings();
  const s = P().shots.find((x) => x.id === id);
  if (s) manageTakes(s);
}

// ---------------------------------------------------------------------------
// C.5 Reroll an approved Shot
// ---------------------------------------------------------------------------

function rememberTake(s) {
  const row = lastRowFor(s.id);
  const seed = effSeed(s) ?? (row ? row.seed : null);
  if (seed === null || seed === undefined) return;
  s.prev_seeds = (s.prev_seeds || []).filter((x) => x !== seed).concat([seed]).slice(-10);
}

/** Shots after `s` that are rendered: they stay (locked) on an in-place render. */
function renderedAfter(s) {
  const act = active();
  return act.slice(act.indexOf(s) + 1).filter((x) => x.status !== "queued");
}

/** Round 1 behaviour, on request: the Shots after `s` render again too. */
function rippleAfter(s) {
  S.gen++;
  for (const x of renderedAfter(s)) {
    if (x.status === "approved") x.was_approved = true;
    else x.was_rendered = true;
    x.status = "queued";
  }
  S.dry = null;
}

/** "↯ hard cut · Bridge": re-render this Shot in place, pinned to the Shot now
 *  before it and to its own old ending, so the Shots after it stay. */
function bridgeShot(s) {
  if (!s || inRenderGuard(s)) return;
  if (jobFor(s.id)) { toast(`${titleOf(s)} is already in the queue.`); return; }
  rememberTake(s);
  reseed(s);
  s.status = "queued";
  s.was_approved = false;
  S.dry = null;
  enqueue({ type: "shot", target: s.id, kind: "reroll", mode: "pinned" });
}

async function rerollShot(s) {
  if (!s || inRenderGuard(s)) return;
  if (jobFor(s.id)) { toast(`${titleOf(s)} is already in the queue.`); return; }
  let alone = false;
  if (s.standalone) {
    const mode = await askStandalone(s, "Reroll");
    if (!mode) return;
    alone = mode === "alone";
  }
  const takes = await askMulti(titleOf(s));
  if (!takes || inRenderGuard(s)) return;
  if (!s.standalone) {
    const after = renderedAfter(s);
    if (after.length) {
      const a = numOf(after[0].id), z = numOf(after[after.length - 1].id);
      const range = after.length > 1 ? `Shots ${a}–${z}` : `Shot ${a}`;
      const ans = await confirmBox({ title: `Reroll ${titleOf(s)} in place?`,
        body: `${titleOf(s)} gets a new take with the same length, pinned to the Shot before it and ` +
          `to ${range}, which stay exactly as they are. One render.`,
        yes: `Reroll ${titleOf(s)}`, no: "Cancel", check: `Also re-render ${range}` });
      if (!ans.ok) return;
      if (ans.checked) rippleAfter(s);
    }
  }
  rememberTake(s);
  reseed(s);
  s.status = "queued";
  s.was_approved = false;
  S.dry = null;
  // standalone pinned: in place, and it stops being standalone; on its own: a fresh start
  enqueue({ type: "shot", target: s.id, kind: "reroll", mode: alone ? "alone" : "pinned" }, takes);
}

function useSeed(s, seed) {
  if (!s || shotGuard(s) || !Number.isFinite(seed)) return;
  rememberTake(s);
  s.shot_seed = seed;
  editInPlace(s, "shot_seed");
  commit();
}

/** The saved final video, when it matches the current approved chain and settings. */
function finalState() {
  const f = P().final_output, lo = last();
  if (!f || !f.video || !lo) return null;
  const v = P().settings.rtx_vsr;
  const chain = active().map((s) => s.id);
  return JSON.stringify(f.chain) === JSON.stringify(chain) && f.source_at === lo.source_at
    && f.scale === v.scale && f.quality === v.quality ? f : null;
}

function upscaleFinal() {
  if (!active().length) return;
  if (mixedSizeGuard("The final video")) return;
  if (Q.jobs.some((j) => liveJob(j) && j.slug === P().slug && j.spec.type === "final")) { toast("Upscale final video is already in the queue."); return; }
  scheduleSave();
  enqueue({ type: "final" });
}

/** Upscale final video's run options, for the queue. */
function finalOpts() {
  const act = active();
  if (!act.length) return null;
  const v = P().settings.rtx_vsr;
  const target = act[act.length - 1].id;
  return { upto: target, kind: "final", final: true, label: `Upscaling final video · ${v.scale}× ${v.quality}`,
    note: "Every Shot loads its saved take; decoding, upscaling and saving",
    onDone: ({ rows, text, outputs, built }) => {
      const combine = outputs[built.nodes.combine] || {};
      const video = (combine.gifs || combine.videos || [])[0];
      if (!video) throw new Error("Video Combine saved no file.");
      const lo = last();
      const source_at = lo ? lo.source_at : null;
      const pr = built.nodes.prores ? outputs[built.nodes.prores] || {} : {};
      const master = (pr.gifs || pr.videos || [])[0] || null;
      P().final_output = { video, master, chain: built.chain, scale: v.scale, quality: v.quality,
        source_at, at: new Date().toISOString() };
      P().last_output = Object.assign({}, lo || {}, { video, plan: rows, chain: built.chain, text,
        size: [built.width, built.height], source_at, video_plan: rows, video_chain: built.chain });
      loadVideo(0);
      toast(`Final video saved as ${video.filename}` + (master ? ` and the ProRes master as ${master.filename}.` : "."));
    } };
}

function renderThrough() {
  const t = throughTarget();
  if (!t || jobFor(t.id)) return;
  const rv = reviewShot();
  if (rv) { rv.status = "approved"; rv.was_approved = rv.was_rendered = false; }
  enqueue({ type: "through", target: t.id, kind: "render", mode: "chain" });
}

// ---------------------------------------------------------------------------
// Restart ComfyUI
// ---------------------------------------------------------------------------

async function restartComfy() {
  if (S.restarting) return;
  const running = S.busy && S.busy.kind !== "check";
  const ok = await confirmBox({ title: "Restart ComfyUI?",
    body: (running ? "A render is running and will stop. " : "") +
      "ComfyUI restarts and this page reconnects by itself, usually within a minute. " +
      "Finished segments are saved on disk, so nothing already rendered is lost; " +
      "the first render after the restart loads the model again.",
    yes: "Restart", no: "Cancel" });
  if (!ok) return;
  await saveNow();
  if (running) await stop();
  S.restarting = Date.now();
  renderHeader();
  try { await api("/longshot/restart", { method: "POST" }); }
  catch (e) {
    S.restarting = null;
    renderHeader();
    toast("Couldn't restart ComfyUI: " + e.message);
    return;
  }
  // If the socket never drops (restart refused by the OS), give up after 3 min.
  setTimeout(() => {
    if (S.restarting && S.conn === "ok" && Date.now() - S.restarting > 170000) {
      S.restarting = null;
      renderHeader();
      toast("ComfyUI didn't restart. Check its console window.");
    }
  }, 180000);
}

async function afterRestart() {
  S.restarting = null;
  S.checkedFor = null;                       // check saved segments again
  try { S.opts = await api("/longshot/options"); } catch (e) { /* keep old lists */ }
  pushLive();                                // a restarted ComfyUI forgot the switch
  if (P()) { await Promise.all([loadInputs(), checkInputs(), loadSegStats()]); }
  render();
  toast(S.autoRestart ? "ComfyUI restarted after running out of memory. The queue goes on." : "ComfyUI restarted.");
  S.autoRestart = false;
  setTimeout(queueNext, 500);
  autoCheck();
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

// While a queue job's project is swapped in, nothing of it is drawn and no
// message pops up: the open project stays on screen as it was.
for (const name of ["render", "renderShots", "renderDecision", "renderViewer", "renderSettings", "renderAdvanced",
  "renderPlan", "renderCast", "renderStyle", "renderAudio", "renderHeader", "renderSaveState", "loadVideo",
  "layoutStage", "toast", "showModal"]) {
  const f = window[name];
  if (typeof f !== "function") continue;
  window[name] = function (...args) { if (S.swapped) return undefined; return f.apply(this, args); };
}

async function init() {
  loadQueue();
  renderQueue();
  try { await start(); } finally {
    S.ready = true;
    renderQueue();
    queueNext();
  }
}

async function start() {
  connect();
  try {
    const caps = await api("/longshot/capabilities");
    S.local = !!caps.local;
    $("brand-ver").textContent = caps.version || "";
  } catch (e) { S.local = false; }
  document.body.classList.toggle("is-local", S.local);
  try { S.opts = await api("/longshot/options"); } catch (e) { toast("Couldn't read ComfyUI's model lists: " + e.message); }
  pushLive();
  if (/Mac|iPhone|iPad/.test(navigator.platform || "")) $("save-key").textContent = "⌘S";
  await refreshProjects();
  const want = store("h3studio.project");
  // 0.13.0: not a project another tab has open
  const free = S.projects.filter((p) => !tabWith(p.slug));
  const pick = free.find((p) => p.slug === want) || free[0];
  if (!pick && S.projects.length) setTimeout(() => toast("Every project is open in another Studio tab, so this tab starts a new one."), 800);
  if (pick) {
    try { await loadProject(pick.slug); return; } catch (e) { toast("Couldn't open " + pick.name + ": " + e.message); }
  }
  try {
    const made = await api("/longshot/projects", { method: "POST", body: { name: "Untitled",
      project: { shots: [{ id: uid("s"), text: "", seconds: 5 }] } } });
    await refreshProjects();
    await loadProject(made.slug);
  } catch (e) { toast("Couldn't create a project: " + e.message); }
}

init();
applyFolds();
applyViewerHidden();
$("viewer-mini").addEventListener("click", () => setViewerHidden(false));
