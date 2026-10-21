# H3 Long Shot Studio

A browser studio for making long AI videos with MiniMax H3, shot by shot. It runs inside
ComfyUI at `/longshot`. Build a film from short Shots, review and approve each one, and the
Studio stitches them into one continuous take or a cut sequence. Approved work is never
thrown away.

<img width="2166" height="1493" alt="H3 Long Shot Studio" src="https://github.com/user-attachments/assets/543bc5fd-05bf-45dd-9557-f36327e8c935" />

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

## What's new in 0.13.3

1. **Turning the song on or off no longer redoes the upscaled export.** Each upscaled clip now remembers its picture (take, upscale settings, trim, refine) and its sound apart. When only the sound changed (Song in final video on or off, or the song's place), Export approved clips keeps the upscaled picture and mixes the sound again with ffmpeg, in seconds: the song, or the take's own sound from its clip. Handy for b-roll without music. The first upscaled export after updating redoes the clips once.

## What's new in 0.13.2

1. The enlarged (theater) viewer keeps its clickable **▾ Preview** title; clicking it folds the preview, which also leaves theater. The theater picture is sized so the controls under it stay on screen.

## What's new in 0.13.1

1. Fixed: **Export approved clips with Upscale with RTX failed** ("too many values to unpack") when the project had no Approved_Clips folder yet (since 0.12.8).

## What's new in 0.13.0

**Several Studio tabs at once**, each on its own project.

1. Each tab has its own queue and runs its own jobs; ComfyUI takes the runs one at a time, in the order they arrive (a tab whose run waits behind another tab's says so). Progress, previews and results go to the tab that queued them.
2. A duplicated tab gets its own identity (it no longer steals the other tab's progress).
3. One project, one tab: a project open in another tab can't be opened in a second one (two tabs would save over each other); the project list marks it "open in another tab". A new tab opens the last project that isn't open elsewhere.
4. A job queued in one tab for a project that's open in another tab moves to that tab when its turn comes, so the result lands where the project is open.
5. The queue panel also lists what the other tabs have queued (greyed). If a tab closes with jobs still waiting, another Studio tab picks them up.

## What's new in 0.12.10

1. Picture, audio and RefMod cards show the **label first** and `<Picture N>` / `<Audio N>` after it, smaller; when the card is narrow the number gives way, so the label stays readable.

## What's new in 0.12.9

1. **Dry run works with mixed sizes:** Shots made at another size than Settings make now are left out of it (Long Shot can't load them at this size), and the box lists them at the top.
2. **A dry run that stops with an error still opens its box**, with the error in it.

## What's new in 0.12.8

1. Fixed: **Export approved clips with Upscale with RTX redid every clip** after you approved, trimmed or moved any Shot. Each exported clip now remembers what it was made with on its own (its take, the upscale settings, its own trim / place in the song, and the refine when it's on), so only new or changed Shots are upscaled; the rest stay. The first export after updating redoes them once.

## What's new in 0.12.7

1. **Clips at different resolutions.** Changing Resolution or Aspect no longer re-renders approved Shots: they keep their takes at the size they were made (Shots under review render again). A dialog says what mixed sizes mean.
2. A Shot made at another size than Settings make now shows its size on its card (e.g. `1056×608`).
3. **No pins across sizes:** H3 shares latent frames only at one size, so a new Shot next to one of another size isn't pinned to it (a hard cut there; its chip and the render's note say so). Shots of the same size join as before. Setting the size back makes them match again.
4. **Stitched work needs one size:** Update preview, Upscale final and Refine on export say which Shots differ and stop. **Export approved clips** works with mixed sizes (each clip at its own), with or without Upscale with RTX.
5. The preview screen (theater and fullscreen) keeps the Settings aspect; a clip of another size is scaled to fit, with black bars when its aspect differs.
6. Resolution adds **1.3, 1.4, 1.6, 1.7 and 1.9 MP**.

## What's new in 0.12.6

1. **The song stays in sync when you click into the timeline.** Browsers jump into an mp3 (or m4a) by estimate, so after clicking a clip the song could play a fraction of a second late. The Studio now plays an uncompressed WAV copy of the song (made once with ffmpeg in ComfyUI's temp folder, and again only if the song file changes), where every jump is exact. Your song file is untouched, and renders still use it. A WAV song is played as is.
2. The song is re-synced to the picture when it drifts more than 0.08 s (was 0.25 s).

## What's new in 0.12.5

1. **aligned ✓** on a rendered Shot card: once you've lined a Shot up with the song by hand (Alt + ← / →; the empty Shots around it make room), click **aligned** to mark it. It turns green, the timeline block shows a ✓, and the Shot (with its Continuous run) stays put: Alt + ← / → and reset won't move it until you click the mark again. A new take (re-render, reroll) clears the mark.
2. **check sync / align are gone** from the Shot cards: they compared the take's own sound with the song, and the fl2va model's sound doesn't match its picture, so it couldn't line up the mouth.

## What's new in 0.12.4

1. **Task type buttons above the Summary** (Style & Sound): keyframe completion, reference generation, video editing, video continuation, audio reuse, audio reference. Click to turn one on (amber), again to turn it off; up to 3, in the order you click them, plus **Clear**. The line under them shows how the summary starts, e.g. `[reference generation + audio reference]`. With none on, it's "reference generation". "audio reuse" shows as *auto* when the Studio adds it (the song as <Audio 1>, or an audio reference set to Copy). They're for the whole project; a Summary you start with `[ … ]` yourself is used as written.

## What's new in 0.12.3

1. **Preview and Shots fold from their titles**, like the other panels: click **▾ Preview** or **▾ Shots** on the top left. Folded, Preview keeps its status line (rendering / done, with the progress bar) and Shots shows how many Shots and how many are approved. The old "▴ Hide preview" / "Show preview" buttons are gone.

## What's new in 0.12.2

1. **Space plays the song when the Audio panel is selected.** Click anywhere in the Audio panel (it gets a thin amber outline) and Space plays / pauses the song only, from the playhead; click anywhere else and Space plays the video again. Typing in the panel's fields is unchanged.
2. Fixed: Space on the song's scrub bar no longer starts the video player at the same time.

## What's new in 0.12.1

1. **A RefMod's definition is yours to pick** (its editor, *Definition*): appearance, motion, action, expression, pose, costume, style, scene, environment or camera and cut structure. A RefMod made from 2+ images comes out as a video (<Video N>) and can now stay "appearance". Left alone it follows the kind, as before (picture: appearance, video: motion; audio is always voice timbre).

## What's new in 0.12.0

1. **Audio references and RefMods open the pop-out editor**, like picture cards (click the card or ✎). The card stays a short summary.
   - Audio: label, what it is, description, a bigger player with **Set start** / **Set end** for the trim, Replace file, and (for a voice) the pictures and RefMods it voices.
   - RefMod: label, description, which RefMod (its kind follows), strength, and its voice.
2. **Audio references can stand on their own.** Set *What it is* to Sound effect, Ambience, Music or your own word, give it a label and a description, and choose **Reference** (the character of the sound) or **Copy** (reuse the audio as it is). The prompt gets e.g. "<sfx> is cars driving by, whose sound comes from <Audio 2>." and a matching retention line; Copy adds "audio reuse" to the summary. Voice timbre cards work as before.
3. **The Refine panel sits above Settings.**
4. **Voices both ways:** a picture or video RefMod can get its voice timbre from an audio reference or an audio RefMod, and a picture card's voice list includes audio RefMods. The prompt writes the matching subject and retention lines.
5. Fixed: an audio RefMod's <Audio N> now counts the song as <Audio 1>.

## What's new in 0.11.0

1. **Shots with an empty prompt are placeholders.** They never render (Render all, ▶ and Continuous chains skip them) and hold their exact length on the film, to the frame. The Shot after one starts fresh. The card reads "holds time".
2. **Placeholders make room.** Alt + ← / → on a Shot (or its Continuous run) lengthens the empty Shot before it and shortens the empty Shot after it, so nothing else on the film moves. Next to a rendered Shot the move trims, as before.
3. **Phrase markers** (Audio panel): press **M** while the song plays (or **+ Mark**) where singing starts after a pause; drag a marker to move it, double-click to delete it. **Detect** suggests them from the full mix (the centre channel in the voice range; Min pause and Sensitivity tune it). They show on the scrub bar and on the timeline ruler.
4. **▸ next phrase** on a Shot card moves the Shot so it starts on the next marker (the empty Shot before it makes room), with optional **Lead-in** frames. Useful with the fl2va model, which sings from the Shot's first frame.
5. **check sync / align** on a rendered Shot: its own audio (H3's performance of the song) is decoded and compared with the song where it sits; the card shows e.g. "sung 1.50 s early · align", and **align** moves it by that much.
6. The Audio panel's lip-sync note now says how each model handles timing.

## What's new in 0.10.0

Needs H3 Long Shot **1.7.0 or later** for the refine pass.

1. **Refine** panel (folds like the others): resample each take with a second model, e.g. the sharper **fl2va** model over takes made with **ref2va** (the lip-sync model). Set the **model**, **steps**, **denoise**, **video shift** and its own **Turbo LoRA** (on/off, file, strength). Lower denoise or a lower video shift (3–5) keeps the motion and lip timing; higher lets the refine model change more.
2. **Every render:** each Shot is refined right after it's sampled, and the refined take *is* the take (its clip too); the next Continuous Shot continues from its refined end.
3. **Refine on export only:** renders stay quick and unrefined; **Export approved clips** and **Upscale final** refine the takes first, in film order, keep them and reuse them for the next export while the settings stay the same. (Export approved clips then goes through ComfyUI, upscaled or not.)
4. Takes made with the refine model itself are never refined (each take now records the model that made it). The panel says how many takes an export refines.
5. **Times are in seconds again everywhere** (0:13.67), like the Shots' Seconds field; the Audio panel's Start and Length take seconds (or minutes:seconds).

## What's new in 0.9.5

1. **"Song pinned to the timeline" is gone from the Audio panel.** Tested on the fl2va model, it didn't steer lip timing (the singing changed with every reroll). Lip sync is **Song as <Audio 1>** with the **ref2v model**; the Audio panel now says so at the top. Long Shot's Song Track node is unchanged for anyone wiring it by hand.

## What's new in 0.9.4

1. Fixed the Settings seed row: Seed, Seed mode, Reset Shot seeds and Multi-take are laid out as before, with ▲ ▼ next to the seed.

## What's new in 0.9.3

Needs H3 Long Shot **1.6.19 or later** for the pinned song.

1. **Song pinned to the timeline** (Audio panel) is back, for the fl2v model: each Shot's part of the song is laid on its own frames, moment by moment, from where its take starts on the film: the same places as `<Audio 1>` (overlaps, Cut / Continuous, trims, moves and the Sync nudge included). Use it on its own, or together with **Song as <Audio 1>** to compare.
2. Turning either song switch on or off, or changing Start, doesn't re-queue Shots: it's for the Shots you render from then on.

## What's new in 0.9.2

Needs H3 Long Shot **1.6.18 or later** for each Shot's own part of the song.

1. **Each Shot gets the part of the song under it as `<Audio 1>`.** The Studio works out where each take's first frame lands on the film (lengths snapping to H3's frame grid, overlaps, trims and moves included) and gives that Shot the song from there. Audio **Start** is now where the film's 00:00:00 sits in the song: leave it at 00:00:00 when the song starts with the film. You only set the Shots' timing.
2. **A Cut or Context Shot shows its whole take**, nothing hidden, right where the Shot before ends. The card's ♪ shows the whole of it (e.g. 00:13:16–00:18:20 after 14 s of other Shots).
3. **Sync nudge** (Audio panel, in frames): if H3 sings a little late, each Shot's song slice starts that many frames later in the song so the singing lands on time. Negative for early. Applies to Shots rendered from then on.
4. **Times as seconds and frames** (MM:SS:FF at 24 fps, like an editor) everywhere: cards, timeline, player, trims, the scrub bar, and the Audio panel's Start and Length (type 00:13:16, or seconds like 13.67).
5. **Song in final video is back**: clips, the timeline, exports and the film carry the original song at each Shot's place. Playback of the song under the film no longer stutters.
6. **Continuous Shots move together**: Alt + ← / → on any of them moves the whole run; the run's outer edges trim.
7. **Seed ▲ ▼** on each Shot's seed and on Settings' seed. On a Shot on auto, ▲ ▼ gives it its own seed, one from its last take's; Shots left on auto keep following Settings.
8. **Queue ⇅** shows the latest job on top (remembered per browser); the run order stays the same.

## What's new in 0.9.1

Lip sync goes back to how MiniMax's own Reference to Video node does it: the song is a reference audio.

1. **The song is `<Audio 1>`.** With **Song as <Audio 1>** on (Audio panel), the song from Start for Length goes into every Shot as reference audio, like the native node's `ref_audio`. Length 0 uses the length of the Shots being rendered. Voice references in Cast & Scenes follow as `<Audio 2>`, `<Audio 3>`.
2. **The prompt says so.** While it's on, the Studio adds "audio reuse" to the summary and the retention line `<Audio 1> (the song): fully_copy`.
3. **Set Start by hand for now.** Changing Start or Length doesn't re-render anything. A Shot card's ♪ shows where it sits in the song (from 0:00): use that as Start when you render it.
4. **Scrub bar** in the Audio panel: the song from Start for Length (both 0: the whole song) with its waveform. Click or drag to move the playhead, ← / → to nudge it, Space to play from there. **Set start** and **Set end** put Start or the end (Length) at the playhead.
5. **"Lip sync to song" and "Song in final video" are off for now** (and the 0.9.0 song-under-the-film extras with them); the video's sound is H3's own. Long Shot's Song Track and Song Cut nodes are unchanged.

## What's new in 0.9.0

Needs H3 Long Shot **1.6.17 or later** for lip sync to keep its place in the song.

1. **Each Shot keeps its place in the song.** Blank or unrendered Shots before it count toward its position, gaps in the middle too, so a Shot after 45 s of other Shots lip-syncs to 0:45 without touching Audio Start. The Shot card shows where it sits: ♪ 0:45.17–0:50.33.
2. **The real song in every output** with "Song in final video" on: each Shot's clip, the timeline, Export approved clips, Update preview and Upscale final all carry the song at the Shot's place in it.
3. **Trim handles** on free edges (Cut and Context joins, the film's start and end): drag to trim, frame by frame, with an in/out readout. Nothing re-renders, and dragging back restores the frames. Dragging the right edge of a Shot not rendered yet sets its seconds. Trims carry into every output; the card shows ✂ with a reset.
4. **Alt + ← / →** moves the selected Shot one frame along the film, overwriting: frames it covers become its neighbour's trim, the side it leaves turns black. Only for Shots with free edges on both sides.
5. **▶ with Continuous** follows on from a Shot under review, and waits for one still queued or rendering, instead of rendering on its own.

## What's new in 0.8.13

1. **Cast & Scenes folds** to one line with a summary ("4 pictures · 2 voices · 1 RefMod"), remembered per browser.
2. **Hide the preview**: **▴ Hide preview** (under the timeline, right) folds the video, timeline and controls to one status line: *Rendering Shot 3 · step 12/30* (with a progress bar), *No Shot queued* or *Shot 3 completed*. Click it to show the preview again. Live preview pauses while it's hidden and comes back only if you had it on. Approve / Reroll stay as they are.
3. **Restore references** on a Shot card: puts back the references its take was made with. Removed ones are added again where they were, bypassed ones turned on; the others stay. The Studio lists what comes back and which Shots render again (labels renumber) before it changes anything. Works for takes made from 0.8.13 on.

## What's new in 0.8.12

Best with H3 Long Shot **1.6.15 or later**.

1. **Live preview costs no measurable speed** with H3 Long Shot 1.6.15: both the rough and the sharp (taeh3) preview run behind the render. Measured with the model partly in VRAM: 31.4 s/step off, 31.4 s/step with the rough preview (the sharp one now runs the same way). Older Long Shot versions wait for the GPU at every step, about 30–40% slower in that case; the switch's tooltip says which applies.

## What's new in 0.8.11

Live preview switches mid-render with H3 Long Shot **1.6.13 or later**.

1. The Live preview switch takes effect at the next sampling step, also while a Shot renders: on shows the picture right away, off stops the extra decoding (and its VRAM) right away. With an older Long Shot it applies from the next render.

## What's new in 0.8.10

Works with H3 Long Shot 1.6.11; **1.6.12** makes live previews show new footage instead of the overlap.

1. **Live preview**: a switch next to Update preview shows the picture forming on the review screen while a Shot renders.
2. **Settings → Live preview quality**: one click installs the sharper preview decoder (taeh3, 22 MB); without it the preview is rough colours.
3. An older ComfyUI (before 0.35.0) is named on the page, and renders stop with "update ComfyUI" instead of failing.
4. Install notes for Windows portable, Desktop (port 8000) and git installs.

## What's new in 0.8.9

1. Timeline mouse controls, editor style: scroll moves along the film, **Alt + scroll** zooms around the cursor, **Ctrl + scroll** makes the timeline taller or shorter to see more of each thumbnail (both remembered per browser).
2. Double-click a Shot on the timeline to jump to its prompt (a clip: its card).
3. Sharper timeline thumbnails for clips made from now on.

## What's new in 0.8.8

1. Zoom the timeline around the cursor, from the whole film down to single frames.
2. Dragging the timeline, or the thin scroll bar under it, scrolls sideways.
3. A time ruler above the Shots (frame ticks when zoomed in). Click it to seek; double-click it to see the whole film.
4. Narrow Shot blocks pop out to full size on hover, so the ◀ take ▶ arrows can always be clicked.
5. The view follows the playhead, and scrolls to a Shot when you pick it (card, Jump to Shot, take arrows). The zoom is remembered per browser.

## What's new in 0.8.7

Needs H3 Long Shot **1.6.11 or later**.

1. No more Video Helper Suite: videos are saved and clips loaded by H3 Long Shot's own nodes, sound by ComfyUI's Load Audio. Only the Prompt Compiler and Long Shot are required now.
2. Saved videos still carry the workflow (drop one on ComfyUI to reopen it). No PNG or silent copy is written next to them any more.

## What's new in 0.8.6

1. RefMod cards: a row in Cast & Scenes for saved RefMods (characters, styles, motions), each with its own label and subject line.
2. Fewer dependencies: KJNodes and MelBandRoFormer are no longer needed; the default scheduler is ComfyUI's own `beta`.
3. Turbo, RTX upscaling and RefMods are optional, with a **Click to install** button where each is used.
4. A Shot's prompt can be edited while it renders; the card flags that the take was made with the old text.

## What's new in 0.8.5

Needs H3 Long Shot **1.6.10 or later**.

1. Whole-film decodes (Update preview, Upscale final, ProRes master) run one continuous run at a time, split only at Cut and Context joins. Still one video file; RAM now limits the longest unbroken run, not the film.
2. Before decoding, the Studio checks each run fits in RAM and names the Shots if one doesn't.
3. Up to 256 Shots per project (was 64).
4. ⇅ in the Shots header flips the list: newest Shot on top (remembered per browser).

## What's new in 0.8.4

1. Open output folder opens Approved_Clips, with the focused Shot's clip selected (before any export: the latest video or the clips folder).
2. Rest the mouse on the Retention field to see the markers it takes (fully_preserved, weak_reference, fully_copy…).
3. While the queue has work, the ComfyUI machine stays awake, and the Studio tab keeps its screen on.

## What's new in 0.8.3

Needs H3 Long Shot **1.6.9 or later**.

1. Context Shots open on a new angle: the frame before is a reference only, never a starting frame.
2. The join chip offers what exists next to the Shot, with Continuous as the default, so Render all chains Shots (and frame anchors) from the start.
3. ▶ on one Shot pins it to the approved Shots next to it; with none approved it renders on its own.
4. Render all shows which Shot is sampling, which are up next, and which are done.
5. Audio references in Cast & Scenes. Link one to a picture in its editor: "gets its voice timbre from <Audio N>".

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
