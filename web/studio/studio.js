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
  conn: "connecting", open: null, styleOpen: false, audioOpen: false, advOpen: false, settingsOpen: true, uploading: {},
  busy: null, error: null, loop: false, dry: null, saveState: "",
  refState: {}, refInfo: {}, inputs: null, segStats: null, conflict: null, checkedFor: null,
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
    prev_seeds: Array.isArray(s.prev_seeds) ? s.prev_seeds.slice(-10) : [] }));
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
const renderingId = () => (S.busy && (S.busy.kind === "render" || S.busy.kind === "reroll") ? S.busy.target : null);
const clock = (iso) => (iso || "").slice(11, 16);

/** Non-bypassed references whose file is gone (or never chosen). */
function missingRefs() {
  return liveCast().filter((c) => !c.image || ["missing", "invalid"].includes(S.refState[c.id]));
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
  S.project = normalize(p);
  if (autoPickModels(S.project)) scheduleSave();
  Object.assign(S, { dry: null, error: null, loop: false, conflict: null, refState: {}, refInfo: {},
    segStats: null, checkedFor: null });
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
  if (!files.length) { S.refState = {}; return; }
  let res;
  try { res = await api("/longshot/check-inputs", { method: "POST", body: { files } }); } catch (e) { return; }
  const state = {};
  let adopted = false, changed = [];
  for (const f of res.files) {
    state[f.key] = f.state;
    S.refInfo[f.key] = f;
    const item = f.key === "audio" ? p.audio : p.cast.find((c) => c.id === f.key);
    if (!item) continue;
    if (f.state === "ok" && f.sha256 && !item.sha256) {      // first check: remember the hash
      item.sha256 = f.sha256;
      item.size_bytes = f.size_bytes;
      adopted = true;
    }
    if (f.state === "changed" && !(f.key === "audio" ? false : item.bypassed)) changed.push(f.key);
  }
  S.refState = state;
  const audioMatters = p.audio.lip_sync || p.audio.voice_ref;
  if (changed.some((k) => k !== "audio") || (changed.includes("audio") && audioMatters)) {
    sharedChanged("A reference file");
  }
  if (adopted) scheduleSave();
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
  queue({ upto, dry: true, kind: "check", label: "Checking saved segments…", note: "Nothing is sampled",
    onDone: ({ rows, built }) => { S.dry = { rows, text: "", chain: built.chain }; } });
}

// ---------------------------------------------------------------------------
// Invalidation rules
// ---------------------------------------------------------------------------

/** Editing a Shot: it and every Shot after it are queued again. */
function queueFrom(id, includeSelf = true) {
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
  if (!rendered.length) return;
  for (const s of P().shots) {
    if (s.status === "approved") s.was_approved = true;
    else if (s.status === "review") s.was_rendered = true;
    s.status = "queued";
  }
  if (!quiet) toast(`${what} changed — all ${rendered.length} rendered shot${rendered.length > 1 ? "s" : ""} ` +
        "will render again from Shot 1. Earlier approvals are flagged.");
}

// ---------------------------------------------------------------------------
// Rendering a step: build → /prompt → /ws progress → /history
// ---------------------------------------------------------------------------

async function queue({ upto, dry, kind, label, note, onDone, final = false }) {
  if (S.busy) return;
  if (Object.keys(S.uploading).length) { toast("Wait for the image upload to finish."); return; }
  S.error = null;
  const missing = missingRefs();
  if (missing.length) {
    S.error = `${missing.length} reference${missing.length > 1 ? "s are" : " is"} missing — relink or bypass ${missing.length > 1 ? "them" : "it"}.`;
    render();
    return;
  }
  let project = P();
  if (audioMissing() && (project.audio.lip_sync || project.audio.voice_ref || project.audio.final_override)) {
    project = Object.assign({}, project, { audio: Object.assign({}, project.audio,
      { lip_sync: false, voice_ref: false, final_override: false }) });
    toast("The audio file is missing, so this render runs without the audio routes.");
  }
  let built;
  try {
    built = await api("/longshot/build", { method: "POST", body: { project, upto, dry_run: !!dry, final } });
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
  if (kind === "render" || kind === "reroll" || kind === "final") saveNow();   // approvals / new seed survive a closed tab
  S.busy = {
    promptId: res.prompt_id, kind, target: upto, label, note, baseNote: note, built, onDone,
    of: built.chain.length, segs: {}, segT0: {}, step: 0, phase: "queued", started: Date.now(),
  };
  if (kind === "render" || kind === "reroll") S.open = upto;
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
      try { b.onDone({ rows: ls.plan_json, text: (ls.text || [""])[0], outputs, built: b.built }); }
      catch (e) { S.error = "Couldn't read the result: " + e.message; }
    }
  }
  render();
  if (b.kind === "render" || b.kind === "reroll" || b.kind === "final") {
    if (!S.error) adoptCurrentFiles();
    loadSegStats().then(renderSettings);
    saveNow();                       // save right after every finished render
  } else scheduleSave();
}

function onRendered(targetId) {
  return ({ rows, text, outputs, built }) => {
    const combine = outputs[built.nodes.combine] || {};
    const video = (combine.gifs || combine.videos || [])[0];
    if (!video) throw new Error("Video Combine saved no file.");
    for (const s of P().shots) {
      if (built.chain.includes(s.id) && s.id !== targetId && s.status === "queued") {
        s.status = "approved";
        s.was_approved = s.was_rendered = false;
      }
    }
    const target = P().shots.find((s) => s.id === targetId);
    if (target) { target.status = "review"; target.was_rendered = false; }
    const at = new Date().toISOString();
    P().last_output = { video, plan: rows, chain: built.chain, text,
      size: [built.width, built.height], at, source_at: at };
    S.dry = null;
    S.open = targetId;
    const row = rows[built.chain.indexOf(targetId)];
    loadVideo(row ? row.start + 0.04 : 0);
  };
}

function primary() {
  const rv = reviewShot(), nx = nextQueued();
  if (rv) { rv.status = "approved"; rv.was_approved = false; }
  if (!nx) { scheduleSave(); render(); return; }
  const n = numOf(nx.id);
  const reused = n > 1 ? `Shots 1–${n - 1} reused from memory · only Shot ${n} renders` : "Rendering Shot 1";
  queue({ upto: nx.id, kind: "render", label: "Rendering Shot " + n,
    note: n === 2 ? "Shot 1 reused from memory · only Shot 2 renders" : reused, onDone: onRendered(nx.id) });
}

function reroll() {
  const rv = reviewShot();
  if (!rv || S.busy) return;
  rv.shot_seed = Math.floor(Math.random() * (SEED_MAX + 1));
  const n = numOf(rv.id);
  queue({ upto: rv.id, kind: "reroll", label: `Re-rolling Shot ${n} · seed ${rv.shot_seed}`,
    note: n > 1 ? (n === 2 ? "Shot 1 reused from memory" : `Shots 1–${n - 1} reused from memory`) : "",
    onDone: onRendered(rv.id) });
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
    if (S.busy) pollLater(); else autoCheck();
  };
  ws.onclose = () => { S.conn = S.restarting ? "restarting" : "down"; renderHeader(); renderDecision(); retry(); };
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
    const from = srcs.length === 1 ? srcs[0] : "memory and disk";
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
function loopRange() {
  const lo = last(), rv = reviewShot();
  if (!lo || !rv) return null;
  const i = lo.chain.indexOf(rv.id);
  if (i < 0) return null;
  const row = lo.plan[i], prev = i > 0 ? lo.plan[i - 1] : null;
  return { a: prev ? prev.start + prev.seconds / 2 : row.start, b: row.end, i, prev: !!prev };
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
  $("tc-overlay").textContent = (lo && i >= 0 ? "S" + (i + 1) + " · " : "") + fmt(t);
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

function render() {
  if (!P()) return;
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

function renderCast() {
  let n = 0;
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
    return `<div class="card${c.bypassed ? " off" : ""}${missing && !c.bypassed ? " missing" : ""}${S.uploading[c.id] ? " uploading" : ""}" data-cast="${esc(c.id)}">${up}
      <button class="thumb${missing ? " missing" : ""}${c.image ? "" : " empty"}" data-action="${c.image ? "view-image" : "pick-image"}" title="${missing ? "File not found" : c.image ? "Open full size · drop an image on this card to replace it" : "Choose an image, or drop one here"}" aria-label="${c.image ? `Open ${esc(c.label)} full size` : `Choose an image for ${esc(c.label)}`}">${thumb}</button>
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
};

function renderShots() {
  const rid = renderingId();
  $("shots").innerHTML = P().shots.map((s) => {
    const state = s.bypassed ? "bypassed" : s.id === rid ? "rendering" : s.status;
    const L = LOOK[state];
    const title = s.bypassed ? "Bypassed" : "Shot " + numOf(s.id);
    const seed = s.shot_seed < 0 || s.shot_seed === "" ? "auto" : String(s.shot_seed);
    const open = S.open === s.id;
    const chipBorder = state === "queued" ? "#33363C" : "transparent";
    const flag = s.was_approved && s.status !== "approved" ? '<span class="flag" title="Approved before; re-renders with its seed">was ✓</span>'
      : s.was_rendered && s.status === "queued" ? '<span class="flag" title="Rendered before; re-renders with its seed">was ●</span>' : "";
    const canReroll = !s.bypassed && s.status === "approved" && !!lastRowFor(s.id);
    const prev = (s.prev_seeds || []).slice(-3).reverse();
    const body = open ? `<div class="shot-body">
        <textarea class="field" data-shot-field="text" rows="6" aria-label="${title} text">${esc(s.text)}</textarea>
        <div class="shot-opts">
          <label class="lbl-row">Seconds <input type="number" step="0.1" min="0.1" data-shot-field="seconds" value="${esc(s.seconds)}" style="width:72px"></label>
          <label class="lbl-row">Seed <input class="mono" data-shot-field="shot_seed" value="${s.shot_seed < 0 ? "" : esc(s.shot_seed)}" placeholder="auto" style="width:120px"></label>
          <button class="ghost sm" data-action="wrap" data-before="&lt;d&gt;[English] " data-after="&lt;/d&gt;">Wrap &lt;d&gt; dialogue</button>
          <button class="ghost sm" data-action="wrap" data-before="&quot;" data-after="&quot;">Wrap "on-screen text"</button>
          ${canReroll ? '<button class="ghost sm" data-action="reroll-shot">⟳ Reroll this Shot</button>' : ""}
        </div>
        ${prev.length ? `<div class="prev-seed">Earlier takes: ${prev.map((x) => `<button data-action="use-seed" data-seed="${esc(x)}" title="Set this seed (re-renders this Shot and the ones after it)">${esc(x)}</button>`).join(" · ")}</div>` : ""}
        </div>` : "";
    return `<div class="shot${state === "review" ? " review" : ""}${s.bypassed ? " off" : ""}" data-shot="${esc(s.id)}">
      <div class="shot-row">
        <button class="shot-head" data-action="toggle-shot" aria-expanded="${open}">
          <span class="sdot" style="background:${L.dot};color:${L.fg}">${L.icon}</span>
          <span class="stitle">${title}</span>
          <span class="smeta">${esc(s.seconds)}s · seed ${esc(seed)}</span>
          <span class="sprev">${esc(s.text) || '<i class="muted">empty</i>'}</span>
          ${flag}
          <span class="chip" style="background:${L.chipBg};color:${L.chipFg};border-color:${chipBorder}">${L.label}</span>
        </button>
        <div class="shot-tools">
          ${canReroll ? `<button class="icon lg reroll" data-action="reroll-shot" title="Reroll ${title} (new seed)" aria-label="Reroll ${title}">⟳</button>` : ""}
          <button class="icon lg${s.bypassed ? " on" : ""}" data-action="bypass-shot" aria-pressed="${s.bypassed}" title="${s.bypassed ? "Turn shot back on" : "Bypass shot"}">${POWER}</button>
          <button class="icon lg x" data-action="remove-shot" title="Remove" aria-label="Remove ${title}">${CROSS}</button>
        </div>
      </div>${body}</div>`;
  }).join("");
  $("add-shot").innerHTML = `${PLUS} Add Shot ${active().length + 1}`;
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
    return `<div class="tick" style="left:calc(${pct}% - .5px)"><div></div></div>` +
      `<div class="tick-label" style="left:calc(${pct}% + 4px)">S${i + 1}</div>`;
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
      ? ` · last half of Shot ${L.i}, the seam, then ${titleOf(rv)}` : ` · ${titleOf(rv)}`);
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
  const rv = reviewShot(), nx = nextQueued(), lo = last();
  let line;
  if (rv && nx) line = `Happy with ${titleOf(rv)}? Continue approves it and renders ${titleOf(nx)}.`;
  else if (rv) line = `${titleOf(rv)} is the last shot. Approve it to finish the chain.`;
  else if (nx && numOf(nx.id) === 1 && !active().some((s) => s.status === "approved")) {
    line = nx.was_approved ? "A shared change needs every shot rendered again. Render Shot 1 to start."
      : "Render Shot 1 to start. Each Continue approves the shot you're reviewing and renders the next.";
  } else if (nx && lastRowFor(nx.id)) line = `${titleOf(nx)} needs rendering again — it or a shot before it changed.`;
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
  const label = nx ? (rv ? "✓ Continue → " : "▶ Render ") + titleOf(nx) : rv ? "✓ Approve & finish"
    : allDone && vsrOk ? `⤢ Upscale final video (${v.scale}× ${v.quality})${fin ? " again" : ""}` : "All done";
  const primaryAction = allDone && vsrOk ? "final" : "primary";
  const off = S.conn !== "ok" || missing.length > 0;
  if (S.conn !== "ok") line = "ComfyUI isn't connected. Rendering waits until it's back.";
  el.innerHTML = `${errBox}<div class="dec-line">${esc(line)}</div><div class="dec-btns">
    <button class="primary go" data-action="${primaryAction}"${(!rv && !nx && primaryAction !== "final") || off ? " disabled" : ""}>${esc(label)}</button>
    <button class="ghost" data-action="reroll"${!rv || off ? " disabled" : ""}>⟳ Reroll ${esc(titleOf(rv))}</button>
    ${thr ? `<button class="ghost through" data-action="render-through"${off ? " disabled" : ""}>⟳ Re-render through ${esc(titleOf(thr))}</button>` : ""}</div>`;
  layoutStage();
}

/** After a reroll of an earlier Shot (or a shared change), the kept takes that
 *  follow the next Shot can re-render in one queue. Returns the last of that
 *  run, when it's more than just the next Shot. */
function throughTarget() {
  const act = active(), nx = nextQueued();
  if (!nx) return null;
  let i = act.indexOf(nx), lastKept = null;
  while (i < act.length && act[i].status === "queued" && (act[i].was_approved || act[i].was_rendered)) lastKept = act[i++];
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
      <label class="lbl">Audio file (from ComfyUI's input folder)
        <select class="field" data-relink="audio">${inputOptions("audio", a.subfolder, a.file, "No audio")}</select></label>
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
      </div><div class="muted small" style="margin-top:8px">Pick from audio files in ComfyUI's input folder, or this project's input/longshot/${esc(P().slug)} folder.</div></div>`;
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

function renderSettings() {
  const s = P().settings, o = S.opts || {};
  const vsr = s.rtx_vsr;
  const vsrOk = !S.opts || !S.opts.nodes || S.opts.nodes.RTXVideoSuperResolution !== false;
  const size = sizeOf(s);
  const t = s.turbo;
  const modelName = (s.model || "no model").split(/[\\/]/).pop().replace(/\.(safetensors|gguf|ckpt|pt)$/i, "");
  $("settings-summary").textContent = S.settingsOpen ? "" : [modelName, t.on ? "Turbo" : "no Turbo",
    `${s.steps} steps`, size ? `${size[0]}×${size[1]}` : `${s.megapixels} MP ${s.aspect}`,
    vsr.on && vsrOk ? `RTX ${vsr.scale}×` : ""].filter(Boolean).join(" · ");
  $("settings-chev").textContent = S.settingsOpen ? "Hide ▴" : "Show ▾";
  $("settings-toggle").setAttribute("aria-expanded", String(!!S.settingsOpen));
  $("settings").hidden = !S.settingsOpen;
  if (!S.settingsOpen) return;
  const loras = s.loras.map((l, i) => `<div class="lora${l.on ? "" : " off"}">
      ${switchHTML(l.on, `data-action="lora-on" data-i="${i}" aria-label="LoRA ${i + 1}"`, true)}
      <select data-lora="${i}" data-k="name" aria-label="LoRA ${i + 1} file"${l.on ? "" : " disabled"} style="flex:1 1 160px">${fileOptions(o.loras, l.name, "Choose a LoRA…")}</select>
      <label class="strength"><input type="range" min="0" max="2" step="0.05" data-lora="${i}" data-k="strength" value="${esc(l.strength)}"${l.on ? "" : " disabled"} aria-label="LoRA ${i + 1} strength"><output>${Number(l.strength).toFixed(2)}</output></label>
    </div>`).join("");
  const warn = !t.on && s.steps < 20 ? `<div class="warnbox" role="alert" style="margin-top:12px">
      <span style="flex:1">Turbo is off and steps are at ${esc(s.steps)}. Without Turbo, H3 needs about 20 steps or more. Expect a soft, unfinished result.</span>
      <button class="ghost sm" data-action="steps20">Set 20 steps</button></div>` : "";
  const mp = (o.megapixels || [0.4, 0.6, 0.9, 1.2]).map((m) =>
    `<option value="${m}"${Number(m) === Number(s.megapixels) ? " selected" : ""}>${m} MP</option>`).join("");
  const asp = (o.aspects || ["16:9"]).map((a) => `<option${a === s.aspect ? " selected" : ""}>${a}</option>`).join("");
  $("settings").innerHTML = `
    <label class="lbl settings-model">Model ${select('data-set="model"', o.models, s.model, "Choose a model…")}</label>
    <div class="box">
      <div class="box-row">
        ${switchHTML(t.on, 'data-action="turbo-on" aria-label="Turbo LoRA"')}
        <div style="flex:1;min-width:140px"><div>Turbo LoRA</div>
          <select data-turbo="lora" aria-label="Turbo LoRA file"${t.on ? "" : " disabled"} style="margin-top:4px;max-width:100%">${fileOptions(o.loras, t.lora, "Choose…")}</select></div>
        <label class="strength" style="flex:1 1 180px">Strength
          <input type="range" min="0" max="2" step="0.05" data-turbo="strength" value="${esc(t.strength)}"${t.on ? "" : " disabled"}><output>${Number(t.strength).toFixed(2)}</output></label>
      </div>${warn}
    </div>
    <div class="loras">${loras}</div>
    <div class="grid3">
      <label class="lbl">Steps <input type="number" min="1" max="200" data-set="steps" data-num value="${esc(s.steps)}"></label>
      <label class="lbl">Resolution <select data-set="megapixels" data-num>${mp}</select></label>
      <label class="lbl">Aspect <select data-set="aspect">${asp}</select></label>
    </div>
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
    <div class="seed-row">
      <label class="lbl">Seed · fixed <input class="mono" data-base-seed inputmode="numeric" value="${esc(s.seed)}" aria-describedby="seed-help"></label>
      <span class="muted small" id="seed-help">Feeds every Shot left on auto. Type a seed to go back to it; use Reroll for new takes.</span>
    </div>
    <div style="margin-top:14px"><div class="muted small" style="margin-bottom:6px">Reference image size</div>
      <div class="seg" role="group" aria-label="Reference image size">
        <button data-action="ref-size" data-v="match" aria-pressed="${s.ref_image_size === "match"}">Match · lighter on VRAM</button>
        <button data-action="ref-size" data-v="max" aria-pressed="${s.ref_image_size === "max"}">Max · best identity</button>
      </div></div>
    <div class="seg-store">
      ${switchHTML(s.save_segments !== false, 'data-action="save-segments" aria-label="Save segments to disk"', true)}
      <span class="grow">Saved segments: ${S.segStats ? `${S.segStats.files} file${S.segStats.files === 1 ? "" : "s"} · ${(S.segStats.bytes / 1048576).toFixed(1)} MB` : "—"}
        <span class="muted"> · output/longshot/${esc(P().slug)}/segments</span></span>
      <button class="ghost sm local-only" data-action="clear-segments"${S.segStats && S.segStats.files ? "" : " disabled"}>Clear saved segments</button>
    </div>`;
}

/** Sampler, scheduler, overlap… — its own section under Settings. */
function renderAdvanced() {
  const s = P().settings, o = S.opts || {};
  $("adv-summary").textContent = [s.sampler, s.scheduler, `overlap ${s.overlap}`, `seed ${s.seed_mode}`]
    .filter(Boolean).join(" · ");
  $("adv-chev").textContent = S.advOpen ? "Hide ▴" : "Show ▾";
  $("adv-toggle").setAttribute("aria-expanded", String(!!S.advOpen));
  $("advanced").hidden = !S.advOpen;
  if (!S.advOpen) return;
  const overlaps = [5, 22, 39, 56, 73].map((v) => `<option value="${v}"${v === Number(s.overlap) ? " selected" : ""}>${v}</option>`).join("");
  const sage = (o.sage_modes && o.sage_modes.length ? o.sage_modes : ["disabled", "auto"]);
  $("advanced").innerHTML = `<div class="grid2">
      <label class="lbl">Sampler ${select('data-set="sampler"', o.samplers, s.sampler)}</label>
      <label class="lbl">Scheduler ${select('data-set="scheduler"', o.schedulers, s.scheduler)}</label>
      <label class="lbl">Overlap frames <select data-set="overlap" data-num>${overlaps}</select></label>
      <label class="lbl">Seed mode <select data-set="seed_mode"><option${s.seed_mode === "increment" ? " selected" : ""}>increment</option><option${s.seed_mode === "same" ? " selected" : ""}>same</option></select></label>
      <label class="lbl">Sage attention ${select('data-set="sage_attention"', sage, s.sage_attention)}</label>
      <label class="lbl">CLIP ${select('data-set="clip"', o.clips, s.clip, "Choose…")}</label>
      <label class="lbl">Reference resize (px) <input data-set="ref_resize_px" data-num type="number" min="64" step="2" value="${esc(s.ref_resize_px)}"></label>
      <label class="lbl">Video VAE ${select('data-set="video_vae"', o.vaes, s.video_vae, "Choose…")}</label>
      <label class="lbl">Audio VAE ${select('data-set="audio_vae"', o.vaes, s.audio_vae, "Choose…")}</label>
      <label class="lbl">Shift video <input data-set="shift_video" data-num type="number" step="0.5" value="${esc(s.shift_video)}"></label>
      <label class="lbl">Shift audio <input data-set="shift_audio" data-num type="number" step="0.5" value="${esc(s.shift_audio)}"></label>
    </div>`;
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
  $("plan").innerHTML = act.map((s, k) => {
    const row = lastRowFor(s.id), dry = dryRow(s.id);
    let len, status, color;
    if (s.id === rid) { len = (row ? row.seconds.toFixed(2) : s.seconds) + "s"; status = "rendering…"; color = "#E9E7E2"; }
    else if (s.status === "approved" && (row || dry)) {
      const r = dry || row;
      len = r.seconds.toFixed(2) + "s";
      status = dry && dry.status === "reused" ? `reused (${dry.source}) · seed ${dry.seed}`
        : dry ? `will render (${dry.reason}) · seed ${dry.seed}` : `reused · seed ${row.seed}`;
      color = dry && dry.status !== "reused" ? "#A3A6AD" : "#9FE0C2";
    }
    else if (s.status === "review" && row) {
      len = row.seconds.toFixed(2) + "s";
      status = `rendered${dry && dry.status === "reused" ? ` (${dry.source})` : ""} · seed ${row.seed}`;
      color = "#FFD08A";
    }
    else {
      len = (dry ? dry.seconds.toFixed(2) : s.seconds) + "s";
      status = dry ? (dry.status === "reused" ? `reused (${dry.source}) · seed ${dry.seed}` : `will render (${dry.reason}) · seed ${dry.seed}`) : "will render";
      color = "#A3A6AD";
    }
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
      queueFrom(s.id, !s.bypassed);
      commit();
      break;
    }
    case "remove-shot": {
      if (S.busy) return toast("Wait for the render to finish (or Stop it) first.");
      const s = shotOf(el);
      if (s.text && !confirm(`Remove ${s.bypassed ? "this bypassed shot" : titleOf(s)}? Its text is deleted.`)) return;
      queueFrom(s.id, false);
      p.shots = p.shots.filter((x) => x.id !== s.id);
      commit();
      break;
    }
    case "add-shot": {
      const s = { id: uid("s"), text: "", seconds: 5, shot_seed: -1, bypassed: false, status: "queued", was_approved: false };
      p.shots.push(s);
      S.open = s.id;
      commit();
      setTimeout(() => { const t = document.querySelector(`[data-shot="${s.id}"] textarea`); if (t) t.focus(); }, 0);
      break;
    }
    case "wrap": wrap(el); break;
    case "bypass-cast": { if (busyGuard()) return; const c = castOf(el); c.bypassed = !c.bypassed; sharedChanged("Cast & Scenes"); commit(); break; }
    case "remove-cast": {
      if (busyGuard()) return;
      const c = castOf(el);
      if (!confirm(`Remove ${c.label || "this reference"}?`)) return;
      p.cast = p.cast.filter((x) => x.id !== c.id);
      if (!c.bypassed) sharedChanged("Cast & Scenes");
      commit();
      break;
    }
    case "add-cast": {
      if (busyGuard()) return;
      p.cast.push({ id: uid("c"), label: "<new>", desc: "", role: "appearance", image: "", bypassed: false });
      sharedChanged("Cast & Scenes");
      commit();
      break;
    }
    case "audio-preview": previewing() ? stopPreview() : startPreview(); break;
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
    case "final": upscaleFinal(); break;
    case "audio-route": {
      if (busyGuard()) return;
      const k = el.dataset.key;
      p.audio[k] = !p.audio[k];
      if (k !== "final_override") sharedChanged("Audio");
      commit();
      break;
    }
    case "turbo-on": if (busyGuard()) return; p.settings.turbo.on = !p.settings.turbo.on; sharedChanged("Turbo"); commit(); break;
    case "lora-on": { if (busyGuard()) return; const l = p.settings.loras[+el.dataset.i]; l.on = !l.on; if (l.name || !l.on) sharedChanged("LoRAs"); commit(); break; }
    case "steps20": p.settings.steps = 20; sharedChanged("Steps"); commit(); break;
    case "ref-size":
      if (busyGuard() || p.settings.ref_image_size === el.dataset.v) return;
      p.settings.ref_image_size = el.dataset.v;
      sharedChanged("Reference image size");
      commit();
      break;
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
    case "confirm-delete": confirmDelete(); break;
    case "conflict-reload": S.conflict = null; loadProject(P().slug); break;
    case "conflict-keep": saveNow(true); break;
    case "relink": { const sel = el.closest("[data-cast]").querySelector("select[data-relink]"); if (sel) { sel.focus(); if (sel.showPicker) try { sel.showPicker(); } catch (e) { /* not allowed */ } } break; }
    case "clear-segments": clearSegments(); break;
    case "save-segments": p.settings.save_segments = p.settings.save_segments === false; commit(); break;
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
  if (el.id === "editor-desc") autoGrow(el);
  else if (el.dataset.style) { p.style[el.dataset.style] = el.value; scheduleSave(); }
  else if (el.dataset.shotField === "text") { shotOf(el).text = el.value; scheduleSave(); }
  else if (el.type === "range" && el.nextElementSibling && el.nextElementSibling.tagName === "OUTPUT") {
    el.nextElementSibling.textContent = Number(el.value).toFixed(2);
  }
});

const committed = new WeakMap();      // element -> value when focused, to see real changes
document.addEventListener("focusin", (e) => { committed.set(e.target, e.target.value); });

document.addEventListener("change", (e) => {
  const el = e.target;
  const p = P();
  if (!p) return;
  const before = committed.get(el);
  const changed = before === undefined || before !== el.value;
  committed.set(el, el.value);
  if (el.dataset.relink) { relinkFromSelect(el); return; }
  if (el.dataset.baseSeed !== undefined) { changeBaseSeed(el); return; }
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
    if (changed && !c.bypassed) sharedChanged("Cast & Scenes");
    return commit();
  }
  if (el.dataset.style) {
    p.style[el.dataset.style] = el.value;
    if (changed) sharedChanged("Style & Sound");
    return commit();
  }
  if (el.dataset.shotField) {
    const s = shotOf(el);
    if (S.busy && S.busy.kind !== "dry" && S.busy.built.chain.includes(s.id)) {
      toast("This shot is part of the render in progress; edit it when it finishes.");
      return render();
    }
    const k = el.dataset.shotField;
    if (k === "seconds") s.seconds = Math.max(0.1, parseFloat(el.value) || 5);
    else if (k === "shot_seed") {
      const v = el.value.trim().toLowerCase();
      const n = v === "" || v === "auto" ? -1 : parseInt(v, 10);
      s.shot_seed = Number.isFinite(n) && n >= -1 ? n : s.shot_seed;
    } else s.text = el.value;
    if (changed && !s.bypassed) queueFrom(s.id);
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
    p.settings[k] = el.dataset.num !== undefined ? Number(el.value) : el.value;
    if (changed) sharedChanged("Settings");
    return commit();
  }
  if (el.dataset.turbo) {
    const k = el.dataset.turbo;
    p.settings.turbo[k] = k === "strength" ? Number(el.value) : el.value;
    if (changed) sharedChanged("Turbo LoRA");
    return commit();
  }
  if (el.dataset.lora !== undefined) {
    const l = p.settings.loras[+el.dataset.lora];
    l[el.dataset.k] = el.dataset.k === "strength" ? Number(el.value) : el.value || null;
    if (changed && l.on) sharedChanged("LoRAs");
    return commit();
  }
});

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
  const name = (prompt("Rename the project (its folder stays the same):", P().name) || "").trim();
  if (!name || name === P().name) return;
  P().name = name;
  await saveNow();
  await refreshProjects();
  renderHeader();
  toast(`Renamed. Saved segments and files stay under "${P().slug}"; new videos save as longshot/${name}_#####.mp4.`);
}

async function openList() {
  await refreshProjects();
  const when = (iso) => iso ? new Date(iso.slice(0, 19)).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "never";
  const rows = S.projects.map((p) => {
    const v = p.video;
    const thumb = v && v.workflow
      ? `<img alt="" loading="lazy" src="${esc(viewURL({ filename: v.workflow, subfolder: v.subfolder, type: v.type || "output" }))}">`
      : "no video";
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
      <label${local ? "" : " hidden"}><input type="checkbox" id="del-segments"> Also delete its saved segments (output/longshot/${esc(P().slug)}/segments)</label>
      <label${local ? "" : " hidden"}><input type="checkbox" id="del-inputs"> Also delete its input folder (input/longshot/${esc(P().slug)})</label>
      ${local ? "" : '<span class="muted small">Files can only be deleted from the machine running ComfyUI.</span>'}
    </div>
    <div class="dialog-actions"><button class="ghost" data-action="close-modal">Keep it</button>
    <button class="danger-btn" data-action="confirm-delete">Delete</button></div>`);
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
    if (isAudio) { p.audio.file = null; p.audio.subfolder = ""; p.audio.sha256 = null; }
    else { item.image = ""; }
    S.refState[key] = undefined;
    if (!isAudio && !item.bypassed) sharedChanged("Cast & Scenes");
    if (isAudio && (p.audio.lip_sync || p.audio.voice_ref)) sharedChanged("Audio");
    return commit();
  }
  const [sub, name] = splitChoice(el.value);
  let info = { state: "ok" };
  try { info = (await api("/longshot/check-inputs", { method: "POST", body: { files: [{ key, name, subfolder: sub }] } })).files[0]; }
  catch (e) { /* treat as ok; the render will say if not */ }
  const same = !!item.sha256 && info.sha256 === item.sha256;
  if (isAudio) Object.assign(item, { file: name });
  else Object.assign(item, { image: name });
  Object.assign(item, { subfolder: sub, original_name: name, sha256: info.sha256 || null,
    size_bytes: info.size_bytes ?? null });
  S.refState[key] = info.state === "missing" || info.state === "invalid" ? info.state : "ok";
  S.refInfo[key] = info;
  if (same) toast("Relinked — it's the same file, so nothing re-renders.");
  else if (isAudio ? (p.audio.lip_sync || p.audio.voice_ref) : !item.bypassed) sharedChanged(isAudio ? "Audio" : "Cast & Scenes");
  commit();
}

// ---------------------------------------------------------------------------
// Dropping (or choosing) reference images: uploaded to input/longshot/<slug>/
// ---------------------------------------------------------------------------

const IMAGE_RE = /\.(png|jpe?g|webp|bmp|gif|tiff?)$/i;
const isImageFile = (f) => IMAGE_RE.test(f.name || "");

async function uploadImage(file) {
  const fd = new FormData();
  fd.append("project", P().slug);
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
  let shared = false, same = 0;
  const failed = [];
  await Promise.all(list.map(async (f, i) => {
    const c = cards[i];
    try {
      const unchanged = applyUpload(c, await uploadImage(f));
      if (target && unchanged) same++;            // a new reference always changes the prompt
      else if (!c.bypassed) shared = true;
    } catch (e) {
      failed.push(`${f.name}: ${e.message}`);
      if (!target) p.cast.splice(p.cast.indexOf(c), 1);
    } finally { delete S.uploading[c.id]; }
  }));
  await loadInputs();
  if (shared) sharedChanged("Cast & Scenes");
  commit();
  const notes = [];
  if (failed.length) notes.push(`Couldn't upload ${failed.join("; ")}`);
  else if (target && same) notes.push("Same picture as before, so nothing re-renders.");
  else if (list.length > 1 && !shared) notes.push(`Added ${list.length} references.`);
  if (files.length > imgs.length) notes.push(`Skipped ${files.length - imgs.length} file${files.length - imgs.length > 1 ? "s" : ""} that ${files.length - imgs.length > 1 ? "aren't images" : "isn't an image"}.`);
  if (target && imgs.length > 1) notes.push("Only the first image replaced it; drop several on Add reference to add each one.");
  if (notes.length) toast(notes.join(" "));
  if (!target && list.length === 1 && !failed.length) openEditor(cards[0]);   // name the new reference
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
function dropTargetOf(e) {
  const panel = e.target.closest && e.target.closest("#cast-panel");
  if (!panel || !P()) return null;
  const card = e.target.closest("[data-cast]");
  return card ? { el: card, id: card.dataset.cast } : { el: panel.querySelector("[data-drop=add]") || panel, id: null };
}

function clearDrop() {
  if (dropEl) dropEl.classList.remove("drop-target");
  dropEl = null;
  $("cast-panel").classList.remove("dragging");
}

window.addEventListener("dragover", (e) => {
  if (!dragHasFiles(e)) return;
  e.preventDefault();                 // a missed drop must never replace the Studio page with the image
  const t = dropTargetOf(e);
  e.dataTransfer.dropEffect = t ? "copy" : "none";
  $("cast-panel").classList.add("dragging");
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
  const t = dropTargetOf(e);
  clearDrop();
  if (t) addImages(e.dataTransfer.files, t.id);
});

async function clearSegments() {
  if (busyGuard()) return;
  const st = S.segStats || { files: 0, bytes: 0 };
  if (!confirm(`Delete ${st.files} saved segment file${st.files === 1 ? "" : "s"} (${(st.bytes / 1048576).toFixed(1)} MB) for "${P().name}"? Approved Shots stay approved but will render again after a restart.`)) return;
  try { S.segStats = await api("/longshot/clear-segments", { method: "POST", body: { project: P().slug } }); }
  catch (e) { toast(e.message); return; }
  S.dry = null;
  renderSettings();
  renderPlan();
  toast("Saved segments cleared. Segments still in ComfyUI's memory are kept until it restarts.");
}

async function openFolder(which) {
  const lo = last();
  try {
    await api("/longshot/open-folder", { method: "POST",
      body: { which, project: P().slug, select: which === "output" && lo && lo.video ? lo.video.filename : null } });
  } catch (e) { toast(e.message); }
}

let toastTimer = null;
function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 6000);
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
function confirmBox({ title, body, yes = "Continue", no = "Cancel" }) {
  return new Promise((resolve) => {
    $("confirm-title").textContent = title;
    $("confirm-body").textContent = body;
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
  if (r) r(v);
}
$("confirm-yes").addEventListener("click", () => confirmDone(true));
$("confirm-no").addEventListener("click", () => confirmDone(false));
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
  const missing = ["missing", "invalid"].includes(S.refState[c.id]);
  $("editor-img").innerHTML = c.image && !missing
    ? `<img alt="" src="${esc(viewURL({ filename: c.image, subfolder: c.subfolder, type: "input" }))}">`
    : `<span>${missing ? "Missing: " + esc(c.original_name || c.image) : "No image chosen"}</span>`;
  $("editor-file").textContent = c.image ? (c.subfolder ? c.subfolder + "/" : "") + c.image : "";
  $("editor").hidden = false;
  autoGrow($("editor-desc"));
  const d = $("editor-desc");
  d.focus();
  d.selectionStart = d.selectionEnd = d.value.length;
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
  if (!c.bypassed && !(await confirmShared("this reference"))) return;     // stays open
  c.label = $("editor-label").value;
  c.desc = $("editor-desc").value;
  if (!c.bypassed) sharedChanged("Cast & Scenes", true);
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
// C.5 Reroll an approved Shot
// ---------------------------------------------------------------------------

function rememberTake(s) {
  const row = lastRowFor(s.id);
  const seed = Number(s.shot_seed) >= 0 ? Number(s.shot_seed) : row ? row.seed : null;
  if (seed === null || seed === undefined) return;
  s.prev_seeds = (s.prev_seeds || []).filter((x) => x !== seed).concat([seed]).slice(-10);
}

async function rerollShot(s) {
  if (!s || busyGuard()) return;
  const act = active();
  const after = act.slice(act.indexOf(s) + 1).filter((x) => x.status !== "queued");
  if (after.length) {
    const a = numOf(after[0].id), z = numOf(after[after.length - 1].id);
    const est = estimateFor([s, ...after]);
    const ok = await confirmBox({ title: `Reroll ${titleOf(s)}?`,
      body: `Rerolling ${titleOf(s)} also re-renders ${after.length > 1 ? `Shots ${a}–${z}` : `Shot ${a}`}` +
        `${est ? ` (${est})` : ""}. Their text and seeds are kept.`,
      yes: `Reroll ${titleOf(s)}`, no: "Cancel" });
    if (!ok) return;
    for (const x of after) {
      if (x.status === "approved") x.was_approved = true;
      else x.was_rendered = true;
      x.status = "queued";
    }
  }
  rememberTake(s);
  s.shot_seed = Math.floor(Math.random() * (SEED_MAX + 1));
  s.status = "queued";
  s.was_approved = false;
  S.dry = null;
  const n = numOf(s.id);
  render();
  queue({ upto: s.id, kind: "reroll", label: `Re-rolling Shot ${n} · seed ${s.shot_seed}`,
    note: n > 1 ? (n === 2 ? "Shot 1 reused" : `Shots 1–${n - 1} reused`) : "",
    onDone: onRendered(s.id) });
}

function useSeed(s, seed) {
  if (!s || busyGuard() || !Number.isFinite(seed)) return;
  rememberTake(s);
  s.shot_seed = seed;
  queueFrom(s.id);
  commit();
  toast(`${titleOf(s)} will render with seed ${seed}.`);
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
    note: "Every Shot comes from saved segments; decoding, upscaling and saving",
    onDone: ({ rows, text, outputs, built }) => {
      const combine = outputs[built.nodes.combine] || {};
      const video = (combine.gifs || combine.videos || [])[0];
      if (!video) throw new Error("Video Combine saved no file.");
      const lo = last();
      const source_at = lo ? lo.source_at : null;
      P().final_output = { video, chain: built.chain, scale: v.scale, quality: v.quality,
        source_at, at: new Date().toISOString() };
      P().last_output = Object.assign({}, lo || {}, { video, plan: rows, chain: built.chain, text,
        size: [built.width, built.height], source_at });
      loadVideo(0);
      toast(`Final video saved as ${video.filename}.`);
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
