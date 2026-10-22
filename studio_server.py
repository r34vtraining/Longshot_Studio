"""HTTP routes for H3 Long Shot Studio, served by ComfyUI itself.

    GET  /longshot                 the page
    GET  /longshot/static/<file>   its JS / CSS
    GET  /longshot/capabilities    {"local": bool} — may this browser open folders?
    GET  /longshot/options         model / LoRA / VAE / CLIP / file lists, sizes, node status
    POST /longshot/build           {project, upto, dry_run, final, standalone} -> API prompt (graph_builder)
    GET  /longshot/projects        saved projects (newest first)
    POST /longshot/projects        {name, project} -> new project with its own slug
    GET  /longshot/projects/<slug> one project
    PUT  /longshot/projects/<slug>?base=<saved_at>[&force=1]   save (409 if changed elsewhere)
    DELETE /longshot/projects/<slug>?segments=1&inputs=1      delete (files: loopback only)
    GET  /longshot/inputs?subfolder=…   image / audio files in the input folder
    POST /longshot/check-inputs    {files: [{key, name, subfolder, sha256}]} -> ok/changed/missing
    GET  /longshot/segments/<slug> saved takes (and old segments): files, bytes
    GET  /longshot/takes/<slug>?shot=<id>   takes, oldest first
    DELETE /longshot/takes/<slug>/<name>    delete one take (loopback only)
    POST /longshot/clear-segments  {project} (loopback only)
    POST /longshot/open-folder     {"which": "output"|"input", "select", "project", "subfolder"} (loopback only)
    POST /longshot/install-pack    {pack}: clone an optional pack (loopback only)
    POST /longshot/install-preview the taeh3 live-preview decoder (loopback only)
    POST /longshot/install-face-detector  the MTCNN face detector for Face refine (loopback only)
    POST /longshot/faces/<slug>    {keys: [clip key]}: face sizes in those takes' clips (CPU)
    POST /longshot/live-preview    {client_id, method}: the tab's live-preview switch
    POST /longshot/layout          {overlap, pieces}: every Shot's place on the film (frames)
    POST /longshot/keep-awake      {on}: keep the machine awake while the queue has work
    POST /longshot/restart         restart ComfyUI (relaunches itself, like ComfyUI-Manager)
    POST /longshot/cleanup-outputs {prompt_id, png, noaudio}: delete a finished render's
                                   first-frame PNG and/or silent video (output/longshot only)
    POST /longshot/clear-cache     drop Long Shot's in-memory pieces (takes on disk stay)
    GET  /longshot/clips/<slug>    the timeline clips: {key: {dur, made, thumb}}
    POST /longshot/clips/<slug>    {video, rows: [{key, start, end}]}: cut pieces of a video (CPU, ffmpeg)
    POST /longshot/clips/<slug>/adopt {items: [{key, file}]}: register clips a render decoded per take

The browser talks to ComfyUI's own endpoints for everything else: /prompt,
/ws, /history, /view, /interrupt.
"""

from __future__ import annotations

import asyncio
import ipaddress
import json
import logging
import os
import shutil
import subprocess
import sys
import tempfile

from . import audio_sync
from . import film
from . import graph_builder as gb
from . import projects as pj

logger = logging.getLogger("H3LongShotStudio")

HERE = os.path.dirname(os.path.abspath(__file__))
WEB_DIR = os.path.join(HERE, "web", "studio")
OLD_PROJECTS_SUBDIR = "h3_longshot_studio"          # early test builds' location, migrated
PROJECTS_SUBDIR = os.path.join("default", "longshot-studio", "projects")
VERSION = pj.STUDIO_VERSION

AUDIO_EXTENSIONS = pj.AUDIO_EXTENSIONS
IMAGE_EXTENSIONS = pj.IMAGE_EXTENSIONS

# Headers a reverse proxy adds. A proxied request can arrive from 127.0.0.1
# while the person is on another device, so any of these means "not local".
_PROXY_HEADERS = ("X-Forwarded-For", "X-Real-IP", "Forwarded", "X-Forwarded-Host",
                  "CF-Connecting-IP")


# ---------------------------------------------------------------------------
# Pure helpers (unit-tested without a server)
# ---------------------------------------------------------------------------

def is_local_request(remote, headers) -> bool:
    """True only for a direct loopback connection with no proxy headers."""
    if any(h in headers for h in _PROXY_HEADERS):
        return False
    if not remote:
        return False
    try:
        return ipaddress.ip_address(remote.split("%", 1)[0]).is_loopback
    except ValueError:
        return False


def folder_for(which, output_dir, input_dir, project=None, subfolder=None):
    """The only folders open-folder may open. Never a path from the browser:
    the project slug only picks input/longshot/<slug> or the project's videos,
    Approved_Clips or clips folder (output/longshot/<slug>/...) when it exists."""
    if which == "output":
        base = os.path.join(output_dir, gb.OUTPUT_SUBFOLDER)
        if pj.is_slug(project):
            videos = pj.videos_folder(output_dir, project)
            sub = str(subfolder or "").replace("\\", "/").strip("/")
            if os.path.isdir(videos) and sub in ("", pj.videos_subfolder(project)):
                return videos
            approved = pj.approved_folder(output_dir, project)
            if sub == pj.approved_subfolder(project) and os.path.isdir(approved):
                return approved
            if sub == pj.clips_subfolder(project):
                clips = pj.clips_folder(output_dir, project)
                if os.path.isdir(clips):
                    return clips
                own = os.path.join(base, project)
                if os.path.isdir(own):
                    return own
        return base
    if which == "input":
        if pj.is_slug(project):
            sub = os.path.join(input_dir, "longshot", project)
            if os.path.isdir(sub):
                return sub
        return input_dir
    raise ValueError("which must be 'output' or 'input'")


def open_target(output_dir, input_dir, body):
    """(folder, select) for an open-folder request. The output button asks for
    the project's Approved_Clips first (0.8.4); when that folder doesn't exist
    yet it uses the request's fallback (the latest video, or the clips folder)."""
    which, project = body.get("which"), body.get("project")
    folder = folder_for(which, output_dir, input_dir, project, body.get("subfolder"))
    select = body.get("select")
    fb = body.get("fallback")
    sub = str(body.get("subfolder") or "").replace("\\", "/").strip("/")
    if which == "output" and isinstance(fb, dict) and pj.is_slug(project) and \
            sub == pj.approved_subfolder(project) and folder != pj.approved_folder(output_dir, project):
        folder = folder_for(which, output_dir, input_dir, project, fb.get("subfolder"))
        select = fb.get("select")
    return folder, select


def selectable(folder, name):
    """A file the browser asked to highlight: a bare file name that exists
    directly inside `folder`. Returns its full path, or None."""
    if not name or not isinstance(name, str):
        return None
    if name != os.path.basename(name) or name in (".", "..") or "/" in name or "\\" in name:
        return None
    path = os.path.join(folder, name)
    real_folder = os.path.realpath(folder)
    real = os.path.realpath(path)
    if os.path.dirname(real) != real_folder or not os.path.isfile(real):
        return None
    return path


def open_command(folder, select=None, platform=None):
    """The OS command that shows `folder` (highlighting `select`, a full path)."""
    platform = platform or sys.platform
    if platform.startswith("win"):
        # explorer wants "/select,<path>" as one argument; a list would quote it wrongly.
        return f'explorer /select,"{select}"' if select else f'explorer "{folder}"'
    if platform == "darwin":
        return ["open", "-R", select] if select else ["open", folder]
    return ["xdg-open", folder]


def _same_file(a, b):
    return a.replace("\\", "/") == b.replace("\\", "/")


def resolve_names(project, lists):
    """Model names saved on one machine still match on another: 'H3\\x' on
    Windows is 'H3/x' on Linux, and a file kept in a different subfolder is
    found by its file name when exactly one listed file has it."""
    def fix(value, kind):
        names = lists.get(kind) or []
        return pj.match_model_name(value, names) or value

    s = project.get("settings") or {}
    for key, kind in (("model", "diffusion_models"), ("clip", "text_encoders"),
                      ("video_vae", "vae"), ("audio_vae", "vae")):
        if key in s:
            s[key] = fix(s[key], kind)
    if isinstance(s.get("turbo"), dict):
        s["turbo"]["lora"] = fix(s["turbo"].get("lora"), "loras")
    for lora in s.get("loras") or []:
        if isinstance(lora, dict):
            lora["name"] = fix(lora.get("name"), "loras")
    a = project.get("audio") or {}
    if "melband_model" in a:
        a["melband_model"] = fix(a["melband_model"], "diffusion_models")
    return project


def files_with_ext(folder, exts):
    if not os.path.isdir(folder):
        return []
    return sorted(f for f in os.listdir(folder)
                  if os.path.isfile(os.path.join(folder, f))
                  and f.rsplit(".", 1)[-1].lower() in exts and "." in f)


# ---------------------------------------------------------------------------
# ComfyUI-dependent helpers
# ---------------------------------------------------------------------------

_NVENC = None


def _ffmpeg_path():
    for name, mod in list(sys.modules.items()):
        if name.endswith("videohelpersuite.utils") and getattr(mod, "ffmpeg_path", None):
            return mod.ffmpeg_path
    if os.environ.get("VHS_FORCE_FFMPEG_PATH"):
        return os.environ["VHS_FORCE_FFMPEG_PATH"]
    try:
        from imageio_ffmpeg import get_ffmpeg_exe
        return get_ffmpeg_exe()
    except Exception:
        return shutil.which("ffmpeg")


def nvenc_available():
    """Whether VHS's ffmpeg can actually encode with h264_nvenc. Listing the
    encoder isn't enough (builds include it without a usable GPU), so this
    encodes a few black frames. Cached per process."""
    global _NVENC
    if _NVENC is None:
        path = _ffmpeg_path()
        try:
            _NVENC = bool(path) and subprocess.run(
                [path, "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
                 "color=c=black:s=256x256:r=24:d=0.2", "-c:v", "h264_nvenc", "-f", "null", "-"],
                capture_output=True, timeout=30).returncode == 0
        except Exception:
            _NVENC = False
        logger.info("H3 Long Shot Studio: NVENC %s", "available" if _NVENC else
                    "not available; saving with software h264")
    return _NVENC


def _node_classes():
    import nodes
    return nodes.NODE_CLASS_MAPPINGS


def _input_options(class_name, input_name):
    cls = _node_classes().get(class_name)
    if cls is None:
        return None
    try:
        if hasattr(cls, "INPUT_TYPES"):
            types = cls.INPUT_TYPES()
        else:
            types = cls.GET_SCHEMA().get_v1_info(cls).input   # V3 node
        for section in ("required", "optional"):
            spec = (types.get(section) or {}).get(input_name)
            if spec is not None:
                return list(spec[0]) if isinstance(spec[0], (list, tuple)) else spec[1].get("options")
    except Exception:
        logger.debug("could not read %s.%s options", class_name, input_name, exc_info=True)
    return None


def video_formats():
    formats = _input_options("VHS_VideoCombine", "format")
    if formats is None:
        return None
    if not nvenc_available():
        formats = [f for f in formats if "nvenc" not in f]
    return formats


def _timeline_has_context():
    """Long Shot 1.6.8's Timeline Shot takes a context_image."""
    try:
        import nodes as comfy_nodes
        cls = comfy_nodes.NODE_CLASS_MAPPINGS.get("MiniMaxH3TimelineShot")
        return cls is None or "context_image" in (cls.INPUT_TYPES().get("optional") or {})
    except Exception:
        return True


def _timeline_shot_inputs():
    """MiniMax H3 Timeline Shot's optional inputs (None: unknown, assume all)."""
    try:
        import nodes as comfy_nodes
        cls = comfy_nodes.NODE_CLASS_MAPPINGS.get("MiniMaxH3TimelineShot")
        return None if cls is None else set((cls.INPUT_TYPES().get("optional") or {}).keys())
    except Exception:
        return None


def longshot_version():
    """H3 Long Shot's version as a tuple, (0,) when it can't be read."""
    try:
        import importlib
        import nodes as comfy_nodes
        cls = comfy_nodes.NODE_CLASS_MAPPINGS.get("MiniMaxH3LongShot")
        pkg = cls.__module__.rsplit(".", 1)[0]
        v = importlib.import_module(pkg + ".store").LONGSHOT_VERSION
        return tuple(int(x) for x in str(v).split("."))
    except Exception:
        return (0,)


def _longshot_nodes():
    """H3 Long Shot's nodes module (same process), or None."""
    try:
        import sys as _sys
        import nodes as comfy_nodes
        cls = comfy_nodes.NODE_CLASS_MAPPINGS.get("MiniMaxH3LongShot")
        return _sys.modules.get(cls.__module__) if cls else None
    except Exception:
        return None


def _longshot_planner():
    """H3 Long Shot's planner module (same process), or None."""
    mod = _longshot_nodes()
    if mod is None:
        return None
    try:
        import importlib
        return importlib.import_module(mod.__name__.rsplit(".", 1)[0] + ".planner")
    except Exception:
        return None


def film_layout(pieces, overlap, planner=None):
    """Where every Shot sits on the whole film (0.9.0; runs split at Cut / Context in
    0.9.2), from H3 Long Shot's own planner. pieces: [{id, seconds, window, cut}] in
    film order (window: a take's or clip's frame count, or None; cut: a Cut or Context
    join before it). Returns {fps, total, pieces: [{id, ws, vs, we, run}]} in frames."""
    planner = planner or _longshot_planner()
    if planner is None:
        raise LookupError("H3 Long Shot isn't loaded.")
    return film.film_layout(pieces, overlap, planner)


def chunk_codec_args(codec):
    """H3 Long Shot's own encoder settings for chunks (so black made here joins them),
    or None."""
    mod = _longshot_nodes()
    table = getattr(mod, "_CHUNK_CODECS", None)
    if not table or codec not in table:
        return None
    return list(table[codec]) + list(getattr(mod, "_BT709", []))


def live_switch_supported():
    """Long Shot 1.6.13+: the live-preview switch is read at every step."""
    return hasattr(_longshot_nodes(), "set_live_preview")


def set_live_preview(client_id, method):
    """The Studio tab's live-preview switch, passed to Long Shot."""
    mod = _longshot_nodes()
    if not hasattr(mod, "set_live_preview"):
        raise LookupError("Update H3 Long Shot to 1.6.13 or later for a live-preview switch that works mid-render.")
    return mod.set_live_preview(client_id, method)


def current_env():
    return gb.Env(classes=set(_node_classes()), video_formats=None,
                  shot_inputs=_timeline_shot_inputs(), nvenc=nvenc_available(),
                  planner=_longshot_planner(), longshot=(longshot_version() if longshot_version() != (0,) else None))


_READY = set()
MODEL_FOLDERS_FILE = os.path.join("default", "longshot-studio", "model_folders.json")
_ADDED = {}          # kind -> folders this process added to ComfyUI


_STATS = {"at": 0.0, "data": None}
_NVSMI = {"path": None, "checked": False}


def _nvidia_smi():
    """GPU name, load and memory from nvidia-smi (shipped with the NVIDIA
    driver), or None when there is no NVIDIA GPU or driver tool."""
    if not _NVSMI["checked"]:
        _NVSMI["checked"] = True
        _NVSMI["path"] = shutil.which("nvidia-smi")
        if not _NVSMI["path"] and os.name == "nt":
            p = os.path.join(os.environ.get("SystemRoot", r"C:\Windows"), "System32", "nvidia-smi.exe")
            _NVSMI["path"] = p if os.path.isfile(p) else None
    if not _NVSMI["path"]:
        return None
    try:
        out = subprocess.run(
            [_NVSMI["path"], "--query-gpu=name,utilization.gpu,memory.used,memory.total",
             "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=2,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0)).stdout
    except (OSError, subprocess.SubprocessError):
        return None
    gpus = []
    for line in out.strip().splitlines():
        parts = [x.strip() for x in line.split(",")]
        if len(parts) == 4:
            try:
                gpus.append({"name": parts[0], "util": float(parts[1]),
                             "vram_used": float(parts[2]) * 1048576,
                             "vram_total": float(parts[3]) * 1048576})
            except ValueError:
                continue
    return gpus or None


def system_stats():
    """RAM, GPU load and VRAM of the machine running ComfyUI, cached for a second."""
    import time as _time
    now = _time.monotonic()
    if _STATS["data"] is not None and now - _STATS["at"] < 1.0:
        return _STATS["data"]
    out = {"ram": None, "gpu": None}
    try:
        import psutil
        vm = psutil.virtual_memory()
        out["ram"] = {"used": vm.total - vm.available, "total": vm.total}
    except Exception:
        pass
    gpus = _nvidia_smi()
    if gpus:
        out["gpu"] = gpus[0]                     # the first GPU (ComfyUI's default)
    else:
        try:
            import torch
            if torch.cuda.is_available():
                free, total = torch.cuda.mem_get_info()
                out["gpu"] = {"name": torch.cuda.get_device_name(0), "util": None,
                              "vram_used": total - free, "vram_total": total}
        except Exception:
            pass
    _STATS.update(at=now, data=out)
    return out


def probe_video(path):
    ffmpeg = _ffmpeg_path()
    if not ffmpeg:
        return {}
    try:
        res = subprocess.run([ffmpeg, "-hide_banner", "-i", path], capture_output=True, text=True,
                             timeout=20, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    except (OSError, subprocess.SubprocessError):
        return {}
    return pj.parse_probe(res.stderr)


def make_filmstrip(path, t0, t1, n=6):
    import folder_paths
    ffmpeg = _ffmpeg_path()
    if not ffmpeg:
        return None
    st = os.stat(path)
    key = pj.hashlib.blake2b(f"{path}|{st.st_size}|{st.st_mtime_ns}|{t0:.2f}|{t1:.2f}|{n}".encode(),
                             digest_size=10).hexdigest()
    folder = os.path.join(folder_paths.get_temp_directory(), "longshot-filmstrips")
    os.makedirs(folder, exist_ok=True)
    out = os.path.join(folder, key + ".jpg")
    if os.path.isfile(out):
        return out
    length = max(0.2, (t1 - t0) if t1 > t0 else 5.0)
    cmd = [ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-ss", f"{t0:.3f}", "-t", f"{length:.3f}",
           "-i", path, "-vf", f"fps={n / length:.4f},scale=128:-2,tile={n}x1", "-frames:v", "1",
           "-q:v", "5", out]
    try:
        subprocess.run(cmd, capture_output=True, timeout=60,
                       creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    except (OSError, subprocess.SubprocessError):
        return None
    return out if os.path.isfile(out) else None


def video_entries(outputs):
    """Every saved file Video Combine reported in a history entry's outputs."""
    out = []
    for node_out in (outputs or {}).values():
        if not isinstance(node_out, dict):
            continue
        for key in ("gifs", "videos"):
            for e in node_out.get(key) or []:
                if isinstance(e, dict):
                    out.append(e)
    return out


def fresh_outputs(entry):
    """A history entry's outputs without the nodes ComfyUI served from its cache:
    their files belong to an earlier render."""
    outputs = dict(entry.get("outputs") or {})
    for m in (entry.get("status") or {}).get("messages") or []:
        if isinstance(m, (list, tuple)) and len(m) == 2 and m[0] == "execution_cached":
            for node in (m[1] or {}).get("nodes") or []:
                outputs.pop(node, None)
    return outputs


def history_outputs(prompt_id):
    """The outputs one finished prompt made itself (cached nodes left out), or None."""
    try:
        from server import PromptServer
        h = PromptServer.instance.prompt_queue.get_history(prompt_id=prompt_id)
    except Exception:
        return None
    entry = (h or {}).get(prompt_id)
    return fresh_outputs(entry) if isinstance(entry, dict) else None


def longshot_module():
    """Long Shot's node module (loaded by ComfyUI under its folder's name)."""
    for name, mod in list(sys.modules.items()):
        if name.endswith(".nodes") and hasattr(mod, "clear_segment_cache") \
                and hasattr(mod, "_SEGMENT_CACHE"):
            return mod
    return None


def clear_longshot_cache():
    """Drop the pieces Long Shot keeps in RAM. Returns how many, or None when
    Long Shot isn't loaded. Takes on disk aren't touched."""
    import gc
    mod = longshot_module()
    if mod is None:
        return None
    n = len(mod._SEGMENT_CACHE)
    mod.clear_segment_cache()
    gc.collect()
    return n


def register_video_formats():
    """Let Video Helper Suite find the Studio's own video formats (the 10-bit
    ProRes master). Works whether VHS loaded before or after the Studio."""
    import folder_paths
    folder = os.path.join(HERE, "video_formats")
    key = "VHS_video_formats"
    entry = folder_paths.folder_names_and_paths.get(key)
    if entry is None:
        folder_paths.folder_names_and_paths[key] = ([folder], {".json"})
    else:
        paths, exts = entry
        if folder not in paths:
            # VHS creates the entry with a tuple; keep its extensions set
            folder_paths.folder_names_and_paths[key] = (list(paths) + [folder], exts)
        exts.add(".json")
    getattr(folder_paths, "filename_list_cache", {}).pop(key, None)
    helper = getattr(folder_paths, "cache_helper", None)
    if helper is not None and hasattr(helper, "cache"):
        helper.cache.pop(key, None)


def comfy_queue_busy():
    try:
        from server import PromptServer
        running, pending = PromptServer.instance.prompt_queue.get_current_queue()
        return bool(running or pending)
    except Exception:
        return False


def model_folders_path():
    import folder_paths
    return os.path.join(folder_paths.get_user_directory(), MODEL_FOLDERS_FILE)


def apply_model_folders():
    """Register the model folders saved by the Studio with ComfyUI, so its
    loaders (and everything else) list the files in them."""
    import folder_paths
    saved = pj.load_model_folders(model_folders_path())
    for kind, folders in saved.items():
        for folder in folders:
            if os.path.isdir(folder) and folder not in folder_paths.get_folder_paths(kind):
                folder_paths.add_model_folder_path(kind, folder)
                _ADDED.setdefault(kind, []).append(folder)
    return saved


def model_listing(kind):
    import folder_paths
    saved = pj.load_model_folders(model_folders_path()).get(kind, [])
    folders = []
    for f in folder_paths.get_folder_paths(kind):
        folders.append({"path": f, "exists": os.path.isdir(f), "studio": f in saved})
    for f in saved:
        if f not in [x["path"] for x in folders]:
            folders.append({"path": f, "exists": os.path.isdir(f), "studio": True})
    roots = [x["path"] for x in folders if x["exists"]]
    files = []
    for name in folder_paths.get_filename_list(kind):
        root = next((r for r in roots if os.path.isfile(os.path.join(r, name))), None)
        try:
            size = os.path.getsize(os.path.join(root, name)) if root else None
        except OSError:
            size = None
        files.append({"name": name, "bytes": size, "folder": root})
    return {"kind": kind, "folders": folders, "files": files}


def project_store():
    """The project store, moving projects from early test builds over once."""
    import folder_paths
    user = folder_paths.get_user_directory()
    store = pj.ProjectStore(os.path.join(user, PROJECTS_SUBDIR))
    if user not in _READY:
        _READY.add(user)
        moved = pj.migrate(os.path.join(user, OLD_PROJECTS_SUBDIR), store)
        if moved:
            logger.info("H3 Long Shot Studio: moved %d project(s) to %s", moved, store.folder)
    return store


def options_payload():
    import folder_paths

    def names(kind):
        try:
            return folder_paths.get_filename_list(kind)
        except Exception:
            return []

    classes = _node_classes()
    feature_classes = sorted(set(gb.PACKS) | {"UNETLoader", "LoraLoaderModelOnly"})
    input_dir = folder_paths.get_input_directory()
    return {
        "version": VERSION,
        "models": names("diffusion_models"),
        "clips": names("text_encoders"),
        "vaes": names("vae"),
        "loras": names("loras"),
        "melband": names("diffusion_models"),
        "images": pj.list_inputs(input_dir)["images"],
        "audio": pj.list_inputs(input_dir)["audio"],
        "videos": pj.list_inputs(input_dir)["videos"],
        "samplers": _input_options("KSamplerSelect", "sampler_name") or [],
        "schedulers": _input_options("BasicScheduler", "scheduler") or [],
        "sage_modes": _input_options("PathchSageAttentionKJ", "sage_attention") or [],
        "megapixels": gb.MEGAPIXELS,
        "aspects": list(gb.ASPECTS),
        "sizes": gb.size_table(),
        "nodes": {c: c in classes for c in feature_classes},
        "packs": gb.PACKS,
        "video_formats": video_formats(),
        "nvenc": nvenc_available(),
        "output_subfolder": gb.OUTPUT_SUBFOLDER,
        "longshot_version": ".".join(str(x) for x in longshot_version()),
        "max_shots": gb.MAX_SHOTS,
        "optional_packs": {k: {"folder": f, "url": u} for k, (f, u) in OPTIONAL_PACKS.items()},
        "comfy": comfy_status(),
        "preview_decoder": preview_decoder_installed(names("vae_approx")),
        "face_detector": face_detector_installed(),
        "live_switch": live_switch_supported(),
    }


def restart_command(executable, argv, platform=None):
    """The command line that relaunches ComfyUI the way it was started, as
    ComfyUI-Manager does. --windows-standalone-build is dropped so a restart
    doesn't open another browser tab. On Windows, os.execv joins arguments
    with spaces, so any argument containing a space is quoted."""
    platform = platform or sys.platform
    args = [a for a in argv if a != "--windows-standalone-build"]
    if args and args[0].endswith("__main__.py"):
        module = os.path.basename(os.path.dirname(args[0]))
        cmd = [executable, "-m", module] + args[1:]
    else:
        cmd = [executable] + args
    if platform.startswith("win"):
        cmd = [f'"{a}"' if (" " in a and not a.startswith('"')) else a for a in cmd]
    return cmd


def restart_comfyui():
    """Replace this process with a fresh ComfyUI. Never returns."""
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.flush()
        except Exception:
            pass
    cmd = restart_command(sys.executable, sys.argv)
    logger.info("H3 Long Shot Studio: restarting ComfyUI: %s", " ".join(cmd))
    os.execv(sys.executable, cmd)


def launch(cmd):
    if isinstance(cmd, str):
        subprocess.Popen(cmd, shell=False)        # Windows explorer command line
    else:
        subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


# --- Windows: the Explorer window opened for the browser comes up behind it,
# because Windows only lets the foreground app raise windows. Find the new
# window and bring it to the front; if Windows still refuses, flash it on the
# taskbar. Never raises, and does nothing on other systems.

def pick_window(windows, before, name):
    """The Explorer window to raise. windows: [(hwnd, title)] of the visible
    Explorer windows now; before: the hwnds that were open before the launch.
    Prefer a new window, then one whose title is the folder (Explorer reuses a
    window that already shows it), else None to keep waiting."""
    name = (name or "").lower()
    def match(title):
        t = (title or "").lower()
        return bool(name) and (t == name or t.endswith("\\" + name) or name in t)
    new = [(h, t) for h, t in windows if h not in before]
    for h, t in new:
        if match(t):
            return h
    if len(new) == 1:
        return new[0][0]
    for h, t in windows:
        if match(t):
            return h
    return None


def _win_api(ctypes):
    """user32/kernel32 with the signatures set, so 64-bit window handles pass intact."""
    from ctypes import wintypes
    user32, kernel32 = ctypes.windll.user32, ctypes.windll.kernel32
    H, B, I, D = wintypes.HWND, wintypes.BOOL, ctypes.c_int, wintypes.DWORD
    sigs = {"IsWindowVisible": ([H], B), "IsIconic": ([H], B), "ShowWindow": ([H, I], B),
            "SetForegroundWindow": ([H], B), "GetForegroundWindow": ([], H), "BringWindowToTop": ([H], B),
            "GetWindowThreadProcessId": ([H, ctypes.c_void_p], D), "AttachThreadInput": ([D, D, B], B),
            "GetClassNameW": ([H, wintypes.LPWSTR, I], I), "GetWindowTextW": ([H, wintypes.LPWSTR, I], I),
            "AllowSetForegroundWindow": ([D], B)}
    for fn, (args, res) in sigs.items():
        f = getattr(user32, fn)
        f.argtypes, f.restype = args, res
    kernel32.GetCurrentThreadId.restype = D
    return user32, kernel32


def _explorer_windows(user32, ctypes):
    from ctypes import wintypes
    found = []
    proc = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def each(hwnd, _):
        try:
            if not user32.IsWindowVisible(hwnd):
                return True
            cls = ctypes.create_unicode_buffer(64)
            user32.GetClassNameW(hwnd, cls, 64)
            if cls.value in ("CabinetWClass", "ExploreWClass"):
                buf = ctypes.create_unicode_buffer(512)
                user32.GetWindowTextW(hwnd, buf, 512)
                found.append((int(hwnd or 0), buf.value))
        except Exception:
            pass
        return True
    user32.EnumWindows(proc(each), 0)
    return found


def _raise_window(user32, kernel32, hwnd):
    """SetForegroundWindow with the usual workarounds; True when it worked."""
    from ctypes import wintypes
    SW_RESTORE, SW_SHOW = 9, 5
    user32.ShowWindow(hwnd, SW_RESTORE if user32.IsIconic(hwnd) else SW_SHOW)
    if user32.SetForegroundWindow(hwnd) and user32.GetForegroundWindow() == hwnd:
        return True
    # join the input queue of the window that has the foreground, then raise
    fg = user32.GetForegroundWindow()
    fg_thread = user32.GetWindowThreadProcessId(fg, None) if fg else 0
    me = kernel32.GetCurrentThreadId()
    attached = bool(fg_thread) and fg_thread != me and user32.AttachThreadInput(me, fg_thread, True)
    try:
        user32.BringWindowToTop(hwnd)
        user32.SetForegroundWindow(hwnd)
    finally:
        if attached:
            user32.AttachThreadInput(me, fg_thread, False)
    if user32.GetForegroundWindow() == hwnd:
        return True
    # a key press counts as user input, which lets this process set the foreground
    VK_MENU, KEYUP = 0x12, 0x0002
    user32.keybd_event(VK_MENU, 0, 0, 0)
    user32.keybd_event(VK_MENU, 0, KEYUP, 0)
    user32.SetForegroundWindow(hwnd)
    return user32.GetForegroundWindow() == hwnd


def _flash_window(user32, ctypes, hwnd):
    from ctypes import wintypes
    class FLASHWINFO(ctypes.Structure):
        _fields_ = [("cbSize", wintypes.UINT), ("hwnd", wintypes.HWND), ("dwFlags", wintypes.DWORD),
                    ("uCount", wintypes.UINT), ("dwTimeout", wintypes.DWORD)]
    FLASHW_ALL, FLASHW_TIMERNOFG = 0x3, 0xC
    info = FLASHWINFO(ctypes.sizeof(FLASHWINFO), hwnd, FLASHW_ALL | FLASHW_TIMERNOFG, 0, 0)
    user32.FlashWindowEx(ctypes.byref(info))


def explorer_snapshot(platform=None):
    """The Explorer windows open now (hwnds), before a launch. Empty off Windows."""
    if not (platform or sys.platform).startswith("win"):
        return set()
    try:
        import ctypes
        return {h for h, _ in _explorer_windows(_win_api(ctypes)[0], ctypes)}
    except Exception:
        return set()


def bring_to_front(folder, before, platform=None, wait=4.0):
    """Windows only: in the background, wait for the Explorer window showing
    `folder` and bring it to the front (flash it on the taskbar if Windows
    won't allow that). Returns the thread, or None off Windows."""
    if not (platform or sys.platform).startswith("win"):
        return None
    import threading
    import time

    def run():
        try:
            import ctypes
            user32, kernel32 = _win_api(ctypes)
            user32.AllowSetForegroundWindow(0xFFFFFFFF)    # ASFW_ANY
            name = os.path.basename(os.path.normpath(folder))
            end = time.monotonic() + wait
            hwnd = None
            while time.monotonic() < end and not hwnd:
                time.sleep(0.15)
                hwnd = pick_window(_explorer_windows(user32, ctypes), before, name)
            if not hwnd:
                return
            time.sleep(0.1)                                # let Explorer finish showing it
            if not _raise_window(user32, kernel32, hwnd):
                _flash_window(user32, ctypes, hwnd)
        except Exception as err:                           # never break the route
            logger.debug("H3 Long Shot Studio: couldn't raise the folder window: %s", err)

    t = threading.Thread(target=run, name="longshot-raise-folder", daemon=True)
    t.start()
    return t


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Keep awake (0.8.4): while the Studio's queue has work, the ComfyUI machine
# doesn't go to sleep. The browser sends a heartbeat; ComfyUI's own queue
# counts too (the last job keeps running if the tab closes). One thread holds
# the OS request, so it's released the moment neither is true, or about
# KEEP_AWAKE_TTL seconds after the last heartbeat.
# ---------------------------------------------------------------------------

OPTIONAL_PACKS = {      # 0.8.6: optional features, installed from the Studio (fixed repos only)
    "turbo": ("ComfyUI-MiniMax-H3-Turbo", "https://github.com/Larryvrh/ComfyUI-MiniMax-H3-Turbo"),
    "rtx": ("ComfyUI-NVIDIA-RTX-VSR-Pro", "https://github.com/whmc76/ComfyUI-NVIDIA-RTX-VSR-Pro"),
    "refmod": ("ComfyUI-MiniMaxH3Mod", "https://github.com/Luisacaotica/ComfyUI-MiniMaxH3Mod"),
}


def install_pack(key, custom_nodes, run=None, git=None, python=None):
    """git clone one optional pack into custom_nodes (and pip its requirements with
    ComfyUI's own Python). Returns {folder, cloned, pip}. ComfyUI restarts to load it."""
    if key not in OPTIONAL_PACKS:
        raise ValueError("Not an optional pack.")
    folder, url = OPTIONAL_PACKS[key]
    run = run or (lambda cmd: subprocess.run(cmd, capture_output=True, timeout=900))
    dest = os.path.join(custom_nodes, folder)
    cloned = False
    if not os.path.isdir(dest):
        git = git or shutil.which("git")
        if not git:
            raise ValueError("git isn't installed on this machine. Run: git clone " + url)
        res = run([git, "clone", "--depth", "1", url, dest])
        if getattr(res, "returncode", 1) != 0:
            err = getattr(res, "stderr", b"") or b""
            raise RuntimeError("git clone failed: " + (err.decode("utf-8", "replace") if isinstance(err, bytes) else str(err))[-400:])
        cloned = True
    pip = False
    req = os.path.join(dest, "requirements.txt")
    if os.path.isfile(req):
        res = run([python or sys.executable, "-m", "pip", "install", "-r", req])
        pip = getattr(res, "returncode", 1) == 0
    return {"folder": dest, "cloned": cloned, "pip": pip, "url": url}


# ---------------------------------------------------------------------------
# Live preview (0.8.10): ComfyUI previews H3 latents itself, roughly (latent2rgb)
# or sharply with madebyollin's taeh3 decoder in models/vae_approx. The Studio
# can download that one file, pinned to a commit and checked by its hash.
# ---------------------------------------------------------------------------

PREVIEW_DECODER = {
    "file": "taeh3.safetensors",
    "url": "https://raw.githubusercontent.com/madebyollin/taehv/"
           "011dfc2112197741c540e0bdd5b7b67bcc930771/safetensors/taeh3.safetensors",
    "page": "https://github.com/madebyollin/taehv",
    "sha256": "4fd022bfcab08772fe0536b17ea1a3bbb5625be11e397868d1c5d891863d4c13",
    "size": 22709752,
}
MIN_COMFY = "0.35.0"


def preview_decoder_installed(names):
    """ComfyUI uses the first vae_approx file whose name starts with taeh3."""
    return any(os.path.basename(str(n)).startswith("taeh3") for n in names or [])


def _download(url, dest, timeout=60):
    import urllib.request
    req = urllib.request.Request(url, headers={"User-Agent": "H3-Long-Shot-Studio"})
    with urllib.request.urlopen(req, timeout=timeout) as r, open(dest, "wb") as f:
        shutil.copyfileobj(r, f, 1 << 20)


def install_preview_decoder(folder, fetch=None, spec=None):
    """Download the taeh3 decoder into `folder` (models/vae_approx). Kept only if
    its size and SHA-256 match. Returns {path, downloaded}."""
    import hashlib
    spec = spec or PREVIEW_DECODER
    os.makedirs(folder, exist_ok=True)
    dest = os.path.join(folder, spec["file"])

    def sha(path):
        h = hashlib.sha256()
        with open(path, "rb") as f:
            for block in iter(lambda: f.read(1 << 20), b""):
                h.update(block)
        return h.hexdigest()

    if os.path.isfile(dest) and sha(dest) == spec["sha256"]:
        return {"path": dest, "downloaded": False}
    tmp = dest + ".part"
    try:
        (fetch or _download)(spec["url"], tmp)
        if os.path.getsize(tmp) != spec["size"] or sha(tmp) != spec["sha256"]:
            raise RuntimeError("The downloaded file didn't match the expected one. Download "
                               f"{spec['file']} from {spec['page']} into {folder} by hand.")
        os.replace(tmp, dest)
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)
    return {"path": dest, "downloaded": True}


# ---------------------------------------------------------------------------
# Face refine (0.14.0): the face detector (MTCNN, MIT, from the facenet-pytorch
# wheel on PyPI: three small weight files) and a quick look at the faces in a take
# ---------------------------------------------------------------------------

FACE_DETECTOR = {
    "url": "https://files.pythonhosted.org/packages/ed/2e/2d56386bc2f834cdc683743903852cf1428b4e5ee119f16cf808b589d3cd/"
           "facenet_pytorch-2.6.0-py3-none-any.whl",
    "page": "https://pypi.org/project/facenet-pytorch/2.6.0/",
    "size": 1881930,
    "sha256": "ecb82b27beb226d106f2219efe8f829b01b87a8595badd01545679bdb9f19cca",
    "files": {
        "facenet_pytorch/data/pnet.pt": ("pnet.pt", "a2a71925e0b9996a42f63e47efc1ca19043e69558b5c523b978d611dfae49c8f"),
        "facenet_pytorch/data/rnet.pt": ("rnet.pt", "bbb937de72efc9ef83b186c49f5f558467a1d7e3453a8ece0d71a886633f6a86"),
        "facenet_pytorch/data/onet.pt": ("onet.pt", "165bfbe42940416ccfb977545cf0e976d5bf321f67083ae2aaaa5c764280118d"),
    },
}
FACE_FILES = ("pnet.pt", "rnet.pt", "onet.pt")


def face_detector_folder():
    """models/facedetect/mtcnn (a facedetect folder from extra_model_paths.yaml counts too)."""
    import folder_paths
    if "facedetect" not in folder_paths.folder_names_and_paths:
        folder_paths.folder_names_and_paths["facedetect"] = (
            [os.path.join(folder_paths.models_dir, "facedetect")], set())
    roots = folder_paths.get_folder_paths("facedetect") or [os.path.join(folder_paths.models_dir, "facedetect")]
    for r in roots:
        d = os.path.join(r, "mtcnn")
        if all(os.path.isfile(os.path.join(d, f)) for f in FACE_FILES):
            return d
    return os.path.join(roots[0], "mtcnn")


def face_detector_installed():
    try:
        d = face_detector_folder()
    except Exception:
        return False
    return all(os.path.isfile(os.path.join(d, f)) for f in FACE_FILES)


def _sha256(path):
    import hashlib
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def install_face_detector(folder, fetch=None, spec=None):
    """Download the facenet-pytorch wheel and keep its three MTCNN weight files in
    `folder`, each checked against its SHA-256 (nothing else from the wheel is kept or
    run). Returns {path, downloaded}."""
    import hashlib
    import zipfile
    spec = spec or FACE_DETECTOR
    os.makedirs(folder, exist_ok=True)
    if all(os.path.isfile(os.path.join(folder, name)) and _sha256(os.path.join(folder, name)) == sha
           for name, sha in spec["files"].values()):
        return {"path": folder, "downloaded": False}
    tmp = os.path.join(folder, ".facenet.whl.part")
    try:
        (fetch or _download)(spec["url"], tmp)
        if os.path.getsize(tmp) != spec["size"] or _sha256(tmp) != spec["sha256"]:
            raise RuntimeError("The download didn't match the expected file. Get facenet_pytorch-2.6.0's wheel "
                               f"from {spec['page']} and copy pnet.pt, rnet.pt and onet.pt from its "
                               f"facenet_pytorch/data folder into {folder}.")
        with zipfile.ZipFile(tmp) as z:
            for member, (name, sha) in spec["files"].items():
                data = z.read(member)
                if hashlib.sha256(data).hexdigest() != sha:
                    raise RuntimeError(f"{name} in the download isn't the expected file.")
                part = os.path.join(folder, name + ".part")
                with open(part, "wb") as fh:
                    fh.write(data)
                os.replace(part, os.path.join(folder, name))
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)
    return {"path": folder, "downloaded": True}


def faces_module():
    """Long Shot's faces module (1.8.0), or None."""
    try:
        import importlib
        import nodes as comfy_nodes
        cls = comfy_nodes.NODE_CLASS_MAPPINGS.get("MiniMaxH3FaceRefine")
        if cls is None:
            return None
        return importlib.import_module(cls.__module__.rsplit(".", 1)[0] + ".faces")
    except Exception:
        return None


def read_frames(path, every=6, ffmpeg=None, max_frames=80):
    """Every `every`-th frame of a video as uint8 [N,H,W,3] (torch), with ffmpeg."""
    import numpy as np
    import torch
    info = probe_video(path)
    w, h = int(info.get("width") or 0), int(info.get("height") or 0)
    ffmpeg = ffmpeg or _ffmpeg_path()
    if not ffmpeg or not w or not h:
        return None
    cmd = [ffmpeg, "-hide_banner", "-loglevel", "error", "-i", path, "-vf", f"select=not(mod(n\\,{int(every)}))",
           "-vsync", "0", "-frames:v", str(int(max_frames)), "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]
    try:
        res = subprocess.run(cmd, capture_output=True, timeout=120,
                             creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    except (OSError, subprocess.SubprocessError):
        return None
    n = len(res.stdout) // (w * h * 3)
    if res.returncode != 0 or n == 0:
        return None
    arr = np.frombuffer(res.stdout[:n * w * h * 3], np.uint8).reshape(n, h, w, 3)
    return torch.from_numpy(arr.copy())


def scan_faces(path, faces, folder, every=6):
    """The faces in one take's clip: {h, w, faces: [{size, cx, cy, w, hh}]} (size in pixels
    of the clip, biggest first; cx..hh: the face's box in the middle of its run, as
    fractions of the picture). On the CPU, so a render isn't slowed down."""
    frames = read_frames(path, every)
    if frames is None:
        return None
    det = faces.detector(folder, "cpu")
    found = {}
    for i in range(frames.shape[0]):
        b, sc, p = det.detect(frames[i], min_face=12)
        found[i] = [(b[j], float(sc[j]), p[j]) for j in range(len(sc)) if sc[j] >= 0.9]
    tracks = faces.build_tracks(found, frames.shape[0], max_gap=3, min_hits=2, sigma=0.8)
    H, W = int(frames.shape[1]), int(frames.shape[2])
    rows = []
    for t in sorted(tracks, key=lambda t: -t.size()):
        mid = len(t.cx) // 2
        rows.append({"size": round(t.size(), 1), "cx": round(float(t.cx[mid]) / W, 4),
                     "cy": round(float(t.cy[mid]) / H, 4), "w": round(float(t.w[mid]) / W, 4),
                     "hh": round(float(t.h[mid]) / H, 4)})
    return {"h": H, "w": W, "faces": rows[:8]}


def comfy_status():
    """ComfyUI's version, and whether it has what Long Shot needs (native H3 with
    guides at any frame: ComfyUI 0.35.0, Sept 2026). Checked by ability, so
    nightly and Desktop builds count by what they can do."""
    version = None
    try:
        import comfyui_version
        version = str(comfyui_version.__version__)
    except Exception:
        pass
    try:
        import inspect
        from comfy.ldm.minimax.model import PackedLayout
        ok = "frame_count" not in inspect.signature(PackedLayout.__init__).parameters
    except Exception:
        ok = False
    return {"version": version, "ok": ok, "min": MIN_COMFY}


KEEP_AWAKE_TTL = 120.0


class KeepAwake:
    ES_CONTINUOUS, ES_SYSTEM_REQUIRED, ES_AWAYMODE_REQUIRED = 0x80000000, 0x00000001, 0x00000040

    def __init__(self, platform=None, clock=None, busy=None):
        import threading
        import time
        self.platform = platform or sys.platform
        self.clock = clock or time.monotonic
        self.busy = busy or comfy_queue_busy
        self.until = 0.0
        self.held = False
        self.proc = None
        self.lock = threading.Lock()
        self.thread = None
        self.wake = threading.Event()

    def beat(self, on):
        """A heartbeat from the browser: on = its queue has work."""
        with self.lock:
            self.until = self.clock() + KEEP_AWAKE_TTL if on else 0.0
        self._ensure_thread()
        self.wake.set()
        return self.state()

    def wanted(self):
        return self.clock() < self.until or bool(self.busy())

    def state(self):
        return {"held": self.held, "how": self.how()}

    def how(self):
        if self.platform == "win32":
            return "Windows: system sleep blocked (the screen can still turn off)"
        if self.platform == "darwin":
            return "macOS: caffeinate -i"
        return "Linux: systemd-inhibit (sleep)" if shutil.which("systemd-inhibit") else "not supported here"

    def _ensure_thread(self):
        import threading
        if self.thread is None or not self.thread.is_alive():
            self.thread = threading.Thread(target=self._run, name="longshot-keep-awake", daemon=True)
            self.thread.start()

    def _run(self):
        # SetThreadExecutionState holds for the thread that calls it: this one.
        while True:
            want = self.wanted()
            if want != self.held:
                try:
                    self._apply(want)
                    self.held = want
                    logger.info("Long Shot Studio: %s", "the queue has work, keeping this machine awake."
                                if want else "the queue is idle, sleep is allowed again.")
                except Exception as err:      # never break a render over this
                    logger.warning("Long Shot Studio: couldn't change the sleep setting: %s", err)
                    self.held = want
            elif want and self.platform == "win32":
                try:
                    self._apply(True)        # refresh, harmless
                except Exception:
                    pass
            if not want and self.clock() >= self.until and not self.busy():
                self.wake.wait(30)
            else:
                self.wake.wait(20)
            self.wake.clear()

    def _apply(self, on):
        if self.platform == "win32":
            import ctypes
            flags = self.ES_CONTINUOUS | (self.ES_SYSTEM_REQUIRED if on else 0)
            ctypes.windll.kernel32.SetThreadExecutionState(flags)
            return
        if on and self.proc is None:
            if self.platform == "darwin" and shutil.which("caffeinate"):
                self.proc = subprocess.Popen(["caffeinate", "-i", "-w", str(os.getpid())])
            elif shutil.which("systemd-inhibit"):
                self.proc = subprocess.Popen(["systemd-inhibit", "--what=sleep:idle", "--who=H3 Long Shot Studio",
                                              "--why=Renders in the queue", "sleep", "infinity"])
        elif not on and self.proc is not None:
            self.proc.terminate()
            self.proc = None


def comfy_queue_busy():
    """ComfyUI has prompts running or waiting."""
    try:
        from server import PromptServer
        q = PromptServer.instance.prompt_queue
        return bool(q.get_tasks_remaining())
    except Exception:
        return False


KEEP_AWAKE = KeepAwake()


def register(routes=None):
    """Attach the routes to ComfyUI's PromptServer. False when there is none
    (tests, scripts)."""
    from aiohttp import web
    if routes is None:
        try:
            from server import PromptServer
            routes = PromptServer.instance.routes
        except Exception:
            return False

    no_cache = {"Cache-Control": "no-cache"}

    def error(msg, status=400):
        return web.json_response({"error": str(msg)}, status=status)

    @routes.get("/longshot")
    @routes.get("/longshot/")
    async def page(request):
        return web.FileResponse(os.path.join(WEB_DIR, "index.html"), headers=no_cache)

    @routes.get("/longshot/static/{name}")
    async def static(request):
        name = request.match_info["name"]
        path = os.path.join(WEB_DIR, name)
        if os.path.dirname(os.path.realpath(path)) != os.path.realpath(WEB_DIR) \
                or not os.path.isfile(path):
            return web.Response(status=404)
        return web.FileResponse(path, headers=no_cache)

    @routes.get("/longshot/capabilities")
    async def capabilities(request):
        return web.json_response({"local": is_local_request(request.remote, request.headers),
                                  "version": VERSION})

    @routes.get("/longshot/options")
    async def options(request):
        return web.json_response(options_payload())

    @routes.get("/longshot/stats")
    async def stats(request):
        data = await asyncio.get_running_loop().run_in_executor(None, system_stats)
        return web.json_response(data, headers=no_cache)

    @routes.get("/longshot/models")
    async def models(request):
        kind = request.query.get("kind", "")
        if kind not in pj.MODEL_KINDS:
            return error("kind must be one of " + ", ".join(pj.MODEL_KINDS))
        return web.json_response(model_listing(kind))

    @routes.get("/longshot/browse")
    async def browse(request):
        if not local(request):
            return error("Folders can only be browsed from the machine running ComfyUI.", 403)
        try:
            return web.json_response(pj.browse_dir(request.query.get("path", "")))
        except ValueError as err:
            return error(err)

    @routes.post("/longshot/model-folders")
    async def model_folders(request):
        """{kind, path, action: "add" | "remove"} — loopback only."""
        import folder_paths
        if not local(request):
            return error("Model folders can only be changed from the machine running ComfyUI.", 403)
        body = await body_of(request)
        kind = (body or {}).get("kind")
        path = str((body or {}).get("path") or "").strip()
        action = (body or {}).get("action", "add")
        if kind not in pj.MODEL_KINDS or not path:
            return error("Send {kind, path, action}.")
        path = os.path.abspath(os.path.expanduser(path))
        saved = pj.load_model_folders(model_folders_path())
        mine = saved.setdefault(kind, [])
        if action == "add":
            if not os.path.isdir(path):
                return error(f"Not a folder: {path}")
            if path not in folder_paths.get_folder_paths(kind):
                folder_paths.add_model_folder_path(kind, path)
                _ADDED.setdefault(kind, []).append(path)
            if path not in mine:
                mine.append(path)
        elif action == "remove":
            if path not in mine:
                return error("Only folders added here can be removed here. Folders from ComfyUI's "
                             "own settings (extra_model_paths.yaml) stay.", 409)
            mine.remove(path)
            paths = folder_paths.folder_names_and_paths.get(kind, ([], set()))[0]
            if path in paths:
                paths.remove(path)
            # ComfyUI's file list cache notices added folders, not removed ones
            getattr(folder_paths, "filename_list_cache", {}).pop(kind, None)
            helper = getattr(folder_paths, "cache_helper", None)
            if helper is not None and hasattr(helper, "cache"):
                helper.cache.pop(kind, None)
        else:
            return error("action must be add or remove")
        pj.save_model_folders(model_folders_path(), saved)
        return web.json_response(model_listing(kind))

    @routes.post("/longshot/build")
    async def build(request):
        try:
            body = await request.json()
        except ValueError:
            return error("Body must be JSON.")
        import folder_paths
        lists = {}
        for kind in ("diffusion_models", "text_encoders", "vae", "loras"):
            try:
                lists[kind] = folder_paths.get_filename_list(kind)
            except Exception:
                lists[kind] = []
        project = resolve_names(body.get("project") or {}, lists)
        context_notes = []
        if not body.get("take_clips") and not body.get("export_clips") and not body.get("face_try"):
            context_notes = await asyncio.get_running_loop().run_in_executor(
                None, add_context_frames, project, bool(body.get("dry_run")), body.get("upto"),
                bool(body.get("standalone")))
        try:
            if isinstance(body.get("take_audio"), dict):
                built = gb.build_take_audio(project, body["take_audio"].get("take"), env=current_env())
            elif isinstance(body.get("take_clips"), list):
                built = gb.build_take_clips(project, body["take_clips"][:64], env=current_env())
            elif isinstance(body.get("face_try"), dict):
                built = gb.build_face_try(project, body["face_try"], env=current_env())
            elif isinstance(body.get("export_clips"), list):
                built = gb.build_clip_export(project, body["export_clips"][:64], env=current_env())
            else:
                built = gb.build_prompt(project, upto=body.get("upto"),
                                        dry_run=bool(body.get("dry_run")), env=current_env(),
                                        final=bool(body.get("final")),
                                        standalone=bool(body.get("standalone")),
                                        clips_for=body.get("clips_for") if isinstance(body.get("clips_for"), list) else None,
                                        chunk=body.get("chunk") if isinstance(body.get("chunk"), dict) else None)
        except gb.BuildError as err:
            return error(err)
        out = built.as_dict()
        if context_notes:
            out["warnings"] = list(out.get("warnings") or []) + context_notes
        return web.json_response(out)

    def add_context_frames(project, dry_run, upto=None, standalone=False):
        """Context Continuity Shots that render get the last frame of the Shot
        before them (made from its take's clip). Returns warnings for those
        that can't have it yet."""
        import folder_paths
        shots = [x for x in project.get("shots") or [] if isinstance(x, dict) and not x.get("bypassed")]
        notes = []
        if any(x.get("join") == "context" for x in shots) and not _timeline_has_context():
            raise_build = "Context Continuity needs H3 Long Shot 1.6.8 or later. Update it, then restart ComfyUI."
            notes.append(raise_build)
            for x in shots:
                if x.get("join") == "context":
                    x["join"] = "cut"
            return notes
        ffmpeg = None
        ids = [x.get("id") for x in shots]
        last = ids.index(upto) if upto in ids else len(shots) - 1     # what this run renders
        for i, sh in enumerate(shots):
            if i > last or (standalone and i != last):
                continue
            if sh.get("join") != "context" or sh.get("kind") == "clip" or sh.get("lock") or i == 0:
                continue
            prev = shots[i - 1]
            if prev.get("kind") != "clip" and (prev.get("status") == "queued" or not prev.get("take")):
                if not dry_run:
                    notes.append(f"Shot {i + 1} (Context): the Shot before it has no take yet, so it "
                                 "renders without its last frame.")
                continue
            ffmpeg = ffmpeg or _ffmpeg_path()
            if not ffmpeg:
                notes.append("ffmpeg isn't available: Context Shots render without the frame before.")
                break
            slug = gb.project_slug(project)
            info = pj.context_frame(folder_paths.get_output_directory(), folder_paths.get_input_directory(),
                                    slug, prev, ffmpeg=ffmpeg)
            if info:
                sh["context_image"] = info
            elif not dry_run:
                notes.append(f"Shot {i + 1} (Context): the take before it has no clip yet (Make missing "
                             "clips under the timeline), so it renders without its last frame.")
        return notes

    def local(request):
        return is_local_request(request.remote, request.headers)

    async def body_of(request):
        try:
            body = await request.json()
        except ValueError:
            return None
        return body if isinstance(body, dict) else None

    def slug_of(request):
        slug = request.match_info["slug"]
        return slug if pj.is_slug(slug) else None

    @routes.get("/longshot/projects")
    async def projects(request):
        import folder_paths
        inp, out = folder_paths.get_input_directory(), folder_paths.get_output_directory()
        listing = await asyncio.get_running_loop().run_in_executor(None, lambda: project_store().list(
            check=lambda slug, p: {"files_missing": pj.files_missing(inp, out, slug, p)}))
        return web.json_response(listing)

    @routes.post("/longshot/projects")
    async def create_project(request):
        body = await body_of(request)
        if body is None or not str(body.get("name") or "").strip():
            return error("Give the project a name.")
        project = body.get("project") if isinstance(body.get("project"), dict) else {}
        slug, saved_at = project_store().create(str(body["name"]).strip(), project)
        return web.json_response({"slug": slug, "saved_at": saved_at})

    @routes.get("/longshot/projects/{slug}")
    async def get_project(request):
        slug, store = slug_of(request), project_store()
        if not slug or not store.exists(slug):
            return error("No such project.", 404)
        return web.json_response(store.load(slug))

    @routes.put("/longshot/projects/{slug}")
    async def put_project(request):
        slug, project = slug_of(request), await body_of(request)
        if not slug:
            return error("Not a project slug.", 400)
        if project is None:
            return error("A project is a JSON object.")
        base = request.query.get("base")
        try:
            saved_at = project_store().save(slug, project, base=base,
                                            force=request.query.get("force") == "1")
        except pj.Conflict as c:
            return web.json_response({"error": "This project was changed in another tab.",
                                      "current": c.current}, status=409)
        return web.json_response({"slug": slug, "saved_at": saved_at})

    @routes.post("/longshot/projects/{slug}/rename")
    async def rename_project(request):
        """{name, base}: renames the project and moves its input and takes
        folders to the new name. Refused while ComfyUI has work queued."""
        import folder_paths
        slug, body = slug_of(request), await body_of(request)
        if not slug or body is None:
            return error("Send {name}.")
        store = project_store()
        if not store.exists(slug):
            return error("No such project.", 404)
        if comfy_queue_busy():
            return error("ComfyUI is still rendering. Rename when its queue is empty, so no "
                         "files move during a render.", 409)
        try:
            new, saved_at = pj.rename_project(store, folder_paths.get_input_directory(),
                                              folder_paths.get_output_directory(), slug,
                                              body.get("name"), body.get("base"))
        except pj.Conflict as c:
            return web.json_response({"error": "This project was changed in another tab.",
                                      "current": c.current}, status=409)
        except ValueError as err:
            return error(err)
        return web.json_response({"slug": new, "saved_at": saved_at})

    @routes.delete("/longshot/projects/{slug}")
    async def delete_project(request):
        import folder_paths
        slug = slug_of(request)
        if not slug:
            return error("Not a project slug.", 400)
        segments, inputs = request.query.get("segments") == "1", request.query.get("inputs") == "1"
        videos = request.query.get("videos") == "1"
        if (segments or inputs or videos) and not local(request):
            return error("Files can only be deleted from the machine running ComfyUI.", 403)
        out = {"project": project_store().delete(slug)}
        if segments:
            out["segments"] = pj.clear_segments(folder_paths.get_output_directory(), slug)
        if inputs:
            out["inputs"] = pj.delete_inputs(folder_paths.get_input_directory(), slug)
        if videos:
            out["videos"] = pj.delete_videos(folder_paths.get_output_directory(), slug)
        return web.json_response(out)

    @routes.get("/longshot/inputs")
    async def inputs(request):
        import folder_paths
        try:
            listing = pj.list_inputs(folder_paths.get_input_directory(),
                                     request.query.get("subfolder", ""))
        except ValueError as err:
            return error(err)
        return web.json_response(listing)

    @routes.post("/longshot/upload")
    async def upload(request):
        """Multipart: project=<slug>, kind=images|audio|video, file. Saved to input/longshot/<slug>/."""
        import folder_paths
        try:
            form = await request.post()
        except Exception as err:        # e.g. over ComfyUI's --max-upload-size
            return error(f"Upload failed: {err}", 413 if "large" in str(err).lower() else 400)
        slug, f = str(form.get("project") or ""), form.get("file")
        kind = str(form.get("kind") or "images")
        if not pj.is_slug(slug) or not project_store().exists(slug):
            return error("No such project.", 404)
        if f is None or not hasattr(f, "file"):
            return error("Send the file as 'file'.")
        data = f.file.read()
        try:
            saved = await asyncio.get_running_loop().run_in_executor(
                None, pj.store_upload, folder_paths.get_input_directory(), slug, f.filename, data,
                kind)
        except ValueError as err:
            return error(err)
        return web.json_response(saved)

    @routes.post("/longshot/check-inputs")
    async def check_inputs(request):
        import folder_paths
        body = await body_of(request)
        if body is None or not isinstance(body.get("files"), list):
            return error("Send {files: [...]}.")
        input_dir = folder_paths.get_input_directory()
        out = []
        for entry in body["files"][:200]:
            entry = entry if isinstance(entry, dict) else {}
            result = pj.check_file(input_dir, entry)
            result["key"] = entry.get("key")
            out.append(result)
        return web.json_response({"files": out})

    @routes.get("/longshot/probe")
    async def probe(request):
        """Length, frame rate, size and sound of a video in the input folder."""
        import folder_paths
        try:
            path = pj.resolve_input(folder_paths.get_input_directory(), request.query.get("name"),
                                    request.query.get("subfolder", ""))
        except ValueError as err:
            return error(err)
        if not os.path.isfile(path):
            return error("No such file.", 404)
        info = await asyncio.get_running_loop().run_in_executor(None, probe_video, path)
        if info.get("duration") is None:
            return error("ffmpeg couldn't read that video.")
        return web.json_response(info)

    @routes.get("/longshot/filmstrip")
    async def filmstrip(request):
        """A strip of 6 thumbnails from a video (JPEG), cached by file, in and out."""
        import folder_paths
        q = request.query
        try:
            path = pj.resolve_input(folder_paths.get_input_directory(), q.get("name"),
                                    q.get("subfolder", ""))
            t0, t1 = max(0.0, float(q.get("in", 0))), float(q.get("out", 0))
        except (ValueError, TypeError) as err:
            return error(err)
        if not os.path.isfile(path):
            return error("No such file.", 404)
        out = await asyncio.get_running_loop().run_in_executor(None, make_filmstrip, path, t0, t1)
        if not out:
            return error("ffmpeg couldn't make a filmstrip.", 500)
        return web.FileResponse(out, headers={"Cache-Control": "max-age=3600"})

    @routes.get("/longshot/export/{slug}/estimate")
    async def export_estimate(request):
        import folder_paths
        slug, store = slug_of(request), project_store()
        if not slug or not store.exists(slug):
            return error("No such project.", 404)
        return web.json_response(pj.export_estimate(
            folder_paths.get_input_directory(), folder_paths.get_output_directory(), slug,
            store.load(slug)))

    @routes.get("/longshot/export/{slug}")
    async def export(request):
        """The project as one .zip (loopback only): ?takes=1&video=0."""
        import folder_paths
        slug, store = slug_of(request), project_store()
        if not slug or not store.exists(slug):
            return error("No such project.", 404)
        if not local(request):
            return error("Projects can only be exported on the machine running ComfyUI.", 403)
        project = store.load(slug)
        folder = os.path.join(folder_paths.get_temp_directory(), "longshot-export")
        os.makedirs(folder, exist_ok=True)
        dest = os.path.join(folder, slug + ".zip")
        await asyncio.get_running_loop().run_in_executor(
            None, lambda: pj.export_project(
                folder_paths.get_input_directory(), folder_paths.get_output_directory(),
                project, dest, takes=request.query.get("takes", "1") == "1",
                video=request.query.get("video") == "1"))
        name = gb.safe_name(project.get("name") or slug)
        return web.FileResponse(dest, headers={
            "Content-Disposition": f'attachment; filename="{name}.zip"',
            "Cache-Control": "no-cache"})

    @routes.post("/longshot/import")
    async def import_(request):
        """Multipart file=<export .zip> (loopback only). Streamed to disk, so
        ComfyUI's upload size limit doesn't apply."""
        import folder_paths
        if not local(request):
            return error("Projects can only be imported on the machine running ComfyUI.", 403)
        folder = os.path.join(folder_paths.get_temp_directory(), "longshot-import")
        os.makedirs(folder, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=folder, suffix=".zip")
        os.close(fd)
        try:
            reader = await request.multipart()
            got = False
            while True:
                part = await reader.next()
                if part is None:
                    break
                if part.name != "file":
                    continue
                with open(tmp, "wb") as out:
                    while True:
                        chunk = await part.read_chunk(1 << 20)
                        if not chunk:
                            break
                        out.write(chunk)
                got = True
            if not got:
                return error("Send the .zip as 'file'.")
            slug, summary = await asyncio.get_running_loop().run_in_executor(
                None, pj.import_project, project_store(), folder_paths.get_input_directory(),
                folder_paths.get_output_directory(), tmp)
        except ValueError as err:
            return error(err)
        finally:
            try:
                os.remove(tmp)
            except OSError:
                pass
        return web.json_response(dict(summary, slug=slug))

    @routes.post("/longshot/find-inputs")
    async def find_inputs(request):
        """{project, files: [{key, name, sha256}]}: where missing references are now."""
        import folder_paths
        body = await body_of(request)
        if body is None or not isinstance(body.get("files"), list):
            return error("Send {project, files: [...]}.")
        found = await asyncio.get_running_loop().run_in_executor(
            None, pj.find_inputs, folder_paths.get_input_directory(),
            str(body.get("project") or ""), body["files"][:200])
        return web.json_response({"files": found})

    @routes.get("/longshot/segments/{slug}")
    async def segments(request):
        import folder_paths
        slug = slug_of(request)
        if not slug:
            return error("Not a project slug.", 400)
        return web.json_response(pj.segment_stats(folder_paths.get_output_directory(), slug))

    @routes.get("/longshot/takes/{slug}")
    async def takes(request):
        import folder_paths
        slug = slug_of(request)
        if not slug:
            return error("Not a project slug.")
        shot = request.query.get("shot")
        return web.json_response({"takes": pj.list_takes(folder_paths.get_output_directory(),
                                                         slug, shot)})

    @routes.delete("/longshot/takes/{slug}/{name}")
    async def delete_take(request):
        import folder_paths
        slug, name = slug_of(request), request.match_info["name"]
        if not slug or not pj.TAKE_NAME_RE.fullmatch(name):
            return error("Not a take.")
        if not local(request):
            return error("Takes can only be deleted from the machine running ComfyUI.", 403)
        store = project_store()
        if store.exists(slug):
            for i, shot in enumerate(store.load(slug).get("shots") or []):
                if shot.get("take") == name:
                    return error("That take is the one this Shot uses. Switch to another take "
                                 "first.", 409)
        removed = pj.delete_take(folder_paths.get_output_directory(), slug, name)
        return web.json_response({"deleted": removed,
                                  **pj.segment_stats(folder_paths.get_output_directory(), slug)})

    @routes.post("/longshot/clear-segments")
    async def clear_segments(request):
        import folder_paths
        if not local(request):
            return error("Saved takes can only be deleted from the machine running ComfyUI.", 403)
        body = await body_of(request) or {}
        slug = body.get("project")
        if not pj.is_slug(slug):
            return error("Not a project slug.")
        removed = pj.clear_segments(folder_paths.get_output_directory(), slug)
        return web.json_response({"removed": removed,
                                  **pj.segment_stats(folder_paths.get_output_directory(), slug)})

    @routes.post("/longshot/open-folder")
    async def open_folder(request):
        if not is_local_request(request.remote, request.headers):
            return error("Folders can only be opened from the machine running ComfyUI.", 403)
        try:
            body = await request.json()
        except ValueError:
            body = {}
        import folder_paths
        try:
            folder, wanted = open_target(folder_paths.get_output_directory(),
                                         folder_paths.get_input_directory(), body)
        except ValueError as err:
            return error(err)
        os.makedirs(folder, exist_ok=True)
        select = selectable(folder, wanted)
        before = explorer_snapshot()
        try:
            launch(open_command(folder, select))
        except Exception as err:
            return error(f"Couldn't open the folder: {err}", 500)
        bring_to_front(folder, before)
        return web.json_response({"opened": folder, "selected": bool(select)})

    @routes.post("/longshot/cleanup-outputs")
    async def cleanup_outputs(request):
        """{prompt_id, png, noaudio}: after a render, delete the side files the
        project doesn't keep. Only files ComfyUI's history lists for that
        prompt, inside output/longshot, and never the video with sound."""
        import folder_paths
        body = await body_of(request)
        if body is None or not isinstance(body.get("prompt_id"), str):
            return error("Send {prompt_id, png, noaudio}.")
        png, noaudio = bool(body.get("png")), bool(body.get("noaudio"))
        outputs = history_outputs(body["prompt_id"])
        if outputs is None:
            return error("ComfyUI has no finished render with that id.", 404)
        removed = await asyncio.get_running_loop().run_in_executor(
            None, pj.remove_render_side_files, folder_paths.get_output_directory(),
            video_entries(outputs), png, noaudio)
        return web.json_response({"removed": removed})

    @routes.post("/longshot/chunks/{slug}/join")
    async def join_chunks(request):
        """{prefix, chunks: [{filename, subfolder}], audio, masters}: join the
        chunks of an upscaled render (pictures copied, not encoded again) and
        its sound into one video in the project's videos folder."""
        import folder_paths
        slug, body = slug_of(request), await body_of(request)
        if not slug or body is None or not isinstance(body.get("chunks"), list):
            return error("Send {prefix, chunks, audio, masters}.")
        ffmpeg = _ffmpeg_path()
        if not ffmpeg:
            return error("ffmpeg isn't available, so the chunks can't be joined.", 500)
        try:
            out = await asyncio.get_running_loop().run_in_executor(
                None, lambda: pj.join_chunks(folder_paths.get_output_directory(), slug, body.get("prefix"),
                                             body["chunks"], body.get("audio"),
                                             body.get("masters") if isinstance(body.get("masters"), list) else None,
                                             ffmpeg=ffmpeg, gaps=body.get("gaps") if isinstance(body.get("gaps"), list) else None,
                                             song=body.get("song") if isinstance(body.get("song"), dict) else None,
                                             input_dir=folder_paths.get_input_directory(),
                                             codec_args=chunk_codec_args(body.get("codec")),
                                             master_args=chunk_codec_args("prores_hq")))
        except ValueError as err:
            return error(err)
        except Exception as err:
            return error(str(err), 500)
        return web.json_response(out)

    @routes.post("/longshot/approved/{slug}")
    async def approved_clips(request):
        """Export approved clips. {mode: "copy", items: [{key, name}]} copies each
        clip whole; {mode: "mux", items: [{name, video, audio, master}]} finishes
        the upscaled export (adds the sound); {mode: "clear"} empties the folder."""
        import folder_paths
        slug, body = slug_of(request), await body_of(request)
        if not slug or body is None:
            return error("Send {mode, items}.")
        out_dir, mode = folder_paths.get_output_directory(), body.get("mode")
        try:
            if mode == "copy":
                song = body.get("song") if isinstance(body.get("song"), dict) else None
                names = await asyncio.get_running_loop().run_in_executor(
                    None, lambda: pj.copy_approved(out_dir, slug, body.get("items"), ffmpeg=_ffmpeg_path(),
                                                   input_dir=folder_paths.get_input_directory(), song=song))
            elif mode == "mux":
                ffmpeg = _ffmpeg_path()
                if not ffmpeg:
                    return error("ffmpeg isn't available.", 500)
                names = await asyncio.get_running_loop().run_in_executor(
                    None, lambda: pj.mux_approved(out_dir, slug, body.get("items"), ffmpeg=ffmpeg,
                                                  sig=body.get("sig")))
            elif mode == "keep":
                res = await asyncio.get_running_loop().run_in_executor(
                    None, lambda: pj.keep_upscaled(out_dir, slug, body.get("items"), str(body.get("sig") or ""),
                                                   prores=bool(body.get("prores")), ffmpeg=_ffmpeg_path(),
                                                   input_dir=folder_paths.get_input_directory(),
                                                   song=body.get("song") if isinstance(body.get("song"), dict) else None))
                return web.json_response({**res, "subfolder": pj.approved_subfolder(slug)})
            elif mode == "clear":
                names = []
                pj.clear_approved(out_dir, slug)
            else:
                return error("mode must be copy, mux, keep or clear.")
        except ValueError as err:
            return error(err)
        except Exception as err:
            return error(str(err), 500)
        return web.json_response({"files": names, "subfolder": pj.approved_subfolder(slug)})

    @routes.post("/longshot/chunks/{slug}/discard")
    async def discard_chunks(request):
        """Remove the chunks of an upscale that was stopped or failed."""
        import folder_paths
        slug = slug_of(request)
        if not slug:
            return error("Not a project slug.")
        return web.json_response({"removed": pj.discard_chunks(folder_paths.get_output_directory(), slug)})

    @routes.get("/longshot/clips/{slug}")
    async def clips(request):
        import folder_paths
        slug = slug_of(request)
        if not slug:
            return error("Not a project slug.")
        return web.json_response(pj.clip_index(folder_paths.get_output_directory(), slug),
                                 headers=no_cache)

    @routes.post("/longshot/clips/{slug}")
    async def cut_clips(request):
        """{video: {filename, subfolder}, rows: [{key, start, end}]}: cut each
        take's piece of a finished render for the timeline (CPU only)."""
        import folder_paths
        slug, body = slug_of(request), await body_of(request)
        if not slug or body is None or not isinstance(body.get("rows"), list):
            return error("Send {video, rows}.")
        ffmpeg = _ffmpeg_path()
        if not ffmpeg:
            return error("ffmpeg isn't available.", 500)

        def run(cmd):
            try:
                return subprocess.run(cmd, capture_output=True, timeout=300,
                                      creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0)).returncode == 0
            except (OSError, subprocess.SubprocessError):
                return False
        try:
            index = await asyncio.get_running_loop().run_in_executor(
                None, pj.cut_clips, folder_paths.get_output_directory(), slug, body.get("video") or {},
                body["rows"][:64], run, ffmpeg)
        except ValueError as err:
            return error(err)
        return web.json_response(index)

    @routes.post("/longshot/clips/{slug}/adopt")
    async def adopt_clips(request):
        """{items: [{key, file}]}: clips Video Combine just saved become the timeline's clips."""
        import folder_paths
        slug, body = slug_of(request), await body_of(request)
        if not slug or body is None or not isinstance(body.get("items"), list):
            return error("Send {items}.")
        ffmpeg = _ffmpeg_path()

        def probe(path):
            return probe_video(path).get("duration")

        def thumb(src, dest):
            if not ffmpeg:
                return False
            try:
                return subprocess.run([ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-ss", "0.5",
                                       "-i", src, "-frames:v", "1", "-vf", "scale=384:-2", "-q:v", "5", dest],
                                      capture_output=True, timeout=60,
                                      creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0)).returncode == 0
            except (OSError, subprocess.SubprocessError):
                return False
        index = await asyncio.get_running_loop().run_in_executor(
            None, pj.adopt_clips, folder_paths.get_output_directory(), slug, body["items"][:64], probe, thumb)
        return web.json_response(index)

    @routes.post("/longshot/clear-cache")
    async def clear_cache(request):
        if comfy_queue_busy():
            return error("ComfyUI is rendering. Clear the cache when its queue is empty.", 409)
        n = await asyncio.get_running_loop().run_in_executor(None, clear_longshot_cache)
        if n is None:
            return error("The H3 Long Shot pack isn't loaded.", 404)
        return web.json_response({"cleared": n})

    @routes.post("/longshot/install-pack")
    async def install_pack_route(request):
        """{pack}: clone an optional pack (Turbo, RTX VSR, RefMod). Local only."""
        if not is_local_request(request.remote, request.headers):
            return error("Packs can only be installed from the machine running ComfyUI.", 403)
        try:
            body = await request.json()
        except ValueError:
            body = {}
        import folder_paths
        roots = folder_paths.get_folder_paths("custom_nodes")
        if not roots:
            return error("ComfyUI's custom_nodes folder wasn't found.", 500)
        try:
            out = await asyncio.get_running_loop().run_in_executor(
                None, lambda: install_pack(str(body.get("pack") or ""), roots[0]))
        except ValueError as err:
            return error(err)
        except Exception as err:
            return error(str(err), 500)
        return web.json_response(out)

    @routes.post("/longshot/install-preview")
    async def install_preview_route(request):
        """Download the taeh3 live-preview decoder into models/vae_approx. Local only."""
        if not is_local_request(request.remote, request.headers):
            return error("The preview decoder can only be installed from the machine running ComfyUI.", 403)
        import folder_paths
        roots = folder_paths.get_folder_paths("vae_approx")
        if not roots:
            return error("ComfyUI's models/vae_approx folder wasn't found.", 500)
        try:
            out = await asyncio.get_running_loop().run_in_executor(
                None, lambda: install_preview_decoder(roots[0]))
        except Exception as err:
            return error(f"Couldn't download the preview decoder: {err}", 500)
        return web.json_response(out)

    @routes.post("/longshot/install-face-detector")
    async def install_face_detector_route(request):
        """Download the MTCNN face detector into models/facedetect/mtcnn. Local only."""
        if not is_local_request(request.remote, request.headers):
            return error("The face detector can only be installed from the machine running ComfyUI.", 403)
        try:
            out = await asyncio.get_running_loop().run_in_executor(
                None, lambda: install_face_detector(face_detector_folder()))
        except Exception as err:
            return error(f"Couldn't download the face detector: {err}", 500)
        return web.json_response(out)

    _face_scans = {}          # (path, mtime, size) -> result

    @routes.post("/longshot/faces/{slug}")
    async def scan_faces_route(request):
        """{keys: [clip key]}: the faces in each take's clip, {key: {h, w, faces} | null}."""
        import folder_paths
        slug, body = slug_of(request), await body_of(request)
        if not slug or body is None or not isinstance(body.get("keys"), list):
            return error("Send {keys}.")
        mod = faces_module()
        if mod is None:
            return error("Face refine needs H3 Long Shot 1.8.0 or later.", 404)
        folder = face_detector_folder()
        if not mod.weights_present(folder):
            return error("The face detector isn't installed.", 409)
        clips_dir = pj.clips_folder(folder_paths.get_output_directory(), slug)

        def work():
            out = {}
            for key in [str(k) for k in body["keys"][:64]]:
                if not pj.CLIP_KEY_RE.fullmatch(key):
                    continue
                path = os.path.join(clips_dir, key + ".mp4")
                try:
                    st = os.stat(path)
                except OSError:
                    out[key] = None
                    continue
                sig = (path, st.st_mtime_ns, st.st_size)
                if sig not in _face_scans:
                    try:
                        _face_scans[sig] = scan_faces(path, mod, folder)
                    except Exception as err:
                        logger.warning("H3 Long Shot Studio: couldn't look for faces in %s: %s", key, err)
                        _face_scans[sig] = None
                out[key] = _face_scans[sig]
            return out
        res = await asyncio.get_running_loop().run_in_executor(None, work)
        return web.json_response(res, headers=no_cache)

    @routes.post("/longshot/phrases")
    async def phrases_route(request):
        """{file, subfolder, min_gap, sensitivity}: suggested phrase starts in the song (0.11.0)."""
        try:
            body = await request.json()
        except ValueError:
            body = {}
        import folder_paths
        try:
            path = pj.resolve_input(folder_paths.get_input_directory(), body.get("file"), body.get("subfolder", ""))
        except (ValueError, TypeError) as err:
            return error(err)
        if not os.path.isfile(path):
            return error("The song file is missing.", 404)
        ff = _ffmpeg_path()
        if not ff:
            return error("ffmpeg isn't available.", 500)
        try:
            gap = float(body.get("min_gap", 0.5))
            sens = float(body.get("sensitivity", 0.5))
            found = await asyncio.get_running_loop().run_in_executor(
                None, lambda: audio_sync.detect_phrases(path, ff, min_gap=gap, sensitivity=sens))
        except Exception as err:
            return error(f"Couldn't read the song: {err}", 500)
        return web.json_response({"phrases": found})

    _preview_locks = {}

    @routes.get("/longshot/song-preview")
    async def song_preview(request):
        """?file=&subfolder=: the song for playback in the Studio (0.12.6): a WAV as is,
        anything else (mp3, m4a…) as a WAV copy made once in ComfyUI's temp folder, so
        jumping to a point in it is exact."""
        import folder_paths
        try:
            path = pj.resolve_input(folder_paths.get_input_directory(), request.query.get("file"),
                                    request.query.get("subfolder", ""))
        except (ValueError, TypeError) as err:
            return error(err)
        if not os.path.isfile(path):
            return error("The song file is missing.", 404)
        if not audio_sync.needs_preview(path):
            return web.FileResponse(path, headers={"Cache-Control": "no-cache"})
        ff = _ffmpeg_path()
        if not ff:                                   # no ffmpeg: the file itself
            return web.FileResponse(path, headers={"Cache-Control": "no-cache"})
        folder = os.path.join(folder_paths.get_temp_directory(), "longshot_song_preview")
        key = audio_sync.preview_name(path)
        lock = _preview_locks.setdefault(key, asyncio.Lock())
        async with lock:
            try:
                out = await asyncio.get_running_loop().run_in_executor(
                    None, lambda: audio_sync.make_preview(path, ff, folder))
            except Exception as err:
                return error(f"Couldn't prepare the song for playback: {err}", 500)
        return web.FileResponse(out, headers={"Content-Type": "audio/wav", "Cache-Control": "no-cache"})

    @routes.post("/longshot/align")
    async def align_route(request):
        """{audio: {filename, subfolder}, song: {file, subfolder}, at, seconds}: how far a take's
        own audio (in output/) is from the song where it sits (0.11.0). {offset, confidence}:
        offset > 0, the take sings early by that many seconds."""
        try:
            body = await request.json()
        except ValueError:
            body = {}
        import folder_paths
        try:
            a = body.get("audio") or {}
            tpath = pj.resolve_input(folder_paths.get_output_directory(), a.get("filename"), a.get("subfolder", ""))
            song = body.get("song") or {}
            spath = pj.resolve_input(folder_paths.get_input_directory(), song.get("file"), song.get("subfolder", ""))
            at, secs = float(body.get("at", 0)), float(body.get("seconds", 0))
        except (ValueError, TypeError, AttributeError) as err:
            return error(err)
        if not os.path.isfile(tpath) or not os.path.isfile(spath):
            return error("The take's audio or the song is missing.", 404)
        ff = _ffmpeg_path()
        if not ff:
            return error("ffmpeg isn't available.", 500)

        def measure():
            take = audio_sync.read_audio(tpath, ff)
            lead = min(3.0, max(0.0, at))
            sa = audio_sync.read_audio(spath, ff, start=at - lead, duration=secs + lead + 3.0)
            return audio_sync.find_offset(take, sa, lead)
        try:
            off, conf = await asyncio.get_running_loop().run_in_executor(None, measure)
        except Exception as err:
            return error(f"Couldn't compare the audio: {err}", 500)
        try:
            os.remove(tpath)                    # a scratch file
        except OSError:
            pass
        return web.json_response({"offset": off, "confidence": conf})

    @routes.post("/longshot/layout")
    async def layout_route(request):
        """{overlap, pieces: [{id, seconds, window}]}: every Shot's place on the film."""
        try:
            body = await request.json()
        except ValueError:
            body = {}
        pieces = body.get("pieces")
        if not isinstance(pieces, list) or not pieces:
            return error("Send {overlap, pieces}.")
        try:
            return web.json_response(film_layout(pieces[:1000], body.get("overlap", 22)))
        except LookupError as err:
            return error(str(err), 409)
        except (ValueError, TypeError) as err:
            return error(err)

    @routes.post("/longshot/live-preview")
    async def live_preview_route(request):
        """{client_id, method}: this tab's live-preview switch ("taesd" | "latent2rgb" |
        "none"). It only changes that tab's own previews, so any device may set it."""
        try:
            body = await request.json()
        except ValueError:
            body = {}
        cid = str(body.get("client_id") or "")
        if not cid:
            return error("Send {client_id, method}.")
        try:
            method = set_live_preview(cid, body.get("method"))
        except LookupError as err:
            return error(str(err), 409)
        except ValueError as err:
            return error(err)
        return web.json_response({"client_id": cid, "method": method})

    @routes.post("/longshot/keep-awake")
    async def keep_awake(request):
        """{on}: the browser's queue has work (a heartbeat every ~30 s)."""
        try:
            body = await request.json()
        except ValueError:
            body = {}
        return web.json_response(KEEP_AWAKE.beat(bool(body.get("on"))))

    @routes.post("/longshot/restart")
    async def restart(request):
        """Restart ComfyUI. Allowed from any device that can reach ComfyUI (it
        changes nothing on disk); the page asks first. The reply goes out
        before the process is replaced."""
        import asyncio
        try:
            from server import PromptServer
            PromptServer.instance.send_sync("mmh3.studio", {"restarting": True})
        except Exception:
            pass
        asyncio.get_running_loop().call_later(0.6, restart_comfyui)
        return web.json_response({"restarting": True})

    try:
        register_video_formats()
    except Exception as err:
        logger.warning("H3 Long Shot Studio: couldn't add its video formats: %s", err)
    try:
        apply_model_folders()
    except Exception as err:      # a broken settings file mustn't stop the page
        logger.warning("H3 Long Shot Studio: couldn't add saved model folders: %s", err)
    logger.info("H3 Long Shot Studio %s at /longshot", VERSION)
    return True
