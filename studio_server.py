"""HTTP routes for H3 Long Shot Studio, served by ComfyUI itself.

    GET  /longshot                 the page
    GET  /longshot/static/<file>   its JS / CSS
    GET  /longshot/capabilities    {"local": bool} — may this browser open folders?
    GET  /longshot/options         model / LoRA / VAE / CLIP / file lists, sizes, node status
    POST /longshot/build           {project, upto, dry_run} -> API prompt (graph_builder)
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
    POST /longshot/open-folder     {"which": "output"|"input", "select", "project"} (loopback only)
    POST /longshot/restart         restart ComfyUI (relaunches itself, like ComfyUI-Manager)

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


def folder_for(which, output_dir, input_dir, project=None):
    """The only folders open-folder may open. Never a path from the browser:
    the project slug only picks input/longshot/<slug> when that folder exists."""
    if which == "output":
        return os.path.join(output_dir, gb.OUTPUT_SUBFOLDER)
    if which == "input":
        if pj.is_slug(project):
            sub = os.path.join(input_dir, "longshot", project)
            if os.path.isdir(sub):
                return sub
        return input_dir
    raise ValueError("which must be 'output' or 'input'")


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


def current_env():
    return gb.Env(classes=set(_node_classes()), video_formats=video_formats())


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


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

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
        try:
            built = gb.build_prompt(project, upto=body.get("upto"),
                                    dry_run=bool(body.get("dry_run")), env=current_env(),
                                    final=bool(body.get("final")))
        except gb.BuildError as err:
            return error(err)
        return web.json_response(built.as_dict())

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
        return web.json_response(project_store().list())

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
        if (segments or inputs) and not local(request):
            return error("Files can only be deleted from the machine running ComfyUI.", 403)
        out = {"project": project_store().delete(slug)}
        if segments:
            out["segments"] = pj.clear_segments(folder_paths.get_output_directory(), slug)
        if inputs:
            out["inputs"] = pj.delete_inputs(folder_paths.get_input_directory(), slug)
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
            folder = folder_for(body.get("which"), folder_paths.get_output_directory(),
                                folder_paths.get_input_directory(), body.get("project"))
        except ValueError as err:
            return error(err)
        os.makedirs(folder, exist_ok=True)
        select = selectable(folder, body.get("select"))
        try:
            launch(open_command(folder, select))
        except Exception as err:
            return error(f"Couldn't open the folder: {err}", 500)
        return web.json_response({"opened": folder, "selected": bool(select)})

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
        apply_model_folders()
    except Exception as err:      # a broken settings file mustn't stop the page
        logger.warning("H3 Long Shot Studio: couldn't add saved model folders: %s", err)
    logger.info("H3 Long Shot Studio %s at /longshot", VERSION)
    return True
