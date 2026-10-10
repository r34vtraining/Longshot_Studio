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
  "MiniMaxH3LongShot", "MiniMaxH3SigmaShift", "ImageResizeKJv2", "VHS_VideoCombine"];

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
  gen: 0,          // bumped by every re-queue rule, so an edited Shot only returns to its take if nothing else changed
  bad: {},         // "<shot id>:<field>" -> the field holds something that isn't a value yet (typing)
};
const P = () => S.project;

const DEFAULT_SETTINGS = {
  model: "", clip: "", video_vae: "", audio_vae: "",
  turbo: { on: true, lora: "", strength: 1.0 },
  loras: [0, 1, 2].map(() => ({ on: false, name: null, strength: 1.0 })),
  steps: 8, megapixels: 0.6, aspect: "16:9", ref_image_size: "match", ref_resize_px: 1500,
  sampler: "er_sde", scheduler: "beta57", overlap: 22, seed: 1722, seed_mode: "increment",
  shift_video: 12, shift_audio: 3, sage_attention: "auto", save_segments: true,
  rtx_vsr: { on: false, scale: 2, quality: "ULTRA" },
  save_png: false, save_noaudio: false,      // Video Combine's side files: deleted after each render
  prores_master: false,                      // Upscale final also writes a 10-bit ProRes 422 HQ .mov
};

function normalize(p) {
  p.version = p.version || 1;
  p.name = p.name || "Untitled";
  p.cast = (p.cast || []).map((c) => ({ id: c.id || uid("c"), label: c.label || "", desc: c.desc || "",
    role: c.role || "appearance", image: c.image || "", subfolder: c.subfolder || "", type: "input",
    size_bytes: c.size_bytes ?? null, sha256: c.sha256 || null,
    original_name: c.original_name || c.image || "", bypassed: !!c.bypassed }));
  p.style = Object.assign({ summary: "", retention: "", style_line: "", soundscape: "", music: "N/A",
    task_types: ["reference generation"] }, p.style || {});
  p.shots = (p.shots || []).map((s) => ({ id: s.id || uid("s"), text: s.text || "",
    seconds: Number(s.seconds) || 5, shot_seed: s.shot_seed ?? -1, bypassed: !!s.bypassed,
    status: ["approved", "review", "queued"].includes(s.status) ? s.status : "queued",
    was_approved: !!s.was_approved, was_rendered: !!s.was_rendered,
    prev_seeds: Array.isArray(s.prev_seeds) ? s.prev_seeds.slice(-10) : [],
    take: s.take || null, window: s.window || null, take_seconds: s.take_seconds ?? null,
    // what the current take was rendered with: editing back to exactly this brings the take back
    rendered: s.rendered && typeof s.rendered === "object" ? s.rendered
      : s.take && s.status !== "queued" ? { text: s.text || "", seconds: Number(s.seconds) || 5, seed: s.shot_seed ?? -1 } : null,
    edit_from: s.edit_from && typeof s.edit_from === "object" ? Object.assign({}, s.edit_from, { gen: 0 }) : null,
    join: s.join === "cut" ? "cut" : "bridge",
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
  p.stats = p.stats || { rate: null, n: 0 };
  return p;
}

const active = () => P().shots.filter((s) => !s.bypassed);
const liveCast = () => P().cast.filter((c) => !c.bypassed);
const numOf = (id) => active().findIndex((s) => s.id === id) + 1;
const titleOf = (s) => (s ? "Shot " + numOf(s.id) : "—");
const reviewShot = () => active().find((s) => s.status === "review");
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
function cutBefore(s) {
  if (!s || s.bypassed || s.status === "queued") return false;
  const act = active(), prev = act[act.indexOf(s) - 1];
  if (!prev || s.join === "cut" || prev.kind === "clip" || s.kind === "clip" || prev.status === "queued") return false;
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
    sh.seam = prev && isRendered(prev) && prev.kind !== "clip" && sh.join !== "cut" ? "mismatch" : null;
    if (next && next.kind !== "clip" && next.status !== "queued" && next.join !== "cut") next.seam = "mismatch";
  }
}
const renderingId = () => (S.busy && (S.busy.kind === "render" || S.busy.kind === "reroll") ? S.busy.target : null);
const clock = (iso) => (iso || "").slice(11, 16);

/** Non-bypassed references whose file is gone (or never chosen). */
function missingRefs() {
  const clips = active().filter((s) => s.kind === "clip" &&
    (!s.clip.file || ["missing", "invalid"].includes(S.refState["clip:" + s.id])))
    .map((s) => ({ label: titleOf(s) + "'s clip" }));
  return liveCast().filter((c) => !c.image || ["missing", "invalid"].includes(S.refState[c.id])).concat(clips);
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
  const relinked = relinkModels(S.project);
  if (relinked) {
    scheduleSave();
    toast(`Found ${relinked} model file${relinked > 1 ? "s" : ""} by name in this machine's model folders.`);
  }
  Object.assign(S, { dry: null, error: null, loop: false, conflict: null, refState: {}, refInfo: {},
    segStats: null, checkedFor: null, takes: {} });
  $("conflict").hidden = true;
  S.saveState = p.saved_at ? "Saved · " + clock(p.saved_at) : "";
  S.open = (reviewShot() || nextQueued() || {}).id || null;
  store("h3studio.project", P().slug);
  loadVideo();
  render();
  await Promise.all([loadInputs(), checkInputs(), loadSegStats()]);
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
  }
  if (!files.length) { S.refState = {}; return; }
  let res;
  try { res = await api("/longshot/check-inputs", { method: "POST", body: { files } }); } catch (e) { return; }
  const state = {};
  let adopted = false, changed = [];
  for (const f of res.files) {
    state[f.key] = f.state;
    S.refInfo[f.key] = f;
    const item = f.key === "audio" ? p.audio : f.key.startsWith("clip:") ? refItem(f.key) : p.cast.find((c) => c.id === f.key);
    if (!item) continue;
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
  return p.cast.find((c) => c.id === key);
}
function refName(key) { const it = refItem(key); return key === "audio" ? it.file : key.startsWith("clip:") ? it.file : it.image; }
function refLabel(key) {
  if (key === "audio") return "The song";
  if (key.startsWith("clip:")) { const sh = P().shots.find((x) => x.id === key.slice(5)); return sh ? `${titleOf(sh)}'s clip` : "A clip"; }
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
  if (!p || S.checkedFor === p.slug || S.busy || S.conn !== "ok") return;
  const done = active().filter((s) => s.status !== "queued");
  if (!done.length || missingRefs().length) { S.checkedFor = p.slug; return; }
  try {
    const q = await api("/queue");
    if ((q.queue_running || []).length || (q.queue_pending || []).length) return;
  } catch (e) { return; }
  S.checkedFor = p.slug;
  const upto = done[done.length - 1].id;
  queue({ upto, dry: true, kind: "check", label: "Checking saved takes…", note: "Nothing is sampled",
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
  const rendered = active().filter((s) => s.status !== "queued");
  S.dry = null;
  S.gen++;
  if (!rendered.length) return;
  for (const s of P().shots) {
    if (s.status === "approved") s.was_approved = true;
    else if (s.status === "review") s.was_rendered = true;
    s.status = "queued";
  }
  if (!quiet) toast(`${what} changed — all ${rendered.length} rendered shot${rendered.length > 1 ? "s" : ""} ` +
        "will render again from Shot 1. Earlier approvals are flagged.");
}

/** Approved generated Shots (clips are always "approved" and don't count). */
const approvedShots = () => active().filter((s) => s.kind !== "clip" && s.status === "approved");

/** Cast & Scenes changed with approved Shots: they keep their takes (locked
 *  takes never sample) and the change applies from the next Shot rendered.
 *  Shots under review render again. */
function keepApproved(what, withAction = false) {
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
  toast(msg, withAction ? { label: "Re-render everything", fn: () => { sharedChanged(what); commit(); } } : undefined);
}

/** Ask how a Cast & Scenes change treats approved Shots. "keep" | "all" | null (cancelled).
 *  Nothing approved: "all", no dialog (the change re-renders what's rendered, as before). */
async function askRefChange(title) {
  const ap = approvedShots();
  if (!ap.length) return "all";
  const review = active().filter((s) => s.kind !== "clip" && s.status === "review");
  const rendered = active().filter((s) => s.status !== "queued" && s.kind !== "clip");
  const est = estimateFor(rendered);
  const ans = await confirmBox({ title: `${title}`,
    body: `Keep approved Shots: the ${ap.length} approved Shot${ap.length > 1 ? "s keep their takes" : " keeps its take"} ` +
      "and nothing re-renders for them; the change applies from the next Shot you render" +
      (review.length ? ` (${review.map(titleOf).join(", ")} under review render${review.length > 1 ? "" : "s"} again)` : "") +
      `. Re-render everything: all ${rendered.length} rendered Shot${rendered.length > 1 ? "s" : ""} render again with the change` +
      (est ? `, ${est}` : "") + "; approvals are kept as a flag.",
    yes: "Keep approved Shots", alt: "Re-render everything", no: "Cancel" });
  return ans === true ? "keep" : ans === "alt" ? "all" : null;
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
function sendable(project) {
  const p = JSON.parse(JSON.stringify(project));
  // Auto seeds follow base + position - 1, but never repeat a seed another Shot
  // already froze (a Shot added before Shot 1 would otherwise get Shot 1's).
  const used = new Set(p.shots.filter((s) => Number(s.shot_seed) >= 0).map((s) => Number(s.shot_seed)));
  const base = Number(p.settings.seed) || 0;
  p.shots.filter((s) => !s.bypassed).forEach((s, i) => {
    if (s.kind === "clip" || Number(s.shot_seed) >= 0) return;
    if (p.settings.seed_mode === "same") { s.shot_seed = base; return; }
    let seed = (base + i) % (SEED_MAX + 1);
    while (used.has(seed)) seed = (seed + 1) % (SEED_MAX + 1);
    used.add(seed);
    s.shot_seed = seed;
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

async function queue({ upto, dry, kind, label, note, onDone, final = false, standalone = false, batch = null,
  omit = null, trimLeft = false }) {
  if (S.busy) return;
  if (Object.keys(S.uploading).length) { toast("Wait for the image upload to finish."); return; }
  S.error = null;
  const missing = missingRefs();
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
  let project = sendable(P());          // seeds are settled on the whole timeline first
  const target = upto;
  if (!standalone && !omit && (kind === "render" || kind === "reroll" || kind === "refresh")) upto = chainEnd(upto);
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
    built = await api("/longshot/build", { method: "POST", body: { project, upto, dry_run: !!dry, final, standalone } });
  } catch (e) {
    S.error = e.message;
    render();
    return;
  }
  const fresh = (built.warnings || []).filter((w) => !shownWarnings.has(w));
  fresh.forEach((w) => shownWarnings.add(w));
  if (fresh.length) toast(fresh.join(" "));
  let res;
  try {
    res = await api("/prompt", { method: "POST", body: { prompt: built.prompt, client_id: CLIENT_ID } });
  } catch (e) {
    S.error = describeQueueError(e);
    render();
    return;
  }
  if (kind === "render" || kind === "reroll" || kind === "final" || kind === "refresh") saveNow();   // approvals / new seed survive a closed tab
  // what each Shot is rendered with, so an edit back to exactly this can bring the take back
  const sent = {};
  for (const sh of project.shots) sent[sh.id] = { text: sh.text || "", seconds: Number(sh.seconds) };
  S.busy = {
    promptId: res.prompt_id, kind, target, label, note, baseNote: note, built, onDone, sent, batch, standalone,
    of: built.chain.length, segs: {}, segT0: {}, step: 0, phase: "queued", started: Date.now(),
  };
  if (kind === "render" || kind === "reroll") S.open = target;
  render();
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
    loadSegStats().then(renderSettings);
    saveNow();                       // save right after every finished render
  } else scheduleSave();
  // Render odd Shots: the next one in the list, unless this one failed or was stopped
  const ok = !failed && !stopped && !b.stopped && !S.error && !!entry;
  let more = false;
  if (b.batch) {
    const rest = b.batch.ids.filter((id) => { const x = P().shots.find((y) => y.id === id); return x && !x.bypassed && x.status === "queued"; });
    if (ok && rest.length) {
      more = true;
      setTimeout(() => renderAlone(P().shots.find((x) => x.id === rest[0]), { ids: rest.slice(1), of: b.batch.of }), 0);
    } else if (!ok && rest.length) toast(`Render odd Shots stopped; ${rest.length} Shot${rest.length > 1 ? "s" : ""} still to render.`);
  }
  // A Shot rendered on its own shows alone; once the run is over, the preview
  // shows every rendered Shot back to back so each one can be reviewed.
  if (ok && b.standalone && !more && active().filter(isRendered).length > 1) setTimeout(() => stitchPreview(b.target), 0);
}

/** Item 3: the preview from every rendered Shot, in order, with the Shots not
 *  rendered yet left out (hard cuts there). Every Shot loads its take. */
function stitchPreview(focusId) {
  if (S.busy || !P()) return;
  const act = active(), done = act.filter(isRendered);
  if (done.length < 2) return;
  const gaps = act.filter((x) => !isRendered(x)).map((x) => x.id);
  queue({ upto: done[done.length - 1].id, kind: "refresh", omit: gaps,
    label: "Updating the preview · rendered Shots back to back",
    note: gaps.length ? "Nothing is sampled · Shots not rendered yet are left out" : "Nothing is sampled",
    onDone: onRendered(null, false, { gaps: gaps.length > 0, focus: focusId }) });
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
    if (!(Number(sh.shot_seed) >= 0) && r.seed !== null && r.seed !== undefined) sh.shot_seed = r.seed;
    const was = (sent || {})[sh.id] || { text: sh.text, seconds: Number(sh.seconds) };
    sh.rendered = { text: was.text, seconds: was.seconds, seed: Number(sh.shot_seed) };
    sh.edit_from = null;
    // a new take: standalone or continued (the first Shot has nothing before it either way)
    if (r.status !== "locked") sh.standalone = !!standalone && active()[0] !== sh;
    sh.cleared = false;
  }
}

function onRendered(targetId, standalone = false, opts = {}) {
  return ({ rows, text, outputs, built, sent }) => {
    const combine = outputs[built.nodes.combine] || {};
    const video = (combine.gifs || combine.videos || [])[0];
    if (!video) throw new Error("Video Combine saved no file.");
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
    // a Shot edited while this rendered no longer matches its new take
    for (const s of P().shots) if (s.kind !== "clip" && s.status !== "queued" && s.rendered && !matchesRendered(s)) {
      s.edit_from = { status: s.status, was_approved: s.was_approved, was_rendered: s.was_rendered, take: s.take, gen: S.gen };
      s.status = "queued";
    }
    const at = new Date().toISOString();
    P().last_output = { video, plan: rows, chain: built.chain, text,
      size: [built.width, built.height], at, source_at: at };
    P().preview_dirty = false;
    S.dry = null;
    if (targetId) S.open = targetId;
    const focus = targetId || opts.focus;
    const row = focus && built.chain.includes(focus) ? rows[built.chain.indexOf(focus)] : null;
    loadVideo(row ? row.start + 0.04 : video.currentTime || 0);
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
  if (P().preview_dirty) return true;
  const shown = lo.plan.map((r) => r.kind === "clip" ? `${r.id}:clip` : `${r.id || ""}:${r.take || ""}`).join("|");
  return shown !== done.map((s) => s.kind === "clip" ? `${s.id}:clip` : `${s.id}:${s.take}`).join("|");
}

function refreshPreview() {
  const done = active().filter(isRendered);
  if (!done.length || S.busy) return;
  queue({ upto: done[done.length - 1].id, kind: "refresh", label: "Updating the preview",
    note: "Every Shot loads its take · nothing is sampled", onDone: onRendered(null) });
}

async function primary() {
  const rv0 = reviewShot(), nx0 = nextToRender();
  let alone = false;
  if (nx0 && nx0.standalone) {
    const mode = await askStandalone(nx0, "Render");
    if (!mode || S.busy) return;
    alone = mode === "alone";
  }
  const rv = reviewShot(), nx = nextToRender();
  if (rv !== rv0 || nx !== nx0) return;        // something changed while the dialog was open
  if (rv) { rv.status = "approved"; rv.was_approved = false; }
  if (!nx && previewStale()) { refreshPreview(); return; }
  if (!nx) { scheduleSave(); render(); return; }
  if (nx.standalone && alone) { renderAlone(nx); return; }
  const n = numOf(nx.id);
  if (nx.standalone) {
    queue({ upto: nx.id, kind: "render", trimLeft: true, label: `Rendering Shot ${n} · ${pinnedNote(nx)}`,
      note: "In place · the Shots around it keep their takes", onDone: onRendered(nx.id) });
    return;
  }
  const others = active().filter((x) => x !== nx && isRendered(x)).length;
  queue({ upto: nx.id, kind: "render", label: "Rendering Shot " + n,
    note: others ? `${others} Shot${others > 1 ? "s" : ""} load${others > 1 ? "" : "s"} ${others > 1 ? "their" : "its"} take · only Shot ${n} renders`
      : n > 1 ? `Shots 1–${n - 1} reused · only Shot ${n} renders` : "Rendering Shot 1",
    onDone: onRendered(nx.id) });
}

async function reroll() {
  const rv = reviewShot();
  if (!rv || S.busy) return;
  let alone = false;
  if (rv.standalone) {
    const mode = await askStandalone(rv, "Reroll");
    if (!mode || S.busy || reviewShot() !== rv) return;
    alone = mode === "alone";
  }
  rememberTake(rv);
  rv.shot_seed = Math.floor(Math.random() * (SEED_MAX + 1));
  rv.status = "queued";
  const n = numOf(rv.id);
  queue({ upto: rv.id, kind: "reroll", standalone: alone, trimLeft: !alone,
    label: `Re-rolling Shot ${n}${alone ? " on its own" : rv.standalone ? " · " + pinnedNote(rv) : ""} · seed ${rv.shot_seed}`,
    note: alone ? "A fresh start · no pins to the Shots around it" : "Every other Shot keeps its take",
    onDone: onRendered(rv.id, alone) });
}

/** Shots the panel buttons would render: not rendered yet, generated, active. */
const toRender = () => active().filter((s) => s.kind !== "clip" && s.status === "queued");
const oddToRender = () => toRender().filter((s) => numOf(s.id) % 2 === 1);

/** ▶ Render all: one run through every Shot not rendered yet, each continued
 *  from the Shot before it (the standard workflow). Rendered Shots keep their
 *  takes, so gaps between them render as bridges. All land under review. */
function renderAll() {
  if (busyGuard()) return;
  const list = toRender();
  if (!list.length) { toast("Every Shot is rendered."); return; }
  const lastOne = list[list.length - 1];
  const others = active().filter((x) => isRendered(x)).length;
  queue({ upto: lastOne.id, kind: "render", label: `Rendering all · ${list.length} Shot${list.length > 1 ? "s" : ""}`,
    note: others ? `${others} rendered Shot${others > 1 ? "s keep their takes" : " keeps its take"} · each new Shot continues from the one before`
      : "Each Shot continues from the one before",
    onDone: onRendered(lastOne.id) });
}

/** ▶ Render odd Shots: Shots 1, 3, 5… not rendered yet, each on its own, one
 *  render after another. Then Render all (or the main button) bridges the gaps. */
function renderOdd() {
  if (busyGuard()) return;
  const list = oddToRender();
  if (!list.length) { toast("Every odd Shot is rendered."); return; }
  renderAlone(list[0], { ids: list.slice(1).map((x) => x.id), of: list.length });
}

/** Item 4 (round 5): a standalone Shot re-rendering next to rendered Shots —
 *  pinned to them in place (default), or on its own again.
 *  "pinned" | "alone" | null (cancelled). No rendered neighbour: "alone". */
async function askStandalone(s, verb) {
  const act = active(), i = act.indexOf(s);
  const prev = act[i - 1] && isRendered(act[i - 1]) ? act[i - 1] : null;
  const next = act[i + 1] && isRendered(act[i + 1]) ? act[i + 1] : null;
  if (!prev && !next) return "alone";
  const names = [prev, next].filter(Boolean).map(titleOf).join(" and ");
  const how = [prev ? `starts from the end of ${titleOf(prev)}` : "", next ? `leads into ${titleOf(next)}` : ""]
    .filter(Boolean).join(" and ");
  const ans = await confirmBox({ title: `${verb} ${titleOf(s)}`,
    body: `Pinned: ${titleOf(s)} ${how}, in place. ${names} keep${prev && next ? "" : "s"} ${prev && next ? "their takes" : "its take"}, ` +
      `and ${titleOf(s)} is no longer standalone. On its own: a fresh start from the references; ` +
      `the join${prev && next ? "s" : ""} with ${names} become${prev && next ? " hard cuts" : "s a hard cut"} until bridged again.`,
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
  if (!s || s.kind === "clip" || busyGuard() || s.status === "queued") return;
  Object.assign(s, { status: "queued", take: null, rendered: null, edit_from: null, standalone: false,
    seam: null, was_approved: false, was_rendered: false, cleared: true });
  delete S.takes[s.id];
  S.gen++;
  S.dry = null;
  commit();
  const pin = pinnedNote(s);
  toast(`${titleOf(s)} is cleared. It renders again${pin ? `, ${pin}` : ""}, with the same prompt, length and seed ` +
    "(the same picture unless something around it changed; Reroll for a new one). Its old take stays in Take history.");
}

/** Item 12: render one Shot on its own — a fresh generation from the
 *  references, not continued from the Shot before and not pinned to the one
 *  after. Its neighbours render later as bridges pinned to it. */
function renderAlone(s, batch = null) {
  if (!s || s.kind === "clip" || s.bypassed || S.busy) return;
  const n = numOf(s.id);
  const step = batch ? ` · ${batch.of - batch.ids.length} of ${batch.of}` : "";
  queue({ upto: s.id, kind: "render", standalone: true, batch, label: `Rendering Shot ${n} on its own${step}`,
    note: "A fresh start from the references · no pins to the Shots around it",
    onDone: onRendered(s.id, true) });
}

function dryRun() {
  const shots = active();
  if (!shots.length || S.busy) return;
  queue({ upto: shots[shots.length - 1].id, dry: true, kind: "dry", label: "Dry run · planning every shot",
    note: "Nothing is sampled", onDone: ({ rows, text, built }) => {
      S.dry = { rows, text, chain: built.chain };
      showModal("Dry run · full prompts", text);
    } });
}

async function stop() {
  const b = S.busy;
  if (!b) return;
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
    if (S.restarting) afterRestart();
    renderHeader(); renderDecision();
    if (P()) renderShots();                     // ▶ on Shot cards follows the connection
    pollStats();
    if (S.busy) pollLater(); else autoCheck();
  };
  ws.onclose = () => { S.conn = S.restarting ? "restarting" : "down"; renderHeader(); renderDecision(); if (P()) renderShots(); retry(); };
  ws.onerror = () => {};
  ws.onmessage = (ev) => {
    if (typeof ev.data !== "string") return;          // binary previews
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
      if (d.node === b.built.nodes.longshot || d.node === undefined) b.step = d.max ? d.value / d.max : 0;
      break;
    case "mmh3.longshot": onSegment(b, d); break;
    case "execution_success": case "execution_error": case "execution_interrupted":
      finish(b.promptId); return;
    default: return;
  }
  renderDecision();
}

function onSegment(b, d) {
  b.of = d.of || b.of;
  b.segs[d.segment] = d.status;
  if (d.status === "reused") (b.sources = b.sources || {})[d.segment] = d.source || "memory";
  if (d.status === "rendering") { b.segT0[d.segment] = Date.now(); b.step = 0; b.current = d; }
  if (d.status === "done" && b.segT0[d.segment] && d.seconds) {
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

function loadVideo(at) {
  const lo = last();
  if (!lo || !lo.video) {
    video.removeAttribute("src");
    video.load();
    renderViewer();
    return;
  }
  const url = viewURL(lo.video);
  if (lo.size) $("screen").style.aspectRatio = lo.size[0] + " / " + lo.size[1];
  video.src = url + "&t=" + Date.now();
  $("download").href = url;
  $("download").setAttribute("download", lo.video.filename);
  video.addEventListener("loadedmetadata", () => {
    if (at !== undefined) video.currentTime = Math.min(at, video.duration || at);
    renderViewer();
  }, { once: true });
  renderViewer();
}

function totalSeconds() {
  const lo = last();
  if (video.duration && isFinite(video.duration)) return video.duration;
  return lo && lo.plan.length ? lo.plan[lo.plan.length - 1].end : 0;
}

/** Loop range: halfway into the previous Shot → end of the Shot under review. */
/** The Shot number of the i-th piece of a preview (a stitched preview skips Shots). */
function rowNum(lo, i) {
  const n = lo && lo.chain ? numOf(lo.chain[i]) : 0;
  return n > 0 ? n : i + 1;
}

function loopRange() {
  const lo = last(), rv = reviewShot();
  if (!lo || !rv) return null;
  const i = lo.chain.indexOf(rv.id);
  if (i < 0) return null;
  // the half of the Shot before only when it really is the Shot before (not across a left-out gap)
  const act = active(), before = act[act.indexOf(rv) - 1];
  const row = lo.plan[i], prev = i > 0 && before && lo.chain[i - 1] === before.id ? lo.plan[i - 1] : null;
  return { a: prev ? prev.start + prev.seconds / 2 : row.start, b: row.end, i, prev: !!prev,
    prevTitle: prev ? titleOf(before) : "" };
}

function shotAt(t) {
  const lo = last();
  if (!lo) return -1;
  let idx = 0;
  lo.plan.forEach((r, k) => { if (t >= r.start - 1e-6) idx = k; });
  return idx;
}

function tick() {
  const t = video.currentTime || 0;
  if (S.loop) {
    const L = loopRange();
    if (L && (t >= L.b - 0.02 || t < L.a - 0.1)) video.currentTime = L.a;
  }
  updateTime();
  if (!video.paused) rafId = requestAnimationFrame(tick);
}

function updateTime() {
  const t = video.currentTime || 0, total = totalSeconds();
  const lo = last();
  $("scrub").value = String(t);
  const i = shotAt(t);
  $("tc-overlay").textContent = (lo && i >= 0 ? "S" + rowNum(lo, i) + " · " : "") + fmt(t);
  $("tc-label").textContent = fmt(t) + " / " + fmt(total);
}

video.addEventListener("play", () => { $("play").setAttribute("aria-label", "Pause"); setPlayIcon(true); cancelAnimationFrame(rafId); rafId = requestAnimationFrame(tick); });
video.addEventListener("pause", () => { $("play").setAttribute("aria-label", "Play"); setPlayIcon(false); updateTime(); });
video.addEventListener("seeked", updateTime);
video.addEventListener("ended", () => { if (S.loop) { const L = loopRange(); if (L) { video.currentTime = L.a; play(); } } });
$("scrub").addEventListener("input", (e) => { video.currentTime = parseFloat(e.target.value) || 0; updateTime(); });

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

function play() {
  const p = video.play();
  if (p && p.catch) p.catch(() => { /* reported by the error handler */ });
}

function togglePlay() {
  if (!video.src) return;
  if (video.paused) play(); else video.pause();
}

video.addEventListener("error", () => {
  if (!video.getAttribute("src")) return;
  toast("This browser can't play the video file. Open the output folder" +
        (S.local ? "" : " or download it") + " to watch it in a player.");
});

function stepFrame(dir) {
  if (!video.src) return;
  video.pause();
  video.currentTime = Math.max(0, Math.min(totalSeconds(), (video.currentTime || 0) + dir / FPS));
  updateTime();
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
}

function renderSaveState() { $("save-state").textContent = S.saveState; }

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
  if (missing.length) {
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
  out += items.map((f) => `<option value="${esc(f)}"${f === current ? " selected" : ""}>${esc(f)}</option>`).join("");
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

function renderCast() {
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
        ${badge ? `<div>${badge}</div>` : ""}
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
  cards.push(`<button class="addtile" data-action="add-cast" data-drop="add">${PLUS} <span>Add reference · ${esc(`<Picture ${n + 1}>`)}<br><span class="muted small">or drop images here</span></span></button>`);
  $("cast").innerHTML = cards.join("");
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
    `<label for="f-${k}">${label}</label><textarea id="f-${k}" data-style="${k}" rows="${rows}">${esc(st[k])}</textarea>`).join("");
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

/** A Shot in the render that's running can't be edited until it finishes. */
const inRender = (s) => !!S.busy && S.busy.kind !== "dry" && S.busy.kind !== "check" &&
  !!S.busy.built && S.busy.built.chain.includes(s.id);

/** The always-visible row of a (generated) Shot card: status, title, preview, tools. */
function shotRowHTML(s) {
  const rid = renderingId();
  const state = s.bypassed ? "bypassed" : s.id === rid ? "rendering" : s.status;
  const L = LOOK[state];
  const title = s.bypassed ? "Bypassed" : "Shot " + numOf(s.id);
  const seed = s.shot_seed < 0 || s.shot_seed === "" ? "auto" : String(s.shot_seed);
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
      ? '<span class="flag cut" title="Rendered on its own, so it doesn\'t follow on from the Shot before it. Render or reroll the Shot before it to bridge into it, or Bridge here to continue this Shot from it.">↯ hard cut · standalone</span>'
      : '<span class="flag cut" title="This Shot doesn\'t follow on from the take of the Shot before it, so the join is a hard cut.">↯ hard cut</span>') : "";
  const standaloneTag = !cut && s.standalone && s.status !== "queued" && !s.bypassed
    ? '<span class="flag standalone" title="Rendered on its own, from the references. The Shot before it bridges into it.">standalone</span>' : "";
  const bridge = cut ? `<button class="ghost sm bridge" data-action="bridge" title="Re-render ${title} in place so it flows from the Shot before it${s.standalone ? " (it stops being standalone)" : ""}; the Shots after it stay">Bridge</button>` : "";
  const canAlone = state === "queued" && s.kind !== "clip";
  const aloneOff = !!S.busy || S.conn !== "ok" || missingRefs().length > 0;
  const play = canAlone ? `<button class="sdot sdot-play" data-action="render-alone"${aloneOff ? " disabled" : ""}
      title="Render this Shot on its own — a fresh start, not continued from the Shot before." aria-label="Render ${title} on its own">▶</button>` : "";
  return `${play}<button class="shot-head${play ? " has-play" : ""}" data-action="toggle-shot" aria-expanded="${open}">
          ${play ? "" : `<span class="sdot" style="background:${L.dot};color:${L.fg}">${L.icon}</span>`}
          <span class="stitle">${title}</span>
          <span class="smeta">${esc(s.seconds)}s · seed ${esc(seed)}</span>
          <span class="sprev">${esc(s.text) || '<i class="muted">empty</i>'}</span>
          ${flag}${cut}${standaloneTag}
          <span class="chip" style="background:${L.chipBg};color:${L.chipFg};border-color:${chipBorder}">${L.label}</span>
        </button>
        <div class="shot-tools">
          ${bridge}
          ${canReroll ? `<button class="icon lg reroll" data-action="reroll-shot" title="Reroll ${title} (new seed)" aria-label="Reroll ${title}">⟳</button>` : ""}
          <button class="icon lg${s.bypassed ? " on" : ""}" data-action="bypass-shot" aria-pressed="${s.bypassed}" title="${s.bypassed ? "Turn shot back on" : "Bypass shot"}">${POWER}</button>
          <button class="icon lg x" data-action="remove-shot" title="Remove" aria-label="Remove ${title}">${CROSS}</button>
        </div>`;
}

/** While typing: only the Shot's row changes, never its fields. */
function refreshShotRow(s) {
  const el = document.querySelector(`.shot[data-shot="${CSS.escape(s.id)}"]`);
  if (!el || s.kind === "clip") return;
  const row = el.querySelector(":scope > .shot-row");
  if (row) row.innerHTML = shotRowHTML(s);
  el.classList.toggle("review", !s.bypassed && s.status === "review");
}

function renderShots() {
  if (deferIfHeld("shots")) return;
  let prevActive = null;
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
        <textarea class="field" data-shot-field="text" rows="6" aria-label="${title} text"${ro}>${esc(s.text)}</textarea>
        <div class="shot-opts">
          <label class="lbl-row">Seconds <input type="number" step="0.1" min="0.1" data-shot-field="seconds" value="${esc(s.seconds)}" style="width:72px"${ro}></label>
          <label class="lbl-row">Seed <input class="mono" data-shot-field="shot_seed" value="${s.shot_seed < 0 ? "" : esc(s.shot_seed)}" placeholder="auto" style="width:120px"${ro}></label>
          <button class="ghost sm" data-action="wrap" data-before="&lt;d&gt;[English] " data-after="&lt;/d&gt;">Wrap &lt;d&gt; dialogue</button>
          <button class="ghost sm" data-action="wrap" data-before="&quot;" data-after="&quot;">Wrap "on-screen text"</button>
          ${canReroll ? '<button class="ghost sm" data-action="reroll-shot">⟳ Reroll this Shot</button>' : ""}
        </div>
        <div class="shot-opts shot-more">
          ${takes}
          <span class="push"></span>
          ${!s.bypassed && s.status !== "queued" ? `<button class="ghost sm" data-action="clear-render"${inRender(s) ? " disabled" : ""}
            title="Back to not rendered: keeps the prompt, length and seed. The take stays in Take history.">Clear render</button>` : ""}
          <button class="ghost sm" data-action="insert-before" title="Insert a new Shot before this one">⊕ Shot before</button>
          <button class="ghost sm" data-action="insert-after" title="Insert a new Shot after this one">⊕ Shot after</button>
          <button class="ghost sm" data-action="insert-clip-after" title="Insert a video clip after this Shot">⊕ Clip after</button>
          <button class="ghost sm" data-action="replace-clip" title="Put a video clip in this Shot's place (the Shot is kept, bypassed)">Replace with clip</button>
        </div>
        </div>` : "";
    return mark + `<div class="shot${state === "review" ? " review" : ""}${s.bypassed ? " off" : ""}" data-shot="${esc(s.id)}">
      <div class="shot-row">${shotRowHTML(s)}</div>${body}</div>`;
  }).join("");
  $("add-shot").innerHTML = `${PLUS} Add Shot ${active().length + 1}`;
  const off = !!S.busy || S.conn !== "ok" || missingRefs().length > 0;
  const nAll = toRender().length, nOdd = oddToRender().length;
  $("render-all").textContent = `▶ Render all${nAll ? ` (${nAll})` : ""}`;
  $("render-all").disabled = off || !nAll;
  $("render-odd").textContent = `▶ Render odd Shots${nOdd ? ` (${nOdd})` : ""}`;
  $("render-odd").disabled = off || !nOdd;
  const first = $("add-first");
  first.hidden = !P().shots.length;
  first.innerHTML = `${PLUS} Add shot before Shot 1`;
  $("add-first-clip").hidden = !P().shots.length;
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
  const lo = last();
  const has = !!(lo && lo.video && video.src);
  $("placeholder").hidden = has;
  $("tc-overlay").hidden = !has;
  const total = totalSeconds();
  const scrub = $("scrub");
  scrub.max = String(total || 0);
  scrub.disabled = !has;
  // ticks
  $("ticks").innerHTML = lo && total ? lo.plan.map((r, i) => {
    const pct = (r.start / total) * 100;
    const band = r.kind === "clip"
      ? `<div class="clip-band" style="left:${pct}%;width:${((r.end - r.start) / total) * 100}%" title="Clip"></div>` : "";
    return band + `<div class="tick${r.kind === "clip" ? " clip" : ""}" style="left:calc(${pct}% - .5px)"><div></div></div>` +
      `<div class="tick-label${r.kind === "clip" ? " clip" : ""}" style="left:calc(${pct}% + 4px)">${r.kind === "clip" ? "▶" : "S"}${rowNum(lo, i)}</div>`;
  }).join("") : "";
  // loop band + note
  const L = loopRange();
  const band = $("loop-band"), note = $("loop-note");
  if (S.loop && L && total) {
    band.hidden = false;
    band.style.left = (L.a / total) * 100 + "%";
    band.style.width = ((L.b - L.a) / total) * 100 + "%";
    const rv = reviewShot();
    note.hidden = false;
    note.textContent = `Looping ${fmt(L.a)} → ${fmt(L.b)}` + (L.prev
      ? ` · last half of ${L.prevTitle}, the seam, then ${titleOf(rv)}` : ` · ${titleOf(rv)}`);
  } else {
    band.hidden = true;
    note.hidden = true;
  }
  const rv = reviewShot();
  $("jump").textContent = "Jump to " + titleOf(rv);
  $("jump").disabled = !has || !rv || !L;
  $("loop").setAttribute("aria-pressed", S.loop && !!L);
  $("loop").disabled = !has || !L;
  for (const el of document.querySelectorAll('[data-which="output"], #download')) el.toggleAttribute("disabled", !has);
  $("download").hidden = S.local || !has;
  updateTime();
}

function renderDecision() {
  const el = $("decision");
  if (!P()) return;
  if (deferIfHeld("decision")) return;
  const errBox = S.error ? `<div class="err" role="alert"><span>${esc(S.error)}</span>
      <button class="icon x" data-action="dismiss-error" aria-label="Dismiss">${CROSS}</button></div>` : "";
  const b = S.busy;
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
  const stale = !nx && previewStale();
  if (stale && !rv) line = "The timeline changed since the last preview. Update it: every Shot loads its take, nothing is sampled.";
  // [ ✓ Approve 25% ][ main action 50% ][ ⟳ Reroll 25% ]
  let mainLabel, mainAction, mainOff = false;
  const reviews = active().filter((s) => s.status === "review");
  if (rv && reviews.length > 1) {
    // several Shots rendered at once (Render all / Render odd Shots): review them one by one
    if (!missing.length) line = `${reviews.length} Shots to review. Happy with ${titleOf(rv)}? Approve it and go on to ${titleOf(reviews[1])}.`;
    mainLabel = `✓ Approve & review ${titleOf(reviews[1])}`;
    mainAction = "approve-next";
  } else if (rv && nx) { mainLabel = `✓ Approve & render ${titleOf(nx)}`; mainAction = "primary"; }
  else if (rv && stale) { mainLabel = "✓ Approve & update preview"; mainAction = "primary"; }
  else if (rv && vsrOk) { mainLabel = `✓ Approve & upscale final (${v.scale}×)`; mainAction = "approve-final"; }
  else if (rv) { mainLabel = "✓ Approve & finish"; mainAction = "primary"; }
  else if (nx) { mainLabel = "▶ Render " + titleOf(nx) + (nx.standalone && !pinnedNote(nx) ? " on its own" : ""); mainAction = "primary"; }
  else if (stale) { mainLabel = "▶ Update preview"; mainAction = "primary"; }
  else if (allDone && vsrOk) { mainLabel = `⤢ Upscale final video (${v.scale}× ${v.quality})${fin ? " again" : ""}`; mainAction = "final"; }
  else { mainLabel = "All done"; mainAction = "primary"; mainOff = true; }
  const off = S.conn !== "ok" || missing.length > 0;
  if (S.conn !== "ok") line = "ComfyUI isn't connected. Rendering waits until it's back.";
  const sub = [rv ? takeNav(rv) : "",
    thr ? `<button class="ghost sm through" data-action="render-through"${off ? " disabled" : ""}>⟳ Re-render through ${esc(titleOf(thr))}</button>` : ""].filter(Boolean).join("");
  el.innerHTML = `${errBox}<div class="dec-line">${esc(line)}</div>
    <div class="dec-row3">
      <button class="ghost approve" data-action="approve" title="Approve ${esc(titleOf(rv))} without rendering anything"${!rv || off ? " disabled" : ""}>✓ Approve</button>
      <button class="primary go" data-action="${mainAction}"${mainOff || off ? " disabled" : ""}>${esc(mainLabel)}</button>
      <button class="ghost" data-action="reroll" title="Reroll ${esc(titleOf(rv))}"${!rv || off ? " disabled" : ""}>⟳ Reroll</button>
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
  ["voice_ref", "Voice reference", "song → MelBand vocals → ref_audio", "timbre"],
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
  video.pause();
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

video.addEventListener("play", stopPreview);
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
  const secs = active().reduce((a, s) => a + ((lastRowFor(s.id) || {}).seconds || Number(s.seconds) || 0), 0);
  const frames = Math.round(secs * FPS);
  const gb = (frames * size[0] * size[1] * 3 * 4 * (1 + scale * scale)) / 1024 ** 3;
  return `Needs about ${gb < 10 ? gb.toFixed(1) : Math.round(gb)} GB of system RAM for the full ${secs.toFixed(0)} s at ${scale}×.`;
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
      <label class="lbl">Seed · fixed <input class="mono" data-base-seed inputmode="numeric" value="${esc(s.seed)}" aria-describedby="seed-help"></label>
      <button class="ghost sm reset-seeds" data-action="reset-seeds"${P().shots.some((x) => x.kind !== "clip" && Number(x.shot_seed) >= 0) ? "" : " disabled"}
        title="Put the Shots' own seeds back to auto, so they follow this seed again">Reset Shot seeds</button>
      <span class="muted small" id="seed-help">Feeds every Shot left on auto. Type a seed to go back to it; use Reroll for new takes.</span>
    </div>
    <div class="grid3">
      <label class="lbl">Steps <input type="number" min="1" max="200" data-set="steps" data-num value="${esc(s.steps)}"></label>
      <label class="lbl">Resolution <select data-set="megapixels" data-num>${mp}</select></label>
      <label class="lbl">Aspect <select data-set="aspect">${asp}</select></label>
    </div>${warn}
    <div class="size-out">${size ? `→ ${size[0]} × ${size[1]} output` : "→ size unknown"}${size && vsr.on && vsrOk
      ? ` · <span class="vsr-size">${even(size[0] * vsr.scale)} × ${even(size[1] * vsr.scale)} after RTX Super Resolution</span>` : ""}</div>
    <div class="vsr-row${vsr.on && vsrOk ? "" : " off"}">
      ${switchHTML(vsr.on && vsrOk, `data-action="vsr-on" aria-label="RTX Super Resolution"${vsrOk ? "" : " disabled"}`, true)}
      <div class="vsr-text"><div>Upscale previews <span class="muted small">· RTX Super Resolution</span></div>
        <div class="muted small">${!vsrOk ? "Install ComfyUI-NVIDIA-RTX-VSR-Pro (RTX GPU) to use it."
          : vsr.on ? "Every render is upscaled (slower as the chain grows). Never re-renders Shots."
            : "Off: previews stay fast. Upscale final video (when every Shot is approved) always upscales with this scale and quality."}</div>
        ${vsrOk && size ? `<div class="muted small">${vsrRamNote(size, vsr.scale)}</div>` : ""}</div>
      <label class="lbl-row">Scale <select data-vsr="scale"${vsrOk ? "" : " disabled"}>${[1.5, 2].map((x) =>
        `<option value="${x}"${Number(vsr.scale) === x ? " selected" : ""}>${x}×</option>`).join("")}</select></label>
      <label class="lbl-row">Quality <select data-vsr="quality"${vsrOk ? "" : " disabled"}>${["LOW", "MEDIUM", "HIGH", "ULTRA"].map((q) =>
        `<option${vsr.quality === q ? " selected" : ""}>${q}</option>`).join("")}</select></label>
    </div>
    <label class="check-row prores-row${vsrOk ? "" : " off"}"><input type="checkbox" data-outfile="prores_master"${s.prores_master ? " checked" : ""}${vsrOk ? "" : " disabled"}>
      <span>Final video: also save a ProRes master <span class="muted small">· 10-bit ProRes 422 HQ .mov with sound, next to the upscaled MP4 (large files)</span></span></label>
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
      <label class="check-row"><input type="checkbox" data-outfile="save_png"${s.save_png ? " checked" : ""}>
        <span>Save PNG <span class="muted small">· the first frame (with the workflow) next to each video</span></span></label>
      <label class="check-row"><input type="checkbox" data-outfile="save_noaudio"${s.save_noaudio ? " checked" : ""}>
        <span>Save audio-less MP4 <span class="muted small">· a copy without sound, besides the video with sound</span></span></label>
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
    </div>
    <div class="loras">${loras}</div>
    <div class="adv-sub">Sampling</div>
    <div class="grid2">
      <label class="lbl">Sampler ${select('data-set="sampler"', o.samplers, s.sampler)}</label>
      <label class="lbl">Scheduler ${select('data-set="scheduler"', o.schedulers, s.scheduler)}</label>
      <label class="lbl">Overlap frames <select data-set="overlap" data-num>${overlaps}</select></label>
      <label class="lbl">Seed mode <select data-set="seed_mode"><option${s.seed_mode === "increment" ? " selected" : ""}>increment</option><option${s.seed_mode === "same" ? " selected" : ""}>same</option></select></label>
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
  if (!act.length) { $("plan").innerHTML = '<div class="plan-empty">No active shots.</div>'; return; }
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
      return `<div class="plan-row"><span>Seg ${k + 1}</span><span class="muted">${esc(len)}</span><span style="color:#8FD3F0">${esc(status)}</span></div>`;
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
      status = `take · seed ${s.shot_seed}`;
      color = s.status === "approved" ? "#9FE0C2" : "#FFD08A";
    }
    if (s.standalone && s.status !== "queued") status += " · standalone";
    if (cutBefore(s) && !/hard cut/.test(status)) status += " · cut before it";
    if (((dry || row) && (dry || row).seam === "mismatch") || cutBefore(s)) color = "#FFB4A8";
    return `<div class="plan-row"><span>Seg ${k + 1}</span><span class="muted">${esc(len)}</span><span style="color:${color}">${esc(status)}</span></div>`;
  }).join("");
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

function castOf(el) { const c = el.closest("[data-cast]"); return c && P().cast.find((x) => x.id === c.dataset.cast); }
function shotOf(el) { const c = el.closest("[data-shot]"); return c && P().shots.find((x) => x.id === c.dataset.shot); }

document.addEventListener("click", async (e) => {
  const el = e.target.closest("[data-action]");
  if (!el || el.disabled) return;
  const a = el.dataset.action;
  const p = P();
  switch (a) {
    case "primary": primary(); break;
    case "approve": { const rv = reviewShot(); if (rv && !busyGuard()) { rv.status = "approved"; rv.was_approved = false; commit(); } break; }
    case "approve-next": {
      const rv = reviewShot();
      if (!rv || busyGuard()) break;
      rv.status = "approved"; rv.was_approved = false;
      const nextRv = reviewShot();
      if (nextRv) {
        S.open = nextRv.id;
        const row = lastRowFor(nextRv.id);
        if (row && video.src) { video.pause(); video.currentTime = row.start + 0.04; updateTime(); }
      }
      commit();
      break;
    }
    case "approve-final": { const rv = reviewShot(); if (rv) { rv.status = "approved"; rv.was_approved = false; } if (previewStale()) refreshPreview(); else upscaleFinal(); break; }
    case "bridge": bridgeShot(shotOf(el)); break;
    case "render-alone": renderAlone(shotOf(el)); break;
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
      if (S.busy) return toast("Wait for the render to finish (or Stop it) first.");
      const s = shotOf(el);
      s.bypassed = !s.bypassed;
      S.dry = null;
      if (!syncAfter(s, `${s.bypassed ? "Bypassing" : "Turning on"} a Shot`) && renderedAfter(s).length && s.take) {
        toast("The Shots after it keep their takes. If a join looks wrong, reroll the Shot after it to bridge it.");
      }
      commit();
      break;
    }
    case "remove-shot": {
      if (S.busy) return toast("Wait for the render to finish (or Stop it) first.");
      const s = shotOf(el);
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
      if (busyGuard()) return;
      const c = castOf(el);
      const mode = await askRefChange(`${c.bypassed ? "Turn on" : "Bypass"} ${c.label || "this reference"}?`);
      if (!mode) return;
      c.bypassed = !c.bypassed;
      applyRefChange(mode, "Cast & Scenes");
      commit();
      break;
    }
    case "remove-cast": {
      if (busyGuard()) return;
      const c = castOf(el);
      let mode = "all";
      if (!c.bypassed && approvedShots().length) {
        mode = await askRefChange(`Remove ${c.label || "this reference"}?`);
        if (!mode) return;
      } else if (!confirm(`Remove ${c.label || "this reference"}?`)) return;
      p.cast = p.cast.filter((x) => x.id !== c.id);
      if (!c.bypassed) applyRefChange(mode, "Cast & Scenes");
      commit();
      break;
    }
    case "add-cast": {
      if (busyGuard()) return;
      p.cast.push({ id: uid("c"), label: "<new>", desc: "", role: "appearance", image: "", bypassed: false });
      // an empty card changes nothing yet; choosing its picture asks about approved Shots
      if (approvedShots().length) { S.dry = null; S.gen++; } else sharedChanged("Cast & Scenes");
      commit();
      break;
    }
    case "ref-step": stepRef(castOf(el), +el.dataset.dir); break;
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
      if (busyGuard()) return;
      const k = el.dataset.key;
      p.audio[k] = !p.audio[k];
      if (k !== "final_override") sharedChanged("Audio");
      commit();
      break;
    }
    case "turbo-on": {
      if (busyGuard()) return;
      const mode = await askSettingChange(p.settings.turbo.on ? "Turn Turbo off" : "Turn Turbo on");
      if (!mode) return;
      p.settings.turbo.on = !p.settings.turbo.on;
      applyRefChange(mode, "Turbo");
      commit();
      break;
    }
    case "lora-on": {
      if (busyGuard()) return;
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
      if (busyGuard() || p.settings.ref_image_size === el.dataset.v) return;
      const mode = await askSettingChange("Change the reference image size");
      if (!mode) return;
      p.settings.ref_image_size = el.dataset.v;
      applyRefChange(mode, "Reference image size");
      commit();
      break;
    }
    case "play": togglePlay(); break;
    case "step": stepFrame(+el.dataset.dir); break;
    case "jump": { const L = loopRange(); if (L) { video.pause(); video.currentTime = p.last_output.plan[L.i].start; updateTime(); } break; }
    case "loop": {
      const L = loopRange();
      S.loop = !S.loop && !!L;
      if (S.loop) { video.currentTime = L.a; play(); }
      renderViewer();
      break;
    }
    case "open-folder": openFolder(el.dataset.which); break;
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

function busyGuard() {
  if (!S.busy) return false;
  toast("Wait for the render to finish (or Stop it) first.");
  return true;
}

function commit() { render(); scheduleSave(); }

/** Text fields: typing updates the project quietly; leaving the field commits
 *  (and applies the re-render rules). */
document.addEventListener("input", (e) => {
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
  else if (el.dataset.style) { p.style[el.dataset.style] = el.value; scheduleSave(); }
  else if (el.dataset.shotField) shotInput(el);
  else if (el.type === "range" && el.nextElementSibling && el.nextElementSibling.tagName === "OUTPUT") {
    el.nextElementSibling.textContent = Number(el.value).toFixed(2);
  }
});

const committed = new WeakMap();      // element -> value when focused, to see real changes
document.addEventListener("focusin", (e) => { committed.set(e.target, e.target.value); });

document.addEventListener("change", async (e) => {
  const el = e.target;
  const p = P();
  if (!p) return;
  const before = committed.get(el);
  const changed = before === undefined || before !== el.value;
  committed.set(el, el.value);
  if (el.dataset.relink) { relinkFromSelect(el); return; }
  if (el.dataset.baseSeed !== undefined) { changeBaseSeed(el); return; }
  if (el.dataset.outfile) {        // which files a render keeps: nothing re-renders
    p.settings[el.dataset.outfile] = el.checked;
    return commit();
  }
  if (el.dataset.vsr) {            // post-process only: no Shot re-renders
    const k = el.dataset.vsr;
    p.settings.rtx_vsr[k] = k === "scale" ? Number(el.value) : el.value;
    return commit();
  }
  if (S.busy && !el.dataset.shotField) {
    toast("Wait for the render to finish (or Stop it) first.");
    render();
    return;
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
    if (S.busy && S.busy.kind !== "dry" && S.busy.built.chain.includes(s.id)) {
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
    if (changed && KEEPABLE[k]) {
      // approved takes don't depend on it: they can be kept (item 2, round 5)
      const mode = await askSettingChange(`Change ${KEEPABLE[k]}`);
      if (!mode) return render();
      p.settings[k] = v;
      applyRefChange(mode, KEEPABLE[k][0].toUpperCase() + KEEPABLE[k].slice(1));
      return commit();
    }
    p.settings[k] = v;               // size and overlap: old takes can't be used, everything renders again
    if (changed) sharedChanged("Settings");
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
  if (t.closest && t.closest("input, textarea, select, [contenteditable]")) return;
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
  if (busyGuard()) return;
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
  if (busyGuard()) return;
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
        <span class="muted small">Saved ${esc(when(p.saved_at))} · ${p.approved} of ${p.shots} shots approved</span></span></button>`;
  }).join("") || '<div class="muted">No saved projects yet.</div>';
  showModal("Open project", null, rows);
}

function deleteDialog() {
  const local = S.local;
  showModal(`Delete "${P().name}"?`, null, `<p style="margin:0;color:var(--sub)">The project file is deleted. This can't be undone.</p>
    <div class="checks">
      <label${local ? "" : " hidden"}><input type="checkbox" id="del-segments"> Also delete its saved takes (output/longshot/${esc(P().slug)}/takes)</label>
      <label${local ? "" : " hidden"}><input type="checkbox" id="del-inputs"> Also delete its input folder (input/longshot/${esc(P().slug)})</label>
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
  if (busyGuard()) return;
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
  if (busyGuard()) return;
  const inp = document.createElement("input");
  inp.type = "file";
  inp.accept = ".zip,application/zip";
  inp.addEventListener("change", () => { if (inp.files.length) importZip(inp.files[0]); });
  inp.click();
}

async function importZip(file) {
  if (!S.local) { toast("Projects can only be imported on the machine running ComfyUI."); return; }
  if (busyGuard()) return;
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
  const slug = P().slug;
  clearTimeout(saveTimer);
  try {
    await api("/longshot/projects/" + slug + (q.length ? "?" + q.join("&") : ""), { method: "DELETE" });
  } catch (e) { toast("Couldn't delete: " + e.message); return; }
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
  if (busyGuard()) { render(); return; }
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
  if (!c || busyGuard() || S.uploading[c.id]) return;
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
  if (busyGuard()) return;
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
  if (busyGuard()) return;
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
  if (busyGuard()) return;
  const inp = document.createElement("input");
  inp.type = "file";
  inp.accept = "audio/*";
  inp.addEventListener("change", () => { if (inp.files.length) addAudio(inp.files); });
  inp.click();
}

function pickImages(targetId) {
  if (busyGuard()) return;
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
    const card = e.target.closest("[data-cast]");
    return card ? { zone: "cast", el: card, id: card.dataset.cast }
      : { zone: "cast", el: cast.querySelector("[data-drop=add]") || cast, id: null };
  }
  const audio = e.target.closest("#audio-panel");
  if (audio) return { zone: "audio", el: audio, id: null };
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
  if (t.zone === "cast") addImages(e.dataTransfer.files, t.id);
  else if (t.zone === "audio") addAudio(e.dataTransfer.files);
  else if (t.zone === "shots") addClipFiles(e.dataTransfer.files, t.id);
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
  try {
    await api("/longshot/open-folder", { method: "POST",
      body: { which, project: P().slug, select: which === "output" && lo && lo.video ? lo.video.filename : null,
        subfolder: which === "output" && lo && lo.video ? lo.video.subfolder : null } });
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
function confirmBox({ title, body, yes = "Continue", no = "Cancel", check = null, alt = null }) {
  return new Promise((resolve) => {
    if (confirmResolve) confirmDone(false);           // only one question at a time
    $("confirm-title").textContent = title;
    $("confirm-body").textContent = body;
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
  if (busyGuard()) { el.value = s.seed; return; }
  // Only Shots on auto use the base seed; the first one and everything after it re-render.
  const act = active();
  const firstAuto = act.findIndex((x) => !(Number(x.shot_seed) >= 0));
  const affected = firstAuto < 0 ? [] : act.slice(firstAuto).filter((x) => x.status !== "queued");
  if (affected.length && !(await confirmShared("the seed", affected))) { el.value = s.seed; return; }
  s.seed = n;
  if (firstAuto >= 0) {
    S.gen++;
    for (const x of act.slice(firstAuto)) {
      if (x.status === "approved") x.was_approved = true;
      else if (x.status === "review") x.was_rendered = true;
      x.status = "queued";
    }
    S.dry = null;
  }
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

function editorDirty() {
  const c = editing && P().cast.find((x) => x.id === editing.id);
  return !!c && ($("editor-label").value !== c.label || $("editor-desc").value !== c.desc);
}

function closeEditor() { $("editor").hidden = true; editing = null; }

async function editorSave() {
  const c = editing && P().cast.find((x) => x.id === editing.id);
  if (!c) return closeEditor();
  if (!editorDirty()) return closeEditor();
  if (busyGuard()) return;
  let mode = "all";
  if (!c.bypassed) {
    if (approvedShots().length) mode = await askRefChange("Save this reference?");
    else if (!(await confirmShared("this reference"))) mode = null;
    if (!mode) return;                                                      // stays open
  }
  c.label = $("editor-label").value;
  c.desc = $("editor-desc").value;
  if (!c.bypassed) applyRefChange(mode, "Cast & Scenes", true);
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

document.addEventListener("fullscreenchange", () => {
  const on = document.fullscreenElement === $("stage");
  $("fs-btn").setAttribute("aria-pressed", on);
  // toasts and confirmations must live inside the full-screen element to be seen
  (on ? $("stage") : document.querySelector(".app")).appendChild($("toast"));
  layoutStage();
});
window.addEventListener("resize", () => layoutStage());
video.addEventListener("loadedmetadata", () => layoutStage());

/** Full screen: the video takes the whole screen; controls and the decision
 *  panel sit in a translucent bar at the bottom. The picture goes up into the
 *  top of the screen only as far as it must, so letterbox space sits under the
 *  bar first and the bar covers as little of the frame as possible. */
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
  const top = H - fitH >= barH ? (H - barH - fitH) / 2 : 0;
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
  if (busyGuard()) return;
  const shots = P().shots.filter((s) => s.kind !== "clip");
  if (!shots.some((s) => Number(s.shot_seed) >= 0)) { toast("Every Shot is already on auto."); return; }
  const act = active().filter((s) => s.kind !== "clip");
  const approved = act.filter((s) => s.status === "approved");
  let which = shots;
  if (approved.length) {
    const rest = act.filter((s) => s.status !== "approved");
    const ans = await confirmBox({ title: "Reset Shot seeds to auto?",
      body: `${approved.length} Shot${approved.length > 1 ? "s are" : " is"} approved. All Shots: every Shot goes back to auto and ` +
        "renders again, approved ones too (their takes stay in Take history). Only Shots not yet rendered: approved Shots keep " +
        "their seeds and takes; Shots under review count as not rendered and render again.",
      yes: `Only Shots not yet rendered (${rest.length})`, alt: `All Shots (${act.length})`, no: "Cancel" });
    if (!ans) return;
    which = ans === "alt" ? shots : shots.filter((s) => s.bypassed || s.status !== "approved");
  }
  S.gen++;
  S.dry = null;
  let again = 0;
  for (const s of which) {
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
  if (busyGuard()) return;
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
  if (prev && prev.kind !== "clip" && s.join !== "cut" && prev.status !== "queued") { prev.status = "queued"; out.push(prev); }
  if (next && next.kind !== "clip" && next.join !== "cut" && next.status !== "queued") { next.status = "queued"; out.push(next); }
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
  if (busyGuard()) return;
  S.uploading.clip = true;
  toast(`Uploading ${f.name}…`);
  let info;
  try { info = await uploadFile(f, "video"); }
  catch (e) { toast(`Couldn't upload ${f.name}: ${e.message}`); return; }
  finally { delete S.uploading.clip; }
  await loadInputs();
  const near = nearId ? p.shots.findIndex((x) => x.id === nearId) : -1;
  const at = atIndex !== undefined ? atIndex : near < 0 ? p.shots.length : near + (replace ? 0 : 1);
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
  if (busyGuard()) return;
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
  if (!s || busyGuard()) return;
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

function toggleJoin(s) {
  if (!s || busyGuard()) return;
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
  if (busyGuard()) return;
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
}

/** "Take 2 of 4 ◀ ▶" for a rendered Shot with more than one take. */
function takeNav(s) {
  if (!s || !s.take) return "";
  const list = S.takes[s.id];
  if (!list) { fetchTakes(s.id); return ""; }
  if (list.length < 2) return "";
  const i = list.findIndex((t) => t.name === s.take);
  const off = !!S.busy;
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
  if (t) useTake(s, t.name);
}

/** Switching takes is instant: the take is a file, so nothing samples. */
function useTake(s, name) {
  if (!s || busyGuard()) return;
  const t = (S.takes[s.id] || []).find((x) => x.name === name);
  if (!t) return;
  s.take = t.name;
  if (t.seed !== null && t.seed !== undefined) s.shot_seed = t.seed;
  s.window = t.window_frames;
  s.take_seconds = Number(s.seconds);
  s.rendered = { text: s.text, seconds: Number(s.seconds), seed: Number(s.shot_seed) };
  s.edit_from = null;
  Object.keys(S.bad).forEach((k) => { if (k.startsWith(s.id + ":")) delete S.bad[k]; });
  if (s.status === "queued") s.status = "review";
  S.dry = null;
  commit();
  refreshPreview();
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
  const seed = Number(s.shot_seed) >= 0 ? Number(s.shot_seed) : row ? row.seed : null;
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
  if (!s || busyGuard()) return;
  rememberTake(s);
  s.shot_seed = Math.floor(Math.random() * (SEED_MAX + 1));
  s.status = "queued";
  s.was_approved = false;
  S.dry = null;
  render();
  queue({ upto: s.id, kind: "reroll", trimLeft: true, label: `Bridging into ${titleOf(s)}`,
    note: "In place · the Shots around it keep their takes", onDone: onRendered(s.id) });
}

async function rerollShot(s) {
  if (!s || busyGuard()) return;
  let alone = false;
  if (s.standalone) {
    const mode = await askStandalone(s, "Reroll");
    if (!mode || S.busy) return;
    alone = mode === "alone";
  }
  if (s.standalone && !alone) {
    // pinned in place to the rendered Shots around it; it stops being standalone
    rememberTake(s);
    s.shot_seed = Math.floor(Math.random() * (SEED_MAX + 1));
    s.status = "queued";
    s.was_approved = false;
    S.dry = null;
    render();
    queue({ upto: s.id, kind: "reroll", trimLeft: true, label: `Re-rolling Shot ${numOf(s.id)} · ${pinnedNote(s)} · seed ${s.shot_seed}`,
      note: "In place · the Shots around it keep their takes", onDone: onRendered(s.id) });
    return;
  }
  if (s.standalone) {
    rememberTake(s);
    s.shot_seed = Math.floor(Math.random() * (SEED_MAX + 1));
    s.status = "queued";
    s.was_approved = false;
    S.dry = null;
    render();
    queue({ upto: s.id, kind: "reroll", standalone: true, label: `Re-rolling Shot ${numOf(s.id)} on its own · seed ${s.shot_seed}`,
      note: "A fresh start · no pins to the Shots around it", onDone: onRendered(s.id, true) });
    return;
  }
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
  rememberTake(s);
  s.shot_seed = Math.floor(Math.random() * (SEED_MAX + 1));
  s.status = "queued";
  s.was_approved = false;
  S.dry = null;
  const n = numOf(s.id);
  render();
  queue({ upto: s.id, kind: "reroll", trimLeft: true, label: `Re-rolling Shot ${n} · seed ${s.shot_seed}`,
    note: renderedAfter(s).length ? "In place · the Shots around it keep their takes" : "",
    onDone: onRendered(s.id) });
}

function useSeed(s, seed) {
  if (!s || busyGuard() || !Number.isFinite(seed)) return;
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
  const act = active();
  if (!act.length || S.busy) return;
  const v = P().settings.rtx_vsr;
  const target = act[act.length - 1].id;
  queue({ upto: target, kind: "final", final: true, label: `Upscaling final video · ${v.scale}× ${v.quality}`,
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
        size: [built.width, built.height], source_at });
      loadVideo(0);
      toast(`Final video saved as ${video.filename}` + (master ? ` and the ProRes master as ${master.filename}.` : "."));
    } });
}

function renderThrough() {
  const t = throughTarget();
  if (!t || S.busy) return;
  const rv = reviewShot();
  if (rv) { rv.status = "approved"; rv.was_approved = rv.was_rendered = false; }
  const n = numOf(t.id);
  queue({ upto: t.id, kind: "render", label: `Re-rendering through Shot ${n}`,
    note: "Kept takes re-continue with their own seeds", onDone: onRendered(t.id) });
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
  if (P()) { await Promise.all([loadInputs(), checkInputs(), loadSegStats()]); }
  render();
  toast("ComfyUI restarted.");
  autoCheck();
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function init() {
  connect();
  try {
    const caps = await api("/longshot/capabilities");
    S.local = !!caps.local;
  } catch (e) { S.local = false; }
  document.body.classList.toggle("is-local", S.local);
  try { S.opts = await api("/longshot/options"); } catch (e) { toast("Couldn't read ComfyUI's model lists: " + e.message); }
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
