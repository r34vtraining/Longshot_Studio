# H3 Long Shot Studio

A browser studio for making long AI videos with MiniMax H3, shot by shot. It runs inside
ComfyUI at `/longshot`. Build a film from short Shots, review and approve each one, and the
Studio stitches them into one continuous take or a cut sequence. Approved work is never
thrown away.

<img width="1701" height="1390" alt="image" src="https://github.com/user-attachments/assets/2c2f4718-efc1-4be3-8682-c9d13481effa" />

## What's new in 0.8.5
1. Whole-film decodes (Update preview, Upscale final, ProRes master) run one continuous run at a time, split only at Cut and Context joins. Still one video file; RAM now limits the longest unbroken run, not the film.
2. Before decoding, the Studio checks each run fits in RAM and names the Shots if one doesn't.
3. Up to 256 Shots per project (was 64).
4. ⇅ in the Shots header flips the list: newest Shot on top (remembered per browser).

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
- A timeline with one block per Shot: switch takes instantly, loop the seam, approve or
  reroll any Shot **in place** while its neighbours keep their takes.
- Insert, bypass or remove Shots anywhere, including before Shot 1.
- Drop in real video clips as Shots, bridged into the generated footage or hard-cut.
- Take history for every Shot. Nothing samples again unless it has to.

**Deliver**
- Export approved clips, plain or upscaled with RTX Super Resolution.
- Upscale the final film in chunks with flat RAM, with an optional ProRes 422 HQ master.
- Export or import a whole project as one .zip.

## What's new in 0.8.4

Needs H3 Long Shot **1.6.9 or later**.

1. Context Shots open on a new angle: the frame before is a reference only, never a starting frame.
2. The join chip offers what exists next to the Shot, with Continuous as the default, so Render all chains Shots (and frame anchors) from the start.
3. ▶ on one Shot pins it to the approved Shots next to it; with none approved it renders on its own.
4. Render all shows which Shot is sampling, which are up next, and which are done.
5. Audio references in Cast & Scenes. Link one to a picture in its editor: "gets its voice timbre from <Audio N>".

## Requirements

- ComfyUI with native MiniMax H3 support, and the MiniMax H3 model files.
- These node packs (the Studio names any that are missing):

| Pack | Needed for |
|---|---|
| [H3 Prompt Compiler](https://github.com/r34vtraining/H3_Prompt_Compiler) | prompts (always) |
| [H3 Long Shot](https://github.com/r34vtraining/H3_Longshot) **1.6.9+** | rendering (always) |
| [ComfyUI-KJNodes](https://github.com/kijai/ComfyUI-KJNodes) | reference resizing (always) |
| [ComfyUI-VideoHelperSuite](https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite) | video and audio (always) |
| [ComfyUI-MiniMax-H3-Turbo](https://github.com/Larryvrh/ComfyUI-MiniMax-H3-Turbo) | Turbo LoRA (optional) |
| [ComfyUI-MelBandRoFormer](https://github.com/kijai/ComfyUI-MelBandRoFormer) | the song's voice as a reference (optional) |
| [ComfyUI-NVIDIA-RTX-VSR-Pro](https://github.com/whmc76/ComfyUI-NVIDIA-RTX-VSR-Pro) | RTX upscaling, RTX GPU (optional) |

The default scheduler, `beta57`, comes from [RES4LYF](https://github.com/ClownsharkBatwing/RES4LYF);
without it, pick another under **Advanced**.

## Install

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/r34vtraining/Longshot_Studio
git clone https://github.com/r34vtraining/H3_Prompt_Compiler
git clone https://github.com/r34vtraining/H3_Longshot
git clone https://github.com/kijai/ComfyUI-KJNodes
git clone https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite
```

Skip any you already have, and install each pack's `requirements.txt` with ComfyUI's Python.
Restart ComfyUI and open **http://127.0.0.1:8188/longshot**.

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
