"""Built prompts against a real ComfyUI (CPU mode, no model weights).

1. ComfyUI's own validate_prompt accepts every graph the builder makes, with
   the real node packs loaded (Prompt Compiler, Long Shot, KJNodes, VHS,
   H3 Turbo, MelBand). Model names only have to exist, so empty files stand in.
2. The core loop runs through ComfyUI's real PromptExecutor: Start, Continue,
   Reroll, edit, dry run. Loaders, decoders and the sampler are stubbed (the
   32B model can't run here); everything else is real — Shot, Subject, Ref
   Prompt Builder, Long Shot with its segment memory, LoadImage, KJ resize,
   VHS audio loader and VHS Video Combine writing a real mp4 with ffmpeg.

Set COMFYUI_ROOT and the pack folders (see comfy_env.py). Tests that need a
pack that isn't configured are skipped with the reason.
"""
import asyncio
import hashlib
import shutil
import importlib
import json
import os
import subprocess
import sys

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
PKG_DIR = os.path.dirname(HERE)
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.dirname(PKG_DIR))

import comfy_env  # noqa: E402

CLASSES = comfy_env.load_packs()

import torch  # noqa: E402
import folder_paths  # noqa: E402
import comfy.samplers  # noqa: E402
import execution  # noqa: E402
import nodes as comfy_nodes  # noqa: E402
from comfy.nested_tensor import NestedTensor  # noqa: E402

PKG = os.path.basename(PKG_DIR)
gb = importlib.import_module(PKG + ".graph_builder")
srv = importlib.import_module(PKG + ".studio_server")

SAMPLE = os.path.join(HERE, "fixtures", "sample_project.json")
FULL_SET = (set(gb.PACKS) - {"RTXVideoSuperResolution"}) | {"UNETLoader", "LoraLoaderModelOnly", "LoadImage"}  # RTX VSR needs an NVIDIA GPU


def need(*classes):
    missing = [c for c in classes if c not in CLASSES]
    return pytest.mark.skipif(bool(missing), reason=f"pack not loaded for {missing} "
                              "(set MMH3_PROMPT_PACK / MMH3_LONGSHOT_PACK / STUDIO_EXTRA_NODES)")


ALL_PACKS = need(*sorted(FULL_SET))
CORE_PACKS = need("MiniMaxH3Shot", "MiniMaxH3RefPromptBuilder", "MiniMaxH3LongShot",
                  "ImageResizeKJv2", "VHS_VideoCombine", "VHS_LoadAudioUpload")


# ---------------------------------------------------------------------------
# A ComfyUI install in a temp folder: models, input images, a real song
# ---------------------------------------------------------------------------

MODEL_FILES = {
    "diffusion_models": ["H3/minimax_h3_fl2va_pruned_bf16.safetensors",
                         "Infinite Talk/MelBandRoformer_fp16.safetensors"],
    "text_encoders": ["H3/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors"],
    "vae": ["H3/minimax_h3_video_vae_fp16.safetensors",
            "H3/minimax_h3_audio_vae_fp32.safetensors"],
    "loras": ["H3/Speed/minimax_h3_ref2v_turbo_8step_v1.0_768p_comfyui_bf16.safetensors",
              "style_a.safetensors", "style_b.safetensors", "style_c.safetensors"],
}
SONG = "song.mp3"


def listed(kind, rel):
    """The name ComfyUI lists for a model file (separators differ by OS)."""
    want = rel.replace("/", os.sep)
    for name in folder_paths.get_filename_list(kind):
        if name.replace("/", os.sep).replace("\\", os.sep) == want:
            return name
    raise AssertionError(f"{rel} not listed under {kind}")


@pytest.fixture(scope="module")
def install(tmp_path_factory):
    root = tmp_path_factory.mktemp("comfy")
    for kind, files in MODEL_FILES.items():
        base = root / "models" / kind
        for f in files:
            p = base / f
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(b"\0")
        folder_paths.add_model_folder_path(kind, str(base), is_default=True)
    inp, out, user, temp = root / "input", root / "output", root / "user", root / "temp"
    for d in (inp, out, user, temp):
        d.mkdir()
    folder_paths.set_temp_directory(str(temp))    # main.py makes this; VHS writes metadata there
    folder_paths.set_input_directory(str(inp))
    folder_paths.set_output_directory(str(out))
    folder_paths.set_user_directory(str(user))

    from PIL import Image
    project = json.load(open(SAMPLE, encoding="utf-8"))
    for k, c in enumerate(project["cast"]):
        Image.new("RGB", (96 + 8 * k, 64), (40 * k % 255, 90, 160)).save(inp / c["image"])
    srv.project_store().create(project["name"], project)     # what a user would have saved
    ffmpeg = srv._ffmpeg_path()
    subprocess.run([ffmpeg, "-y", "-loglevel", "error", "-f", "lavfi", "-i",
                    "sine=frequency=440:duration=40", "-ac", "2", str(inp / SONG)], check=True)

    # RES4LYF adds beta57 to ComfyUI's scheduler list; do the same here.
    for names in {id(comfy.samplers.SCHEDULER_NAMES): comfy.samplers.SCHEDULER_NAMES,
                  id(comfy.samplers.KSampler.SCHEDULERS): comfy.samplers.KSampler.SCHEDULERS
                  }.values():
        if "beta57" not in names:
            names.append("beta57")
    return root


def project(**settings):
    """The sample project, with model names as this OS lists them."""
    p = json.load(open(SAMPLE, encoding="utf-8"))
    s = p["settings"]
    s["model"] = listed("diffusion_models", "H3/minimax_h3_fl2va_pruned_bf16.safetensors")
    s["clip"] = listed("text_encoders", "H3/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors")
    s["video_vae"] = listed("vae", "H3/minimax_h3_video_vae_fp16.safetensors")
    s["audio_vae"] = listed("vae", "H3/minimax_h3_audio_vae_fp32.safetensors")
    s["turbo"]["lora"] = listed(
        "loras", "H3/Speed/minimax_h3_ref2v_turbo_8step_v1.0_768p_comfyui_bf16.safetensors")
    p["audio"]["melband_model"] = listed("diffusion_models",
                                         "Infinite Talk/MelBandRoformer_fp16.safetensors")
    s.update(settings)
    return p


def validate(prompt):
    return asyncio.run(execution.validate_prompt("studio-test", prompt, None))


# ---------------------------------------------------------------------------
# 1. ComfyUI's validator accepts every combination
# ---------------------------------------------------------------------------

def _variant(name):
    p = project()
    a = p["audio"]
    if name == "turbo off + 3 LoRAs":
        p["settings"]["turbo"]["on"] = False
        p["settings"]["steps"] = 20
        p["settings"]["loras"] = [{"on": True, "name": listed("loras", f"style_{x}.safetensors"),
                                   "strength": 0.8} for x in "abc"]
    elif name == "turbo + LoRA 2 only":
        p["settings"]["loras"][1] = {"on": True, "name": listed("loras", "style_b.safetensors"),
                                     "strength": 1.2}
    elif name.startswith("audio"):
        a["lip_sync"], a["voice_ref"], a["final_override"] = (c == "1" for c in name[-3:])
    elif name == "bypassed cast + shots":
        p["cast"][0]["bypassed"] = p["cast"][4]["bypassed"] = True
        p["shots"][2]["bypassed"] = True
    elif name == "no references":
        p["cast"] = []
    elif name == "max refs, other settings":
        p["settings"].update(ref_image_size="max", seed_mode="same", overlap=39,
                             sampler="euler", scheduler="simple", aspect="9:16", megapixels=0.4)
    elif name == "sage disabled":
        p["settings"]["sage_attention"] = "disabled"
    return p


VARIANTS = ["sample as saved", "turbo off + 3 LoRAs", "turbo + LoRA 2 only", "bypassed cast + shots",
            "no references", "max refs, other settings", "sage disabled"] + \
    [f"audio {a}{b}{c}" for a in "01" for b in "01" for c in "01"]


@ALL_PACKS
@pytest.mark.parametrize("variant", VARIANTS)
@pytest.mark.parametrize("dry_run", [False, True])
def test_comfyui_validates_every_variant(install, variant, dry_run):
    p = _variant(variant)
    built = gb.build_prompt(p, dry_run=dry_run, env=srv.current_env())
    ok, err, outputs, node_errors = validate(built.prompt)
    assert ok, json.dumps({"error": err, "node_errors": node_errors}, indent=1)[:3000]
    assert outputs == ["combine"]


@ALL_PACKS
@pytest.mark.parametrize("upto", ["s1", "s2", "s3", "s6"])
def test_comfyui_validates_each_step_of_the_chain(install, upto):
    ok, err, _, node_errors = validate(gb.build_prompt(project(), upto=upto,
                                                       env=srv.current_env()).prompt)
    assert ok, (err, node_errors)


@ALL_PACKS
def test_live_env_reports_the_installed_nodes(install):
    env = srv.current_env()
    for c in FULL_SET:
        assert env.has(c), c
    # this machine's ffmpeg has no NVENC, so the live env drops it
    if not srv.nvenc_available():
        assert gb.NVENC not in env.video_formats and gb.H264 in env.video_formats


@ALL_PACKS
def test_validator_catches_a_wrong_model_name(install):
    """Sanity check that validation is real: a missing file is rejected."""
    p = project(model="not_there.safetensors")
    ok, _, _, node_errors = validate(gb.build_prompt(p, env=srv.current_env()).prompt)
    assert not ok and "unet" in node_errors


# ---------------------------------------------------------------------------
# 2. The core loop through ComfyUI's real executor
# ---------------------------------------------------------------------------

class FakeModel:
    pass


class MockClip:
    def __init__(self):
        self.prompts = []

    def tokenize(self, prompt, images=None, minimax_ref_items=None):
        self.prompts.append(prompt)
        return {}

    def encode_from_tokens_scheduled(self, tokens):
        return [[torch.zeros(1, 7, 16), {}]]


class MockVae:
    def encode(self, pixels):
        return torch.zeros(1, 24, 1, pixels.shape[1] // 16, pixels.shape[2] // 16)


class MockAudioVae:
    audio_sample_rate = 32000

    def encode(self, wave):
        t = wave.shape[1] * 40 // self.audio_sample_rate
        return torch.zeros(1, 32, 2, t)


def _stub(name, returns, fn, inputs):
    """A node class taking `inputs` and returning fn(**kwargs)."""
    return type(name, (), {
        "INPUT_TYPES": classmethod(lambda cls: {"required": {},
                                                "optional": {n: ("*",) for n in inputs}}),
        "RETURN_TYPES": returns, "FUNCTION": "go", "CATEGORY": "test",
        "go": lambda self, **kw: fn(**kw)})


RAN = []


def _decode(samples=None, vae=None):
    RAN.append("decode")
    tokens = samples["samples"].tensors[0].shape[2]
    frames = (tokens - 2) // 5 * 17 + 5
    return (torch.rand(frames, 64, 112, 3),)


def _decode_audio(samples=None, vae=None):
    RAN.append("decode_audio")
    n = samples["samples"].tensors[1].shape[-1]
    return ({"waveform": torch.zeros(1, 2, n * 1200), "sample_rate": 48000},)


STUBS = {
    "UNETLoader": _stub("S1", ("MODEL",), lambda **k: (RAN.append("unet") or FakeModel(),),
                        ["unet_name", "weight_dtype"]),
    "PathchSageAttentionKJ": _stub("S2", ("MODEL",), lambda model, **k: (model,),
                                   ["model", "sage_attention", "allow_compile"]),
    "MiniMaxH3SigmaShift": _stub("S3", ("MODEL",), lambda model, **k: (model,),
                                 ["model", "shift_video", "shift_audio"]),
    "MiniMaxH3TurboLoRA": _stub("S4", ("MODEL",), lambda model, **k: (model,),
                                ["model", "lora_name", "strength", "low_vram"]),
    "LoraLoaderModelOnly": _stub("S5", ("MODEL",), lambda model, **k: (model,),
                                 ["model", "lora_name", "strength_model"]),
    "CLIPLoader": _stub("S6", ("CLIP",), lambda **k: (MockClip(),), ["clip_name", "type", "device"]),
    "VAELoader": _stub("S7", ("VAE",), lambda vae_name, **k: (
        MockAudioVae() if "audio" in vae_name else MockVae(),), ["vae_name"]),
    "BasicScheduler": _stub("S8", ("SIGMAS",), lambda **k: (torch.linspace(1, 0, k["steps"] + 1),),
                            ["model", "scheduler", "steps", "denoise"]),
    "VAEDecode": _stub("S9", ("IMAGE",), _decode, ["samples", "vae"]),
    "VAEDecodeAudio": _stub("S10", ("AUDIO",), _decode_audio, ["samples", "vae"]),
    "MelBandRoFormerModelLoader": _stub("S11", ("MELROFORMERMODEL",), lambda **k: ("mel",),
                                        ["model_name"]),
    "MelBandRoFormerSampler": _stub("S12", ("AUDIO", "AUDIO"), lambda model, audio: (audio, audio),
                                    ["model", "audio"]),
}


class Sampler:
    """Deterministic stand-in for one H3 generation: the window's content is a
    hash of seed + prompt + the tail guide, like a sampler with fixed settings."""

    def __init__(self):
        self.calls = []

    def __call__(self, model, noise, sampler, sigmas, positive, latent):
        meta = positive[0][1]
        tail = [k["latent"] for k in meta.get("minimax_keyframes", []) if k.get("latent") is not None]
        self.calls.append(noise.seed)
        h = hashlib.sha256(f"{noise.seed}|{len(self.calls)}".encode())
        g = torch.Generator().manual_seed(int.from_bytes(h.digest()[:8], "little"))
        tv, ta = latent["samples"].tensors
        v, a = torch.randn(tv.shape, generator=g), torch.randn(ta.shape, generator=g)
        if tail:
            v[:, :, :tail[0].shape[2]] = tail[0]
        return {"samples": NestedTensor((v, a))}


class FakeServer:
    client_id = "studio"
    last_node_id = None

    def __init__(self):
        self.events = []

    def send_sync(self, event, data, sid=None):
        self.events.append((event, data))


def _long_shot_module():
    for name, mod in sys.modules.items():
        if name.endswith(".nodes") and hasattr(mod, "_sample_window") and hasattr(mod, "plan_rows"):
            return mod
    pytest.skip("the updated Long Shot pack (with front-end hooks) isn't loaded")


@pytest.fixture
def loop(install, monkeypatch, tmp_path):
    for name, cls in STUBS.items():
        monkeypatch.setitem(comfy_nodes.NODE_CLASS_MAPPINGS, name, cls)
    ls = _long_shot_module()
    ls.clear_segment_cache()
    if hasattr(ls, "STORE_ROOT"):
        monkeypatch.setattr(ls, "STORE_ROOT", str(tmp_path / "segments-root"))
    sampler = Sampler()
    monkeypatch.setattr(ls, "_sample_window", sampler)
    server = FakeServer()
    import server as comfy_server
    monkeypatch.setattr(comfy_server.PromptServer, "instance", server, raising=False)
    def new_executor():
        return execution.PromptExecutor(server, cache_args={"lru": 0, "ram": 0, "ram_inactive": 0})

    state = {"ex": new_executor()}
    RAN.clear()

    def run(p, upto, dry_run=False, restart=False, final=False):
        """restart=True: ComfyUI restarted — Long Shot's memory and ComfyUI's
        caches are gone; only files on disk remain."""
        if restart:
            ls.clear_segment_cache()
            state["ex"] = new_executor()
        ex = state["ex"]
        built = gb.build_prompt(p, upto=upto, dry_run=dry_run, env=srv.current_env(), final=final)
        server.events.clear()
        calls = len(sampler.calls)
        ex.execute(built.prompt, f"p{len(server.events)}-{upto}", {"client_id": "studio"},
                   ["combine"])
        assert ex.success, [(m[1].get("exception_message"), "".join(m[1].get("traceback", []))) for m in ex.status_messages if m[0] == "execution_error"]
        outputs = ex.history_result["outputs"]
        progress = [(d["segment"], d["status"]) for e, d in server.events
                    if e == ls.PROGRESS_EVENT]
        run.sources = [d.get("source") for e, d in server.events if e == ls.PROGRESS_EVENT]
        return outputs, progress, len(sampler.calls) - calls

    yield run
    ls.clear_segment_cache()


def small(**kw):
    """The sample project at a size a CPU can stitch quickly."""
    p = project(megapixels=0.2, ref_resize_px=64, **kw)
    return p


@CORE_PACKS
def test_core_loop_start_continue_reroll_edit(loop):
    p = small()

    # Dry run: plan comes back through /history, nothing is decoded or saved
    out, progress, sampled = loop(p, "s2", dry_run=True)
    assert sampled == 0 and progress == [] and RAN == []
    assert "combine" not in out
    rows = out["longshot"]["plan_json"]
    assert [(r["index"], r["status"], r["reason"]) for r in rows] == \
        [(1, "render", "first run"), (2, "render", "first run")]
    assert out["longshot"]["text"][0].startswith("Reference labels")

    # Start: Shot 1 only
    out, progress, sampled = loop(p, "s1")
    assert sampled == 1 and progress == [(1, "rendering"), (1, "done")]
    video = out["combine"]["gifs"][0]
    assert video["subfolder"] == "longshot" and video["type"] == "output"
    assert video["filename"].startswith("Sample project_")
    assert os.path.isfile(os.path.join(folder_paths.get_output_directory(), "longshot",
                                       video["filename"]))
    # nvenc when this machine's ffmpeg can actually use it, software h264 otherwise
    assert video["format"] == (gb.NVENC if srv.nvenc_available() else gb.H264)
    assert out["longshot"]["plan_json"][0]["seed"] == 1722

    # Continue: Shot 1 comes from memory, only Shot 2 renders
    out, progress, sampled = loop(p, "s2")
    assert sampled == 1
    assert progress == [(1, "reused"), (2, "rendering"), (2, "done")]
    rows = out["longshot"]["plan_json"]
    assert [r["status"] for r in rows] == ["reused", "render"]
    assert [r["seed"] for r in rows] == [1722, 1723]

    # Continue again: Shot 3 carries its saved shot_seed 0
    out, progress, sampled = loop(p, "s3")
    assert progress == [(1, "reused"), (2, "reused"), (3, "rendering"), (3, "done")]
    assert out["longshot"]["plan_json"][2]["seed"] == 0
    assert out["longshot"]["plan_json"][2]["own_seed"] is True

    # Reroll Shot 3: new seed, 1-2 reused
    p["shots"][2]["shot_seed"] = 3_141_592_653
    out, progress, sampled = loop(p, "s3")
    assert sampled == 1
    assert progress == [(1, "reused"), (2, "reused"), (3, "rendering"), (3, "done")]
    row = out["longshot"]["plan_json"][2]
    assert (row["seed"], row["own_seed"], row["reason"]) == (3_141_592_653, True, "seed changed")

    # Edit Shot 2's text: 2 and 3 render again, 1 is kept
    p["shots"][1]["text"] += " She glances back once."
    out, progress, sampled = loop(p, "s3")
    assert sampled == 2
    assert progress[0] == (1, "reused")
    assert [r["reason"] for r in out["longshot"]["plan_json"]] == \
        [None, "prompt changed", "follows a changed segment"]

    # Bypass Shot 2: Shot 3 now follows Shot 1 and renders; Shot 1 kept
    p["shots"][1]["bypassed"] = True
    out, progress, sampled = loop(p, "s3")
    assert sampled == 1 and progress[0] == (1, "reused")
    assert len(out["longshot"]["plan_json"]) == 2


@CORE_PACKS
def test_shared_change_rerenders_everything(loop):
    p = small()
    loop(p, "s2")
    p["style"]["style_line"] += " Film grain."
    _, progress, sampled = loop(p, "s2")
    assert sampled == 2 and ("reused" not in {s for _, s in progress})


@CORE_PACKS
@need("MiniMaxH3SongTrack")
@pytest.mark.parametrize("lip,voice,final", [(True, False, True), (False, True, False),
                                             (True, True, True), (False, False, True)])
def test_audio_routes_run(loop, lip, voice, final):
    p = small()
    p["audio"].update(start=2.0, length=20.0, lip_sync=lip, voice_ref=voice, final_override=final)
    out, progress, sampled = loop(p, "s2")
    assert sampled == 2
    assert ("decode_audio" in RAN) == (not final)
    assert out["combine"]["gifs"][0]["filename"].endswith("-audio.mp4")
    assert ("lip-sync song connected" in out["longshot"]["text"][0]) == lip


# ---------------------------------------------------------------------------
# 3. HTTP routes
# ---------------------------------------------------------------------------

def _client_call(method, path, headers=None, **kw):
    from aiohttp import web
    from aiohttp.test_utils import TestClient, TestServer

    async def go():
        routes = web.RouteTableDef()
        assert srv.register(routes)
        app = web.Application()
        app.add_routes(routes)
        async with TestClient(TestServer(app)) as client:
            resp = await client.request(method, path, headers=headers or {}, **kw)
            body = await resp.read()
            try:
                body = json.loads(body)
            except ValueError:
                body = body.decode("utf-8", "replace")
            return resp.status, body

    return asyncio.run(go())


@ALL_PACKS
def test_routes_build_projects_options(install, monkeypatch):
    status, opts = _client_call("GET", "/longshot/options")
    assert status == 200
    assert listed("diffusion_models", "H3/minimax_h3_fl2va_pruned_bf16.safetensors") in opts["models"]
    assert "hero portrait (1).png" in opts["images"]
    assert SONG in opts["audio"]
    assert "er_sde" in opts["samplers"] and "beta57" in opts["schedulers"]
    assert opts["sizes"]["0.6|16:9"] == [1056, 608]
    assert opts["nodes"]["MiniMaxH3LongShot"] is True

    status, projects = _client_call("GET", "/longshot/projects")
    assert status == 200 and projects[0]["name"] == "Sample project"
    assert projects[0]["slug"] == "sample-project"
    status, proj = _client_call("GET", "/longshot/projects/sample-project")
    assert status == 200 and len(proj["shots"]) == 6 and proj["saved_at"]

    # save with the version we loaded; a second tab's stale save is refused
    proj["name"] = "Sample — renamed"
    status, saved = _client_call("PUT", "/longshot/projects/sample-project?base="
                                 + proj["saved_at"], json=proj)
    assert status == 200 and saved["slug"] == "sample-project"
    status, back = _client_call("GET", "/longshot/projects/sample-project")
    assert back["name"] == "Sample — renamed" and back["saved_at"] == saved["saved_at"]
    status, conflict = _client_call("PUT", "/longshot/projects/sample-project?base="
                                    + proj["saved_at"], json=dict(proj, name="stale tab"))
    assert status == 409 and conflict["current"]["name"] == "Sample — renamed"
    assert _client_call("PUT", "/longshot/projects/sample-project?force=1&base=x",
                        json=dict(proj, name="Sample project"))[0] == 200

    status, made = _client_call("POST", "/longshot/projects", json={"name": "Sample project",
                                                                    "project": {"shots": []}})
    assert status == 200 and made["slug"] == "sample-project-2"
    assert _client_call("GET", "/longshot/projects/nope")[0] == 404
    assert _client_call("GET", "/longshot/projects/..%2F..%2Fsecret")[0] in (400, 404)
    assert _client_call("PUT", "/longshot/projects/Bad Slug", json={})[0] == 400
    status, gone = _client_call("DELETE", "/longshot/projects/sample-project-2")
    assert status == 200 and gone["project"] is True
    assert [p["slug"] for p in _client_call("GET", "/longshot/projects")[1]] == ["sample-project"]

    # inputs and reference checks
    status, listing = _client_call("GET", "/longshot/inputs")
    assert "scene1.png" in listing["images"] and SONG in listing["audio"]
    assert _client_call("GET", "/longshot/inputs?subfolder=../..")[0] == 400
    status, checked = _client_call("POST", "/longshot/check-inputs", json={"files": [
        {"key": "c1", "name": "scene1.png", "subfolder": ""},
        {"key": "c2", "name": "gone.png", "subfolder": ""},
        {"key": "c3", "name": "scene1.png", "subfolder": "", "sha256": "0" * 64},
        {"key": "c4", "name": "../../etc/passwd", "subfolder": ""}]})
    states = {f["key"]: f["state"] for f in checked["files"]}
    assert states == {"c1": "ok", "c2": "missing", "c3": "changed", "c4": "invalid"}
    assert len(checked["files"][0]["sha256"]) == 64

    # dropping a reference image: saved under input/longshot/<slug>/, deduplicated
    import io
    from PIL import Image
    buf = io.BytesIO()
    Image.new("RGB", (16, 16), (10, 120, 200)).save(buf, "PNG")

    def form(name="dropped face.png", data=None, slug="sample-project"):
        from aiohttp import FormData
        fd = FormData(quote_fields=False)      # browsers send file names unescaped
        fd.add_field("project", slug)
        fd.add_field("file", data if data is not None else buf.getvalue(), filename=name,
                     content_type="image/png")
        return fd

    status, up = _client_call("POST", "/longshot/upload", data=form())
    assert status == 200 and up == dict(up, name="dropped face.png",
                                        subfolder="longshot/sample-project", reused=False)
    status, mine = _client_call("GET", "/longshot/inputs?subfolder=longshot/sample-project")
    assert "dropped face.png" in mine["images"]
    assert _client_call("POST", "/longshot/upload", data=form())[1]["reused"] is True
    assert _client_call("POST", "/longshot/upload", data=form(slug="nope"))[0] == 404
    status, bad = _client_call("POST", "/longshot/upload", data=form(name="x.txt"))
    assert status == 400 and "can't be used" in bad["error"]
    assert _client_call("POST", "/longshot/upload", data=form(data=b"junk"))[0] == 400

    status, built = _client_call("POST", "/longshot/build",
                                 json={"project": project(), "upto": "s2", "dry_run": True})
    assert status == 200 and built["chain"] == ["s1", "s2"]
    assert built["prompt"]["longshot"]["inputs"]["dry_run"] is True
    assert validate(built["prompt"])[0]

    status, err = _client_call("POST", "/longshot/build", json={"project": {"shots": []}})
    assert status == 400 and "error" in err


@ALL_PACKS
def test_routes_page_and_static(install):
    status, html = _client_call("GET", "/longshot")
    assert status == 200 and "H3 Long Shot Studio" in html
    assert _client_call("GET", "/longshot/static/studio.js")[0] == 200
    assert _client_call("GET", "/longshot/static/..%2F__init__.py")[0] == 404


@ALL_PACKS
def test_open_folder_is_local_only(install, monkeypatch):
    launched = []
    monkeypatch.setattr(srv, "launch", launched.append)
    assert _client_call("GET", "/longshot/capabilities")[1]["local"] is True
    fwd = {"X-Forwarded-For": "100.64.0.7"}
    assert _client_call("GET", "/longshot/capabilities", headers=fwd)[1]["local"] is False
    assert _client_call("POST", "/longshot/open-folder", headers=fwd,
                        json={"which": "output"})[0] == 403
    assert launched == []

    out_dir = os.path.join(folder_paths.get_output_directory(), "longshot")
    os.makedirs(out_dir, exist_ok=True)
    open(os.path.join(out_dir, "Sample_00001.mp4"), "wb").close()
    status, body = _client_call("POST", "/longshot/open-folder",
                                json={"which": "output", "select": "Sample_00001.mp4"})
    assert status == 200 and body["selected"] is True
    assert body["opened"] == out_dir
    status, body = _client_call("POST", "/longshot/open-folder",
                                json={"which": "output", "select": "../../secret.txt"})
    assert status == 200 and body["selected"] is False
    assert _client_call("POST", "/longshot/open-folder", json={"which": "/etc"})[0] == 400
    # input: this project's subfolder when it exists, the input folder otherwise
    inp = folder_paths.get_input_directory()
    os.makedirs(os.path.join(inp, "longshot", "sample-project"), exist_ok=True)
    body = _client_call("POST", "/longshot/open-folder",
                        json={"which": "input", "project": "sample-project"})[1]
    assert body["opened"] == os.path.join(inp, "longshot", "sample-project")
    for bad in ("no-such-project", "../..", None):
        body = _client_call("POST", "/longshot/open-folder", json={"which": "input", "project": bad})[1]
        assert body["opened"] == inp
    assert len(launched) == 6


@ALL_PACKS
def test_segment_routes_are_local_only(install, monkeypatch):
    out = folder_paths.get_output_directory()
    seg = os.path.join(out, "longshot", "sample-project", "segments")
    os.makedirs(seg, exist_ok=True)
    for f in ("a" * 32 + ".safetensors", "b" * 32 + ".safetensors"):
        with open(os.path.join(seg, f), "wb") as fh:
            fh.write(b"x" * 10)
    status, stats = _client_call("GET", "/longshot/segments/sample-project")
    assert status == 200 and stats == {"files": 2, "bytes": 20}
    fwd = {"X-Forwarded-For": "100.64.0.7"}
    assert _client_call("POST", "/longshot/clear-segments", headers=fwd,
                        json={"project": "sample-project"})[0] == 403
    assert _client_call("POST", "/longshot/clear-segments", json={"project": "../x"})[0] == 400
    status, cleared = _client_call("POST", "/longshot/clear-segments",
                                   json={"project": "sample-project"})
    assert status == 200 and cleared["removed"] == 2 and cleared["files"] == 0
    # deleting a project's files is local-only too
    _client_call("POST", "/longshot/projects", json={"name": "Scratch", "project": {}})
    assert _client_call("DELETE", "/longshot/projects/scratch?segments=1", headers=fwd)[0] == 403
    assert _client_call("DELETE", "/longshot/projects/scratch?segments=1")[0] == 200


@CORE_PACKS
def test_crash_resume_from_saved_segments(loop):
    """A.4: after a restart nothing previously rendered is sampled again, and the
    model isn't even loaded until a Shot needs rendering."""
    p = small()
    loop(p, "s1")
    loop(p, "s2")
    _, _, sampled = loop(p, "s3")
    assert sampled == 1

    RAN.clear()
    out, progress, sampled = loop(p, "s3", dry_run=True, restart=True)
    assert sampled == 0 and "unet" not in RAN, "the reopen check never loads the model"
    rows = out["longshot"]["plan_json"]
    assert [(r["status"], r["source"]) for r in rows] == [("reused", "disk")] * 3

    RAN.clear()
    out, progress, sampled = loop(p, "s3", restart=True)
    assert sampled == 0 and "unet" not in RAN
    assert progress == [(1, "reused"), (2, "reused"), (3, "reused")]
    assert loop.sources == ["disk"] * 3
    assert out["combine"]["gifs"][0]["filename"].startswith("Sample project_")

    RAN.clear()
    out, progress, sampled = loop(p, "s4", restart=True)     # Continue after the crash
    assert sampled == 1 and RAN.count("unet") == 1
    assert progress == [(1, "reused"), (2, "reused"), (3, "reused"), (4, "rendering"), (4, "done")]


@CORE_PACKS
@need("MiniMaxH3SongTrack")
def test_references_and_audio_load_from_a_project_subfolder(loop):
    """B.3: LoadImage and VHS Load Audio both accept input/longshot/<slug>/…"""
    inp = folder_paths.get_input_directory()
    sub = os.path.join(inp, "longshot", "sample-project")
    os.makedirs(sub, exist_ok=True)
    p = small()
    shutil.copy(os.path.join(inp, p["cast"][0]["image"]), os.path.join(sub, "hero (1).png"))
    shutil.copy(os.path.join(inp, SONG), os.path.join(sub, "song.mp3"))
    p["cast"][0].update(image="hero (1).png", subfolder="longshot/sample-project")
    p["audio"].update(file="song.mp3", subfolder="longshot/sample-project", start=1.0,
                      length=12.0, lip_sync=True, final_override=True)
    built = gb.build_prompt(p, upto="s2", env=srv.current_env())
    ok, err, _, node_errors = validate(built.prompt)
    assert ok, (err, node_errors)
    out, progress, sampled = loop(p, "s2")
    assert sampled == 2 and out["combine"]["gifs"][0]["filename"].endswith("-audio.mp4")


@ALL_PACKS
def test_restart_route_replies_then_restarts(install, monkeypatch):
    called = []
    monkeypatch.setattr(srv, "restart_comfyui", lambda: called.append(True))

    async def go():
        from aiohttp import web
        from aiohttp.test_utils import TestClient, TestServer
        routes = web.RouteTableDef()
        srv.register(routes)
        app = web.Application()
        app.add_routes(routes)
        async with TestClient(TestServer(app)) as client:
            resp = await client.post("/longshot/restart", headers={"X-Forwarded-For": "100.64.0.7"})
            body = await resp.json()
            assert called == [], "the reply goes out before the restart"
            await asyncio.sleep(0.8)
            return resp.status, body

    status, body = asyncio.run(go())
    assert status == 200 and body == {"restarting": True}
    assert called == [True], "restart also works from another device (Tailscale)"


def _vsr_stand_in():
    """RTX Video Super Resolution needs an NVIDIA GPU (nvvfx), so this copies
    its input schema from ComfyUI-NVIDIA-RTX-VSR-Pro and upscales by repeating
    pixels. ComfyUI validates the Studio's inputs against the same schema."""
    from comfy_api.latest import io

    class RTXVideoSuperResolution(io.ComfyNode):
        @classmethod
        def define_schema(cls):
            return io.Schema(node_id="RTXVideoSuperResolution", category="image/upscaling", inputs=[
                io.Image.Input("images"),
                io.DynamicCombo.Input("resize_type", options=[
                    io.DynamicCombo.Option("scale by multiplier", [
                        io.Float.Input("scale", default=2.0, min=1.0, max=4.0, step=0.01)]),
                    io.DynamicCombo.Option("target dimensions", [
                        io.Int.Input("width", default=1920, min=64, max=16384, step=8),
                        io.Int.Input("height", default=1080, min=64, max=16384, step=8),
                        io.Boolean.Input("keep_aspect_ratio", default=True)]),
                ]),
                io.Combo.Input("quality", options=["LOW", "MEDIUM", "HIGH", "ULTRA"], default="ULTRA"),
            ], outputs=[io.Image.Output("upscaled_images"), io.Float.Output("calculated_scale"),
                        io.Int.Output("output_width"), io.Int.Output("output_height")])

        @classmethod
        def execute(cls, images, resize_type, quality):
            k = int(round(resize_type["scale"]))
            RAN.append(("vsr", resize_type["resize_type"], resize_type["scale"], quality))
            up = images.repeat_interleave(k, dim=1).repeat_interleave(k, dim=2)
            return io.NodeOutput(up, float(k), up.shape[2], up.shape[1])

    return RTXVideoSuperResolution


@CORE_PACKS
def test_rtx_vsr_validates_and_runs(loop, monkeypatch):
    monkeypatch.setitem(comfy_nodes.NODE_CLASS_MAPPINGS, "RTXVideoSuperResolution", _vsr_stand_in())
    p = small()
    p["settings"]["rtx_vsr"] = {"on": True, "scale": 2.0, "quality": "ULTRA"}
    built = gb.build_prompt(p, upto="s1", env=srv.current_env())
    ok, err, _, node_errors = validate(built.prompt)
    assert ok, (err, node_errors)
    out, progress, sampled = loop(p, "s1")
    assert ("vsr", "scale by multiplier", 2.0, "ULTRA") in RAN
    # toggling it off again reuses the segment: only decode + save run again
    p["settings"]["rtx_vsr"]["on"] = False
    RAN.clear()
    out, progress, sampled = loop(p, "s1")
    # nothing re-samples: ComfyUI serves Long Shot from its cache (or memory reuses it)
    assert sampled == 0 and progress in ([], [(1, "reused")])
    assert not [r for r in RAN if isinstance(r, tuple) and r[0] == "vsr"]
    assert out["combine"]["gifs"][0]["filename"].startswith("Sample project")



@CORE_PACKS
def test_upscale_final_reuses_every_segment(loop, monkeypatch):
    monkeypatch.setitem(comfy_nodes.NODE_CLASS_MAPPINGS, "RTXVideoSuperResolution", _vsr_stand_in())
    p = small()
    p["settings"]["rtx_vsr"] = {"on": False, "scale": 2.0, "quality": "ULTRA"}
    loop(p, "s1")
    loop(p, "s2")
    RAN.clear()
    out, progress, sampled = loop(p, "s2", final=True, restart=True)   # even after a restart
    assert sampled == 0 and progress == [(1, "reused"), (2, "reused")]
    assert ("vsr", "scale by multiplier", 2.0, "ULTRA") in RAN and "unet" not in RAN
    assert out["combine"]["gifs"][0]["filename"].startswith("Sample project_final_")
