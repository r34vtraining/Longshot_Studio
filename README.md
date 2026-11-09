# H3 Long Shot Studio

Music video made by this API
https://www.youtube.com/watch?v=rPmv9dpM0P8
Short films 
https://youtu.be/2flxMiXXGL8
https://youtu.be/gq6I-muf1AY

A browser studio for making long AI videos with MiniMax H3, shot by shot. It runs inside
ComfyUI at `/longshot`. Build a film from short Shots, review and approve each one, and the
Studio stitches them into one continuous take or a cut sequence. Approved work is never
thrown away.

<img width="1696" height="1350" alt="image" src="https://github.com/user-attachments/assets/af2861fe-43ed-436d-a908-d954a6788a3d" />

## Features

**Generate**
- Reference-to-video like the ComfyUI MiniMax H3 workflow: picture references for
  characters, outfits and places, plus audio references for character voices.
- Join each Shot to its neighbours with **Continuous**, **Bridge**, **Lead in**, **Context**,
  **Cutaway** or **Cut** (see [The join chip](#the-join-chip)).
- Frame anchors: first or last-frame images at any join.
- **Render all** renders every Shot in order as one flowing chain; **Render group** does the same
  for one group. Multi-take with seed control, a render queue across projects (pause, reorder by
  drag), and an automatic retry when ComfyUI runs out of memory.
- Before a render, the `<tags>` in the prompts are checked against the reference cards, so a
  bypassed or misspelled reference is caught before it wastes a render.
- A song as reference audio (`<Audio 1>`) for singing Shots.

**Edit**
- A zoomable timeline with one block per Shot: switch takes instantly, loop the seam, approve or
  reroll any Shot **in place** while its neighbours keep their takes.
- Insert, bypass or remove Shots anywhere, including before Shot 1. Group them into folders by
  scene or act.
- **Line up Shots** for films without a song: every Shot end to end, no overlaps.
- Drop in real video clips as Shots, bridged into the generated footage or hard-cut.
- Take history for every Shot. Nothing samples again unless it has to.
- **Face refine** redraws small faces as close-ups; **Region refine** does the same for anything
  you box by hand (cartoon characters, creatures); **Face swap** gives a face the identity of a
  picture card.

**Deliver**
- Export approved clips, plain or upscaled with RTX Super Resolution.
- Output the final film at its own size, or upscaled 2× in chunks with flat RAM, with an optional
  ProRes 422 HQ master.
- Dialogue and SFX stems as separate .wav files.
- Export or import a whole project as one .zip.

## What's new in 0.18.5

1. **Face swap.** In the Face refine panel, pick a Shot's take or any video file, choose the picture
   card for the new face, and the ref2va model redraws the face as that person, keeping the head
   movement, expression and mouth. One face swaps the largest face found; for up to four faces, draw
   a box around each and give each its own picture. Results go to `<project>/Face_Swap`.
   Needs H3 Long Shot 1.9.0 and a ref2va model.
2. **Region refine.** For faces the detector can't see (cartoon characters, creatures), draw a box on
   the first and last frame and describe what's in it. The box follows a straight line between key
   frames.
3. **Line up Shots.** When you're not syncing to music, placement on the timeline doesn't matter:
   tick Line up Shots under the timeline and every Shot starts where the one before ends, with no
   second track. It's on by itself in projects without a song.
4. **Rearrange approved Shots.** Approved Cut, Context and Cutaway Shots can now be dragged to a new
   place in the Shots list and keep their takes. Continuous and Lead in Shots stay put.
5. **Reference check.** Before a render, Studio reads the `<tags>` in the prompts and checks them
   against the reference cards. A bypassed card, a label no card has, or `<Picture 6>` with only five
   pictures on gets flagged, with **Turn on and render**, **Render anyway** or **Cancel**.
6. **Better queue.**
- **Pause now** stops the running job and puts it back first in line; on Resume it picks up the
  Shots it had already finished. **Pause after it** lets it finish first.
- Drag waiting jobs to any place in line (▲ ▼ still work).
- A page refresh in the middle of a render no longer loses it: Studio follows it again, or saves its
  take if it finished during the refresh.
7. **Easier references.** One drop bar in Cast & Scenes takes pictures, videos and audio together and
  sorts each into its own row. Active reference cards have a thicker border, so it's easier to see
  what's on.
8. **Project window.** Sort by date or name, scroll, and drag projects into folders by project type.
9. **Smaller things.** GPU temperature in the top bar, group bypass button, Settings stays folded
  after a refresh, the page no longer jumps when you change a chip, and Alt + mouse wheel never goes
  back a page.

## What's new in 0.17.32

1. Group folders, you can now group your shots by scenes, act, etc.  One button to restore all the reference that was used for that group.  
2. Audio separation.  Didn't matter too much with a music video, but with a short film the dialogue and sfx often clash, so a stems detector will output .wav files for both dialogue and sfx separately.  
3. Added more options for consecutive shots.  
- Cut (a hard cut shot)
- Context (a shot that takes the last frame of the previous shot as a reference)
- Bridge (connect 2 shots together)
- Lead In (transition into a shot after it)
- Cutaway (a context shot that connects to the previous shot but is not seen by the following shot, mainly used for B-roll shots)
- Continuous (making longer and longer continuous shot)

## What's new in 0.17.0

**Several Studio tabs at once**, each on its own project.

1. Each tab has its own queue and runs its own jobs; ComfyUI takes the runs one at a time, in the order they arrive (a tab whose run waits behind another tab's says so). Progress, previews and results go to the tab that queued them.
2. A duplicated tab gets its own identity (it no longer steals the other tab's progress).
3. One project, one tab: a project open in another tab can't be opened in a second one (two tabs would save over each other); the project list marks it "open in another tab". A new tab opens the last project that isn't open elsewhere.
4. A job queued in one tab for a project that's open in another tab moves to that tab when its turn comes, so the result lands where the project is open.
5. The queue panel also lists what the other tabs have queued (greyed). If a tab closes with jobs still waiting, another Studio tab picks them up.
6. Lip Sync function works now.  See Audio tab for audio control for lip syncing.
7. Face Refine Added, refine selected clip then export them as approved clips.  
8. Stackable timelines for overlapping clips with handles for easier editing.
   
## Requirements

- ComfyUI with native MiniMax H3 support, and the MiniMax H3 model files.
- Two node packs (the Studio names any that are missing):

| Pack | Needed for |
|---|---|
| [H3 Prompt Compiler](https://github.com/r34vtraining/H3_Prompt_Compiler) | prompts (always) |
| [H3 Long Shot](https://github.com/r34vtraining/H3_Longshot) **1.7.0+** | rendering, and saving / loading video (always) |
| [H3 Long Shot](https://github.com/r34vtraining/H3_Longshot) **1.8.2+** | Face refine and Region refine |
| [H3 Long Shot](https://github.com/r34vtraining/H3_Longshot) **1.9.0+** | Face swap (with a ref2va model) |

ffmpeg is needed (on PATH, or `pip install imageio-ffmpeg` with ComfyUI's Python).

Optional, each with a **Click to install** button in the Studio where it's used:

| Pack | Adds |
|---|---|
| [ComfyUI-MiniMax-H3-Turbo](https://github.com/Larryvrh/ComfyUI-MiniMax-H3-Turbo) | full Turbo support (without it, the Turbo LoRA loads through ComfyUI's stock loader) |
| [ComfyUI-NVIDIA-RTX-VSR-Pro](https://github.com/whmc76/ComfyUI-NVIDIA-RTX-VSR-Pro) | RTX upscaling (RTX GPU) |
| [ComfyUI-MiniMaxH3Mod](https://github.com/Luisacaotica/ComfyUI-MiniMaxH3Mod) | RefMods |

Also optional: the MTCNN face detector for Face refine (a **Download face detector** button in the
Face refine panel, about 2 MB), and Kijai's `MelBandRoformer_fp16.safetensors` in
`models/diffusion_models` for dialogue / SFX stems.

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

Every Shot has a chip that sets how it joins its neighbours. Click it to cycle through the
choices; which ones it offers depends on what's rendered next to it.

| Chip | What it does |
|---|---|
| **Cut** | A fresh shot from the references, a hard cut. |
| **Context** | A new angle: a hard cut, with the last frame of the Shot before as a reference. |
| **Cutaway** | A Context Shot the next Shot doesn't see: the Shot after it continues from the Shot before the cutaway (B-roll). |
| **Continuous** | Flows on from the Shot before, one longer take. |
| **Bridge** | Continuous between two rendered Shots: pinned at both ends. |
| **Lead in** | Starts fresh and leads into the rendered Shot after it. |

- **Render all** and **Render group** follow the chips: Continuous chains from the Shot before,
  Context splits the run there, Cut starts fresh.
- **▶ on one Shot** (and every other render button) follows its chip and pins it to the rendered
  Shots next to it (approved or under review). The Shots around it keep their takes.
- Takes made at another resolution can't be joined: change the resolution back, or re-render
  those Shots at the new size, working forward from the first one.

## Tips

- A Shot pinned at both ends has to travel to a fixed end state: give it at least 5 s and
  write the arrival into its text ("…ends with her at the doorway").
- To keep drift from building on long takes, use **▶ Render odd Shots** (each on its own),
  then **Render all** to bridge the gaps.
- Write speaker IDs like (S1) in the Shot text yourself; the Studio only adds the voice lines.
- Face swap: start at denoise 0.6. Raise it toward 0.7 if the old face shows through, lower it
  toward 0.5 if the mouth drifts from the dialogue.
- Everything about a project (references, takes, videos) lives in `input/longshot/<project>`
  and `output/longshot/<project>`, and moves with Rename and Export.
