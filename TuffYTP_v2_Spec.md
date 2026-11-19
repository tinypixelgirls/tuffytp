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

## Milestone 2 — Transparent media (alpha)

Cutouts need real transparency, not just a key colour. Zoro's hair is green, so a green screen eats his head.

- Add an optional alpha track to `MediaFile`: `alpha?: true`, stored as **`media.webm`, VP9 with `yuva420p`**. Chromium plays VP9 alpha in `<video>`, and drawing it to canvas keeps the transparency, so the preview needs no changes beyond picking the file.
- ffmpeg only keeps VP9 alpha when decoding with `-c:v libvpx-vp9` (the built-in decoder drops it). Put that before `-i` for alpha inputs in `planComposite`, then `format=rgba` as now.
- Effects on alpha media: each effect builds its filter for `[0:v]`. Route alpha through by splitting `alphaextract` off before the effect and `alphamerge` after it, for effects whose timing the alpha can follow: everything except purely audio effects, which pass video through anyway. Otherwise flatten to green and say so in a toast.
- "**Bake onto colour**" command: turns alpha media into a green (or magenta) screen clip, for sharing outside the app.

*Done when:* a PNG with transparency and a transparent WebM import, sit on a layer, and export correctly.

---

## Milestone 3 — Cutout tool (AI add-on)

Click a character and get them out of the scene for the whole shot.

**Model:** SAM 2.1 (Meta, Apache-2.0). Its small and base+ sizes run comfortably in 8 GB; SAM 3 adds text prompts ("straw hat boy") but wants ~12 GB, so it's an option for later or for a bigger GPU. Anime is a good case for these models because of the flat colours and hard outlines. For soft edges (hair, smoke, Gear 5 clouds), an optional matting refiner (MatAnyone 2 or VideoMaMa) can turn the mask into a soft alpha.

**Packaging, keeping the app small:**
- The app ships without Python. The first time you open the cutout tool, it offers to download the **TuffYTP AI pack**: an embeddable Python, PyTorch (CUDA), and the SAM 2.1 weights, into `userData/ai/`. It's a few GB, with a progress bar, resumable, and deletable from settings.
- A **sidecar process** (`ai/server.py`) speaks JSON over stdin/stdout, like ffmpeg jobs do now: `load_video`, `add_points`, `propagate`, `export_mask`, with progress lines. It runs through the existing `JobQueue`, so cancel works.
- No GPU, or not enough VRAM: fall back to the tiny model on CPU with a warning that it's slow.

**UX:**
1. Select a stretch of the main track (one shot works best; see Milestone 4) and press **✂ CUT OUT**.
2. A cutout view opens on the first frame. Left-click adds what to keep, right-click adds what to drop. The mask previews live.
3. **Track** runs the model through the selection. Scrub to check it, add fix-up clicks on any frame, and track again.
4. **Save** makes transparent media (Milestone 2) and puts it in the bin, tagged with the episode and timestamp. It can also drop it straight onto a layer over the original, lined up.
5. Options: grow or shrink the edge, feather it, and "keep the whole frame but blur or erase the character" (a clean plate) for swapping someone out of a scene.

*Done when:* five clicks get Luffy out of a 3-second shot cleanly enough to use as a running gag.

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
