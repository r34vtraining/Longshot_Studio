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
    GET  /longshot/segments/<slug> saved segments: files, bytes
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
    """Model names saved on one OS ('H3\\x' on Windows) still match on another
    ('H3/x'). Only rewrites a name that isn't listed but has a listed twin."""
    def fix(value, kind):
        names = lists.get(kind) or []
        if not value or value in names:
            return value
        return next((n for n in names if _same_file(n, value)), value)

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
        """Multipart: project=<slug>, file=<image>. Saved to input/longshot/<slug>/."""
        import folder_paths
        try:
            form = await request.post()
        except Exception as err:        # e.g. over ComfyUI's --max-upload-size
            return error(f"Upload failed: {err}", 413 if "large" in str(err).lower() else 400)
        slug, f = str(form.get("project") or ""), form.get("file")
        if not pj.is_slug(slug) or not project_store().exists(slug):
            return error("No such project.", 404)
        if f is None or not hasattr(f, "file"):
            return error("Send the image as 'file'.")
        data = f.file.read()
        try:
            saved = await asyncio.get_running_loop().run_in_executor(
                None, pj.store_upload, folder_paths.get_input_directory(), slug, f.filename, data)
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

    @routes.get("/longshot/segments/{slug}")
    async def segments(request):
        import folder_paths
        slug = slug_of(request)
        if not slug:
            return error("Not a project slug.", 400)
        return web.json_response(pj.segment_stats(folder_paths.get_output_directory(), slug))

    @routes.post("/longshot/clear-segments")
    async def clear_segments(request):
        import folder_paths
        if not local(request):
            return error("Saved segments can only be cleared from the machine running ComfyUI.", 403)
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

    logger.info("H3 Long Shot Studio %s at /longshot", VERSION)
    return True
