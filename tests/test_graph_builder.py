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

EXAMPLE = os.path.join(PKG_DIR, "examples", "mara_spaceport_chase.json")


def mara():
    with open(EXAMPLE, encoding="utf-8") as fh:
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
    dangling = set(prompt) - used - {"combine"}
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
# The user's own project reproduces the user's own workflow
# ---------------------------------------------------------------------------

def test_mara_matches_the_users_api_export():
    b = build(mara())
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

    # 7 references, in order, each resized exactly as the user's subgraphs do
    for k in range(7):
        r = p[ls[f"ref_images.ref_image_{k}"][0]]
        assert r["class_type"] == "ImageResizeKJv2"
        assert {x: r["inputs"][x] for x in r["inputs"] if x != "image"} == dict(
            width=1500, height=1500, upscale_method="nearest-exact", keep_proportion="resize",
            pad_color="0, 0, 0", crop_position="center", divisible_by=2, device="cpu")
    assert p[p[ls["ref_images.ref_image_0"][0]]["inputs"]["image"][0]]["inputs"]["image"] \
        == "Actress_Headshots_8_Options 06 (1).png"
    assert "ref_images.ref_image_7" not in ls

    # subject chain: <Mara> first, cited as <Picture 1>; the builder gets the last
    subs = of_class(p, "MiniMaxH3Subject")
    assert len(subs) == 7
    assert p["subject1"]["inputs"]["label"] == "<Mara>"
    assert p["subject1"]["inputs"]["reference"] == "<Picture 1>"
    assert "subjects" not in p["subject1"]["inputs"]
    assert p["subject7"]["inputs"]["reference"] == "<Picture 7>"
    assert p["subject7"]["inputs"]["subjects"] == ["subject6", 0]
    assert p["builder"]["inputs"]["subjects"] == ["subject7", 0]
    assert p["builder"]["inputs"]["subject_definitions"] == ""
    assert p["builder"]["inputs"]["task_type"] == "reference generation"

    # Shots: all six, chained, seeds as saved (Shot 3 carries the user's 0)
    shots = of_class(p, "MiniMaxH3Shot")
    assert len(shots) == 6
    assert [p[f"shot{n}"]["inputs"]["seconds"] for n in range(1, 7)] == [5, 5, 5, 5, 9, 6]
    assert [p[f"shot{n}"]["inputs"]["shot_seed"] for n in range(1, 7)] == [-1, -1, 0, -1, -1, -1]
    assert all(s["inputs"]["cut_verb"] == "the camera cuts to" for s in shots.values())
    assert p["builder"]["inputs"]["shots"] == ["shot6", 0]

    c = p["combine"]["inputs"]
    assert c["filename_prefix"] == "longshot/Mara — spaceport chase"
    assert c["format"] == "video/nvenc_h264-mp4" and c["frame_rate"] == 24
    assert c["audio"] == ["decode_audio", 0] and c["images"] == ["decode", 0]
    assert (c["pix_fmt"], c["bitrate"], c["megabit"], c["save_metadata"], c["pingpong"],
            c["save_output"], c["loop_count"]) == ("yuv420p", 8, True, True, False, True, 0)
    # no CLIPVisionEncode, no ResolutionSelector, no rgthree switch, no Seed Everywhere
    classes = {n["class_type"] for n in p.values()}
    assert not classes & {"CLIPVisionEncode", "ResolutionSelector", "Any Switch (rgthree)",
                          "Seed Everywhere", "SetImageSize"}
    assert b.chain == ["s1", "s2", "s3", "s4", "s5", "s6"]


def test_prompt_is_json_serialisable():
    json.dumps(build(mara()).prompt)


# ---------------------------------------------------------------------------
# Chains: Start / Continue / Reroll
# ---------------------------------------------------------------------------

def test_start_renders_shot_1_only():
    b = build(mara(), upto="s1")
    assert b.chain == ["s1"]
    assert len(of_class(b.prompt, "MiniMaxH3Shot")) == 1
    assert b.prompt["builder"]["inputs"]["shots"] == ["shot1", 0]
    check_wiring(b.prompt)


@pytest.mark.parametrize("upto,n", [("s2", 2), ("s4", 4), ("s6", 6)])
def test_continue_queues_the_chain_up_to_the_target(upto, n):
    b = build(mara(), upto=upto)
    assert len(of_class(b.prompt, "MiniMaxH3Shot")) == n
    assert b.prompt["builder"]["inputs"]["shots"] == [f"shot{n}", 0]


def test_reroll_changes_only_that_shots_seed():
    a = mara()
    before = build(a, upto="s3").prompt
    a["shots"][2]["shot_seed"] = 4_000_000_000
    after = build(a, upto="s3").prompt
    diff = [k for k in before if before[k] != after[k]]
    assert diff == ["shot3"]
    assert after["shot3"]["inputs"]["shot_seed"] == 4_000_000_000


def test_unknown_or_bypassed_target_is_an_error():
    p = mara()
    p["shots"][1]["bypassed"] = True
    with pytest.raises(gb.BuildError):
        build(p, upto="s2")
    with pytest.raises(gb.BuildError):
        build(p, upto="nope")


def test_dry_run_is_the_same_graph_with_dry_run_on():
    real, dry = build(mara(), upto="s3").prompt, build(mara(), upto="s3", dry_run=True).prompt
    assert set(real) == set(dry)
    assert dry["longshot"]["inputs"]["dry_run"] is True
    dry["longshot"]["inputs"]["dry_run"] = False
    assert real == dry


# ---------------------------------------------------------------------------
# Bypass / remove / renumber
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("off", [set(), {0}, {1}, {6}, {0, 3}, {1, 2, 4, 5}])
def test_bypassed_cast_renumbers_pictures(off):
    p = mara()
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
    p = mara()
    p["cast"] = []
    b = build(p)
    check_wiring(b.prompt)
    classes = {n["class_type"] for n in b.prompt.values()}
    assert not classes & {"LoadImage", "ImageResizeKJv2", "MiniMaxH3Subject"}
    assert "subjects" not in b.prompt["builder"]["inputs"]


def test_all_cast_bypassed_is_the_same_as_none():
    p = mara()
    for c in p["cast"]:
        c["bypassed"] = True
    q = mara()
    q["cast"] = []
    assert build(p).prompt == build(q).prompt


@pytest.mark.parametrize("off", [{0}, {2}, {5}, {1, 3}])
def test_bypassed_shots_are_left_out_and_renumber(off):
    p = mara()
    for i in off:
        p["shots"][i]["bypassed"] = True
    b = build(p)
    live = [s for i, s in enumerate(p["shots"]) if i not in off]
    assert b.chain == [s["id"] for s in live]
    shots = of_class(b.prompt, "MiniMaxH3Shot")
    assert len(shots) == len(live)
    for n, s in enumerate(live, 1):
        assert b.prompt[f"shot{n}"]["inputs"]["text"] == s["text"]
        assert b.prompt[f"shot{n}"]["inputs"]["seconds"] == s["seconds"]
        assert ("shots" in b.prompt[f"shot{n}"]["inputs"]) == (n > 1)


def test_all_shots_bypassed_is_an_error():
    p = mara()
    for s in p["shots"]:
        s["bypassed"] = True
    with pytest.raises(gb.BuildError, match="No active Shots"):
        build(p)


def test_reference_without_image_names_its_label():
    p = mara()
    p["cast"][1]["image"] = None
    with pytest.raises(gb.BuildError, match=r"<outfit> \(<Picture 2>\)"):
        build(p)
    p["cast"][1]["bypassed"] = True
    build(p)


def test_too_many_references():
    p = mara()
    p["cast"] = [dict(p["cast"][0], id=f"x{i}") for i in range(10)]
    with pytest.raises(gb.BuildError, match="at most 9"):
        build(p)


# ---------------------------------------------------------------------------
# Models: Turbo, LoRAs, Sage
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("turbo", [True, False])
@pytest.mark.parametrize("on", list(itertools.product([False, True], repeat=3)))
def test_turbo_and_lora_combinations(turbo, on):
    p = mara()
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
    p = mara()
    p["settings"]["turbo"]["on"] = False
    assert any("Turbo is off" in w for w in build(p).warnings)
    p["settings"]["steps"] = 20
    assert not any("Turbo is off" in w for w in build(p).warnings)


def test_turbo_strength_and_low_vram():
    p = mara()
    p["settings"]["turbo"]["strength"] = 0.75
    t = build(p).prompt["turbo"]["inputs"]
    assert t["strength"] == 0.75 and t["low_vram"] is False


def test_lora_on_without_a_file_is_an_error():
    p = mara()
    p["settings"]["loras"][1] = {"on": True, "name": None, "strength": 1}
    with pytest.raises(gb.BuildError, match="LoRA 2"):
        build(p)


def test_lora_off_without_a_file_is_fine():
    p = mara()
    p["settings"]["loras"][1] = {"on": False, "name": None, "strength": 1}
    build(p)


def test_sage_is_skipped_when_kjnodes_lacks_it():
    env = gb.Env(classes=set(gb.required_classes(mara())) - {"PathchSageAttentionKJ"})
    b = build(mara(), env=env)
    assert "sage" not in b.prompt
    assert model_chain(b.prompt)[:2] == ["UNETLoader", "MiniMaxH3SigmaShift"]
    assert any("SageAttention" in w for w in b.warnings)
    check_wiring(b.prompt)


@pytest.mark.parametrize("mode", ["disabled", "off", None, ""])
def test_sage_can_be_turned_off(mode):
    p = mara()
    p["settings"]["sage_attention"] = mode
    assert "sage" not in build(p).prompt


def test_model_settings_flow_through():
    p = mara()
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
    assert b["resize1"]["inputs"]["width"] == 1024 == b["resize1"]["inputs"]["height"]
    assert (b["shift"]["inputs"]["shift_video"], b["shift"]["inputs"]["shift_audio"]) == (8.5, 2)


@pytest.mark.parametrize("field,value,match", [
    ("overlap", 20, "17k"), ("seed", -1, "fixed"), ("seed_mode", "random", "Seed mode"),
    ("ref_image_size", "big", "Reference image size"), ("aspect", "5:4", "aspect"),
    ("steps", 0, "Steps"), ("model", "", "model"), ("megapixels", 0, "MP")])
def test_bad_settings_are_reported(field, value, match):
    p = mara()
    p["settings"][field] = value
    with pytest.raises(gb.BuildError, match=match):
        build(p)


@pytest.mark.parametrize("seed,ok", [(-1, True), (0, True), (2**32 - 1, True),
                                     (2**64 - 1, True), (2**64, False), (-2, False),
                                     ("", True), (None, True), ("abc", False)])
def test_shot_seed_range(seed, ok):
    p = mara()
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

AUDIO_CLASSES = {"VHS_LoadAudioUpload", "MiniMaxH3SongTrack", "MelBandRoFormerModelLoader",
                 "MelBandRoFormerSampler"}


@pytest.mark.parametrize("lip,voice,final", list(itertools.product([False, True], repeat=3)))
def test_audio_route_combinations(lip, voice, final):
    p = mara()
    p["audio"].update(lip_sync=lip, voice_ref=voice, final_override=final)
    b = build(p)
    g = b.prompt
    check_wiring(g)
    ls = g["longshot"]["inputs"]
    classes = {n["class_type"] for n in g.values()}
    if not (lip or voice or final):
        assert not classes & AUDIO_CLASSES, "all routes off: no audio nodes at all"
    else:
        loader = g["audio"]["inputs"]
        assert loader == {"audio": "Is it a Dream_.mp3", "start_time": 15.0, "duration": 15.1}
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
    p = mara()
    p["audio"].update(file=None, lip_sync=True)
    with pytest.raises(gb.BuildError, match="audio file"):
        build(p)


def test_audio_file_with_routes_off_adds_nothing():
    p = mara()
    p["audio"].update(lip_sync=False, voice_ref=False, final_override=False)
    assert "audio" not in build(p).prompt


def test_melband_model_is_selectable():
    p = mara()
    p["audio"].update(voice_ref=True, melband_model="MelBand\\other.safetensors")
    assert build(p).prompt["melband"]["inputs"]["model_name"] == "MelBand\\other.safetensors"


def test_short_song_warns():
    p = mara()
    p["audio"].update(lip_sync=True, length=10)
    assert any("song clip" in w for w in build(p, upto="s3").warnings)
    assert not any("song clip" in w for w in build(p, upto="s2").warnings)


# ---------------------------------------------------------------------------
# Environment: missing nodes, nvenc fallback
# ---------------------------------------------------------------------------

def test_missing_node_classes_are_named_with_their_pack():
    env = gb.Env(classes=set(gb.required_classes(mara())) - {"VHS_VideoCombine",
                                                              "MiniMaxH3LongShot"})
    with pytest.raises(gb.BuildError) as err:
        build(mara(), env=env)
    msg = str(err.value)
    assert "VHS_VideoCombine — from ComfyUI-VideoHelperSuite" in msg
    assert "MiniMaxH3LongShot — from H3 Long Shot" in msg


def test_turbo_node_only_required_when_turbo_is_on():
    p = mara()
    env = gb.Env(classes=set(gb.required_classes(p)) - {"MiniMaxH3TurboLoRA"})
    with pytest.raises(gb.BuildError, match="MiniMaxH3TurboLoRA"):
        build(p, env=env)
    p["settings"]["turbo"]["on"] = False
    build(p, env=env)


def test_melband_only_required_for_voice_reference():
    p = mara()
    env = gb.Env(classes=set(gb.required_classes(p)) | {"VHS_LoadAudioUpload",
                                                         "MiniMaxH3SongTrack"})
    p["audio"].update(lip_sync=True, final_override=True)
    build(p, env=env)
    p["audio"]["voice_ref"] = True
    with pytest.raises(gb.BuildError, match="MelBandRoFormer"):
        build(p, env=env)


@pytest.mark.parametrize("formats,want", [
    (None, gb.NVENC), (["video/nvenc_h264-mp4", "video/h264-mp4"], gb.NVENC),
    (["video/h264-mp4", "video/webm"], gb.H264)])
def test_nvenc_falls_back_to_h264(formats, want):
    b = build(mara(), env=gb.Env(video_formats=formats))
    c = b.prompt["combine"]["inputs"]
    assert c["format"] == want == b.video_format
    if want == gb.H264:
        assert c["crf"] == 19 and "bitrate" not in c
    else:
        assert (c["bitrate"], c["megabit"]) == (8, True) and "crf" not in c
    assert any("NVENC" in w for w in b.warnings) == (want == gb.H264)


def test_no_mp4_format_is_an_error():
    with pytest.raises(gb.BuildError):
        build(mara(), env=gb.Env(video_formats=["video/webm"]))


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
    p = mara()
    p["settings"].update(megapixels=0.98, aspect="16:9")
    b = build(p)
    ls = b.prompt["longshot"]["inputs"]
    assert (ls["width"], ls["height"]) == (b.width, b.height) == (1344, 768)


@pytest.mark.parametrize("name,want", [
    ("Mara — spaceport chase", "Mara — spaceport chase"),
    ("../../etc/passwd", "_etc_passwd"), ('a:b*c?"d<e>f|g', "a_b_c_d_e_f_g"),
    ("  ..hidden  ", "hidden"), ("", "untitled"), (None, "untitled"),
    ("C:\\Windows\\x", "C_Windows_x")])
def test_safe_name(name, want):
    assert gb.safe_name(name) == want


def test_output_prefix_stays_in_the_longshot_folder():
    p = mara()
    p["name"] = "../../escape/me"
    prefix = build(p).prompt["combine"]["inputs"]["filename_prefix"]
    assert prefix == "longshot/_escape_me"
    assert prefix.count("/") == 1


def test_task_types_map_to_the_three_slots():
    p = mara()
    p["style"]["task_types"] = ["reference generation", "audio reference"]
    i = build(p).prompt["builder"]["inputs"]
    assert (i["task_type"], i["task_type_2"], i["task_type_3"]) == \
        ("reference generation", "audio reference", "-")
    p["style"]["task_types"] = []
    i = build(p).prompt["builder"]["inputs"]
    assert (i["task_type"], i["task_type_2"], i["task_type_3"]) == \
        ("reference generation", "-", "-")


def test_style_fields_reach_the_builder():
    p = mara()
    p["style"].update(summary="S", retention="R", style_line="L", soundscape="A", music="M")
    i = build(p).prompt["builder"]["inputs"]
    assert (i["summary"], i["retention_analysis"], i["style_line"], i["overall_soundscape"],
            i["non_diegetic_music"], i["detailed_description"]) == ("S", "R", "L", "A", "M", "")


def test_builder_does_not_mutate_the_project():
    p = mara()
    before = copy.deepcopy(p)
    build(p, upto="s2", dry_run=True)
    assert p == before


# ---------------------------------------------------------------------------
# Projects and saved segments (Addenda A and B)
# ---------------------------------------------------------------------------

def test_long_shot_gets_the_project_slug_as_cache_name():
    ls = build(mara()).prompt["longshot"]["inputs"]
    assert ls["cache_name"] == "mara-spaceport-chase" and ls["save_to_disk"] is True
    p = mara()
    p["name"] = "Renamed later"          # renaming keeps the slug
    assert build(p).prompt["longshot"]["inputs"]["cache_name"] == "mara-spaceport-chase"
    del p["slug"]
    assert build(p).prompt["longshot"]["inputs"]["cache_name"] == "renamed-later"


def test_saving_segments_can_be_turned_off():
    p = mara()
    p["settings"]["save_segments"] = False
    assert build(p).prompt["longshot"]["inputs"]["save_to_disk"] is False


def test_references_and_audio_in_a_project_subfolder():
    p = mara()
    p["cast"][0].update(image="actress.png", subfolder="longshot/mara-spaceport-chase")
    p["audio"].update(file="song (1).mp3", subfolder="longshot/mara-spaceport-chase",
                      lip_sync=True)
    g = build(p).prompt
    assert g["img1"]["inputs"]["image"] == "longshot/mara-spaceport-chase/actress.png"
    assert g["img2"]["inputs"]["image"] == "Ten futuristic outfits in a clean catalo 01g.png"
    assert g["audio"]["inputs"]["audio"] == "longshot/mara-spaceport-chase/song (1).mp3"


@pytest.mark.parametrize("sub,name", [("../secret", "a.png"), ("/etc", "a.png"),
                                      ("longshot", "../a.png"), ("C:\\x", "a.png")])
def test_bad_reference_paths_are_refused(sub, name):
    p = mara()
    p["cast"][0].update(image=name, subfolder=sub)
    with pytest.raises(gb.BuildError):
        build(p)



# ---------------------------------------------------------------------------
# RTX Video Super Resolution
# ---------------------------------------------------------------------------

def test_rtx_vsr_off_by_default_adds_nothing():
    assert "vsr" not in build(mara()).prompt


@pytest.mark.parametrize("final", [False, True])
def test_rtx_vsr_sits_between_decode_and_video_combine(final):
    p = mara()
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
    off = build(mara()).prompt
    p = mara()
    p["settings"]["rtx_vsr"] = {"on": True, "scale": 3, "quality": "HIGH"}
    on = build(p).prompt
    assert on["longshot"] == off["longshot"], "segments stay reusable when toggling it"


@pytest.mark.parametrize("vsr,match", [({"on": True, "scale": 5}, "factor"),
                                       ({"on": True, "scale": 0.5}, "factor"),
                                       ({"on": True, "quality": "MAX"}, "quality")])
def test_rtx_vsr_bad_values(vsr, match):
    p = mara()
    p["settings"]["rtx_vsr"] = vsr
    with pytest.raises(gb.BuildError, match=match):
        build(p)


def test_rtx_vsr_needs_its_pack_only_when_on():
    p = mara()
    env = gb.Env(classes=set(gb.required_classes(p)))
    build(p, env=env)
    p["settings"]["rtx_vsr"] = {"on": True}
    with pytest.raises(gb.BuildError, match="RTX-VSR"):
        build(p, env=env)



def test_upscale_final_forces_rtx_and_names_the_file():
    p = mara()
    p["settings"]["rtx_vsr"] = {"on": False, "scale": 3, "quality": "HIGH"}
    preview = build(p).prompt
    final = build(p, final=True).prompt
    check_wiring(final)
    assert "vsr" not in preview
    assert final["vsr"]["inputs"]["resize_type.scale"] == 3 and final["vsr"]["inputs"]["quality"] == "HIGH"
    assert final["combine"]["inputs"]["images"] == ["vsr", 0]
    assert final["combine"]["inputs"]["filename_prefix"] == "longshot/Mara — spaceport chase_final"
    assert preview["combine"]["inputs"]["filename_prefix"] == "longshot/Mara — spaceport chase"
    assert final["longshot"] == preview["longshot"], "the final reuses every segment"


def test_upscale_final_needs_the_rtx_pack():
    p = mara()
    env = gb.Env(classes=set(gb.required_classes(p)))
    with pytest.raises(gb.BuildError, match="RTX-VSR"):
        build(p, final=True, env=env)
