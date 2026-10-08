"""Project JSON -> ComfyUI API prompt for H3 Long Shot Studio.

Pure Python: no torch, no ComfyUI imports, so every rule is unit-testable
without a GPU. What ComfyUI has installed (node classes, VHS video formats)
comes in through `Env`, which the server fills from the live registry.

The graph is built from scratch every time, mirroring the reference
H3 Ref2V Long Shot workflow:

    UNETLoader -> [Sage] -> SigmaShift -> [Turbo LoRA] -> [LoRA x3] -> BasicScheduler
    LoadImage -> ImageResizeKJv2 -> Long Shot ref_images.ref_image_k
    Subject chain + Shot chain -> Ref Prompt Builder r2v -> long_shot -> Long Shot
    Long Shot -> VAEDecode + VAEDecodeAudio -> VHS_VideoCombine
    [VHS_LoadAudioUpload -> Song Track / MelBand vocals / Video Combine audio]
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field

from . import projects as pj

FPS = 24
CUT_VERB = "the camera cuts to"
MAX_REFERENCES = 9          # Long Shot's ref_images autogrow limit
MAX_SHOTS = 16              # Long Shot's planner limit
MAX_SEED = 0xFFFFFFFFFFFFFFFF
OUTPUT_SUBFOLDER = "longshot"
NVENC = "video/nvenc_h264-mp4"
H264 = "video/h264-mp4"

# Same table and maths as ComfyUI's ResolutionSelector (1 MP = 1024 x 1024 px,
# rounded to multiples of 32), so sizes match MiniMax's published size table.
ASPECTS = {
    "16:9": (16, 9), "9:16": (9, 16), "1:1": (1, 1), "4:3": (4, 3), "3:4": (3, 4),
    "3:2": (3, 2), "2:3": (2, 3), "21:9": (21, 9),
}
MEGAPIXELS = [0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.98, 1.0, 1.2, 1.5, 1.8, 2.0]

# Which pack provides each node class, for "missing node" errors.
PACKS = {
    "MiniMaxH3Shot": "H3 Prompt Compiler (github.com/r34vtraining/H3_Prompt_Compiler)",
    "MiniMaxH3Subject": "H3 Prompt Compiler (github.com/r34vtraining/H3_Prompt_Compiler)",
    "MiniMaxH3RefPromptBuilder": "H3 Prompt Compiler (github.com/r34vtraining/H3_Prompt_Compiler)",
    "MiniMaxH3LongShot": "H3 Long Shot 1.3.0+ (github.com/r34vtraining/H3_Longshot)",
    "MiniMaxH3SongTrack": "H3 Long Shot 1.3.0+ (github.com/r34vtraining/H3_Longshot)",
    "MiniMaxH3SigmaShift": "ComfyUI core (update ComfyUI)",
    "MiniMaxH3TurboLoRA": "ComfyUI-MiniMax-H3-Turbo",
    "PathchSageAttentionKJ": "ComfyUI-KJNodes",
    "ImageResizeKJv2": "ComfyUI-KJNodes",
    "VHS_VideoCombine": "ComfyUI-VideoHelperSuite",
    "VHS_LoadAudioUpload": "ComfyUI-VideoHelperSuite",
    "MelBandRoFormerModelLoader": "ComfyUI-MelBandRoFormer",
    "MelBandRoFormerSampler": "ComfyUI-MelBandRoFormer",
    "RTXVideoSuperResolution": "ComfyUI-NVIDIA-RTX-VSR-Pro (RTX Video Super Resolution)",
}
VSR_QUALITIES = ["LOW", "MEDIUM", "HIGH", "ULTRA"]


class BuildError(ValueError):
    """The project can't be turned into a graph; the message is user-facing."""


@dataclass
class Env:
    """What the running ComfyUI has. None means 'unknown, assume yes'."""
    classes: set | None = None
    video_formats: list | None = None

    def has(self, cls: str) -> bool:
        return self.classes is None or cls in self.classes


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


def active_cast(project: dict) -> list:
    return [c for c in project.get("cast") or [] if not c.get("bypassed")]


def picture_label(k: int) -> str:
    """<Picture N> for the k-th (0-based) non-bypassed cast entry. Never stored."""
    return f"<Picture {k + 1}>"


def active_shots(project: dict) -> list:
    return [s for s in project.get("shots") or [] if not s.get("bypassed")]


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


def required_classes(project: dict, dry_run: bool = False, final: bool = False) -> list:
    """Node classes the build will use, given the project's toggles."""
    s = project.get("settings") or {}
    a = project.get("audio") or {}
    need = ["UNETLoader", "MiniMaxH3SigmaShift", "CLIPLoader", "VAELoader", "BasicScheduler",
            "KSamplerSelect", "RandomNoise", "MiniMaxH3Shot", "MiniMaxH3RefPromptBuilder",
            "MiniMaxH3LongShot", "VAEDecode", "VHS_VideoCombine"]
    if not a.get("final_override"):
        need.append("VAEDecodeAudio")
    if active_cast(project):
        need += ["LoadImage", "ImageResizeKJv2", "MiniMaxH3Subject"]
    if (s.get("turbo") or {}).get("on"):
        need.append("MiniMaxH3TurboLoRA")
    if any(l.get("on") and l.get("name") for l in s.get("loras") or []):
        need.append("LoraLoaderModelOnly")
    if final or (s.get("rtx_vsr") or {}).get("on"):
        need.append("RTXVideoSuperResolution")
    if a.get("lip_sync") or a.get("voice_ref") or a.get("final_override"):
        need.append("VHS_LoadAudioUpload")
    if a.get("lip_sync"):
        need.append("MiniMaxH3SongTrack")
    if a.get("voice_ref"):
        need += ["MelBandRoFormerModelLoader", "MelBandRoFormerSampler"]
    return need


def build_prompt(project: dict, *, upto=None, dry_run: bool = False,
                 env: Env | None = None, final: bool = False) -> Build:
    """Turn a Studio project into an API prompt rendering the chain of active
    Shots up to and including `upto` (all active Shots when None).

    final=True is "Upscale final video": RTX Super Resolution is always on
    (with the project's scale and quality) and the file is saved as
    <project>_final_#####.mp4. The Long Shot part is identical, so every
    segment is reused."""
    env = env or Env()
    if not isinstance(project, dict):
        raise BuildError("The project must be a JSON object.")
    s = project.get("settings") or {}
    style = project.get("style") or {}
    audio = project.get("audio") or {}
    warnings = []

    upscale_final = bool(final)      # (`final` is reused below for the song route)
    missing = [c for c in dict.fromkeys(required_classes(project, dry_run, upscale_final)) if not env.has(c)]
    if missing:
        rows = [f"{c} — from {PACKS.get(c, 'ComfyUI core')}" for c in missing]
        raise BuildError("ComfyUI is missing node(s) this project needs:\n  " + "\n  ".join(rows))

    chain = chain_upto(project, upto)
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
        if env.has("PathchSageAttentionKJ"):
            model = g.add("sage", "PathchSageAttentionKJ", "Patch Sage Attention KJ",
                          model=model, sage_attention=sage, allow_compile=False)
        else:
            warnings.append("KJNodes' Patch Sage Attention isn't installed; rendering "
                            "without SageAttention (slower).")
    model = g.add("shift", "MiniMaxH3SigmaShift", "ModelSamplingMiniMaxH3", model=model,
                  shift_video=_num(s.get("shift_video", 12), "Video shift", 0.01, 100),
                  shift_audio=_num(s.get("shift_audio", 3), "Audio shift", 0.01, 100))
    turbo = s.get("turbo") or {}
    if turbo.get("on"):
        if not turbo.get("lora"):
            raise BuildError("Turbo is on but no Turbo LoRA file is chosen.")
        # low_vram: newer Turbo builds require it; older ones ignore extra inputs.
        model = g.add("turbo", "MiniMaxH3TurboLoRA", "MiniMax-H3 Turbo LoRA", model=model,
                      lora_name=turbo["lora"],
                      strength=_num(turbo.get("strength", 1.0), "Turbo strength", -10, 10),
                      low_vram=bool(turbo.get("low_vram", False)))
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
                   scheduler=s.get("scheduler", "beta57"), steps=steps, denoise=1.0)
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
        refs[f"ref_images.ref_image_{k}"] = g.add(
            f"resize{k + 1}", "ImageResizeKJv2", f"Resize {pic}", image=img,
            width=resize_px, height=resize_px, upscale_method="nearest-exact",
            keep_proportion="resize", pad_color="0, 0, 0", crop_position="center",
            divisible_by=2, device="cpu")
        inputs = dict(label=c.get("label") or pic, description=c.get("desc", ""),
                      role=c.get("role") or "appearance", reference=pic,
                      role_2="-", reference_2="")
        if subjects is not None:
            inputs["subjects"] = subjects
        subjects = g.add(f"subject{k + 1}", "MiniMaxH3Subject", f"{pic} subject", **inputs)

    # --- prompt ---------------------------------------------------------------
    shots = None
    for n, shot in enumerate(chain, 1):
        seconds = _num(shot.get("seconds", 5), f"Shot {n} seconds", 0.1, 600)
        inputs = dict(cut_verb=CUT_VERB, seconds=seconds, text=shot.get("text", ""),
                      shot_seed=_seed(shot.get("shot_seed", -1), f"Shot {n} seed"))
        if shots is not None:
            inputs["shots"] = shots
        shots = g.add(f"shot{n}", "MiniMaxH3Shot", f"[Shot {n}]", **inputs)

    types = [t for t in (style.get("task_types") or ["reference generation"]) if t][:3]
    types += ["-"] * (3 - len(types))
    builder_inputs = dict(
        subject_definitions="", task_type=types[0] if types[0] != "-" else "reference generation",
        task_type_2=types[1], task_type_3=types[2],
        summary=style.get("summary", ""), retention_analysis=style.get("retention", ""),
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
        loader = g.add("audio", "VHS_LoadAudioUpload", "Load Audio (trimmed)",
                       audio=audio_value,
                       start_time=_num(audio.get("start", 0), "Audio start", 0, 1e7),
                       duration=_num(audio.get("length", 0), "Audio length", 0, 1e7))
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

    # --- Long Shot ---------------------------------------------------------------
    long_shot = g.add("longshot", "MiniMaxH3LongShot", "MiniMax H3 Long Shot",
                      model=model, clip=clip, vae=vae, noise=noise, sampler=sampler,
                      sigmas=sigmas, prompt=_out(builder, 3), width=width, height=height,
                      overlap_frames=overlap, seed_mode=seed_mode, dry_run=bool(dry_run),
                      reuse_segments=True, ref_image_size=ref_size,
                      save_to_disk=bool(s.get("save_segments", True)),
                      cache_name=project_slug(project), audio_vae=avae,
                      **long_extra, **refs)

    # --- output -----------------------------------------------------------------
    images = g.add("decode", "VAEDecode", "VAE Decode", samples=long_shot, vae=vae)
    vsr = s.get("rtx_vsr") or {}
    if vsr.get("on") or upscale_final:
        # NVIDIA RTX Video Super Resolution on the decoded frames, before saving.
        # Runs after Long Shot, so it never changes which segments are reused.
        quality = vsr.get("quality", "ULTRA")
        if quality not in VSR_QUALITIES:
            raise BuildError(f"RTX Super Resolution quality must be one of {', '.join(VSR_QUALITIES)}.")
        images = g.add("vsr", "RTXVideoSuperResolution", "RTX Video Super Resolution",
                       images=images, resize_type="scale by multiplier",
                       **{"resize_type.scale": _num(vsr.get("scale", 2.0), "RTX upscale factor", 1, 4)},
                       quality=quality)
    # Song in final video: the loader's (trimmed) audio replaces H3's decoded
    # audio, so the decoder isn't built at all.
    decoded_audio = None if final else g.add("decode_audio", "VAEDecodeAudio",
                                             "VAE Decode Audio", samples=long_shot, vae=avae)
    fmt = NVENC
    if env.video_formats is not None and NVENC not in env.video_formats:
        if H264 not in env.video_formats:
            raise BuildError("Video Helper Suite offers neither nvenc nor h264 mp4 output.")
        fmt = H264
        warnings.append("NVENC isn't available; saving with the software h264 encoder.")
    prefix = f"{OUTPUT_SUBFOLDER}/{safe_name(project.get('name'))}" + ("_final" if upscale_final else "")
    # nvenc takes a bitrate; the software h264 format takes a quality (crf) instead.
    quality = dict(bitrate=8, megabit=True) if fmt == NVENC else dict(crf=19)
    combine = g.add("combine", "VHS_VideoCombine", "Video Combine",
                    frame_rate=FPS, loop_count=0, filename_prefix=prefix, format=fmt,
                    pix_fmt="yuv420p", **quality, save_metadata=True,
                    pingpong=False, save_output=True, images=images,
                    audio=loader if final else decoded_audio)

    ids.update(longshot="longshot", combine="combine", builder="builder")
    return Build(prompt=g.nodes, width=width, height=height,
                 chain=[x.get("id") for x in chain], nodes=ids, filename_prefix=prefix,
                 video_format=fmt, warnings=warnings)
