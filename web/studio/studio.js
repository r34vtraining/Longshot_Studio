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
  for (const k of ["plan", "queue", "cast"]) {
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
}
/** Is this zone folded in this browser? (Plan, Queue, the Upscale settings) */
function folded(k) {
  try { return !!(JSON.parse(store("h3studio.folds") || "{}") || {})[k]; } catch (e) { return false; }
}

const CLIENT_ID = (() => {
  let id = null;
  try { id = sessionStorage.getItem("h3studio.client"); } catch (e) { /* ignore */ }
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
  conn: "connecting", open: null, takes: {}, styleOpen: false, audioOpen: false, advOpen: false, settingsOpen: true, uploading: {},
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
    bypassed: !!m.bypassed }));
  p.voices = (p.voices || []).map((v) => ({ id: v.id || uid("v"), label: v.label || "", file: v.file || "",
    subfolder: v.subfolder || "", type: "input", original_name: v.original_name || v.file || "",
    sha256: v.sha256 || null, size_bytes: v.size_bytes ?? null, start: Math.max(0, Number(v.start) || 0),
    length: Math.max(0, Number(v.length) || 0), bypassed: !!v.bypassed }));
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
    standalone: !!s.standalone && s.kind !== "clip",   // its take was rendered on its own (no pins)
    seam: ["ok", "mismatch"].includes(s.seam) ? s.seam : null,   // its left join, as last known
    cleared: !!s.cleared && s.status === "queued",              // Clear render: waiting to render again
    clip: s.kind === "clip" ? Object.assign({ file: "", subfolder: "", original_name: "", sha256: null,
      size_bytes: null, trim_in: 0, frames: 0, duration: null, fps: null, width: null, height: null,
      has_audio: false, audio: "mute" }, s.clip || {}) : null }));
  for (const s of p.shots) if (s.kind === "clip") s.status = "approved";   // clips are never sampled
  p.audio = Object.assign({ file: null, subfolder: "", type: "input", size_bytes: null, sha256: null,
    original_name: null, start: 0, length: 0, lip_sync: false, voice_ref: false,
    final_override: false, melband_model: "Infinite Talk\\MelBandRoformer_fp16.safetensors" }, p.audio || {});
  const s = Object.assign({}, DEFAULT_SETTINGS, p.settings || {});
  s.turbo = Object.assign({}, DEFAULT_SETTINGS.turbo, s.turbo || {});
  s.rtx_vsr = Object.assign({}, DEFAULT_SETTINGS.rtx_vsr, s.rtx_vsr || {});
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
  return i < 0 ? null : `<Audio ${(P().audio.voice_ref ? 1 : 0) + i + 1}>`;
}
const audioRefCount = () => liveVoices().length + (P().audio.voice_ref ? 1 : 0);
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

/** The join chip: what the user wants at this Shot's joins. Its choices come
 *  from the Shots that exist next to it (0.8.3):
 *    none            → Cut
 *    a Shot before   → Cut, Context, Continuous
 *    a Shot after    → Cut, Continuous
 *  Continuous reads "Bridge" when the Shots on both sides are approved. Kept in
 *  s.join ("cut" | "context" | "bridge"; Continuous is the default). Render all
 *  and the main button read it as the join with the Shot before; ▶ on one Shot
 *  applies it to the approved Shots next to it at that moment (chipPlan). */
function chipNear(s) {
  const act = active(), i = act.indexOf(s);
  return { prev: i > 0 ? act[i - 1] : null, next: i >= 0 ? act[i + 1] || null : null };
}
function chipSides(s) {
  const act = active(), i = act.indexOf(s);
  const ok = (x) => !!x && (x.kind === "clip" || (x.status === "approved" && !!x.take));
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
  const audioMatters = p.audio.lip_sync || p.audio.voice_ref;
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
  if (key === "audio") return p.audio.lip_sync || p.audio.voice_ref;
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
  if (!multi && (!upscales || filmSeconds() <= vsrChunkS() + 0.5)) return runNow(opts);
  const C = { opts, slug: P().slug, jobId: opts.jobId || null, upscales,
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
  const i = C.k, o = C.opts, run = C.runs[C.r], trim = C.r > 0 ? C.trim : 0;
  const extra = {};
  if (run) {
    extra.omit = active().map((x) => x.id).filter((id) => !run.includes(id));
    extra.upto = run[run.length - 1];
  }
  const span = !run ? "" : run.length === 1 ? `Shot ${numOf(run[0])}` : `Shots ${numOf(run[0])}–${numOf(run[run.length - 1])}`;
  const runTxt = C.runs.length > 1 ? ` · run ${C.r + 1} of ${C.runs.length} (${span})` : "";
  const chunkTxt = C.upscales ? ` · chunk ${C.c + 1}${C.nr ? " of " + C.nr : ""}` : "";
  await runNow(Object.assign({}, o, extra, {
    chunk: { index: i, start: trim + C.c * C.L, length: C.L, audio: C.c === 0 && (C.r === 0 || !C.song) },
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
  const trim = C.r > 0 ? C.trim : 0;
  if (C.c === 0) {
    // this run's frames (after the overlap it hides), and its Shots' times on the whole film
    const shown = Math.max(0, fr.total - trim);
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
    C.offset += shown / FPS;
  }
  C.files.push({ filename: v.filename, subfolder: v.subfolder });
  if (m) C.masters.push({ filename: m.filename, subfolder: m.subfolder });
  const a = built.nodes.audio_file && ((outputs[built.nodes.audio_file] || {}).longshot_audio || [])[0];
  if (a) {
    if (C.song || C.runs.length === 1) C.audio = { filename: a.filename, subfolder: a.subfolder };
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
      body: { prefix: C.prefix, chunks: C.files, audio: C.audio || (C.audios.length ? C.audios : null), masters: C.masters } });
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
const QKEY = "h3studio.queue";

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
    group = "g" + (++Q.seq);
    Q.groups[group] = { slug: P().slug, ids: [...new Set(specs.flatMap(idsOf))], of: takes, first: {}, seams: null };
  }
  const was = waitingJobs().length + (S.busy || S.chunking ? 1 : 0);
  for (let k = 1; k <= takes; k++) {
    for (const spec of specs) {
      const ids = idsOf(spec);
      Q.jobs.push({ id: "j" + (++Q.seq), slug: P().slug, name: P().name, spec, ids, pass: k, of: takes, group,
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
        return { upto: s.id, kind: sp.kind, standalone: true, label: `${verb} Shot ${n} · ${plan.pending ? "on its own" : plan.name}${seed}${take}`,
          note: plan.name === "Context" ? "A hard cut · the last frame of the Shot before as a reference"
            : plan.pending ? "On its own · no approved Shot next to it to continue from yet" : "A fresh start from the references",
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
  if (sp.type === "export") {
    const todo = new Set(job.exportTodo || []);
    const items = approvedForExport().filter((x) => !job.exportTodo || todo.has(x.key));
    if (!items.length) return null;
    const v = P().settings.rtx_vsr || {};
    const skipped = active().filter((x) => x.kind !== "clip" && x.status !== "approved").length;
    return { kind: "export", exportClips: items.map((x) => ({ take: x.take })),
      label: `Exporting ${items.length} approved clip${items.length === 1 ? "" : "s"} · upscaled ${v.scale || 2}× ${v.quality || "ULTRA"}`,
      note: "Each approved take decoded on its own, whole, and upscaled a frame at a time",
      extra: { items: items.map((x) => ({ name: x.name, key: x.key })), skipped, kept: job.exportKept || 0, sig: upSig() },
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
  const wait = waitingJobs().length, live = Q.jobs.filter(liveJob).length;
  $("queue-count").textContent = live ? `· ${live} to go${Q.paused ? " · paused" : ""}` : Q.paused ? "· paused" : "";
  $("queue-pause").textContent = Q.paused ? "Resume" : "Pause";
  $("queue-pause").setAttribute("aria-pressed", Q.paused);
  $("queue-clear").hidden = !Q.jobs.some((j) => !liveJob(j));
  if (!Q.jobs.length) {
    $("queue").innerHTML = '<div class="q-empty peek">Nothing queued. Every render goes here and runs in order, from any project, so you can line up work and let it run.</div>';
    return;
  }
  const time = (t) => t ? new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
  const offline = S.conn !== "ok";
  const peek = Q.jobs.find((j) => j.state === "running") || Q.jobs.find((j) => j.state === "waiting") || Q.jobs[Q.jobs.length - 1];
  $("queue").innerHTML = Q.jobs.map((j) => {
    const here = P() && j.slug === P().slug;
    let sub = "", bar = "";
    if (j.state === "running") {
      const b = S.busy && S.busy.jobId === j.id ? S.busy : null;
      const pct = b ? progressOf(b) : 1;
      sub = b ? `${b.label}${b.note ? " · " + b.note : ""}` : S.restarting ? "Waiting for ComfyUI to restart…" : "Starting…";
      bar = `<div class="q-bar"><div style="width:${pct}%"></div></div>`;
    } else if (j.state === "waiting") {
      const pos = jobPos(j);
      sub = j.error ? j.error : offline ? "Waits for ComfyUI to be back" : Q.paused ? "Paused" : pos === 1 && (S.busy || S.chunking) ? "Next" : `#${pos} in line`;
    } else if (j.state === "done") sub = `Done · ${time(j.ended)}`;
    else if (j.state === "skipped") sub = j.error || "Skipped";
    else sub = `${j.state === "stopped" ? "Stopped" : "Failed"} · ${time(j.ended)}${j.error ? " · " + j.error : ""}`;
    const w = j.state === "waiting", idx = waitingJobs().indexOf(j);
    const acts = w ? `<button class="ghost sm" data-action="queue-up"${idx <= 0 ? " disabled" : ""} aria-label="Move up">▲</button>
        <button class="ghost sm" data-action="queue-down"${idx < 0 || idx >= wait - 1 ? " disabled" : ""} aria-label="Move down">▼</button>
        <button class="ghost sm" data-action="queue-remove" aria-label="Remove from the queue">${CROSS}</button>`
      : j.state === "running" ? `<button class="ghost sm" data-action="queue-stop" title="Stop this job; the queue goes on">Stop</button>`
      : `${j.state === "failed" || j.state === "stopped" ? '<button class="ghost sm" data-action="queue-retry" title="Run it again">↻</button>' : ""}
        <button class="ghost sm" data-action="queue-remove" aria-label="Remove from the list">${CROSS}</button>`;
    return `<div class="q-row st-${j.state}${j === peek ? " peek" : ""}" data-job="${esc(j.id)}">
      <span class="q-icon" aria-hidden="true">${Q_ICON[j.state] || "·"}</span>
      <span class="q-main"><button class="q-name${here ? " here" : ""}" data-action="queue-open" title="${here ? "The open project" : "Open this project"}">${esc(j.name)}</button>
        · ${esc(j.title)}<div class="q-sub">${esc(sub)}</div>${bar}</span>
      <span class="q-act">${acts}</span></div>`;
  }).join("");
}

async function queueAction(action, el) {
  const row = el.closest("[data-job]");
  const job = row && Q.jobs.find((j) => j.id === row.dataset.job);
  if (action === "queue-pause") { Q.paused = !Q.paused; saveQueue(); renderQueue(); if (!Q.paused) queueNext(); return; }
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
  const nj = { id: "j" + (++Q.seq), slug: job.slug, name: job.name, spec: rest, ids: restIds, pass: job.pass, of: job.of,
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
          toast(`All ${job.exportKept} approved clip${job.exportKept === 1 ? " is" : "s are"} already upscaled in Approved_Clips; nothing to do.`);
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
  joins = null }) {
  if (S.busy) return;
  if (Object.keys(S.uploading).length) { toast("Wait for the image upload to finish."); return; }
  S.error = null;
  if (comfyTooOld()) { S.error = comfyTooOldText(); render(); return; }
  const missing = kind === "clips" || kind === "export" ? [] : missingRefs();
  if (missing.length) {
    S.error = `${missing.length} reference${missing.length > 1 ? "s are" : " is"} missing — relink or bypass ${missing.length > 1 ? "them" : "it"}.`;
    render();
    return;
  }
  const lost = missingModels(P());
  if (lost.length) {
    S.error = `Model file${lost.length > 1 ? "s" : ""} not found in ComfyUI's model folders: ${lost.join(", ")}. ` +
      `Choose ${lost.length > 1 ? "them" : "it"} under Advanced (Browse… can also add a folder ComfyUI doesn't know about).`;
    if (!lost.every((x) => x.startsWith("Vocal"))) S.advOpen = true;
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
  if (drop.size) project.shots.forEach((x) => { if (drop.has(x.id)) x.bypassed = true; });
  if (audioMissing() && (project.audio.lip_sync || project.audio.voice_ref || project.audio.final_override)) {
    project = Object.assign({}, project, { audio: Object.assign({}, project.audio,
      { lip_sync: false, voice_ref: false, final_override: false }) });
    toast("The audio file is missing, so this render runs without the audio routes.");
  }
  let built;
  try {
    // Renders while reviewing don't decode the stitched film: each Shot that
    // gets a new take is decoded on its own into its clip (Long Shot 1.6).
    const clipsFor = !dry && (kind === "render" || kind === "reroll")
      ? project.shots.filter((x) => !x.bypassed && x.kind !== "clip" && !x.lock).map((x) => x.id) : null;
    const body = takeClips ? { project, take_clips: takeClips } : exportClips ? { project, export_clips: exportClips }
      : { project, upto, dry_run: !!dry, final, standalone, clips_for: clipsFor, chunk };
    built = await api("/longshot/build", { method: "POST", body });
  } catch (e) {
    undoSeeds();
    S.error = e.message;
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
  } else if (stopped || b.stopped) {
    toast("Stopped. Finished segments stay in Long Shot's memory.");
  } else if (!entry) {
    S.error = "The render finished but ComfyUI's history has no record of it.";
  } else if (b.kind === "clips") {
    await adoptClips(Object.entries(b.built.nodes.clips || {}).map(([key, node]) => ({ key, node })), entry.outputs || {});
    if (S.exportAfter) { S.exportAfter = false; setTimeout(exportApproved, 0); }
  } else if (b.kind === "export") {
    await exportDone(b, entry.outputs || {});
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
  const shots = active();
  if (!shots.length) return;
  if (S.busy || S.chunking) { toast("The dry run starts when ComfyUI is free (a render is running)."); return; }
  runNow({ upto: shots[shots.length - 1].id, dry: true, kind: "dry", label: "Dry run · planning every shot",
    note: "Nothing is sampled", onDone: ({ rows, text, built }) => {
      S.dry = { rows, text, chain: built.chain };
      showModal("Dry run · full prompts", text);
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
    if (e.target.closest("#scrub, .tl-arrow")) return;
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

/** Decode takes on their own into clips (nothing samples, nothing is stitched). */
async function makeClips(takes) {
  const list = takes.filter((t) => t && t.take && !S.clips[takeStem(t.take)]).slice(0, 24);
  if (!list.length || S.busy || S.queuing || !S.clipsReady) return;
  list.forEach((t) => S.clipTried.add(t.take));
  await runNow({ kind: "clips", takeClips: list.map((t) => ({ key: takeStem(t.take), take: t.take })),
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
    name: `Shot ${String(numOf(s.id)).padStart(width, "0")} – seed ${seedOfTake(s)}`,
  }));
}

/** What an upscaled export file was made with: same take + same settings = reuse it. */
const upSig = () => { const v = P().settings.rtx_vsr || {}; return `${Number(v.scale || 2)}x ${v.quality || "ULTRA"}`; };

/** Before an upscaled export: clips already upscaled from the same take stay
 *  (renamed if their number moved); stale ones leave the folder. */
async function exportPrepare(job) {
  const items = approvedForExport();
  const r = await api(`/longshot/approved/${encodeURIComponent(P().slug)}`, { method: "POST",
    body: { mode: "keep", sig: upSig(), prores: !!P().settings.prores_master, items: items.map((x) => ({ key: x.key, name: x.name })) } });
  job.exportTodo = r.todo || [];
  job.exportKept = (r.kept || []).length;
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
  const items = approvedForExport();
  if (!items.length) { toast("No approved Shots to export yet."); return; }
  const skipped = active().filter((s) => s.kind !== "clip" && s.status !== "approved").length;
  if (P().settings.export_upscale) {
    enqueue({ type: "export" });
    return;
  }
  const missing = items.filter((x) => !S.clips[x.key]);
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
      body: { mode: "copy", items: items.map((x) => ({ key: x.key, name: x.name })) } });
    exportedToast(r, skipped);
  } catch (e) { toast("Export failed: " + e.message); }
}

async function exportDone(b, outputs) {
  const ex = b.built.nodes.export || {};
  const items = (b.extra.items || []).map((it, i) => {
    const nd = ex[String(i + 1)] || {};
    const ui = outputs[nd.video] || {};
    return { name: it.name, key: it.key, video: (ui.chunk_video || [])[0] || null, master: (ui.chunk_master || [])[0] || null,
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
    act.every((s, i) => vchain[i] === s.id && !!rowOf(s));
  const half = (Number(P() && P().settings.overlap) || 22) / 24 / 2;
  const entries = [];
  for (const s of act) {
    const r = rowOf(s), key = s.kind !== "clip" && isRendered(s) ? takeStem(s.take) : null;
    const c = key ? S.clips[key] : null;
    let e;
    if (exact) e = { src: loUrl, off: r.start, dur: r.end - r.start, kind: "video" };
    else if (s.kind === "clip" && s.clip.file) {
      e = { src: viewURL({ filename: s.clip.file, subfolder: s.clip.subfolder, type: "input" }),
        off: Number(s.clip.trim_in) || 0, dur: (s.clip.frames || 24) / 24, kind: "source" };
    } else if (c && c.dur > 0) e = { src: clipFile(key, ".mp4"), off: 0, dur: c.dur, kind: "take" };
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
  for (const e of entries) {
    e.start = exact ? e.off : t;
    t = e.start + e.dur;
  }
  const sig = JSON.stringify(entries.map((e) => [e.id, e.src, e.off, e.dur]));
  const changed = sig !== TL.sig;
  TL = { exact, entries, total: t, sig };
  return changed;
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
  if (!e.src && PL.playing) return PL.gapT + (performance.now() - PL.gapWall) / 1000;
  return PL.t;
}

function showEntry(e) {
  const any = TL.entries.some((x) => x.src);
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
}

function pausePlayer() {
  PL.t = tlTime();
  PL.playing = false;
  video.pause();
  setPlayIcon(false);
  $("play").setAttribute("aria-label", "Play");
  updateTime();
  syncLive();
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

function renderVolume() {
  const silent = video.muted || video.volume === 0;
  $("vol-icon").innerHTML = silent ? VOL_PATHS.muted : video.volume < 0.5 ? VOL_PATHS.low : VOL_PATHS.high;
  $("mute-btn").setAttribute("aria-pressed", silent);
  $("mute-btn").setAttribute("aria-label", silent ? "Unmute (M)" : "Mute (M)");
  $("mute-btn").title = silent ? "Unmute (M)" : "Mute (M)";
  $("volume").value = String(video.muted ? 0 : video.volume);
}

function toggleMute() {
  if (video.muted || video.volume === 0) {
    video.muted = false;
    if (video.volume === 0) video.volume = Number(store("h3studio.volumeBeforeMute")) || 0.8;
  } else {
    video.muted = true;
  }
  renderVolume();          // don't wait for the async volumechange event
}

(function initVolume() {
  const v = Number(store("h3studio.volume"));
  video.volume = Number.isFinite(v) && v >= 0 && v <= 1 && store("h3studio.volume") !== null ? v : 1;
  video.muted = store("h3studio.muted") === "1";
  renderVolume();
})();

video.addEventListener("volumechange", () => {
  store("h3studio.volume", String(video.volume));
  store("h3studio.muted", video.muted ? "1" : "0");
  if (video.volume > 0) store("h3studio.volumeBeforeMute", String(video.volume));
  renderVolume();
});
$("volume").addEventListener("input", (e) => {
  const v = Number(e.target.value);
  video.volume = v;
  video.muted = v === 0;
  renderVolume();
});


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
  const nextA = (P().audio.voice_ref ? 1 : 0) + liveVoices().length + 1;
  cards.push(`<button class="addtile voice-add" data-action="add-voice">${PLUS} <span>Add audio reference · ${esc(`<Audio ${nextA}>`)}<br><span class="muted small">a voice timbre · or drop audio here</span></span></button>`);
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
function voiceTag(c) {
  if (!c.voice) return "";
  const v = voiceById(c.voice), a = audioLabelOf(v);
  if (a) return `<div><span class="voice-tag" title="Gets its voice timbre from ${esc(a)}${v.label ? " " + esc(v.label) : ""}">🔊 ${esc(a)}</span></div>`;
  return `<div><span class="voice-tag missing" title="Its voice reference is ${v ? "bypassed" : "removed"}, so the prompt leaves the voice out. Pick another in its editor.">🔊 voice ${v ? "off" : "removed"}</span></div>`;
}

/** An audio reference card: <Audio N>, label, player, trim. */
function voiceCard(v) {
  const a = audioLabelOf(v), state = S.refState["voice:" + v.id];
  const missing = !!v.file && (state === "missing" || state === "invalid");
  const who = liveCast().filter((c) => c.voice === v.id).map((c) => c.label || picOf(c));
  const over = !v.bypassed && a && Number(a.match(/\d+/)[0]) > MAX_AUDIO_REFS;
  const src = v.file && !missing ? viewURL({ filename: v.file, subfolder: v.subfolder, type: "input" }) : "";
  const up = S.uploading["voice:" + v.id] ? '<div class="drop-busy">Uploading…</div>' : "";
  return `<div class="card voice-card${v.bypassed ? " off" : ""}${missing && !v.bypassed ? " missing" : ""}" data-voice="${esc(v.id)}">${up}
      <div class="thumb-col"><button class="thumb voice-thumb" data-action="voice-replace" title="Choose another audio file, or drop one on this card" aria-label="Replace the audio of ${esc(v.label || a || "this voice")}">♪</button></div>
      <div class="card-body">
        <div class="card-top"><span class="pic">${esc(v.bypassed ? "bypassed" : a || "—")}</span>
          <input class="inline voice-label" data-voice-field="label" value="${esc(v.label)}" placeholder="<voice>" spellcheck="false" aria-label="Voice reference label"></div>
        <div class="muted small">${over ? '<span class="warn">Long Shot takes 3 reference audios: bypass one.</span>'
          : who.length ? `Voice timbre of ${esc(who.join(", "))}` : "Not linked yet: pick it in a picture's editor (gets its voice timbre from)."}</div>
        ${missing ? `<div class="missing">Missing: ${esc(v.original_name || v.file)}</div>`
          : src ? `<audio class="voice-play" controls preload="none" src="${esc(src)}"></audio>` : ""}
        <div class="voice-trim">
          <label class="lbl-row">Start <input type="number" min="0" step="0.1" data-voice-field="start" value="${esc(v.start || 0)}" style="width:64px"> s</label>
          <label class="lbl-row">Length <input type="number" min="0" step="0.1" data-voice-field="length" value="${v.length ? esc(v.length) : ""}" placeholder="all" style="width:64px"> s</label>
        </div>
        <div class="muted small voice-file" title="${esc((v.subfolder ? v.subfolder + "/" : "") + v.file)}">${esc(v.original_name || v.file)}</div>
      </div>
      <div class="card-tools">
        <button class="icon${v.bypassed ? " on" : ""}" data-action="bypass-voice" aria-pressed="${v.bypassed}" title="${v.bypassed ? "Turn back on" : "Bypass"}">${POWER}</button>
        <button class="icon x" data-action="remove-voice" title="Remove" aria-label="Remove ${esc(v.label || "this voice reference")}">${CROSS}</button>
      </div></div>`;
}
/** RefMods (0.8.6): <Picture|Video|Audio N>, numbered after the references of that kind. */
const REFMOD_ICON = { image: "🖼", video: "🎞", audio: "🔊" };
const liveRefmods = () => (P().refmods || []).filter((m) => !m.bypassed && m.name && m.strength > 0);
function refmodLabelOf(m) {
  const i = liveRefmods().indexOf(m);
  if (i < 0) return null;
  const counts = { image: liveCast().length, video: 0, audio: liveVoices().length };
  let label = null;
  liveRefmods().slice(0, i + 1).forEach((x) => { counts[x.kind] += 1; label = `<${{ image: "Picture", video: "Video", audio: "Audio" }[x.kind]} ${counts[x.kind]}>`; });
  return label;
}
function refmodCard(m) {
  const a = refmodLabelOf(m);
  return `<div class="card refmod-card${m.bypassed ? " off" : ""}" data-refmod="${esc(m.id)}">
      <div class="thumb-col"><div class="thumb refmod-thumb" title="RefMod (${esc(m.kind)}): no preview">${REFMOD_ICON[m.kind] || "🖼"}</div></div>
      <div class="card-body">
        <div class="card-top"><span class="pic">${esc(m.bypassed ? "bypassed" : a || "—")}</span>
          <input class="inline refmod-label" data-refmod-field="label" value="${esc(m.label)}" placeholder="<name>" spellcheck="false" aria-label="RefMod label"></div>
        <input class="inline refmod-desc" data-refmod-field="desc" value="${esc(m.desc)}" placeholder="Add a description…" aria-label="RefMod description">
        <div class="muted small refmod-name">RefMod · ${esc(m.name)}</div>
        <label class="lbl-row small">Strength <input type="number" min="0" max="1" step="0.05" data-refmod-field="strength" value="${esc(m.strength)}" style="width:64px"></label>
      </div>
      <div class="card-tools">
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
    `<label for="f-${k}">${label}</label><textarea class="fit" id="f-${k}" data-style="${k}" rows="${rows}">${esc(st[k])}</textarea>`).join("");
  fitAll($("style"));
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
  pending: "continues from the Shot before in Render all. ▶ on this Shot alone pins it to the approved Shots next to it; with none approved yet it renders on its own.",
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
  // the join chip: how ▶ renders it, from the approved Shots next to it
  const actR = active(), prevR = !s.bypassed ? actR[actR.indexOf(s) - 1] : null;
  const cj = chipJoin(s), opts = chipOptions(s);
  const icon = { bridge: "↔", context: "⧉", cut: "|" }[cj];
  const joinChip = !s.bypassed && s.kind !== "clip"
    ? `<button class="join-chip j-${esc(cj)}${opts.length < 2 ? " only" : ""}" data-action="cycle-join" title="${esc(chipName(s) + ": " + CHIP_HELP[chipKey(s)])}${
      opts.length < 2 ? " No Shot next to it, so Cut is the only choice." : ` Click to switch: ${opts.map((o) => chipName(s, o)).join(" → ")}.`}">${icon} ${chipName(s)}</button>` : "";
  const ctxStale = s.join === "context" && s.status !== "queued" && s.context_from && prevR &&
    (prevR.kind === "clip" ? `clip:${prevR.id}` : prevR.take) !== s.context_from;
  const ctxFlag = ctxStale ? `<span class="flag cut" title="The Shot before has a different take now. Re-render ${title} to take its new last frame.">context changed</span>` : "";
  const ctxBtn = ctxStale ? `<button class="ghost sm bridge" data-action="context-redo" title="Re-render ${title} from the new last frame of the Shot before (the Shots after it keep their takes)">Re-render</button>` : "";
  return `${play}<button class="shot-head${play ? " has-play" : ""}" data-action="toggle-shot" aria-expanded="${open}">
          ${play ? "" : `<span class="sdot" style="background:${L.dot};color:${L.fg}">${L.icon}</span>`}
          <span class="stitle">${title}</span>
          <span class="smeta">${esc(s.seconds)}s · seed ${esc(seed)}</span>
          <span class="sprev">${esc(s.text) || '<i class="muted">empty</i>'}</span>
          ${flag}${cut}${standaloneTag}${ctxFlag}
          <span class="chip" style="background:${L.chipBg};color:${L.chipFg};border-color:${chipBorder}">${L.label}</span>
        </button>
        <div class="shot-tools">
          ${promptFlag}${promptBtn}${joinChip}${ctxBtn}
          ${canReroll ? `<button class="icon lg reroll" data-action="reroll-shot" title="Reroll ${title} (new seed)" aria-label="Reroll ${title}">⟳</button>` : ""}
          <button class="icon lg${s.bypassed ? " on" : ""}" data-action="bypass-shot" aria-pressed="${s.bypassed}" title="${s.bypassed ? "Turn shot back on" : "Bypass shot"}">${POWER}</button>
          <button class="icon lg x" data-action="remove-shot" title="Remove" aria-label="Remove ${title}">${CROSS}</button>
        </div>`;
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
  if (deferIfHeld("shots")) return;
  let prevActive = null;
  const slots = new Set(anchorKeys());
  const lastId = active().length ? active()[active().length - 1].id : null;
  /** The Anchors column tiles that sit on this card's edges. */
  const tiles = (s) => s.bypassed ? "" : (slots.has(s.id) ? anchorSlot(s.id, "top") : "") +
    (s.id === lastId && slots.has("end") ? anchorSlot("end", "bottom") : "");
  $("shots-panel").classList.toggle("has-anchors", slots.size > 0);
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
          <label class="lbl-row">Seed <input class="mono" data-shot-field="shot_seed" value="${s.shot_seed < 0 ? "" : esc(s.shot_seed)}" placeholder="auto${isAuto(s) && s.status !== "queued" && hasSeed(s.seed_used) ? ` · ${s.seed_used}` : ""}" style="width:120px"${ro}></label>
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
        <span class="smeta">${(s.clip.frames / 24).toFixed(2)}s · clip</span>
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
        ${e.thumb ? `style="background-image:url('${esc(e.thumb)}')"` : ""}><span class="tl-num">${sh.kind === "clip" ? "▶" : "S"}${numOf(sh.id)}</span></button>
      ${nav}</div>`;
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

const ROUTES = [["lip_sync", "Lip sync to song", "song → Song Track → Long Shot", "per segment"],
  ["final_override", "Song in final video", "replaces generated audio in Video Combine", "output"]];

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
  preview.el.pause();
  cancelAnimationFrame(preview.raf);
  if (P()) renderAudio();
}

function previewTick() {
  if (!preview.on) return;
  const el = preview.el;
  if (el.currentTime >= preview.end || el.ended) { stopPreview(); return; }
  const t = $("ap-time");
  if (t) t.textContent = apLabel();
  preview.raf = requestAnimationFrame(previewTick);
}

function startPreview() {
  const a = P().audio;
  if (!a.file || audioMissing()) return;
  const el = preview.el;
  const src = viewURL({ filename: a.file, subfolder: a.subfolder, type: "input" });
  if (preview.src !== src) { el.src = src; preview.src = src; }
  preview.start = Math.max(0, Number(a.start) || 0);
  const len = Math.max(0, Number(a.length) || 0);
  preview.end = len ? preview.start + len : Infinity;
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
    el.currentTime = preview.start;
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


video.addEventListener("volumechange", () => { preview.el.volume = video.volume; });

function renderAudio() {
  const a = P().audio;
  const names = [["lip_sync", "lip sync"], ["voice_ref", "voice ref"], ["final_override", "song in final"]]
    .filter(([k]) => a[k]).map(([, n]) => n);
  $("audio-summary").textContent = names.length ? "On: " + names.join(" · ") : "Off · generated audio only";
  $("audio-chev").textContent = S.audioOpen ? "Hide ▴" : "Show ▾";
  $("audio").hidden = !S.audioOpen;
  if (!S.audioOpen) { stopPreview(); return; }
  $("audio").innerHTML = `<div style="margin-top:12px">
      <div class="lbl">Audio file <span class="muted small">· drop a song anywhere on this panel</span>
        <div class="pick"><select class="field" data-relink="audio" aria-label="Audio file">${inputOptions("audio", a.subfolder, a.file, "No audio")}</select>
          <button class="ghost sm browse" data-action="pick-audio"${S.uploading.audio ? " disabled" : ""}>${S.uploading.audio ? "Uploading…" : "Upload…"}</button></div></div>
      ${audioMissing() ? `<div class="err" style="margin-top:8px"><span>Missing: ${esc(a.original_name || a.file)}. Renders run without the audio routes until you pick the file again.</span></div>`
        : S.refState.audio === "changed" ? '<div class="warnbox" style="margin-top:8px"><span>The audio file changed since it was saved.</span></div>' : ""}
      <div class="shot-opts" style="margin-top:10px">
        <label class="lbl-row">Start <input class="field" type="number" step="0.1" min="0" data-audio="start" value="${esc(a.start)}" style="width:80px"> s</label>
        <label class="lbl-row">Length <input class="field" type="number" step="0.1" min="0" data-audio="length" value="${esc(a.length)}" style="width:80px"> s</label>
        <button class="ghost sm audio-play" data-action="audio-preview" aria-pressed="${previewing()}"${a.file && !audioMissing() ? "" : " disabled"}
          title="${a.file ? "Play the clip the render will use: from Start, for Length (0 = to the end)" : "Choose an audio file first"}"
          aria-label="${previewing() ? "Stop audio preview" : "Play audio preview"}">${previewing() ? STOP_ICON : PLAY_ICON}<span>${previewing() ? "Stop" : "Play"}</span></button>
        <span class="mono muted small" id="ap-time">${previewing() ? apLabel() : ""}</span>
      </div>
      <div style="display:flex;flex-direction:column;gap:2px;margin-top:14px">
      ${ROUTES.map(([k, t, r, badge]) => `<div class="route">${switchHTML(a[k], `data-action="audio-route" data-key="${k}" aria-label="${t}"`)}
        <span class="route-text"><b>${t}</b><i>${r}</i></span><span class="badge">${badge}</span></div>`).join("")}
      </div>
      ${a.voice_ref ? `<div style="margin-top:10px">${modelField("Vocal separation model (MelBand RoFormer)", "diffusion_models", "melband",
        `<select data-melband aria-label="Vocal separation model">${fileOptions((S.opts || {}).melband, a.melband_model, "Choose…")}</select>`)}</div>` : ""}<div class="muted small" style="margin-top:8px">Pick from audio files in ComfyUI's input folder, or this project's input/longshot/${esc(P().slug)} folder.</div></div>`;
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
      <label class="lbl">Seed <input class="mono" data-base-seed inputmode="numeric" value="${esc(s.seed)}" aria-describedby="seed-help" title="Drag left / right to change it (Shift: by 10), or click and type"></label>
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
    case "viewer-show": setViewerHidden(false); break;
    case "restore-refs": restoreRefs(shotOf(el)); break;
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
    case "editor-zoom": if (editing) openLightbox(editing.id); break;
    case "lb-close": closeLightbox(); break;
    case "reroll-shot": rerollShot(shotOf(el)); break;
    case "use-seed": useSeed(shotOf(el), Number(el.dataset.seed)); break;
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
      if (k !== "final_override") sharedChanged("Audio");
      commit();
      break;
    }
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
    case "queue-remove": case "queue-up": case "queue-down": queueAction(a, el); break;
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
  if (el.dataset.melband !== undefined) {
    p.audio.melband_model = el.value || null;
    if (changed && p.audio.voice_ref) sharedChanged("Audio");
    return commit();
  }
  if (el.dataset.audio) {
    const k = el.dataset.audio;
    p.audio[k] = Math.max(0, parseFloat(el.value) || 0);
    stopPreview();
    if (changed && (p.audio.lip_sync || p.audio.voice_ref)) sharedChanged("Audio");
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
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === "m" || e.key === "M") { e.preventDefault(); toggleMute(); }
  else if (e.key === "f" || e.key === "F") { e.preventDefault(); toggleFullscreen(); }
  else if (e.key === "t" || e.key === "T") { e.preventDefault(); setTheater(!S.theater); }
  else if (e.key === " ") { e.preventDefault(); togglePlay(); }
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
    if (isAudio && (p.audio.lip_sync || p.audio.voice_ref)) sharedChanged("Audio");
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
  if (isAudio) Object.assign(item, { file: name });
  else Object.assign(item, { image: name });
  Object.assign(item, { subfolder: sub, original_name: name, sha256: info.sha256 || null,
    size_bytes: info.size_bytes ?? null });
  S.refState[key] = info.state === "missing" || info.state === "invalid" ? info.state : "ok";
  S.refInfo[key] = info;
  if (same) toast("Relinked — it's the same file, so nothing re-renders.");
  else if (isAudio) { if (p.audio.lip_sync || p.audio.voice_ref) sharedChanged("Audio"); }
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
  Object.assign(p.audio, { file: info.name, subfolder: info.subfolder, original_name: info.name,
    sha256: info.sha256, size_bytes: info.size_bytes });
  S.refState.audio = "ok";
  S.refInfo.audio = Object.assign({ state: "ok" }, info);
  await loadInputs();
  if (!same && (p.audio.lip_sync || p.audio.voice_ref)) sharedChanged("Audio");
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
  if (editing && !$("editor").hidden) {
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
  editing = { id: c.id };
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
  const vs = P().voices || [];
  sel.innerHTML = `<option value="">None</option>` + vs.map((v) => {
    const a = audioLabelOf(v);
    return `<option value="${esc(v.id)}">${esc(a || "(off)")} ${esc(v.label || v.original_name || "")}</option>`;
  }).join("") + (c.voice && !voiceById(c.voice) ? `<option value="${esc(c.voice)}">(removed)</option>` : "");
  sel.value = c.voice || "";
  $("editor-voice-row").classList.toggle("empty", !vs.length);
  $("editor-voice-hint").textContent = vs.length ? "" : "Add an audio reference in Cast & Scenes first.";
}

function editorDirty() {
  const c = editing && P().cast.find((x) => x.id === editing.id);
  return !!c && ($("editor-label").value !== c.label || $("editor-desc").value !== c.desc ||
    ($("editor-voice").value || null) !== (c.voice || null));
}

function closeEditor() { $("editor").hidden = true; editing = null; }

async function editorSave() {
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
  const ar = video.videoWidth ? video.videoWidth / video.videoHeight
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
  const pick = S.projects.find((p) => p.slug === want) || S.projects[0];
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
$("viewer-mini").addEventListener("click", (e) => { if (!e.target.closest("button")) setViewerHidden(false); });
