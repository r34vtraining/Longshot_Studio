# H3 Long Shot Studio

Music video made by this API
https://www.youtube.com/watch?v=rPmv9dpM0P8

A browser studio for making long AI videos with MiniMax H3, shot by shot. It runs inside
ComfyUI at `/longshot`. Build a film from short Shots, review and approve each one, and the
Studio stitches them into one continuous take or a cut sequence. Approved work is never
thrown away.

<img width="1664" height="1391" alt="image" src="https://github.com/user-attachments/assets/1bbec1f2-a77c-4f08-bf14-9012c3430b23" />

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
- A song as reference audio (`<Audio 1>`) for singing Shots.

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
- **▶ on one Shot** pins it to the rendered Shots next to it (approved or under review); a
  Continuous neighbour still queued or rendering is waited for. Continuous between two
  rendered Shots reads **Bridge** and is pinned at both ends. The Shots around it keep their takes.

## Tips

- A Shot pinned at both ends has to travel to a fixed end state: give it at least 5 s and
  write the arrival into its text ("…ends with her at the doorway").
- To keep drift from building on long takes, use **▶ Render odd Shots** (each on its own),
  then **Render all** to bridge the gaps.
- Write speaker IDs like (S1) in the Shot text yourself; the Studio only adds the voice lines.
- Everything about a project (references, takes, videos) lives in `input/longshot/<project>`
  and `output/longshot/<project>`, and moves with Rename and Export.
