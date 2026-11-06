# YTP Studio — Build Spec for Claude Code

A desktop video editor made specifically for **YouTube Poops (YTPs)**. You select part of a clip on a timeline and press a button ("Sus", "Stutter", "Ear Rape", "Rainbow"…), and the app replaces that piece with an ffmpeg-rendered version. The point is fast, fun, one-click YTP tropes, not a general-purpose NLE.

Build it in the milestone order at the bottom. After each milestone the app should run, so stop and let me test before moving on.

---

## 1. Tech stack

- **Electron** (latest stable), plain **TypeScript**, bundled with **Vite** (e.g. `electron-vite`). Use **React** for the renderer UI.
- **ffmpeg-static** + **ffprobe-static** for bundled binaries, so the user never installs ffmpeg separately. Call them with `child_process.spawn` from the **main process only**.
- Security: `contextIsolation: true`, `nodeIntegration: false`, and a `preload.ts` that exposes a small typed API (`window.ytp.*`) via `contextBridge`.
- Serve cached media to the renderer through a custom protocol (`ytp-media://`) registered with `protocol.handle`. Don't use raw `file://` URLs.
- State: **Zustand** (or a simple reducer) in the renderer, with immutable project snapshots for undo/redo.
- Packaging: `electron-builder`, targeting Windows first, then mac/Linux.
- `npm install && npm run dev` must be all it takes to run it.

---

## 2. Core concept and data model

The source files are never modified. Every edit produces new **rendered segments** in a cache folder, and the timeline is just a list of references to them.

```ts
type MediaId = string;

interface MediaFile {          // a normalized file in the cache
  id: MediaId;
  path: string;                // absolute path in cache dir
  duration: number;            // seconds
  width: number; height: number; fps: number;
  hasAudio: true;              // normalization guarantees an audio track
  peaksPath?: string;          // waveform peaks (Float32 JSON or binary)
  thumbsPath?: string;         // thumbnail sprite sheet
  origin: { kind: 'import', sourcePath: string } |
          { kind: 'effect', effectId: string, params: any, fromMedia: MediaId, in: number, out: number };
}

interface Clip {
  id: string;
  mediaId: MediaId;
  in: number;                  // seconds into the media
  out: number;
}

interface Project {
  version: 1;
  settings: { width: number; height: number; fps: number; sampleRate: 48000 };
  media: Record<MediaId, MediaFile>;
  timeline: Clip[];            // v1: single track, clips play back-to-back
}
```

**Applying an effect to a selection `[a, b]` on the timeline:**

1. Work out which clip(s) the selection covers. In v1 you can require that the selection sits inside one clip; if it crosses a boundary, auto-snap or ask.
2. Split the clip into `before | middle | after`.
3. Render `middle` through the effect into a **new MediaFile** in the cache.
4. Replace `middle` with a clip pointing at the new media. The new piece can be longer or shorter than the original (Sus doubles it, Stutter lengthens it, Speed Up shortens it).
5. Push an undo snapshot, then select the new clip so effects can be stacked by pressing more buttons.

---

## 3. Media normalization (important)

On import, transcode every file to one house format so that cutting is frame-accurate and every segment can be concatenated without re-encoding:

- Video: H.264 (`libx264 -preset veryfast -crf 18`), `yuv420p`, constant frame rate (project fps, default 30), short GOP (`-g 15` or so), scaled/padded to the project resolution (default 1280×720, letterboxed).
- Audio: AAC 48 kHz stereo. If the source has no audio, add silence with `anullsrc`.
- Container: `.mp4` with `+faststart`.

Every effect render outputs this **same format**. Export and preview can then use the concat demuxer with `-c copy`.

After normalizing, generate:

- **Waveform peaks:** `ffmpeg -i file -ac 1 -ar 8000 -f s16le -` → compute min/max per pixel bucket in main, save as JSON.
- **Thumbnail sprite:** `fps=1,scale=160:-1,tile=…`, or individual JPEGs.

Show a progress bar for all ffmpeg jobs: parse `-progress pipe:1` output against the known duration.

---

## 4. UI layout

```
┌───────────────┬──────────────────────────────┬────────────────────┐
│  MEDIA BIN    │          PREVIEW             │   EFFECT PALETTE   │
│  imported     │   <video> player             │   big chunky       │
│  clips + SFX  │   play/pause/frame-step      │   buttons grouped  │
│  folder       │   timecode                   │   by category      │
├───────────────┴──────────────────────────────┴────────────────────┤
│  TIMELINE: thumbnails strip + waveform, playhead, drag-to-select  │
│  zoom slider, split / delete / duplicate / move clips             │
└───────────────────────────────────────────────────────────────────┘
```

- **Timeline:** draw it on a `<canvas>` for performance. Drag on empty space to make a selection; drag a clip to move it; drag clip edges to trim. The selection is a translucent highlight showing its duration. Zoom with ctrl+wheel. The playhead snaps to frames.
- **Effect buttons:** a click applies the effect with its default params. **Shift+click** (or a small ⚙ on the button) opens a popover with sliders for the params plus a "Preview" button that renders and plays the result without committing it. Buttons are greyed out when nothing is selected.
- **Loud, goofy visual style is welcome** (chunky buttons, bold colors, a "CHAOS" button that looks dangerous), but keep it usable.
- While a render runs, show a spinner on the button and a status bar entry. Allow a queue, and let the user cancel by killing the ffmpeg process.

### Keyboard shortcuts

| Key | Action |
|---|---|
| Space | Play / pause |
| ← / → | Step one frame (Shift = 1 s) |
| I / O | Set selection in / out at playhead |
| S | Split at playhead |
| Delete | Delete selection (ripple) |
| Ctrl+D | Duplicate selection right after itself |
| Ctrl+Z / Ctrl+Shift+Z | Undo / redo |
| L | Loop-play selection |
| 1–9 | Fire pinned effect buttons |

---

## 5. Playback

- Play the timeline by sequencing clips with **two `<video>` elements that swap** (A plays while B preloads the next clip, seeked to its `in`). Use `requestVideoFrameCallback` or `timeupdate` to switch at `out`.
- "Loop selection" plays only the selected range on repeat. This is essential for YTP timing.
- If the swapping is too janky, add a fallback: render a quick low-res proxy of the whole timeline (concat demuxer, `-c copy`) and play that.

---

## 6. Effect system

Every effect lives in its own file under `src/main/effects/` and follows one interface. Adding a new effect should mean adding one file and registering it.

```ts
interface EffectParam {
  key: string; label: string;
  type: 'number' | 'int' | 'bool' | 'select';
  min?: number; max?: number; step?: number; default: any; options?: string[];
}

interface Effect {
  id: string;
  label: string;           // button text, e.g. "SUS"
  category: 'audio+video' | 'audio' | 'video' | 'combo';
  description: string;     // tooltip
  params: EffectParam[];
  // Build an ffmpeg -filter_complex for ONE input (the trimmed segment, as [0:v][0:a]).
  // Must output labels [vout] and [aout].
  buildFilter(params: Record<string, any>, info: { duration: number; fps: number; width: number; height: number; sampleRate: number }): string;
}
```

**Render pipeline for one effect:**

1. Cut the segment frame-accurately: `ffmpeg -ss <in> -to <out> -i media.mp4` (place `-ss` after `-i` if accuracy problems show up) → temp file.
2. `ffmpeg -i temp.mp4 -filter_complex "<buildFilter>" -map [vout] -map [aout] <house encode settings> out.mp4`
3. ffprobe the result and register it as a MediaFile; generate peaks and thumbnails.

`reverse` and `areverse` buffer the whole segment in RAM. That's fine for YTP-length selections, but show a warning above roughly 20 s.

Write unit tests (vitest) for every `buildFilter` that check the filter string is valid. Also add an integration test that runs every effect against a generated test clip (`testsrc2` + `sine`, 3 s) and checks that ffmpeg exits 0 and the output duration is in the expected range.

### 6.1 v1 effect list, with ffmpeg recipes

These are starting recipes; tune them as needed. `f` = a ratio, `semis` = semitones (ratio = 2^(semis/12)).

#### Audio + video (the core YTP stuff)

| Button | What it does | Recipe |
|---|---|---|
| **SUS** | Forward then reversed. Selecting "FRI" of "FRICK!!!" gives "FRI"+"IRF" = **"FRIIRF"**. Params: `mode` = `forward-reverse` / `reverse-forward`, `bounces` (1–8; ping-pong N times). | `[0:v]split[v1][v2];[v2]reverse[vr];[0:a]asplit[a1][a2];[a2]areverse[ar];[v1][a1][vr][ar]concat=n=2:v=1:a=1[vout][aout]` — for bounces > 1, chain more split/reverse/concat pairs |
| **STUTTER** | "F-F-F-FRICK". Repeats the first `chunkMs` (30–500) of the selection `repeats` (1–16) times, then plays the rest. | Video: `loop=loop=R:size=<frames>:start=0`. Audio: `aloop=loop=R:size=<samples>:start=0`. Then `setpts=N/FRAME_RATE/TB` and `asetpts=N/SR/TB` |
| **REVERSE** | Plays the selection backwards. | `[0:v]reverse[vout];[0:a]areverse[aout]` |
| **PITCH UP / PITCH DOWN** | Chipmunk or demon. `semis` (−24…+24). `mode`: `tape` (speed changes with pitch, classic YTP) or `keep-speed`. | Tape: `asetrate=48000*r,aresample=48000` + `setpts=PTS/r`. Keep-speed: `rubberband=pitch=r` if the bundled ffmpeg has librubberband (check `ffmpeg -filters` at startup); otherwise `asetrate=48000*r,aresample=48000,atempo=1/r` |
| **SPEED UP / SLOW MO** | `factor` (0.25–4). | `setpts=PTS/f`; `atempo` chained in 0.5–2.0 steps (e.g. `atempo=2,atempo=2` for 4×) |
| **STRETCH** | Holds a syllable: "FRIIIIIIICK". `amount` (2–8×) without pitch change. | Audio `rubberband=tempo=1/amount` (or chained `atempo=0.5`). Video `setpts=PTS*amount` (optionally `minterpolate` behind a "smooth" checkbox) |
| **LOOP** | Repeats the selection N times (2–20). | `loop` / `aloop` with size = whole segment, or concat N copies |

#### Audio only (video passes through with `[0:v]null[vout]`)

| Button | What it does | Recipe |
|---|---|---|
| **EAR RAPE** | Massively loud, clipped, bass-boosted. `intensity` 1–10. Show a little ⚠ and cap output with a final limiter so it can't damage hardware. | `bass=g=15,treble=g=6,volume=+20dB,asoftclip=type=hard,volume=-3dB` (scale by intensity) |
| **ECHO** | Dramatic trailing echo. `delayMs`, `decay`, `taps`. | `aecho=0.8:0.9:400|800|1200:0.6|0.4|0.2`, then `apad` the audio and `tpad=stop_mode=clone` the video so the tail isn't cut off |
| **REVERB** | Big hall. | Several aecho taps, or `afir` with a bundled impulse-response WAV |
| **CHOIR** | Stacks pitched copies into a chord. `chord` = major / minor / power / octaves. | `asplit=3[a][b][c]`, pitch b and c (+4/+7 for major), `amix=inputs=3:normalize=0`, then normalize volume |
| **BITCRUSH** | Crunchy low-fi sound. `bits` (2–12), `downsample` (1–32). | `acrusher=bits=B:samples=S:mode=lin:mix=1` |
| **WOBBLE** | Vibrato. `rate`, `depth`. | `vibrato=f=6:d=0.8` |
| **MUTE** | Silence. | `volume=0` |

#### Video only (audio passes through with `[0:a]anull[aout]`)

| Button | What it does | Recipe |
|---|---|---|
| **INVERT** | Negative colors. | `negate` |
| **RAINBOW** | Hue cycles over time. `speed`. | `hue=h=t*360*speed:s=1.5` |
| **MIRROR** | Left half mirrored onto the right. `side` = left / right / top / bottom. | `[0:v]crop=iw/2:ih:0:0,split[l][r];[r]hflip[rf];[l][rf]hstack[vout]` |
| **FLIP** | Horizontal / vertical / both. | `hflip` / `vflip` |
| **DEEP FRY** | Oversaturated, oversharpened, noisy, crushed. | `eq=saturation=3:contrast=1.8:brightness=0.05,unsharp=7:7:2.5,noise=alls=25:allf=t`, plus a scale down/up for blockiness |
| **ZOOM PUNCH** | Sudden zoom-in. `zoom` (1.2–4), `center` x/y. | `crop=iw/Z:ih/Z:(iw-iw/Z)*cx:(ih-ih/Z)*cy,scale=W:H` |
| **SHAKE** | Screen shake. `intensity`. | `crop=iw*0.9:ih*0.9:x='(iw-ow)/2+sin(t*70)*A':y='(ih-oh)/2+cos(t*53)*A',scale=W:H` |
| **STAREDOWN** | Freezes the last frame, slowly zooms in, and drops the audio to silence (or a low drone). `holdSec` (1–10). | Freeze with `tpad=stop_mode=clone:stop_duration=H`, slow zoom with `zoompan` or an animated `crop` expression, audio `apad` + volume to 0 over the hold |

#### Combos

| Button | What it does |
|---|---|
| **G-MAJOR** | Hue shift (h=+120 or so) plus a pitch shift of a few semitones, the classic G-Major meme look. |
| **CHAOS** | Picks 2–4 random effects with random params and chains them into one render. Shows a toast saying what it picked, e.g. "CHAOS: Sus → Pitch +7 → Rainbow". Undo removes the whole combo in one step. |

---

## 7. Other editing features (v1)

- **Import:** drag and drop files onto the bin or timeline, or use a file dialog. Accept mp4/mov/mkv/webm/avi/gif plus audio-only files (mp3/wav/ogg; give them a black frame or the waveform as video).
- **SFX folder:** the user picks a folder of sound effects and images, shown as a separate tab in the bin. Dragging one onto the timeline *inserts* it. Overlaying needs tracks, which come in v2.
- **Clip ops:** split, delete (ripple), duplicate, move/reorder, trim edges.
- **Undo/redo:** at least 100 steps of snapshots. The cache files stay on disk, so undo is instant.
- **Effect history panel:** a list of what was applied; clicking an entry selects that clip.
- **Export:** a dialog for resolution (keep / 720p / 1080p), fps, and quality preset. Uses the concat demuxer, re-encoding only if the export settings differ from the house format. Shows progress, then "Show in folder".
- **Cache:** lives in a per-project cache directory in `app.getPath('userData')`. Add a "Clear cache" command, and show the cache size.

---

## 8. Suggested file structure

```
ytp-studio/
  package.json
  electron.vite.config.ts
  src/
    main/
      index.ts            # window, protocol, IPC registration
      ffmpeg.ts           # spawn wrapper: progress parsing, cancel, job queue
      probe.ts            # ffprobe helpers
      normalize.ts        # import → house format, peaks, thumbs
      render.ts           # cut segment + apply effect(s) → MediaFile
      export.ts
      cache.ts
      effects/
        index.ts          # registry
        sus.ts stutter.ts reverse.ts pitch.ts speed.ts stretch.ts loop.ts
        earrape.ts echo.ts reverb.ts choir.ts bitcrush.ts wobble.ts mute.ts
        invert.ts rainbow.ts mirror.ts flip.ts deepfry.ts zoompunch.ts shake.ts staredown.ts
        gmajor.ts chaos.ts
    preload/
      index.ts            # window.ytp API
    renderer/
      App.tsx
      store/              # project state, undo/redo
      components/
        MediaBin.tsx Preview.tsx Timeline.tsx EffectPalette.tsx
        EffectParamsPopover.tsx ExportDialog.tsx StatusBar.tsx
      timeline/           # canvas drawing, hit-testing, selection logic
  tests/
    effects.test.ts       # buildFilter unit tests
    render.int.test.ts    # every effect against a generated test clip
```

---

## 9. Milestones (stop after each so I can test)

1. **Skeleton.** The Electron app opens. Import a video, normalize it with a progress bar, and see it in the bin. Clicking it plays it in the preview.
   *Done when:* I can import an MP4 and an MKV, and both play.
2. **Timeline.** The clip sits on a canvas timeline with thumbnails and a waveform. Includes the playhead, click-to-seek, drag-to-select, I/O keys, zoom, split, delete, duplicate, move, undo/redo, and loop-selection playback.
   *Done when:* I can chop a clip into pieces, rearrange them, and play the result smoothly.
3. **Effect engine + first 6 buttons.** The registry, render pipeline and job queue, plus **SUS, STUTTER, REVERSE, PITCH, SPEED, EAR RAPE**. Includes the param popover with Preview.
   *Done when:* selecting "FRI" in a clip of someone saying "FRICK" and pressing SUS gives "FRIIRF", and stacking effects on the result works.
4. **The rest of the v1 buttons**, plus G-MAJOR and CHAOS. Unit and integration tests pass for all effects.
5. **Export** to MP4, the SFX folder, and cache management.
6. **Polish:** keyboard shortcuts, button pinning to 1–9, error toasts showing ffmpeg stderr, and the visual style pass.

## 10. v2 ideas (don't build yet, but don't design them out)

- **Multiple tracks / overlays:** picture-in-picture, images popping in, a text overlay tool (Impact font, of course). This means the timeline model needs `tracks: Clip[][]` later.
- **Sentence mixing bin:** mark words or syllables in a clip as tagged snippets ("hello", "my", "name"), then type a sentence and the app assembles it from the snippets.
- **YTPMV mode:** pitch a clip to notes from an on-screen piano or a MIDI file, for "making them sing".
- **Project save/load** (`.ytp` JSON plus the cache folder).
- **Random YTP generator:** auto-applies CHAOS to random spots across the whole timeline.
- Optional GPU encoding (nvenc/qsv) when available.

## 11. Notes / gotchas

- Always re-encode cut segments; never stream-copy (`-c copy`) when cutting, or the cuts won't be frame-accurate.
- Some effects change duration (Sus ×2, Stutter, Speed, Stretch, Staredown, Echo tail). The timeline must take the actual rendered duration from ffprobe, not compute it.
- Keep audio and video lengths equal in every render; pad or trim the shorter one (`apad` + `-shortest`, or `tpad`) so concat never drifts out of sync.
- Check filter availability at startup (`ffmpeg -filters`) and hide or fall back for effects whose filters are missing (e.g. `rubberband`).
- Windows paths: quote them properly and escape `:` and `\` inside filter strings (e.g. for `afir` IR files or text overlays).
