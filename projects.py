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
STUDIO_VERSION = "0.3.0"
AUDIO_EXTENSIONS = {"mp3", "wav", "flac", "ogg", "m4a", "aac", "opus", "wma"}
IMAGE_EXTENSIONS = {"png", "jpg", "jpeg", "webp", "bmp", "gif", "tif", "tiff"}


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
    out = {"subfolder": sub, "images": [], "audio": []}
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
    return out


def project_input_subfolder(slug):
    return f"longshot/{slug}"


_UNSAFE_NAME = re.compile(r'[\x00-\x1f<>:"/\\|?*]+')
MAX_UPLOAD_BYTES = 200 * 1024 * 1024


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

    exts = IMAGE_EXTENSIONS if kind == "images" else AUDIO_EXTENSIONS
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


def segment_stats(output_dir, slug):
    folder = segments_folder(output_dir, slug)
    if not os.path.isdir(folder):
        return {"files": 0, "bytes": 0}
    files = [f for f in os.listdir(folder) if f.endswith(".safetensors")]
    return {"files": len(files),
            "bytes": sum(os.path.getsize(os.path.join(folder, f)) for f in files)}


def clear_segments(output_dir, slug):
    """Delete this project's saved segments: only *.safetensors (and leftover
    .tmp) files directly inside its segments folder."""
    folder = segments_folder(output_dir, slug)
    n = 0
    if not os.path.isdir(folder):
        return n
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
