"""Projects on disk and reference checks. Pure Python, no ComfyUI.

Projects are JSON files named by slug:
    <ComfyUI user dir>/default/longshot-studio/projects/<slug>.json
A project's files live in folders named by its slug:
    input/longshot/<slug>/             references, songs, clips
    output/longshot/<slug>/takes/      rendered Shots (Long Shot takes)
    output/longshot/<slug>/videos/     rendered videos
Renaming a project moves both folders to the new name's slug.
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
STUDIO_VERSION = "0.17.32"
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

    def list(self, check=None):
        """Saved projects, newest first. check(slug, project) may add fields."""
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
            if check is not None:
                try:
                    out[-1].update(check(slug, p) or {})
                except Exception:
                    pass
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


def videos_folder(output_dir, slug):
    return os.path.join(output_dir, "longshot", slug, "videos")


def videos_subfolder(slug):
    return f"longshot/{slug}/videos"


# ---------------------------------------------------------------------------
# Timeline clips: each take's piece of a rendered video, cut on the CPU so the
# timeline can switch takes without decoding anything again.
#   output/longshot/<slug>/clips/<key>.mp4 (+ .jpg thumbnail), index.json
# ---------------------------------------------------------------------------

CLIP_KEY_RE = re.compile(r"[A-Za-z0-9_-]{1,160}")


CONTEXT_DIR = "context"
_TAKE_FILE_RE = re.compile(r"[A-Za-z0-9_-]{1,160}\.safetensors")


def context_frame(output_dir, input_dir, slug, prev, ffmpeg="ffmpeg", run=None, back=0):
    """Context Continuity: the last frame of the Shot before (its take's clip,
    or a Clip Shot's video at its trim) as a PNG in the project's input folder,
    made once per take. Returns {file, subfolder} or None when there's nothing
    to take it from yet (no take, or no clip for it).

    0.17.0: back > 0 (frames): the Shot starts that many frames before the Shot before
    ends (they overlap), so the frame is the one right before its start instead."""
    import subprocess
    run = run or (lambda cmd: subprocess.run(cmd, capture_output=True, timeout=120))
    if not is_slug(slug) or not isinstance(prev, dict):
        return None
    sub = f"{project_input_subfolder(slug)}/{CONTEXT_DIR}"
    folder = os.path.join(input_dir, *sub.split("/"))
    if prev.get("kind") == "clip":
        c = prev.get("clip") or {}
        src = None
        try:
            src = os.path.join(input_dir, *_clean_subfolder(c.get("subfolder", "")).split("/"), c.get("file") or "")
        except ValueError:
            return None
        if not c.get("file") or not os.path.isfile(src):
            return None
        end = (float(c.get("trim_in") or 0) + float(c.get("frames") or 0) / 24.0) - (1.0 + back) / 24.0
        key = "clip_" + hashlib.sha256(f"{c.get('file')}|{c.get('sha256')}|{end:.4f}".encode()).hexdigest()[:16]
        cmd_in = ["-ss", f"{max(0.0, end):.4f}", "-i", src, "-frames:v", "1"]
    else:
        take = str(prev.get("take") or "")
        if not _TAKE_FILE_RE.fullmatch(take):
            return None
        key = take[:-len(".safetensors")]
        src = os.path.join(clips_folder(output_dir, slug), key + ".mp4")
        if not os.path.isfile(src):
            return None
        if back:
            cmd_in = ["-sseof", f"-{(back + 1) / 24.0 + 0.0005:.4f}", "-i", src, "-frames:v", "1"]
        else:
            cmd_in = ["-sseof", "-1", "-i", src, "-update", "1"]
    name = f"{key}_last.png" if not back or prev.get("kind") == "clip" else f"{key}_b{back}.png"
    dest = os.path.join(folder, name)
    if not os.path.isfile(dest) or os.path.getmtime(dest) < os.path.getmtime(src):
        os.makedirs(folder, exist_ok=True)
        tmp = dest + ".part.png"
        res = run([ffmpeg, "-y", "-v", "error", *cmd_in, tmp])
        if getattr(res, "returncode", 1) != 0 or not os.path.isfile(tmp):
            return None
        os.replace(tmp, dest)
    return {"file": name, "subfolder": sub}


def clips_folder(output_dir, slug):
    return os.path.join(output_dir, "longshot", slug, "clips")


def clips_subfolder(slug):
    return f"longshot/{slug}/clips"


def clip_index(output_dir, slug):
    """{key: {dur, made, thumb}} for clips whose file is there."""
    folder = clips_folder(output_dir, slug)
    if not is_slug(slug) or not os.path.isdir(folder):
        return {}
    try:
        with open(os.path.join(folder, "index.json"), encoding="utf-8") as fh:
            index = json.load(fh)
    except (OSError, ValueError):
        index = {}
    out = {}
    for key, info in (index.items() if isinstance(index, dict) else []):
        if CLIP_KEY_RE.fullmatch(str(key)) and isinstance(info, dict) and \
                os.path.isfile(os.path.join(folder, key + ".mp4")):
            out[key] = {"dur": float(info.get("dur") or 0), "made": info.get("made") or "",
                        "thumb": bool(info.get("thumb")) and os.path.isfile(os.path.join(folder, key + ".jpg"))}
    return out


def clip_commands(ffmpeg, src, folder, key, start, dur):
    """The two ffmpeg runs for one clip: the piece (re-encoded, so the cut is
    frame-exact) and a small thumbnail from its middle."""
    tmp = os.path.join(folder, f".{key}.tmp.mp4")
    clip = ["ffmpeg" if not ffmpeg else ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
            "-ss", f"{start:.4f}", "-i", src, "-t", f"{dur:.4f}",
            "-map", "0:v:0", "-map", "0:a:0?", "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
            "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", tmp]
    thumb = ["ffmpeg" if not ffmpeg else ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
             "-ss", f"{start + min(0.5, dur / 2):.4f}", "-i", src, "-frames:v", "1",
             "-vf", "scale=384:-2", "-q:v", "5", os.path.join(folder, key + ".jpg")]
    return clip, thumb, tmp


def cut_clips(output_dir, slug, video, rows, run, ffmpeg=None):
    """Cut each row's piece of a rendered video into the project's clips folder.

    rows: [{key, start, end}] in that video's seconds. `run(cmd)` runs one
    command and returns True on success (the server passes subprocess; tests a
    stand-in). Returns the new clip_index."""
    if not is_slug(slug):
        raise ValueError("Not a project slug.")
    src = _video_path(output_dir, video)
    root = os.path.realpath(os.path.join(output_dir, "longshot"))
    if not src or not os.path.realpath(src).startswith(root + os.sep):
        raise ValueError("That video isn't a render in output/longshot.")
    folder = clips_folder(output_dir, slug)
    os.makedirs(folder, exist_ok=True)
    try:
        with open(os.path.join(folder, "index.json"), encoding="utf-8") as fh:
            index = json.load(fh)
        if not isinstance(index, dict):
            index = {}
    except (OSError, ValueError):
        index = {}
    for r in rows or []:
        if not isinstance(r, dict):
            continue
        key = str(r.get("key") or "")
        try:
            start, end = float(r.get("start")), float(r.get("end"))
        except (TypeError, ValueError):
            continue
        if not CLIP_KEY_RE.fullmatch(key) or start < 0 or end - start < 0.04:
            continue
        clip, thumb, tmp = clip_commands(ffmpeg, src, folder, key, start, end - start)
        if not run(clip) or not os.path.isfile(tmp):
            if os.path.exists(tmp):
                os.remove(tmp)
            continue
        os.replace(tmp, os.path.join(folder, key + ".mp4"))
        index[key] = {"dur": round(end - start, 4), "made": now_iso(), "thumb": bool(run(thumb))}
    fd, tmpi = tempfile.mkstemp(dir=folder, suffix=".tmp")
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        json.dump(index, fh, indent=1)
    os.replace(tmpi, os.path.join(folder, "index.json"))
    return clip_index(output_dir, slug)


_CLIP_FILE_RE = re.compile(r"[A-Za-z0-9_-]{1,160}_\d{5,}(-audio)?\.mp4")


def adopt_clips(output_dir, slug, items, probe=None, thumb=None):
    """Clips Video Combine just saved into clips/ (<name>_00001-audio.mp4) become
    <key>.mp4 in the index. items: [{key, file: {filename, subfolder}}].
    probe(path) -> seconds (or None); thumb(src, dest_jpg) -> bool."""
    if not is_slug(slug):
        raise ValueError("Not a project slug.")
    folder = clips_folder(output_dir, slug)
    os.makedirs(folder, exist_ok=True)
    try:
        with open(os.path.join(folder, "index.json"), encoding="utf-8") as fh:
            index = json.load(fh)
        if not isinstance(index, dict):
            index = {}
    except (OSError, ValueError):
        index = {}
    for it in items or []:
        if not isinstance(it, dict):
            continue
        key, f = str(it.get("key") or ""), it.get("file") or {}
        name = str(f.get("filename") or "")
        sub = str(f.get("subfolder") or "").replace("\\", "/").strip("/")
        if not CLIP_KEY_RE.fullmatch(key) or sub != clips_subfolder(slug) or not _CLIP_FILE_RE.fullmatch(name):
            continue
        src = os.path.join(folder, name)
        if not os.path.isfile(src):
            continue
        dest = os.path.join(folder, key + ".mp4")
        os.replace(src, dest)
        stem = name[:-len("-audio.mp4")] if name.endswith("-audio.mp4") else name[:-4]
        for extra in (stem + ".png", stem + ".mp4"):          # the PNG and the silent copy
            x = os.path.join(folder, extra)
            if extra != key + ".mp4" and os.path.isfile(x):
                os.remove(x)
        dur = probe(dest) if probe else None
        index[key] = {"dur": round(float(dur), 4) if dur else float(it.get("dur") or 0), "made": now_iso(),
                      "thumb": bool(thumb(dest, os.path.join(folder, key + ".jpg"))) if thumb else False}
    fd, tmpi = tempfile.mkstemp(dir=folder, suffix=".tmp")
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        json.dump(index, fh, indent=1)
    os.replace(tmpi, os.path.join(folder, "index.json"))
    return clip_index(output_dir, slug)


# ---------------------------------------------------------------------------
# Chunked upscale: chunk files (no sound) + the sound, joined into one video
# ---------------------------------------------------------------------------

CHUNKS_DIR = "_chunks"
_CHUNK_EXT_RE = re.compile(r".+\.(mp4|mov|wav)", re.IGNORECASE)
_FORBIDDEN = set('<>:"/\\|?*')


def _plain_file_name(name, limit=240):
    """A file name the Studio writes (a project name may have spaces, accents,
    apostrophes…): no folders, nothing Windows forbids, no leading dot."""
    return isinstance(name, str) and 0 < len(name) <= limit and name.strip() == name \
        and not name.startswith(".") and ".." not in name \
        and not any(c in _FORBIDDEN or ord(c) < 32 for c in name)


def chunks_folder(output_dir, slug):
    return os.path.join(videos_folder(output_dir, slug), CHUNKS_DIR)


def discard_chunks(output_dir, slug):
    """Remove videos/_chunks (left over from a chunked upscale). True if it was there."""
    folder = chunks_folder(output_dir, slug)
    if not is_slug(slug) or not os.path.isdir(folder):
        return False
    shutil.rmtree(folder, ignore_errors=True)
    return True


def _chunk_path(output_dir, slug, entry):
    """A chunk file Video Combine / Save Audio wrote, as a path; ValueError otherwise."""
    if not isinstance(entry, dict):
        raise ValueError("A chunk is {filename, subfolder}.")
    name, sub = entry.get("filename"), (entry.get("subfolder") or "").replace("\\", "/").strip("/")
    if sub != f"{videos_subfolder(slug)}/{CHUNKS_DIR}" or not _plain_file_name(name) \
            or not _CHUNK_EXT_RE.fullmatch(name):
        raise ValueError(f"Not a chunk of this project: {sub}/{name}")
    path = os.path.join(chunks_folder(output_dir, slug), name)
    if not os.path.isfile(path):
        raise ValueError(f"The chunk {name} is missing.")
    return path


def _next_number(folder, stem):
    rx = re.compile(re.escape(stem) + r"_(\d{5,})(-audio)?\.(mp4|mov|webm|mkv|png)", re.IGNORECASE)
    n = 0
    for f in os.listdir(folder) if os.path.isdir(folder) else []:
        m = rx.fullmatch(f)
        if m:
            n = max(n, int(m.group(1)))
    return n + 1


def _join_run_audio(output_dir, slug, parts, ffmpeg, run):
    """[{filename, subfolder, skip, dur?} | {silence}] -> one WAV in the chunks folder:
    each part from `skip` seconds on (sample-exact), `dur` seconds long when given
    (0.9.0: a trimmed run end), and `silence` seconds of nothing between (a gap on
    the film), in order."""
    files, chains = [], []
    for k, p in enumerate(parts):
        try:
            if isinstance(p, dict) and "silence" in p:
                sec = max(0.0, float(p.get("silence") or 0))
                chains.append(f"anullsrc=r=48000:cl=stereo,atrim=duration={sec:.6f},"
                              f"aformat=sample_fmts=fltp:channel_layouts=stereo[a{k}]")
                continue
            sk = max(0.0, float(p.get("skip") or 0))
            dur = p.get("dur")
            dur = None if dur in (None, "") else max(0.0, float(dur))
        except (TypeError, ValueError):
            raise ValueError("A run's sound needs numbers of seconds (skip, dur, silence).") from None
        i = len(files)
        files.append(_chunk_path(output_dir, slug, p))
        cut = f"atrim=start={sk:.6f}" + (f":duration={dur:.6f}" if dur is not None else "")
        # a run whose sound is shorter than its pictures is padded, so later parts stay in place
        pad = f",apad=whole_dur={dur:.6f}" if dur is not None else ""
        chains.append(f"[{i}:a]{cut},asetpts=PTS-STARTPTS,aresample=48000{pad},"
                      f"aformat=sample_fmts=fltp:channel_layouts=stereo[a{k}]")
    if not files:
        raise ValueError("No sound to join.")
    out = os.path.join(chunks_folder(output_dir, slug), "film_audio.wav")
    cmd = [ffmpeg, "-y", "-v", "error"]
    for f in files:
        cmd += ["-i", f]
    graph = ";".join(chains) + ";" + "".join(f"[a{k}]" for k in range(len(parts))) + \
        f"concat=n={len(parts)}:v=0:a=1[out]"
    cmd += ["-filter_complex", graph, "-map", "[out]", "-c:a", "pcm_s24le", out]
    res = run(cmd)
    if getattr(res, "returncode", 1) != 0 or not os.path.isfile(out):
        err = getattr(res, "stderr", b"") or b""
        raise RuntimeError("Joining the sound of the runs failed: " +
                           (err.decode("utf-8", "replace") if isinstance(err, bytes) else str(err))[-600:])
    return out


def _song_audio(output_dir, slug, song, seconds, input_dir, ffmpeg, run):
    """0.9.0: the song file itself, from `at` seconds for the film's length, as a WAV in
    the chunks folder ("Song in final video", continuous under gaps and edits)."""
    try:
        path = resolve_input(input_dir, song.get("file"), song.get("subfolder", ""))
        at = max(0.0, float(song.get("at") or 0))
    except (TypeError, ValueError, AttributeError) as err:
        raise ValueError(f"The song: {err}") from None
    if not os.path.isfile(path):
        raise ValueError(f"The song file {song.get('file')} is missing.")
    out = os.path.join(chunks_folder(output_dir, slug), "film_song.wav")
    res = run([ffmpeg, "-y", "-v", "error", "-ss", f"{at:.6f}", "-i", path, "-vn",
               "-af", f"aresample=48000,apad=whole_dur={seconds:.6f},atrim=duration={seconds:.6f}",
               "-ac", "2", "-c:a", "pcm_s24le", out])
    if getattr(res, "returncode", 1) != 0 or not os.path.isfile(out):
        err = getattr(res, "stderr", b"") or b""
        raise RuntimeError("Cutting the song failed: " +
                           (err.decode("utf-8", "replace") if isinstance(err, bytes) else str(err))[-600:])
    return out


def _black(output_dir, slug, like, frames, codec_args, name, ffmpeg, run):
    """`frames` of black at 24 fps, encoded with the chunks' own settings (so the
    pictures still join without encoding again), the size of chunk `like`."""
    probe = run([ffmpeg, "-hide_banner", "-i", like])
    info = parse_probe((getattr(probe, "stderr", b"") or b"").decode("utf-8", "replace")
                       if isinstance(getattr(probe, "stderr", b""), bytes) else str(getattr(probe, "stderr", "")))
    if not info.get("width"):
        raise RuntimeError("Couldn't read the chunks' size to make the black between them.")
    out = os.path.join(chunks_folder(output_dir, slug), name)
    res = run([ffmpeg, "-y", "-v", "error", "-f", "lavfi", "-i",
               f"color=c=black:s={info['width']}x{info['height']}:r=24", "-frames:v", str(int(frames)),
               *codec_args, out])
    if getattr(res, "returncode", 1) != 0 or not os.path.isfile(out):
        err = getattr(res, "stderr", b"") or b""
        raise RuntimeError("Making the black between the runs failed: " +
                           (err.decode("utf-8", "replace") if isinstance(err, bytes) else str(err))[-600:])
    return out


def join_chunks(output_dir, slug, prefix, chunks, audio=None, masters=None, ffmpeg="ffmpeg", run=None,
                gaps=None, song=None, input_dir=None, codec_args=None, master_args=None):
    """Join chunk videos (in order) and the sound into videos/<Name>_NNNNN-audio.mp4
    (and the ProRes chunks into <Name>_master_NNNNN-audio.mov). The pictures are
    copied, not encoded again. `prefix` is the render's own file prefix
    (longshot/<slug>/videos/<Name>[_final]). Returns {video, master} entries
    like Video Combine's; the chunks folder is removed afterwards (and kept
    when joining fails, so it can be tried again)."""
    import subprocess
    run = run or (lambda cmd: subprocess.run(cmd, capture_output=True, timeout=1800))
    if not is_slug(slug):
        raise ValueError("Not a project slug.")
    prefix = str(prefix or "").replace("\\", "/")
    head, _, stem = prefix.rpartition("/")
    if head != videos_subfolder(slug) or not _plain_file_name(stem, 160):
        raise ValueError("The joined video goes into the project's videos folder.")
    if not chunks:
        raise ValueError("No chunks to join.")
    vids = [_chunk_path(output_dir, slug, c) for c in chunks]
    mast = [_chunk_path(output_dir, slug, c) for c in (masters or [])]
    # 0.9.0: black where nothing covers the film (a trim, a move, a Shot not rendered),
    # [{before: chunk index, frames}]; the masters' chunks run alongside
    gaps = [g for g in (gaps or []) if isinstance(g, dict) and int(g.get("frames") or 0) > 0]
    total = None
    if gaps:
        if not codec_args:
            raise ValueError("Black between the runs needs the chunks' codec.")
        per = len(mast) == len(vids) and bool(mast)
        vlist, mlist = list(vids), list(mast)
        for k, g in sorted(enumerate(gaps), key=lambda x: -int(x[1].get("before") or 0)):
            at = max(0, min(len(vids), int(g.get("before") or 0)))
            f = int(g["frames"])
            vlist.insert(at, _black(output_dir, slug, vids[0], f, codec_args, f"black_{k:03d}.mp4", ffmpeg, run))
            if per and master_args:
                mlist.insert(at, _black(output_dir, slug, mast[0], f, master_args, f"black_{k:03d}.mov", ffmpeg, run))
        vids, mast = vlist, mlist
    if song:
        try:
            total = float((song or {}).get("seconds"))
        except (TypeError, ValueError):
            raise ValueError("The song needs the film's length in seconds.") from None
        wav = _song_audio(output_dir, slug, song, total, input_dir or "", ffmpeg, run)
        audio = None
    if song:
        pass
    elif isinstance(audio, list):
        # a film decoded run by run (0.8.5): each run's sound, its first `skip`
        # seconds dropped (the hidden overlap after a cut), one after another
        wav = _join_run_audio(output_dir, slug, audio, ffmpeg, run) if audio else None
    else:
        wav = _chunk_path(output_dir, slug, audio) if audio else None
    folder = videos_folder(output_dir, slug)
    n = max(_next_number(folder, stem), _next_number(folder, stem + "_master"))

    def one(files, out_name, audio_codec, extra):
        listing = os.path.join(chunks_folder(output_dir, slug), out_name + ".txt")
        with open(listing, "w", encoding="utf-8") as fh:
            for f in files:
                fh.write("file '" + f.replace("'", "'\\''") + "'\n")
        out = os.path.join(folder, out_name)
        tmp = os.path.join(chunks_folder(output_dir, slug), "joining_" + out_name)
        cmd = [ffmpeg, "-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", listing]
        if wav:
            # the sound is padded with silence and cut at the picture's end: every frame stays
            secs = [_media_seconds(ffmpeg, f, run) for f in files]
            total = sum(secs) if secs and all(secs) else None
            cmd += ["-i", wav, "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", *_pad_to(total), "-c:a", *audio_codec]
        else:
            cmd += ["-map", "0:v:0", "-c", "copy"]
        cmd += [*extra, tmp]
        res = run(cmd)
        if getattr(res, "returncode", 1) != 0 or not os.path.isfile(tmp):
            err = getattr(res, "stderr", b"") or b""
            raise RuntimeError("Joining the chunks failed: " +
                               (err.decode("utf-8", "replace") if isinstance(err, bytes) else str(err))[-600:])
        os.replace(tmp, out)
        return {"filename": out_name, "subfolder": videos_subfolder(slug), "type": "output",
                "format": "video/" + ("quicktime" if out_name.endswith(".mov") else "mp4"),
                "frame_rate": 24.0, "fullpath": out}

    video = one(vids, f"{stem}_{n:05d}-audio.mp4", ["aac", "-b:a", "256k"], ["-movflags", "+faststart"])
    master = one(mast, f"{stem}_master_{n:05d}-audio.mov", ["pcm_s24le"], []) if mast else None
    discard_chunks(output_dir, slug)
    return {"video": video, "master": master}


# ---------------------------------------------------------------------------
# Export approved clips: each approved Shot's own clip, whole, numbered as on
# the timeline, in output/longshot/<slug>/Approved_Clips (for an editor)
# ---------------------------------------------------------------------------

APPROVED_DIR = "Approved_Clips"
_WORK_DIR = "_work"
_CLIP_KEY_RE = re.compile(r"[A-Za-z0-9_-]{1,160}")


def approved_folder(output_dir, slug):
    return os.path.join(output_dir, "longshot", slug, APPROVED_DIR)


def approved_subfolder(slug):
    return f"longshot/{slug}/{APPROVED_DIR}"


_MANIFEST = ".export.json"


def _read_manifest(folder):
    """What the upscaled export left in Approved_Clips: {name.mp4: {key, sig, prores}}."""
    try:
        with open(os.path.join(folder, _MANIFEST), encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _write_manifest(folder, data):
    path = os.path.join(folder, _MANIFEST)
    if not data:
        try:
            os.remove(path)
        except OSError:
            pass
        return
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=1)
    os.replace(tmp, path)


def keep_upscaled(output_dir, slug, items, sig, prores=False, ffmpeg=None, input_dir=None, song=None, run=None):
    """Before an upscaled export: [{key, name, sig, asig, cut?, song_at?, song_len?}]
    wanted. A clip already upscaled from the same take with the same picture `sig`
    stays (renamed when its number changed); when only its sound changed (`asig`:
    the song on or off, or the song's place), its sound is mixed again with ffmpeg
    (0.13.3: from the song, or from the take's own clip), with no new upscale.
    Everything else in the folder goes, so it matches the timeline.
    Returns {"kept": [names], "todo": [keys still to upscale], "remixed": [names]}."""
    import subprocess
    run = run or (lambda cmd: subprocess.run(cmd, capture_output=True, timeout=900))
    if not is_slug(slug):
        raise ValueError("Not a project slug.")
    want = []
    for it in items or []:
        key = str((it or {}).get("key") or "")
        if not _CLIP_KEY_RE.fullmatch(key):
            raise ValueError(f"Not a clip: {key!r}")
        # 0.12.8: each clip's own sig, so approving or moving another Shot doesn't make
        # every clip "changed"; 0.13.3: the picture's sig, the sound apart (asig)
        want.append((key, _export_name(str(it.get("name") or ""), ".mp4"), str(it.get("sig") or sig), it))
    folder = approved_folder(output_dir, slug)
    if not os.path.isdir(folder):
        return {"kept": [], "todo": [k for k, _, _, _ in want], "remixed": []}
    song_path = None
    if song and ffmpeg:
        try:
            song_path = resolve_input(input_dir or "", song.get("file"), song.get("subfolder", ""))
        except (ValueError, TypeError):
            song_path = None
        if song_path and not os.path.isfile(song_path):
            song_path = None
    man = _read_manifest(folder)
    sig_of = {key: isig for key, _, isig, _ in want}
    by_key = {}
    for fname, rec in man.items():
        if not isinstance(rec, dict) or not _plain_file_name(fname):
            continue
        if rec.get("sig") != sig_of.get(rec.get("key")):
            continue
        if not os.path.isfile(os.path.join(folder, fname)):
            continue
        mov = fname[:-4] + ".mov"
        if prores and not os.path.isfile(os.path.join(folder, mov)):
            continue
        by_key.setdefault(rec.get("key"), fname)
    keep, todo = [], []                       # keep: (old name, new name, key, item)
    for key, name, _isig, it in want:
        old = by_key.pop(key, None)
        if old and str(it.get("asig") or "") != str((man.get(old) or {}).get("asig") or ""):
            # the sound changed: mixed again below, or upscaled again when it can't be
            needs_song = bool(it.get("song_len"))
            clip = os.path.join(clips_folder(output_dir, slug), key + ".mp4")
            if not ffmpeg or (needs_song and not song_path) or (not needs_song and not os.path.isfile(clip)):
                old = None
        if old:
            keep.append((old, name, key, it))
        else:
            todo.append(key)
    # rename through temporary names (numbers can shift by one)
    moves = []
    for i, (old, new, key, _it) in enumerate(keep):
        for ext in (".mp4", ".mov"):
            src = os.path.join(folder, old[:-4] + ext)
            if os.path.isfile(src):
                tmp = os.path.join(folder, f".keep{i}{ext}.part")   # not a video: clearing leaves it
                os.replace(src, tmp)
                moves.append((tmp, os.path.join(folder, new[:-4] + ext)))
    clear_approved(output_dir, slug, keep_work=False)
    for tmp, dest in moves:
        os.replace(tmp, dest)
    new_man, remixed = {}, []
    for old, new, key, it in keep:
        rec = dict(man.get(old) or {})
        asig = str(it.get("asig") or "")
        if asig != str(rec.get("asig") or ""):
            _remix_sound(folder, new, key, it, output_dir, slug, ffmpeg, song_path, run)
            remixed.append(new)
        rec.update(key=key, sig=sig_of.get(key, sig), asig=asig)
        rec["prores"] = os.path.isfile(os.path.join(folder, new[:-4] + ".mov"))
        new_man[new] = rec
    _write_manifest(folder, new_man)
    return {"kept": [new for _, new, _, _ in keep], "todo": todo, "remixed": remixed}


def _remix_sound(folder, name, key, it, output_dir, slug, ffmpeg, song_path, run):
    """An exported clip's picture as it is, with its sound made again: the song from
    song_at for song_len, or the take's own sound from its clip (cut the same way)."""
    if it.get("song_len") and song_path:
        src = ["-ss", f"{max(0.0, float(it.get('song_at') or 0)):.6f}", "-t", f"{float(it['song_len']):.6f}", "-i", song_path]
    else:
        clip = os.path.join(clips_folder(output_dir, slug), key + ".mp4")
        cut = it.get("cut") if isinstance(it.get("cut"), dict) else None
        src = (["-ss", f"{max(0.0, float(cut.get('start') or 0)):.6f}", "-t", f"{float(cut['dur']):.6f}"] if cut else []) + ["-i", clip]
    for ext, acodec in ((".mp4", ["aac", "-b:a", "256k"]), (".mov", ["pcm_s24le"])):
        dest = os.path.join(folder, name[:-4] + ext)
        if not os.path.isfile(dest):
            continue
        tmp = dest + ".remix" + ext
        cmd = [ffmpeg, "-y", "-v", "error", "-i", dest, *src, "-map", "0:v:0", "-map", "1:a:0?",
               "-c:v", "copy", *_pad_to(_media_seconds(ffmpeg, dest, run)), "-c:a", *acodec]
        if ext == ".mp4":
            cmd += ["-movflags", "+faststart"]
        res = run(cmd + [tmp])
        if getattr(res, "returncode", 1) != 0 or not os.path.isfile(tmp):
            err = getattr(res, "stderr", b"") or b""
            try:
                os.remove(tmp)
            except OSError:
                pass
            raise RuntimeError(f"Mixing the sound of {name[:-4]}{ext} failed: " +
                               (err.decode("utf-8", "replace") if isinstance(err, bytes) else str(err))[-400:])
        os.replace(tmp, dest)


def _media_seconds(ffmpeg, path, run):
    """A video's length in seconds from ffmpeg's report, or None."""
    try:
        res = run([ffmpeg, "-hide_banner", "-i", path])
    except Exception:
        return None
    err = getattr(res, "stderr", b"") or b""
    text = err.decode("utf-8", "replace") if isinstance(err, bytes) else str(err)
    return parse_probe(text).get("duration") or None


def _pad_to(seconds):
    """0.15.5: the sound padded with silence to the picture's length and cut there, as
    explicit times. "-af apad -shortest" never ends with the picture stream-copied on
    ffmpeg 7.x (it ran until the 900 s timeout); without a length it falls back to that."""
    if seconds:
        return ["-af", f"apad=whole_dur={seconds:.6f}", "-t", f"{seconds:.6f}"]
    return ["-af", "apad", "-shortest"]


# ---------------------------------------------------------------------------
# Stems (0.17.28-0.17.30): each exported clip / final video split into its dialogue and the rest.
# Approved clips' stems go to Approved_Audio/Dialogue and Approved_Audio/SFX; a final's sit next
# to it. One manifest per project (longshot/<slug>/.stems.json) remembers which file each pair
# was split from (its SHA-256) and where the pair is, so an export only splits what changed,
# and the stems of a file that's gone are removed.
# ---------------------------------------------------------------------------

_STEMS_MANIFEST = ".stems.json"
STEM_SUFFIXES = ("_dialogue.wav", "_sfx.wav")
APPROVED_AUDIO_DIR = "Approved_Audio"


def _inside_project(output_dir, slug, rel, ext=""):
    """The absolute path of a file inside the project's output folder (rel + ext), or ValueError."""
    if not is_slug(slug):
        raise ValueError("Not a project slug.")
    rel = str(rel or "").replace("\\", "/").strip("/")
    root = os.path.realpath(os.path.join(output_dir, "longshot", slug))
    path = os.path.realpath(os.path.join(output_dir, *rel.split("/"))) + ext
    if not path.startswith(root + os.sep):
        raise ValueError("Stems stay inside the project's output folder.")
    return path


def _stem_item(it):
    """{source, dx, fx} from an item ({source, dx, fx}, {source, out} or a bare source path)."""
    if isinstance(it, str):
        it = {"source": it}
    if not isinstance(it, dict):
        return None
    src = str(it.get("source") or "").replace("\\", "/").strip("/")
    if not src:
        return None
    if it.get("dx") and it.get("fx"):
        return {"source": src, "dx": str(it["dx"]).strip("/"), "fx": str(it["fx"]).strip("/")}
    out = str(it.get("out") or re.sub(r"(-audio)?\.(mp4|mov|wav)$", "", src, flags=re.I)).strip("/")
    return {"source": src, "dx": out + "_dialogue", "fx": out + "_sfx"}


def _file_sha(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _stems_manifest_path(output_dir, slug):
    return os.path.join(output_dir, "longshot", slug, _STEMS_MANIFEST)


def _stems_manifest(output_dir, slug):
    try:
        with open(_stems_manifest_path(output_dir, slug), encoding="utf-8") as fh:
            data = json.load(fh)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _write_stems_manifest(output_dir, slug, man):
    path = _stems_manifest_path(output_dir, slug)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path + ".tmp", "w", encoding="utf-8") as fh:
        json.dump(man, fh, indent=1)
    os.replace(path + ".tmp", path)


def _rm(path):
    try:
        os.remove(path)
    except OSError:
        pass


def stems_todo(output_dir, slug, items):
    """The items (as {source, dx, fx}) whose stems are missing, elsewhere, or were split from
    another version of the file. Removes the stems of files that are gone, and of a file
    whose stems now go somewhere else."""
    man = _stems_manifest(output_dir, slug)
    todo, changed = [], False
    for raw in items or []:
        it = _stem_item(raw)
        if not it:
            continue
        try:
            src = _inside_project(output_dir, slug, it["source"])
            dx = _inside_project(output_dir, slug, it["dx"], ".wav")
            fx = _inside_project(output_dir, slug, it["fx"], ".wav")
        except ValueError:
            continue
        if not os.path.isfile(src):
            continue
        rec = man.get(it["source"]) or {}
        if rec and (rec.get("dx"), rec.get("fx")) != (it["dx"], it["fx"]):
            for k in ("dx", "fx"):           # they move: the old pair goes
                try:
                    _rm(_inside_project(output_dir, slug, rec.get(k), ".wav"))
                except ValueError:
                    pass
            man.pop(it["source"], None)
            changed, rec = True, {}
        if not (os.path.isfile(dx) and os.path.isfile(fx)) or rec.get("sha") != _file_sha(src):
            todo.append(it)
    # stems of files that aren't there any more
    for source, rec in list(man.items()):
        try:
            gone = not os.path.isfile(_inside_project(output_dir, slug, source))
        except ValueError:
            gone = True
        if gone:
            for k in ("dx", "fx"):
                try:
                    _rm(_inside_project(output_dir, slug, (rec or {}).get(k), ".wav"))
                except ValueError:
                    pass
            del man[source]
            changed = True
    # 0.17.28 put approved clips' stems next to them: they live in Approved_Audio now
    legacy = approved_folder(output_dir, slug)
    if os.path.isdir(legacy):
        for f in os.listdir(legacy):
            if f.endswith(STEM_SUFFIXES):
                _rm(os.path.join(legacy, f))
        _rm(os.path.join(legacy, _STEMS_MANIFEST))
    if changed:
        _write_stems_manifest(output_dir, slug, man)
    return todo


def stems_done(output_dir, slug, items):
    """Remember what each new pair of stems was split from, and where it is."""
    man = _stems_manifest(output_dir, slug)
    n = 0
    for raw in items or []:
        it = _stem_item(raw)
        if not it:
            continue
        try:
            src = _inside_project(output_dir, slug, it["source"])
            dx = _inside_project(output_dir, slug, it["dx"], ".wav")
            fx = _inside_project(output_dir, slug, it["fx"], ".wav")
        except ValueError:
            continue
        if not (os.path.isfile(src) and os.path.isfile(dx) and os.path.isfile(fx)):
            continue
        man[it["source"]] = {"sha": _file_sha(src), "dx": it["dx"], "fx": it["fx"]}
        n += 1
    _write_stems_manifest(output_dir, slug, man)
    return n


def clear_approved(output_dir, slug, keep_work=False):
    """Empty Approved_Clips of its videos (and the upscale's work files)."""
    folder = approved_folder(output_dir, slug)
    if not is_slug(slug) or not os.path.isdir(folder):
        return 0
    _write_manifest(folder, {})
    n = 0
    for f in os.listdir(folder):
        path = os.path.join(folder, f)
        # (0.17.29: the stems stay: stems_todo keeps the ones whose clip came back the same)
        if os.path.isfile(path) and f.lower().endswith((".mp4", ".mov")):
            os.remove(path)
            n += 1
    if not keep_work:
        shutil.rmtree(os.path.join(folder, _WORK_DIR), ignore_errors=True)
    return n


def _export_name(name, ext):
    out = f"{name}{ext}"
    if not _plain_file_name(out):
        raise ValueError(f"Not a usable file name: {name!r}")
    return out


def copy_approved(output_dir, slug, items, ffmpeg=None, input_dir=None, song=None, run=None):
    """[{key, name, cut?, song_at?, song_len?}] -> clips/<key>.mp4 as
    Approved_Clips/<name>.mp4 (the folder is emptied first, so it matches the
    timeline). Returns the names. 0.9.0: `cut` {start, dur} (seconds into the clip)
    exports what the film shows of a trimmed Shot, encoded again frame-exactly;
    with `song` {file, subfolder} and song_at / song_len the clip carries the song."""
    import subprocess
    run = run or (lambda cmd: subprocess.run(cmd, capture_output=True, timeout=900))
    if not is_slug(slug):
        raise ValueError("Not a project slug.")
    song_path = None
    if song:
        song_path = resolve_input(input_dir or "", song.get("file"), song.get("subfolder", ""))
        if not os.path.isfile(song_path):
            raise ValueError(f"The song file {song.get('file')} is missing.")
    plan = []
    for it in items or []:
        key = str((it or {}).get("key") or "")
        if not _CLIP_KEY_RE.fullmatch(key):
            raise ValueError(f"Not a clip: {key!r}")
        src = os.path.join(clips_folder(output_dir, slug), key + ".mp4")
        if not os.path.isfile(src):
            raise ValueError(f"The clip for {it.get('name') or key} isn't there yet.")
        cut = it.get("cut") if isinstance(it.get("cut"), dict) else None
        sng = (float(it["song_at"]), float(it["song_len"])) if song_path and it.get("song_len") else None
        plan.append((src, _export_name(str(it.get("name") or ""), ".mp4"), cut, sng))
    if not plan:
        raise ValueError("No approved clips to export.")
    if any(c or g for _, _, c, g in plan) and not ffmpeg:
        raise ValueError("ffmpeg isn't available, so trimmed clips (or the song) can't be exported.")
    folder = approved_folder(output_dir, slug)
    os.makedirs(folder, exist_ok=True)
    clear_approved(output_dir, slug)
    for src, name, cut, sng in plan:
        dest = os.path.join(folder, name)
        if not cut and not sng:
            shutil.copy2(src, dest)
            continue
        cmd = [ffmpeg, "-y", "-v", "error"]
        if cut:
            cmd += ["-ss", f"{max(0.0, float(cut.get('start') or 0)):.6f}", "-t", f"{float(cut['dur']):.6f}"]
        cmd += ["-i", src]
        if sng:
            length = float(cut["dur"]) if cut else _media_seconds(ffmpeg, src, run)
            cmd += ["-ss", f"{max(0.0, sng[0]):.6f}", "-t", f"{sng[1]:.6f}", "-i", song_path,
                    "-map", "0:v:0", "-map", "1:a:0", *_pad_to(length)]
        else:
            cmd += ["-map", "0:v:0", "-map", "0:a?"]
        cmd += (["-c:v", "libx264", "-crf", "16", "-preset", "medium", "-pix_fmt", "yuv420p"] if cut else ["-c:v", "copy"])
        cmd += ["-c:a", "aac", "-b:a", "256k", "-movflags", "+faststart", dest]
        res = run(cmd)
        if getattr(res, "returncode", 1) != 0 or not os.path.isfile(dest):
            err = getattr(res, "stderr", b"") or b""
            raise RuntimeError(f"Exporting {name} failed: " +
                               (err.decode("utf-8", "replace") if isinstance(err, bytes) else str(err))[-400:])
    return [name for _, name, _, _ in plan]


def _work_path(output_dir, slug, entry):
    if not isinstance(entry, dict):
        raise ValueError("A work file is {filename, subfolder}.")
    name, sub = entry.get("filename"), (entry.get("subfolder") or "").replace("\\", "/").strip("/")
    if sub != f"{approved_subfolder(slug)}/{_WORK_DIR}" or not _plain_file_name(name) \
            or not _CHUNK_EXT_RE.fullmatch(name):
        raise ValueError(f"Not an export work file: {sub}/{name}")
    path = os.path.join(approved_folder(output_dir, slug), _WORK_DIR, name)
    if not os.path.isfile(path):
        raise ValueError(f"{name} is missing.")
    return path


def mux_approved(output_dir, slug, items, ffmpeg="ffmpeg", run=None, sig=None):
    """The upscaled export: [{name, video, audio, master, key}] (work files the
    Upscale Chunk / Save Audio nodes wrote) -> Approved_Clips/<name>.mp4 (and
    <name>.mov with the ProRes copy), pictures copied, sound added. With `sig`
    (incremental: keep_upscaled ran first) the clips already there stay and the
    new ones are recorded; without it the folder is emptied first. The work
    files are removed afterwards."""
    import subprocess
    run = run or (lambda cmd: subprocess.run(cmd, capture_output=True, timeout=900))
    if not is_slug(slug):
        raise ValueError("Not a project slug.")
    plan = []
    for it in items or []:
        name = str((it or {}).get("name") or "")
        _export_name(name, ".mp4")
        plan.append((name, _work_path(output_dir, slug, it.get("video")),
                     _work_path(output_dir, slug, it["audio"]) if it.get("audio") else None,
                     _work_path(output_dir, slug, it["master"]) if it.get("master") else None))
    if not plan:
        raise ValueError("No approved clips to export.")
    folder = approved_folder(output_dir, slug)
    if sig is None:
        clear_approved(output_dir, slug, keep_work=True)
    man = _read_manifest(folder) if sig is not None else {}
    keys = {str((it or {}).get("name") or ""): str((it or {}).get("key") or "") for it in items or []}
    sigs = {str((it or {}).get("name") or ""): str((it or {}).get("sig") or sig or "") for it in items or []}
    asigs = {str((it or {}).get("name") or ""): str((it or {}).get("asig") or "") for it in items or []}
    out = []
    for name, video, wav, master in plan:
        for src, ext, acodec, extra in ((video, ".mp4", ["aac", "-b:a", "256k"], ["-movflags", "+faststart"]),
                                        (master, ".mov", ["pcm_s24le"], [])):
            if not src:
                continue
            dest = os.path.join(folder, name + ext)
            cmd = [ffmpeg, "-y", "-v", "error", "-i", src]
            cmd += (["-i", wav, "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy",
                     *_pad_to(_media_seconds(ffmpeg, src, run)), "-c:a", *acodec]
                    if wav else ["-map", "0:v:0", "-c", "copy"])
            res = run(cmd + extra + [dest])
            if getattr(res, "returncode", 1) != 0 or not os.path.isfile(dest):
                err = getattr(res, "stderr", b"") or b""
                raise RuntimeError(f"Saving {name}{ext} failed: " +
                                   (err.decode("utf-8", "replace") if isinstance(err, bytes) else str(err))[-400:])
            out.append(name + ext)
        if sig is not None and keys.get(name):
            man[name + ".mp4"] = {"key": keys[name], "sig": sigs.get(name) or sig, "asig": asigs.get(name, ""),
                                  "prores": bool(master)}
    if sig is not None:
        _write_manifest(folder, man)
    shutil.rmtree(os.path.join(folder, _WORK_DIR), ignore_errors=True)
    return out


def delete_videos(output_dir, slug):
    """Delete this project's videos and timeline clips folders."""
    n = 0
    for folder in (videos_folder(output_dir, slug), clips_folder(output_dir, slug)):
        if is_slug(slug) and os.path.isdir(folder):
            shutil.rmtree(folder)
            n += 1
    return n > 0


def files_missing(input_dir, output_dir, slug, project):
    """True when the project uses its own folders but they're gone (deleted by
    hand): its input folder while references live there, or its takes folder
    while Shots have takes."""
    sub = project_input_subfolder(slug)
    uses_inputs = any((item.get("subfolder") or "").replace("\\", "/").strip("/") == sub
                      for _k, item, _f in _refs(project))
    if uses_inputs and not os.path.isdir(os.path.join(input_dir, "longshot", slug)):
        return True
    has_takes = any(isinstance(sh, dict) and sh.get("take") for sh in project.get("shots") or [])
    return has_takes and not os.path.isdir(takes_folder(output_dir, slug))


def list_videos(output_dir, slug):
    """Video files directly inside output/longshot/<slug>/videos, by name."""
    folder = videos_folder(output_dir, slug)
    if not is_slug(slug) or not os.path.isdir(folder):
        return []
    return sorted(f for f in os.listdir(folder)
                  if os.path.isfile(os.path.join(folder, f)) and "." in f
                  and f.rsplit(".", 1)[1].lower() in VIDEO_EXTENSIONS)


# ---------------------------------------------------------------------------
# After a render: the first-frame PNG and the video without sound
# ---------------------------------------------------------------------------

# What Video Combine writes per render: <prefix>_00001.png (first frame, with the
# workflow), <prefix>_00001.mp4 (no sound) and <prefix>_00001-audio.mp4.
_RENDER_FILE_RE = re.compile(r"(?P<stem>.+)_(?P<n>\d{5,})(?P<audio>-audio)?\.(?P<ext>mp4|mov|webm|mkv)",
                             re.IGNORECASE)


def render_side_files(output_dir, entries, png=False, noaudio=False):
    """The side files of a render's saved videos that the project doesn't keep.

    `entries` are Video Combine's results for one render ({filename, subfolder,
    type}). Only files inside output/longshot/… that sit next to one of those
    videos are returned: its <prefix>_<n>.png (png=True) and, when the entry
    is the -audio file, the silent <prefix>_<n>.<ext> (noaudio=True). The
    video the player uses (the -audio one) is never among them."""
    root = os.path.realpath(os.path.join(output_dir, "longshot"))
    out = []
    for e in entries or []:
        if not isinstance(e, dict) or (e.get("type") or "output") != "output":
            continue
        name = e.get("filename")
        if not isinstance(name, str) or "/" in name or "\\" in name or name in (".", ".."):
            continue
        try:
            sub = _clean_subfolder(e.get("subfolder") or "")
        except ValueError:
            continue
        if sub != "longshot" and not sub.startswith("longshot/"):
            continue
        m = _RENDER_FILE_RE.fullmatch(name)
        if not m:
            continue
        folder = os.path.join(output_dir, *sub.split("/"))
        if not os.path.realpath(folder).startswith(root) or \
                not os.path.isfile(os.path.join(folder, name)):
            continue
        base = f"{m.group('stem')}_{m.group('n')}"
        want = []
        if png:
            want.append(base + ".png")
        if noaudio and m.group("audio"):
            want.append(f"{base}.{m.group('ext')}")
        for f in want:
            path = os.path.join(folder, f)
            if os.path.isfile(path) and os.path.realpath(path).startswith(root + os.sep):
                out.append(path)
    return list(dict.fromkeys(out))


def remove_render_side_files(output_dir, entries, png=False, noaudio=False):
    """Delete render_side_files(...). Returns the removed paths relative to output/."""
    removed = []
    for path in render_side_files(output_dir, entries, png, noaudio):
        try:
            os.remove(path)
            removed.append(os.path.relpath(path, output_dir).replace(os.sep, "/"))
        except OSError:
            pass
    return removed


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
           "seconds": float(raw["seconds"]) if raw.get("seconds") else None,
           "model": raw.get("model") or None, "refine": raw.get("refine") or None}   # Long Shot 1.7.0
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


def clear_takes_except(output_dir, slug, keep):
    """0.17.17, Delete unapproved takes: every take file of the project but the ones in `keep`
    (the approved Shots' takes), plus any segments left from earlier versions."""
    keep = {k for k in (keep or []) if isinstance(k, str)}
    n = 0
    if not is_slug(slug):
        return 0
    for folder in (takes_folder(output_dir, slug), segments_folder(output_dir, slug)):
        if not os.path.isdir(folder):
            continue
        for f in os.listdir(folder):
            p = os.path.join(folder, f)
            if not os.path.isfile(p) or f in keep:
                continue
            if f.endswith(".safetensors") or f.endswith(".safetensors.tmp"):
                os.remove(p)
                n += 1
    return n


def approved_takes(project):
    """The takes an approved (or locked) Shot uses, including one kept while it's edited."""
    out = set()
    for sh in (project or {}).get("shots") or []:
        if sh.get("kind") == "clip":
            continue
        ed = sh.get("edit_from") or {}
        if sh.get("status") == "approved" or sh.get("was_approved") or sh.get("lock") or ed.get("was_approved") \
                or ed.get("status") == "approved":
            for t in (sh.get("take"), ed.get("take")):
                if isinstance(t, str) and t:
                    out.add(t)
    return out


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
    for v in (project.get("voices") or []) + (project.get("videos") or []):     # 0.17.1: video references too
        if isinstance(v, dict) and (v.get("subfolder") or "").replace("\\", "/").strip("/") == old_sub:
            v["subfolder"] = new_sub
    for sh in project.get("shots") or []:
        clip = sh.get("clip")
        if isinstance(clip, dict) and (clip.get("subfolder") or "").replace("\\", "/").strip("/") == old_sub:
            clip["subfolder"] = new_sub
    _move_video_refs(project, slug, new)
    project["name"] = name
    saved_at = store.save(new, project, force=True)
    store.delete(slug)
    return new, saved_at


def _move_video_refs(project, old, new):
    """The player's videos moved with output/longshot/<old>: point at the new folder."""
    old_root, new_root = f"longshot/{old}", f"longshot/{new}"
    for key in ("last_output", "final_output"):
        out = project.get(key)
        if not isinstance(out, dict):
            continue
        for vkey in ("video", "master"):
            v = out.get(vkey)
            if not isinstance(v, dict):
                continue
            sub = str(v.get("subfolder") or "").replace("\\", "/").strip("/")
            if sub == old_root or sub.startswith(old_root + "/"):
                v["subfolder"] = new_root + sub[len(old_root):]


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
    for v in project.get("voices") or []:          # voice references (audio cards)
        if isinstance(v, dict) and v.get("file"):
            out.append((f"voice:{v.get('id')}", v, "file"))
    for v in project.get("videos") or []:          # 0.17.1: video references (video cards)
        if isinstance(v, dict) and v.get("file"):
            out.append((f"video:{v.get('id')}", v, "file"))
    for sh in project.get("shots") or []:
        clip = sh.get("clip")
        if isinstance(clip, dict) and clip.get("file"):
            out.append((f"clip:{sh.get('id')}", clip, "file"))
        anchor = sh.get("anchor_in")             # frame anchor at the start of this Shot
        if isinstance(anchor, dict) and anchor.get("file"):
            out.append((f"anchor:{sh.get('id')}", anchor, "file"))
    end = project.get("anchor_end")              # frame anchor after the last Shot
    if isinstance(end, dict) and end.get("file"):
        out.append(("anchor:end", end, "file"))
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
    videos = _export_videos(output_dir, slug, project)
    return {"references": refs, "takes": takes, "videos": sum(os.path.getsize(p) for _, p in videos),
            "video_files": len(videos)}


def _video_path(output_dir, v):
    """Full path of a {filename, subfolder} output video, or None."""
    if not isinstance(v, dict) or not v.get("filename"):
        return None
    try:
        sub = _clean_subfolder(v.get("subfolder") or "")
    except ValueError:
        return None
    name = v["filename"]
    if "/" in name or "\\" in name:
        return None
    p = os.path.join(output_dir, *(sub.split("/") if sub else []), name)
    return p if os.path.isfile(p) else None


def _export_videos(output_dir, slug, project):
    """[(name in the zip's videos/, full path)]: every video in the project's
    videos folder, plus the player's videos when they are older renders kept
    elsewhere (output/longshot)."""
    out, names = [], set()
    folder = videos_folder(output_dir, slug)
    for f in list_videos(output_dir, slug):
        out.append((f, os.path.join(folder, f)))
        names.add(f)
    seen = {os.path.realpath(p) for _, p in out}
    for key in ("last_output", "final_output"):
        for vkey in ("video", "master"):
            p = _video_path(output_dir, ((project.get(key) or {}) if isinstance(project.get(key), dict)
                                         else {}).get(vkey))
            if p and os.path.realpath(p) not in seen:
                base, n = os.path.basename(p), 2
                name = base
                while name in names:
                    stem, ext = base.rsplit(".", 1)
                    name, n = f"{stem} ({n}).{ext}", n + 1
                out.append((name, p))
                names.add(name)
                seen.add(os.path.realpath(p))
    return out


def export_project(input_dir, output_dir, project, dest, takes=True, video=False):
    """Write the project, its reference files, and optionally its takes and
    its videos (video=True: everything in output/longshot/<slug>/videos) into
    the zip at `dest`. Missing files are listed, not fatal."""
    import zipfile
    slug = project.get("slug") or slugify(project.get("name"))
    manifest = {"format": EXPORT_FORMAT, "studio_version": STUDIO_VERSION, "slug": slug,
                "name": project.get("name"), "files": [], "missing": [], "takes": [],
                "video": None, "videos": [], "player": {}}
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
        if video:
            by_path = {}
            for name, p in _export_videos(output_dir, slug, project):
                z.write(p, "videos/" + name)
                manifest["videos"].append(name)
                by_path[os.path.realpath(p)] = "videos/" + name
            # which zipped file each of the player's videos is
            for key in ("last_output", "final_output"):
                out = project.get(key) if isinstance(project.get(key), dict) else {}
                for vkey in ("video", "master"):
                    p = _video_path(output_dir, out.get(vkey))
                    if p and os.path.realpath(p) in by_path:
                        manifest["player"][f"{key}.{vkey}"] = by_path[os.path.realpath(p)]
            manifest["video"] = manifest["player"].get("last_output.video")
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
        # Videos go into the new project's videos folder. Exports from 0.5 carry
        # only the last preview, as video/<name>.
        arcs = ["videos/" + str(v) for v in manifest.get("videos") or []]
        old = manifest.get("video")
        if old and str(old).startswith("video/"):
            arcs.append(str(old))
        vdir = videos_folder(output_dir, slug)
        placed_v = {}
        for arc in arcs:
            if arc not in names or arc in placed_v:
                continue
            try:
                fname = clean_upload_name(os.path.basename(arc), ("video",))
            except ValueError:
                continue
            os.makedirs(vdir, exist_ok=True)
            target, n = os.path.join(vdir, fname), 2
            stem, ext = fname.rsplit(".", 1)
            while os.path.exists(target):
                target = os.path.join(vdir, f"{stem} ({n}).{ext}")
                n += 1
            with z.open(arc) as src, open(target, "wb") as dst:
                shutil.copyfileobj(src, dst, 1 << 20)
            placed_v[arc] = os.path.basename(target)
        player = dict(manifest.get("player") or {})
        if old and "last_output.video" not in player:
            player["last_output.video"] = old
        for key in ("last_output", "final_output"):
            out = project.get(key)
            if not isinstance(out, dict):
                project[key] = None
                continue
            for vkey in ("video", "master"):
                arc = player.get(f"{key}.{vkey}")
                if isinstance(out.get(vkey), dict) and arc in placed_v:
                    out[vkey] = dict(out[vkey], filename=placed_v[arc],
                                     subfolder=videos_subfolder(slug), type="output",
                                     workflow=None)     # the first-frame PNG isn't exported
                elif vkey in out:
                    out.pop(vkey)
            if not out.get("video"):
                project[key] = None
        project["name"] = name
    saved_at = store.save(slug, project, force=True)
    return slug, {"saved_at": saved_at, "files": len(placed), "takes": takes_in,
                  "videos": len(placed_v), "missing": manifest.get("missing") or []}


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
