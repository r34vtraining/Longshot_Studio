"""Graph builder unit tests: pure Python, no ComfyUI, no GPU.

Every toggle combination from the spec: audio routes, bypassed cast and Shots,
LoRAs on/off, Turbo off, optional Sage, nvenc fallback, missing node classes.
"""
import copy
import importlib
import itertools
import json
import os
import sys

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
PKG_DIR = os.path.dirname(HERE)
sys.path.insert(0, os.path.dirname(PKG_DIR))
gb = importlib.import_module(os.path.basename(PKG_DIR) + ".graph_builder")

SAMPLE = os.path.join(HERE, "fixtures", "sample_project.json")


def sample():
    with open(SAMPLE, encoding="utf-8") as fh:
        return json.load(fh)


def build(project, **kw):
    return gb.build_prompt(project, **kw)


def of_class(prompt, cls):
    return {k: v for k, v in prompt.items() if v["class_type"] == cls}


def links(prompt):
    for nid, node in prompt.items():
        for name, value in node["inputs"].items():
            if isinstance(value, list) and len(value) == 2 and isinstance(value[1], int):
                yield nid, name, value


def check_wiring(prompt):
    """Every link points at an existing node, and nothing dangles: every node
    feeds something, except the Video Combine output."""
    used = set()
    for nid, name, (src, idx) in links(prompt):
        assert src in prompt, f"{nid}.{name} -> missing node {src}"
        assert idx >= 0
        used.add(src)
    dangling = set(prompt) - used - {"combine", "combine_prores", "save_audio", "upscale_chunk"} \
        - {n for n in prompt if prompt[n]["class_type"] in ("MiniMaxH3UpscaleChunk", "MiniMaxH3SaveAudio")}
    assert not dangling, f"nodes that feed nothing: {dangling}"


def upstream(prompt, nid):
    """All node ids nid depends on."""
    seen, todo = set(), [nid]
    while todo:
        n = todo.pop()
        for value in prompt[n]["inputs"].values():
            if isinstance(value, list) and len(value) == 2 and value[0] in prompt \
                    and value[0] not in seen:
                seen.add(value[0])
                todo.append(value[0])
    return seen


def model_chain(prompt):
    """Class names from the sigma scheduler's model back to the UNET loader."""
    out, link = [], prompt["scheduler"]["inputs"]["model"]
    while True:
        node = prompt[link[0]]
        out.append(node["class_type"])
        if "model" not in node["inputs"]:
            return list(reversed(out))
        link = node["inputs"]["model"]


# ---------------------------------------------------------------------------
# The sample project builds the reference Ref2V Long Shot workflow
# ---------------------------------------------------------------------------

def test_sample_builds_the_reference_workflow():
    b = build(sample())
    p = b.prompt
    check_wiring(p)
    assert model_chain(p) == ["UNETLoader", "PathchSageAttentionKJ", "MiniMaxH3SigmaShift",
                              "MiniMaxH3TurboLoRA"]
    assert p["unet"]["inputs"] == {"unet_name": "H3\\minimax_h3_fl2va_pruned_bf16.safetensors",
                                   "weight_dtype": "default"}
    assert p["sage"]["inputs"]["sage_attention"] == "auto"
    assert p["sage"]["inputs"]["allow_compile"] is False
    assert p["shift"]["inputs"]["shift_video"] == 12 and p["shift"]["inputs"]["shift_audio"] == 3
    assert p["turbo"]["inputs"]["lora_name"].endswith("ref2v_turbo_8step_v1.0_768p_comfyui_bf16.safetensors")
    assert p["clip"]["inputs"] == {"clip_name": "H3\\qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors",
                                   "type": "minimax", "device": "default"}
    assert p["scheduler"]["inputs"]["scheduler"] == "beta57"
    assert p["scheduler"]["inputs"]["steps"] == 8 and p["scheduler"]["inputs"]["denoise"] == 1
    assert p["sampler"]["inputs"] == {"sampler_name": "er_sde"}
    assert p["noise"]["inputs"] == {"noise_seed": 1722}

    ls = p["longshot"]["inputs"]
    assert (ls["width"], ls["height"]) == (1056, 608)
    assert ls["overlap_frames"] == 22 and ls["seed_mode"] == "increment"
    assert ls["reuse_segments"] is True and ls["ref_image_size"] == "match"
    assert ls["dry_run"] is False
    assert ls["prompt"] == ["builder", 3]
    assert ls["audio_vae"] == ["vae_audio", 0] and ls["vae"] == ["vae_video", 0]
    assert ls["model"] == ["turbo", 0]
    assert "song" not in ls and not any(k.startswith("ref_audios") for k in ls)

    # 7 references, in order, each resized exactly as the reference workflow does
    for k in range(7):
        r = p[ls[f"ref_images.ref_image_{k}"][0]]
        assert r["class_type"] == "ImageScaleToMaxDimension"          # core (0.8.6, was KJNodes)
        assert {x: r["inputs"][x] for x in r["inputs"] if x != "image"} == dict(
            upscale_method="lanczos", largest_size=1500)
    assert p[p[ls["ref_images.ref_image_0"][0]]["inputs"]["image"][0]]["inputs"]["image"] \
        == "hero portrait (1).png"
    assert "ref_images.ref_image_7" not in ls

    # subject chain: <hero> first, cited as <Picture 1>; the builder gets the last
    subs = of_class(p, "MiniMaxH3Subject")
    assert len(subs) == 7
    assert p["subject1"]["inputs"]["label"] == "<hero>"
    assert p["subject1"]["inputs"]["reference"] == "<Picture 1>"
    assert "subjects" not in p["subject1"]["inputs"]
    assert p["subject7"]["inputs"]["reference"] == "<Picture 7>"
    assert p["subject7"]["inputs"]["subjects"] == ["subject6", 0]
    assert p["builder"]["inputs"]["subjects"] == ["subject7", 0]
    assert p["builder"]["inputs"]["subject_definitions"] == ""
    assert p["builder"]["inputs"]["task_type"] == "reference generation"

    # Shots: all six, chained, seeds as saved (Shot 3 carries its saved 0)
    shots = of_class(p, "MiniMaxH3TimelineShot")
    assert len(shots) == 6
    assert [p[f"shot{n}"]["inputs"]["seconds"] for n in range(1, 7)] == [5, 5, 5, 5, 9, 6]
    assert [p[f"shot{n}"]["inputs"]["shot_seed"] for n in range(1, 7)] == [-1, -1, 0, -1, -1, -1]
    assert [p[f"shot{n}"]["inputs"]["shot_id"] for n in range(1, 7)] == [f"s{n}" for n in range(1, 7)]
    assert all(s["inputs"]["lock"] == "" and s["inputs"]["join"] == "bridge"
               and s["inputs"]["frames"] == 0 for s in shots.values())
    assert p["builder"]["inputs"]["shots"] == ["shot6", 0]

    c = p["combine"]["inputs"]
    assert c["filename_prefix"] == "longshot/sample-project/videos/Sample project"
    assert p["combine"]["class_type"] == "MiniMaxH3SaveVideo"          # 0.8.7: Long Shot's, not VHS
    assert c["codec"] == "h264_nvenc" and c["frame_rate"] == 24
    assert c["audio"] == ["decode_audio", 0] and c["images"] == ["decode", 0]
    # no CLIPVisionEncode, no ResolutionSelector, no rgthree switch, no Seed Everywhere
    classes = {n["class_type"] for n in p.values()}
    assert not classes & {"CLIPVisionEncode", "ResolutionSelector", "Any Switch (rgthree)",
                          "Seed Everywhere", "SetImageSize"}
    assert b.chain == ["s1", "s2", "s3", "s4", "s5", "s6"]


def test_prompt_is_json_serialisable():
    json.dumps(build(sample()).prompt)


# ---------------------------------------------------------------------------
# Chains: Start / Continue / Reroll
# ---------------------------------------------------------------------------

def test_start_renders_shot_1_only():
    b = build(sample(), upto="s1")
    assert b.chain == ["s1"]
    assert len(of_class(b.prompt, "MiniMaxH3TimelineShot")) == 1
    assert b.prompt["builder"]["inputs"]["shots"] == ["shot1", 0]
    check_wiring(b.prompt)


@pytest.mark.parametrize("upto,n", [("s2", 2), ("s4", 4), ("s6", 6)])
def test_continue_queues_the_chain_up_to_the_target(upto, n):
    b = build(sample(), upto=upto)
    assert len(of_class(b.prompt, "MiniMaxH3TimelineShot")) == n
    assert b.prompt["builder"]["inputs"]["shots"] == [f"shot{n}", 0]


def test_reroll_changes_only_that_shots_seed():
    a = sample()
    before = build(a, upto="s3").prompt
    a["shots"][2]["shot_seed"] = 4_000_000_000
    after = build(a, upto="s3").prompt
    diff = [k for k in before if before[k] != after[k]]
    assert diff == ["shot3"]
    assert after["shot3"]["inputs"]["shot_seed"] == 4_000_000_000


def test_unknown_or_bypassed_target_is_an_error():
    p = sample()
    p["shots"][1]["bypassed"] = True
    with pytest.raises(gb.BuildError):
        build(p, upto="s2")
    with pytest.raises(gb.BuildError):
        build(p, upto="nope")


def test_dry_run_is_the_same_graph_with_dry_run_on():
    real, dry = build(sample(), upto="s3").prompt, build(sample(), upto="s3", dry_run=True).prompt
    assert set(real) == set(dry)
    assert dry["longshot"]["inputs"]["dry_run"] is True
    dry["longshot"]["inputs"]["dry_run"] = False
    assert real == dry


# ---------------------------------------------------------------------------
# Bypass / remove / renumber
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("off", [set(), {0}, {1}, {6}, {0, 3}, {1, 2, 4, 5}])
def test_bypassed_cast_renumbers_pictures(off):
    p = sample()
    for i in off:
        p["cast"][i]["bypassed"] = True
    b = build(p)
    check_wiring(b.prompt)
    live = [c for i, c in enumerate(p["cast"]) if i not in off]
    ls = b.prompt["longshot"]["inputs"]
    assert sorted(k for k in ls if k.startswith("ref_images.")) == \
        [f"ref_images.ref_image_{k}" for k in range(len(live))]
    for k, c in enumerate(live):
        resize = b.prompt[ls[f"ref_images.ref_image_{k}"][0]]
        assert b.prompt[resize["inputs"]["image"][0]]["inputs"]["image"] == c["image"]
        sub = b.prompt[f"subject{k + 1}"]["inputs"]
        assert sub["label"] == c["label"] and sub["reference"] == f"<Picture {k + 1}>"
        assert sub["description"] == c["desc"] and sub["role"] == "appearance"
        assert (sub["role_2"], sub["reference_2"]) == ("-", "")


def test_no_cast_means_no_reference_nodes():
    p = sample()
    p["cast"] = []
    b = build(p)
    check_wiring(b.prompt)
    classes = {n["class_type"] for n in b.prompt.values()}
    assert not classes & {"LoadImage", "ImageResizeKJv2", "MiniMaxH3Subject"}
    assert "subjects" not in b.prompt["builder"]["inputs"]


def test_all_cast_bypassed_is_the_same_as_none():
    p = sample()
    for c in p["cast"]:
        c["bypassed"] = True
    q = sample()
    q["cast"] = []
    assert build(p).prompt == build(q).prompt


@pytest.mark.parametrize("off", [{0}, {2}, {5}, {1, 3}])
def test_bypassed_shots_are_left_out_and_renumber(off):
    p = sample()
    for i in off:
        p["shots"][i]["bypassed"] = True
    b = build(p)
    live = [s for i, s in enumerate(p["shots"]) if i not in off]
    assert b.chain == [s["id"] for s in live]
    shots = of_class(b.prompt, "MiniMaxH3TimelineShot")
    assert len(shots) == len(live)
    for n, s in enumerate(live, 1):
        assert b.prompt[f"shot{n}"]["inputs"]["text"] == s["text"]
        assert b.prompt[f"shot{n}"]["inputs"]["seconds"] == s["seconds"]
        assert ("shots" in b.prompt[f"shot{n}"]["inputs"]) == (n > 1)


def test_all_shots_bypassed_is_an_error():
    p = sample()
    for s in p["shots"]:
        s["bypassed"] = True
    with pytest.raises(gb.BuildError, match="No active Shots"):
        build(p)


def test_reference_without_image_names_its_label():
    p = sample()
    p["cast"][1]["image"] = None
    with pytest.raises(gb.BuildError, match=r"<outfit> \(<Picture 2>\)"):
        build(p)
    p["cast"][1]["bypassed"] = True
    build(p)


def test_too_many_references():
    p = sample()
    p["cast"] = [dict(p["cast"][0], id=f"x{i}") for i in range(10)]
    with pytest.raises(gb.BuildError, match="at most 9"):
        build(p)


# ---------------------------------------------------------------------------
# Models: Turbo, LoRAs, Sage
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("turbo", [True, False])
@pytest.mark.parametrize("on", list(itertools.product([False, True], repeat=3)))
def test_turbo_and_lora_combinations(turbo, on):
    p = sample()
    p["settings"]["turbo"]["on"] = turbo
    p["settings"]["loras"] = [{"on": o, "name": f"style_{i}.safetensors", "strength": 0.5 + i}
                              for i, o in enumerate(on, 1)]
    b = build(p)
    check_wiring(b.prompt)
    want = ["UNETLoader", "PathchSageAttentionKJ", "MiniMaxH3SigmaShift"]
    want += ["MiniMaxH3TurboLoRA"] if turbo else []
    want += ["LoraLoaderModelOnly"] * sum(on)
    assert model_chain(b.prompt) == want
    loras = [b.prompt[f"lora{i}"]["inputs"] for i, o in enumerate(on, 1) if o]
    assert [l["lora_name"] for l in loras] == [f"style_{i}.safetensors"
                                                for i, o in enumerate(on, 1) if o]
    assert [l["strength_model"] for l in loras] == [0.5 + i for i, o in enumerate(on, 1) if o]
    # Long Shot and the scheduler both get the end of the chain
    assert b.prompt["longshot"]["inputs"]["model"] == b.prompt["scheduler"]["inputs"]["model"]
    assert ("turbo" in b.prompt) == turbo


def test_turbo_off_with_few_steps_warns():
    p = sample()
    p["settings"]["turbo"]["on"] = False
    assert any("Turbo is off" in w for w in build(p).warnings)
    p["settings"]["steps"] = 20
    assert not any("Turbo is off" in w for w in build(p).warnings)


def test_turbo_strength_and_low_vram():
    p = sample()
    p["settings"]["turbo"]["strength"] = 0.75
    t = build(p).prompt["turbo"]["inputs"]
    assert t["strength"] == 0.75 and t["low_vram"] is False


def test_lora_on_without_a_file_is_an_error():
    p = sample()
    p["settings"]["loras"][1] = {"on": True, "name": None, "strength": 1}
    with pytest.raises(gb.BuildError, match="LoRA 2"):
        build(p)


def test_lora_off_without_a_file_is_fine():
    p = sample()
    p["settings"]["loras"][1] = {"on": False, "name": None, "strength": 1}
    build(p)


def test_sage_is_skipped_when_kjnodes_lacks_it():
    env = gb.Env(classes=set(gb.required_classes(sample())) - {"PathchSageAttentionKJ"})
    b = build(sample(), env=env)
    assert "sage" not in b.prompt
    assert model_chain(b.prompt)[:2] == ["UNETLoader", "MiniMaxH3SigmaShift"]
    assert not any("SageAttention" in w for w in b.warnings)     # ComfyUI's launch flag does it
    check_wiring(b.prompt)


@pytest.mark.parametrize("mode", ["disabled", "off", None, ""])
def test_sage_can_be_turned_off(mode):
    p = sample()
    p["settings"]["sage_attention"] = mode
    assert "sage" not in build(p).prompt


def test_model_settings_flow_through():
    p = sample()
    s = p["settings"]
    s.update(model="other.safetensors", sampler="euler", scheduler="simple", steps=20,
             seed=99, seed_mode="same", overlap=39, ref_image_size="max", ref_resize_px=1024,
             shift_video=8.5, shift_audio=2)
    b = build(p).prompt
    assert b["unet"]["inputs"]["unet_name"] == "other.safetensors"
    assert b["sampler"]["inputs"]["sampler_name"] == "euler"
    assert b["scheduler"]["inputs"]["scheduler"] == "simple"
    assert b["scheduler"]["inputs"]["steps"] == 20
    assert b["noise"]["inputs"]["noise_seed"] == 99
    ls = b["longshot"]["inputs"]
    assert (ls["seed_mode"], ls["overlap_frames"], ls["ref_image_size"]) == ("same", 39, "max")
    assert b["resize1"]["inputs"]["largest_size"] == 1024
    assert (b["shift"]["inputs"]["shift_video"], b["shift"]["inputs"]["shift_audio"]) == (8.5, 2)


@pytest.mark.parametrize("field,value,match", [
    ("overlap", 20, "17k"), ("seed", -1, "fixed"), ("seed_mode", "random", "Seed mode"),
    ("ref_image_size", "big", "Reference image size"), ("aspect", "5:4", "aspect"),
    ("steps", 0, "Steps"), ("model", "", "model"), ("megapixels", 0, "MP")])
def test_bad_settings_are_reported(field, value, match):
    p = sample()
    p["settings"][field] = value
    with pytest.raises(gb.BuildError, match=match):
        build(p)


@pytest.mark.parametrize("seed,ok", [(-1, True), (0, True), (2**32 - 1, True),
                                     (2**64 - 1, True), (2**64, False), (-2, False),
                                     ("", True), (None, True), ("abc", False)])
def test_shot_seed_range(seed, ok):
    p = sample()
    p["shots"][0]["shot_seed"] = seed
    if ok:
        got = build(p).prompt["shot1"]["inputs"]["shot_seed"]
        assert got == (-1 if seed in ("", None) else seed)
    else:
        with pytest.raises(gb.BuildError):
            build(p)


# ---------------------------------------------------------------------------
# Audio routes: every combination
# ---------------------------------------------------------------------------

AUDIO_CLASSES = {"LoadAudio", "TrimAudioDuration", "MiniMaxH3SongTrack", "MelBandRoFormerModelLoader",
                 "MelBandRoFormerSampler"}


@pytest.mark.parametrize("lip,voice,final", list(itertools.product([False, True], repeat=3)))
def test_audio_route_combinations(lip, voice, final):
    p = sample()
    p["audio"].update(lip_sync=lip, voice_ref=voice, final_override=final)
    b = build(p)
    g = b.prompt
    check_wiring(g)
    ls = g["longshot"]["inputs"]
    classes = {n["class_type"] for n in g.values()}
    if not (lip or voice or final):
        assert not classes & AUDIO_CLASSES, "all routes off: no audio nodes at all"
    else:
        assert g["audio_file"]["inputs"] == {"audio": "song.mp3"}
        assert g["audio"]["inputs"] == {"audio": ["audio_file", 0], "start_index": 15.0, "duration": 15.1}
    assert ("song" in ls) == lip
    if lip:
        assert g[ls["song"][0]]["class_type"] == "MiniMaxH3SongTrack"
        assert g["song"]["inputs"] == {"audio": ["audio", 0], "audio_vae": ["vae_audio", 0]}
    assert ("ref_audios.ref_audio_0" in ls) == voice
    if voice:
        assert ls["ref_audios.ref_audio_0"] == ["vocals", 0]      # output 0 = vocals
        assert g["vocals"]["inputs"] == {"model": ["melband", 0], "audio": ["audio", 0]}
        assert g["melband"]["inputs"]["model_name"] == \
            "Infinite Talk\\MelBandRoformer_fp16.safetensors"
    assert ls["audio_vae"] == ["vae_audio", 0]
    want = ["audio", 0] if final else ["decode_audio", 0]
    assert g["combine"]["inputs"]["audio"] == want
    # the H3 audio decoder exists only when its audio is used
    assert ("decode_audio" in g) == (not final)


def test_audio_route_without_a_file_is_an_error():
    p = sample()
    p["audio"].update(file=None, lip_sync=True)
    with pytest.raises(gb.BuildError, match="audio file"):
        build(p)


def test_audio_file_with_routes_off_adds_nothing():
    p = sample()
    p["audio"].update(lip_sync=False, voice_ref=False, final_override=False)
    assert "audio" not in build(p).prompt


def test_melband_model_is_selectable():
    p = sample()
    p["audio"].update(voice_ref=True, melband_model="MelBand\\other.safetensors")
    assert build(p).prompt["melband"]["inputs"]["model_name"] == "MelBand\\other.safetensors"


def test_short_song_warns():
    p = sample()
    p["audio"].update(lip_sync=True, length=10)
    assert any("song clip" in w for w in build(p, upto="s3").warnings)
    assert not any("song clip" in w for w in build(p, upto="s2").warnings)


# ---------------------------------------------------------------------------
# Environment: missing nodes, nvenc fallback
# ---------------------------------------------------------------------------

def test_missing_node_classes_are_named_with_their_pack():
    env = gb.Env(classes=set(gb.required_classes(sample())) - {"MiniMaxH3SaveVideo",
                                                              "MiniMaxH3LongShot"})
    with pytest.raises(gb.BuildError) as err:
        build(sample(), env=env)
    msg = str(err.value)
    assert "MiniMaxH3SaveVideo — from H3 Long Shot 1.6.11+" in msg
    assert "MiniMaxH3LongShot — from H3 Long Shot" in msg


def test_turbo_node_only_required_when_turbo_is_on():
    p = sample()
    env = gb.Env(classes=set(gb.required_classes(p)) - {"MiniMaxH3TurboLoRA"})
    # no Turbo pack and no stock loader either: it names the stock loader (0.8.6 fallback)
    with pytest.raises(gb.BuildError, match="LoraLoaderModelOnly"):
        build(p, env=env)
    p["settings"]["turbo"]["on"] = False
    build(p, env=env)


def test_melband_only_required_for_voice_reference():
    p = sample()
    env = gb.Env(classes=set(gb.required_classes(p)) | {"LoadAudio", "TrimAudioDuration",
                                                         "MiniMaxH3SongTrack"})
    p["audio"].update(lip_sync=True, final_override=True)
    build(p, env=env)
    p["audio"]["voice_ref"] = True
    with pytest.raises(gb.BuildError, match="MelBandRoFormer"):
        build(p, env=env)


@pytest.mark.parametrize("nvenc,want", [(None, "h264_nvenc"), (True, "h264_nvenc"), (False, "libx264")])
def test_nvenc_falls_back_to_h264(nvenc, want):
    b = build(sample(), env=gb.Env(nvenc=nvenc))
    assert b.prompt["combine"]["inputs"]["codec"] == want
    assert any("NVENC" in w for w in b.warnings) == (want == "libx264")


# ---------------------------------------------------------------------------
# Size, names, labels
# ---------------------------------------------------------------------------

# MiniMax's published 16:9 size table (multiple = 32)
MINIMAX_TABLE = {0.2: (608, 352), 0.3: (736, 416), 0.4: (864, 480), 0.5: (960, 544),
                 0.6: (1056, 608), 0.7: (1152, 640), 0.8: (1216, 672), 0.9: (1280, 736),
                 0.98: (1344, 768), 1.0: (1376, 768), 1.2: (1504, 832), 1.5: (1664, 928),
                 1.8: (1824, 1024), 2.0: (1920, 1088)}


@pytest.mark.parametrize("mp", sorted(MINIMAX_TABLE))
def test_output_size_matches_minimax_table(mp):
    assert gb.output_size(mp, "16:9") == MINIMAX_TABLE[mp]


def test_output_size_is_on_the_32_grid_for_every_preset():
    for key, (w, h) in gb.size_table().items():
        assert w % 32 == 0 and h % 32 == 0, key
    assert gb.output_size(0.6, "9:16") == (608, 1056)
    assert gb.output_size(1.0, "1:1") == (1024, 1024)


def test_size_flows_into_long_shot():
    p = sample()
    p["settings"].update(megapixels=0.98, aspect="16:9")
    b = build(p)
    ls = b.prompt["longshot"]["inputs"]
    assert (ls["width"], ls["height"]) == (b.width, b.height) == (1344, 768)


@pytest.mark.parametrize("name,want", [
    ("Sample project", "Sample project"),
    ("../../etc/passwd", "_etc_passwd"), ('a:b*c?"d<e>f|g', "a_b_c_d_e_f_g"),
    ("  ..hidden  ", "hidden"), ("", "untitled"), (None, "untitled"),
    ("C:\\Windows\\x", "C_Windows_x")])
def test_safe_name(name, want):
    assert gb.safe_name(name) == want


def test_output_prefix_stays_in_the_project_videos_folder():
    p = sample()
    p["name"] = "../../escape/me"
    prefix = build(p).prompt["combine"]["inputs"]["filename_prefix"]
    assert prefix == "longshot/sample-project/videos/_escape_me"
    assert prefix.count("/") == 3
    # a slug that isn't one is never used as a folder: the name's slug is
    p["slug"] = "../../etc"
    prefix = build(p).prompt["combine"]["inputs"]["filename_prefix"]
    assert prefix == "longshot/escape-me/videos/_escape_me"
    assert gb.videos_subfolder(p) == "longshot/escape-me/videos"


def test_task_types_map_to_the_three_slots():
    p = sample()
    p["style"]["task_types"] = ["reference generation", "audio reference"]
    i = build(p).prompt["builder"]["inputs"]
    assert (i["task_type"], i["task_type_2"], i["task_type_3"]) == \
        ("reference generation", "audio reference", "-")
    p["style"]["task_types"] = []
    i = build(p).prompt["builder"]["inputs"]
    assert (i["task_type"], i["task_type_2"], i["task_type_3"]) == \
        ("reference generation", "-", "-")


def test_style_fields_reach_the_builder():
    p = sample()
    p["style"].update(summary="S", retention="R", style_line="L", soundscape="A", music="M")
    i = build(p).prompt["builder"]["inputs"]
    assert (i["summary"], i["retention_analysis"], i["style_line"], i["overall_soundscape"],
            i["non_diegetic_music"], i["detailed_description"]) == ("S", "R", "L", "A", "M", "")


def test_builder_does_not_mutate_the_project():
    p = sample()
    before = copy.deepcopy(p)
    build(p, upto="s2", dry_run=True)
    assert p == before


# ---------------------------------------------------------------------------
# Projects and saved segments (Addenda A and B)
# ---------------------------------------------------------------------------

def test_long_shot_gets_the_project_slug_as_cache_name():
    ls = build(sample()).prompt["longshot"]["inputs"]
    assert ls["cache_name"] == "sample-project" and ls["save_to_disk"] is True
    p = sample()
    p["name"] = "Renamed later"          # renaming keeps the slug
    assert build(p).prompt["longshot"]["inputs"]["cache_name"] == "sample-project"
    del p["slug"]
    assert build(p).prompt["longshot"]["inputs"]["cache_name"] == "renamed-later"


def test_takes_are_always_saved_because_locked_shots_load_them():
    p = sample()
    p["settings"]["save_segments"] = False        # a Stage 1 setting, no longer used
    assert build(p).prompt["longshot"]["inputs"]["save_to_disk"] is True


def test_locks_frames_and_joins_reach_the_timeline_shots():
    p = sample()
    p["shots"][0].update(lock="s1__1722__0123abcd.safetensors", frames=124)
    p["shots"][1].update(frames=120, join="cut")          # 120 isn't 17k + 5: ignored
    g = build(p).prompt
    assert g["shot1"]["inputs"]["lock"] == "s1__1722__0123abcd.safetensors"
    assert g["shot1"]["inputs"]["frames"] == 124
    assert g["shot2"]["inputs"]["frames"] == 0 and g["shot2"]["inputs"]["join"] == "cut"
    p["shots"][2]["lock"] = "../../etc/passwd"
    with pytest.raises(gb.BuildError, match="isn't a take file"):
        build(p)


def test_references_and_audio_in_a_project_subfolder():
    p = sample()
    p["cast"][0].update(image="portrait.png", subfolder="longshot/sample-project")
    p["audio"].update(file="song (1).mp3", subfolder="longshot/sample-project",
                      lip_sync=True)
    g = build(p).prompt
    assert g["img1"]["inputs"]["image"] == "longshot/sample-project/portrait.png"
    assert g["img2"]["inputs"]["image"] == "outfit.png"
    assert g["audio_file"]["inputs"]["audio"] == "longshot/sample-project/song (1).mp3"


@pytest.mark.parametrize("sub,name", [("../secret", "a.png"), ("/etc", "a.png"),
                                      ("longshot", "../a.png"), ("C:\\x", "a.png")])
def test_bad_reference_paths_are_refused(sub, name):
    p = sample()
    p["cast"][0].update(image=name, subfolder=sub)
    with pytest.raises(gb.BuildError):
        build(p)



# ---------------------------------------------------------------------------
# RTX Video Super Resolution
# ---------------------------------------------------------------------------

def test_rtx_vsr_off_by_default_adds_nothing():
    assert "vsr" not in build(sample()).prompt


@pytest.mark.parametrize("final", [False, True])
def test_rtx_vsr_sits_between_decode_and_video_combine(final):
    p = sample()
    p["settings"]["rtx_vsr"] = {"on": True, "scale": 2.0, "quality": "ULTRA"}
    p["audio"]["final_override"] = final
    g = build(p).prompt
    check_wiring(g)
    assert g["vsr"] == {"class_type": "RTXVideoSuperResolution",
                        "_meta": {"title": "RTX Video Super Resolution"},
                        "inputs": {"images": ["decode", 0], "resize_type": "scale by multiplier",
                                   "resize_type.scale": 2.0, "quality": "ULTRA"}}
    assert g["combine"]["inputs"]["images"] == ["vsr", 0]
    assert g["combine"]["inputs"]["audio"] == (["audio", 0] if final else ["decode_audio", 0])


def test_rtx_vsr_does_not_touch_long_shot():
    off = build(sample()).prompt
    p = sample()
    p["settings"]["rtx_vsr"] = {"on": True, "scale": 3, "quality": "HIGH"}
    on = build(p).prompt
    assert on["longshot"] == off["longshot"], "segments stay reusable when toggling it"


@pytest.mark.parametrize("vsr,match", [({"on": True, "scale": 5}, "factor"),
                                       ({"on": True, "scale": 0.5}, "factor"),
                                       ({"on": True, "quality": "MAX"}, "quality")])
def test_rtx_vsr_bad_values(vsr, match):
    p = sample()
    p["settings"]["rtx_vsr"] = vsr
    with pytest.raises(gb.BuildError, match=match):
        build(p)


def test_rtx_vsr_needs_its_pack_only_when_on():
    p = sample()
    env = gb.Env(classes=set(gb.required_classes(p)))
    build(p, env=env)
    p["settings"]["rtx_vsr"] = {"on": True}
    with pytest.raises(gb.BuildError, match="RTX-VSR"):
        build(p, env=env)



def test_upscale_final_forces_rtx_and_names_the_file():
    p = sample()
    p["settings"]["rtx_vsr"] = {"on": False, "scale": 3, "quality": "HIGH"}
    preview = build(p).prompt
    final = build(p, final=True).prompt
    check_wiring(final)
    assert "vsr" not in preview
    assert final["vsr"]["inputs"]["resize_type.scale"] == 3 and final["vsr"]["inputs"]["quality"] == "HIGH"
    assert final["combine"]["inputs"]["images"] == ["vsr", 0]
    assert final["combine"]["inputs"]["filename_prefix"] == "longshot/sample-project/videos/Sample project_final"
    assert preview["combine"]["inputs"]["filename_prefix"] == "longshot/sample-project/videos/Sample project"
    assert final["longshot"] == preview["longshot"], "the final reuses every segment"


def test_upscale_final_needs_the_rtx_pack():
    p = sample()
    env = gb.Env(classes=set(gb.required_classes(p)))
    with pytest.raises(gb.BuildError, match="RTX-VSR"):
        build(p, final=True, env=env)


# ---------------------------------------------------------------------------
# Clip Shots
# ---------------------------------------------------------------------------

def with_clip(**clip):
    p = sample()
    c = {"file": "run.mp4", "subfolder": "longshot/sample-project", "trim_in": 1.5, "frames": 124,
         "audio": "clip", "has_audio": True}
    c.update(clip)
    p["shots"].insert(2, {"id": "c1", "kind": "clip", "status": "approved", "join": "bridge", "clip": c})
    return p


def test_a_clip_shot_builds_load_video_clip_and_clip_shot():
    b = build(with_clip())
    g = b.prompt
    load = g["clipload3"]["inputs"]
    assert load["video"] == "longshot/sample-project/run.mp4"
    assert (load["force_rate"], load["frame_load_cap"], load["skip_first_frames"]) == (24, 124, 36)
    clip = g["clip3"]["inputs"]
    assert clip["audio"] == ["clipload3", 2] and clip["audio_mode"] == "clip"
    assert clip["vae"] == ["vae_video", 0] and clip["audio_vae"] == ["vae_audio", 0]
    assert (clip["width"], clip["height"]) == (b.width, b.height)
    shot = g["shot3"]["inputs"]
    assert g["shot3"]["class_type"] == "MiniMaxH3ClipShot" and shot["shots"] == ["shot2", 0]
    assert g["shot4"]["inputs"]["shots"] == ["shot3", 0]
    assert {"MiniMaxH3LoadVideo", "MiniMaxH3Clip", "MiniMaxH3ClipShot"} <= set(gb.required_classes(with_clip()))
    check_wiring(g)


def test_a_silent_or_muted_clip_gets_no_audio_link():
    for clip in ({"has_audio": False}, {"audio": "mute"}):
        g = build(with_clip(**clip)).prompt
        assert g["clip3"]["inputs"]["audio_mode"] == "mute" and "audio" not in g["clip3"]["inputs"]


@pytest.mark.parametrize("clip,msg", [({"file": ""}, "no video file"), ({"frames": 120}, "valid length"),
                                      ({"file": "../x.mp4"}, "bad file name")])
def test_bad_clips_are_build_errors(clip, msg):
    with pytest.raises(gb.BuildError, match=msg):
        build(with_clip(**clip))


def test_original_clip_pixels_only_on_the_final_video():
    p = with_clip()
    p["settings"]["clip_pixels"] = True
    assert "clip_pixels" not in build(p).prompt
    g = build(p, final=True).prompt
    assert g["clip_pixels"]["inputs"] == {"images": ["decode", 0], "latent": ["longshot", 0],
                                          "enabled": True}


def test_clips_load_scaled_to_cover_the_film():
    wide = build(with_clip(width=3840, height=1080))          # wider than 16:9: fit the height
    load = wide.prompt["clipload3"]["inputs"]
    assert load["height"] == wide.height + 8 and load["width"] == round((wide.height + 8) * 3840 / 1080)
    tall = build(with_clip(width=1080, height=1920)).prompt["clipload3"]["inputs"]
    assert tall["width"] > 0 and tall["height"] == round(tall["width"] * 1920 / 1080)
    unknown = build(with_clip()).prompt["clipload3"]["inputs"]
    assert (unknown["width"], unknown["height"]) == (0, 0)          # Load Video reads the clip's own size


# ---------------------------------------------------------------------------
# Round 4: ProRes master next to the upscaled final
# ---------------------------------------------------------------------------

def test_prores_master_only_on_the_final_and_only_when_asked():
    p = sample()
    assert "combine_prores" not in build(p, final=True).prompt
    p["settings"]["prores_master"] = True
    assert "combine_prores" not in build(p).prompt          # previews never write a master
    b = build(p, final=True)
    final = b.prompt
    check_wiring(final)
    m, c = final["combine_prores"]["inputs"], final["combine"]["inputs"]
    assert m["codec"] == "prores_hq" and final["combine_prores"]["class_type"] == "MiniMaxH3SaveVideo"
    assert m["images"] == c["images"] == ["vsr", 0]          # the same upscaled frames
    assert m["audio"] == c["audio"]                          # and the same sound
    assert m["frame_rate"] == 24
    assert m["filename_prefix"] == "longshot/sample-project/videos/Sample project_final_master"
    assert b.nodes["prores"] == "combine_prores"
    assert final["longshot"] == build(p).prompt["longshot"], "the master reuses every segment"


def test_prores_master_carries_the_song_when_it_replaces_the_audio():
    p = sample()
    p["settings"]["prores_master"] = True
    p["audio"].update(file="song.mp3", final_override=True)
    final = build(p, final=True).prompt
    assert final["combine_prores"]["inputs"]["audio"] == ["audio", 0]


def test_standalone_render_sends_a_one_shot_timeline():
    p = sample()
    b = build(p, upto="s3", standalone=True)
    shots = of_class(b.prompt, "MiniMaxH3TimelineShot")
    assert b.chain == ["s3"] and len(shots) == 1
    s = shots["shot1"]["inputs"]
    assert s["shot_id"] == "s3" and "shots" not in s and s["lock"] == ""
    assert s["text"] == p["shots"][2]["text"]
    check_wiring(b.prompt)
    # the same project and cache, so the take lands with the others
    assert b.prompt["longshot"]["inputs"]["cache_name"] == build(p).prompt["longshot"]["inputs"]["cache_name"]


def test_a_standalone_take_is_sent_as_a_lock_in_later_chains():
    p = sample()
    p["shots"][2].update(lock="s3__99__0123abcd.safetensors", standalone=True)
    shots = build(p, upto="s4").prompt
    assert shots["shot3"]["inputs"]["lock"] == "s3__99__0123abcd.safetensors"
    assert shots["shot3"]["inputs"]["shots"] == ["shot2", 0]


def test_standalone_needs_a_generated_shot():
    p = sample()
    with pytest.raises(gb.BuildError, match="needs the Shot"):
        build(p, standalone=True)
    p["shots"][2].update(kind="clip", clip={"file": "x.mp4", "frames": 22})
    with pytest.raises(gb.BuildError, match="clip"):
        build(p, upto="s3", standalone=True)


def test_more_than_16_shots_build():
    p = sample()
    shot = next(s for s in p["shots"] if s.get("kind") != "clip")
    p["shots"] = [dict(copy.deepcopy(shot), id=f"s{i}", text=f"Beat {i}.", seconds=2)
                  for i in range(1, 31)]
    b = build(p)
    check_wiring(b.prompt)
    assert len(b.chain) == 30
    p["shots"] = [dict(copy.deepcopy(shot), id=f"s{i}", seconds=1) for i in range(1, 201)]
    assert len(build(p).chain) == 200                                  # 256 since Long Shot 1.6.10
    p["shots"] = [dict(copy.deepcopy(shot), id=f"s{i}", seconds=1) for i in range(1, 258)]
    with pytest.raises(gb.BuildError, match="at most 256"):
        build(p)


def test_a_chunk_upscales_a_range_straight_to_a_file():
    p = sample()
    p["settings"]["prores_master"] = True
    b = build(p, final=True, chunk={"index": 2, "start": 480, "length": 240, "audio": True})
    pr = b.prompt
    check_wiring(pr)
    up = pr["upscale_chunk"]
    assert up["class_type"] == "MiniMaxH3UpscaleChunk"
    assert up["inputs"]["images"] == ["decode", 0]
    assert up["inputs"]["start"] == 480 and up["inputs"]["length"] == 240
    assert up["inputs"]["filename_prefix"].endswith("/videos/_chunks/" + gb.safe_name(p.get("name")) + "_final_c002")
    assert up["inputs"]["master_prefix"] == up["inputs"]["filename_prefix"] + "_master"
    assert up["inputs"]["codec"] in ("h264_nvenc", "libx264") and up["inputs"]["scale"] == 2
    # no RTX node and no Video Combine in the graph: nothing big is cached
    assert not of_class(pr, "RTXVideoSuperResolution") and not of_class(pr, "MiniMaxH3SaveVideo")
    sa = pr["save_audio"]
    # the sound of the run this chunk opens (0.8.5: one WAV per decode run)
    assert sa["class_type"] == "MiniMaxH3SaveAudio" and sa["inputs"]["filename_prefix"].endswith(
        "/_chunks/" + gb.safe_name(p.get("name")) + "_audio_c002")
    first = build(sample(), final=True, chunk={"index": 0, "start": 0, "length": 240, "audio": True}).prompt
    assert first["save_audio"]["inputs"]["filename_prefix"].endswith("_audio")
    assert b.nodes["chunk"] == "upscale_chunk" and b.nodes["audio_file"] == "save_audio"
    assert b.nodes["prores"] == "combine_prores"
    assert b.filename_prefix.endswith("/videos/" + gb.safe_name(p.get("name")) + "_final")   # the joined name
    # the rest of the graph is the plain final's, so the decode is reused between chunks
    plain = build(sample(), final=True).prompt
    for nid in ("longshot", "decode"):
        assert pr[nid] == plain[nid]
    later = build(sample(), final=True, chunk={"index": 3, "start": 720, "length": 240}).prompt
    check_wiring(later)
    assert "save_audio" not in later and "decode_audio" not in later
    # a preview that doesn't upscale: a piece of a film decoded run by run, encoded at scale 1
    q = sample()
    q["settings"].setdefault("rtx_vsr", {})["on"] = False
    piece = build(q, chunk={"index": 1, "start": 22, "length": 10_000_000, "audio": True})
    check_wiring(piece.prompt)
    assert piece.prompt["upscale_chunk"]["inputs"]["scale"] == 1.0
    assert piece.prompt["upscale_chunk"]["inputs"]["start"] == 22
    assert not of_class(piece.prompt, "RTXVideoSuperResolution")


def test_bad_chunks_are_build_errors():
    for bad in ({"start": -1, "length": 10}, {"start": 0, "length": 0}, {"start": "x"}):
        with pytest.raises(gb.BuildError):
            build(sample(), final=True, chunk=bad)
    with pytest.raises(gb.BuildError):
        build(sample(), dry_run=True, chunk={"start": 0, "length": 10})


def test_export_approved_clips_upscaled():
    p = sample()
    p["settings"]["prores_master"] = True
    b = gb.build_clip_export(p, [{"take": "s1__1722__fc96d2a8.safetensors"}, {"take": "s3__9__aa5f3e3d.safetensors"}])
    pr = b.prompt
    check_wiring(pr)
    assert b.nodes["export"] == {"1": {"video": "up1", "audio": "wav1"}, "2": {"video": "up2", "audio": "wav2"}}
    up = pr["up2"]["inputs"]
    assert pr["take2"]["inputs"]["take"] == "s3__9__aa5f3e3d.safetensors"
    assert up["images"] == ["dec2", 0] and up["start"] == 0 and up["length"] >= 10_000_000
    assert up["filename_prefix"].endswith("/Approved_Clips/_work/c002")
    assert up["master_prefix"] == up["filename_prefix"] + "_master"
    assert pr["wav2"]["inputs"]["audio"] == ["aud2", 0]
    assert not of_class(pr, "MiniMaxH3SaveVideo") and not of_class(pr, "RTXVideoSuperResolution")
    with pytest.raises(gb.BuildError):
        gb.build_clip_export(sample(), [{"take": "../evil"}])
    with pytest.raises(gb.BuildError):
        gb.build_clip_export(sample(), [])


def test_frame_anchors_reach_the_shots_beside_them():
    p = sample()
    gen = [s for s in p["shots"] if s.get("kind") != "clip" and not s.get("bypassed")]
    for s in p["shots"]:
        s.pop("lock", None); s.pop("take", None)
    a, b = gen[0], gen[1]
    b["anchor_in"] = {"file": "join.png", "subfolder": ""}          # end of a, start of b
    p["anchor_end"] = {"file": "last.png", "subfolder": ""}
    pr = build(p).prompt
    check_wiring(pr)
    shots = {v["inputs"]["shot_id"]: v["inputs"] for v in pr.values() if v["class_type"] == "MiniMaxH3TimelineShot"}
    k = len(gb.active_cast(p))
    sa, sb = shots[a["id"]], shots[b["id"]]
    assert pr[sa["end_image"][0]]["inputs"]["image"] == "join.png" and "start_image" not in sa
    assert pr[sb["start_image"][0]]["inputs"]["image"] == "join.png"
    assert sa["text"].endswith(f"The shot ends on <Picture {k + 1}>.")
    assert sb["text"].startswith(f"The shot begins from <Picture {k + 1}>.")
    last = [s for s in gen][-1]
    sl = shots[last["id"]]
    assert pr[sl["end_image"][0]]["inputs"]["image"] == "last.png"
    # a locked (rendered) Shot loads its take: no anchors sent for it
    a["lock"] = "s1__1722__fc96d2a8.safetensors"
    pr2 = build(p).prompt
    s2 = {v["inputs"]["shot_id"]: v["inputs"] for v in pr2.values() if v["class_type"] == "MiniMaxH3TimelineShot"}
    assert "end_image" not in s2[a["id"]] and "The shot ends on" not in s2[a["id"]]["text"]


def test_context_shot_is_a_cut_with_the_frame_before_as_a_picture():
    p = sample()
    gen = [s for s in p["shots"] if s.get("kind") != "clip" and not s.get("bypassed")]
    for s in p["shots"]:
        s.pop("lock", None); s.pop("take", None)
    b = gen[1]
    b["join"] = "context"
    b["anchor_in"] = {"file": "join.png", "subfolder": ""}
    b["context_image"] = {"file": "s1__5__aa_last.png", "subfolder": "longshot/x/context"}
    pr = build(p).prompt
    check_wiring(pr)
    shots = {v["inputs"]["shot_id"]: v["inputs"] for v in pr.values() if v["class_type"] == "MiniMaxH3TimelineShot"}
    sb = shots[b["id"]]
    k = len(gb.active_cast(p))
    assert sb["join"] == "cut"
    assert pr[sb["context_image"][0]]["inputs"]["image"] == "longshot/x/context/s1__5__aa_last.png"
    assert sb["text"].startswith(f"<Picture {k + 2}> is a reference for the characters, objects and "
                                 "surroundings only."), "after the start anchor"
    assert "continuity" not in sb["text"] and "last frame" not in sb["text"]
    assert f"does not begin from <Picture {k + 2}>" in sb["text"]
    assert f"The shot begins from <Picture {k + 1}>." in sb["text"]
    # its own retention line: weak_reference (Long Shot 1.6.9)
    assert sb["retention"].startswith(f"<Picture {k + 2}> (reference for [Shot 1]): weak_reference - ")
    others = [v for sid, v in shots.items() if sid != b["id"]]
    assert all("retention" not in v for v in others)
    # an older Long Shot without the input: no retention line, the wording still applies
    old_env = gb.Env(shot_inputs={"start_image", "end_image", "context_image"})
    sb_old = {v["inputs"]["shot_id"]: v["inputs"] for v in build(p, env=old_env).prompt.values()
              if v["class_type"] == "MiniMaxH3TimelineShot"}[b["id"]]
    assert "retention" not in sb_old and "does not begin from" in sb_old["text"]
    # a Continuous Shot never takes it, even if one is sent
    b["join"] = "bridge"
    sb2 = {v["inputs"]["shot_id"]: v["inputs"] for v in build(p).prompt.values()
           if v["class_type"] == "MiniMaxH3TimelineShot"}[b["id"]]
    assert "context_image" not in sb2 and sb2["join"] == "bridge"


def _voices(p, n=2):
    cast = gb.active_cast(p)
    p["voices"] = [{"id": f"v{i + 1}", "label": f"<voice {i + 1}>", "file": f"voice{i + 1}.wav",
                    "subfolder": "longshot/x", "start": 1.5 * i, "length": 4, "bypassed": False}
                   for i in range(n)]
    cast[0]["voice"] = "v1"
    if len(cast) > 1:
        cast[1]["voice"] = "v2"
    return cast


def test_voice_references_are_audio_after_the_songs_vocals():
    p = sample()
    p["audio"].update(lip_sync=False, voice_ref=False, final_override=False)
    cast = _voices(p)
    b = build(p)
    pr = b.prompt
    check_wiring(pr)
    ls = pr["longshot"]["inputs"]
    loaders = {k: pr[ls[k][0]]["inputs"] for k in ls if k.startswith("ref_audios.")}
    assert sorted(loaders) == ["ref_audios.ref_audio_0", "ref_audios.ref_audio_1"]
    assert pr[loaders["ref_audios.ref_audio_0"]["audio"][0]]["inputs"]["audio"] == "longshot/x/voice1.wav"
    assert loaders["ref_audios.ref_audio_1"]["start_index"] == 1.5 and loaders["ref_audios.ref_audio_1"]["duration"] == 4
    subj = [v["inputs"] for v in pr.values() if v["class_type"] == "MiniMaxH3Subject"]
    assert subj[0]["role_2"] == "voice timbre" and subj[0]["reference_2"] == "<Audio 1>"
    assert subj[1]["reference_2"] == "<Audio 2>"
    assert all(x["role_2"] == "-" for x in subj[2:])
    ret = pr["builder"]["inputs"]["retention_analysis"]
    assert f"<Audio 1> (voice timbre of {cast[0]['label']}): reference - " in ret
    assert ret.startswith(p["style"]["retention"].strip())
    assert {"LoadAudio", "TrimAudioDuration"} <= set(gb.required_classes(p))
    # the song's vocals come first when Voice reference is on
    p["audio"].update(voice_ref=True, file="song.mp3")
    pr = build(p).prompt
    subj = [v["inputs"] for v in pr.values() if v["class_type"] == "MiniMaxH3Subject"]
    assert subj[0]["reference_2"] == "<Audio 2>" and subj[1]["reference_2"] == "<Audio 3>"
    trim = pr[pr["longshot"]["inputs"]["ref_audios.ref_audio_2"][0]]["inputs"]
    assert pr[trim["audio"][0]]["inputs"]["audio"] == "longshot/x/voice2.wav"


def test_bypassed_voice_drops_its_link_and_the_limit_is_three():
    p = sample()
    p["audio"].update(lip_sync=False, voice_ref=False, final_override=False)
    _voices(p)
    p["voices"][0]["bypassed"] = True
    pr = build(p).prompt
    subj = [v["inputs"] for v in pr.values() if v["class_type"] == "MiniMaxH3Subject"]
    assert subj[0]["role_2"] == "-" and subj[1]["reference_2"] == "<Audio 1>"
    p["voices"][0]["bypassed"] = False
    p["audio"].update(voice_ref=True, file="song.mp3")
    p["voices"].append({"id": "v3", "label": "x", "file": "v3.wav", "subfolder": ""})
    with pytest.raises(gb.BuildError, match="at most 3 reference audios"):
        build(p)


def test_turbo_falls_back_to_the_stock_lora_loader_without_its_pack():
    env = gb.Env(classes=(set(gb.required_classes(sample())) - {"MiniMaxH3TurboLoRA"}) | {"LoraLoaderModelOnly"})
    b = build(sample(), env=env)
    check_wiring(b.prompt)
    t = b.prompt["turbo"]
    assert t["class_type"] == "LoraLoaderModelOnly" and t["inputs"]["strength_model"] == 1.0
    assert any("stock loader" in w for w in b.warnings)


def test_refmod_cards_load_through_load_h3_refmods_and_are_subjects():
    p = sample()
    p["audio"].update(lip_sync=False, voice_ref=False, final_override=False)
    n = len(gb.active_cast(p))
    p["refmods"] = [{"id": "m1", "name": "luma_v2", "kind": "image", "label": "<Luma>", "desc": "the plush", "strength": 0.8},
                    {"id": "m2", "name": "narrator", "kind": "audio", "label": "<Narr>", "desc": "", "strength": 1},
                    {"id": "m3", "name": "off", "kind": "image", "label": "<Off>", "bypassed": True}]
    b = build(p)
    pr = b.prompt
    check_wiring(pr)
    ld = pr["refmods"]["inputs"]
    assert pr["refmods"]["class_type"] == "MiniMaxH3RefModsLoader"
    assert (ld["mod_1"], ld["strength_1"], ld["mod_2"], ld["mod_3"]) == ("luma_v2", 0.8, "narrator", "(none)")
    assert pr["longshot"]["inputs"]["refmods"] == ["refmods", 0]
    assert gb.refmod_labels(p) == [f"<Picture {n + 1}>", "<Audio 1>"]
    subs = [v["inputs"] for v in pr.values() if v["class_type"] == "MiniMaxH3Subject"]
    assert {"label": "<Luma>", "reference": f"<Picture {n + 1}>", "role": "appearance"}.items() <= subs[-2].items()
    assert subs[-1]["role"] == "voice timbre" and subs[-1]["reference"] == "<Audio 1>"
    assert "MiniMaxH3RefModsLoader" in gb.required_classes(p)
