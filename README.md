# H3 Long Shot Studio

A browser studio for making long AI videos with MiniMax H3, shot by shot. It runs inside
ComfyUI at `/longshot`. Build a film from short Shots, review and approve each one, and the
Studio stitches them into one continuous take or a cut sequence. Approved work is never
thrown away.

<img width="1783" height="1392" alt="image" src="https://github.com/user-attachments/assets/8c8f9a1f-eca5-425d-b337-8eb45297caff" />

## Features

**Generate**
- Reference-to-video like the ComfyUI MiniMax H3 workflow: picture references for
  characters, outfits and places, plus audio references for character voices.
- Join each Shot to its neighbours with **Continuous** (flows on from the Shot before),
  **Bridge** (pinned at both ends), **Context** (a new angle, with the last frame before as a
  reference) or **Cut** (a fresh shot from the references).
- Frame anchors: first or last-frame images at any join.
- **Render all** renders every Shot in order as one flowing chain. Multi-take with seed
  control, a render queue across projects, and an automatic retry when ComfyUI runs out of memory.
- Optional song-driven lip sync.

**Edit**
- A zoomable timeline with one block per Shot: switch takes instantly, loop the seam, approve or
  reroll any Shot **in place** while its neighbours keep their takes.
- Insert, bypass or remove Shots anywhere, including before Shot 1.
- Drop in real video clips as Shots, bridged into the generated footage or hard-cut.
- Take history for every Shot. Nothing samples again unless it has to.

**Deliver**
- Export approved clips, plain or upscaled with RTX Super Resolution.
- Upscale the final film in chunks with flat RAM, with an optional ProRes 422 HQ master.
- Export or import a whole project as one .zip.

## What's new in 0.8.13

Needs Long Shot **1.6.15 or later**.
1. **Cast & Scenes folds** to one line with a summary ("4 pictures · 2 voices · 1 RefMod"), remembered per browser.
2. **Hide the preview**: **▴ Hide preview** (under the timeline, right) folds the video, timeline and controls to one status line: *Rendering Shot 3 · step 12/30* (with a progress bar), *No Shot queued* or *Shot 3 completed*. Click it to show the preview again. Live preview pauses while it's hidden and comes back only if you had it on. Approve / Reroll stay as they are.
3. **Restore references** on a Shot card: puts back the references its take was made with. Removed ones are added again where they were, bypassed ones turned on; the others stay. The Studio lists what comes back and which Shots render again (labels renumber) before it changes anything. Works for takes made from 0.8.13 on.
4. **Live preview**: a switch next to Update preview shows the picture forming on the review screen while a Shot renders.
4b. **Settings → Live preview quality**: one click installs the sharper preview decoder (taeh3, 22 MB); without it the preview is rough colours.

## Previous updates

3. An older ComfyUI (before 0.35.0) is named on the page, and renders stop with "update ComfyUI" instead of failing.
4. Install notes for Windows portable, Desktop (port 8000) and git installs.
5. Timeline mouse controls, editor style: scroll moves along the film, **Alt + scroll** zooms around the cursor, **Ctrl + scroll** makes the timeline taller or shorter to see more of each thumbnail (both remembered per browser).
6. Double-click a Shot on the timeline to jump to its prompt (a clip: its card).
7. Sharper timeline thumbnails for clips made from now on.
8. Zoom the timeline around the cursor, from the whole film down to single frames.
9. Dragging the timeline, or the thin scroll bar under it, scrolls sideways.
10. A time ruler above the Shots (frame ticks when zoomed in). Click it to seek; double-click it to see the whole film.
11. Narrow Shot blocks pop out to full size on hover, so the ◀ take ▶ arrows can always be clicked.
12. The view follows the playhead, and scrolls to a Shot when you pick it (card, Jump to Shot, take arrows). The zoom is remembered per browser.
13. No more Video Helper Suite: videos are saved and clips loaded by H3 Long Shot's own nodes, sound by ComfyUI's Load Audio. Only the Prompt Compiler and Long Shot are required now.
14. Saved videos still carry the workflow (drop one on ComfyUI to reopen it). No PNG or silent copy is written next to them any more.
15. RefMod cards: a row in Cast & Scenes for saved RefMods (characters, styles, motions), each with its own label and subject line.
16. Fewer dependencies: KJNodes and MelBandRoFormer are no longer needed; the default scheduler is ComfyUI's own `beta`.
17. Turbo, RTX upscaling and RefMods are optional, with a **Click to install** button where each is used.
18. A Shot's prompt can be edited while it renders; the card flags that the take was made with the old text.
19. Whole-film decodes (Update preview, Upscale final, ProRes master) run one continuous run at a time, split only at Cut and Context joins. Still one video file; RAM now limits the longest unbroken run, not the film.
20. Before decoding, the Studio checks each run fits in RAM and names the Shots if one doesn't.
21. Up to 256 Shots per project (was 64).
22. ⇅ in the Shots header flips the list: newest Shot on top (remembered per browser).
23. Open output folder opens Approved_Clips, with the focused Shot's clip selected (before any export: the latest video or the clips folder).
24. Rest the mouse on the Retention field to see the markers it takes (fully_preserved, weak_reference, fully_copy…).
25. While the queue has work, the ComfyUI machine stays awake, and the Studio tab keeps its screen on.
26. Context Shots open on a new angle: the frame before is a reference only, never a starting frame.
27. The join chip offers what exists next to the Shot, with Continuous as the default, so Render all chains Shots (and frame anchors) from the start.
28. ▶ on one Shot pins it to the approved Shots next to it; with none approved it renders on its own.
29. Render all shows which Shot is sampling, which are up next, and which are done.
30. Audio references in Cast & Scenes. Link one to a picture in its editor: "gets its voice timbre from <Audio N>".

## Requirements

- ComfyUI with native MiniMax H3 support, and the MiniMax H3 model files.
- Two node packs (the Studio names any that are missing):

| Pack | Needed for |
|---|---|
| [H3 Prompt Compiler](https://github.com/r34vtraining/H3_Prompt_Compiler) | prompts (always) |
| [H3 Long Shot](https://github.com/r34vtraining/H3_Longshot) **1.6.11+** | rendering, and saving / loading video (always) |

ffmpeg is needed (on PATH, or `pip install imageio-ffmpeg` with ComfyUI's Python).

Optional, each with a **Click to install** button in the Studio where it's used:

| Pack | Adds |
|---|---|
| [ComfyUI-MiniMax-H3-Turbo](https://github.com/Larryvrh/ComfyUI-MiniMax-H3-Turbo) | full Turbo support (without it, the Turbo LoRA loads through ComfyUI's stock loader) |
| [ComfyUI-NVIDIA-RTX-VSR-Pro](https://github.com/whmc76/ComfyUI-NVIDIA-RTX-VSR-Pro) | RTX upscaling (RTX GPU) |
| [ComfyUI-MiniMaxH3Mod](https://github.com/Luisacaotica/ComfyUI-MiniMaxH3Mod) | RefMods |

For SageAttention, start ComfyUI with `--use-sage-attention`.

## Install

Needs **ComfyUI 0.35.0 or later** (native MiniMax H3). On an older ComfyUI the page opens but
says to update, and nothing renders.

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/r34vtraining/Longshot_Studio
git clone https://github.com/r34vtraining/H3_Prompt_Compiler
git clone https://github.com/r34vtraining/H3_Longshot
```

Skip any you already have. Then install H3 Long Shot's `requirements.txt` with ComfyUI's own Python:

| ComfyUI | Command (from the folder that holds `ComfyUI`) |
|---|---|
| Windows portable | `python_embeded\python.exe -m pip install -r ComfyUI\custom_nodes\H3_Longshot\requirements.txt` |
| Desktop | in its `.venv`: `.venv\Scripts\python.exe -m pip install -r custom_nodes\H3_Longshot\requirements.txt` |
| git / venv | `python -m pip install -r custom_nodes/H3_Longshot/requirements.txt` (venv active) |

Restart ComfyUI and open `/longshot` on ComfyUI's address:

- portable or git install: **http://127.0.0.1:8188/longshot**
- ComfyUI Desktop: **http://127.0.0.1:8000/longshot** (its port is in Settings → Server Config)

**Updating:** `git pull` in the Studio's and H3 Long Shot's folders, restart ComfyUI, then
hard-refresh the page (Ctrl+Shift+R).

## Getting started

1. In **Settings**, check the model, text encoder, VAEs and Turbo LoRA (the Studio fills in
   the ones it recognises).
2. Drop reference images on **Cast & Scenes** and give each a label (`<hero>`, `<street>`)
   and a short description. Drop a voice clip there too, and link it in the character's editor.
3. Fill in **Style & Sound**, then write your Shots using those labels.
4. Press **▶ Render all**, or render Shot by Shot. Review each one, then **Approve** or **Reroll**.

## The join chip

Every Shot has a chip that sets how it joins its neighbours. Click it to switch.

| Next to the Shot | Choices |
|---|---|
| nothing | Cut |
| a Shot before | Cut · Context · Continuous |
| only a Shot after | Cut · Continuous |

- **Render all** follows the chips: Continuous chains from the Shot before, Context splits
  the run there, Cut starts fresh.
- **▶ on one Shot** pins it to the *approved* Shots next to it. Continuous between two
  approved Shots reads **Bridge** and is pinned at both ends. The Shots around it keep their takes.

## Tips

- A Shot pinned at both ends has to travel to a fixed end state: give it at least 5 s and
  write the arrival into its text ("…ends with her at the doorway").
- To keep drift from building on long takes, use **▶ Render odd Shots** (each on its own),
  then **Render all** to bridge the gaps.
- Write speaker IDs like (S1) in the Shot text yourself; the Studio only adds the voice lines.
- Everything about a project (references, takes, videos) lives in `input/longshot/<project>`
  and `output/longshot/<project>`, and moves with Rename and Export.
