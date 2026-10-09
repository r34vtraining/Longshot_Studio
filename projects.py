"""Projects on disk and reference checks. Pure Python, no ComfyUI.

Projects are JSON files named by slug:
    <ComfyUI user dir>/default/longshot-studio/projects/<slug>.json
The slug is fixed when a project is created; renaming changes only the
display name, so saved segments (output/longshot/<slug>/segments) and the
input subfolder (input/longshot/<slug>) keep matching.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import tempfile
import time

SLUG_RE = re.compile(r"[a-z0-9]+(?:-[a-z0-9]+)*")
STUDIO_VERSION = "0.5.0"
AUDIO_EXTENSIONS = {"mp3", "wav", "flac", "ogg", "m4a", "aac", "opus", "wma"}
IMAGE_EXTENSIONS = {"png", "jpg", "jpeg", "webp", "bmp", "gif", "tif", "tiff"}
VIDEO_EXTENSIONS = {"mp4", "mov", "webm", "mkv", "m4v", "avi"}


class Conflict(Exception):
    """The project file changed since this client loaded it."""

    def __init__(self, current):
        super().__init__("changed elsewhere")
        self.current = current


# ---------------------------------------------------------------------------
# Slugs
# ---------------------------------------------------------------------------

def slugify(name) -> str:
    """Lower-case, runs of anything else -> '-'. Names with no Latin letters or
    digits (e.g. Chinese) get 'project-<hash>' so they still have a stable slug."""
    s = re.sub(r"[^a-z0-9]+", "-", str(name or "").lower()).strip("-")[:60].strip("-")
    if not s:
        s = "project-" + hashlib.sha1(str(name or "").encode("utf-8")).hexdigest()[:6]
    return s


def is_slug(s) -> bool:
    return isinstance(s, str) and len(s) <= 80 and SLUG_RE.fullmatch(s) is not None


def now_iso() -> str:
    t = time.time_ns()
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(t / 1e9)) + f".{t // 1000 % 1000000:06d}"


# ---------------------------------------------------------------------------
# Project files
# ---------------------------------------------------------------------------

class ProjectStore:
    def __init__(self, folder):
        self.folder = folder

    def path(self, slug):
        if not is_slug(slug):
            raise ValueError(f"not a project slug: {slug!r}")
        return os.path.join(self.folder, slug + ".json")

    def exists(self, slug):
        return is_slug(slug) and os.path.isfile(self.path(slug))

    def load(self, slug):
        with open(self.path(slug), encoding="utf-8") as fh:
            project = json.load(fh)
        project["slug"] = slug
        return project

    def list(self):
        out = []
        if not os.path.isdir(self.folder):
            return out
        for f in os.listdir(self.folder):
            slug = f[:-5]
            if not f.endswith(".json") or not is_slug(slug):
                continue
            try:
                p = self.load(slug)
            except (OSError, ValueError):
                continue
            lo = p.get("last_output") or {}
            out.append({"slug": slug, "name": p.get("name") or slug,
                        "saved_at": p.get("saved_at") or "",
                        "video": lo.get("video"),
                        "shots": len([s for s in p.get("shots") or [] if not s.get("bypassed")]),
                        "approved": len([s for s in p.get("shots") or []
                                         if s.get("status") == "approved" and not s.get("bypassed")])})
        out.sort(key=lambda p: p["saved_at"], reverse=True)
        return out

    def unique_slug(self, name):
        base = slugify(name)
        slug, n = base, 2
        while self.exists(slug):
            slug, n = f"{base}-{n}", n + 1
        return slug

    def save(self, slug, project, base=None, force=False):
        """Write atomically. With `base` (the saved_at the client loaded), refuse
        when the file changed since, unless forced. Returns the new saved_at."""
        os.makedirs(self.folder, exist_ok=True)
        path = self.path(slug)
        if base is not None and not force and os.path.isfile(path):
            try:
                current = self.load(slug)
            except (OSError, ValueError):
                current = None
            if current is not None and (current.get("saved_at") or "") != base:
                raise Conflict({"saved_at": current.get("saved_at"), "name": current.get("name")})
        previous = None
        if os.path.isfile(path):
            try:
                with open(path, encoding="utf-8") as fh:
                    previous = json.load(fh).get("saved_at")
            except (OSError, ValueError):
                pass
        stamp = now_iso()
        while stamp == previous:          # every save gets a new version stamp
            time.sleep(0.000002)
            stamp = now_iso()
        project = dict(project)
        project.update(slug=slug, saved_at=stamp, studio_version=STUDIO_VERSION)
        project.setdefault("version", 1)
        fd, tmp = tempfile.mkstemp(dir=self.folder, suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                json.dump(project, fh, ensure_ascii=False, indent=2)
            os.replace(tmp, path)
        except BaseException:
            if os.path.exists(tmp):
                os.remove(tmp)
            raise
        return project["saved_at"]

    def create(self, name, project=None):
        slug = self.unique_slug(name)
        project = dict(project or {})
        project["name"] = name
        return slug, self.save(slug, project)

    def delete(self, slug):
        path = self.path(slug)
        if os.path.isfile(path):
            os.remove(path)
            return True
        return False


def migrate(old_folder, store):
    """Early test builds kept projects as <user>/h3_longshot_studio/<name>.json. Move them
    in once, giving each a slug; the old folder is renamed, never deleted."""
    if not os.path.isdir(old_folder):
        return 0
    n = 0
    for f in sorted(os.listdir(old_folder)):
        if not f.endswith(".json"):
            continue
        try:
            with open(os.path.join(old_folder, f), encoding="utf-8") as fh:
                project = json.load(fh)
        except (OSError, ValueError):
            continue
        name = project.get("name") or f[:-5]
        slug = slugify(name)
        if store.exists(slug):
            continue
        store.save(slug, project)
        n += 1
    try:
        os.replace(old_folder, old_folder + ".migrated")
    except OSError:
        pass
    return n


# ---------------------------------------------------------------------------
# Input files
# ---------------------------------------------------------------------------

def _clean_subfolder(subfolder) -> str:
    sub = str(subfolder or "").replace("\\", "/").strip("/")
    if not sub:
        return ""
    parts = sub.split("/")
    if os.path.isabs(subfolder) or any(p in ("", ".", "..") or ":" in p for p in parts):
        raise ValueError(f"bad subfolder {subfolder!r}")
    return "/".join(parts)


def resolve_input(input_dir, name, subfolder=""):
    """Full path of input/<subfolder>/<name>. Only bare file names inside the
    input folder; anything with .., an absolute path or a separator is refused."""
    if not isinstance(name, str) or not name or name in (".", "..") \
            or "/" in name or "\\" in name or ":" in name or "\0" in name:
        raise ValueError(f"bad file name {name!r}")
    sub = _clean_subfolder(subfolder)
    path = os.path.join(input_dir, *(sub.split("/") if sub else []), name)
    root = os.path.realpath(input_dir)
    if not os.path.realpath(path).startswith(root + os.sep):
        raise ValueError("outside the input folder")
    return path


def input_path_value(name, subfolder=""):
    """What LoadImage / VHS Load Audio take: 'sub/folder/name.png'."""
    if not isinstance(name, str) or not name or name in (".", "..") \
            or "/" in name or "\\" in name or "\0" in name:
        raise ValueError(f"bad file name {name!r}")
    sub = _clean_subfolder(subfolder)
    return f"{sub}/{name}" if sub else name


_HASHES = {}   # (path, size, mtime_ns) -> sha256


def file_sha256(path):
    st = os.stat(path)
    key = (os.path.realpath(path), st.st_size, st.st_mtime_ns)
    if key not in _HASHES:
        h = hashlib.sha256()
        with open(path, "rb") as fh:
            for chunk in iter(lambda: fh.read(1 << 20), b""):
                h.update(chunk)
        _HASHES[key] = h.hexdigest()
    return _HASHES[key]


def check_file(input_dir, entry):
    """{'state': ok | changed | missing | invalid, 'size_bytes', 'sha256'} for one
    saved reference. A file with no stored hash yet is ok, and gets one."""
    try:
        path = resolve_input(input_dir, entry.get("name"), entry.get("subfolder"))
    except ValueError as err:
        return {"state": "invalid", "error": str(err)}
    if not os.path.isfile(path):
        return {"state": "missing"}
    size, sha = os.path.getsize(path), file_sha256(path)
    want = entry.get("sha256")
    state = "ok" if not want or want == sha else "changed"
    return {"state": state, "size_bytes": size, "sha256": sha}


def list_inputs(input_dir, subfolder=""):
    """Image and audio files directly inside input/<subfolder>."""
    sub = _clean_subfolder(subfolder)
    folder = os.path.join(input_dir, *(sub.split("/") if sub else []))
    out = {"subfolder": sub, "images": [], "audio": [], "videos": []}
    if not os.path.isdir(folder):
        return out
    for f in sorted(os.listdir(folder), key=str.lower):
        if not os.path.isfile(os.path.join(folder, f)) or "." not in f:
            continue
        ext = f.rsplit(".", 1)[-1].lower()
        if ext in IMAGE_EXTENSIONS:
            out["images"].append(f)
        elif ext in AUDIO_EXTENSIONS:
            out["audio"].append(f)
        elif ext in VIDEO_EXTENSIONS:
            out["videos"].append(f)
    return out


def project_input_subfolder(slug):
    return f"longshot/{slug}"


_UNSAFE_NAME = re.compile(r'[\x00-\x1f<>:"/\\|?*]+')
MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024     # ComfyUI's --max-upload-size usually caps it first


def clean_upload_name(filename, kinds=("images",)) -> str:
    """A browser's file name, made safe for input/longshot/<slug>/. Only the
    extensions the Studio can use are taken."""
    name = os.path.basename(str(filename or "").replace("\\", "/"))
    name = _UNSAFE_NAME.sub("_", name).strip()
    if "." not in name:
        raise ValueError("The file has no extension.")
    stem, ext = name.rsplit(".", 1)
    ext = ext.lower()
    allowed = set()
    if "images" in kinds:
        allowed |= IMAGE_EXTENSIONS
    if "audio" in kinds:
        allowed |= AUDIO_EXTENSIONS
    if "video" in kinds:
        allowed |= VIDEO_EXTENSIONS
    if ext not in allowed:
        raise ValueError(f".{ext} files can't be used here. Use one of: "
                         + ", ".join(sorted(allowed)) + ".")
    stem = stem.strip(" .")[:120] or "upload"
    return f"{stem}.{ext}"


def _check_image(data: bytes):
    try:
        from PIL import Image
    except ImportError:          # no Pillow: LoadImage will say if it can't read it
        return
    import io
    try:
        with Image.open(io.BytesIO(data)) as im:
            im.verify()
    except Exception:
        raise ValueError("That file isn't a readable image.") from None


def store_upload(input_dir, slug, filename, data: bytes, kind="images"):
    """Save a dropped file to input/longshot/<slug>/.

    The same bytes are never stored twice: a file already in the folder with
    the same content is reused (so a reference keeps its hash and nothing
    re-renders). A different file with the same name gets ' (2)', ' (3)'…
    Returns {name, subfolder, sha256, size_bytes, reused}."""
    if not is_slug(slug):
        raise ValueError("Not a project slug.")
    if not data:
        raise ValueError("The file is empty.")
    if len(data) > MAX_UPLOAD_BYTES:
        raise ValueError(f"The file is over {MAX_UPLOAD_BYTES // (1024 * 1024)} MB.")
    name = clean_upload_name(filename, (kind,))
    if kind == "images":
        _check_image(data)
    sub = project_input_subfolder(slug)
    folder = os.path.join(input_dir, *sub.split("/"))
    os.makedirs(folder, exist_ok=True)
    sha = hashlib.sha256(data).hexdigest()
    out = {"subfolder": sub, "sha256": sha, "size_bytes": len(data)}

    if kind not in ("images", "audio", "video"):
        raise ValueError("kind must be images, audio or video")
    exts = {"images": IMAGE_EXTENSIONS, "audio": AUDIO_EXTENSIONS, "video": VIDEO_EXTENSIONS}[kind]
    same_name = os.path.join(folder, name)
    candidates = [name] + sorted(f for f in os.listdir(folder) if f != name)
    for f in candidates:
        path = os.path.join(folder, f)
        if (os.path.isfile(path) and "." in f and f.rsplit(".", 1)[1].lower() in exts
                and os.path.getsize(path) == len(data) and file_sha256(path) == sha):
            return dict(out, name=f, reused=True)

    stem, ext = name.rsplit(".", 1)
    target, n = same_name, 2
    while os.path.exists(target):
        target = os.path.join(folder, f"{stem} ({n}).{ext}")
        n += 1
    fd, tmp = tempfile.mkstemp(dir=folder, prefix=".upload-", suffix=".tmp")
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(data)
        os.replace(tmp, target)
    except BaseException:
        if os.path.exists(tmp):
            os.remove(tmp)
        raise
    return dict(out, name=os.path.basename(target), reused=False)


def segments_folder(output_dir, slug):
    return os.path.join(output_dir, "longshot", slug, "segments")


def takes_folder(output_dir, slug):
    return os.path.join(output_dir, "longshot", slug, "takes")


TAKE_NAME_RE = re.compile(r"[A-Za-z0-9_-]{1,64}__\d{1,20}__[0-9a-f]{8}\.safetensors")
_TAKE_INTS = ("window_frames", "overlap", "width", "height", "seed", "head_audio", "tail_audio")


def safetensors_metadata(path):
    """The __metadata__ of a .safetensors file, read from its header only."""
    import struct
    with open(path, "rb") as fh:
        head = fh.read(8)
        if len(head) != 8:
            raise ValueError("not a safetensors file")
        (n,) = struct.unpack("<Q", head)
        if n > 16 * 1024 * 1024:
            raise ValueError("header too large")
        header = json.loads(fh.read(n).decode("utf-8"))
    meta = header.get("__metadata__") or {}
    return meta if isinstance(meta, dict) else {}


def take_info(output_dir, slug, name):
    """One take's metadata, or None."""
    if not is_slug(slug) or not TAKE_NAME_RE.fullmatch(name or ""):
        return None
    path = os.path.join(takes_folder(output_dir, slug), name)
    if not os.path.isfile(path):
        return None
    try:
        raw = safetensors_metadata(path)
    except (OSError, ValueError):
        return None
    out = {"name": name, "bytes": os.path.getsize(path), "created": raw.get("created", ""),
           "shot_id": raw.get("shot_id", name.split("__")[0]),
           "seconds": float(raw["seconds"]) if raw.get("seconds") else None}
    for k in _TAKE_INTS:
        try:
            out[k] = int(raw[k]) if raw.get(k, "") != "" else None
        except ValueError:
            out[k] = None
    return out


def list_takes(output_dir, slug, shot_id=None):
    """Takes of a project (or of one Shot), oldest first."""
    folder = takes_folder(output_dir, slug)
    if not is_slug(slug) or not os.path.isdir(folder):
        return []
    want = None
    if shot_id is not None:
        want = re.sub(r"[^A-Za-z0-9_-]+", "_", str(shot_id)).strip("_")[:64] or "shot"
    out = []
    for f in os.listdir(folder):
        # <id>__<seed>__<fp8>.safetensors; ids may contain "__", so split from the right
        if TAKE_NAME_RE.fullmatch(f) and (want is None or f.rsplit("__", 2)[0] == want):
            info = take_info(output_dir, slug, f)
            if info:
                out.append(info)
    out.sort(key=lambda t: (t["created"], t["name"]))
    return out


def delete_take(output_dir, slug, name):
    if not is_slug(slug) or not TAKE_NAME_RE.fullmatch(name or ""):
        raise ValueError("not a take")
    path = os.path.join(takes_folder(output_dir, slug), name)
    if os.path.isfile(path):
        os.remove(path)
        return True
    return False


def segment_stats(output_dir, slug):
    """Saved takes plus any saved segments left from earlier versions."""
    files = n_bytes = 0
    for folder in (takes_folder(output_dir, slug), segments_folder(output_dir, slug)):
        if not os.path.isdir(folder):
            continue
        for f in os.listdir(folder):
            if f.endswith(".safetensors"):
                files += 1
                n_bytes += os.path.getsize(os.path.join(folder, f))
    return {"files": files, "bytes": n_bytes}


def clear_segments(output_dir, slug):
    """Delete this project's takes and saved segments: only *.safetensors (and
    leftover .tmp) files directly inside its takes and segments folders."""
    n = 0
    for folder in (takes_folder(output_dir, slug), segments_folder(output_dir, slug)):
        if not os.path.isdir(folder):
            continue
        for f in os.listdir(folder):
            p = os.path.join(folder, f)
            if os.path.isfile(p) and (f.endswith(".safetensors") or f.endswith(".safetensors.tmp")):
                os.remove(p)
                n += 1
    return n


def delete_inputs(input_dir, slug):
    """Delete this project's own input subfolder (input/longshot/<slug>)."""
    folder = os.path.join(input_dir, "longshot", slug)
    if is_slug(slug) and os.path.isdir(folder):
        shutil.rmtree(folder)
        return True
    return False


# ---------------------------------------------------------------------------
# Model folders the Studio adds to ComfyUI (for models kept outside its
# models/ tree). Saved as {"diffusion_models": ["D:/AI/models", ...], ...}.
# ---------------------------------------------------------------------------

MODEL_KINDS = ("diffusion_models", "text_encoders", "vae", "loras")
MODEL_EXTENSIONS = (".safetensors", ".sft", ".ckpt", ".pt", ".pt2", ".pth", ".bin", ".gguf")


def load_model_folders(path):
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        return {}
    out = {}
    for kind in MODEL_KINDS:
        folders = data.get(kind) if isinstance(data, dict) else None
        if isinstance(folders, list):
            out[kind] = [str(f) for f in folders if isinstance(f, str) and f.strip()]
    return out


def save_model_folders(path, folders):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    clean = {k: list(dict.fromkeys(v)) for k, v in folders.items() if k in MODEL_KINDS and v}
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), suffix=".tmp")
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        json.dump(clean, fh, indent=2)
    os.replace(tmp, path)


def match_model_name(value, names):
    """The listed name for a saved model name: the same name, the same name
    with the other OS's separators, or failing that the one listed file with
    the same file name (models kept in a different subfolder on this machine).
    None when there's no match or more than one candidate."""
    if not value:
        return None
    if value in names:
        return value
    norm = value.replace("\\", "/")
    for n in names:
        if n.replace("\\", "/") == norm:
            return n
    base = norm.rsplit("/", 1)[-1].lower()
    hits = [n for n in names if n.replace("\\", "/").rsplit("/", 1)[-1].lower() == base]
    return hits[0] if len(hits) == 1 else None


def browse_dir(path):
    """Folders (and model files) in one folder of this machine, for picking a
    model folder. path '' lists the drives (Windows) or '/'."""
    if not path:
        if os.name == "nt":
            import string
            roots = [f"{d}:\\" for d in string.ascii_uppercase if os.path.isdir(f"{d}:\\")]
        else:
            roots = ["/"]
        return {"path": "", "parent": None, "dirs": roots, "models": 0, "roots": roots}
    path = os.path.abspath(os.path.expanduser(path))
    if not os.path.isdir(path):
        raise ValueError(f"Not a folder: {path}")
    dirs, models = [], 0
    try:
        entries = sorted(os.scandir(path), key=lambda e: e.name.lower())
    except OSError as err:
        raise ValueError(f"Can't open {path}: {err.strerror or err}") from None
    for e in entries:
        try:
            if e.name.startswith(".") or e.name.startswith("$"):
                continue
            if e.is_dir():
                dirs.append(e.name)
            elif e.name.lower().endswith(MODEL_EXTENSIONS):
                models += 1
        except OSError:
            continue
    parent = os.path.dirname(path.rstrip("\\/")) or None
    if parent == path:
        parent = None
    return {"path": path, "parent": parent if parent != path else None, "dirs": dirs,
            "models": models}


# ---------------------------------------------------------------------------
# Renaming a project moves its folders
# ---------------------------------------------------------------------------

def _project_dirs(input_dir, output_dir, slug):
    return [os.path.join(input_dir, "longshot", slug), os.path.join(output_dir, "longshot", slug)]


def rename_project(store, input_dir, output_dir, slug, name, base=None):
    """Rename a project and give it the slug of its new name: its input folder
    (input/longshot/<slug>) and its takes folder (output/longshot/<slug>) move,
    and every reference in those folders is updated. Takes keep their names,
    so nothing re-renders. Returns (new_slug, saved_at)."""
    name = str(name or "").strip()
    if not name:
        raise ValueError("Give the project a name.")
    project = store.load(slug)
    if base is not None and (project.get("saved_at") or "") != base:
        raise Conflict({"saved_at": project.get("saved_at"), "name": project.get("name")})
    want = slugify(name)
    if want == slug:                       # same folder name: just the display name
        project["name"] = name
        return slug, store.save(slug, project, force=True)
    new, n = want, 2
    while store.exists(new) or any(os.path.exists(d) for d in _project_dirs(input_dir, output_dir, new)):
        new, n = f"{want}-{n}", n + 1
    moved = []
    try:
        for src, dst in zip(_project_dirs(input_dir, output_dir, slug),
                            _project_dirs(input_dir, output_dir, new)):
            if os.path.isdir(src):
                os.makedirs(os.path.dirname(dst), exist_ok=True)
                shutil.move(src, dst)
                moved.append((src, dst))
    except OSError as err:
        for src, dst in reversed(moved):           # put back what already moved
            try:
                shutil.move(dst, src)
            except OSError:
                pass
        raise ValueError(f"Couldn't move the project's folder: {err.strerror or err}. "
                         f"Close anything that has files in it open and try again.") from None
    old_sub, new_sub = project_input_subfolder(slug), project_input_subfolder(new)
    for c in project.get("cast") or []:
        if (c.get("subfolder") or "").replace("\\", "/").strip("/") == old_sub:
            c["subfolder"] = new_sub
    audio = project.get("audio") or {}
    if (audio.get("subfolder") or "").replace("\\", "/").strip("/") == old_sub:
        audio["subfolder"] = new_sub
    for sh in project.get("shots") or []:
        clip = sh.get("clip")
        if isinstance(clip, dict) and (clip.get("subfolder") or "").replace("\\", "/").strip("/") == old_sub:
            clip["subfolder"] = new_sub
    project["name"] = name
    saved_at = store.save(new, project, force=True)
    store.delete(slug)
    return new, saved_at


# ---------------------------------------------------------------------------
# Finding missing references again
# ---------------------------------------------------------------------------

def find_inputs(input_dir, slug, entries):
    """For each missing reference {key, name, sha256}: a file in the project's
    input folder (then the input folder itself) with the same contents (any
    name), or failing that one with the same file name.
    Returns [{key, name, subfolder, sha256, size_bytes, match: "same" | "name"}]."""
    folders = [project_input_subfolder(slug), ""] if is_slug(slug) else [""]
    files = []
    for sub in folders:
        folder = os.path.join(input_dir, *(sub.split("/") if sub else []))
        if not os.path.isdir(folder):
            continue
        for f in sorted(os.listdir(folder)):
            p = os.path.join(folder, f)
            if os.path.isfile(p) and "." in f and f.rsplit(".", 1)[1].lower() in \
                    (IMAGE_EXTENSIONS | AUDIO_EXTENSIONS | VIDEO_EXTENSIONS):
                files.append((sub, f, p))
    out = []
    for e in entries or []:
        if not isinstance(e, dict):
            continue
        want_sha, want_name = e.get("sha256"), str(e.get("name") or "")
        hit = None
        if want_sha:
            for sub, f, p in files:
                if file_sha256(p) == want_sha:
                    hit = (sub, f, p, "same")
                    break
        if hit is None and want_name:
            for sub, f, p in files:
                if f.lower() == want_name.lower():
                    hit = (sub, f, p, "same" if not want_sha else "name")
                    break
        if hit:
            sub, f, p, kind = hit
            out.append({"key": e.get("key"), "name": f, "subfolder": sub, "match": kind,
                        "sha256": file_sha256(p), "size_bytes": os.path.getsize(p)})
    return out


# ---------------------------------------------------------------------------
# Export / import: one .zip with the project and everything it uses
# ---------------------------------------------------------------------------

EXPORT_FORMAT = 1


def _refs(project):
    """(key, item, name field) for every file the project refers to."""
    out = []
    for c in project.get("cast") or []:
        if c.get("image"):
            out.append((f"cast:{c.get('id')}", c, "image"))
    a = project.get("audio") or {}
    if a.get("file"):
        out.append(("audio", a, "file"))
    for sh in project.get("shots") or []:
        clip = sh.get("clip")
        if isinstance(clip, dict) and clip.get("file"):
            out.append((f"clip:{sh.get('id')}", clip, "file"))
    return out


def _take_files(folder):
    if not os.path.isdir(folder):
        return []
    return sorted(f for f in os.listdir(folder) if TAKE_NAME_RE.fullmatch(f))


def export_estimate(input_dir, output_dir, slug, project):
    refs = 0
    for _key, item, field in _refs(project):
        try:
            refs += os.path.getsize(resolve_input(input_dir, item[field], item.get("subfolder")))
        except (ValueError, OSError):
            pass
    folder = takes_folder(output_dir, slug)
    takes = sum(os.path.getsize(os.path.join(folder, n)) for n in _take_files(folder))
    video = 0
    lo = (project.get("last_output") or {}).get("video") or {}
    if lo.get("filename"):
        p = os.path.join(output_dir, lo.get("subfolder") or "", lo["filename"])
        video = os.path.getsize(p) if os.path.isfile(p) else 0
    return {"references": refs, "takes": takes, "video": video}


def export_project(input_dir, output_dir, project, dest, takes=True, video=False):
    """Write the project, its reference files, and optionally its takes and
    last video into the zip at `dest`. Missing files are listed, not fatal."""
    import zipfile
    slug = project.get("slug") or slugify(project.get("name"))
    manifest = {"format": EXPORT_FORMAT, "studio_version": STUDIO_VERSION, "slug": slug,
                "name": project.get("name"), "files": [], "missing": [], "takes": [],
                "video": None}
    stored = {}                   # sha/name -> path in zip, so a file goes in once
    with zipfile.ZipFile(dest, "w", zipfile.ZIP_STORED, allowZip64=True) as z:
        for key, item, field in _refs(project):
            try:
                src = resolve_input(input_dir, item[field], item.get("subfolder"))
            except ValueError:
                src = None
            if not src or not os.path.isfile(src):
                manifest["missing"].append({"key": key, "name": item[field]})
                continue
            ident = file_sha256(src)
            arc = stored.get(ident)
            if arc is None:
                base, n = item[field], 2
                arc = "inputs/" + base
                while arc in stored.values():
                    stem, ext = base.rsplit(".", 1) if "." in base else (base, "")
                    arc = f"inputs/{stem} ({n})" + (f".{ext}" if ext else "")
                    n += 1
                z.write(src, arc)
                stored[ident] = arc
            manifest["files"].append({"key": key, "path": arc, "sha256": ident})
        if takes:
            folder = takes_folder(output_dir, slug)
            for name in _take_files(folder):
                z.write(os.path.join(folder, name), "takes/" + name)
                manifest["takes"].append(name)
        lo = (project.get("last_output") or {}).get("video") or {}
        if video and lo.get("filename"):
            p = os.path.join(output_dir, lo.get("subfolder") or "", lo["filename"])
            if os.path.isfile(p):
                z.write(p, "video/" + os.path.basename(lo["filename"]))
                manifest["video"] = "video/" + os.path.basename(lo["filename"])
        clean = dict(project)
        clean.pop("saved_at", None)
        z.writestr("project.json", json.dumps(clean, ensure_ascii=False, indent=2))
        z.writestr("manifest.json", json.dumps(manifest, indent=2))
    return manifest


def import_project(store, input_dir, output_dir, zip_path):
    """Create a new project from an exported zip. Files go into the new
    project's own folders; references are relinked to them. Returns
    (slug, summary)."""
    import zipfile
    try:
        z = zipfile.ZipFile(zip_path)
    except zipfile.BadZipFile:
        raise ValueError("That isn't a project export (.zip).") from None
    with z:
        names = set(z.namelist())
        if "project.json" not in names or "manifest.json" not in names:
            raise ValueError("That zip isn't an H3 Long Shot Studio project export.")
        try:
            project = json.loads(z.read("project.json").decode("utf-8"))
            manifest = json.loads(z.read("manifest.json").decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            raise ValueError("The project inside the zip is damaged.") from None
        if not isinstance(project, dict) or not isinstance(manifest, dict):
            raise ValueError("The project inside the zip is damaged.")
        if int(manifest.get("format") or 0) > EXPORT_FORMAT:
            raise ValueError("This export comes from a newer Studio. Update the Studio to import it.")
        name = str(project.get("name") or manifest.get("name") or "Imported").strip() or "Imported"
        slug = store.unique_slug(name)
        while any(os.path.exists(d) for d in _project_dirs(input_dir, output_dir, slug)):
            slug = store.unique_slug(slug + "-x")
        sub = project_input_subfolder(slug)
        folder = os.path.join(input_dir, *sub.split("/"))
        refs = {key: (item, field) for key, item, field in _refs(project)}
        placed = {}
        for entry in manifest.get("files") or []:
            arc, key = entry.get("path"), entry.get("key")
            if arc not in names or not str(arc).startswith("inputs/") or key not in refs:
                continue
            if arc not in placed:
                fname = clean_upload_name(os.path.basename(arc), ("images", "audio", "video"))
                os.makedirs(folder, exist_ok=True)
                target, n = os.path.join(folder, fname), 2
                stem, ext = fname.rsplit(".", 1)
                while os.path.exists(target):
                    target = os.path.join(folder, f"{stem} ({n}).{ext}")
                    n += 1
                with z.open(arc) as src, open(target, "wb") as dst:
                    shutil.copyfileobj(src, dst, 1 << 20)
                placed[arc] = os.path.basename(target)
            item, field = refs[key]
            item[field] = placed[arc]
            item["subfolder"] = sub
            item["original_name"] = placed[arc]
            item["sha256"] = entry.get("sha256") or item.get("sha256")
        takes_in = 0
        tfolder = takes_folder(output_dir, slug)
        for tname in manifest.get("takes") or []:
            arc = "takes/" + str(tname)
            if arc in names and TAKE_NAME_RE.fullmatch(str(tname)):
                os.makedirs(tfolder, exist_ok=True)
                with z.open(arc) as src, open(os.path.join(tfolder, tname), "wb") as dst:
                    shutil.copyfileobj(src, dst, 1 << 20)
                takes_in += 1
        have = set(os.listdir(tfolder)) if os.path.isdir(tfolder) else set()
        for sh in project.get("shots") or []:
            if sh.get("take") and sh["take"] not in have:
                sh["take"] = None              # renders again on this machine
        vid = manifest.get("video")
        lo = project.get("last_output") or {}
        if vid and vid in names and str(vid).startswith("video/") and lo.get("video"):
            vdir = os.path.join(output_dir, "longshot")
            os.makedirs(vdir, exist_ok=True)
            base = os.path.basename(vid)
            target, n = os.path.join(vdir, base), 2
            while os.path.exists(target):
                stem, ext = base.rsplit(".", 1)
                target = os.path.join(vdir, f"{stem} ({n}).{ext}")
                n += 1
            with z.open(vid) as src, open(target, "wb") as dst:
                shutil.copyfileobj(src, dst, 1 << 20)
            lo["video"] = dict(lo["video"], filename=os.path.basename(target), subfolder="longshot",
                               type="output")
        else:
            project["last_output"] = None
        project.pop("final_output", None)
        project["name"] = name
    saved_at = store.save(slug, project, force=True)
    return slug, {"saved_at": saved_at, "files": len(placed), "takes": takes_in,
                  "missing": manifest.get("missing") or []}


# ---------------------------------------------------------------------------
# Video clips: what ffmpeg says about a file
# ---------------------------------------------------------------------------

_DUR_RE = re.compile(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)")
_VID_RE = re.compile(r"Stream #[^\n]*?Video:[^\n]*?(\d{2,5})x(\d{2,5})[^\n]*?(\d+(?:\.\d+)?)\s*(?:fps|tbr)")


def parse_probe(text):
    """{duration, fps, width, height, has_audio} from ffmpeg -i's report."""
    out = {"duration": None, "fps": None, "width": None, "height": None,
           "has_audio": bool(re.search(r"Stream #[^\n]*Audio:", text or ""))}
    m = _DUR_RE.search(text or "")
    if m:
        out["duration"] = int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3))
    m = _VID_RE.search(text or "")
    if m:
        out["width"], out["height"], out["fps"] = int(m.group(1)), int(m.group(2)), float(m.group(3))
    return out


def clip_frames(seconds, fps=24):
    """The longest valid clip length (17k + 5 frames at 24 fps) within `seconds`."""
    n = int(max(0.0, float(seconds)) * fps + 1e-6)
    if n < 5:
        return 0
    return (n - 5) // 17 * 17 + 5
