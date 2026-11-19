# TuffYTP v2 — The Omega Upgrade

The goal: a YTP of every One Piece episode, 5–9 minutes each. That means cutting characters and faces out of scenes, keeping them in a bank, and dropping them back in anywhere for running jokes. This spec covers what's built and what comes next, in build order. Like the v1 spec, stop after each milestone so it can be tested.

Hardware target: Windows PC with an **RTX 2070 (8 GB VRAM)**. The app itself must stay small. Anything AI-heavy is an **optional add-on** that downloads on first use.

---

## Milestone 1 — Layers ✅ built

The main track is unchanged: clips play back to back, effects chop and swap pieces, and it sets how long the video is. **Layers** stack on top of it.

- **Data model** (`src/shared/layers.ts`): `Project.layers: Layer[]` (bottom first). A `Layer` has a name, hidden/muted flags, and `OverlayClip`s that float at a fixed `start` time.
- **Overlay clip**: its source is media (`mediaId`, `in`, `out`) or text. It also has transform keyframes (x, y, scale, rotation, with easing: linear, smooth or hold), opacity, a blend mode (normal, add, screen, multiply, overlay, darken, lighten, difference), fade in/out, volume, and an optional **chroma key**.
- **Keyframes**: a clip starts still. Press **K** (or ◆ Keyframe) to start animating. After that, moving it at another time adds a keyframe there, After Effects style.
- **Preview** (`src/renderer/timeline/compositor.ts`): a canvas draws the main track's frame plus every active layer clip. Keying runs per pixel using the same maths as ffmpeg's `colorkey`, and keyframes interpolate with the same shared code as the export, so what you see is what you export. In the preview you can drag to move, wheel to scale, Shift+wheel to rotate, and pick the key colour with the eyedropper.
- **Timeline**: layer lanes sit above the main track and share its zoom and scroll. Drag clips to move them in time or between layers, and drag their edges to trim. Keyframes show as diamonds, and stripes mark anything past the end of the video.
- **Effects on layers**: with a layer clip selected, every effect button renders that clip instead of the main track, and its position, motion and key stay as they are. You can SUS a keyed Luffy without setting him up again.
- **Export** (`src/main/composite.ts`): the main track is joined first. Then each layer clip becomes an RGBA stream that gets keyed, faded and warped into place with `perspective` (one filter does move, scale and rotate, and it follows keyframes frame by frame), then overlaid or blended. Clips go in batches of 24 per ffmpeg pass so a video with hundreds of layer clips doesn't open hundreds of decoders at once. Passes before the last one keep near-lossless video and PCM audio.
- **Text**: Impact (falls back to a bold sans) with an outline, one `drawtext` per line so every line is centred. The text is read from a file, so no escaping problems.
- **Undo** covers layers. Dragging a slider folds into one undo step.
- **Files from before layers** load fine (`withLayers`).

Shortcuts with a layer clip selected: **K** keyframe, **S** split, **Delete** delete, **Ctrl+D** duplicate, **Esc** deselect. **T** adds text at the playhead.

---

## Milestone 2 — Transparent media (alpha) ✅ built

Zoro's hair is green, so cutouts need real transparency, not just a key colour.

- `MediaFile.alphaPath` points at **`alpha.webm`**, which is VP9 with `yuva420p` plus Opus sound, next to the usual `media.mp4`. Layers use the transparent copy. The main track, bin thumbnails and waveforms keep using `media.mp4`, where the see-through parts are filled with a solid colour.
- **Import**: PNGs, GIFs and VP9 WebMs with alpha (anything ffprobe reports with an alpha pixel format, `alpha_mode=1`, or a paletted PNG/GIF) get the transparent copy as well. The house file fills the clear parts with black (`premultiply`).
- ffmpeg only keeps VP9 alpha when reading with **`-c:v libvpx-vp9`** (its own decoder drops it), so every read of `alpha.webm` goes through `alphaInputArgs`.
- **Preview**: Chromium plays VP9 alpha in `<video>`, and `drawImage` keeps the transparency, so the compositor just picks `alpha.webm`.
- **Effects on transparent layer clips** (`keepAlpha`): the render reads the transparent copy and writes both files in one ffmpeg run (`AlphaOutput: 'both'`). CHAOS passes in between stay transparent. Timing effects like SUS, STUTTER and REVERSE keep the alpha. An effect whose filters can't carry alpha comes out opaque, which is still usable.
- Tests: `tests/alpha.int.test.ts`.

---

## Milestone 3 — Cutout tool (AI add-on) ✅ built (real-model path untested, see below)

Click a character and get them out of the scene for the whole shot.

**Model:** SAM 2.1 small (Meta, Apache-2.0), from the `sam2` package on PyPI with the official `sam2.1_hiera_small.pt` checkpoint. It runs in float32 on Turing cards like the RTX 2070, and switches to bfloat16 autocast on Ampere and newer.

**AI pack** (`src/main/ai.ts`): optional, installed into `userData/ai/` from inside the app, and removable from the cutout studio:
1. Downloads **uv** from GitHub releases and unpacks it (`tar` reads zips on Windows 10 and later).
2. `uv venv --python 3.11`: a private Python, with uv's cache and Python kept inside the folder.
3. PyTorch: the CUDA 12.6 build when `nvidia-smi` finds a card, otherwise the CPU build.
4. `sam2==1.1.0` with `SAM2_BUILD_CUDA=0` and `--no-build-isolation`, so no compiler is needed.
5. The checkpoint, from `dl.fbaipublicfiles.com`.
6. Starts the helper once to prove it works, and records the GPU name in `ready.json`.

Each step can be re-run, so a failed or cancelled install resumes. AI jobs run on their own queue, so a big download doesn't hold up renders.

**Helper** (`src/main/ai/server.py`, bundled with Vite `?raw` and written out at launch): JSON lines over stdin/stdout. Commands are `open`, `points`, `track` (with progress) and `close`. It stays running, so the model only loads once. `--fake` cuts by colour instead of using the model, which lets the app's tests drive the whole pipeline without PyTorch.

**Pipeline** (`src/main/cutout.ts`): the selection (joined first if it spans clips) is pulled out as JPEG frames. Clicks go to the model, which writes one mask PNG per frame. Tracking propagates forward from the first clicked frame, then backward. Saving merges the masks with the **original video** (not the JPEGs) using `alphamerge`, after optional grow/shrink (`dilation`/`erosion`) and feathering (`gblur`). It writes the transparent copy plus a flat copy on green, magenta or blue. The result is new media with `origin.kind = 'cutout'`.

**Studio** (`CutoutStudio.tsx`): the **✂ Cut out** button sits in the timeline toolbar and works on selections of 30 s or less. Left click keeps, right click cuts away, and clicking a dot removes it. There's a frame scrubber, a mask view and a cut-out-on-checkerboard view, and a "track again" hint after changing dots. **Save** puts the cutout in the bin (cutouts show there, like imports) and, by default, on a layer, full frame and lined up in time over the original.

**Not tested yet:** the installer's downloads and the real SAM 2.1 backend could only be written here, not run, because there was no network or GPU. The test suite runs the full UI → helper → masks → transparent media path with the fake backend. First things to check on a real PC: the install finishes, the GPU name shows in the studio header, and clicking Luffy gives a sensible mask.

Later: a matting refiner (MatAnyone 2 / VideoMaMa) for soft edges, several characters per cutout, a clean plate (erase the character instead of keeping them), and SAM 3 text prompts on bigger GPUs.

---

## Milestone 4 — Episode ingest, shots and the Library

At one YTP per episode, the source material is the whole show, so the app needs a home for it that outlives a single project.

- **Library** (`userData/library/`): media, cutouts, faces and sound bites shared by every project, with tags. A project references library items by id. Clearing a project's cache never touches the library.
- **Tags** are free text with autocomplete: `luffy`, `laugh`, `ep 001`, `zoro lost`, `running gag: meat`. The bin gets a Library tab with search ("zoro lost" finds every clip tagged with both).
- **Episode ingest:** drop in an episode file and it's normalized once into the library, not per project. **Shot detection** runs at the same time (ffmpeg `scdet` or a `select='gt(scene,0.3)'` pass) and saves the cut points. The episode then shows on the timeline pre-split into shots, so a double-click selects one shot.
- **Running gags:** a "Send to library" button on any bin item, cutout or selection, with the episode and time filled in automatically.

---

## Milestone 5 — Face bank

- An anime face detector (a small YOLO-style ONNX model, run in the AI pack) scans an ingested episode and finds faces per shot. The tracker from Milestone 3 then follows each face through its shot.
- The results are grouped by character: you name a few and similar faces cluster with them. They land in the library as **face clips** (cut out, with alpha) tagged by character and expression.
- **Face swap gag:** drop a face clip on a layer and the tool offers "stick to this face". It tracks a face in the main track and keyframes the layer to follow it (position and scale per frame), which is the classic YTP head-replacement.

---

## Milestone 6 — Sentence mixing

This was already in the v1 ideas list; transcripts make it practical.

- **Transcribe** an episode with Whisper (in the AI pack; `small` or `medium` fits 8 GB) to get word-level timestamps. It handles both Japanese audio and the English dub, and the language is picked per episode.
- Every word becomes a searchable snippet in the library, so you can find every time anyone says "meat".
- **Type a sentence** and the app builds it from snippets, picking the best take of each word with alternatives one click away. It goes onto the main track as clips that keep their source, so effects work on them as usual.
- Same idea for the existing double-click word grab: snap to the transcript's word edges when there's a transcript.

---

## Milestone 7 — Per-episode workflow

- **Episode template**: a starter project with your intro, outro, and recurring layers (watermark, a "previously on" card), plus the episode already loaded and split into shots.
- **Batch export queue**: queue several finished projects and let them render overnight.
- **Random YTP generator** (v1 idea): FULL POOP for the whole episode, plus the library. It sprinkles in tagged running gags at random, on layers.
- GPU encoding (NVENC on the 2070) for exports when available, which makes 9-minute videos much faster.

---

## Notes / gotchas

- Layer media is always the project's size (normalization pads it), so transforms are relative to the frame. Keep that true for alpha media too.
- `perspective` copies edge pixels outward, which is why each layer clip gets a 2 px transparent margin before warping. Keep that margin if the warp changes.
- In ffmpeg filter options, Windows paths need `C\:` escaped even inside quotes (`filterPath`).
- Preview and export share `transformAt`, `alphaAt` and `keyAlpha`. Any new layer feature should put its maths in `src/shared/layers.ts` first, so they can't drift apart. A test checks `keyframeExpr` against `transformAt`.
