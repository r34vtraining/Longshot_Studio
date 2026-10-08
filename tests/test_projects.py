"""Projects (Addendum B): slugs, saving, conflicts, migration, reference checks."""
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
EXAMPLES = os.path.join(PKG_DIR, "examples")


@pytest.mark.parametrize("name,slug", [
    ("Mara — spaceport chase", "mara-spaceport-chase"), ("  Hello, World!! ", "hello-world"),
    ("A/B\\C..D", "a-b-c-d"), ("UPPER lower 123", "upper-lower-123")])
def test_slugify(name, slug):
    assert pj.slugify(name) == slug and pj.is_slug(slug)


def test_names_without_latin_letters_still_get_a_stable_slug():
    a, b = pj.slugify("太空港追逐"), pj.slugify("太空港追逐")
    assert a == b and a.startswith("project-") and pj.is_slug(a)
    assert pj.slugify("另一个") != a


@pytest.mark.parametrize("bad", ["", "../x", "a/b", "A", "a--b", "-a", "a b", None, "x" * 81])
def test_is_slug_rejects(bad):
    assert not pj.is_slug(bad)


@pytest.fixture
def store(tmp_path):
    return pj.ProjectStore(str(tmp_path / "projects"))


def test_save_reload_is_identical(store):
    with open(os.path.join(EXAMPLES, "mara_spaceport_chase.json"), encoding="utf-8") as fh:
        p = json.load(fh)
    p["shots"][0].update(status="approved", shot_seed=123)
    p["shots"][1]["status"] = "review"
    p["cast"][2]["bypassed"] = True
    saved_at = store.save("mara-spaceport-chase", p)
    back = store.load("mara-spaceport-chase")
    for k in ("cast", "shots", "settings", "audio", "style", "name"):
        assert back[k] == p[k], k
    assert back["saved_at"] == saved_at and back["studio_version"] == pj.STUDIO_VERSION


def test_slug_is_stable_across_rename(store):
    slug, _ = store.create("Mara — spaceport chase", {"shots": []})
    p = store.load(slug)
    p["name"] = "Mara — final cut"
    store.save(slug, p, base=p["saved_at"])
    assert [x["slug"] for x in store.list()] == ["mara-spaceport-chase"]
    assert store.load(slug)["name"] == "Mara — final cut"


def test_create_never_overwrites(store):
    a, _ = store.create("Mara", {})
    b, _ = store.create("mara!", {})
    c, _ = store.create("MARA", {})
    assert (a, b, c) == ("mara", "mara-2", "mara-3")


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
    (old / "Mara — spaceport chase.json").write_text(json.dumps({"name": "Mara — spaceport chase"}),
                                                     encoding="utf-8")
    assert pj.migrate(str(old), store) == 1
    assert store.exists("mara-spaceport-chase")
    assert not old.exists() and (tmp_path / "h3_longshot_studio.migrated").exists()
    assert pj.migrate(str(old), store) == 0


def test_seeds_the_example_once(store):
    pj.seed_examples(store, EXAMPLES)
    pj.seed_examples(store, EXAMPLES)
    assert [p["slug"] for p in store.list()] == ["mara-spaceport-chase"]


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
    (root / "longshot" / "mara").mkdir(parents=True)
    (root / "longshot" / "mara" / "actress.png").write_bytes(b"pixels-1")
    (root / "song.mp3").write_bytes(b"audio")
    (tmp_path / "secret.txt").write_text("x")
    return str(root)


def entry(name, sub="longshot/mara", sha=None):
    return {"name": name, "subfolder": sub, "sha256": sha}


def test_reference_ok_changed_missing_and_relink(inputs, tmp_path):
    first = pj.check_file(inputs, entry("actress.png"))
    assert first["state"] == "ok" and first["size_bytes"] == 8 and len(first["sha256"]) == 64
    sha = first["sha256"]
    assert pj.check_file(inputs, entry("actress.png", sha=sha))["state"] == "ok"

    # overwritten -> changed
    p = os.path.join(inputs, "longshot", "mara", "actress.png")
    with open(p, "wb") as fh:
        fh.write(b"pixels-2")
    os.utime(p, (1, 1))
    assert pj.check_file(inputs, entry("actress.png", sha=sha))["state"] == "changed"

    # deleted -> missing
    with open(p, "wb") as fh:
        fh.write(b"pixels-1")
    shutil.move(p, os.path.join(inputs, "moved.png"))
    assert pj.check_file(inputs, entry("actress.png", sha=sha))["state"] == "missing"

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
    assert pj.list_inputs(inputs) == {"subfolder": "", "images": [], "audio": ["song.mp3"]}
    assert pj.list_inputs(inputs, "longshot/mara")["images"] == ["actress.png"]
    assert pj.list_inputs(inputs, "longshot/nope")["images"] == []
    with pytest.raises(ValueError):
        pj.list_inputs(inputs, "../..")


def test_input_path_value():
    assert pj.input_path_value("a.png") == "a.png"
    assert pj.input_path_value("a.png", "longshot/mara") == "longshot/mara/a.png"
    assert pj.input_path_value("a.png", "longshot\\mara\\") == "longshot/mara/a.png"


def test_segments_stats_and_clear_touch_only_segment_files(tmp_path):
    out = str(tmp_path / "output")
    seg = pj.segments_folder(out, "mara")
    os.makedirs(seg)
    for f, data in (("a.safetensors", b"12345"), ("b.safetensors", b"123"),
                    ("c.safetensors.tmp", b"1"), ("notes.txt", b"keep")):
        with open(os.path.join(seg, f), "wb") as fh:
            fh.write(data)
    video = os.path.join(out, "longshot", "Mara_00001.mp4")
    open(video, "wb").close()
    assert pj.segment_stats(out, "mara") == {"files": 2, "bytes": 8}
    assert pj.clear_segments(out, "mara") == 3
    assert os.listdir(seg) == ["notes.txt"] and os.path.isfile(video)
    assert pj.segment_stats(out, "other") == {"files": 0, "bytes": 0}


def test_delete_inputs_only_removes_the_projects_own_folder(tmp_path):
    root = tmp_path / "input"
    (root / "longshot" / "mara").mkdir(parents=True)
    (root / "longshot" / "other").mkdir(parents=True)
    (root / "keep.png").write_bytes(b"x")
    assert pj.delete_inputs(str(root), "mara")
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
    out = pj.store_upload(root, "mara", "Actress Headshot.PNG", data)
    assert out["name"] == "Actress Headshot.png" and out["subfolder"] == "longshot/mara"
    assert out["reused"] is False and out["size_bytes"] == len(data)
    path = os.path.join(root, "longshot", "mara", "Actress Headshot.png")
    with open(path, "rb") as fh:
        assert fh.read() == data
    assert pj.check_file(root, {"name": out["name"], "subfolder": out["subfolder"],
                                "sha256": out["sha256"]})["state"] == "ok"
    assert not [f for f in os.listdir(os.path.dirname(path)) if f.endswith(".tmp")]


def test_upload_reuses_identical_files_and_never_overwrites(tmp_path):
    root = str(tmp_path / "input")
    os.makedirs(root)
    red, blue = _png((255, 0, 0)), _png((0, 0, 255))
    first = pj.store_upload(root, "mara", "face.png", red)
    again = pj.store_upload(root, "mara", "face.png", red)
    assert again["reused"] is True and again["name"] == "face.png"
    renamed = pj.store_upload(root, "mara", "copy of face.png", red)     # same bytes, other name
    assert renamed["reused"] is True and renamed["name"] == "face.png"
    other = pj.store_upload(root, "mara", "face.png", blue)             # same name, other picture
    assert other["reused"] is False and other["name"] == "face (2).png"
    assert other["sha256"] != first["sha256"]
    with open(os.path.join(root, "longshot", "mara", "face.png"), "rb") as fh:
        assert fh.read() == red
    assert pj.store_upload(root, "mara", "face.png", _png((0, 255, 0)))["name"] == "face (3).png"


@pytest.mark.parametrize("name,msg", [
    ("notes.txt", "can't be used"), ("noext", "no extension"), ("song.mp3", "can't be used")])
def test_upload_refuses_other_file_types(tmp_path, name, msg):
    with pytest.raises(ValueError, match=msg):
        pj.store_upload(str(tmp_path), "mara", name, _png())


def test_upload_refuses_bad_slugs_empty_and_unreadable_files(tmp_path):
    with pytest.raises(ValueError, match="slug"):
        pj.store_upload(str(tmp_path), "../escape", "a.png", _png())
    with pytest.raises(ValueError, match="empty"):
        pj.store_upload(str(tmp_path), "mara", "a.png", b"")
    with pytest.raises(ValueError, match="readable image"):
        pj.store_upload(str(tmp_path), "mara", "a.png", b"not really a png")
    assert not os.path.exists(tmp_path / "longshot" / "mara" / "a.png")


@pytest.mark.parametrize("raw,clean", [
    ("../../etc/evil.png", "evil.png"), ("C:\\Users\\me\\Pictures\\face.JPG", "face.jpg"),
    ('we<ird>:"name?.webp', "we_ird_name_.webp"), ("  .png", "upload.png")])
def test_upload_names_are_made_safe(raw, clean):
    assert pj.clean_upload_name(raw) == clean
