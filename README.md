# H3 Long Shot Studio

A browser studio for making long AI videos with MiniMax H3, shot by shot. It runs inside
ComfyUI at `/longshot`. Build a film from short Shots, review and approve each one, and the
Studio stitches them into one continuous take or a cut sequence. Approved work is never
thrown away.

<img width="1678" height="1347" alt="image" src="https://github.com/user-attachments/assets/bee0c423-921e-45ad-bfc8-3e415c9d7655" />

<img width="3402" height="1332" alt="image" src="https://github.com/user-attachments/assets/466e77fe-7f4f-4543-afa0-e803ddfb6338" />

## Features

**Generate**
- Reference-to-video like the ComfyUI MiniMax H3 workflow: picture references for
  characters, outfits and places, plus audio references for character voices.
- Join each Shot to its neighbours with **Continuous**, **Bridge**, **Lead in**, **Context**,
  **180°**, **Cutaway** or **Cut** (see [The join chip](#the-join-chip)).
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
- Output the final film at native size, or upscaled in chunks with flat RAM, with an optional ProRes 422 HQ master.
- Export or import a whole project as one .zip.
- **Face refine**: small faces redrawn by H3 as steady close-ups, Shot by Shot, compared A/B.
- **Undo / redo** for every change you make (Ctrl+Z, Ctrl+Shift+Z).

**Images** (0.20.0)
- An **Images** side of every project: stills with the H3 video model or MiniMax-H3-Image from
  one shared set of references (`<Picture 1…N>`), text-to-image or editing a picture (whole, or
  only inside boxes you draw), every result kept, and one click to make a result a Cast & Scenes
  reference.
- An **Outputs** drawer on both sides: browse the project's output folder and drag any
  picture into the references.

## What's new since 0.26.1

- **Handoff care for long Continuous chains** (needs H3 Long Shot 1.10.1). Two ticks on each
  Continuous Shot, both off by default, for static Shots where colour, brightness and grain build
  up from piece to piece:
  - **Colour lock** eases the Shot back to the colour and brightness at the start of its chain
    (no cost). **Let colour change** marks a Shot where the light is meant to change.
  - **Refresh handoff** redraws the frames it's pinned to before pinning them, cleaning the grain
    (about a minute extra per Shot). Strengths are in Advanced.
- **⇄ 180° chip** for shot / reverse-shot conversations: like Context, with the frame from 2 Shots
  back. **Frame from** on any Context, 180° or Cutaway Shot picks the Shot by hand.
- **Region edit** on the Images side: draw boxes on the picture being edited, give each its own
  edit; only the boxes change (**Paste back**, or **Zoom in** for small details).
- **Take prompts**: every take records its prompt. **↺ Take's prompt** and the Takes list put an
  earlier prompt back.
- **📌 Keep seed** on Shots and Picture cards: re-render with the same seed after changing the
  prompt or references.
- **Notes**: adding one opens its Shot's card; **📝 n open** steps through every open note.
- Smaller things: a big **▶ Render** above Image settings, clickable Picture cards, a tidier Shot
  card, a shorter Advanced panel.
- Fixed: exporting a refined face clip failed (needs H3 Long Shot 1.9.1 or later).

## Requirements

- ComfyUI with native MiniMax H3 support, and the MiniMax H3 model files.
- Two node packs (the Studio names any that are missing):

| Pack | Needed for |
|---|---|
| [H3 Prompt Compiler](https://github.com/r34vtraining/H3_Prompt_Compiler) | prompts (always) |
| [H3 Long Shot](https://github.com/r34vtraining/H3_Longshot) **1.10.1+** | rendering, and saving / loading video (always) |

For **Images** (0.20.0): ComfyUI **0.44.0+** (MiniMax H3 Image Conditioning, core) and these
files, each linked from Image settings when it's missing:

| File | Folder | From |
|---|---|---|
| `minimax_h3_image_pruned_int8_convrot.safetensors` (21 GB) | `models/diffusion_models` | [Comfy-Org/MiniMax-H3-Image](https://huggingface.co/Comfy-Org/MiniMax-H3-Image) |
| `minimax_h3_image_vae_fp16.safetensors` | `models/vae` | [Comfy-Org/MiniMax-H3-Image](https://huggingface.co/Comfy-Org/MiniMax-H3-Image) |
| `qwen3vl_32b_minimax_h3_int8_convrot.safetensors` (25 GB) — the video text encoder, shared | `models/text_encoders` | [Comfy-Org/MiniMax-H3](https://huggingface.co/Comfy-Org/MiniMax-H3) |
| `qwen3.5_9b_w4a8_gptq.safetensors` (6 GB, optional: Expand prompt) | `models/text_encoders` | [Comfy-Org/Qwen3.5](https://huggingface.co/Comfy-Org/Qwen3.5) |

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

Every Shot has a chip that sets how it joins the Shot before it. Click it to cycle through the
choices; which ones it offers depends on what's rendered next to it.

| Chip | What it does |
|---|---|
| **Continuous** | Flows on from the Shot before, one longer take. |
| **Bridge** | Continuous between two rendered Shots: pinned at both ends. |
| **Lead in** | Starts fresh and leads into the rendered Shot after it. |
| **Context** | A new angle: a hard cut, with the last frame of the Shot before as a reference. |
| **180°** | Shot / reverse shot: like Context, with the frame from 2 Shots back. |
| **Cutaway** | B-roll: like Context, and the Shot after it continues from the Shot before the cutaway. |
| **Cut** | A fresh shot from the references. |

- **Render all** follows the chips: Continuous chains from the Shot before; Context, 180° and
  Cutaway split the run and wait for the Shot they take their frame from; Cut starts fresh.
- **▶ on one Shot** pins it to the rendered Shots next to it (approved or under review). The
  Shots around it keep their takes.
- Context, 180° and Cutaway use the **Context frame** setting (Small + soft by default, Full or
  Off) and **Frame from** (Auto, or any earlier Shot).

## Tips

- A Shot pinned at both ends has to travel to a fixed end state: give it at least 5 s and
  write the arrival into its text ("…ends with her at the doorway").
- To keep drift from building on long takes, use **▶ Render odd Shots** (each on its own),
  then **Render all** to bridge the gaps.
- Write speaker IDs like (S1) in the Shot text yourself; the Studio only adds the voice lines.
- Everything about a project (references, takes, videos) lives in `input/longshot/<project>`
  and `output/longshot/<project>`, and moves with Rename and Export.
