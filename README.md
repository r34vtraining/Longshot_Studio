# H3 Long Shot Studio

A browser front end for [MiniMax H3 Long Shot](https://github.com/r34vtraining/H3_Longshot),
served by ComfyUI itself at **http://127.0.0.1:8188/longshot** (or whatever address your
ComfyUI uses). You build a continuous long shot one approved Shot at a time:

- **▶ Render Shot 1** starts. A one-Shot project works the same way.
- **✓ Continue** approves the Shot under review and renders the next one.
  Earlier Shots come from Long Shot's segment memory, so each step costs one segment.
- **⟳ Reroll** gives the Shot under review a new seed and renders it again.
- **Stop** interrupts. Finished segments are kept, so the next render picks up from there.

The pack adds no nodes. It builds a workflow from your project and queues it on ComfyUI.

**Features**
- Projects with autosave, a project menu, and protection against two tabs overwriting each other.
- Cast & Scenes references with drag and drop, a label/description editor and a lightbox.
- Shot-by-shot review: approve, reroll (including an already-approved Shot), and
  re-render the Shots after it in one go.
- Saved segments on disk, so a crash or restart costs no finished Shots.
- A viewer with frame stepping, loop-the-seam, theater and full-screen views, and volume.
- Audio routes (lip sync, voice reference, song in the final video) with a clip preview.
- Optional RTX Video Super Resolution for previews or the final video.
- Restart ComfyUI from the page.

## Requirements

- A ComfyUI version with native MiniMax H3 support, and the MiniMax H3 model files.
- These custom node packs. The Studio checks for them and names any that are missing.

| Pack | Needed for |
|---|---|
| [H3 Prompt Compiler](https://github.com/r34vtraining/H3_Prompt_Compiler) | Shot, Subject, Ref Prompt Builder r2v (always) |
| [H3 Long Shot](https://github.com/r34vtraining/H3_Longshot) **1.3.0 or later** | rendering; 1.3.0 adds the plan and progress hooks and the saved segments the Studio uses (always) |
| [ComfyUI-KJNodes](https://github.com/kijai/ComfyUI-KJNodes) | resizing references, optional Sage attention (always) |
| [ComfyUI-VideoHelperSuite](https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite) | saving the video, loading audio (always) |
| [ComfyUI-MiniMax-H3-Turbo](https://github.com/Larryvrh/ComfyUI-MiniMax-H3-Turbo) | only when Turbo is on |
| [ComfyUI-MelBandRoFormer](https://github.com/kijai/ComfyUI-MelBandRoFormer) | only for the voice-reference audio route |
| [ComfyUI-NVIDIA-RTX-VSR-Pro](https://github.com/whmc76/ComfyUI-NVIDIA-RTX-VSR-Pro) | only for RTX upscaling (needs an RTX GPU) |

The default scheduler, `beta57`, comes from [RES4LYF](https://github.com/ClownsharkBatwing/RES4LYF).
If you don't have it, pick another scheduler under **Advanced**.

## Install

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/r34vtraining/H3_Longshot_Studio
git clone https://github.com/r34vtraining/H3_Prompt_Compiler
git clone https://github.com/r34vtraining/H3_Longshot
git clone https://github.com/kijai/ComfyUI-KJNodes
git clone https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite
```

Skip any you already have. If you already have H3 Long Shot, update it to 1.3.0 or
later with `git pull` in its folder.

Optional packs:

```bash
git clone https://github.com/Larryvrh/ComfyUI-MiniMax-H3-Turbo      # Turbo LoRA
git clone https://github.com/kijai/ComfyUI-MelBandRoFormer          # voice-reference route
git clone https://github.com/whmc76/ComfyUI-NVIDIA-RTX-VSR-Pro      # RTX upscaling
```

KJNodes, VideoHelperSuite and some optional packs have Python requirements. Install
them with ComfyUI's Python from each pack's folder:

```bash
python -m pip install -r requirements.txt
```

For the Windows portable build, run this from the `ComfyUI_windows_portable` folder instead:

```bat
python_embeded\python.exe -m pip install -r ComfyUI\custom_nodes\ComfyUI-KJNodes\requirements.txt
```

The Studio itself has no extra dependencies.

Restart ComfyUI and open **http://127.0.0.1:8188/longshot**.

## Getting started

1. The first time you open the Studio it makes an empty **Untitled** project. Rename it
   from the project menu (click the name at the top).
2. In **Settings**, check the model, text encoder, VAEs and Turbo LoRA. The Studio
   fills any it can identify from your model folders; choose the rest yourself.
3. Drop reference images on **Cast & Scenes** and give each a label (for example
   `<hero>`, `<scene1>`) and a short description.
4. Fill in **Style & Sound**, then write your Shots, referring to references by label.
5. Press **▶ Render Shot 1**, review it, then **✓ Continue** or **⟳ Reroll**.

Updating: run `git pull` in the Studio's folder (and in H3 Long Shot's), then restart
ComfyUI and hard-refresh the page (Ctrl+Shift+R).

## How it works

- `POST /longshot/build` turns the project into a ComfyUI API prompt (`graph_builder.py`,
  pure Python). Each render queues the chain of active Shots up to the target. Long Shot reuses every
  unchanged earlier segment and samples only what changed.
- The browser queues that prompt through ComfyUI's own `/prompt`, follows progress on `/ws`
  (including Long Shot's per-segment `mmh3.longshot` events), and reads the plan and the video
  from `/history`.
- Projects are saved as `ComfyUI/user/default/longshot-studio/projects/<slug>.json` (see *Projects*).
- Videos are saved to `ComfyUI/output/longshot/<project>_00001.mp4`. Video Combine uses NVENC
  when your ffmpeg can actually run it (checked with a one-frame test encode), and the
  software h264 encoder otherwise.
- The size uses the same rule as ComfyUI's ResolutionSelector and MiniMax's size table
  (1 MP = 1024 × 1024 px, multiples of 32). For example, 0.6 MP at 16:9 gives 1056 × 608.
- Model names saved on Windows (`H3\x`) still match on Linux (`H3/x`), and the other way round.

### Projects

- **Slug.** Each project has a fixed slug: its name lower-cased, with other characters
  turned into `-` (for example `my-chase-scene` for "My chase scene"). Names with no Latin letters or
  digits get `project-<hash>`. **Rename** changes only the display name, so the
  project's saved segments (`output/longshot/<slug>/segments`) and input folder
  (`input/longshot/<slug>`) stay attached.
- **Menu.** Click the project name for **New project**, **Open…** (with the last
  video's first frame, the save time and progress), **Save** (Ctrl/⌘ S), **Save as…**,
  **Rename…**, **Duplicate** and **Delete…**. Delete can also remove the saved segments
  and the input folder; both are unticked by default, and both only work from the
  ComfyUI machine.
- **Autosave.** The project saves 2 s after any change, and right away when a render is
  queued or finishes. The indicator shows "Saved · 21:34", "Saving…" or
  "Unsaved changes". The last project reopens on load.
- **Two tabs.** If another tab saved the project since this one loaded it, saving stops
  and asks **Reload** or **Keep mine**.

### References and audio

- **What's saved.** Each reference saves its file name and subfolder (as ComfyUI has
  them), the file's size and sha256, and its original name. Audio saves the same, plus
  start, length and the three routes.
- **Where files can come from.** The file pickers list this project's input folder
  (`input/longshot/<slug>`) first, then the input folder itself.
- **Reopen checks.** On opening, every file is checked inside the input folder:
  - **ok**: shown normally.
  - **Changed since saved**: amber badge. The file was overwritten, so every Shot
    renders again.
  - **Missing**: red placeholder with **Relink…** and **Bypass**. Rendering waits until
    every active reference is found or bypassed. A missing song turns off only the
    audio routes for that render.
- **Relinking costs nothing.** Picking a file with the same contents, even from another
  folder, restores it silently with nothing to re-render.
- **Drag and drop.** Drop images on **Add reference** (or anywhere in Cast & Scenes) to
  add one reference per image. A single new image opens the editor so you can name it.
  Drop an image on a card to replace that card's picture. Clicking an empty thumbnail
  opens a file picker.
  - Files go to `input/longshot/<slug>/` through `POST /longshot/upload`, from any device
    that can reach ComfyUI. The size limit is ComfyUI's `--max-upload-size`.
  - Uploads never overwrite. A file with the same contents is reused, so dropping the
    same picture again re-renders nothing. A different picture with an existing name
    is saved as `name (2).png`.
  - Only images are taken (PNG, JPG, WebP, BMP, GIF, TIFF), and each is checked as a
    readable image.
- **Audio preview.** The play button next to Length plays the clip the render will use:
  from Start, for Length seconds (0 plays to the end). It plays at the viewer's volume
  level, stops by itself at the end of the clip, and stops when the video plays.
- **Subfolders work for audio.** `VHS_LoadAudioUpload` validates the file by path, not
  by its dropdown, so `input/longshot/<slug>/song.mp3` loads. Images and audio in a
  project subfolder are tested through ComfyUI's validator and executor
  (`test_references_and_audio_load_from_a_project_subfolder`).

### Saved segments

The Studio sets Long Shot's `cache_name` to the project's slug, so each project keeps
its finished segments in `output/longshot/<slug>/segments/`.

After a crash or restart, reopen the project. The Studio runs a free dry run (Long
Shot doesn't load the model for it), and the Plan shows **reused (disk)** for every
finished Shot. **Continue** picks up exactly where you left off, and nothing that was
already rendered is sampled again.

Settings shows **Saved segments: N files · X MB**, a switch to stop saving them, and
**Clear saved segments**, which works from the ComfyUI machine only. A 5 s Shot takes
about 4–5 MB at 0.6 MP.

### Reviewing and rerolling

- **Seed · fixed** (Settings) feeds every Shot left on auto. It never changes by itself;
  use Reroll for new takes, and type a seed to go back to one. Changing it asks first
  when rendered Shots would re-render: the first auto Shot and everything after it.
- **Reroll an approved Shot** with the ⟳ button on its card.
  - If it's the last rendered Shot, it simply re-renders with a new seed for review.
  - If Shots after it are rendered, the Studio asks first. Those Shots go back to
    Queued, keep their text and seeds, and are marked "was ✓" (approved) or "was ●"
    (was being reviewed).
  - After the new take, **Re-render through Shot N** brings all the kept takes back in
    one queue, continued from the new Shot, and stops on the last one for review.
  - Earlier seeds are listed under the Shot's seed field. Click one to go back to it.
- **References** open in an editor dialog when you click the label, the description or
  ✎. It shows the image large, the label, and an auto-growing description box.
  - Ctrl/⌘ Enter saves and Esc cancels.
  - Clicking outside asks before discarding your edits.
  - Saving asks first when rendered Shots would re-render.
- **Clicking a thumbnail** opens the lightbox: scroll to zoom, drag to pan, ←/→ to move
  between references, Esc to close.
- **Bigger viewer.**
  - **Theater** (▭ button or `T`) spans the page, with the decision panel beside it.
  - **Full screen** (⛶ button or `F`) puts the video, every control and the decision panel
    on screen, with the controls in a translucent bar along the bottom that sits in the
    letterbox space first.
  - Esc or the same button exits. Space and ←/→ (frame step) work in every view.
- **Volume.** The speaker button mutes and unmutes, the slider sets the level, and `M`
  toggles mute. Both are in every view, and the browser remembers the level and mute
  state between sessions.

### RTX Super Resolution (upscale previews / upscale final)

Two controls use NVIDIA's RTX Video Super Resolution node (`RTXVideoSuperResolution`,
"scale by multiplier"), which runs between VAE Decode and Video Combine. Neither ever re-renders a Shot: the upscale runs after Long Shot,
so segments are reused and only the decode, upscale and save run again.

- **Upscale previews** (switch in Settings, under the resolution settings). When it's
  on, every render is upscaled. It gets slower as the chain grows, so leave it off
  while you review.
- **⤢ Upscale final video** (decision panel, once every Shot is approved). It always
  upscales, with the scale and quality set next to the switch, and saves as
  `longshot/<project>_final_#####.mp4`. After that, the panel shows the saved file
  name and offers "again".
- **Scale** is 1.5× or 2×. Higher factors mostly run out of memory on long chains.
- **RAM.** ComfyUI holds every frame in system RAM as float32, before and after the
  upscale. A 35 s chain at 0.6 MP needs about 20 GB at 1.5× and 30 GB at 2×. The
  Settings row shows the estimate for your current chain.
- **Needs** ComfyUI-NVIDIA-RTX-VSR-Pro and an RTX GPU. Without the pack, both controls are
  greyed out.

### Restarting ComfyUI

**Restart** (top bar, left of the status light) restarts ComfyUI after asking first.

- ComfyUI relaunches itself with the same command line, the way ComfyUI-Manager does it,
  minus `--windows-standalone-build` so no extra browser tab opens.
- The page shows "Restarting ComfyUI…", reconnects on its own, and re-checks saved
  segments.
- A running render stops. Finished segments are on disk, so nothing already rendered
  is lost.
- It works from any device that can reach ComfyUI, including over Tailscale.

### What re-renders what

- **Editing a Shot's text, seconds or seed** re-renders that Shot and every Shot after it.
- **Bypassing or removing a Shot** re-renders the Shots after it, which renumber.
- **Cast & Scenes, Style & Sound, Settings, and the lip-sync or voice audio routes** are
  shared by every Shot. Changing them re-renders everything from Shot 1. Earlier approvals
  are kept as a "was ✓" flag.
- **Song in final video** only changes what Video Combine muxes, so nothing re-renders.

### Opening folders

The **Open input folder** and **Open output folder** buttons open the folder on the machine
running ComfyUI. They only work when you browse from that machine (a loopback connection with
no proxy headers). From another device, such as over Tailscale, the buttons are hidden and
**Download video** appears instead.

## Tests

`tests/` runs against a real ComfyUI source tree in CPU mode, with no model weights:

- `test_graph_builder.py`: pure Python, no ComfyUI needed. Covers every toggle combination
  (the 8 audio-route combinations, bypassed cast and Shots, LoRAs on and off with and without
  Turbo, Sage missing, NVENC fallback, missing packs) and MiniMax's size table.
- `test_comfy_integration.py`:
  - ComfyUI's own `validate_prompt` accepts every variant, with the real packs loaded.
  - The full core loop (dry run, Start, Continue, Reroll, edit, bypass, audio routes) runs
    through ComfyUI's real executor. Loaders, decoders and the sampler are stand-ins; Long
    Shot, the prompt nodes, LoadImage, KJ resize and VHS are real, and VHS writes a real mp4.
  - Also covers the HTTP routes.
- `test_studio_server.py`: who counts as local, open-folder path safety, portable model names.
- `test_projects.py`:
  - slugs, including non-Latin names;
  - save → reload gives identical state;
  - the slug survives a rename;
  - two-tab conflicts;
  - missing / changed / relinked references;
  - `check-inputs` path refusal;
  - Delete and Clear touch only the chosen files.
- `test_comfy_integration.py` also covers crash-resume. After a simulated restart,
  nothing is re-sampled and the model never loads until a new Shot renders.

```
set COMFYUI_ROOT=C:\path\to\ComfyUI
set MMH3_PROMPT_PACK=%COMFYUI_ROOT%\custom_nodes\H3_Prompt_Compiler
set MMH3_LONGSHOT_PACK=%COMFYUI_ROOT%\custom_nodes\H3_Longshot
set STUDIO_EXTRA_NODES=%COMFYUI_ROOT%\custom_nodes\ComfyUI-KJNodes;%COMFYUI_ROOT%\custom_nodes\ComfyUI-VideoHelperSuite;%COMFYUI_ROOT%\custom_nodes\ComfyUI-MiniMax-H3-Turbo;%COMFYUI_ROOT%\custom_nodes\ComfyUI-MelBandRoFormer;%COMFYUI_ROOT%\custom_nodes\ComfyUI-NVIDIA-RTX-VSR-Pro
python -m pytest tests -q
```

Use your ComfyUI's Python. For the portable build that's `python_embeded\python.exe -m pip install pytest`,
then `python_embeded\python.exe -m pytest ...`. If a pack folder isn't set, the tests that
need it are skipped and say why.
