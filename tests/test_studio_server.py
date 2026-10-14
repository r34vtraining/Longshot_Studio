"""Server helpers that don't need ComfyUI: who counts as local, which files
open-folder may select, the OS commands, project storage."""
import importlib
import json
import os
import sys

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
PKG_DIR = os.path.dirname(HERE)
sys.path.insert(0, os.path.dirname(PKG_DIR))
srv = importlib.import_module(os.path.basename(PKG_DIR) + ".studio_server")
gb = importlib.import_module(os.path.basename(PKG_DIR) + ".graph_builder")


@pytest.mark.parametrize("remote,headers,local", [
    ("127.0.0.1", {}, True), ("::1", {}, True), ("127.0.0.5", {}, True),
    ("100.101.102.103", {}, False),        # Tailscale
    ("192.168.1.20", {}, False), ("10.0.0.2", {}, False),
    ("127.0.0.1", {"X-Forwarded-For": "100.64.1.1"}, False),   # local reverse proxy
    ("127.0.0.1", {"Forwarded": "for=1.2.3.4"}, False),
    ("127.0.0.1", {"CF-Connecting-IP": "1.2.3.4"}, False),
    (None, {}, False), ("not an ip", {}, False)])
def test_is_local_request(remote, headers, local):
    assert srv.is_local_request(remote, headers) is local


def test_folder_for_only_knows_two_folders(tmp_path):
    out, inp = str(tmp_path / "out"), str(tmp_path / "in")
    assert srv.folder_for("output", out, inp) == os.path.join(out, "longshot")
    assert srv.folder_for("input", out, inp) == inp
    for bad in ("", None, "/etc", "../output", "user"):
        with pytest.raises(ValueError):
            srv.folder_for(bad, out, inp)


def test_output_folder_is_the_projects_videos_folder_when_it_has_one(tmp_path):
    out, inp = str(tmp_path / "out"), str(tmp_path / "in")
    assert srv.folder_for("output", out, inp, "demo") == os.path.join(out, "longshot")
    os.makedirs(os.path.join(out, "longshot", "demo", "videos"))
    videos = os.path.join(out, "longshot", "demo", "videos")
    assert srv.folder_for("output", out, inp, "demo") == videos
    assert srv.folder_for("output", out, inp, "demo", "longshot/demo/videos") == videos
    # the last video is an older render in output/longshot: open that folder
    assert srv.folder_for("output", out, inp, "demo", "longshot") == os.path.join(out, "longshot")
    assert srv.folder_for("output", out, inp, "../x", "longshot/demo/videos") == os.path.join(out, "longshot")


def test_output_folder_can_be_the_projects_clips_folder(tmp_path):
    out, inp = str(tmp_path / "out"), str(tmp_path / "in")
    base = os.path.join(out, "longshot")
    # no project folder yet: output/longshot
    assert srv.folder_for("output", out, inp, "demo", "longshot/demo/clips") == base
    os.makedirs(os.path.join(base, "demo"))
    assert srv.folder_for("output", out, inp, "demo", "longshot/demo/clips") == os.path.join(base, "demo")
    clips = os.path.join(base, "demo", "clips")
    os.makedirs(clips)
    assert srv.folder_for("output", out, inp, "demo", "longshot/demo/clips") == clips
    # another project's clips folder is never picked by subfolder alone
    os.makedirs(os.path.join(base, "other", "clips"))
    assert srv.folder_for("output", out, inp, "demo", "longshot/other/clips") == base
    assert srv.folder_for("output", out, inp, "../x", "longshot/demo/clips") == base


def test_output_button_opens_approved_clips_first_then_falls_back(tmp_path):
    out, inp = str(tmp_path / "out"), str(tmp_path / "in")
    base = os.path.join(out, "longshot", "demo")
    os.makedirs(os.path.join(base, "clips"))
    body = {"which": "output", "project": "demo", "subfolder": "longshot/demo/Approved_Clips",
            "select": "Shot 02 – seed 5.mp4",
            "fallback": {"subfolder": "longshot/demo/clips", "select": "s2__5__aa.mp4"}}
    # nothing exported yet: the fallback
    assert srv.open_target(out, inp, body) == (os.path.join(base, "clips"), "s2__5__aa.mp4")
    os.makedirs(os.path.join(base, "Approved_Clips"))
    assert srv.open_target(out, inp, body) == (os.path.join(base, "Approved_Clips"), "Shot 02 – seed 5.mp4")
    # a plain request is unchanged
    plain = {"which": "output", "project": "demo", "subfolder": "longshot/demo/clips", "select": "x.mp4"}
    assert srv.open_target(out, inp, plain) == (os.path.join(base, "clips"), "x.mp4")


def test_video_entries_collects_every_video_combine_result():
    outputs = {"longshot": {"plan_json": [1]}, "combine": {"gifs": [{"filename": "a-audio.mp4"}]},
               "combine_prores": {"gifs": [{"filename": "b-audio.mov"}]}, "x": None,
               "y": {"videos": [{"filename": "c.mp4"}, "junk"]}}
    assert [e["filename"] for e in srv.video_entries(outputs)] == ["a-audio.mp4", "b-audio.mov", "c.mp4"]
    assert srv.video_entries(None) == []


def test_cleanup_skips_video_combines_served_from_comfyuis_cache():
    entry = {"outputs": {"combine": {"gifs": [{"filename": "old-audio.mp4"}]},
                         "combine_prores": {"gifs": [{"filename": "new-audio.mov"}]}},
             "status": {"messages": [["execution_start", {}],
                                     ["execution_cached", {"nodes": ["unet", "combine"]}]]}}
    assert list(srv.fresh_outputs(entry)) == ["combine_prores"]
    assert srv.fresh_outputs({"outputs": {"a": {}}}) == {"a": {}}


def test_clear_longshot_cache_finds_the_loaded_module(monkeypatch):
    import types
    mod = types.ModuleType("fake_longshot.nodes")
    mod._SEGMENT_CACHE = {"a": 1, "b": 2}
    mod.clear_segment_cache = lambda: mod._SEGMENT_CACHE.clear()
    monkeypatch.setitem(sys.modules, "fake_longshot.nodes", mod)
    monkeypatch.setattr(srv, "longshot_module", lambda: mod)
    assert srv.clear_longshot_cache() == 2 and mod._SEGMENT_CACHE == {}


def test_the_prores_format_file_is_valid_and_ten_bit():
    path = os.path.join(PKG_DIR, "video_formats", gb.PRORES_FORMAT_FILE)
    with open(path, encoding="utf-8") as fh:
        f = json.load(fh)
    main = f["main_pass"]
    assert main[main.index("-c:v") + 1] == "prores_ks" and main[main.index("-profile:v") + 1] == "hq"
    assert main[main.index("-pix_fmt") + 1] == "yuv422p10le"
    assert f["input_color_depth"] == "16bit" and f["extension"] == "mov"
    assert f["audio_pass"][:2] == ["-c:a", "pcm_s16le"] and "use_metadata_tags" in f["audio_pass"]
    assert f["save_metadata"][0] == "save_metadata"


def test_selectable_rejects_anything_but_a_file_in_the_folder(tmp_path):
    folder = tmp_path / "longshot"
    folder.mkdir()
    (folder / "Sample_00001.mp4").write_bytes(b"x")
    (folder / "sub").mkdir()
    (tmp_path / "secret.txt").write_text("x")
    assert srv.selectable(str(folder), "Sample_00001.mp4") == str(folder / "Sample_00001.mp4")
    for bad in ("../secret.txt", "..", ".", "sub", "missing.mp4", "", None, 3,
                str(tmp_path / "secret.txt"), "sub/../Sample_00001.mp4", "..\\secret.txt"):
        assert srv.selectable(str(folder), bad) is None, bad


def test_selectable_rejects_symlink_escape(tmp_path):
    folder = tmp_path / "longshot"
    folder.mkdir()
    (tmp_path / "secret.txt").write_text("x")
    try:
        os.symlink(tmp_path / "secret.txt", folder / "link.mp4")
    except (OSError, NotImplementedError):
        pytest.skip("no symlinks here")
    assert srv.selectable(str(folder), "link.mp4") is None


def test_open_commands():
    assert srv.open_command("C:\\out\\longshot", "C:\\out\\longshot\\a b.mp4", "win32") == \
        'explorer /select,"C:\\out\\longshot\\a b.mp4"'
    assert srv.open_command("C:\\in", None, "win32") == 'explorer "C:\\in"'
    assert srv.open_command("/o", "/o/a.mp4", "darwin") == ["open", "-R", "/o/a.mp4"]
    assert srv.open_command("/o", None, "darwin") == ["open", "/o"]
    assert srv.open_command("/o", "/o/a.mp4", "linux") == ["xdg-open", "/o"]


def test_sample_project_shape():
    with open(os.path.join(HERE, "fixtures", "sample_project.json"),
              encoding="utf-8") as fh:
        p = json.load(fh)
    assert p["version"] == 1 and len(p["cast"]) == 7 and len(p["shots"]) == 6
    assert all("Picture" not in c["label"] for c in p["cast"]), "<Picture N> is never stored"
    assert all(s["status"] == "queued" for s in p["shots"])
    assert not (p["audio"]["lip_sync"] or p["audio"]["voice_ref"] or p["audio"]["final_override"])


def test_model_names_are_portable_between_windows_and_linux():
    lists = {"diffusion_models": ["H3/minimax_h3_fl2va_pruned_bf16.safetensors"],
             "text_encoders": ["H3/qwen.safetensors"], "vae": ["H3/v.safetensors", "H3/a.safetensors"],
             "loras": ["H3/Speed/turbo.safetensors", "style.safetensors"]}
    p = {"settings": {"model": "H3\\minimax_h3_fl2va_pruned_bf16.safetensors",
                      "clip": "H3\\qwen.safetensors", "video_vae": "H3\\v.safetensors",
                      "audio_vae": "H3/a.safetensors",
                      "turbo": {"on": True, "lora": "H3\\Speed\\turbo.safetensors"},
                      "loras": [{"on": True, "name": "style.safetensors"}, {"on": False, "name": None}]},
         "audio": {"melband_model": "Not\\Listed.safetensors"}}
    srv.resolve_names(p, lists)
    s = p["settings"]
    assert s["model"] == "H3/minimax_h3_fl2va_pruned_bf16.safetensors"
    assert s["clip"] == "H3/qwen.safetensors" and s["video_vae"] == "H3/v.safetensors"
    assert s["turbo"]["lora"] == "H3/Speed/turbo.safetensors"
    assert s["loras"][0]["name"] == "style.safetensors" and s["loras"][1]["name"] is None
    assert p["audio"]["melband_model"] == "Not\\Listed.safetensors"   # no twin: left alone


def test_restart_command_relaunches_the_same_way():
    # portable Windows build: path with spaces, browser flag dropped
    exe = "D:\\David\\Stuff\\Software\\Stable_Diffusion\\Comfy UI\\python_embeded\\python.exe"
    cmd = srv.restart_command(exe, ["D:\\...\\Comfy UI\\ComfyUI\\main.py", "--windows-standalone-build",
                                    "--listen", "--output-directory", "E:\\AI out"], "win32")
    assert cmd == [f'"{exe}"', '"D:\\...\\Comfy UI\\ComfyUI\\main.py"', "--listen",
                   "--output-directory", '"E:\\AI out"']
    assert srv.restart_command("/usr/bin/python3", ["main.py", "--cpu"], "linux") == \
        ["/usr/bin/python3", "main.py", "--cpu"]
    assert srv.restart_command("/py", ["/x/comfy/__main__.py", "--port", "8190"], "linux") == \
        ["/py", "-m", "comfy", "--port", "8190"]


def test_pick_explorer_window():
    wins = [(1, "Documents"), (2, "longshot"), (3, "input")]
    assert srv.pick_window(wins, {1, 2, 3}, "input") == 3            # Explorer reused the window
    assert srv.pick_window(wins + [(9, "clips")], {1, 2, 3}, "clips") == 9
    assert srv.pick_window(wins + [(9, "C:\\out\\clips")], {1, 2, 3}, "clips") == 9
    assert srv.pick_window(wins + [(9, "Quick access")], {1, 2, 3}, "videos") == 9  # the one new window
    assert srv.pick_window(wins, {1, 2, 3}, "videos") is None        # not there yet: keep waiting


def test_bring_to_front_only_on_windows():
    assert srv.explorer_snapshot("linux") == set()
    assert srv.bring_to_front("/o/x", set(), "linux") is None
    assert srv.bring_to_front("/o/x", set(), "darwin") is None


def test_open_folder_can_open_approved_clips(tmp_path):
    out, inp = tmp_path / "out", tmp_path / "in"
    (out / "longshot" / "p1" / "videos").mkdir(parents=True)
    assert srv.folder_for("output", str(out), str(inp), "p1", "longshot/p1/Approved_Clips").endswith("longshot")
    (out / "longshot" / "p1" / "Approved_Clips").mkdir()
    assert srv.folder_for("output", str(out), str(inp), "p1", "longshot/p1/Approved_Clips") == \
        str(out / "longshot" / "p1" / "Approved_Clips")


def test_keep_awake_holds_while_the_queue_has_work_and_lets_go_after():
    now = [1000.0]
    busy = [False]
    calls = []
    ka = srv.KeepAwake(platform="test", clock=lambda: now[0], busy=lambda: busy[0])
    ka._apply = lambda on: calls.append(on)
    ka._ensure_thread = lambda: None            # drive it by hand
    ka.beat(True)
    assert ka.wanted()
    now[0] += srv.KEEP_AWAKE_TTL - 1
    assert ka.wanted()
    now[0] += 2                                  # no heartbeat: the tab closed
    assert not ka.wanted()
    busy[0] = True                               # ComfyUI still runs the last job
    assert ka.wanted()
    busy[0] = False
    ka.beat(True)
    ka.beat(False)                               # queue empty or paused: right away
    assert not ka.wanted()


def test_install_pack_clones_only_known_packs(tmp_path):
    calls = []
    class R:
        returncode = 0
        stderr = b""
    def run(cmd):
        calls.append(cmd)
        if cmd[1] == "clone":
            os.makedirs(cmd[-1])
            open(os.path.join(cmd[-1], "requirements.txt"), "w").close()
        return R()
    out = srv.install_pack("refmod", str(tmp_path), run=run, git="git", python="py")
    assert calls[0][:4] == ["git", "clone", "--depth", "1"] and calls[0][4].endswith("/ComfyUI-MiniMaxH3Mod")
    assert calls[1][:4] == ["py", "-m", "pip", "install"] and out["cloned"] and out["pip"]
    again = srv.install_pack("refmod", str(tmp_path), run=run, git="git", python="py")
    assert not again["cloned"]                                     # already there: no second clone
    with pytest.raises(ValueError):
        srv.install_pack("https://evil.example/x", str(tmp_path), run=run, git="git")
