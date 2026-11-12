"""Project JSON -> ComfyUI API prompt for H3 Long Shot Studio.

Pure Python: no torch, no ComfyUI imports, so every rule is unit-testable
without a GPU. What ComfyUI has installed (node classes, VHS video formats)
comes in through `Env`, which the server fills from the live registry.

The graph is built from scratch every time, mirroring the reference
H3 Ref2V Long Shot workflow:

    UNETLoader -> [Sage] -> SigmaShift -> [Turbo LoRA] -> [LoRA x3] -> BasicScheduler
    LoadImage -> ImageScaleToMaxDimension (core) -> Long Shot ref_images.ref_image_k
    Subject chain + Shot chain -> Ref Prompt Builder r2v -> long_shot -> Long Shot
    Long Shot -> VAEDecode + VAEDecodeAudio -> MiniMax H3 Save Video [+ ProRes master]
    [LoadAudio -> TrimAudioDuration -> Song Track / Save Video audio]   (0.8.7: no Video Helper Suite)
"""

from __future__ import annotations

import json
import math
import os
import re
from dataclasses import dataclass, field

from . import film
from . import projects as pj

FPS = 24
CUT_VERB = "the camera cuts to"
MAX_REFERENCES = 9          # Long Shot's ref_images autogrow limit
MAX_SHOTS = 256             # Long Shot's planner limit (1.6.10; 64 from 1.6.1, 16 before)
MAX_SEED = 0xFFFFFFFFFFFFFFFF
OUTPUT_SUBFOLDER = "longshot"
VIDEOS_SUBFOLDER = "videos"     # output/longshot/<slug>/videos
NVENC = "video/nvenc_h264-mp4"
H264 = "video/h264-mp4"
# The ProRes master: the Studio's own VHS format (video_formats/ in this pack),
# fed 16-bit frames so the 10-bit file holds real 10-bit detail. VHS lists a
# format from an added folder by its file name, .json included.
PRORES_FORMAT_FILE = "h3-prores-422hq-10bit.json"
PRORES = "video/" + PRORES_FORMAT_FILE
VHS_PRORES = "video/ProRes"          # VHS's built-in one: 8-bit input in a 10-bit file

# Same table and maths as ComfyUI's ResolutionSelector (1 MP = 1024 x 1024 px,
# rounded to multiples of 32), so sizes match MiniMax's published size table.
ASPECTS = {
    "16:9": (16, 9), "9:16": (9, 16), "1:1": (1, 1), "4:3": (4, 3), "3:4": (3, 4),
    "3:2": (3, 2), "2:3": (2, 3), "21:9": (21, 9),
}
MEGAPIXELS = [0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.98, 1.0, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 2.0]

# Which pack provides each node class, for "missing node" errors.
PACKS = {
    "MiniMaxH3TimelineShot": "H3 Long Shot 1.4.0+ (github.com/r34vtraining/H3_Longshot)",
    "MiniMaxH3Take": "H3 Long Shot 1.6.0+ (github.com/r34vtraining/H3_Longshot)",
    "MiniMaxH3SongCut": "H3 Long Shot 1.6.17+ (github.com/r34vtraining/H3_Longshot)",
    "MiniMaxH3FrameRange": "H3 Long Shot 1.6.2+ (github.com/r34vtraining/H3_Longshot)",
    "MiniMaxH3UpscaleChunk": "H3 Long Shot 1.6.2+ (github.com/r34vtraining/H3_Longshot)",
    "MiniMaxH3SaveAudio": "H3 Long Shot 1.6.2+ (github.com/r34vtraining/H3_Longshot)",
    "MiniMaxH3Clip": "H3 Long Shot 1.5.0+ (github.com/r34vtraining/H3_Longshot)",
    "MiniMaxH3ClipShot": "H3 Long Shot 1.5.0+ (github.com/r34vtraining/H3_Longshot)",
    "MiniMaxH3ClipPixels": "H3 Long Shot 1.5.0+ (github.com/r34vtraining/H3_Longshot)",
    "MiniMaxH3LoadVideo": "H3 Long Shot 1.6.11+",
    "MiniMaxH3Subject": "H3 Prompt Compiler (github.com/r34vtraining/H3_Prompt_Compiler)",
    "MiniMaxH3RefPromptBuilder": "H3 Prompt Compiler (github.com/r34vtraining/H3_Prompt_Compiler)",
    "MiniMaxH3LongShot": "H3 Long Shot 1.4.0+ (github.com/r34vtraining/H3_Longshot)",
    "MiniMaxH3SongTrack": "H3 Long Shot 1.4.0+ (github.com/r34vtraining/H3_Longshot)",
    "MiniMaxH3SigmaShift": "ComfyUI core (update ComfyUI)",
    "MiniMaxH3TurboLoRA": "ComfyUI-MiniMax-H3-Turbo",
    "PathchSageAttentionKJ": "ComfyUI-KJNodes",
    "ImageScaleToMaxDimension": "ComfyUI core (update ComfyUI)",
    "MiniMaxH3SaveVideo": "H3 Long Shot 1.6.11+",
    "LoadAudio": "ComfyUI core",
    "TrimAudioDuration": "ComfyUI core (update ComfyUI)",
    "MelBandRoFormerModelLoader": "ComfyUI-MelBandRoFormer",
    "MiniMaxH3RefModsLoader": "ComfyUI-MiniMaxH3Mod",
    "MelBandRoFormerSampler": "ComfyUI-MelBandRoFormer",
    "RTXVideoSuperResolution": "ComfyUI-NVIDIA-RTX-VSR-Pro (RTX Video Super Resolution)",
    "MiniMaxH3FaceRefine": "H3 Long Shot 1.8.0+ (github.com/r34vtraining/H3_Longshot)",
    "MiniMaxH3PasteFaces": "H3 Long Shot 1.8.1+ (github.com/r34vtraining/H3_Longshot)",
}
VSR_QUALITIES = ["LOW", "MEDIUM", "HIGH", "ULTRA"]


TAKE_NAME_RE = re.compile(r"[A-Za-z0-9_-]{1,64}__\d{1,20}__[0-9a-f]{8}\.safetensors")


def _song_gap(shot, env):
    """0.9.0: the Shots left out of this render right before this one (Long Shot 1.6.17's
    song_gap), so lip sync keeps its place in the song. None when there are none or
    Long Shot is older."""
    gap = str(shot.get("song_gap") or "").strip()
    if not gap or not env.shot_takes("song_gap"):
        return None
    if not re.fullmatch(r"(w\d+|\d+(\.\d+)?)(,(w\d+|\d+(\.\d+)?))*", gap):
        raise BuildError(f"A Shot's song gap {gap!r} isn't seconds or w<frames> separated by commas.")
    return gap


def _clip_nodes(g, n, shot, prev, vae, avae, width, height, env=None):
    """A Clip Shot: VHS Load Video (24 fps, trimmed) → MiniMax H3 Clip → Clip Shot."""
    clip = shot.get("clip") or {}
    if not clip.get("file"):
        raise BuildError(f"Shot {n} is a clip with no video file chosen.")
    try:
        path = pj.input_path_value(clip["file"], clip.get("subfolder", ""))
    except ValueError as err:
        raise BuildError(f"Shot {n}'s clip: {err}") from None
    frames = int(clip.get("frames") or 0)
    if frames < 5 or frames % 17 != 5:
        raise BuildError(f"Shot {n}'s clip length ({frames} frames) isn't a valid length; "
                         f"trim it again.")
    skip = int(round(_num(clip.get("trim_in", 0), f"Shot {n} clip start", 0, 1e6) * FPS))
    # Load it already scaled so it just covers the film's size (one side set, so
    # VHS keeps the aspect); MiniMax H3 Clip centre-crops the rest. A 4K clip is
    # never held in memory at full size.
    cw = ch = 0
    sw, sh = clip.get("width"), clip.get("height")
    if isinstance(sw, (int, float)) and isinstance(sh, (int, float)) and sw > 0 and sh > 0:
        if sw / sh > width / height:
            ch = height + 8
        else:
            cw = width + 8
    # both sides (0.8.7, Long Shot's Load Video): the other one from the clip's aspect
    if cw and isinstance(sw, (int, float)) and sw > 0:
        ch = round(cw * sh / sw)
    elif ch and isinstance(sh, (int, float)) and sh > 0:
        cw = round(ch * sw / sh)
    load = g.add(f"clipload{n}", "MiniMaxH3LoadVideo", f"[Shot {n}] clip video", video=path,
                 force_rate=FPS, width=cw, height=ch, frame_load_cap=frames, skip_first_frames=skip)
    mode = "clip" if clip.get("audio", "clip") == "clip" and clip.get("has_audio", True) else "mute"
    inputs = dict(images=[load[0], 0], vae=vae, audio_vae=avae, width=width, height=height,
                  frames=frames, audio_mode=mode)
    if mode == "clip":
        inputs["audio"] = [load[0], 2]
    prepared = g.add(f"clip{n}", "MiniMaxH3Clip", f"[Shot {n}] clip", **inputs)
    shot_inputs = dict(clip=prepared, shot_id=str(shot.get("id") or f"clip{n}"),
                       join=shot.get("join") if shot.get("join") in ("bridge", "cut") else "bridge")
    if prev is not None:
        shot_inputs["shots"] = prev
    gap = _song_gap(shot, env) if env is not None else None
    if gap:
        shot_inputs["song_gap"] = gap
    return g.add(f"shot{n}", "MiniMaxH3ClipShot", f"[Shot {n}] clip", **shot_inputs)


class BuildError(ValueError):
    """The project can't be turned into a graph; the message is user-facing."""


@dataclass
class Env:
    """What the running ComfyUI has. None means 'unknown, assume yes'."""
    classes: set | None = None
    video_formats: list | None = None
    shot_inputs: set | None = None      # MiniMax H3 Timeline Shot's optional inputs
    nvenc: bool | None = None           # ffmpeg can encode with h264_nvenc here
    planner: object | None = None       # H3 Long Shot's planner module (0.9.2: song positions)
    longshot: tuple | None = None       # H3 Long Shot's version (None: unknown, assume new)

    def longshot_at_least(self, *v) -> bool:
        return self.longshot is None or tuple(self.longshot) >= tuple(v)

    def has(self, cls: str) -> bool:
        return self.classes is None or cls in self.classes

    def shot_takes(self, name: str) -> bool:
        return self.shot_inputs is None or name in self.shot_inputs


@dataclass
class Build:
    prompt: dict
    width: int
    height: int
    chain: list                 # shot ids, in render order
    nodes: dict                 # role -> node id (longshot, combine, ...)
    filename_prefix: str
    video_format: str
    warnings: list = field(default_factory=list)

    def as_dict(self):
        return {"prompt": self.prompt, "width": self.width, "height": self.height,
                "chain": self.chain, "nodes": self.nodes,
                "filename_prefix": self.filename_prefix, "video_format": self.video_format,
                "warnings": self.warnings}


# ---------------------------------------------------------------------------
# Small helpers the front end mirrors
# ---------------------------------------------------------------------------

def output_size(megapixels: float, aspect: str, multiple: int = 32) -> tuple[int, int]:
    """Width and height for a megapixel budget and aspect, as ResolutionSelector."""
    if aspect not in ASPECTS:
        raise BuildError(f"Unknown aspect {aspect!r}. Choose one of {', '.join(ASPECTS)}.")
    mp = float(megapixels)
    if not mp > 0:
        raise BuildError("Resolution must be above 0 MP.")
    w_ratio, h_ratio = ASPECTS[aspect]
    scale = math.sqrt(mp * 1024 * 1024 / (w_ratio * h_ratio))
    width = round(w_ratio * scale / multiple) * multiple
    height = round(h_ratio * scale / multiple) * multiple
    return max(multiple, width), max(multiple, height)


def size_table() -> dict:
    """Every preset size, keyed 'mp|aspect', so the UI can show sizes without
    reimplementing Python's rounding."""
    return {f"{mp:g}|{a}": list(output_size(mp, a)) for mp in MEGAPIXELS for a in ASPECTS}


_UNSAFE = re.compile(r'[\\/:*?"<>|\x00-\x1f]+')


def safe_name(name: str, fallback: str = "untitled") -> str:
    """A project name as a file name: no path separators or characters
    Windows forbids, no leading dots, trimmed."""
    out = str(name or "").strip().strip(".")
    out = _UNSAFE.sub("_", out)
    out = re.sub(r"\.{2,}", "_", out)          # no '..' anywhere
    out = re.sub(r"_{2,}", "_", out).strip().rstrip(".")
    return out[:120] or fallback


def project_slug(project: dict) -> str:
    """The project's fixed slug; also Long Shot's cache_name."""
    slug = project.get("slug")
    return slug if pj.is_slug(slug) else pj.slugify(project.get("name"))


def videos_subfolder(project: dict) -> str:
    """Where this project's renders are saved, under ComfyUI's output folder."""
    return f"{OUTPUT_SUBFOLDER}/{project_slug(project)}/{VIDEOS_SUBFOLDER}"


def active_cast(project: dict) -> list:
    return [c for c in project.get("cast") or [] if not c.get("bypassed")]


MAX_AUDIO_REFS = 3          # Long Shot's ref_audios autogrow limit


def active_voices(project: dict) -> list:
    """Voice references (audio cards in Cast & Scenes) that are on and have a file."""
    return [v for v in project.get("voices") or []
            if isinstance(v, dict) and not v.get("bypassed") and v.get("file")]


def song_ref_on(project: dict) -> bool:
    """0.9.1: the song in the Audio panel goes into every Shot as <Audio 1>, a
    reference audio like the native Reference to Video node's (switch on, file chosen)."""
    a = project.get("audio") or {}
    return bool(a.get("song_ref") and a.get("file"))


def song_slot(project: dict) -> int:
    """1 when the song (or, before 0.8.6, its vocals) takes <Audio 1>, else 0."""
    a = project.get("audio") or {}
    return 1 if song_ref_on(project) or a.get("voice_ref") else 0


SONG_LABEL = "<Audio 1>"
SONG_RETENTION = (f"{SONG_LABEL} (the song): fully_copy - the song is reused as the soundtrack; the singer's "
                  "mouth moves only where its vocals are sung.")

MAX_REF_VIDEOS = 3          # Long Shot's ref_videos autogrow limit
REF_VIDEO_MIN_S, REF_VIDEO_MAX_S = 2.0, 15.0


def active_videos(project: dict) -> list:
    """0.17.1: video references (video cards in Cast & Scenes) that are on and have a file."""
    return [v for v in project.get("videos") or []
            if isinstance(v, dict) and not v.get("bypassed") and v.get("file")]


def video_sound_on(v: dict) -> bool:
    """A video reference whose soundtrack goes in too (it has one, and it's switched on)."""
    return bool(v.get("sound") and v.get("has_audio", True))


def video_audio_count(project: dict) -> int:
    """Video soundtracks take the first <Audio N> labels, before the song and the voices."""
    return sum(1 for v in active_videos(project) if video_sound_on(v))


def video_labels(project: dict) -> dict:
    """{video id: ('<Video N>', '<Audio M>' or None)}."""
    out, audio = {}, 0
    for k, v in enumerate(active_videos(project)):
        a = None
        if video_sound_on(v):
            audio += 1
            a = f"<Audio {audio}>"
        out[str(v.get("id"))] = (f"<Video {k + 1}>", a)
    return out


def song_label(project: dict) -> str:
    """The song's <Audio N>: 1, or after the video soundtracks (0.17.1)."""
    return f"<Audio {video_audio_count(project) + 1}>"


def song_retention(project: dict) -> str:
    return SONG_RETENTION.replace(SONG_LABEL, song_label(project), 1)


def audio_labels(project: dict) -> dict:
    """{voice id: '<Audio N>'}. The song takes <Audio 1> when it's on (0.9.1);
    voice references follow in card order. 0.17.1: video soundtracks come first."""
    base = video_audio_count(project) + song_slot(project)
    return {str(v.get("id")): f"<Audio {base + k + 1}>" for k, v in enumerate(active_voices(project))}


AUDIO_ROLE_WORD = {"sfx": "sound", "ambience": "ambience", "music": "music"}
AUDIO_ROLE_NAME = {"sfx": "sound effect", "ambience": "ambience", "music": "music"}


def audio_role(v: dict) -> str:
    """What an audio reference is for (0.12.0): voice (a timbre for pictures), sfx,
    ambience, music or other (the user's own word)."""
    r = v.get("role") or "voice"
    return r if r in ("voice", "sfx", "ambience", "music", "other") else "voice"


def sound_word(v: dict) -> str:
    """The word in "whose <word> comes from <Audio N>" for a sound of its own."""
    r = audio_role(v)
    return AUDIO_ROLE_WORD.get(r) or (str(v.get("role_text") or "").strip() or "sound")


def voice_keys(project: dict) -> dict:
    """{voice key: '<Audio N>'}: the voices a picture or RefMod can take (0.12.0): voice
    references (by id) and audio RefMods ("refmod:<id>")."""
    labels = audio_labels(project)
    out = {str(v.get("id")): labels[str(v.get("id"))] for v in active_voices(project)
           if audio_role(v) == "voice"}
    for m, label in zip(active_refmods(project), refmod_labels(project)):
        if m.get("kind") == "audio":
            out["refmod:" + str(m.get("id"))] = label
    return out


def voice_retention(project: dict) -> list:
    """retention_analysis lines for the audio references (and audio RefMods that voice
    a picture)."""
    labels, cast = audio_labels(project), active_cast(project)
    mods = [(m, lab) for m, lab in zip(active_refmods(project), refmod_labels(project))]

    def voiced_by(key):
        who = [c.get("label") or picture_label(k) for k, c in enumerate(cast) if c.get("voice") == key]
        who += [m.get("label") or lab for m, lab in mods if m.get("kind") != "audio" and m.get("voice") == key]
        return who

    out = []
    for v in active_voices(project):
        a = labels[str(v.get("id"))]
        if audio_role(v) != "voice":
            name = AUDIO_ROLE_NAME.get(audio_role(v)) or sound_word(v)
            lab = str(v.get("label") or "").strip()
            what = f"{name}{' ' + lab if lab else ''}"
            if v.get("use") == "copy":
                out.append(f"{a} ({what}): fully_copy - the audio is reused as it is.")
            else:
                out.append(f"{a} ({what}): reference - its sound character only; the recording itself is not reused.")
            continue
        who = voiced_by(str(v.get("id")))
        out.append(f"{a} (voice timbre{' of ' + ', '.join(who) if who else ''}): reference - voice timbre, "
                   "pitch and delivery only; none of its words are reused.")
    for m, lab in mods:
        if m.get("kind") == "audio":
            who = voiced_by("refmod:" + str(m.get("id")))
            if who:
                out.append(f"{lab} (voice timbre of {', '.join(who)}): reference - voice timbre, "
                           "pitch and delivery only; none of its words are reused.")
    return out


def live_retention(project: dict, text, warnings=None) -> str:
    """0.22.2: the Style panel's Retention without the lines that name a reference switched off
    (bypassed, or with no file) and no live one: H3 brings in or morphs whatever it's told is there.
    The panel's text stays as it is; only this render leaves them out. Unknown labels (an <OutfitA>
    inside a card's description) are kept."""
    def tag(x):
        x = re.sub(r"[<>]", "", str(x or "")).strip()
        return f"<{x}>" if x else ""
    live, off = set(), set()
    groups = [(project.get("cast") or [], lambda c: bool(c.get("image"))),
              (project.get("videos") or [], lambda v: bool(v.get("file"))),
              (project.get("refmods") or [], lambda m: bool(m.get("name"))),
              (project.get("voices") or [], lambda v: bool(v.get("file")))]
    for items, has_file in groups:
        for it in items:
            if not isinstance(it, dict) or not tag(it.get("label")):
                continue
            (off if it.get("bypassed") or not has_file(it) else live).add(tag(it.get("label")))
    off -= live
    out, dropped = [], []
    for line in str(text or "").strip().splitlines():
        names = set(re.findall(r"<[^<>\n]{1,80}>", line))
        if names & off and not names & live:
            dropped.append(line.strip())
        else:
            out.append(line)
    if dropped and warnings is not None:
        msg = ("Left out of Retention for this render (their cards are switched off): " +
               "; ".join(dropped[:6]) + (" …" if len(dropped) > 6 else ""))
        if msg not in warnings:
            warnings.append(msg)
    return "\n".join(out).strip()


def audio_copied(project: dict) -> bool:
    """Is an audio reference set to Copy (0.12.0)? Then the summary adds "audio reuse"."""
    return any(audio_role(v) != "voice" and v.get("use") == "copy" for v in active_voices(project))


MAX_REFMODS = 8             # Load H3 RefMods' slots
_REFMOD_KIND = {"image": "Picture", "video": "Video", "audio": "Audio"}


def active_refmods(project: dict) -> list:
    """RefMod cards (0.8.6) that are on and name a RefMod."""
    return [m for m in project.get("refmods") or []
            if isinstance(m, dict) and not m.get("bypassed") and m.get("name") and float(m.get("strength", 1) or 0) > 0]


REFMOD_ROLES = ("appearance", "motion", "action", "expression", "pose", "costume", "style", "scene",
                "environment", "camera and cut structure")


def refmod_role(m: dict) -> str:
    """A RefMod's definition (0.12.1): the one picked in its editor, else by kind
    (audio: voice timbre; video: motion; picture: appearance)."""
    if m.get("kind") == "audio":
        return "voice timbre"
    if m.get("role") in REFMOD_ROLES:
        return m["role"]
    return "motion" if m.get("kind") == "video" else "appearance"


def refmod_labels(project: dict) -> list:
    """Each active RefMod's label, numbered after the native references by kind,
    as Long Shot presents them (pictures after the Cast, audio after the voices)."""
    counts = {"image": len(active_cast(project)), "video": len(active_videos(project)),
              "audio": len(audio_labels(project)) + song_slot(project) + video_audio_count(project)}
    out = []
    for m in active_refmods(project):
        kind = m.get("kind") if m.get("kind") in _REFMOD_KIND else "image"
        counts[kind] += 1
        out.append(f"<{_REFMOD_KIND[kind]} {counts[kind]}>")
    return out


def picture_label(k: int) -> str:
    """<Picture N> for the k-th (0-based) non-bypassed cast entry. Never stored."""
    return f"<Picture {k + 1}>"


def active_shots(project: dict) -> list:
    return [s for s in project.get("shots") or [] if not s.get("bypassed")]


def _anchor_file(item):
    return item if isinstance(item, dict) and item.get("file") else None


def frame_anchors(project: dict, shot: dict):
    """(start image, end image) of a generated Shot: the frame anchor at the join
    before it (kept on the Shot as anchor_in) and at the join after it (the next
    active Shot's anchor_in, or the project's anchor_end after the last one).
    No anchor next to a clip: the clip's own frames anchor that join."""
    act = active_shots(project)
    ids = [s.get("id") for s in act]
    if shot.get("kind") == "clip" or shot.get("id") not in ids:
        return None, None
    i = ids.index(shot.get("id"))
    prev = act[i - 1] if i else None
    nxt = act[i + 1] if i + 1 < len(act) else None
    start = None if prev is not None and prev.get("kind") == "clip" else _anchor_file(shot.get("anchor_in"))
    if nxt is None:
        end = _anchor_file(project.get("anchor_end"))
    else:
        end = None if nxt.get("kind") == "clip" else _anchor_file(nxt.get("anchor_in"))
    return start, end


def chain_upto(project: dict, upto=None) -> list:
    """Active Shots up to and including `upto` (a shot id). None = all."""
    shots = active_shots(project)
    if upto is None:
        return shots
    for i, s in enumerate(shots):
        if s.get("id") == upto:
            return shots[:i + 1]
    raise BuildError(f"Shot {upto!r} isn't an active Shot in this project.")


def _seed(value, what: str) -> int:
    if value is None or value == "":
        return -1
    try:
        seed = int(value)
    except (TypeError, ValueError):
        raise BuildError(f"{what} must be a whole number, got {value!r}.") from None
    if seed < -1 or seed > MAX_SEED:
        raise BuildError(f"{what} must be -1 (auto) or between 0 and {MAX_SEED}.")
    return seed


def _num(value, what: str, lo=None, hi=None, kind=float):
    try:
        out = kind(value)
    except (TypeError, ValueError):
        raise BuildError(f"{what} must be a number, got {value!r}.") from None
    if (lo is not None and out < lo) or (hi is not None and out > hi):
        raise BuildError(f"{what} must be between {lo} and {hi}, got {out}.")
    return out


# ---------------------------------------------------------------------------
# The builder
# ---------------------------------------------------------------------------

class _Graph:
    def __init__(self):
        self.nodes = {}

    def add(self, node_id, class_type, title=None, **inputs):
        if node_id in self.nodes:
            raise AssertionError(f"duplicate node id {node_id}")
        node = {"class_type": class_type, "inputs": inputs}
        if title:
            node["_meta"] = {"title": title}
        self.nodes[node_id] = node
        return [node_id, 0]

    def drop_unused(self, *node_ids):
        """Leave out loaders nothing ended up using (e.g. the audio VAE when the song
        replaces every clip's sound)."""
        for nid in node_ids:
            if not any(isinstance(v, list) and v and v[0] == nid
                       for n in self.nodes.values() for v in n["inputs"].values()):
                self.nodes.pop(nid, None)


def _out(link, index):
    return [link[0], index]


CLIPS_SUBFOLDER = "clips"      # output/longshot/<slug>/clips: one video per take


def clips_subfolder(project: dict) -> str:
    return f"{OUTPUT_SUBFOLDER}/{project_slug(project)}/{CLIPS_SUBFOLDER}"


def _codec(fmt):
    return "h264_nvenc" if fmt == NVENC else "libx264"


def _clip_save(g, n, project, images, audio, fmt, name):
    """One take's own clip, through Long Shot's Save Video (0.8.7, was Video Combine)."""
    return g.add(f"clipsave{n}", "MiniMaxH3SaveVideo", f"Clip {name}", images=images, audio=audio,
                 filename_prefix=f"{clips_subfolder(project)}/{name}", codec=_codec(fmt), frame_rate=float(FPS))


def _video_format(env, warnings):
    """NVENC when this machine's ffmpeg can use it, else software h264."""
    no = env.nvenc is False or (env.video_formats is not None and NVENC not in env.video_formats)
    if no:
        warnings.append("NVENC isn't available; saving with the software h264 encoder.")
        return H264
    return NVENC


def _maybe_vsr(g, n, s, images):
    vsr = s.get("rtx_vsr") or {}
    if not vsr.get("on"):
        return images
    quality = vsr.get("quality", "ULTRA")
    if quality not in VSR_QUALITIES:
        raise BuildError(f"RTX Super Resolution quality must be one of {', '.join(VSR_QUALITIES)}.")
    return g.add(f"clipvsr{n}", "RTXVideoSuperResolution", "RTX Video Super Resolution",
                 images=images, resize_type="scale by multiplier",
                 **{"resize_type.scale": _num(vsr.get("scale", 2.0), "RTX upscale factor", 1, 4)},
                 quality=quality)


def _song_slices(g, project, items):
    """0.9.0, "Song in final video": the song's own sound for each item that carries
    song_at / song_len (seconds into the song file), so a take's clip has the music it
    sits under on the film. {index: audio node}; empty when the route is off."""
    audio = project.get("audio") or {}
    if not audio.get("final_override") or not audio.get("file"):
        return {}
    wanted = [(n, it) for n, it in enumerate(items or [], 1)
              if isinstance(it, dict) and it.get("song_len") not in (None, "")]
    if not wanted:
        return {}
    try:
        value = pj.input_path_value(audio["file"], audio.get("subfolder", ""))
    except ValueError as err:
        raise BuildError(f"Audio file: {err}") from None
    raw = g.add("song_file", "LoadAudio", "Song", audio=value)
    out = {}
    for n, it in wanted:
        out[n] = g.add(f"songcut{n}", "TrimAudioDuration", f"Song for clip {n}", audio=raw,
                       start_index=_num(it.get("song_at", 0), "Song position", 0, 1e7),
                       duration=_num(it.get("song_len"), "Song length", 0.01, 1e5))
    return out


def build_take_clips(project: dict, takes: list, env: Env | None = None) -> Build:
    """Decode takes on their own into clips: [{key, take}] -> one branch each
    (MiniMax H3 Take -> VAE Decode (+audio) -> Video Combine into clips/).
    Nothing samples and nothing is stitched."""
    env = env or Env()
    s = project.get("settings") or {}
    need = ["MiniMaxH3Take", "VAELoader", "VAEDecode", "VAEDecodeAudio", "MiniMaxH3SaveVideo"]
    if (s.get("rtx_vsr") or {}).get("on"):
        need.append("RTXVideoSuperResolution")
    missing = [c for c in need if not env.has(c)]
    if missing:
        raise BuildError("ComfyUI is missing node(s) this needs:\n  " +
                         "\n  ".join(f"{c} — from {PACKS.get(c, 'ComfyUI core')}" for c in missing))
    for key in ("video_vae", "audio_vae"):
        if not s.get(key):
            raise BuildError(f"Settings: choose a {key.replace('_', ' ')} file.")
    warnings = []
    fmt = _video_format(env, warnings)
    g = _Graph()
    vae = g.add("vae_video", "VAELoader", "Video VAE", vae_name=s["video_vae"])
    avae = g.add("vae_audio", "VAELoader", "Audio VAE", vae_name=s["audio_vae"])
    clips = {}
    songs = _song_slices(g, project, takes)
    for n, t in enumerate(takes or [], 1):
        key, take = str(t.get("key") or ""), str(t.get("take") or "")
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,160}", key) or not TAKE_NAME_RE.fullmatch(take):
            raise BuildError(f"Not a take: {take!r}")
        lat = g.add(f"take{n}", "MiniMaxH3Take", f"Take {take}", cache_name=project_slug(project),
                    take=take, shot_id="")
        images = _maybe_vsr(g, n, s, g.add(f"clipdec{n}", "VAEDecode", "VAE Decode", samples=lat, vae=vae))
        audio = songs.get(n) or g.add(f"clipaud{n}", "VAEDecodeAudio", "VAE Decode Audio", samples=lat, vae=avae)
        clips[key] = _clip_save(g, n, project, images, audio, fmt, key)[0]
    if not clips:
        raise BuildError("No takes to make clips for.")
    g.drop_unused("vae_audio")
    return Build(prompt=g.nodes, width=0, height=0, chain=[], nodes={"clips": clips},
                 filename_prefix=clips_subfolder(project), video_format=fmt, warnings=warnings)


def _export_project(project: dict, takes: set) -> dict:
    """0.10.0: the film cut down to the Shots being exported (locked to their takes), so
    Long Shot refines just those, in film order. A Shot whose film neighbour is left out
    starts fresh (Cut) instead of continuing from a Shot that isn't there."""
    import copy
    p = copy.deepcopy(project)
    last_kept = False
    for sh in p.get("shots") or []:
        if sh.get("bypassed"):
            continue
        lock = sh.get("lock") or (sh.get("take") if sh.get("status") in ("approved", "review") else None)
        keep = sh.get("kind") != "clip" and lock in takes
        if keep:
            sh["lock"] = lock
            if sh.get("window"):
                sh["frames"] = sh.get("window")
            if not last_kept:
                sh["join"] = "cut"
        else:
            sh["bypassed"] = True
            sh["left_out"] = True
        last_kept = keep
    return p


def build_take_audio(project: dict, take: str, env: Env | None = None) -> Build:
    """0.11.0, Align to song: a take's own audio (H3's performance) as a WAV, so the
    Studio can measure how far it is from the song. Nothing is sampled."""
    env = env or Env()
    s = project.get("settings") or {}
    need = ["MiniMaxH3Take", "VAELoader", "VAEDecodeAudio", "MiniMaxH3SaveAudio"]
    missing = [c for c in need if not env.has(c)]
    if missing:
        raise BuildError("ComfyUI is missing node(s) this needs:\n  " +
                         "\n  ".join(f"{c} — from {PACKS.get(c, 'ComfyUI core')}" for c in missing))
    if not s.get("audio_vae"):
        raise BuildError("Settings: choose an audio vae file.")
    take = str(take or "")
    if not TAKE_NAME_RE.fullmatch(take):
        raise BuildError(f"Not a take: {take!r}")
    g = _Graph()
    avae = g.add("vae_audio", "VAELoader", "Audio VAE", vae_name=s["audio_vae"])
    lat = g.add("take", "MiniMaxH3Take", f"Take {take}", cache_name=project_slug(project), take=take, shot_id="")
    aud = g.add("aud", "VAEDecodeAudio", "VAE Decode Audio", samples=lat, vae=avae)
    prefix = f"{OUTPUT_SUBFOLDER}/{project_slug(project)}/_align/{take[:-len('.safetensors')]}"
    g.add("wav", "MiniMaxH3SaveAudio", "Take audio", audio=aud, filename_prefix=prefix)
    return Build(prompt=g.nodes, width=0, height=0, chain=[], nodes={"audio": "wav"},
                 filename_prefix=prefix, video_format="", warnings=[])


STEM_SOURCE_EXT = (".mp4", ".mov", ".wav", ".flac", ".mp3", ".m4a")


def build_stems(project: dict, stems: dict, env: Env | None = None) -> Build:
    """0.17.28, Stems: each exported clip / final video split into its dialogue and the rest
    (sound effects, ambience, music) with MelBand RoFormer, as two WAVs. stems = {model,
    items: [{source, dx, fx}]}: the source with its extension, the two stems without (0.17.30:
    approved clips' stems go to Approved_Audio/Dialogue and Approved_Audio/SFX); {source, out}
    puts them next to it as <out>_dialogue.wav and <out>_sfx.wav. All inside the project's
    output folder."""
    env = env or Env()
    need = ["LoadAudio", "MelBandRoFormerModelLoader", "MelBandRoFormerSampler", "MiniMaxH3SaveAudio"]
    missing = [c for c in need if not env.has(c)]
    if missing:
        raise BuildError("Stems need node(s) ComfyUI doesn't have:\n  " +
                         "\n  ".join(f"{c} — from {PACKS.get(c, 'ComfyUI core')}" for c in missing))
    stems = stems if isinstance(stems, dict) else {}
    model = str(stems.get("model") or "").strip()
    if not model:
        raise BuildError("Stems need the MelBand RoFormer model (MelBandRoformer_fp16.safetensors) in "
                         "models/diffusion_models.")
    root = f"{OUTPUT_SUBFOLDER}/{project_slug(project)}/"
    items = [x for x in (stems.get("items") or []) if isinstance(x, dict)]
    if not items:
        raise BuildError("Nothing to split into stems.")
    if len(items) > 64:                 # 0.17.31: never cut short quietly (the Studio sends 32 a run)
        raise BuildError(f"One run splits at most 64 files into stems ({len(items)} sent).")

    def inside(p, what):
        p = str(p or "").replace("\\", "/").strip("/")
        if not p.startswith(root) or ".." in p.split("/") or len(p) > 400:
            raise BuildError(f"{what} must be inside this project's output folder.")
        return p

    g = _Graph()
    mel = g.add("melband", "MelBandRoFormerModelLoader", "MelBand RoFormer", model_name=model)
    nodes = {}
    for i, it in enumerate(items, 1):
        src = inside(it.get("source"), "A stem's source")
        if not src.lower().endswith(STEM_SOURCE_EXT):
            raise BuildError(f"Can't read the sound of {src.rsplit('/', 1)[-1]}.")
        if it.get("dx") or it.get("fx"):
            dx, fx = inside(it.get("dx"), "A stem's file"), inside(it.get("fx"), "A stem's file")
        else:
            out = inside(it.get("out"), "A stem's file")
            dx, fx = out + "_dialogue", out + "_sfx"
        load = g.add(f"load{i}", "LoadAudio", f"Sound of {src.rsplit('/', 1)[-1]}", audio=f"{src} [output]")
        sep = g.add(f"sep{i}", "MelBandRoFormerSampler", "Dialogue / the rest", model=mel, audio=load)
        g.add(f"dx{i}", "MiniMaxH3SaveAudio", "Dialogue stem", audio=[sep[0], 0], filename_prefix=dx)
        g.add(f"fx{i}", "MiniMaxH3SaveAudio", "SFX stem", audio=[sep[0], 1], filename_prefix=fx)
        nodes[str(i)] = {"dialogue": f"dx{i}", "sfx": f"fx{i}"}
    return Build(prompt=g.nodes, width=0, height=0, chain=[], nodes={"stems": nodes},
                 filename_prefix=root, video_format="", warnings=[])


def build_clip_export(project: dict, items: list, env: Env | None = None) -> Build:
    """Export approved clips, upscaled: [{take, n}] -> one branch each. The take
    is decoded on its own, whole (MiniMax H3 Take -> VAE Decode), upscaled a
    frame at a time straight into a file (MiniMax H3 Upscale Chunk) and its sound
    saved as a WAV, into Approved_Clips/_work; the server then adds the sound.
    The project's ProRes master setting also makes a ProRes copy of each clip."""
    env = env or Env()
    s = project.get("settings") or {}
    # 0.10.0: with the refine pass, the takes are refined first (Long Shot, in film order;
    # kept and reused), and the export is made from the refined takes, upscaled or not
    rc = refine_settings(project, env)
    upscale = bool(s.get("export_upscale")) or rc is None
    faced = any((it or {}).get("face_clip") for it in items or [])
    need = ["MiniMaxH3Take", "VAELoader", "VAEDecode", "VAEDecodeAudio", "MiniMaxH3UpscaleChunk",
            "MiniMaxH3SaveAudio"] + (["RTXVideoSuperResolution"] if upscale else []) + \
        (["MiniMaxH3LoadVideo"] if faced else [])
    missing = [c for c in need if not env.has(c)]
    if missing:
        raise BuildError("ComfyUI is missing node(s) this needs:\n  " +
                         "\n  ".join(f"{c} — from {PACKS.get(c, 'ComfyUI core')}" for c in missing))
    for key in ("video_vae", "audio_vae"):
        if not s.get(key):
            raise BuildError(f"Settings: choose a {key.replace('_', ' ')} file.")
    base = None
    if rc is not None:
        takes = {str((it or {}).get("take") or "") for it in items or []}
        xp = _export_project(project, takes)
        if any(not sh.get("bypassed") for sh in xp.get("shots") or []):
            base = build_prompt(xp, env=env, long_shot_only=True, refine_export=True)
    vsr = s.get("rtx_vsr") or {}
    quality = vsr.get("quality", "ULTRA")
    if quality not in VSR_QUALITIES:
        raise BuildError(f"RTX Super Resolution quality must be one of {', '.join(VSR_QUALITIES)}.")
    scale = _num(vsr.get("scale", 2.0), "RTX upscale factor", 1, 4) if upscale else 1.0
    warnings = list(base.warnings) if base is not None else []
    fmt = _video_format(env, warnings)
    work = f"{OUTPUT_SUBFOLDER}/{project_slug(project)}/Approved_Clips/_work"
    g = _Graph()
    if base is not None:
        g.nodes.update(base.prompt)
    vae = ["vae_video", 0] if "vae_video" in g.nodes else g.add("vae_video", "VAELoader", "Video VAE", vae_name=s["video_vae"])
    avae = ["vae_audio", 0] if "vae_audio" in g.nodes else g.add("vae_audio", "VAELoader", "Audio VAE", vae_name=s["audio_vae"])
    refine_in = dict(refine=rc["key"], after=["longshot", 1]) if base is not None else {}
    out = {}
    songs = _song_slices(g, project, items)
    for n, it in enumerate(items or [], 1):
        take = str((it or {}).get("take") or "")
        if not TAKE_NAME_RE.fullmatch(take):
            raise BuildError(f"Not a take: {take!r}")
        own = {}
        rk = str((it or {}).get("refine") or "")
        if not refine_in and rk:
            # 0.17.8: a Shot set to its refined take (Refine this Shot), already on disk
            if not re.fullmatch(r"r[0-9a-f]{12}", rk):
                raise BuildError(f"Not a refine key: {rk!r}")
            own = {"refine": rk}
        lat = g.add(f"take{n}", "MiniMaxH3Take", f"Take {take}", cache_name=project_slug(project),
                    take=take, shot_id="", **(refine_in or own))
        fclip = str((it or {}).get("face_clip") or "")
        if fclip:
            # 0.15.0: a Shot set to Refined exports its approved face-refined clip, as it was made
            if not re.fullmatch(r"[A-Za-z0-9_-]{1,160}", fclip):
                raise BuildError(f"Not a clip: {fclip!r}")
            images = g.add(f"facevid{n}", "MiniMaxH3LoadVideo", f"Refined clip {n}",
                           video=f"{clips_subfolder(project)}/{fclip}.mp4 [output]", skip_first_frames=0,
                           # the take's own frames (some ffmpeg builds add a few at the end)
                           frame_load_cap=int(_num((it or {}).get("frames", 0) or 0, "Frames", 0, 1e6)),
                           width=0, height=0, force_rate=float(FPS))
        else:
            images = g.add(f"dec{n}", "VAEDecode", "VAE Decode", samples=lat, vae=vae)
        # 0.9.0: the Shot's trims (frames off its take's start / end); a song slice is already cut to them
        start = int(_num((it or {}).get("trim_in", 0) or 0, "Trim", 0, 1e6))
        length = int(_num((it or {}).get("length", 0) or 0, "Length", 0, 1e7)) or 10_000_000
        audio = songs.get(n)
        if audio is None:
            audio = g.add(f"aud{n}", "VAEDecodeAudio", "VAE Decode Audio", samples=lat, vae=avae)
            if start or length < 10_000_000:
                audio = g.add(f"audtrim{n}", "TrimAudioDuration", f"Sound of clip {n}, trimmed", audio=audio,
                              start_index=start / FPS, duration=length / FPS if length < 10_000_000 else 1e7)
        g.add(f"up{n}", "MiniMaxH3UpscaleChunk", f"Upscale clip {n}", images=images, start=start,
              length=length, scale=scale, quality=quality, filename_prefix=f"{work}/c{n:03d}",
              codec="h264_nvenc" if fmt == NVENC else "libx264",
              master_prefix=f"{work}/c{n:03d}_master" if s.get("prores_master") else "", frame_rate=float(FPS))
        g.add(f"wav{n}", "MiniMaxH3SaveAudio", f"Sound of clip {n}", audio=audio,
              filename_prefix=f"{work}/c{n:03d}_audio")
        out[str(n)] = {"video": f"up{n}", "audio": f"wav{n}"}
    if not out:
        raise BuildError("No approved Shots to export.")
    g.drop_unused("vae_audio")
    return Build(prompt=g.nodes, width=0, height=0, chain=[], nodes={"export": out},
                 filename_prefix=work, video_format=fmt, warnings=warnings)


def required_classes(project: dict, dry_run: bool = False, final: bool = False, final_upscale: bool = True) -> list:
    """Node classes the build will use, given the project's toggles."""
    s = project.get("settings") or {}
    a = project.get("audio") or {}
    need = ["UNETLoader", "MiniMaxH3SigmaShift", "CLIPLoader", "VAELoader", "BasicScheduler",
            "KSamplerSelect", "RandomNoise", "MiniMaxH3TimelineShot", "MiniMaxH3RefPromptBuilder",
            "MiniMaxH3LongShot", "VAEDecode", "MiniMaxH3SaveVideo"]
    if not a.get("final_override"):
        need.append("VAEDecodeAudio")
    if active_cast(project):
        need += ["LoadImage", "ImageScaleToMaxDimension", "MiniMaxH3Subject"]
    if active_videos(project):
        need += ["MiniMaxH3LoadVideo", "MiniMaxH3Subject"]
    if (s.get("turbo") or {}).get("on"):
        need.append("MiniMaxH3TurboLoRA")
    r = s.get("refine") or {}
    if r.get("on") and r.get("model") and (r.get("turbo") or {}).get("on"):
        need.append("MiniMaxH3TurboLoRA")
    if any(l.get("on") and l.get("name") for l in s.get("loras") or []):
        need.append("LoraLoaderModelOnly")
    if (final and final_upscale) or (not final and (s.get("rtx_vsr") or {}).get("on")):
        need.append("RTXVideoSuperResolution")
    if any(sh.get("kind") == "clip" for sh in active_shots(project)):
        need += ["MiniMaxH3LoadVideo", "MiniMaxH3Clip", "MiniMaxH3ClipShot"]
        if final and s.get("clip_pixels"):
            need.append("MiniMaxH3ClipPixels")
    if a.get("lip_sync") or a.get("voice_ref") or a.get("final_override") or active_voices(project) \
            or song_ref_on(project):
        need += ["LoadAudio", "TrimAudioDuration"]
    if a.get("lip_sync"):
        need.append("MiniMaxH3SongTrack")
    if a.get("voice_ref"):
        need += ["MelBandRoFormerModelLoader", "MelBandRoFormerSampler"]
    if active_refmods(project):
        need += ["MiniMaxH3RefModsLoader", "MiniMaxH3Subject"]
    return need


REFINE_DEFAULTS = {"on": False, "export_only": False, "model": None, "steps": 10, "denoise": 0.3,
                   "shift_video": 12.0, "turbo": {"on": False, "lora": None, "strength": 1.0}}


def refine_settings(project: dict, env: "Env | None" = None):
    """0.10.0: the Refine panel's settings when the refine pass applies (on, a model chosen
    that isn't the render model, H3 Long Shot 1.7.0+), with its key; else None."""
    s = project.get("settings") or {}
    r = dict(REFINE_DEFAULTS, **(s.get("refine") or {}))
    r["turbo"] = dict(REFINE_DEFAULTS["turbo"], **(r.get("turbo") or {}))
    if not r.get("on") or not r.get("model") or r["model"] == s.get("model"):
        return None
    if env is not None and not env.longshot_at_least(1, 7, 0):
        return None
    r["steps"] = int(_num(r.get("steps", 10), "Refine steps", 1, 200, int))
    r["denoise"] = _num(r.get("denoise", 0.3), "Refine denoise", 0.01, 1.0)
    r["shift_video"] = _num(r.get("shift_video", 12), "Refine video shift", 0.01, 100)
    r["shift_audio"] = _num(s.get("shift_audio", 3), "Audio shift", 0.01, 100)
    r["scheduler"] = s.get("scheduler", "beta")
    t = r["turbo"]
    if t.get("on") and not t.get("lora"):
        raise BuildError("Refine: Turbo is on but no Turbo LoRA file is chosen.")
    import hashlib
    ident = json.dumps([r["model"], r["steps"], round(r["denoise"], 4), round(r["shift_video"], 4),
                        round(r["shift_audio"], 4), r["scheduler"], s.get("sampler", "er_sde"),
                        bool(t.get("on")), t.get("lora") if t.get("on") else None,
                        round(float(t.get("strength", 1) or 0), 4) if t.get("on") else None])
    r["key"] = "r" + hashlib.sha1(ident.encode()).hexdigest()[:12]
    return r


def _refine_nodes(g, project, r, env, sage):
    """The refine model (its own model sampling and Turbo LoRA) and its sigmas."""
    model = g.add("refine_unet", "UNETLoader", "Refine model", unet_name=r["model"],
                  weight_dtype=(project.get("settings") or {}).get("weight_dtype", "default"))
    if sage and env.has("PathchSageAttentionKJ"):
        model = g.add("refine_sage", "PathchSageAttentionKJ", "Patch Sage Attention KJ (refine)",
                      model=model, sage_attention=sage, allow_compile=False)
    model = g.add("refine_shift", "MiniMaxH3SigmaShift", "ModelSamplingMiniMaxH3 (refine)", model=model,
                  shift_video=r["shift_video"], shift_audio=r["shift_audio"])
    t = r["turbo"]
    if t.get("on"):
        strength = _num(t.get("strength", 1.0), "Refine Turbo strength", -10, 10)
        if env.has("MiniMaxH3TurboLoRA"):
            model = g.add("refine_turbo", "MiniMaxH3TurboLoRA", "Turbo LoRA (refine)", model=model,
                          lora_name=t["lora"], strength=strength, low_vram=False)
        else:
            model = g.add("refine_turbo", "LoraLoaderModelOnly", "Turbo LoRA (refine)", model=model,
                          lora_name=t["lora"], strength_model=strength)
    sigmas = g.add("refine_scheduler", "BasicScheduler", "BasicScheduler (refine)", model=model,
                   scheduler=r["scheduler"], steps=r["steps"], denoise=r["denoise"])
    return model, sigmas


# ---------------------------------------------------------------------------
# Face refine (0.14.0, Long Shot 1.8.0): small faces redrawn by H3 as close-ups
# ---------------------------------------------------------------------------

FACE_DEFAULTS = {"on": True, "model": None, "steps": 10, "denoise": 0.3, "shift_video": 4.0,
                 "turbo": {"on": False, "lora": None, "strength": 1.0},
                 "max_face": 150, "which": "all", "work": 640, "padding": 0.8, "follow": "auto",
                 "mask": 1.0, "feather": 0.3, "color": 1.0, "hold_audio": True, "seed": 0,
                 "describe": "", "cast": None}
FACE_FOLLOW = ("auto", "fixed", "follow")
FACE_WHICH = ("all", "largest")
FACE_CLIP_SUFFIX = "__face"


def face_prompt(with_ref=False, label="the person", describe=""):
    """The close-up's prompt (the same as Long Shot's face_prompt): a face filling the
    frame that keeps its expression and mouth movement. with_ref: ref2va's sections,
    with <Picture 1> as the face's identity."""
    who = (describe or "").strip().rstrip(".")
    look = f" {who[0].upper() + who[1:]}." if who else ""
    action = ("The face keeps exactly the same expression, head movement, eye movement and mouth "
              "movement as before, in time with the sound. Sharp natural detail in the eyes, eyelashes, "
              "skin texture, lips and teeth. The camera is static.")
    sound = "overall_soundscape: The person's own voice and the room around them, unchanged.\nnon_diegetic_music: N/A"
    if not with_ref:
        return ("integrated_multimodal_description: [Shot 1] Cinematic, live-action, realistic. "
                f"An extreme close-up of a person's face filling most of the frame.{look} {action}\n" + sound)
    name = (label or "").strip() or "the person"
    return (f"subject_definitions: <Subject 1> is {name}, whose face and appearance come from <Picture 1>.\n"
            "summary: [reference generation] An extreme close-up of <Subject 1>'s face.\n"
            "retention_analysis: <Subject 1> (appears in [Shot 1]): fully_preserved - face, identity, "
            "hairstyle and skin tone.\n"
            "detailed_description: Cinematic, live-action, realistic. [Shot 1] An extreme close-up of "
            f"<Subject 1>'s face filling most of the frame.{look} {action}\n" + sound)


def face_identity(project: dict, f: dict):
    """The Cast member whose picture is the face's identity (ref2va only), or None."""
    cid = f.get("cast")
    if not cid or "fl2v" in str(f.get("model") or "").lower():
        return None
    for c in project.get("cast") or []:
        if isinstance(c, dict) and str(c.get("id")) == str(cid) and c.get("image") and not c.get("bypassed"):
            return c
    return None


def shot_face_on(shot: dict) -> bool:
    """0.15.0: the Shot is set to Refined, with a refined clip of the take it uses."""
    f = shot.get("face")
    take = shot.get("lock") or shot.get("take")
    return (isinstance(f, dict) and f.get("keep") == "refined" and bool(take) and f.get("take") == take
            and bool(TAKE_NAME_RE.fullmatch(str(take))))


def face_rows(f: dict) -> list:
    """The redrawn faces' boxes from a Shot's refine report: one list per face."""
    treated = {c.get("track") for c in f.get("crops") or []}
    return [t.get("boxes") or [] for t in f.get("tracks") or [] if t.get("id") in treated and t.get("boxes")]


def face_shapes(f: dict) -> list:
    """0.17.38: each redrawn face's mask shape, in face_rows' order ("rect" for a region)."""
    treated = {c.get("track") for c in f.get("crops") or []}
    return [t.get("shape") or "oval" for t in f.get("tracks") or [] if t.get("id") in treated and t.get("boxes")]


def region_prompt(what="", with_ref=False, label=""):
    """0.17.38: the close-up's prompt for a region drawn by hand: what's in it (the user's
    words), kept moving as before with sharper detail. with_ref: <Picture 1> as who it is."""
    what = (what or "").strip().rstrip(".") or "the characters"
    action = ("Everything keeps exactly the same pose, movement, expression and timing as before. Sharp clean "
              "detail in the faces, eyes, fur, fabric and materials. The camera is static.")
    sound = "overall_soundscape: The scene's own sound, unchanged.\nnon_diegetic_music: N/A"
    if not with_ref:
        return ("integrated_multimodal_description: [Shot 1] Cinematic, high detail. "
                f"A close-up of {what}, filling most of the frame. {action}\n" + sound)
    name = (label or "").strip() or "the characters"
    return (f"subject_definitions: <Subject 1> is {name}, whose appearance comes from <Picture 1>.\n"
            f"summary: [reference generation] A close-up of {what}.\n"
            "retention_analysis: <Subject 1> (appears in [Shot 1]): fully_preserved - face, design, colours and materials.\n"
            f"detailed_description: Cinematic, high detail. [Shot 1] A close-up of {what}, filling most of the frame. {action}\n" + sound)


def face_settings(project: dict, env: "Env | None" = None, strict: bool = True):
    """0.14.0: the Face refine panel's settings when it applies (a model chosen, H3 Long Shot
    1.8.0 with its Face Refine node), with `key` naming the redraw model and settings, `sig`
    all of what the result depends on and `text` the prompt; else None. 0.17.15: manual only
    (Refine this Shot), so there's no on / off switch any more."""
    s = project.get("settings") or {}
    f = dict(FACE_DEFAULTS, **(s.get("face") or {}))
    f["turbo"] = dict(FACE_DEFAULTS["turbo"], **(f.get("turbo") or {}))
    if not f.get("model"):
        return None
    if env is not None and (not env.longshot_at_least(1, 8, 0) or not env.has("MiniMaxH3FaceRefine")):
        if strict:
            raise BuildError("Face refine needs H3 Long Shot 1.8.0 or later. Update it, then restart ComfyUI.")
        return None
    f["steps"] = int(_num(f.get("steps", 10), "Face refine steps", 1, 200, int))
    f["denoise"] = _num(f.get("denoise", 0.3), "Face refine denoise", 0.01, 1.0)
    f["shift_video"] = _num(f.get("shift_video", 4), "Face refine video shift", 0.01, 100)
    f["shift_audio"] = _num(s.get("shift_audio", 3), "Audio shift", 0.01, 100)
    f["max_face"] = int(_num(f.get("max_face", 150), "Face size", 8, 4096, int))
    f["work"] = int(_num(f.get("work", 640), "Close-up size", 256, 1536, int)) // 32 * 32
    f["padding"] = _num(f.get("padding", 0.8), "Room around the face", 0.2, 3.0)
    f["mask"] = _num(f.get("mask", 1.0), "Mask size", 0.5, 2.5)
    f["feather"] = _num(f.get("feather", 0.3), "Feather", 0.02, 1.0)
    f["color"] = _num(f.get("color", 1.0), "Colour match", 0.0, 1.0)
    f["seed"] = max(0, _seed(f.get("seed", 0), "Face refine seed"))
    if f.get("follow") not in FACE_FOLLOW:
        f["follow"] = "auto"
    if f.get("which") not in FACE_WHICH:
        f["which"] = "all"
    f["scheduler"] = s.get("scheduler", "beta")
    f["sampler"] = s.get("sampler", "er_sde")
    t = f["turbo"]
    if t.get("on") and not t.get("lora"):
        raise BuildError("Face refine: Turbo is on but no Turbo LoRA file is chosen.")
    who = face_identity(project, f)
    f["identity"] = who
    f["text"] = face_prompt(with_ref=who is not None, label=(who or {}).get("label") or "the person",
                            describe=f.get("describe", ""))
    import hashlib
    ident = json.dumps([f["model"], f["steps"], round(f["denoise"], 4), round(f["shift_video"], 4),
                        round(f["shift_audio"], 4), f["scheduler"], f["sampler"], s.get("clip"), s.get("video_vae"),
                        bool(t.get("on")), t.get("lora") if t.get("on") else None,
                        round(float(t.get("strength", 1) or 0), 4) if t.get("on") else None,
                        f["work"], bool(f.get("hold_audio", True))])
    f["key"] = "x" + hashlib.sha1(ident.encode()).hexdigest()[:12]
    f["sig"] = hashlib.sha1(json.dumps([f["key"], f["text"], f["seed"], f["max_face"], f["which"],
                                        round(f["padding"], 3), f["follow"], round(f["mask"], 3),
                                        round(f["feather"], 3), round(f["color"], 3),
                                        (who or {}).get("image")]).encode()).hexdigest()[:12]
    return f


def face_sig(project: dict, env: "Env | None" = None):
    """The current Face refine settings' signature (None when it doesn't apply)."""
    try:
        f = face_settings(project, env, strict=False)
    except BuildError:
        return None
    return f["sig"] if f else None


def _face_nodes(g, project, f, env):
    """The redraw model (its own model sampling and Turbo LoRA), sigmas, sampler, noise,
    CLIP, VAE and the identity picture, added once per graph."""
    s = project.get("settings") or {}
    if "face_unet" in g.nodes:
        return g.face
    model = g.add("face_unet", "UNETLoader", "Face refine model", unet_name=f["model"],
                  weight_dtype=s.get("weight_dtype", "default"))
    sage = s.get("sage_attention", "auto")
    if sage and sage not in ("disabled", "off", False) and env.has("PathchSageAttentionKJ"):
        model = g.add("face_sage", "PathchSageAttentionKJ", "Patch Sage Attention KJ (face)",
                      model=model, sage_attention=sage, allow_compile=False)
    model = g.add("face_shift", "MiniMaxH3SigmaShift", "ModelSamplingMiniMaxH3 (face)", model=model,
                  shift_video=f["shift_video"], shift_audio=f["shift_audio"])
    t = f["turbo"]
    if t.get("on"):
        strength = _num(t.get("strength", 1.0), "Face refine Turbo strength", -10, 10)
        if env.has("MiniMaxH3TurboLoRA"):
            model = g.add("face_turbo", "MiniMaxH3TurboLoRA", "Turbo LoRA (face)", model=model,
                          lora_name=t["lora"], strength=strength, low_vram=False)
        else:
            model = g.add("face_turbo", "LoraLoaderModelOnly", "Turbo LoRA (face)", model=model,
                          lora_name=t["lora"], strength_model=strength)
    clip = ["clip", 0] if "clip" in g.nodes else g.add("clip", "CLIPLoader", "Load CLIP", clip_name=s["clip"],
                                                       type="minimax", device="default")
    vae = ["vae_video", 0] if "vae_video" in g.nodes else g.add("vae_video", "VAELoader", "Video VAE",
                                                                vae_name=s["video_vae"])
    out = dict(model=model, clip=clip, vae=vae,
               sigmas=g.add("face_scheduler", "BasicScheduler", "BasicScheduler (face)", model=model,
                            scheduler=f["scheduler"], steps=f["steps"], denoise=f["denoise"]),
               sampler=g.add("face_sampler", "KSamplerSelect", "KSamplerSelect (face)", sampler_name=f["sampler"]),
               noise=g.add("face_noise", "RandomNoise", "RandomNoise (face)", noise_seed=f["seed"]))
    who = f.get("identity")
    if who:
        try:
            image = pj.input_path_value(who["image"], who.get("subfolder", ""))
        except ValueError as err:
            raise BuildError(f"Face refine identity ({who.get('label') or 'Cast'}): {err}") from None
        out["ref"] = g.add("face_ref", "LoadImage", f"Face identity {who.get('label', '')}".strip(), image=image)
    g.face = out
    return out


def _face_node(g, nid, project, f, env, images, latent, skip=None, title="Face refine", regions=None, text=None):
    """MiniMax H3 Face Refine over `images` (decoded from `latent`). 0.17.38: regions (JSON)
    drawn by hand replace the found faces, with their own prompt (text)."""
    m = _face_nodes(g, project, f, env)
    extra = {"ref_image": m["ref"]} if m.get("ref") else {}
    if skip:
        extra["skip"] = json.dumps([[int(a), int(b)] for a, b in skip])
    if regions:
        extra["regions"] = regions
    return g.add(nid, "MiniMaxH3FaceRefine", title, images=images, latent=latent, model=m["model"],
                 clip=m["clip"], vae=m["vae"], noise=m["noise"], sampler=m["sampler"], sigmas=m["sigmas"],
                 text=text if text else f["text"], max_face=f["max_face"], which=f["which"], work_size=f["work"],
                 padding=f["padding"], follow=f["follow"], mask_scale=f["mask"], feather=f["feather"],
                 color_match=f["color"], hold_audio=bool(f.get("hold_audio", True)), max_window=362,
                 cache_name=project_slug(project), cache_key=f["key"], detect_every=2, enabled=True, **extra)


# ---------------------------------------------------------------------------
# Face swap (0.18.0, Long Shot 1.9.0): a take or any video, each face given the identity
# of a Cast picture by the ref2va model, saved in <project>/Face_Swap
# ---------------------------------------------------------------------------

FACE_SWAP_DEFAULTS = {"model": None, "steps": 12, "denoise": 0.6, "shift_video": 4.0, "color": 0.4,
                      "mask": 1.15, "seed": 0, "work": 640}
FACE_SWAP_SUBFOLDER = "Face_Swap"


def is_ref2va(name) -> bool:
    n = str(name or "").lower()
    return bool(n) and "fl2v" not in n and "t2v" not in n


def build_face_swap(project: dict, item: dict, env: Env | None = None) -> Build:
    """item: {source: {kind: "take", take, key} | {kind: "file", file, subfolder},
    faces: [{cast, keys?}], name}. One face without a box: the largest face found gets its
    picture. Two or more: each needs its box (drawn like a region), and gets its own."""
    import copy
    env = env or Env()
    s = project.get("settings") or {}
    sw = dict(FACE_SWAP_DEFAULTS, **(s.get("face_swap") or {}))
    if not sw.get("model"):
        raise BuildError("Face swap: choose the ref2va model first (Face refine → Face swap).")
    if not is_ref2va(sw["model"]):
        raise BuildError(f"Face swap needs a ref2va model (it takes the new face as a reference picture); "
                         f"{sw['model']} isn't one.")
    if not env.longshot_at_least(1, 9, 0):
        raise BuildError("Face swap needs H3 Long Shot 1.9.0 or later. Update it, then restart ComfyUI.")
    for key in ("video_vae", "audio_vae", "clip"):
        if not s.get(key):
            raise BuildError(f"Settings: choose a {key.replace('_', ' ')} file.")
    item = item or {}
    src = item.get("source") or {}
    cast = {str(c.get("id")): c for c in project.get("cast") or [] if isinstance(c, dict)}
    rows = []
    for k, fc in enumerate((item.get("faces") or [])[:4]):
        c = cast.get(str((fc or {}).get("cast") or ""))
        if not c or not c.get("image"):
            raise BuildError(f"Face swap: face {k + 1} has no picture card chosen.")
        keys = [[float(v) for v in list(x)[:5]] for x in ((fc or {}).get("keys") or [])
                if isinstance(x, (list, tuple)) and len(x) >= 5][:64]
        rows.append((c, keys))
    if not rows:
        raise BuildError("Face swap: choose the picture of the new face.")
    if len(rows) > 1 and not all(keys for _c, keys in rows):
        raise BuildError("Face swap with more than one face: draw a box for each face, so each gets its own picture.")
    p2 = copy.deepcopy(project)
    p2.setdefault("settings", {})["face"] = dict((s.get("face") or {}), model=sw["model"], steps=sw["steps"],
                                                 denoise=sw["denoise"], shift_video=sw["shift_video"], color=sw["color"],
                                                 mask=sw["mask"], seed=sw["seed"], work=sw["work"], cast=None,
                                                 turbo={"on": False}, max_face=4096, which="largest", describe="")
    f = face_settings(p2, env)
    warnings = []
    fmt = _video_format(env, warnings)
    g = _Graph()
    vae = g.add("vae_video", "VAELoader", "Video VAE", vae_name=s["video_vae"])
    if src.get("kind") == "take":
        key, take = str(src.get("key") or ""), str(src.get("take") or "")
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,150}", key) or not TAKE_NAME_RE.fullmatch(take):
            raise BuildError(f"Not a take: {take!r}")
        avae = g.add("vae_audio", "VAELoader", "Audio VAE", vae_name=s["audio_vae"])
        lat = g.add("take", "MiniMaxH3Take", f"Take {take}", cache_name=project_slug(project), take=take, shot_id="")
        images = g.add("dec", "VAEDecode", "VAE Decode", samples=lat, vae=vae)
        audio = g.add("aud", "VAEDecodeAudio", "VAE Decode Audio", samples=lat, vae=avae)
        base = key
    elif src.get("kind") == "file":
        if not env.has("MiniMaxH3LoadVideo"):
            raise BuildError("Face swap on a video file needs H3 Long Shot 1.9.0 (MiniMax H3 Load Video). Restart ComfyUI after updating.")
        try:
            path = pj.input_path_value(str(src.get("file") or ""), str(src.get("subfolder") or ""))
        except ValueError as err:
            raise BuildError(f"Face swap video: {err}") from None
        load = g.add("swapsrc", "MiniMaxH3LoadVideo", f"Video {src.get('file')}", video=path,
                     max_seconds=_num(src.get("max_seconds", 60), "Face swap length", 1, 600))
        images, audio, lat = _out(load, 0), _out(load, 1), None
        base = re.sub(r"[^A-Za-z0-9_-]+", "_", os.path.splitext(str(src.get("file")))[0])[:60] or "video"
    else:
        raise BuildError("Face swap: choose a Shot's take or a video file.")
    m = _face_nodes(g, p2, f, env)
    refs = {}
    for k, (c, _keys) in enumerate(rows):
        try:
            image = pj.input_path_value(c["image"], c.get("subfolder", ""))
        except ValueError as err:
            raise BuildError(f"Face swap picture ({c.get('label') or 'Cast'}): {err}") from None
        refs[("ref_image", "ref_image_2", "ref_image_3", "ref_image_4")[k]] = g.add(
            f"swapref{k + 1}", "LoadImage", f"New face {k + 1} {c.get('label', '')}".strip(), image=image)
    extra = dict(refs)
    if rows[0][1]:
        extra["regions"] = json.dumps([{"keys": keys, "ref": k + 1, "label": re.sub(r"[<>]", "", str(c.get("label") or ""))[:80],
                                        "describe": str(c.get("desc") or "")[:200], "shape": "oval"}
                                       for k, (c, keys) in enumerate(rows)])
    if lat is not None:
        extra["latent"] = lat
    face = g.add("swap", "MiniMaxH3FaceRefine", "Face swap", images=images, model=m["model"], clip=m["clip"],
                 vae=m["vae"], noise=m["noise"], sampler=m["sampler"], sigmas=m["sigmas"], text="", mode="swap",
                 max_face=4096, which="largest", work_size=f["work"], padding=f["padding"], follow=f["follow"],
                 mask_scale=f["mask"], feather=f["feather"], color_match=f["color"], hold_audio=lat is not None,
                 max_window=362, cache_name=project_slug(project), cache_key=f["key"], detect_every=2, enabled=True,
                 **extra)
    name = re.sub(r"[^A-Za-z0-9_-]+", "_", str(item.get("name") or base))[:80] + "_swap"
    prefix = f"{OUTPUT_SUBFOLDER}/{project_slug(project)}/{FACE_SWAP_SUBFOLDER}"
    save = g.add("swapsave", "MiniMaxH3SaveVideo", f"Face swap {name}", images=_out(face, 0), audio=audio,
                 filename_prefix=f"{prefix}/{name}", codec=_codec(fmt), frame_rate=float(FPS))
    return Build(prompt=g.nodes, width=0, height=0, chain=[], nodes={"face": "swap", "save": "swapsave"},
                 filename_prefix=prefix, video_format=fmt, warnings=warnings)


REFINE_CLIP_SUFFIX = "__ref"


def build_refine_try(project: dict, item: dict, env: Env | None = None) -> Build:
    """0.17.8, Refine this Shot: one take refined with the Refine panel's model (Long Shot's
    refine pass on that take alone, kept in takes/refined), decoded and saved as its own clip
    (clips/<take>__ref.mp4) for the A/B viewer. Works with the panel's switches off.
    item: {key, take, song_at, song_len}."""
    import copy
    env = env or Env()
    p = copy.deepcopy(project)
    s = p.setdefault("settings", {})
    s["refine"] = dict(s.get("refine") or {}, on=True)
    if not s["refine"].get("model"):
        raise BuildError("Choose the refine model first (Refine panel).")
    if s["refine"]["model"] == s.get("model"):
        # 0.17.10: the take is what gets refined: the model it was made with is what counts. The
        # Long Shot run samples nothing (the take is locked), so its model input can be that one.
        made = str((item or {}).get("take_model") or "")
        if not made:
            raise BuildError("Which model made this take isn't recorded, and the refine model is the Model in "
                             "Advanced. Set the Model to the one it was rendered with to refine it.")
        if made == s["refine"]["model"]:
            raise BuildError("This take was made with the refine model already: nothing to refine.")
        s["model"] = made
    rc = refine_settings(p, env)
    if rc is None:
        raise BuildError("Update H3 Long Shot to 1.7.0 or later to refine a Shot.")
    item = item or {}
    key, take = str(item.get("key") or ""), str(item.get("take") or "")
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,150}", key) or not TAKE_NAME_RE.fullmatch(take):
        raise BuildError(f"Not a take: {take!r}")
    xp = _export_project(p, {take})
    if not any(not sh.get("bypassed") for sh in xp.get("shots") or []):
        raise BuildError("That take isn't on the timeline any more.")
    base = build_prompt(xp, env=env, long_shot_only=True, refine_export=True)
    warnings = list(base.warnings)
    fmt = _video_format(env, warnings)
    g = _Graph()
    g.nodes.update(base.prompt)
    vae = ["vae_video", 0] if "vae_video" in g.nodes else g.add("vae_video", "VAELoader", "Video VAE", vae_name=s["video_vae"])
    avae = ["vae_audio", 0] if "vae_audio" in g.nodes else g.add("vae_audio", "VAELoader", "Audio VAE", vae_name=s["audio_vae"])
    lat = g.add("reftake", "MiniMaxH3Take", f"Take {take} (refined)", cache_name=project_slug(p), take=take,
                shot_id="", refine=rc["key"], after=["longshot", 1])
    images = g.add("refdec", "VAEDecode", "VAE Decode", samples=lat, vae=vae)
    songs = _song_slices(g, p, [item])
    audio = songs.get(1) or g.add("refaud", "VAEDecodeAudio", "VAE Decode Audio", samples=lat, vae=avae)
    name = key + REFINE_CLIP_SUFFIX
    save = _clip_save(g, 1, p, images, audio, fmt, name)[0]
    g.drop_unused("vae_audio")
    return Build(prompt=g.nodes, width=0, height=0, chain=[], nodes={"clips": {name: save}, "refine_key": rc["key"],
                                                                    "longshot": "longshot"},
                 filename_prefix=clips_subfolder(p), video_format=fmt, warnings=warnings)


def build_face_try(project: dict, item: dict, env: Env | None = None) -> Build:
    """0.14.0, Try on this Shot: one take decoded, its faces refined, saved as its own clip
    (clips/<take>__face.mp4) next to the take's clip for the A/B viewer. item: {key, take,
    song_at, song_len}."""
    env = env or Env()
    s = project.get("settings") or {}
    f = face_settings(project, env)
    if f is None:
        raise BuildError("Choose the face model first (Face refine panel).")
    need = ["MiniMaxH3Take", "VAELoader", "VAEDecode", "VAEDecodeAudio", "MiniMaxH3SaveVideo",
            "MiniMaxH3FaceRefine", "UNETLoader", "MiniMaxH3SigmaShift", "CLIPLoader", "BasicScheduler",
            "KSamplerSelect", "RandomNoise"]
    missing = [c for c in need if not env.has(c)]
    if missing:
        raise BuildError("ComfyUI is missing node(s) this needs:\n  " +
                         "\n  ".join(f"{c} — from {PACKS.get(c, 'ComfyUI core')}" for c in missing))
    for key in ("video_vae", "audio_vae", "clip"):
        if not s.get(key):
            raise BuildError(f"Settings: choose a {key.replace('_', ' ')} file.")
    item = item or {}
    key, take = str(item.get("key") or ""), str(item.get("take") or "")
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,150}", key) or not TAKE_NAME_RE.fullmatch(take):
        raise BuildError(f"Not a take: {take!r}")
    warnings = []
    fmt = _video_format(env, warnings)
    g = _Graph()
    vae = g.add("vae_video", "VAELoader", "Video VAE", vae_name=s["video_vae"])
    avae = g.add("vae_audio", "VAELoader", "Audio VAE", vae_name=s["audio_vae"])
    lat = g.add("take", "MiniMaxH3Take", f"Take {take}", cache_name=project_slug(project), take=take, shot_id="")
    images = g.add("dec", "VAEDecode", "VAE Decode", samples=lat, vae=vae)
    # 0.17.38: a region drawn by hand (cartoon characters, creatures…) instead of found faces
    regions = item.get("regions") if isinstance(item.get("regions"), list) else None
    extra = {}
    if regions:
        if not env.longshot_at_least(1, 8, 2):
            raise BuildError("Region refine needs H3 Long Shot 1.8.2 or later. Update it, then restart ComfyUI.")
        clean = []
        for r in regions[:8]:
            keys = [[float(v) for v in list(k)[:5]] for k in ((r or {}).get("keys") or []) if isinstance(k, (list, tuple)) and len(k) >= 5]
            if keys:
                clean.append({"keys": keys[:64]})
        if not clean:
            raise BuildError("Draw the region on the Shot first (Face refine → Region).")
        who = f.get("identity")
        extra = {"regions": json.dumps(clean), "text": region_prompt(str(item.get("region_text") or ""),
                 with_ref=who is not None, label=(who or {}).get("label") or "")}
    face = _face_node(g, "face", project, f, env, images, lat, **extra)
    songs = _song_slices(g, project, [item])
    audio = songs.get(1) or g.add("aud", "VAEDecodeAudio", "VAE Decode Audio", samples=lat, vae=avae)
    name = key + FACE_CLIP_SUFFIX
    save = _clip_save(g, 1, project, _out(face, 0), audio, fmt, name)[0]
    g.drop_unused("vae_audio")
    return Build(prompt=g.nodes, width=0, height=0, chain=[], nodes={"face": "face", "clips": {name: save},
                                                                    "sig": f["sig"]},
                 filename_prefix=clips_subfolder(project), video_format=fmt, warnings=warnings)


def build_prompt(project: dict, *, upto=None, dry_run: bool = False,
                 env: Env | None = None, final: bool = False, standalone: bool = False,
                 clips_for=None, chunk=None, refine_export: bool = False,
                 long_shot_only: bool = False, final_upscale: bool = True) -> Build:
    """Turn a Studio project into an API prompt rendering the chain of active
    Shots up to and including `upto` (all active Shots when None).

    final=True is "Upscale final video": RTX Super Resolution is always on
    (with the project's scale and quality) and the file is saved as
    <project>_final_#####.mp4 (plus a ProRes master .mov when the project asks
    for one). The Long Shot part is identical, so every segment is reused.
    0.17.27: final_upscale=False is "Output final" at the film's own size: everything the
    final does (refined faces, clip pixels, ProRes master) without RTX, saved as
    <project>_final_native_#####.mp4.

    standalone=True renders the Shot `upto` on its own: a one-Shot timeline, so
    it starts fresh from the references with no pin to the Shots around it. Its
    take is saved under its id like any other; later chains lock it.

    clips_for=[shot ids] (a render while reviewing): the stitched film isn't
    decoded. Each of those Shots' new take is decoded on its own into
    clips/<shot id>_#####-audio.mp4 instead (MiniMax H3 Take after Long Shot),
    so a render's decode costs one Shot, however long the film.

    chunk={index, start, length[, audio]} (an upscaled whole-film render, a
    chunk at a time): the film is decoded as usual (ComfyUI keeps the decoded
    frames between runs), then only frames start .. start+length-1 are
    upscaled, a few at a time straight into the encoder (MiniMax H3 Upscale
    Chunk), and saved without sound as videos/_chunks/<Name>[_final]_cNNN.
    audio=True also saves the film's sound as videos/_chunks/<Name>_audio.wav.
    The server joins the chunks and the sound afterwards."""
    env = env or Env()
    if not isinstance(project, dict):
        raise BuildError("The project must be a JSON object.")
    s = project.get("settings") or {}
    style = project.get("style") or {}
    audio = project.get("audio") or {}
    warnings = []

    upscale_final = bool(final)      # (`final` is reused below for the song route)
    final_up = upscale_final and bool(final_upscale)     # 0.17.27: the final at native size: no RTX
    clip_ids = [str(x) for x in (clips_for or [])] if not dry_run and not upscale_final else []
    need_classes = required_classes(project, dry_run, upscale_final, final_up)
    if clip_ids:
        need_classes = need_classes + ["MiniMaxH3Take", "VAEDecodeAudio"]
    if chunk is not None:
        if dry_run or clip_ids:
            raise BuildError("A chunk is part of a whole-film render.")
        try:
            chunk = {"index": int(chunk.get("index", 0)), "start": int(chunk.get("start", 0)),
                     "length": int(chunk.get("length", 0)), "audio": bool(chunk.get("audio"))}
        except (TypeError, ValueError, AttributeError):
            raise BuildError("A chunk needs index, start and length.") from None
        if chunk["start"] < 0 or chunk["length"] < 1 or not 0 <= chunk["index"] < 10000:
            raise BuildError("A chunk needs a start of 0 or more and a length of 1 or more.")
        # a chunk upscales only when the render does; otherwise it's a piece of a film
        # decoded run by run (Upscale Chunk at scale 1: frames encoded, no RTX)
        chunk_up = final_up or (not upscale_final and bool((s.get("rtx_vsr") or {}).get("on")))
        need_classes = [c for c in need_classes if c not in ("RTXVideoSuperResolution", "MiniMaxH3SaveVideo")] + \
            ["MiniMaxH3UpscaleChunk"] + (["RTXVideoSuperResolution"] if chunk_up else []) + \
            (["MiniMaxH3SaveAudio"] if chunk["audio"] else [])
    if "MiniMaxH3TurboLoRA" in need_classes and not env.has("MiniMaxH3TurboLoRA"):
        need_classes = [c for c in need_classes if c != "MiniMaxH3TurboLoRA"] + ["LoraLoaderModelOnly"]
    missing = [c for c in dict.fromkeys(need_classes) if not env.has(c)]
    if missing:
        rows = [f"{c} — from {PACKS.get(c, 'ComfyUI core')}" for c in missing]
        raise BuildError("ComfyUI is missing node(s) this project needs:\n  " + "\n  ".join(rows))

    chain = chain_upto(project, upto)
    if standalone:
        if upto is None:
            raise BuildError("A standalone render needs the Shot to render.")
        if chain[-1].get("kind") == "clip":
            raise BuildError("A clip isn't rendered; it can't render on its own.")
        chain = chain[-1:]
    if not chain:
        raise BuildError("No active Shots. Add a Shot (or turn one back on) to render.")
    if len(chain) > MAX_SHOTS:
        raise BuildError(f"Long Shot renders at most {MAX_SHOTS} Shots; this chain has {len(chain)}.")

    for key in ("model", "clip", "video_vae", "audio_vae"):
        if not s.get(key):
            raise BuildError(f"Settings: choose a {key.replace('_', ' ')} file.")

    width, height = output_size(s.get("megapixels", 0.6), s.get("aspect", "16:9"))
    steps = _num(s.get("steps", 8), "Steps", 1, 200, int)
    overlap = _num(s.get("overlap", 22), "Overlap frames", 5, 107, int)
    if overlap % 17 != 5:
        raise BuildError("Overlap frames must be 5, 22, 39, 56, 73, 90 or 107 (17k + 5).")
    seed_mode = s.get("seed_mode", "increment")
    if seed_mode not in ("increment", "same"):
        raise BuildError("Seed mode must be 'increment' or 'same'.")
    ref_size = s.get("ref_image_size", "match")
    if ref_size not in ("match", "max"):
        raise BuildError("Reference image size must be 'match' or 'max'.")
    base_seed = _seed(s.get("seed", 0), "Base seed")
    if base_seed < 0:
        raise BuildError("Base seed must be fixed (0 or more) so finished Shots can be reused.")

    g = _Graph()
    ids = {}

    # 0.9.2: where each Shot's take starts on the whole film, for its part of the song
    songref = song_ref_on(project)
    song_start = _num(audio.get("start", 0) or 0, "Audio start", 0, 1e7)
    nudge = int(_num(audio.get("sync_nudge", 0) or 0, "Sync nudge", -2400, 2400))
    positions = None
    lipsong = bool(audio.get("lip_sync") and audio.get("file"))
    if (songref or lipsong or (audio.get("final_override") and audio.get("file"))) and env.planner is not None:
        try:
            positions = film.frame0_positions(film.film_shots(project), chain, overlap, env.planner,
                                               film.line_up(project))
        except Exception as err:          # never stop a render over the song's place
            warnings.append(f"Couldn't work out where the Shots sit in the song ({err}).")
    per_shot_song = bool(songref and positions is not None and env.shot_takes("song_at")
                         and env.has("MiniMaxH3LongShot"))
    # 0.9.3: the pinned song (Song Track) takes each Shot's song_at from Long Shot 1.6.19
    per_shot_pin = bool(lipsong and positions is not None and env.shot_takes("song_at")
                        and env.longshot_at_least(1, 6, 19))

    # --- models -------------------------------------------------------------
    model = g.add("unet", "UNETLoader", "Load Diffusion Model",
                  unet_name=s["model"], weight_dtype=s.get("weight_dtype", "default"))
    sage = s.get("sage_attention", "auto")
    if sage and sage not in ("disabled", "off", False):
        # optional (0.8.6): KJNodes' patch when it's installed; otherwise ComfyUI's
        # own --use-sage-attention launch flag does it, and nothing is added here
        if env.has("PathchSageAttentionKJ"):
            model = g.add("sage", "PathchSageAttentionKJ", "Patch Sage Attention KJ",
                          model=model, sage_attention=sage, allow_compile=False)
    model = g.add("shift", "MiniMaxH3SigmaShift", "ModelSamplingMiniMaxH3", model=model,
                  shift_video=_num(s.get("shift_video", 12), "Video shift", 0.01, 100),
                  shift_audio=_num(s.get("shift_audio", 3), "Audio shift", 0.01, 100))
    turbo = s.get("turbo") or {}
    if turbo.get("on"):
        if not turbo.get("lora"):
            raise BuildError("Turbo is on but no Turbo LoRA file is chosen.")
        strength = _num(turbo.get("strength", 1.0), "Turbo strength", -10, 10)
        if env.has("MiniMaxH3TurboLoRA"):
            # low_vram: newer Turbo builds require it; older ones ignore extra inputs.
            model = g.add("turbo", "MiniMaxH3TurboLoRA", "MiniMax-H3 Turbo LoRA", model=model,
                          lora_name=turbo["lora"], strength=strength,
                          low_vram=bool(turbo.get("low_vram", False)))
        else:
            # 0.8.6: without the Turbo pack, ComfyUI's own LoRA loader (it maps H3's keys).
            # On the pruned H3 checkpoints the timestep part of the LoRA needs the pack.
            model = g.add("turbo", "LoraLoaderModelOnly", "Turbo LoRA (stock loader)", model=model,
                          lora_name=turbo["lora"], strength_model=strength)
            warnings.append("Turbo LoRA through ComfyUI's stock loader. For full Turbo support "
                            "(pruned checkpoints), install ComfyUI-MiniMax-H3-Turbo.")
    elif steps < 20 and not re.search(r"fast[\s_-]?h3", str(s.get("model") or ""), re.I):   # 0.17.9: FastH3 is an 8-step model
        warnings.append(f"Turbo is off and steps are at {steps}. Without Turbo, H3 needs "
                        "about 20 steps or more.")
    for n, lora in enumerate((s.get("loras") or [])[:3], 1):
        if not lora.get("on"):
            continue
        if not lora.get("name"):
            raise BuildError(f"LoRA {n} is switched on but has no file chosen.")
        model = g.add(f"lora{n}", "LoraLoaderModelOnly", f"LoRA {n}", model=model,
                      lora_name=lora["name"],
                      strength_model=_num(lora.get("strength", 1.0), f"LoRA {n} strength",
                                          -100, 100))

    clip = g.add("clip", "CLIPLoader", "Load CLIP", clip_name=s["clip"], type="minimax",
                 device="default")
    vae = g.add("vae_video", "VAELoader", "Video VAE", vae_name=s["video_vae"])
    avae = g.add("vae_audio", "VAELoader", "Audio VAE", vae_name=s["audio_vae"])
    sigmas = g.add("scheduler", "BasicScheduler", "BasicScheduler", model=model,
                   scheduler=s.get("scheduler", "beta"), steps=steps, denoise=1.0)
    sampler = g.add("sampler", "KSamplerSelect", "KSamplerSelect",
                    sampler_name=s.get("sampler", "er_sde"))
    noise = g.add("noise", "RandomNoise", "RandomNoise", noise_seed=base_seed)

    # --- references and subjects -------------------------------------------
    cast = active_cast(project)
    if len(cast) > MAX_REFERENCES:
        raise BuildError(f"Long Shot takes at most {MAX_REFERENCES} references; "
                         f"{len(cast)} are on. Bypass some.")
    resize_px = _num(s.get("ref_resize_px", 1500), "Reference resize", 16, 8192, int)
    refs, subjects = {}, None
    voice_of = voice_keys(project)
    n_audio = len(audio_labels(project)) + song_slot(project)
    if n_audio > MAX_AUDIO_REFS:
        raise BuildError(f"Long Shot takes at most {MAX_AUDIO_REFS} reference audios; {n_audio} are on "
                         "(voice references, plus the song as <Audio 1>). Bypass some.")
    for k, c in enumerate(cast):
        pic = picture_label(k)
        if not c.get("image"):
            raise BuildError(f"{c.get('label') or pic} ({pic}) has no image. Pick one or "
                             f"bypass it.")
        try:
            image = pj.input_path_value(c["image"], c.get("subfolder", ""))
        except ValueError as err:
            raise BuildError(f"{c.get('label') or pic}: {err}") from None
        img = g.add(f"img{k + 1}", "LoadImage", f"{pic} {c.get('label', '')}".strip(),
                    image=image)
        # core resize (0.8.6, was KJNodes): the longer side to resize_px, proportions kept
        refs[f"ref_images.ref_image_{k}"] = g.add(
            f"resize{k + 1}", "ImageScaleToMaxDimension", f"Resize {pic}", image=img,
            upscale_method="lanczos", largest_size=resize_px)
        voice = voice_of.get(str(c.get("voice") or ""))
        inputs = dict(label=c.get("label") or pic, description=c.get("desc", ""),
                      role=c.get("role") or "appearance", reference=pic,
                      role_2="voice timbre" if voice else "-", reference_2=voice or "")
        if subjects is not None:
            inputs["subjects"] = subjects
        subjects = g.add(f"subject{k + 1}", "MiniMaxH3Subject", f"{pic} subject", **inputs)

    # --- video references (0.17.1): <Video N>, each a subject, its soundtrack optional
    vids = active_videos(project)
    if len(vids) > MAX_REF_VIDEOS:
        raise BuildError(f"Long Shot takes at most {MAX_REF_VIDEOS} reference videos; {len(vids)} are on. Bypass some.")
    vlabels = video_labels(project)
    for k, v in enumerate(vids):
        vlab, alab = vlabels[str(v.get("id"))]
        try:
            path = pj.input_path_value(v["file"], v.get("subfolder", ""))
        except ValueError as err:
            raise BuildError(f"{v.get('label') or vlab}: {err}") from None
        start = _num(v.get("start", 0) or 0, f"{vlab} start", 0, 1e6)
        dur = float(v.get("duration") or 0)
        length = float(v.get("length") or 0) or max(0.0, (dur - start) if dur else REF_VIDEO_MAX_S)
        length = min(REF_VIDEO_MAX_S, length)
        if length < REF_VIDEO_MIN_S:
            warnings.append(f"{v.get('label') or vlab} is {length:.2f}s; H3 expects reference videos of "
                            f"{REF_VIDEO_MIN_S:g}-{REF_VIDEO_MAX_S:g}s.")
        frames = max(5, int(round(length * FPS)))
        # loaded at about the film's size (H3 shrinks it to its own canvas anyway): a 4K
        # reference is never held in memory at full size
        vw, vh = v.get("width"), v.get("height")
        lw = lh = 0
        if isinstance(vw, (int, float)) and isinstance(vh, (int, float)) and vw > 0 and vh > 0:
            sc = min(1.0, ((width * height) / (vw * vh)) ** 0.5)
            lw, lh = max(32, int(round(vw * sc / 2)) * 2), max(32, int(round(vh * sc / 2)) * 2)
        load = g.add(f"refvid{k + 1}", "MiniMaxH3LoadVideo", f"{vlab} {v.get('label', '')}".strip(), video=path,
                     force_rate=FPS, width=lw, height=lh, frame_load_cap=frames,
                     skip_first_frames=int(round(start * FPS)))
        refs[f"ref_videos.ref_video_{k}"] = [load[0], 0]
        if alab:
            refs[f"ref_video_audios.ref_video_audio_{k}"] = [load[0], 2]
        role = v.get("role") if v.get("role") in REFMOD_ROLES else "motion"
        inputs = dict(label=v.get("label") or vlab, description=v.get("desc", ""), role=role, reference=vlab,
                      role_2="-", reference_2="")
        if subjects is not None:
            inputs["subjects"] = subjects
        subjects = g.add(f"subject_v{k + 1}", "MiniMaxH3Subject", f"{vlab} subject", **inputs)

    # --- RefMods (0.8.6): Load H3 RefMods -> Long Shot refmods; each card is a subject
    mods = active_refmods(project)
    refmod_input = {}
    if mods:
        if len(mods) > MAX_REFMODS:
            raise BuildError(f"Long Shot takes at most {MAX_REFMODS} RefMods; {len(mods)} are on. Bypass some.")
        slots = {"show_info": False}
        for i in range(1, MAX_REFMODS + 1):
            m = mods[i - 1] if i <= len(mods) else None
            slots[f"mod_{i}"] = str(m["name"]) if m else "(none)"
            slots[f"strength_{i}"] = _num(m.get("strength", 1.0), "RefMod strength", 0, 1) if m else 1.0
            slots[f"copies_{i}"] = 1
        refmod_input["refmods"] = g.add("refmods", "MiniMaxH3RefModsLoader", "Load H3 RefMods", **slots)
        for m, label in zip(mods, refmod_labels(project)):
            role = refmod_role(m)
            voice = voice_of.get(str(m.get("voice") or "")) if m.get("kind") != "audio" else None
            inputs = dict(label=m.get("label") or label, description=m.get("desc", ""), role=role,
                          reference=label, role_2="voice timbre" if voice else "-", reference_2=voice or "")
            if subjects is not None:
                inputs["subjects"] = subjects
            subjects = g.add(f"subject_m{m.get('id') or label}"[:60].replace(" ", ""), "MiniMaxH3Subject",
                             f"{label} subject (RefMod)", **inputs)

    # --- sounds of their own (0.12.0): "<sfx> is cars driving by, whose sound comes from <Audio 2>."
    # (the compiler's subject roles are for pictures, so the clause goes in the description)
    alabels = audio_labels(project)
    for v in active_voices(project):
        if audio_role(v) == "voice":
            continue
        a = alabels[str(v.get("id"))]
        desc = str(v.get("desc") or "").strip().rstrip(".") or "this audio"
        inputs = dict(label=str(v.get("label") or "").strip() or a,
                      description=f"{desc}, whose {sound_word(v)} comes from {a}",
                      role="appearance", reference="", role_2="-", reference_2="")
        if subjects is not None:
            inputs["subjects"] = subjects
        subjects = g.add(f"subject_a{v.get('id')}"[:60].replace(" ", ""), "MiniMaxH3Subject",
                         f"{a} subject (audio)", **inputs)

    # --- prompt ---------------------------------------------------------------
    # Timeline Shots (Long Shot 1.4): each carries its id, its locked take
    # (approved and reviewed Shots load their take instead of sampling), the
    # window length to keep when re-rendered in place, and its join.
    shots = None
    for n, shot in enumerate(chain, 1):
        if shot.get("kind") == "clip":
            shots = _clip_nodes(g, n, shot, shots, vae, avae, width, height, env)
            continue
        seconds = _num(shot.get("seconds", 5), f"Shot {n} seconds", 0.1, 600)
        lock = shot.get("lock") or ""
        if lock and not TAKE_NAME_RE.fullmatch(lock):
            raise BuildError(f"Shot {n}'s take name {lock!r} isn't a take file.")
        frames = shot.get("frames") or 0
        frames = int(frames) if isinstance(frames, (int, float)) and frames > 0 and \
            int(frames) % 17 == 5 else 0
        # Context Continuity: a cut for Long Shot (nothing pinned), with the last
        # frame of the Shot before as one more reference picture
        join = "cut" if shot.get("join") == "context" else \
            shot.get("join") if shot.get("join") in ("bridge", "cut") else "bridge"
        text = shot.get("text", "")
        anchor_inputs = {}
        own_retention = ""
        if not lock:
            # Frame anchors (Long Shot 1.6.7): the image at the join before this Shot and
            # the one after it. Each is this Shot's next <Picture N>, after the Cast.
            a0, a1 = frame_anchors(project, shot)
            pic = len(cast)
            lead, tail = "", ""
            for key, item in (("start_image", a0), ("end_image", a1)):
                if not item:
                    continue
                pic += 1
                try:
                    image = pj.input_path_value(item["file"], item.get("subfolder", ""))
                except ValueError as err:
                    raise BuildError(f"Shot {n}'s frame anchor: {err}") from None
                anchor_inputs[key] = g.add(f"anchor{n}{key[0]}", "LoadImage",
                                           f"Shot {n} {'start' if key[0] == 's' else 'end'} frame",
                                           image=image)
                if key == "start_image":
                    lead = f"The shot begins from <Picture {pic}>. "
                else:
                    tail = f" The shot ends on <Picture {pic}>."
            ctx = shot.get("context_image") if shot.get("join") == "context" else None
            if isinstance(ctx, dict) and ctx.get("file"):
                pic += 1
                try:
                    image = pj.input_path_value(ctx["file"], ctx.get("subfolder", ""))
                except ValueError as err:
                    raise BuildError(f"Shot {n}'s context frame: {err}") from None
                anchor_inputs["context_image"] = g.add(f"context{n}", "LoadImage",
                                                       f"Shot {n} context (last frame before)", image=image)
                # reference only: never "continuity" or "last frame", which H3 reads as
                # "open on this frame and carry on from it". 0.22.1: the location only: people in the
                # frame drifted toward the model's own idea of them (a well-known IP) instead of the
                # reference sheets, so no likeness is taken from it.
                lead = (f"<Picture {pic}> is a reference for the location only: the setting, its layout, light "
                        f"and props. No person's appearance comes from <Picture {pic}>: every character looks "
                        "exactly as in their own reference pictures. "
                        f"The shot does not begin from <Picture {pic}> and does not continue it: it opens "
                        "on a new camera angle and composition. ") + lead
                if not env.shot_takes("retention"):
                    msg = ("H3 Long Shot 1.6.9 or later marks a Context picture as weak_reference in the "
                           "retention section. Update it for Context Shots that don't open on that frame.")
                    if msg not in warnings:
                        warnings.append(msg)
                else:
                    own_retention = (f"<Picture {pic}> (reference for [Shot 1]): partially_preserved - the location "
                                     "only (setting, layout, light, props), seen from a new camera angle; no "
                                     "character appearance comes from it; not a frame anchor.")
            text = (lead + text + tail).strip()
        inputs = dict(shot_id=str(shot.get("id") or f"shot{n}"), seconds=seconds,
                      text=text,
                      shot_seed=_seed(shot.get("shot_seed", -1), f"Shot {n} seed"),
                      lock=lock, join=join, frames=frames, **anchor_inputs)
        if (per_shot_song or per_shot_pin) and str(shot.get("id")) in positions:
            # Long Shot 1.6.18: this Shot's own slice of the song, from where its take starts
            at = song_start + (positions[str(shot.get("id"))][0] + nudge) / film.FPS
            if at < 0:
                warnings.append(f"Shot {n} starts before the song (Start plus the sync nudge); "
                                "its song slice starts at the song's beginning.")
            inputs["song_at"] = round(max(0.0, at), 4)
        if own_retention:
            inputs["retention"] = own_retention       # Long Shot 1.6.9: this Shot's own lines
        gap = _song_gap(shot, env)
        if gap:
            inputs["song_gap"] = gap                   # Long Shot 1.6.17: its place in the song
        elif str(shot.get("song_gap") or "").strip() and (project.get("audio") or {}).get("lip_sync"):
            msg = ("Update H3 Long Shot to 1.6.17 or later: Shots left out of this render don't count "
                   "toward the song's position, so lip sync starts at the song's beginning.")
            if msg not in warnings:
                warnings.append(msg)
        if shots is not None:
            inputs["shots"] = shots
        shots = g.add(f"shot{n}", "MiniMaxH3TimelineShot", f"[Shot {n}]", **inputs)

    types = [t for t in (style.get("task_types") or ["reference generation"]) if t][:3]
    if songref and "audio reuse" not in types:
        # 0.9.1: the song is reused as the soundtrack: [reference generation + audio reuse]
        if len(types) < 3:
            types.append("audio reuse")
        else:
            warnings.append("The summary has three task types already, so \"audio reuse\" (the song as "
                            "<Audio 1>) isn't in it. Drop one in the Style panel.")
    if audio_copied(project) and "audio reuse" not in types:
        if len(types) < 3:
            types.append("audio reuse")
        else:
            warnings.append("The summary has three task types already, so \"audio reuse\" (an audio "
                            "reference set to Copy) isn't in it. Drop one in the Style panel.")
    types += ["-"] * (3 - len(types))
    builder_inputs = dict(
        subject_definitions="", task_type=types[0] if types[0] != "-" else "reference generation",
        task_type_2=types[1], task_type_3=types[2],
        summary=style.get("summary", ""),
        retention_analysis="\n".join(x for x in [live_retention(project, style.get("retention"), warnings),
                                                  song_retention(project) if songref else "", *voice_retention(project)] if x),
        style_line=style.get("style_line", ""), detailed_description="",
        overall_soundscape=style.get("soundscape", ""),
        non_diegetic_music=style.get("music", ""), shots=shots)
    if subjects is not None:
        builder_inputs["subjects"] = subjects
    builder = g.add("builder", "MiniMaxH3RefPromptBuilder", "MiniMax H3 Ref Prompt Builder r2v",
                    **builder_inputs)

    # --- audio ----------------------------------------------------------------
    lip, voice, final = (bool(audio.get("lip_sync")), bool(audio.get("voice_ref")) and not songref,
                         bool(audio.get("final_override")))
    loader = None
    long_extra = {}
    if songref and per_shot_song:
        # 0.9.2: the whole song to Long Shot, which gives each Shot its slice (its song_at)
        try:
            song_value = pj.input_path_value(audio["file"], audio.get("subfolder", ""))
        except ValueError as err:
            raise BuildError(f"Audio file: {err}") from None
        long_extra["song_ref"] = g.add("song_file_ref", "LoadAudio", f"Song ({song_label(project)}, a slice per Shot)",
                                       audio=song_value)
    elif songref:
        # 0.9.1 (older Long Shot): the song as <Audio 1>, cut to Start / Length for every Shot
        warnings.append("Update H3 Long Shot to 1.6.18 or later so each Shot gets its own part of the "
                        "song; until then every Shot gets the song from Start.")
        try:
            song_value = pj.input_path_value(audio["file"], audio.get("subfolder", ""))
        except ValueError as err:
            raise BuildError(f"Audio file: {err}") from None
        song_raw = g.add("song_file_ref", "LoadAudio", "Song", audio=song_value)
        song_len = _num(audio.get("length", 0), "Audio length", 0, 1e7)
        if not song_len:
            song_len = round(sum(float(x.get("seconds", 0) or 0) for x in chain), 3) or 5.0
            warnings.append(f"Audio Length is 0, so {song_label(project)} is the song from Start for this render's "
                            f"length ({song_len:g}s).")
        long_extra["ref_audios.ref_audio_0"] = g.add(
            "song_ref", "TrimAudioDuration", f"{song_label(project)} the song", audio=song_raw,
            start_index=_num(audio.get("start", 0), "Audio start", 0, 1e7), duration=song_len)
    if lip or voice or final:
        if not audio.get("file"):
            raise BuildError("An audio route is on but no audio file is chosen.")
        try:
            audio_value = pj.input_path_value(audio["file"], audio.get("subfolder", ""))
        except ValueError as err:
            raise BuildError(f"Audio file: {err}") from None
        raw = g.add("audio_file", "LoadAudio", "Load Audio", audio=audio_value)
        length = _num(audio.get("length", 0), "Audio length", 0, 1e7)
        loader = g.add("audio", "TrimAudioDuration", "Trim Audio", audio=raw,
                       start_index=_num(audio.get("start", 0), "Audio start", 0, 1e7),
                       duration=length if length > 0 else 1e7)
        if lip and per_shot_pin:
            # 0.9.3: the whole song, pinned to each Shot's timeline from its song_at
            long_extra["song"] = g.add("song", "MiniMaxH3SongTrack", "MiniMax H3 Song Track",
                                       audio=raw, audio_vae=avae)
        elif lip:
            if lipsong and positions is not None:
                warnings.append("Update H3 Long Shot to 1.6.19 or later so the pinned song starts where "
                                "each Shot sits on the film; until then it follows this render only.")
            long_extra["song"] = g.add("song", "MiniMaxH3SongTrack", "MiniMax H3 Song Track",
                                       audio=loader, audio_vae=avae)
            total = sum(float(x.get("seconds", 0)) for x in chain)
            length = float(audio.get("length", 0) or 0)
            if length and length + 0.5 < total:
                warnings.append(f"The song clip is {length:g}s but the Shots add up to "
                                f"{total:g}s; Long Shot will stop with an error.")
        if voice:
            mel = g.add("melband", "MelBandRoFormerModelLoader", "MelBand RoFormer",
                        model_name=audio.get("melband_model")
                        or s.get("melband_model")
                        or "Infinite Talk\\MelBandRoformer_fp16.safetensors")
            long_extra["ref_audios.ref_audio_0"] = g.add(
                "vocals", "MelBandRoFormerSampler", "MelBand vocals", model=mel, audio=loader)

    # voice references (audio cards in Cast & Scenes): <Audio N> after the song's vocals
    slot0 = 0 if per_shot_song else (1 if voice or songref else 0)   # Long Shot puts song_ref before ref_audios
    base = video_audio_count(project) + (1 if voice or songref else 0)   # 0.17.1: video soundtracks first
    for k, v in enumerate(active_voices(project)):
        a_label = f"<Audio {base + k + 1}>"
        try:
            value = pj.input_path_value(v["file"], v.get("subfolder", ""))
        except ValueError as err:
            raise BuildError(f"{v.get('label') or a_label}: {err}") from None
        vraw = g.add(f"voicefile{k + 1}", "LoadAudio", f"{a_label} {v.get('label', '')}".strip(), audio=value)
        vlen = _num(v.get("length", 0) or 0, f"{a_label} length", 0, 1e7)
        long_extra[f"ref_audios.ref_audio_{slot0 + k}"] = g.add(
            f"voice{k + 1}", "TrimAudioDuration", f"Trim {a_label}", audio=vraw,
            start_index=_num(v.get("start", 0) or 0, f"{a_label} start", 0, 1e7),
            duration=vlen if vlen > 0 else 1e7)

    # --- Long Shot ---------------------------------------------------------------
    # --- refine pass (0.10.0, Long Shot 1.7.0) -------------------------------------
    rc = refine_settings(project, env)
    if rc is not None:
        mode = "new and locked takes" if (upscale_final or refine_export) else \
            ("off" if rc.get("export_only") else "new takes")
        if mode != "off":
            rmodel, rsigmas = _refine_nodes(g, project, rc, env, sage if sage not in ("disabled", "off", False) else None)
            long_extra.update(refine_model=rmodel, refine_sigmas=rsigmas, refine_mode=mode,
                              refine_key=rc["key"], model_name=str(s.get("model") or ""),
                              refine_model_name=str(rc["model"]))
            ids["refine"] = {"mode": mode, "key": rc["key"]}
    long_shot = g.add("longshot", "MiniMaxH3LongShot", "MiniMax H3 Long Shot",
                      model=model, clip=clip, vae=vae, noise=noise, sampler=sampler,
                      sigmas=sigmas, prompt=_out(builder, 3), width=width, height=height,
                      overlap_frames=overlap, seed_mode=seed_mode, dry_run=bool(dry_run),
                      reuse_segments=True, ref_image_size=ref_size,
                      save_to_disk=True,          # takes are what locked Shots load
                      cache_name=project_slug(project), audio_vae=avae,
                      **long_extra, **refs, **refmod_input)

    if long_shot_only:
        # 0.10.0: just the run (an export refines its locked takes; Take nodes follow it)
        ids.update(longshot="longshot", builder="builder")
        return Build(prompt=g.nodes, width=width, height=height, chain=[x.get("id") for x in chain],
                     nodes=ids, filename_prefix="", video_format="", warnings=warnings)

    # --- output: each new take's own clip (renders while reviewing) -----------------
    ids_in_chain = [str(x.get("id")) for x in chain if x.get("kind") != "clip"]
    targets = [i for i in dict.fromkeys(clip_ids) if i in ids_in_chain]
    if targets:
        fmt = _video_format(env, warnings)
        clips = {}
        for n, sid in enumerate(targets, 1):
            lat = g.add(f"take{n}", "MiniMaxH3Take", f"[{sid}] its take", cache_name=project_slug(project),
                        take="", shot_id=sid, after=_out(long_shot, 1))
            imgs = _maybe_vsr(g, n, s, g.add(f"clipdec{n}", "VAEDecode", "VAE Decode", samples=lat, vae=vae))
            if final and loader is not None and positions is not None and sid in positions:
                # 0.9.2: the song where this take starts on the film, for its whole window
                f0, win = positions[sid]
                aud = g.add(f"clipsong{n}", "TrimAudioDuration", f"[{sid}] its part of the song",
                            audio=raw, start_index=round(max(0.0, song_start + f0 / film.FPS), 4),
                            duration=round(win / film.FPS, 4))
            elif final and loader is not None and env.has("MiniMaxH3SongCut"):
                # 0.9.0: "Song in final video": the clip carries the song where this take sits
                aud = g.add(f"clipsong{n}", "MiniMaxH3SongCut", f"[{sid}] its part of the song",
                            audio=loader, latent=_out(long_shot, 0), shot_id=sid)
            else:
                if final and loader is not None:
                    msg = "Update H3 Long Shot to 1.6.17 or later to put the song on each Shot's clip."
                    if msg not in warnings:
                        warnings.append(msg)
                aud = g.add(f"clipaud{n}", "VAEDecodeAudio", "VAE Decode Audio", samples=lat, vae=avae)
            clips[sid] = _clip_save(g, n, project, imgs, aud, fmt,
                                    re.sub(r"[^A-Za-z0-9_-]+", "_", sid)[:64] or "shot")[0]
        ids.update(longshot="longshot", builder="builder", clips=clips)
        return Build(prompt=g.nodes, width=width, height=height,
                     chain=[x.get("id") for x in chain], nodes=ids,
                     filename_prefix=clips_subfolder(project), video_format=fmt, warnings=warnings)

    # --- output: the stitched film, decoded once ------------------------------------
    images = g.add("decode", "VAEDecode", "VAE Decode", samples=long_shot, vae=vae)
    if upscale_final and s.get("clip_pixels") and any(sh.get("kind") == "clip" for sh in chain):
        images = g.add("clip_pixels", "MiniMaxH3ClipPixels", "Original clip pixels",
                       images=images, latent=long_shot, enabled=True)
    faced = [sh for sh in chain if shot_face_on(sh)] if upscale_final else []
    if faced:
        # 0.15.0: each Shot set to Refined gets its approved face-refined faces back, over its
        # own frames of the film (only around the faces; nothing is redrawn here)
        if not env.has("MiniMaxH3PasteFaces"):
            raise BuildError("Refined faces in the final video need H3 Long Shot 1.8.1 or later. Update it, "
                             "then restart ComfyUI (or set those Shots to Original).")
        if env.planner is None:
            warnings.append("Couldn't place the refined faces (H3 Long Shot's planner isn't loaded): the final "
                            "video has the original faces.")
        else:
            spans = film.render_spans(chain, overlap, env.planner, with_start=True)
            rows = []
            for sh in faced:
                sp = spans.get(str(sh.get("id")))
                fc = sh["face"]
                if not sp:
                    continue
                first, end, ws = sp
                rows.append({"file": f"{clips_subfolder(project)}/{str(fc['take'])[:-len('.safetensors')]}{FACE_CLIP_SUFFIX}.mp4",
                             "at": first, "from": first - ws, "frames": end - first,
                             "w": int(fc.get("w") or 0), "h": int(fc.get("h") or 0), "faces": face_rows(fc),
                             "shapes": face_shapes(fc)})
            if rows:
                images = g.add("faces", "MiniMaxH3PasteFaces", "Refined faces", images=images, items=json.dumps(rows))
                ids["faces"] = "faces"
    vsr = s.get("rtx_vsr") or {}
    upscales = final_up or (not upscale_final and bool(vsr.get("on")))
    if upscales:
        vsr_quality = vsr.get("quality", "ULTRA")
        if vsr_quality not in VSR_QUALITIES:
            raise BuildError(f"RTX Super Resolution quality must be one of {', '.join(VSR_QUALITIES)}.")
        vsr_scale = _num(vsr.get("scale", 2.0), "RTX upscale factor", 1, 4)
    if upscales and chunk is None:
        # NVIDIA RTX Video Super Resolution on the decoded frames, before saving.
        # Runs after Long Shot, so it never changes which segments are reused.
        images = g.add("vsr", "RTXVideoSuperResolution", "RTX Video Super Resolution",
                       images=images, resize_type="scale by multiplier",
                       **{"resize_type.scale": vsr_scale}, quality=vsr_quality)
    # Song in final video: the loader's (trimmed) audio replaces H3's decoded
    # audio, so the decoder isn't built at all.
    decoded_audio = None if final or (chunk is not None and not chunk["audio"]) else \
        g.add("decode_audio", "VAEDecodeAudio", "VAE Decode Audio", samples=long_shot, vae=avae)
    fmt = _video_format(env, warnings)
    # Renders go into the project's own folder, next to its takes:
    # output/longshot/<slug>/videos/<Name>_00001-audio.mp4
    prefix = f"{videos_subfolder(project)}/{safe_name(project.get('name'))}" + \
        (("_final" if final_up else "_final_native") if upscale_final else "")
    out_audio = loader if final else decoded_audio
    if chunk is not None:
        # A chunk: frames start .. start+length-1, upscaled a few at a time and
        # piped straight into the encoder (no sound; joined later). Nothing big is
        # left in ComfyUI's cache, so chunks don't pile up in RAM. The sound goes
        # to a WAV once, with the first chunk.
        if not upscales:
            vsr_scale, vsr_quality = 1.0, "ULTRA"     # Long Shot 1.6.10: encode only
        name = safe_name(project.get("name"))
        cprefix = f"{videos_subfolder(project)}/_chunks/{name}" + (("_final" if final_up else "_final_native") if upscale_final else "") + \
            f"_c{chunk['index']:03d}"
        master = upscale_final and bool(s.get("prores_master"))
        g.add("upscale_chunk", "MiniMaxH3UpscaleChunk", "Upscale chunk → file", images=images,
              start=chunk["start"], length=chunk["length"], scale=vsr_scale, quality=vsr_quality,
              filename_prefix=cprefix, codec="h264_nvenc" if fmt == NVENC else "libx264",
              master_prefix=cprefix + "_master" if master else "", frame_rate=float(FPS))
        ids.update(chunk="upscale_chunk", combine="combine",
                   chunk_codec="h264_nvenc" if fmt == NVENC else "libx264")   # 0.9.0: black joins them
        if master:
            ids["prores"] = "combine_prores"
        if chunk["audio"]:
            # one WAV per decode run (0.8.5): the chunk that opens each run saves its sound
            g.add("save_audio", "MiniMaxH3SaveAudio", "Sound for the chunks", audio=out_audio,
                  filename_prefix=f"{videos_subfolder(project)}/_chunks/{name}_audio" +
                  (f"_c{chunk['index']:03d}" if chunk["index"] else ""))
            ids["audio_file"] = "save_audio"
        ids.update(longshot="longshot", builder="builder")
        return Build(prompt=g.nodes, width=width, height=height,
                     chain=[x.get("id") for x in chain], nodes=ids, filename_prefix=prefix,
                     video_format=fmt, warnings=warnings)
    # 0.8.7: Long Shot's Save Video (was Video Combine): H.264 mp4, and the ProRes master
    sound = {} if out_audio is None else {"audio": out_audio}
    g.add("combine", "MiniMaxH3SaveVideo", "Save Video", images=images, filename_prefix=prefix,
          codec=_codec(fmt), frame_rate=float(FPS), **sound)
    if upscale_final and s.get("prores_master"):
        g.add("combine_prores", "MiniMaxH3SaveVideo", "ProRes master", images=images,
              filename_prefix=prefix + "_master", codec="prores_hq", frame_rate=float(FPS), **sound)
        ids["prores"] = "combine_prores"

    ids.update(longshot="longshot", combine="combine", builder="builder")
    return Build(prompt=g.nodes, width=width, height=height,
                 chain=[x.get("id") for x in chain], nodes=ids, filename_prefix=prefix,
                 video_format=fmt, warnings=warnings)


# ---------------------------------------------------------------------------
# 0.20.0: Images. MiniMax-H3-Image (ComfyUI 0.44.0+, core nodes): one picture from a
# prompt and the project's reference pictures (<Picture 1..N>), or an edit of a
# picture (it becomes <Picture 1>; the references follow as <Picture 2..>).
#
#     UNETLoader (image model) -> KSampler (6 steps, cfg 1, euler / simple)
#     CLIPLoader (the video text encoder) + VAELoader (image VAE)
#     LoadImage x N -> MiniMax H3 Image Conditioning (prompt, width, height, images.image_k)
#     ConditioningZeroOut -> negative;  VAEDecode -> SaveImage output/longshot/<slug>/images
#     [CLIPLoader (Qwen3.5) -> StringReplace -> TextGenerateV2 -> JsonExtractString: Expand prompt]
# ---------------------------------------------------------------------------

IMAGES_SUBFOLDER = "images"
IMAGE_MEGAPIXELS = [4, 6, 8, 12, 16, 20]       # 0.21.3: H3-Image works from about 4 MP up
IMAGE_MAX_REFS = 9
IMAGE_DEFAULTS = {"model": "", "vae": "", "expander": "", "steps": 6, "cfg": 1.0, "sampler": "euler",
                  "scheduler": "simple", "megapixels": 4, "aspect": "1:1", "keep": 20,
                  # 0.22.0, after n8te0's 20 MP workflow: the LCM sampler with per-step noise 1.1 -> 0.9
                  "sampler_kind": "lcm", "lcm_start": 1.1, "lcm_end": 0.9, "lcm_clip": 0.0,
                  "pe_thinking": False, "format": "png", "avif_crf": 18}
IMAGE_NODE = "MiniMaxH3ImageConditioning"
# Where each file comes from (the links the Studio shows when one is missing)
IMAGE_FILES = {
    "model": {"name": "minimax_h3_image_pruned_int8_convrot.safetensors", "folder": "diffusion_models", "size": "21 GB",
              "url": "https://huggingface.co/Comfy-Org/MiniMax-H3-Image/resolve/main/diffusion_models/minimax_h3_image_pruned_int8_convrot.safetensors"},
    "vae": {"name": "minimax_h3_image_vae_fp16.safetensors", "folder": "vae", "size": "0.7 GB",
            "url": "https://huggingface.co/Comfy-Org/MiniMax-H3-Image/resolve/main/vae/minimax_h3_image_vae_fp16.safetensors"},
    "clip": {"name": "qwen3vl_32b_minimax_h3_int8_convrot.safetensors", "folder": "text_encoders", "size": "25 GB",
             "url": "https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/text_encoders/qwen3vl_32b_minimax_h3_int8_convrot.safetensors"},
    "expander": {"name": "qwen3.5_9b_w4a8_gptq.safetensors", "folder": "text_encoders", "size": "6 GB",
                 "url": "https://huggingface.co/Comfy-Org/Qwen3.5/resolve/main/text_encoders/qwen3.5_9b_w4a8_gptq.safetensors"},
}
PACKS.update({
    IMAGE_NODE: "ComfyUI core 0.44.0+ (update ComfyUI)",
    "TextGenerateV2": "ComfyUI core 0.44.0+ (update ComfyUI)",
    "JsonExtractString": "ComfyUI core 0.44.0+ (update ComfyUI)",
})


def image_settings(project: dict) -> dict:
    s = project.get("settings") or {}
    return dict(IMAGE_DEFAULTS, **(s.get("image") or {}))


def images_subfolder(project: dict) -> str:
    return f"{OUTPUT_SUBFOLDER}/{project_slug(project)}/{IMAGES_SUBFOLDER}"


def image_size(megapixels, aspect, like=None) -> tuple[int, int]:
    """The canvas: an aspect preset, or the shape of the picture being edited (`like`:
    (width, height)), at the megapixel budget, in multiples of 32. 0.22.0: H3-Image counts
    1 MP as 1,000,000 pixels (as its published sizes and n8te0's workflow do)."""
    mp = _num(megapixels, "Image size (MP)", 0.25, 64)
    if like and like[0] and like[1]:
        w, h = int(like[0]), int(like[1])
    else:
        if aspect not in ASPECTS:
            raise BuildError(f"Unknown aspect {aspect!r}. Choose one of {', '.join(ASPECTS)}.")
        w, h = ASPECTS[aspect]
    return (max(32, round(math.sqrt(w / h * mp * 1_000_000) / 32) * 32),
            max(32, round(math.sqrt(h / w * mp * 1_000_000) / 32) * 32))


def expander_type(name) -> str:
    """CLIPLoader type for a prompt expander file: Qwen3.5 loads as 'minimax' (ComfyUI's template),
    other Qwen files (Qwen3.8-27B...) as 'stable_diffusion' (n8te0's workflow)."""
    return "minimax" if re.search(r"qwen[\s_.-]*3[._]?5", str(name or ""), re.I) else "stable_diffusion"


def _picture_path(ref: dict, what: str) -> str:
    """What LoadImage takes: an input file, or an output file with ComfyUI's [output] mark."""
    name, sub = str(ref.get("image") or ref.get("filename") or ""), str(ref.get("subfolder") or "")
    try:
        if ref.get("type") == "output":
            return pj.output_path_value(name, sub)
        return pj.input_path_value(name, sub)
    except ValueError as err:
        raise BuildError(f"{what}: {err}") from None


def build_image(project: dict, item: dict, env: Env | None = None) -> Build:
    """item: {text, expand, edit: {image, subfolder, type, width?, height?} | null,
    refs: [{image, subfolder, type, label}], megapixels, aspect, seed, steps, name}."""
    env = env or Env()
    if not env.has(IMAGE_NODE):
        raise BuildError("This ComfyUI has no MiniMax H3 Image Conditioning node: update ComfyUI to 0.44.0 or later, "
                         "then restart it.")
    s = project.get("settings") or {}
    im = image_settings(project)
    item = item or {}
    for key, label in (("model", "image model"), ("vae", "image VAE")):
        if not im.get(key):
            raise BuildError(f"Image settings: choose the {label} file.")
    if not s.get("clip"):
        raise BuildError("Settings: choose a text encoder file (it's shared with the video renders).")
    text = str(item.get("text") or "").strip()
    if not text:
        raise BuildError("The Picture has no prompt.")
    refs = [r for r in (item.get("refs") or []) if isinstance(r, dict) and (r.get("image") or r.get("filename"))]
    edit = item.get("edit") if isinstance(item.get("edit"), dict) and (item["edit"].get("image") or item["edit"].get("filename")) else None
    pictures = ([edit] if edit else []) + refs
    if len(pictures) > IMAGE_MAX_REFS:
        raise BuildError(f"At most {IMAGE_MAX_REFS} pictures: the one to edit and {IMAGE_MAX_REFS - 1} references. Bypass some.")
    expand = bool(item.get("expand"))
    if expand and not im.get("expander"):
        raise BuildError("Expand prompt needs the prompt expander file (Image settings).")
    if expand and not (env.has("TextGenerateV2") and env.has("JsonExtractString")):
        raise BuildError("Expand prompt needs ComfyUI 0.44.0 or later (Generate Text). Update ComfyUI, then restart it.")
    steps = int(_num(item.get("steps", im["steps"]), "Steps", 1, 200, kind=int))
    seed = _seed(item.get("seed", 0), "Seed")
    mp = max(4.0, float(_num(item.get("megapixels", im["megapixels"]), "Image size (MP)", 0.25, 64)))
    aspect = str(item.get("aspect") or im["aspect"])
    if edit and edit.get("width") and edit.get("height"):
        width, height = image_size(mp, aspect, (edit["width"], edit["height"]))
    elif edit:
        width, height = 0, 0            # the node takes the edited picture's size
    else:
        width, height = image_size(mp, aspect)
    warnings = []
    if (width * height or 4_000_000) < 3_500_000:
        warnings.append("MiniMax-H3-Image loses detail under about 4 MP; 4–20 MP is its range.")

    g = _Graph()
    model = g.add("img_model", "UNETLoader", "Image model", unet_name=im["model"], weight_dtype="default")
    clip = g.add("img_clip", "CLIPLoader", "Text encoder", clip_name=s["clip"], type="minimax", device="default")
    vae = g.add("img_vae", "VAELoader", "Image VAE", vae_name=im["vae"])
    loaders = {}
    for k, ref in enumerate(pictures, 1):
        what = "The picture to edit" if (edit and k == 1) else f"Reference {k - (1 if edit else 0)} ({ref.get('label') or ref.get('image')})"
        loaders[k] = g.add(f"pic{k}", "LoadImage", f"<Picture {k}> {ref.get('label') or ref.get('image') or ''}".strip(),
                           image=_picture_path(ref, what))
    prompt_in = text
    if expand:
        from . import image_pe
        pe_clip = g.add("pe_clip", "CLIPLoader", "Prompt expander", clip_name=im["expander"],
                        type=expander_type(im["expander"]), device="default")
        ask = g.add("pe_ask", "StringReplace", "Expander brief", string=image_pe.EDIT_SYSTEM if pictures else image_pe.T2I_SYSTEM,
                    find=image_pe.PLACEHOLDER, replace=text)
        gen_in = {f"images.image{k}": v for k, v in loaders.items()}
        thinking = bool(im.get("pe_thinking"))
        gen = g.add("pe", "TextGenerateV2", "Expand prompt", clip=pe_clip, prompt=ask,
                    system_prompt=image_pe.EFFORT + image_pe.PREFIX,
                    max_length=8192, sampling_mode="on", thinking=thinking, use_default_template=True,
                    mtp="off",       # 0.21.3: speculative decoding crashed in comfy_kitchen's flash attention
                    **{
                        "sampling_mode.temperature": 1.0, "sampling_mode.top_k": 20, "sampling_mode.top_p": 0.95,
                        "sampling_mode.min_p": 0.0, "sampling_mode.repetition_penalty": 1.0,
                        "sampling_mode.presence_penalty": 0.0, "sampling_mode.seed": 0}, **gen_in)
        prompt_in = g.add("pe_text", "JsonExtractString", "Expanded caption", json_string=_out(gen, 0), key="expanded_caption")
    cond_in = {f"images.image_{k - 1}": v for k, v in loaders.items()}     # 0.22.0: image_0 is <Picture 1>
    cond = g.add("cond", IMAGE_NODE, "MiniMax H3 Image Conditioning", clip=clip, vae=vae, prompt=prompt_in,
                 width=width, height=height, **cond_in)
    sched = str(im.get("scheduler") or "simple")
    if im.get("sampler_kind", "lcm") == "lcm" and env.has("SamplerLCM"):
        # 0.22.0: n8te0's 20 MP workflow: LCM with per-step noise start -> end, BasicGuider (no CFG)
        smp = g.add("lcm", "SamplerLCM", "Sampler LCM", s_noise=_num(im.get("lcm_start", 1.1), "LCM noise start", 0, 64),
                    s_noise_end=_num(im.get("lcm_end", 0.9), "LCM noise end", 0, 64),
                    noise_clip_std=_num(im.get("lcm_clip", 0.0), "LCM noise clip", 0, 10))
        sigmas = g.add("sched", "BasicScheduler", "BasicScheduler", model=model, scheduler=sched, steps=steps, denoise=1.0)
        noise = g.add("noise", "RandomNoise", "RandomNoise", noise_seed=seed)
        guider = g.add("guider", "BasicGuider", "BasicGuider", model=model, conditioning=_out(cond, 0))
        sampler = g.add("sampler", "SamplerCustomAdvanced", "Sample", noise=noise, guider=guider, sampler=smp,
                        sigmas=sigmas, latent_image=_out(cond, 1))
    else:
        if im.get("sampler_kind", "lcm") == "lcm":
            warnings.append("This ComfyUI has no Sampler LCM node, so the picture is sampled with euler. Update ComfyUI.")
        neg = g.add("neg", "ConditioningZeroOut", "Negative (none)", conditioning=_out(cond, 0))
        sampler = g.add("sampler", "KSampler", "Sample", model=model, positive=_out(cond, 0), negative=neg,
                        latent_image=_out(cond, 1), seed=seed, steps=steps, cfg=float(im.get("cfg", 1.0)),
                        sampler_name=str(im.get("sampler") or "euler"), scheduler=sched, denoise=1.0)
    images = g.add("decode", "VAEDecode", "VAE Decode", samples=_out(sampler, 0), vae=vae)
    stem = re.sub(r"[^A-Za-z0-9_-]+", "_", str(item.get("name") or "picture")).strip("_")[:60] or "picture"
    prefix = images_subfolder(project)
    if im.get("format") == "avif" and env.has("SaveImageAdvanced"):
        g.add("save", "SaveImageAdvanced", f"Save {stem} (AVIF)", images=images, filename_prefix=f"{prefix}/{stem}",
              format="avif", **{"format.bit_depth": "auto", "format.input_color_space": "sRGB",
                                "format.crf": int(_num(im.get("avif_crf", 18), "AVIF quality", 1, 63, int)),
                                "format.save_mode": "still images"})
    else:
        g.add("save", "SaveImage", f"Save {stem}", images=images, filename_prefix=f"{prefix}/{stem}")
    nodes = {"sampler": "sampler", "save": "save", "longshot": "sampler", "combine": "decode", "cond": "cond"}
    if expand:
        nodes["expand"] = "pe_text"
    return Build(prompt=g.nodes, width=width, height=height, chain=[], nodes=nodes,
                 filename_prefix=prefix, video_format="", warnings=warnings)


# ---------------------------------------------------------------------------
# 0.21.0: Stills with the video model. The Images side's default engine: the project's own
# H3 video model (Settings: model, text encoder, VAEs, shift, Turbo, LoRAs, steps) renders
# the shortest clip H3 allows from the References (<Picture 1..N>) with a "nothing moves"
# tail on the prompt, and the middle frame is saved as the picture.
#
#     UNETLoader -> [Sage] -> SigmaShift -> [Turbo] -> [LoRA x3] -> BasicScheduler / KSamplerSelect / RandomNoise
#     LoadImage -> ImageScaleToMaxDimension -> MiniMax H3 Reference to Video (prompt, size, length)
#     BasicGuider -> SamplerCustomAdvanced -> VAEDecode -> ImageFromBatch (middle) -> [RTX VSR] -> SaveImage
# ---------------------------------------------------------------------------

STILL_FRAMES = [5, 22, 39]
STILL_TAIL = ("A single still frame: the camera is static and nothing moves; everything stays exactly as it is "
              "for the whole shot. No dialogue.")
STILL_DEFAULTS = {"engine": "video", "frames": 22, "tail": STILL_TAIL, "upscale": False, "scale": 2.0,
                  "quality": "ULTRA", "megapixels": 1.0, "aspect": "16:9"}


def still_settings(project: dict) -> dict:
    s = project.get("settings") or {}
    return dict(STILL_DEFAULTS, **(s.get("image") or {}))


def _tag(label: str, k: int) -> str:
    """A reference's tag in the prompt: its label as <label>, or <Picture k>."""
    name = re.sub(r"[<>]", "", str(label or "")).strip()
    return f"<{name}>" if name else picture_label(k - 1)


def still_prompt(project: dict, text: str, pictures: list, tail: str, edit: bool = False) -> str:
    """The r2v six sections for one still: each reference a subject whose appearance comes
    from its <Picture k>, fully preserved; the Style panel's look line; the user's text as
    [Shot 1] with the still tail; no sound."""
    style = project.get("style") or {}
    own = (project.get("settings") or {}).get("image") or {}      # 0.21.5: the stills' own style line / summary
    defs, ret = [], []
    for k, ref in enumerate(pictures, 1):
        tag = _tag(ref.get("label"), k)
        pic = picture_label(k - 1)
        desc = str(ref.get("desc") or "").strip().rstrip(".")
        if edit and k == 1:
            # To edit: the picture itself is the starting point, changed only as the text says
            defs.append(f"{tag} is the scene in {pic}: its people, objects, place, light and composition.")
            ret.append(f"{tag} (appears in [Shot 1]): partially_preserved - kept as it is except for what the "
                       "description changes.")
            continue
        defs.append(f"{tag} is {desc}, whose appearance comes from {pic}." if desc else f"{tag} is the subject shown in {pic}.")
        ret.append(f"{tag} (appears in [Shot 1]): fully_preserved - appearance, identity, colours and materials.")
    look = str(own.get("style_line") or "").strip() or str(style.get("style_line") or "").strip()
    body = str(text or "").strip()
    if body and not body.endswith((".", "!", "?")):
        body += "."
    shot = f"[Shot 1] {body} {str(tail or '').strip()}".strip()
    out = []
    if defs:
        out.append("subject_definitions: " + " ".join(defs))
    summary = str(own.get("summary") or "").strip()
    out.append("summary: [reference generation] " + (summary if summary else
                                                    f"A single static frame: {body or 'the scene described below.'}"))
    if ret:
        out.append("retention_analysis: " + "\n".join(ret))
    out.append("detailed_description: " + (look + " " if look else "") + shot)
    out.append("overall_soundscape: N/A")
    out.append("non_diegetic_music: N/A")
    return "\n".join(out)


def build_still(project: dict, item: dict, env: Env | None = None) -> Build:
    """item: {text, edit: {image, subfolder, type, label, desc?} | null, refs: [{image, subfolder, type,
    label, desc}], megapixels, aspect, seed, steps?, frames?, name}. The picture being edited (To edit)
    is <Picture 1>; the References follow."""
    env = env or Env()
    s = project.get("settings") or {}
    st = still_settings(project)
    item = item or {}
    for key in ("model", "clip", "video_vae", "audio_vae"):
        if not s.get(key):
            raise BuildError(f"Settings (Video side): choose a {key.replace('_', ' ')} file; stills use the video model.")
    need = ["UNETLoader", "CLIPLoader", "VAELoader", "MiniMaxH3SigmaShift", "MiniMaxH3ReferenceToVideo",
            "BasicScheduler", "KSamplerSelect", "RandomNoise", "BasicGuider", "SamplerCustomAdvanced",
            "VAEDecode", "ImageFromBatch", "SaveImage", "ImageScaleToMaxDimension"]
    missing = [c for c in need if not env.has(c)]
    if missing:
        raise BuildError("ComfyUI is missing node(s) this needs:\n  " +
                         "\n  ".join(f"{c} — from {PACKS.get(c, 'ComfyUI core (update ComfyUI)')}" for c in missing))
    text = str(item.get("text") or "").strip()
    if not text:
        raise BuildError("The Picture has no prompt.")
    refs = [r for r in (item.get("refs") or []) if isinstance(r, dict) and (r.get("image") or r.get("filename"))]
    edit = item.get("edit") if isinstance(item.get("edit"), dict) and (item["edit"].get("image") or item["edit"].get("filename")) else None
    pictures = ([edit] if edit else []) + refs
    if len(pictures) > MAX_REFERENCES:
        raise BuildError(f"At most {MAX_REFERENCES} pictures (the one to edit and the References). Bypass some.")
    # 0.21.4: any H3 video model takes the References (fl2va too, as on the Video side)
    frames = int(_num(item.get("frames", st.get("frames", 22)), "Frames", 5, 362, kind=int))
    if (frames - 5) % 17:
        raise BuildError("Frames must be 5, 22, 39… (17k + 5).")
    steps = int(_num(item.get("steps", s.get("steps", 8)), "Steps", 1, 200, kind=int))
    seed = _seed(item.get("seed", 0), "Seed")
    width, height = output_size(item.get("megapixels", st.get("megapixels", 1.0)),
                                str(item.get("aspect") or st.get("aspect") or "16:9"))
    warnings = []
    tail = str(item.get("tail") or st.get("tail") or STILL_TAIL)

    g = _Graph()
    model = g.add("unet", "UNETLoader", "Load Diffusion Model", unet_name=s["model"],
                  weight_dtype=s.get("weight_dtype", "default"))
    sage = s.get("sage_attention", "auto")
    if sage and sage not in ("disabled", "off", False) and env.has("PathchSageAttentionKJ"):
        model = g.add("sage", "PathchSageAttentionKJ", "Patch Sage Attention KJ", model=model,
                      sage_attention=sage, allow_compile=False)
    model = g.add("shift", "MiniMaxH3SigmaShift", "ModelSamplingMiniMaxH3", model=model,
                  shift_video=_num(s.get("shift_video", 12), "Video shift", 0.01, 100),
                  shift_audio=_num(s.get("shift_audio", 3), "Audio shift", 0.01, 100))
    turbo = s.get("turbo") or {}
    if turbo.get("on"):
        if not turbo.get("lora"):
            raise BuildError("Turbo is on but no Turbo LoRA file is chosen (Settings).")
        strength = _num(turbo.get("strength", 1.0), "Turbo strength", -10, 10)
        if env.has("MiniMaxH3TurboLoRA"):
            model = g.add("turbo", "MiniMaxH3TurboLoRA", "MiniMax-H3 Turbo LoRA", model=model,
                          lora_name=turbo["lora"], strength=strength, low_vram=bool(turbo.get("low_vram", False)))
        else:
            model = g.add("turbo", "LoraLoaderModelOnly", "Turbo LoRA (stock loader)", model=model,
                          lora_name=turbo["lora"], strength_model=strength)
    elif steps < 20 and not re.search(r"fast[\s_-]?h3", str(s.get("model") or ""), re.I):
        warnings.append(f"Turbo is off and steps are at {steps}. Without Turbo, H3 needs about 20 steps or more.")
    for n, lora in enumerate((s.get("loras") or [])[:3], 1):
        if not lora.get("on"):
            continue
        if not lora.get("name"):
            raise BuildError(f"LoRA {n} is switched on but has no file chosen.")
        model = g.add(f"lora{n}", "LoraLoaderModelOnly", f"LoRA {n}", model=model, lora_name=lora["name"],
                      strength_model=_num(lora.get("strength", 1.0), f"LoRA {n} strength", -100, 100))
    clip = g.add("clip", "CLIPLoader", "Load CLIP", clip_name=s["clip"], type="minimax", device="default")
    vae = g.add("vae_video", "VAELoader", "Video VAE", vae_name=s["video_vae"])
    avae = g.add("vae_audio", "VAELoader", "Audio VAE", vae_name=s["audio_vae"])
    sigmas = g.add("scheduler", "BasicScheduler", "BasicScheduler", model=model,
                   scheduler=s.get("scheduler", "beta"), steps=steps, denoise=1.0)
    sampler = g.add("sampler", "KSamplerSelect", "KSamplerSelect", sampler_name=s.get("sampler", "er_sde"))
    noise = g.add("noise", "RandomNoise", "RandomNoise", noise_seed=seed)

    resize_px = _num(s.get("ref_resize_px", 1500), "Reference resize", 16, 8192, int)
    ref_in = {}
    for k, ref in enumerate(pictures, 1):
        what = "The picture to edit" if (edit and k == 1) else f"Reference {k - (1 if edit else 0)} ({ref.get('label') or ref.get('image')})"
        img = g.add(f"img{k}", "LoadImage", f"{picture_label(k - 1)} {ref.get('label') or ''}".strip(),
                    image=_picture_path(ref, what))
        ref_in[f"ref_images.ref_image_{k - 1}"] = g.add(f"resize{k}", "ImageScaleToMaxDimension", f"Resize {picture_label(k - 1)}",
                                                        image=img, upscale_method="lanczos", largest_size=resize_px)
    ref_size = s.get("ref_image_size", "match")
    if ref_size not in ("match", "max"):
        ref_size = "match"
    prompt = still_prompt(project, text, pictures, tail, edit=bool(edit))
    cond = g.add("r2v", "MiniMaxH3ReferenceToVideo", "MiniMax H3 Reference to Video", clip=clip, vae=vae,
                 audio_vae=avae, prompt=prompt, width=width, height=height, length=frames, ref_image_size=ref_size, **ref_in)
    guider = g.add("guider", "BasicGuider", "BasicGuider", model=model, conditioning=_out(cond, 0))
    out = g.add("sample", "SamplerCustomAdvanced", "SamplerCustomAdvanced", noise=noise, guider=guider,
                sampler=sampler, sigmas=sigmas, latent_image=_out(cond, 1))
    images = g.add("decode", "VAEDecode", "VAE Decode", samples=_out(out, 0), vae=vae)
    images = g.add("middle", "ImageFromBatch", f"Middle frame ({frames // 2 + 1} of {frames})", image=images,
                   batch_index=frames // 2, length=1)
    scale = 1.0
    if item.get("upscale", st.get("upscale")) and env.has("RTXVideoSuperResolution"):
        quality = str(item.get("quality", st.get("quality", "ULTRA")))
        if quality not in VSR_QUALITIES:
            quality = "ULTRA"
        scale = _num(item.get("scale", st.get("scale", 2.0)), "RTX upscale factor", 1, 4)
        images = g.add("vsr", "RTXVideoSuperResolution", "RTX Video Super Resolution", images=images,
                       resize_type="scale by multiplier", **{"resize_type.scale": scale}, quality=quality)
    elif item.get("upscale", st.get("upscale")):
        warnings.append("RTX Super Resolution isn't installed, so the still is saved at the render size.")
    stem = re.sub(r"[^A-Za-z0-9_-]+", "_", str(item.get("name") or "picture")).strip("_")[:60] or "picture"
    prefix = images_subfolder(project)
    g.add("save", "SaveImage", f"Save {stem}", images=images, filename_prefix=f"{prefix}/{stem}")
    nodes = {"sampler": "sample", "save": "save", "longshot": "sample", "combine": "decode", "cond": "r2v"}
    return Build(prompt=g.nodes, width=int(width * scale), height=int(height * scale), chain=[], nodes=nodes,
                 filename_prefix=prefix, video_format="", warnings=warnings)


def build_image_upscale(project: dict, item: dict, env: Env | None = None) -> Build:
    """0.21.3, Upscale this: one finished picture (an output file) through RTX Video Super
    Resolution, saved next to it as <name>_up_#####.png. item: {filename, subfolder, scale, quality}."""
    env = env or Env()
    if not env.has("RTXVideoSuperResolution"):
        raise BuildError("Upscale needs RTX Video Super Resolution (ComfyUI-NVIDIA-RTX-VSR-Pro). Install it, then restart ComfyUI.")
    item = item or {}
    name = str(item.get("filename") or "")
    src = _picture_path({"image": name, "subfolder": item.get("subfolder") or "", "type": item.get("type") or "output"},
                        "The picture to upscale")
    q = item.get("quality") if item.get("quality") in VSR_QUALITIES else "ULTRA"
    scale = _num(item.get("scale", 2), "Upscale", 1, 4)
    g = _Graph()
    img = g.add("up_src", "LoadImage", f"Picture {name}", image=src)
    up = g.add("vsr", "RTXVideoSuperResolution", "RTX Video Super Resolution", images=img,
               resize_type="scale by multiplier", **{"resize_type.scale": scale}, quality=q)
    stem = re.sub(r"[^A-Za-z0-9_-]+", "_", os.path.splitext(name)[0]).strip("_")[:70] or "picture"
    stem = re.sub(r"_\d{5}_?$", "", stem)
    prefix = images_subfolder(project)
    g.add("save", "SaveImage", f"Save {stem}_up", images=up, filename_prefix=f"{prefix}/{stem}_up")
    return Build(prompt=g.nodes, width=0, height=0, chain=[], nodes={"save": "save", "sampler": "vsr", "longshot": "vsr"},
                 filename_prefix=prefix, video_format="", warnings=[])
