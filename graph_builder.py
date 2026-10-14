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

import math
import re
from dataclasses import dataclass, field

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
MEGAPIXELS = [0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.98, 1.0, 1.2, 1.5, 1.8, 2.0]

# Which pack provides each node class, for "missing node" errors.
PACKS = {
    "MiniMaxH3TimelineShot": "H3 Long Shot 1.4.0+ (github.com/r34vtraining/H3_Longshot)",
    "MiniMaxH3Take": "H3 Long Shot 1.6.0+ (github.com/r34vtraining/H3_Longshot)",
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
}
VSR_QUALITIES = ["LOW", "MEDIUM", "HIGH", "ULTRA"]


TAKE_NAME_RE = re.compile(r"[A-Za-z0-9_-]{1,64}__\d{1,20}__[0-9a-f]{8}\.safetensors")


def _clip_nodes(g, n, shot, prev, vae, avae, width, height):
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


def audio_labels(project: dict) -> dict:
    """{voice id: '<Audio N>'}. The song's vocals (Audio → Voice reference) take
    <Audio 1> when that's on; voice references follow in card order."""
    base = 1 if (project.get("audio") or {}).get("voice_ref") else 0
    return {str(v.get("id")): f"<Audio {base + k + 1}>" for k, v in enumerate(active_voices(project))}


def voice_retention(project: dict) -> list:
    """retention_analysis lines for the voice references."""
    labels, cast = audio_labels(project), active_cast(project)
    out = []
    for v in active_voices(project):
        a = labels[str(v.get("id"))]
        who = [c.get("label") or picture_label(k) for k, c in enumerate(cast) if c.get("voice") == v.get("id")]
        out.append(f"{a} (voice timbre{' of ' + ', '.join(who) if who else ''}): reference - the voice "
                   "timbre only; what is said comes from each Shot's dialogue.")
    return out


MAX_REFMODS = 8             # Load H3 RefMods' slots
_REFMOD_KIND = {"image": "Picture", "video": "Video", "audio": "Audio"}


def active_refmods(project: dict) -> list:
    """RefMod cards (0.8.6) that are on and name a RefMod."""
    return [m for m in project.get("refmods") or []
            if isinstance(m, dict) and not m.get("bypassed") and m.get("name") and float(m.get("strength", 1) or 0) > 0]


def refmod_labels(project: dict) -> list:
    """Each active RefMod's label, numbered after the native references by kind,
    as Long Shot presents them (pictures after the Cast, audio after the voices)."""
    counts = {"image": len(active_cast(project)), "video": 0,
              "audio": len(audio_labels(project)) + (1 if (project.get("audio") or {}).get("voice_ref") else 0)}
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
    for n, t in enumerate(takes or [], 1):
        key, take = str(t.get("key") or ""), str(t.get("take") or "")
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,160}", key) or not TAKE_NAME_RE.fullmatch(take):
            raise BuildError(f"Not a take: {take!r}")
        lat = g.add(f"take{n}", "MiniMaxH3Take", f"Take {take}", cache_name=project_slug(project),
                    take=take, shot_id="")
        images = _maybe_vsr(g, n, s, g.add(f"clipdec{n}", "VAEDecode", "VAE Decode", samples=lat, vae=vae))
        audio = g.add(f"clipaud{n}", "VAEDecodeAudio", "VAE Decode Audio", samples=lat, vae=avae)
        clips[key] = _clip_save(g, n, project, images, audio, fmt, key)[0]
    if not clips:
        raise BuildError("No takes to make clips for.")
    return Build(prompt=g.nodes, width=0, height=0, chain=[], nodes={"clips": clips},
                 filename_prefix=clips_subfolder(project), video_format=fmt, warnings=warnings)


def build_clip_export(project: dict, items: list, env: Env | None = None) -> Build:
    """Export approved clips, upscaled: [{take, n}] -> one branch each. The take
    is decoded on its own, whole (MiniMax H3 Take -> VAE Decode), upscaled a
    frame at a time straight into a file (MiniMax H3 Upscale Chunk) and its sound
    saved as a WAV, into Approved_Clips/_work; the server then adds the sound.
    The project's ProRes master setting also makes a ProRes copy of each clip."""
    env = env or Env()
    s = project.get("settings") or {}
    need = ["MiniMaxH3Take", "VAELoader", "VAEDecode", "VAEDecodeAudio", "MiniMaxH3UpscaleChunk",
            "MiniMaxH3SaveAudio", "RTXVideoSuperResolution"]
    missing = [c for c in need if not env.has(c)]
    if missing:
        raise BuildError("ComfyUI is missing node(s) this needs:\n  " +
                         "\n  ".join(f"{c} — from {PACKS.get(c, 'ComfyUI core')}" for c in missing))
    for key in ("video_vae", "audio_vae"):
        if not s.get(key):
            raise BuildError(f"Settings: choose a {key.replace('_', ' ')} file.")
    vsr = s.get("rtx_vsr") or {}
    quality = vsr.get("quality", "ULTRA")
    if quality not in VSR_QUALITIES:
        raise BuildError(f"RTX Super Resolution quality must be one of {', '.join(VSR_QUALITIES)}.")
    scale = _num(vsr.get("scale", 2.0), "RTX upscale factor", 1, 4)
    warnings = []
    fmt = _video_format(env, warnings)
    work = f"{OUTPUT_SUBFOLDER}/{project_slug(project)}/Approved_Clips/_work"
    g = _Graph()
    vae = g.add("vae_video", "VAELoader", "Video VAE", vae_name=s["video_vae"])
    avae = g.add("vae_audio", "VAELoader", "Audio VAE", vae_name=s["audio_vae"])
    out = {}
    for n, it in enumerate(items or [], 1):
        take = str((it or {}).get("take") or "")
        if not TAKE_NAME_RE.fullmatch(take):
            raise BuildError(f"Not a take: {take!r}")
        lat = g.add(f"take{n}", "MiniMaxH3Take", f"Take {take}", cache_name=project_slug(project),
                    take=take, shot_id="")
        images = g.add(f"dec{n}", "VAEDecode", "VAE Decode", samples=lat, vae=vae)
        audio = g.add(f"aud{n}", "VAEDecodeAudio", "VAE Decode Audio", samples=lat, vae=avae)
        g.add(f"up{n}", "MiniMaxH3UpscaleChunk", f"Upscale clip {n}", images=images, start=0,
              length=10_000_000, scale=scale, quality=quality, filename_prefix=f"{work}/c{n:03d}",
              codec="h264_nvenc" if fmt == NVENC else "libx264",
              master_prefix=f"{work}/c{n:03d}_master" if s.get("prores_master") else "", frame_rate=float(FPS))
        g.add(f"wav{n}", "MiniMaxH3SaveAudio", f"Sound of clip {n}", audio=audio,
              filename_prefix=f"{work}/c{n:03d}_audio")
        out[str(n)] = {"video": f"up{n}", "audio": f"wav{n}"}
    if not out:
        raise BuildError("No approved Shots to export.")
    return Build(prompt=g.nodes, width=0, height=0, chain=[], nodes={"export": out},
                 filename_prefix=work, video_format=fmt, warnings=warnings)


def required_classes(project: dict, dry_run: bool = False, final: bool = False) -> list:
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
    if (s.get("turbo") or {}).get("on"):
        need.append("MiniMaxH3TurboLoRA")
    if any(l.get("on") and l.get("name") for l in s.get("loras") or []):
        need.append("LoraLoaderModelOnly")
    if final or (s.get("rtx_vsr") or {}).get("on"):
        need.append("RTXVideoSuperResolution")
    if any(sh.get("kind") == "clip" for sh in active_shots(project)):
        need += ["MiniMaxH3LoadVideo", "MiniMaxH3Clip", "MiniMaxH3ClipShot"]
        if final and s.get("clip_pixels"):
            need.append("MiniMaxH3ClipPixels")
    if a.get("lip_sync") or a.get("voice_ref") or a.get("final_override") or active_voices(project):
        need += ["LoadAudio", "TrimAudioDuration"]
    if a.get("lip_sync"):
        need.append("MiniMaxH3SongTrack")
    if a.get("voice_ref"):
        need += ["MelBandRoFormerModelLoader", "MelBandRoFormerSampler"]
    if active_refmods(project):
        need += ["MiniMaxH3RefModsLoader", "MiniMaxH3Subject"]
    return need


def build_prompt(project: dict, *, upto=None, dry_run: bool = False,
                 env: Env | None = None, final: bool = False, standalone: bool = False,
                 clips_for=None, chunk=None) -> Build:
    """Turn a Studio project into an API prompt rendering the chain of active
    Shots up to and including `upto` (all active Shots when None).

    final=True is "Upscale final video": RTX Super Resolution is always on
    (with the project's scale and quality) and the file is saved as
    <project>_final_#####.mp4 (plus a ProRes master .mov when the project asks
    for one). The Long Shot part is identical, so every segment is reused.

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
    clip_ids = [str(x) for x in (clips_for or [])] if not dry_run and not upscale_final else []
    need_classes = required_classes(project, dry_run, upscale_final)
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
        chunk_up = upscale_final or bool((s.get("rtx_vsr") or {}).get("on"))
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
    elif steps < 20:
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
    voice_of = audio_labels(project)
    n_audio = len(voice_of) + (1 if (project.get("audio") or {}).get("voice_ref") else 0)
    if n_audio > MAX_AUDIO_REFS:
        raise BuildError(f"Long Shot takes at most {MAX_AUDIO_REFS} reference audios; {n_audio} are on "
                         "(voice references, plus the song's voice when Voice reference is on). Bypass some.")
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
            role = {"audio": "voice timbre", "video": "motion"}.get(m.get("kind"), "appearance")
            inputs = dict(label=m.get("label") or label, description=m.get("desc", ""), role=role,
                          reference=label, role_2="-", reference_2="")
            if subjects is not None:
                inputs["subjects"] = subjects
            subjects = g.add(f"subject_m{m.get('id') or label}"[:60].replace(" ", ""), "MiniMaxH3Subject",
                             f"{label} subject (RefMod)", **inputs)

    # --- prompt ---------------------------------------------------------------
    # Timeline Shots (Long Shot 1.4): each carries its id, its locked take
    # (approved and reviewed Shots load their take instead of sampling), the
    # window length to keep when re-rendered in place, and its join.
    shots = None
    for n, shot in enumerate(chain, 1):
        if shot.get("kind") == "clip":
            shots = _clip_nodes(g, n, shot, shots, vae, avae, width, height)
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
                # "open on this frame and carry on from it"
                lead = (f"<Picture {pic}> is a reference for the characters, objects and surroundings only. "
                        f"The shot does not begin from <Picture {pic}> and does not continue it: it opens "
                        "on a new camera angle and composition. ") + lead
                if not env.shot_takes("retention"):
                    msg = ("H3 Long Shot 1.6.9 or later marks a Context picture as weak_reference in the "
                           "retention section. Update it for Context Shots that don't open on that frame.")
                    if msg not in warnings:
                        warnings.append(msg)
                else:
                    own_retention = (f"<Picture {pic}> (reference for [Shot 1]): weak_reference - characters, "
                                     "objects and surroundings only; not a frame anchor, new framing and "
                                     "camera angle.")
            text = (lead + text + tail).strip()
        inputs = dict(shot_id=str(shot.get("id") or f"shot{n}"), seconds=seconds,
                      text=text,
                      shot_seed=_seed(shot.get("shot_seed", -1), f"Shot {n} seed"),
                      lock=lock, join=join, frames=frames, **anchor_inputs)
        if own_retention:
            inputs["retention"] = own_retention       # Long Shot 1.6.9: this Shot's own lines
        if shots is not None:
            inputs["shots"] = shots
        shots = g.add(f"shot{n}", "MiniMaxH3TimelineShot", f"[Shot {n}]", **inputs)

    types = [t for t in (style.get("task_types") or ["reference generation"]) if t][:3]
    types += ["-"] * (3 - len(types))
    builder_inputs = dict(
        subject_definitions="", task_type=types[0] if types[0] != "-" else "reference generation",
        task_type_2=types[1], task_type_3=types[2],
        summary=style.get("summary", ""),
        retention_analysis="\n".join(x for x in [(style.get("retention") or "").strip(), *voice_retention(project)] if x),
        style_line=style.get("style_line", ""), detailed_description="",
        overall_soundscape=style.get("soundscape", ""),
        non_diegetic_music=style.get("music", ""), shots=shots)
    if subjects is not None:
        builder_inputs["subjects"] = subjects
    builder = g.add("builder", "MiniMaxH3RefPromptBuilder", "MiniMax H3 Ref Prompt Builder r2v",
                    **builder_inputs)

    # --- audio ----------------------------------------------------------------
    lip, voice, final = (bool(audio.get("lip_sync")), bool(audio.get("voice_ref")),
                         bool(audio.get("final_override")))
    loader = None
    long_extra = {}
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
        if lip:
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
    base = 1 if voice else 0
    for k, v in enumerate(active_voices(project)):
        a_label = f"<Audio {base + k + 1}>"
        try:
            value = pj.input_path_value(v["file"], v.get("subfolder", ""))
        except ValueError as err:
            raise BuildError(f"{v.get('label') or a_label}: {err}") from None
        vraw = g.add(f"voicefile{k + 1}", "LoadAudio", f"{a_label} {v.get('label', '')}".strip(), audio=value)
        vlen = _num(v.get("length", 0) or 0, f"{a_label} length", 0, 1e7)
        long_extra[f"ref_audios.ref_audio_{base + k}"] = g.add(
            f"voice{k + 1}", "TrimAudioDuration", f"Trim {a_label}", audio=vraw,
            start_index=_num(v.get("start", 0) or 0, f"{a_label} start", 0, 1e7),
            duration=vlen if vlen > 0 else 1e7)

    # --- Long Shot ---------------------------------------------------------------
    long_shot = g.add("longshot", "MiniMaxH3LongShot", "MiniMax H3 Long Shot",
                      model=model, clip=clip, vae=vae, noise=noise, sampler=sampler,
                      sigmas=sigmas, prompt=_out(builder, 3), width=width, height=height,
                      overlap_frames=overlap, seed_mode=seed_mode, dry_run=bool(dry_run),
                      reuse_segments=True, ref_image_size=ref_size,
                      save_to_disk=True,          # takes are what locked Shots load
                      cache_name=project_slug(project), audio_vae=avae,
                      **long_extra, **refs, **refmod_input)

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
    vsr = s.get("rtx_vsr") or {}
    upscales = bool(vsr.get("on") or upscale_final)
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
        ("_final" if upscale_final else "")
    out_audio = loader if final else decoded_audio
    if chunk is not None:
        # A chunk: frames start .. start+length-1, upscaled a few at a time and
        # piped straight into the encoder (no sound; joined later). Nothing big is
        # left in ComfyUI's cache, so chunks don't pile up in RAM. The sound goes
        # to a WAV once, with the first chunk.
        if not upscales:
            vsr_scale, vsr_quality = 1.0, "ULTRA"     # Long Shot 1.6.10: encode only
        name = safe_name(project.get("name"))
        cprefix = f"{videos_subfolder(project)}/_chunks/{name}" + ("_final" if upscale_final else "") + \
            f"_c{chunk['index']:03d}"
        master = upscale_final and bool(s.get("prores_master"))
        g.add("upscale_chunk", "MiniMaxH3UpscaleChunk", "Upscale chunk → file", images=images,
              start=chunk["start"], length=chunk["length"], scale=vsr_scale, quality=vsr_quality,
              filename_prefix=cprefix, codec="h264_nvenc" if fmt == NVENC else "libx264",
              master_prefix=cprefix + "_master" if master else "", frame_rate=float(FPS))
        ids.update(chunk="upscale_chunk", combine="combine")
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
