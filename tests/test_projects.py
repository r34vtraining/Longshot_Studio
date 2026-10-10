"""Projects: slugs, saving, conflicts, migration, reference checks."""
import importlib
import json
import os
import shutil
import sys

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
PKG_DIR = os.path.dirname(HERE)
sys.path.insert(0, os.path.dirname(PKG_DIR))
pj = importlib.import_module(os.path.basename(PKG_DIR) + ".projects")
SAMPLE = os.path.join(HERE, "fixtures", "sample_project.json")


@pytest.mark.parametrize("name,slug", [
    ("Sample — chase scene", "sample-chase-scene"), ("  Hello, World!! ", "hello-world"),
    ("A/B\\C..D", "a-b-c-d"), ("UPPER lower 123", "upper-lower-123")])
def test_slugify(name, slug):
    assert pj.slugify(name) == slug and pj.is_slug(slug)


def test_names_without_latin_letters_still_get_a_stable_slug():
    a, b = pj.slugify("测试项目"), pj.slugify("测试项目")
    assert a == b and a.startswith("project-") and pj.is_slug(a)
    assert pj.slugify("另一个") != a


@pytest.mark.parametrize("bad", ["", "../x", "a/b", "A", "a--b", "-a", "a b", None, "x" * 81])
def test_is_slug_rejects(bad):
    assert not pj.is_slug(bad)


@pytest.fixture
def store(tmp_path):
    return pj.ProjectStore(str(tmp_path / "projects"))


def test_save_reload_is_identical(store):
    with open(SAMPLE, encoding="utf-8") as fh:
        p = json.load(fh)
    p["shots"][0].update(status="approved", shot_seed=123)
    p["shots"][1]["status"] = "review"
    p["cast"][2]["bypassed"] = True
    saved_at = store.save("sample-project", p)
    back = store.load("sample-project")
    for k in ("cast", "shots", "settings", "audio", "style", "name"):
        assert back[k] == p[k], k
    assert back["saved_at"] == saved_at and back["studio_version"] == pj.STUDIO_VERSION


def test_slug_is_stable_across_rename(store):
    slug, _ = store.create("Sample project", {"shots": []})
    p = store.load(slug)
    p["name"] = "Sample — final cut"
    store.save(slug, p, base=p["saved_at"])
    assert [x["slug"] for x in store.list()] == ["sample-project"]
    assert store.load(slug)["name"] == "Sample — final cut"


def test_create_never_overwrites(store):
    a, _ = store.create("Demo", {})
    b, _ = store.create("demo!", {})
    c, _ = store.create("DEMO", {})
    assert (a, b, c) == ("demo", "demo-2", "demo-3")


def test_two_tabs_later_save_is_refused_unless_forced(store):
    slug, first = store.create("Two tabs", {"shots": []})
    tab_a, tab_b = store.load(slug), store.load(slug)
    store.save(slug, dict(tab_a, name="from A"), base=tab_a["saved_at"])
    with pytest.raises(pj.Conflict) as c:
        store.save(slug, dict(tab_b, name="from B"), base=tab_b["saved_at"])
    assert c.value.current["name"] == "from A"
    store.save(slug, dict(tab_b, name="from B"), base=tab_b["saved_at"], force=True)
    assert store.load(slug)["name"] == "from B"


def test_list_is_newest_first_with_progress(store):
    store.create("Old", {"shots": [{"status": "approved"}, {"status": "queued"}]})
    store.create("New", {"shots": [], "last_output": {"video": {"filename": "x.mp4"}}})
    rows = store.list()
    assert [r["name"] for r in rows] == ["New", "Old"]
    assert rows[1]["shots"] == 2 and rows[1]["approved"] == 1
    assert rows[0]["video"] == {"filename": "x.mp4"}


def test_migrates_stage_1_projects_once(tmp_path, store):
    old = tmp_path / "h3_longshot_studio"
    old.mkdir()
    (old / "Sample project.json").write_text(json.dumps({"name": "Sample project"}),
                                                     encoding="utf-8")
    assert pj.migrate(str(old), store) == 1
    assert store.exists("sample-project")
    assert not old.exists() and (tmp_path / "h3_longshot_studio.migrated").exists()
    assert pj.migrate(str(old), store) == 0


def test_delete_removes_only_the_project_file(store, tmp_path):
    a, _ = store.create("Keep", {})
    b, _ = store.create("Drop", {})
    assert store.delete(b) and not store.exists(b) and store.exists(a)
    assert not store.delete(b)


# ---------------------------------------------------------------------------
# Reference states
# ---------------------------------------------------------------------------

@pytest.fixture
def inputs(tmp_path):
    root = tmp_path / "input"
    (root / "longshot" / "demo").mkdir(parents=True)
    (root / "longshot" / "demo" / "portrait.png").write_bytes(b"pixels-1")
    (root / "song.mp3").write_bytes(b"audio")
    (tmp_path / "secret.txt").write_text("x")
    return str(root)


def entry(name, sub="longshot/demo", sha=None):
    return {"name": name, "subfolder": sub, "sha256": sha}


def test_reference_ok_changed_missing_and_relink(inputs, tmp_path):
    first = pj.check_file(inputs, entry("portrait.png"))
    assert first["state"] == "ok" and first["size_bytes"] == 8 and len(first["sha256"]) == 64
    sha = first["sha256"]
    assert pj.check_file(inputs, entry("portrait.png", sha=sha))["state"] == "ok"

    # overwritten -> changed
    p = os.path.join(inputs, "longshot", "demo", "portrait.png")
    with open(p, "wb") as fh:
        fh.write(b"pixels-2")
    os.utime(p, (1, 1))
    assert pj.check_file(inputs, entry("portrait.png", sha=sha))["state"] == "changed"

    # deleted -> missing
    with open(p, "wb") as fh:
        fh.write(b"pixels-1")
    shutil.move(p, os.path.join(inputs, "moved.png"))
    assert pj.check_file(inputs, entry("portrait.png", sha=sha))["state"] == "missing"

    # moved and relinked: same hash -> ok
    relinked = pj.check_file(inputs, entry("moved.png", sub="", sha=sha))
    assert relinked["state"] == "ok" and relinked["sha256"] == sha


@pytest.mark.parametrize("name,sub", [
    ("../secret.txt", ""), ("..", ""), ("a/b.png", ""), ("a\\b.png", ""), ("C:x.png", ""),
    ("secret.txt", ".."), ("secret.txt", "../"), ("x.png", "/etc"), ("x.png", "longshot/../.."),
    ("x.png", "C:\\Windows"), ("", "")])
def test_check_inputs_refuses_paths_outside_the_input_folder(inputs, name, sub):
    assert pj.check_file(inputs, {"name": name, "subfolder": sub})["state"] == "invalid"


def test_list_inputs(inputs):
    assert pj.list_inputs(inputs) == {"subfolder": "", "images": [], "audio": ["song.mp3"], "videos": []}
    assert pj.list_inputs(inputs, "longshot/demo")["images"] == ["portrait.png"]
    assert pj.list_inputs(inputs, "longshot/nope")["images"] == []
    with pytest.raises(ValueError):
        pj.list_inputs(inputs, "../..")


def test_input_path_value():
    assert pj.input_path_value("a.png") == "a.png"
    assert pj.input_path_value("a.png", "longshot/demo") == "longshot/demo/a.png"
    assert pj.input_path_value("a.png", "longshot\\demo\\") == "longshot/demo/a.png"


def test_segments_stats_and_clear_touch_only_segment_files(tmp_path):
    out = str(tmp_path / "output")
    seg = pj.segments_folder(out, "demo")
    os.makedirs(seg)
    for f, data in (("a.safetensors", b"12345"), ("b.safetensors", b"123"),
                    ("c.safetensors.tmp", b"1"), ("notes.txt", b"keep")):
        with open(os.path.join(seg, f), "wb") as fh:
            fh.write(data)
    video = os.path.join(out, "longshot", "Sample_00001.mp4")
    open(video, "wb").close()
    assert pj.segment_stats(out, "demo") == {"files": 2, "bytes": 8}
    assert pj.clear_segments(out, "demo") == 3
    assert os.listdir(seg) == ["notes.txt"] and os.path.isfile(video)
    assert pj.segment_stats(out, "other") == {"files": 0, "bytes": 0}


def test_delete_inputs_only_removes_the_projects_own_folder(tmp_path):
    root = tmp_path / "input"
    (root / "longshot" / "demo").mkdir(parents=True)
    (root / "longshot" / "other").mkdir(parents=True)
    (root / "keep.png").write_bytes(b"x")
    assert pj.delete_inputs(str(root), "demo")
    assert sorted(os.listdir(root / "longshot")) == ["other"] and (root / "keep.png").exists()
    assert not pj.delete_inputs(str(root), "../input")


# ---------------------------------------------------------------------------
# Dropped reference images
# ---------------------------------------------------------------------------

def _png(color=(200, 30, 30), size=(8, 8)):
    import io
    from PIL import Image
    buf = io.BytesIO()
    Image.new("RGB", size, color).save(buf, "PNG")
    return buf.getvalue()


def test_upload_saves_into_the_projects_input_folder(tmp_path):
    root = str(tmp_path / "input")
    os.makedirs(root)
    data = _png()
    out = pj.store_upload(root, "demo", "Headshot.PNG", data)
    assert out["name"] == "Headshot.png" and out["subfolder"] == "longshot/demo"
    assert out["reused"] is False and out["size_bytes"] == len(data)
    path = os.path.join(root, "longshot", "demo", "Headshot.png")
    with open(path, "rb") as fh:
        assert fh.read() == data
    assert pj.check_file(root, {"name": out["name"], "subfolder": out["subfolder"],
                                "sha256": out["sha256"]})["state"] == "ok"
    assert not [f for f in os.listdir(os.path.dirname(path)) if f.endswith(".tmp")]


def test_upload_reuses_identical_files_and_never_overwrites(tmp_path):
    root = str(tmp_path / "input")
    os.makedirs(root)
    red, blue = _png((255, 0, 0)), _png((0, 0, 255))
    first = pj.store_upload(root, "demo", "face.png", red)
    again = pj.store_upload(root, "demo", "face.png", red)
    assert again["reused"] is True and again["name"] == "face.png"
    renamed = pj.store_upload(root, "demo", "copy of face.png", red)     # same bytes, other name
    assert renamed["reused"] is True and renamed["name"] == "face.png"
    other = pj.store_upload(root, "demo", "face.png", blue)             # same name, other picture
    assert other["reused"] is False and other["name"] == "face (2).png"
    assert other["sha256"] != first["sha256"]
    with open(os.path.join(root, "longshot", "demo", "face.png"), "rb") as fh:
        assert fh.read() == red
    assert pj.store_upload(root, "demo", "face.png", _png((0, 255, 0)))["name"] == "face (3).png"


@pytest.mark.parametrize("name,msg", [
    ("notes.txt", "can't be used"), ("noext", "no extension"), ("song.mp3", "can't be used")])
def test_upload_refuses_other_file_types(tmp_path, name, msg):
    with pytest.raises(ValueError, match=msg):
        pj.store_upload(str(tmp_path), "demo", name, _png())


def test_upload_refuses_bad_slugs_empty_and_unreadable_files(tmp_path):
    with pytest.raises(ValueError, match="slug"):
        pj.store_upload(str(tmp_path), "../escape", "a.png", _png())
    with pytest.raises(ValueError, match="empty"):
        pj.store_upload(str(tmp_path), "demo", "a.png", b"")
    with pytest.raises(ValueError, match="readable image"):
        pj.store_upload(str(tmp_path), "demo", "a.png", b"not really a png")
    assert not os.path.exists(tmp_path / "longshot" / "demo" / "a.png")


@pytest.mark.parametrize("raw,clean", [
    ("../../etc/evil.png", "evil.png"), ("C:\\Users\\me\\Pictures\\face.JPG", "face.jpg"),
    ('we<ird>:"name?.webp', "we_ird_name_.webp"), ("  .png", "upload.png")])
def test_upload_names_are_made_safe(raw, clean):
    assert pj.clean_upload_name(raw) == clean


# ---------------------------------------------------------------------------
# Model files on another machine
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("saved,listed,want", [
    ("H3\\model.safetensors", ["H3/model.safetensors"], "H3/model.safetensors"),
    ("H3/model.safetensors", ["H3\\model.safetensors"], "H3\\model.safetensors"),
    ("H3\\model.safetensors", ["minimax/Model.safetensors", "other.safetensors"],
     "minimax/Model.safetensors"),                     # another subfolder: found by file name
    ("H3\\model.safetensors", ["a/model.safetensors", "b/model.safetensors"], None),  # ambiguous
    ("H3\\model.safetensors", ["x.safetensors"], None),
    ("", ["x.safetensors"], None),
])
def test_model_names_match_across_machines(saved, listed, want):
    assert pj.match_model_name(saved, listed) == want


def test_model_folders_round_trip(tmp_path):
    path = str(tmp_path / "cfg" / "model_folders.json")
    assert pj.load_model_folders(path) == {}
    pj.save_model_folders(path, {"diffusion_models": ["D:/AI", "D:/AI"], "bogus": ["x"], "vae": []})
    assert pj.load_model_folders(path) == {"diffusion_models": ["D:/AI"]}
    with open(path, "w") as fh:
        fh.write("not json")
    assert pj.load_model_folders(path) == {}


def test_browse_dir_lists_folders_and_counts_models(tmp_path):
    (tmp_path / "models" / "H3").mkdir(parents=True)
    (tmp_path / "models" / "a.safetensors").write_bytes(b"x")
    (tmp_path / "models" / "notes.txt").write_text("x")
    (tmp_path / "models" / ".hidden").mkdir()
    out = pj.browse_dir(str(tmp_path / "models"))
    assert out["dirs"] == ["H3"] and out["models"] == 1
    assert out["parent"] == str(tmp_path)
    assert pj.browse_dir("")["dirs"]                       # drives / root
    with pytest.raises(ValueError):
        pj.browse_dir(str(tmp_path / "nope"))


# ---------------------------------------------------------------------------
# Round 3: renaming moves folders, finding missing files, export / import
# ---------------------------------------------------------------------------

def _project_with_files(tmp_path, store):
    inp, out = tmp_path / "input", tmp_path / "output"
    (inp / "longshot" / "demo").mkdir(parents=True)
    (inp / "longshot" / "demo" / "face.png").write_bytes(b"face")
    (inp / "song.mp3").write_bytes(b"song")
    (out / "longshot" / "demo" / "takes").mkdir(parents=True)
    take = "s1__5__0123abcd.safetensors"
    (out / "longshot" / "demo" / "takes" / take).write_bytes(b"take")
    project = {"name": "Demo", "cast": [{"id": "c1", "label": "<hero>", "image": "face.png",
                                         "subfolder": "longshot/demo", "sha256": pj.file_sha256(str(inp / "longshot" / "demo" / "face.png"))}],
               "audio": {"file": "song.mp3", "subfolder": ""},
               "shots": [{"id": "s1", "take": take, "status": "approved"}]}
    store.save("demo", project)
    return str(inp), str(out), take


def test_rename_moves_the_input_and_takes_folders(tmp_path, store):
    inp, out, take = _project_with_files(tmp_path, store)
    new, _ = pj.rename_project(store, inp, out, "demo", "Chase Scene")
    assert new == "chase-scene" and not store.exists("demo")
    p = store.load(new)
    assert p["name"] == "Chase Scene" and p["cast"][0]["subfolder"] == "longshot/chase-scene"
    assert p["audio"]["subfolder"] == ""                     # files outside the project stay put
    assert os.path.isfile(os.path.join(inp, "longshot", "chase-scene", "face.png"))
    assert os.path.isfile(os.path.join(out, "longshot", "chase-scene", "takes", take))
    assert p["shots"][0]["take"] == take
    assert not os.path.exists(os.path.join(inp, "longshot", "demo"))


def test_rename_to_the_same_slug_only_renames(tmp_path, store):
    inp, out, _ = _project_with_files(tmp_path, store)
    assert pj.rename_project(store, inp, out, "demo", "DEMO")[0] == "demo"
    assert store.load("demo")["name"] == "DEMO"


def test_rename_never_merges_into_an_existing_folder(tmp_path, store):
    inp, out, _ = _project_with_files(tmp_path, store)
    os.makedirs(os.path.join(inp, "longshot", "chase"))
    assert pj.rename_project(store, inp, out, "demo", "Chase")[0] == "chase-2"


def test_missing_files_are_found_by_contents_then_by_name(tmp_path):
    inp = tmp_path / "input"
    (inp / "longshot" / "demo").mkdir(parents=True)
    (inp / "longshot" / "demo" / "renamed.png").write_bytes(b"face")
    (inp / "other.png").write_bytes(b"different")
    sha = __import__("hashlib").sha256(b"face").hexdigest()
    found = pj.find_inputs(str(inp), "demo", [
        {"key": "c1", "name": "face.png", "sha256": sha},
        {"key": "c2", "name": "other.png", "sha256": "0" * 64},
        {"key": "c3", "name": "gone.png", "sha256": "1" * 64}])
    by = {f["key"]: f for f in found}
    assert by["c1"]["name"] == "renamed.png" and by["c1"]["match"] == "same"
    assert by["c1"]["subfolder"] == "longshot/demo"
    assert by["c2"]["match"] == "name" and "c3" not in by


def test_export_then_import_brings_everything(tmp_path, store):
    inp, out, take = _project_with_files(tmp_path, store)
    dest = str(tmp_path / "demo.zip")
    man = pj.export_project(inp, out, store.load("demo"), dest, takes=True)
    assert len(man["files"]) == 2 and man["takes"] == [take] and not man["missing"]
    # import on "another machine"
    other = pj.ProjectStore(str(tmp_path / "other" / "projects"))
    inp2, out2 = str(tmp_path / "other" / "input"), str(tmp_path / "other" / "output")
    slug, summary = pj.import_project(other, inp2, out2, dest)
    p = other.load(slug)
    assert slug == "demo" and summary["files"] == 2 and summary["takes"] == 1
    assert p["cast"][0]["subfolder"] == "longshot/demo" and p["audio"]["subfolder"] == "longshot/demo"
    assert os.path.isfile(os.path.join(inp2, "longshot", "demo", "song.mp3"))
    assert p["shots"][0]["take"] == take
    assert os.path.isfile(os.path.join(out2, "longshot", "demo", "takes", take))
    # importing again makes a second project, never overwrites
    slug2, _ = pj.import_project(other, inp2, out2, dest)
    assert slug2 != slug


def test_export_without_takes_imports_shots_to_render_again(tmp_path, store):
    inp, out, _ = _project_with_files(tmp_path, store)
    dest = str(tmp_path / "demo.zip")
    pj.export_project(inp, out, store.load("demo"), dest, takes=False)
    other = pj.ProjectStore(str(tmp_path / "o" / "p"))
    slug, summary = pj.import_project(other, str(tmp_path / "o" / "i"), str(tmp_path / "o" / "o"), dest)
    assert summary["takes"] == 0 and other.load(slug)["shots"][0]["take"] is None


def test_import_refuses_other_zips(tmp_path, store):
    import zipfile
    bad = tmp_path / "x.zip"
    with zipfile.ZipFile(bad, "w") as z:
        z.writestr("readme.txt", "hi")
    with pytest.raises(ValueError, match="isn't an H3 Long Shot Studio project"):
        pj.import_project(store, str(tmp_path / "i"), str(tmp_path / "o"), str(bad))
    (tmp_path / "y.zip").write_bytes(b"nope")
    with pytest.raises(ValueError, match="isn't a project export"):
        pj.import_project(store, str(tmp_path / "i"), str(tmp_path / "o"), str(tmp_path / "y.zip"))


def test_import_ignores_paths_outside_the_zip_layout(tmp_path, store):
    import zipfile, json as _json
    z_path = tmp_path / "evil.zip"
    with zipfile.ZipFile(z_path, "w") as z:
        z.writestr("project.json", _json.dumps({"name": "E", "cast": [{"id": "c1", "image": "a.png"}],
                                                "shots": []}))
        z.writestr("manifest.json", _json.dumps({"format": 1, "files": [
            {"key": "cast:c1", "path": "../../escape.png"}], "takes": ["../../x.safetensors"]}))
        z.writestr("../../escape.png", b"x")
    slug, summary = pj.import_project(store, str(tmp_path / "i"), str(tmp_path / "o"), str(z_path))
    assert summary["files"] == 0 and summary["takes"] == 0
    assert not (tmp_path / "escape.png").exists()


def test_uploads_take_audio_and_video_by_kind(tmp_path):
    out = pj.store_upload(str(tmp_path), "demo", "Song.MP3", b"ID3audio", kind="audio")
    assert out["name"] == "Song.mp3"
    assert pj.store_upload(str(tmp_path), "demo", "clip.mov", b"\0\0video", kind="video")["name"] == "clip.mov"
    with pytest.raises(ValueError):
        pj.store_upload(str(tmp_path), "demo", "clip.mov", b"x", kind="audio")


def test_probe_report_parsing_and_clip_lengths():
    text = """Input #0, mov,mp4, from 'x.mp4':
  Duration: 00:00:12.48, start: 0.000000, bitrate: 1200 kb/s
  Stream #0:0[0x1](und): Video: h264 (High), yuv420p(progressive), 1920x1080 [SAR 1:1 DAR 16:9], 29.97 fps, 29.97 tbr
  Stream #0:1[0x2](und): Audio: aac (LC), 48000 Hz, stereo, fltp, 128 kb/s"""
    info = pj.parse_probe(text)
    assert info == {"duration": 12.48, "fps": 29.97, "width": 1920, "height": 1080, "has_audio": True}
    assert pj.parse_probe("Duration: 00:01:02.5\\n Stream #0:0: Video: vp9, 640x360, 25 fps")["has_audio"] is False
    assert pj.clip_frames(5.0) == 107 and pj.clip_frames(5.2) == 124 and pj.clip_frames(0.1) == 0


# ---------------------------------------------------------------------------
# Round 4: videos in the project folder, side files of a render
# ---------------------------------------------------------------------------

def _render_files(folder, stem="Demo", n=1, ext="mp4"):
    """What Video Combine writes for one render."""
    os.makedirs(folder, exist_ok=True)
    names = [f"{stem}_{n:05}.png", f"{stem}_{n:05}.{ext}", f"{stem}_{n:05}-audio.{ext}"]
    for f in names:
        with open(os.path.join(folder, f), "wb") as fh:
            fh.write(b"x" * 10)
    return names


def test_side_files_of_a_render_png_and_silent_video(tmp_path):
    out = str(tmp_path / "output")
    vids = os.path.join(out, "longshot", "demo", "videos")
    png, silent, loud = _render_files(vids)
    other = _render_files(vids, n=2)                       # an earlier render: never touched
    entry = {"filename": loud, "subfolder": "longshot/demo/videos", "type": "output"}
    assert pj.render_side_files(out, [entry]) == []
    assert [os.path.basename(p) for p in pj.render_side_files(out, [entry], png=True)] == [png]
    assert [os.path.basename(p) for p in pj.render_side_files(out, [entry], noaudio=True)] == [silent]
    removed = pj.remove_render_side_files(out, [entry], png=True, noaudio=True)
    assert removed == [f"longshot/demo/videos/{png}", f"longshot/demo/videos/{silent}"]
    assert sorted(os.listdir(vids)) == sorted([loud] + other)


def test_side_files_never_include_the_video_the_player_uses(tmp_path):
    out = str(tmp_path / "output")
    vids = os.path.join(out, "longshot", "demo", "videos")
    png, silent, loud = _render_files(vids)
    os.remove(os.path.join(vids, loud))                    # a render with no sound: the silent
    entry = {"filename": silent, "subfolder": "longshot/demo/videos", "type": "output"}
    assert pj.render_side_files(out, [entry], noaudio=True) == []      # file is the video
    assert [os.path.basename(p) for p in pj.render_side_files(out, [entry], png=True)] == [png]


@pytest.mark.parametrize("entry", [
    {"filename": "Demo_00001-audio.mp4", "subfolder": "", "type": "output"},          # output root
    {"filename": "Demo_00001-audio.mp4", "subfolder": "other", "type": "output"},
    {"filename": "Demo_00001-audio.mp4", "subfolder": "longshot/../other", "type": "output"},
    {"filename": "Demo_00001-audio.mp4", "subfolder": "longshot/demo/videos", "type": "temp"},
    {"filename": "../Demo_00001-audio.mp4", "subfolder": "longshot/demo/videos", "type": "output"},
    {"filename": "notes.txt", "subfolder": "longshot/demo/videos", "type": "output"},
    {"filename": "Demo_00009-audio.mp4", "subfolder": "longshot/demo/videos", "type": "output"},  # no such render
    "not a dict",
])
def test_side_files_only_inside_output_longshot(tmp_path, entry):
    out = str(tmp_path / "output")
    for folder in (out, os.path.join(out, "other"), os.path.join(out, "longshot", "demo", "videos")):
        _render_files(folder)
    assert pj.render_side_files(out, [entry], png=True, noaudio=True) == []


def test_old_renders_in_output_longshot_can_be_cleaned_too(tmp_path):
    out = str(tmp_path / "output")
    png, silent, loud = _render_files(os.path.join(out, "longshot"))
    entry = {"filename": loud, "subfolder": "longshot", "type": "output"}
    assert len(pj.render_side_files(out, [entry], png=True, noaudio=True)) == 2


def test_rename_moves_the_videos_and_the_player_follows(tmp_path, store):
    inp, out, _ = _project_with_files(tmp_path, store)
    _render_files(os.path.join(out, "longshot", "demo", "videos"))
    _render_files(os.path.join(out, "longshot"), stem="Old")           # a 0.5 render
    p = store.load("demo")
    p["last_output"] = {"video": {"filename": "Demo_00001-audio.mp4", "subfolder": "longshot/demo/videos",
                                  "type": "output", "workflow": "Demo_00001.png"}, "plan": [], "chain": []}
    p["final_output"] = {"video": {"filename": "Old_00001-audio.mp4", "subfolder": "longshot",
                                   "type": "output"},
                         "master": {"filename": "Demo_00001-audio.mp4", "subfolder": "longshot\\demo\\videos"}}
    store.save("demo", p)
    new, _ = pj.rename_project(store, inp, out, "demo", "Chase")
    p = store.load(new)
    assert p["last_output"]["video"]["subfolder"] == "longshot/chase/videos"
    assert p["final_output"]["video"]["subfolder"] == "longshot"          # old renders stay put
    assert p["final_output"]["master"]["subfolder"] == "longshot/chase/videos"
    assert os.path.isfile(os.path.join(out, "longshot", "chase", "videos", "Demo_00001-audio.mp4"))
    assert os.path.isfile(os.path.join(out, "longshot", "Old_00001-audio.mp4"))
    assert pj.list_videos(out, "chase") == ["Demo_00001-audio.mp4", "Demo_00001.mp4"]


def test_export_with_videos_and_import_restores_them(tmp_path, store):
    inp, out, take = _project_with_files(tmp_path, store)
    vids = os.path.join(out, "longshot", "demo", "videos")
    _render_files(vids)
    _render_files(os.path.join(out, "longshot"), stem="Old")
    p = store.load("demo")
    p["last_output"] = {"video": {"filename": "Old_00001-audio.mp4", "subfolder": "longshot",
                                  "type": "output", "workflow": "Old_00001.png"},
                        "plan": [{"id": "s1"}], "chain": ["s1"]}
    p["final_output"] = {"video": {"filename": "Demo_00001-audio.mp4", "subfolder": "longshot/demo/videos",
                                   "type": "output"}, "chain": ["s1"]}
    store.save("demo", p)
    est = pj.export_estimate(inp, out, "demo", store.load("demo"))
    assert est["video_files"] == 3 and est["videos"] == 30      # 2 in videos/ + the older last preview
    assert est["takes"] == 4

    no_v = str(tmp_path / "plain.zip")
    man = pj.export_project(inp, out, store.load("demo"), no_v, takes=True)
    assert man["videos"] == []
    with_v = str(tmp_path / "full.zip")
    man = pj.export_project(inp, out, store.load("demo"), with_v, takes=True, video=True)
    assert sorted(man["videos"]) == ["Demo_00001-audio.mp4", "Demo_00001.mp4", "Old_00001-audio.mp4"]
    assert man["player"] == {"last_output.video": "videos/Old_00001-audio.mp4",
                             "final_output.video": "videos/Demo_00001-audio.mp4"}

    other = pj.ProjectStore(str(tmp_path / "o" / "projects"))
    inp2, out2 = str(tmp_path / "o" / "input"), str(tmp_path / "o" / "output")
    slug, summary = pj.import_project(other, inp2, out2, no_v)
    q = other.load(slug)
    assert summary["videos"] == 0 and q["last_output"] is None and q["final_output"] is None
    slug, summary = pj.import_project(other, inp2, out2, with_v)
    q = other.load(slug)
    assert summary["videos"] == 3
    assert sorted(os.listdir(os.path.join(out2, "longshot", slug, "videos"))) == \
        ["Demo_00001-audio.mp4", "Demo_00001.mp4", "Old_00001-audio.mp4"]
    assert q["last_output"]["video"] == {"filename": "Old_00001-audio.mp4", "type": "output",
                                         "subfolder": f"longshot/{slug}/videos", "workflow": None}
    assert q["last_output"]["plan"] == [{"id": "s1"}]
    assert q["final_output"]["video"]["subfolder"] == f"longshot/{slug}/videos"


def test_import_of_a_0_5_export_puts_its_preview_in_the_videos_folder(tmp_path, store):
    import zipfile
    dest = tmp_path / "old.zip"
    project = {"name": "Old one", "cast": [], "shots": [],
               "last_output": {"video": {"filename": "Old_00001-audio.mp4", "subfolder": "longshot"},
                               "plan": [], "chain": []}}
    with zipfile.ZipFile(dest, "w") as z:
        z.writestr("project.json", json.dumps(project))
        z.writestr("manifest.json", json.dumps({"format": 1, "files": [], "takes": [],
                                                "video": "video/Old_00001-audio.mp4"}))
        z.writestr("video/Old_00001-audio.mp4", b"vid")
    out = str(tmp_path / "output")
    slug, summary = pj.import_project(store, str(tmp_path / "input"), out, str(dest))
    assert summary["videos"] == 1
    v = store.load(slug)["last_output"]["video"]
    assert v["subfolder"] == f"longshot/{slug}/videos" and v["filename"] == "Old_00001-audio.mp4"
    assert os.path.isfile(os.path.join(out, "longshot", slug, "videos", "Old_00001-audio.mp4"))


def test_studio_version():
    assert pj.STUDIO_VERSION == "0.6.3"
