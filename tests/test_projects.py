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


def test_voice_references_travel_with_rename_and_export(tmp_path, store):
    inp, out, _ = _project_with_files(tmp_path, store)
    (tmp_path / "input" / "longshot" / "demo" / "luma.wav").write_bytes(b"voice")
    p = store.load("demo")
    p["voices"] = [{"id": "v1", "label": "<luma voice>", "file": "luma.wav", "subfolder": "longshot/demo"}]
    p["cast"][0]["voice"] = "v1"
    store.save("demo", p, force=True)
    new, _ = pj.rename_project(store, inp, out, "demo", "Moved")
    p = store.load(new)
    assert p["voices"][0]["subfolder"] == "longshot/moved"
    dest = str(tmp_path / "moved.zip")
    man = pj.export_project(inp, out, p, dest, takes=False)
    assert any(f["key"] == "voice:v1" for f in man["files"]) and not man["missing"]
    other = pj.ProjectStore(str(tmp_path / "other" / "projects"))
    inp2, out2 = str(tmp_path / "other" / "input"), str(tmp_path / "other" / "output")
    slug, _ = pj.import_project(other, inp2, out2, dest)
    q = other.load(slug)
    assert q["voices"][0]["file"] == "luma.wav" and q["cast"][0]["voice"] == "v1"
    assert os.path.isfile(os.path.join(inp2, "longshot", slug, "luma.wav"))


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
    assert pj.STUDIO_VERSION == "0.8.7"


# ---------------------------------------------------------------------------
# Round 5: timeline clips, deleting videos, projects whose folders are gone
# ---------------------------------------------------------------------------

def _real_run(cmd):
    import subprocess
    return subprocess.run(cmd, capture_output=True).returncode == 0


@pytest.mark.skipif(not shutil.which("ffmpeg"), reason="needs ffmpeg")
def test_cut_clips_makes_a_clip_and_thumbnail_per_take(tmp_path):
    import subprocess
    out = tmp_path / "output"
    vids = out / "longshot" / "demo" / "videos"
    vids.mkdir(parents=True)
    src = vids / "Demo_00001-audio.mp4"
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=duration=4:size=160x96:rate=24",
                    "-f", "lavfi", "-i", "sine=duration=4", "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p",
                    "-c:a", "aac", str(src)], check=True)
    video = {"filename": src.name, "subfolder": "longshot/demo/videos", "type": "output"}
    idx = pj.cut_clips(str(out), "demo", video, [
        {"key": "s1__1722__0123abcd", "start": 0, "end": 1.5},
        {"key": "s2__1723__89abcdef", "start": 1.5, "end": 4.0},
        {"key": "../evil", "start": 0, "end": 1},             # refused
        {"key": "short", "start": 1, "end": 1.01}], _real_run, "ffmpeg")
    assert sorted(idx) == ["s1__1722__0123abcd", "s2__1723__89abcdef"]
    assert idx["s2__1723__89abcdef"]["dur"] == 2.5 and idx["s1__1722__0123abcd"]["thumb"]
    clips = out / "longshot" / "demo" / "clips"
    probe = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0",
                            str(clips / "s2__1723__89abcdef.mp4")], capture_output=True, text=True).stdout
    assert abs(float(probe) - 2.5) < 0.1
    assert pj.clip_index(str(out), "demo") == idx
    # a video outside output/longshot is refused
    with pytest.raises(ValueError):
        pj.cut_clips(str(out), "demo", {"filename": "x.mp4", "subfolder": ""}, [], _real_run)
    # deleting the project's videos takes the clips with them
    assert pj.delete_videos(str(out), "demo")
    assert not vids.exists() and not clips.exists()
    assert not pj.delete_videos(str(out), "demo")


def test_clip_index_ignores_missing_files_and_bad_keys(tmp_path):
    folder = tmp_path / "longshot" / "demo" / "clips"
    folder.mkdir(parents=True)
    (folder / "a.mp4").write_bytes(b"x")
    (folder / "index.json").write_text(json.dumps({"a": {"dur": 1.2}, "gone": {"dur": 2}, "../x": {"dur": 1}}))
    assert pj.clip_index(str(tmp_path), "demo") == {"a": {"dur": 1.2, "made": "", "thumb": False}}
    assert pj.clip_index(str(tmp_path), "no-project") == {}


def test_files_missing_flags_projects_whose_folders_were_deleted(tmp_path, store):
    inp, out, take = _project_with_files(tmp_path, store)
    p = store.load("demo")
    assert not pj.files_missing(inp, out, "demo", p)
    shutil.rmtree(os.path.join(out, "longshot", "demo"))
    assert pj.files_missing(inp, out, "demo", p)                  # Shots have takes, folder gone
    listing = store.list(check=lambda slug, pr: {"files_missing": pj.files_missing(inp, out, slug, pr)})
    assert listing[0]["files_missing"] is True
    p["shots"][0]["take"] = None
    assert not pj.files_missing(inp, out, "demo", p)
    shutil.rmtree(os.path.join(inp, "longshot", "demo"))
    assert pj.files_missing(inp, out, "demo", p)                  # references lived in its input folder
    assert not pj.files_missing(inp, out, "demo", {"cast": [], "shots": []})



def _ffmpeg():
    import shutil as sh
    return sh.which("ffmpeg"), sh.which("ffprobe")


def test_join_chunks_with_ffmpeg(tmp_path):
    import subprocess
    ff, fp = _ffmpeg()
    if not ff or not fp:
        pytest.skip("no ffmpeg")
    slug = "joiny"
    ch = tmp_path / "longshot" / slug / "videos" / "_chunks"
    ch.mkdir(parents=True)
    sub = f"longshot/{slug}/videos/_chunks"
    chunks = []
    for i, n in enumerate((48, 48, 20)):
        f = ch / f"Film_final_c{i:03d}_00001.mp4"
        subprocess.run([ff, "-v", "error", "-f", "lavfi", "-i", f"testsrc=size=64x48:rate=24", "-frames:v", str(n),
                        "-c:v", "libx264", "-pix_fmt", "yuv420p", str(f)], check=True)
        chunks.append({"filename": f.name, "subfolder": sub})
    subprocess.run([ff, "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
                    "-t", "4.9", "-c:a", "pcm_f32le", str(ch / "Film_audio.wav")], check=True)
    (tmp_path / "longshot" / slug / "videos" / "Film_final_00003-audio.mp4").write_bytes(b"x")
    out = pj.join_chunks(str(tmp_path), slug, f"longshot/{slug}/videos/Film_final", chunks,
                         {"filename": "Film_audio.wav", "subfolder": sub}, ffmpeg=ff)
    v = out["video"]
    assert v["filename"] == "Film_final_00004-audio.mp4" and v["subfolder"] == f"longshot/{slug}/videos"
    assert out["master"] is None
    probe = json.loads(subprocess.run([fp, "-v", "error", "-count_frames", "-show_streams", "-of", "json", v["fullpath"]],
                                      capture_output=True, text=True).stdout)["streams"]
    vid = next(x for x in probe if x["codec_type"] == "video")
    aud = next(x for x in probe if x["codec_type"] == "audio")
    assert int(vid["nb_read_frames"]) == 116 and aud["codec_name"] == "aac"
    assert not ch.exists()                         # chunks removed after joining


def test_join_runs_drops_each_runs_hidden_overlap_from_the_sound(tmp_path):
    """0.8.5: a film decoded run by run: run 2's first 22 frames (its hidden
    overlap after the cut) aren't in its picture piece, so its sound skips them too."""
    import subprocess
    ff, fp = _ffmpeg()
    if not ff or not fp:
        pytest.skip("no ffmpeg")
    slug = "runs"
    ch = tmp_path / "longshot" / slug / "videos" / "_chunks"
    ch.mkdir(parents=True)
    sub = f"longshot/{slug}/videos/_chunks"
    chunks, audio = [], []
    for i, (n, secs, skip) in enumerate(((48, 2.0, 0), (26, 22 / 24 + 26 / 24, 22 / 24))):
        f = ch / f"Film_c{i:03d}_00001.mp4"
        subprocess.run([ff, "-v", "error", "-f", "lavfi", "-i", "testsrc=size=64x48:rate=24", "-frames:v", str(n),
                        "-c:v", "libx264", "-pix_fmt", "yuv420p", str(f)], check=True)
        chunks.append({"filename": f.name, "subfolder": sub})
        w = ch / f"Film_audio_r{i}_00001.wav"
        subprocess.run([ff, "-v", "error", "-f", "lavfi", "-i", f"sine=frequency={440 + 220 * i}:sample_rate=48000",
                        "-t", f"{secs:.4f}", "-c:a", "pcm_f32le", str(w)], check=True)
        audio.append({"filename": w.name, "subfolder": sub, "skip": skip})
    out = pj.join_chunks(str(tmp_path), slug, f"longshot/{slug}/videos/Film", chunks, audio, ffmpeg=ff)
    probe = json.loads(subprocess.run([fp, "-v", "error", "-count_frames", "-show_streams", "-of", "json",
                                       out["video"]["fullpath"]], capture_output=True, text=True).stdout)["streams"]
    vid = next(x for x in probe if x["codec_type"] == "video")
    aud = next(x for x in probe if x["codec_type"] == "audio")
    assert int(vid["nb_read_frames"]) == 74
    assert abs(float(aud["duration"]) - 74 / 24) < 0.06       # 2 s + 26 frames, the overlap's sound gone
    assert not ch.exists()


def test_join_chunks_refuses_foreign_files(tmp_path):
    slug = "joiny"
    (tmp_path / "longshot" / slug / "videos" / "_chunks").mkdir(parents=True)
    with pytest.raises(ValueError):
        pj.join_chunks(str(tmp_path), slug, f"longshot/{slug}/videos/Film", [{"filename": "../x.mp4",
                       "subfolder": f"longshot/{slug}/videos/_chunks"}])
    with pytest.raises(ValueError):
        pj.join_chunks(str(tmp_path), slug, "longshot/other/videos/Film", [{"filename": "a.mp4",
                       "subfolder": f"longshot/{slug}/videos/_chunks"}])
    with pytest.raises(ValueError):
        pj.join_chunks(str(tmp_path), slug, f"longshot/{slug}/videos/Film", [{"filename": "a.mp4",
                       "subfolder": "longshot/other/videos/_chunks"}])
    assert pj.discard_chunks(str(tmp_path), slug) is True
    assert pj.discard_chunks(str(tmp_path), slug) is False


def test_join_chunks_with_a_real_world_project_name(tmp_path):
    import subprocess
    ff, fp = _ffmpeg()
    if not ff:
        pytest.skip("no ffmpeg")
    slug, stem = "noras-film", "Nora's Long Film – take é (v2)"
    ch = tmp_path / "longshot" / slug / "videos" / "_chunks"
    ch.mkdir(parents=True)
    sub = f"longshot/{slug}/videos/_chunks"
    chunks = []
    for i in range(2):
        f = ch / f"{stem}_final_c{i:03d}_00001.mp4"
        subprocess.run([ff, "-v", "error", "-f", "lavfi", "-i", "testsrc=size=64x48:rate=24", "-frames:v", "24",
                        "-c:v", "libx264", "-pix_fmt", "yuv420p", str(f)], check=True)
        chunks.append({"filename": f.name, "subfolder": sub})
    subprocess.run([ff, "-v", "error", "-f", "lavfi", "-i", "sine=sample_rate=48000", "-t", "2",
                    "-c:a", "pcm_f32le", str(ch / f"{stem}_audio.wav")], check=True)
    out = pj.join_chunks(str(tmp_path), slug, f"longshot/{slug}/videos/{stem}_final", chunks,
                         {"filename": f"{stem}_audio.wav", "subfolder": sub}, ffmpeg=ff)
    assert out["video"]["filename"] == f"{stem}_final_00001-audio.mp4"
    assert os.path.isfile(out["video"]["fullpath"]) and not ch.exists()
    for bad in ("a/b", "..x", ".hidden", "a:b", "a*b", " lead", "trail "):
        with pytest.raises(ValueError):
            pj.join_chunks(str(tmp_path), slug, f"longshot/{slug}/videos/{bad}", chunks)


def test_a_failed_join_keeps_the_chunks(tmp_path):
    slug = "keep"
    ch = tmp_path / "longshot" / slug / "videos" / "_chunks"
    ch.mkdir(parents=True)
    (ch / "F_c000_00001.mp4").write_bytes(b"not a video")
    fail = lambda cmd: type("R", (), {"returncode": 1, "stderr": b"boom"})()
    with pytest.raises(RuntimeError, match="boom"):
        pj.join_chunks(str(tmp_path), slug, f"longshot/{slug}/videos/F", [{"filename": "F_c000_00001.mp4",
                       "subfolder": f"longshot/{slug}/videos/_chunks"}], run=fail)
    assert (ch / "F_c000_00001.mp4").is_file()


def test_copy_approved_clips_whole(tmp_path):
    slug = "expo"
    clips = tmp_path / "longshot" / slug / "clips"
    clips.mkdir(parents=True)
    (clips / "s1__1722__aa.mp4").write_bytes(b"one")
    (clips / "s3__99__bb.mp4").write_bytes(b"three")
    folder = tmp_path / "longshot" / slug / "Approved_Clips"
    folder.mkdir()
    (folder / "Shot 09 – old.mp4").write_bytes(b"stale")
    (folder / "notes.txt").write_text("mine")
    names = pj.copy_approved(str(tmp_path), slug, [{"key": "s1__1722__aa", "name": "Shot 01 – seed 1722"},
                                                   {"key": "s3__99__bb", "name": "Shot 02 – seed 99"}])
    assert names == ["Shot 01 – seed 1722.mp4", "Shot 02 – seed 99.mp4"]
    assert sorted(f.name for f in folder.iterdir()) == ["Shot 01 – seed 1722.mp4", "Shot 02 – seed 99.mp4", "notes.txt"]
    assert (folder / "Shot 02 – seed 99.mp4").read_bytes() == b"three"       # the clip, whole
    with pytest.raises(ValueError, match="isn't there"):
        pj.copy_approved(str(tmp_path), slug, [{"key": "s9__1__cc", "name": "Shot 03"}])
    for bad in ({"key": "../x", "name": "a"}, {"key": "s1__1722__aa", "name": "a/b"}, {"key": "s1__1722__aa", "name": "..x"}):
        with pytest.raises(ValueError):
            pj.copy_approved(str(tmp_path), slug, [bad])


def test_mux_approved_adds_the_sound(tmp_path):
    import subprocess
    ff, fp = _ffmpeg()
    if not ff or not fp:
        pytest.skip("no ffmpeg")
    slug = "expo"
    work = tmp_path / "longshot" / slug / "Approved_Clips" / "_work"
    work.mkdir(parents=True)
    subprocess.run([ff, "-v", "error", "-f", "lavfi", "-i", "testsrc=size=64x48:rate=24", "-frames:v", "36",
                    "-c:v", "libx264", "-pix_fmt", "yuv420p", str(work / "c001_00001.mp4")], check=True)
    subprocess.run([ff, "-v", "error", "-f", "lavfi", "-i", "sine=sample_rate=48000", "-t", "1.45",
                    "-c:a", "pcm_f32le", str(work / "c001_audio.wav")], check=True)    # a bit short, as the VAE's is
    sub = f"longshot/{slug}/Approved_Clips/_work"
    names = pj.mux_approved(str(tmp_path), slug, [{"name": "Shot 01 – seed 5",
                                                    "video": {"filename": "c001_00001.mp4", "subfolder": sub},
                                                    "audio": {"filename": "c001_audio.wav", "subfolder": sub}}], ffmpeg=ff)
    assert names == ["Shot 01 – seed 5.mp4"]
    out = tmp_path / "longshot" / slug / "Approved_Clips" / "Shot 01 – seed 5.mp4"
    streams = json.loads(subprocess.run([fp, "-v", "error", "-count_frames", "-show_streams", "-of", "json", str(out)],
                                        capture_output=True, text=True).stdout)["streams"]
    assert {x["codec_type"] for x in streams} == {"video", "audio"}
    assert int(next(x for x in streams if x["codec_type"] == "video")["nb_read_frames"]) == 36
    assert not work.exists()
    with pytest.raises(ValueError):
        pj.mux_approved(str(tmp_path), slug, [{"name": "x", "video": {"filename": "a.mp4", "subfolder": "longshot/expo/videos"}}])


def test_upscaled_export_keeps_clips_already_upscaled(tmp_path):
    """Only new approved takes are upscaled again: the rest stay (renamed when
    their number moved), stale files leave the folder, the clips folder stays."""
    slug = "inc"
    folder = tmp_path / "longshot" / slug / "Approved_Clips"
    folder.mkdir(parents=True)
    clips = tmp_path / "longshot" / slug / "clips"
    clips.mkdir()
    (clips / "s1__5__aa.mp4").write_bytes(b"clip")
    for n in ("Shot 01 – seed 5", "Shot 02 – seed 6", "Shot 03 – seed 7"):
        (folder / f"{n}.mp4").write_bytes(n.encode())
    pj._write_manifest(str(folder), {
        "Shot 01 – seed 5.mp4": {"key": "s1__5__aa", "sig": "2x ULTRA", "prores": False},
        "Shot 02 – seed 6.mp4": {"key": "s2__6__bb", "sig": "2x ULTRA", "prores": False},
        "Shot 03 – seed 7.mp4": {"key": "s3__7__cc", "sig": "2x ULTRA", "prores": False}})
    # a Shot was inserted after Shot 1 and Shot 2 got a new take
    r = pj.keep_upscaled(str(tmp_path), slug, [
        {"key": "s1__5__aa", "name": "Shot 01 – seed 5"},
        {"key": "s2__9__dd", "name": "Shot 03 – seed 9"},
        {"key": "s3__7__cc", "name": "Shot 04 – seed 7"}], "2x ULTRA")
    assert r["todo"] == ["s2__9__dd"]
    assert sorted(r["kept"]) == ["Shot 01 – seed 5.mp4", "Shot 04 – seed 7.mp4"]
    assert sorted(f.name for f in folder.iterdir() if f.suffix == ".mp4") == ["Shot 01 – seed 5.mp4", "Shot 04 – seed 7.mp4"]
    assert (folder / "Shot 04 – seed 7.mp4").read_bytes() == "Shot 03 – seed 7".encode()
    assert (clips / "s1__5__aa.mp4").exists()
    man = pj._read_manifest(str(folder))
    assert man["Shot 04 – seed 7.mp4"]["key"] == "s3__7__cc"
    # other upscale settings: everything again; ProRes wanted but missing: again
    assert pj.keep_upscaled(str(tmp_path), slug, [{"key": "s1__5__aa", "name": "Shot 01 – seed 5"}],
                            "4x ULTRA")["todo"] == ["s1__5__aa"]
    assert not any(f.suffix == ".mp4" for f in folder.iterdir())


def test_context_frame_is_the_last_frame_of_the_take_before(tmp_path):
    import subprocess
    ff, _fp = _ffmpeg()
    if not ff:
        pytest.skip("no ffmpeg")
    slug = "ctx"
    clips = tmp_path / "out" / "longshot" / slug / "clips"
    clips.mkdir(parents=True)
    # 24 frames: red, then the last frame blue
    subprocess.run([ff, "-v", "error", "-f", "lavfi", "-i", "color=red:size=32x32:rate=24:d=0.958",
                    "-f", "lavfi", "-i", "color=blue:size=32x32:rate=24:d=0.042",
                    "-filter_complex", "[0][1]concat=n=2:v=1", "-c:v", "libx264", "-pix_fmt", "yuv444p",
                    "-qp", "0", str(clips / "s1__5__aa.mp4")], check=True)
    info = pj.context_frame(str(tmp_path / "out"), str(tmp_path / "in"), slug,
                            {"kind": "shot", "status": "review", "take": "s1__5__aa.safetensors"}, ffmpeg=ff)
    assert info == {"file": "s1__5__aa_last.png", "subfolder": "longshot/ctx/context"}
    png = tmp_path / "in" / "longshot" / slug / "context" / "s1__5__aa_last.png"
    raw = subprocess.run([ff, "-v", "error", "-i", str(png), "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
                         capture_output=True).stdout
    assert raw[2] > 200 and raw[0] < 60, "blue: the very last frame"
    assert pj.context_frame(str(tmp_path / "out"), str(tmp_path / "in"), slug,
                            {"kind": "shot", "take": "s2__6__bb.safetensors"}, ffmpeg=ff) is None, "no clip yet"
