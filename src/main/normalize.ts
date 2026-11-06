import { writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { MEDIA_FILE, PEAKS_FILE, THUMBS_FILE } from '../shared/media';
import type {
  MediaFile,
  MediaId,
  MediaOrigin,
  ProjectSettings,
  ThumbGrid,
  WaveformPeaks,
} from '../shared/types';
import { runFfmpeg, type JobContext } from './ffmpeg';
import { probe, type ProbeResult } from './probe';

const PEAKS_SAMPLE_RATE = 8000;
const PEAKS_PER_SECOND = 100;
const THUMB_WIDTH = 160;
const THUMB_COLS = 10;
const MAX_THUMBS = 1000;

// Share of a job's progress bar spent on the transcode; the rest covers thumbs and peaks.
export const RENDER_SHARE = 0.85;

export const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.bmp', '.webp']);
const STILL_SECONDS = 2;

const isStillImage = (path: string) => IMAGE_EXTENSIONS.has(extname(path).toLowerCase());

/** Video and audio encoder settings shared by every file in the cache. */
export function houseEncodeArgs(settings: ProjectSettings): string[] {
  return [
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '18',
    '-pix_fmt', 'yuv420p',
    '-r', String(settings.fps),
    '-g', '15',
    '-keyint_min', '15',
    '-sc_threshold', '0',
    '-c:a', 'aac',
    '-ar', String(settings.sampleRate),
    '-ac', '2',
    '-b:a', '192k',
    '-movflags', '+faststart',
  ];
}

export function buildNormalizeArgs(
  sourcePath: string,
  source: ProbeResult,
  settings: ProjectSettings,
  outPath: string,
): string[] {
  const { width, height, fps, sampleRate } = settings;
  const silence = `anullsrc=channel_layout=stereo:sample_rate=${sampleRate}`;
  const black = `color=c=black:s=${width}x${height}:r=${fps}`;

  const inputs: string[] = [];
  const maps: string[] = [];
  if (source.video) {
    if (isStillImage(sourcePath)) inputs.push('-loop', '1', '-framerate', String(fps), '-t', String(STILL_SECONDS));
    inputs.push('-i', sourcePath);
    maps.push('-map', `0:${source.video.index}`);
    if (source.audio) {
      maps.push('-map', `0:${source.audio.index}`);
    } else {
      inputs.push('-f', 'lavfi', '-i', silence);
      maps.push('-map', '1:a');
    }
  } else {
    // Audio-only sources get a black picture for as long as the audio runs.
    const length = source.duration ? ['-t', String(source.duration)] : [];
    inputs.push('-f', 'lavfi', ...length, '-i', black, '-i', sourcePath);
    maps.push('-map', '0:v', '-map', `1:${source.audio!.index}`);
  }

  return [
    ...inputs,
    ...maps,
    '-vf',
    `scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
      `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps},format=yuv420p`,
    // apad + -shortest keeps the audio exactly as long as the picture, so concat never drifts.
    '-af', `aresample=${sampleRate}:async=1:first_pts=0,apad`,
    '-shortest',
    ...houseEncodeArgs(settings),
    outPath,
  ];
}

export function thumbGridFor(duration: number, settings: ProjectSettings): ThumbGrid {
  const interval = Math.max(1, Math.ceil(duration / MAX_THUMBS));
  const count = Math.max(1, Math.ceil(duration / interval));
  const cols = Math.min(THUMB_COLS, count);
  return {
    cols,
    rows: Math.ceil(count / cols),
    interval,
    tileWidth: THUMB_WIDTH,
    tileHeight: Math.round((THUMB_WIDTH * settings.height) / settings.width),
  };
}

async function generateThumbs(mediaPath: string, outPath: string, grid: ThumbGrid, signal: AbortSignal) {
  // Decoding only keyframes is plenty for 1 fps tiles, and the house GOP is half a second.
  // eof_action=pass matters for clips under that: their lone keyframe would otherwise be dropped.
  await runFfmpeg({
    args: [
      '-skip_frame', 'nokey',
      '-i', mediaPath,
      '-an',
      '-vf',
      `fps=1/${grid.interval}:eof_action=pass,scale=${grid.tileWidth}:${grid.tileHeight},` +
        `tile=${grid.cols}x${grid.rows}`,
      '-frames:v', '1',
      '-q:v', '4',
      outPath,
    ],
    signal,
  });
}

async function generatePeaks(mediaPath: string, outPath: string, signal: AbortSignal) {
  const samplesPerBucket = PEAKS_SAMPLE_RATE / PEAKS_PER_SECOND;
  const peaks: WaveformPeaks = { bucketsPerSecond: PEAKS_PER_SECOND, min: [], max: [] };
  const round = (value: number) => Math.round(value * 1000) / 1000;

  let low = 1;
  let high = -1;
  let count = 0;
  const flush = () => {
    peaks.min.push(round(low));
    peaks.max.push(round(high));
    low = 1;
    high = -1;
    count = 0;
  };

  // Chunks can split a 16-bit sample in half, so the odd byte carries over.
  let leftover: Buffer = Buffer.alloc(0);
  await runFfmpeg({
    args: ['-i', mediaPath, '-ac', '1', '-ar', String(PEAKS_SAMPLE_RATE), '-f', 's16le', '-'],
    signal,
    onStdout: (chunk) => {
      const data = leftover.length ? Buffer.concat([leftover, chunk]) : chunk;
      const usable = data.length & ~1;
      for (let i = 0; i < usable; i += 2) {
        const sample = data.readInt16LE(i) / 32768;
        if (sample < low) low = sample;
        if (sample > high) high = sample;
        if (++count === samplesPerBucket) flush();
      }
      leftover = data.subarray(usable);
    },
  });
  if (count > 0) flush();

  await writeFile(outPath, JSON.stringify(peaks));
}

/** Probes a finished house-format file and builds its peaks and thumbnails. */
export async function finalizeMedia(
  id: MediaId,
  dir: string,
  origin: MediaOrigin,
  settings: ProjectSettings,
  ctx: JobContext,
): Promise<MediaFile> {
  const path = join(dir, MEDIA_FILE);
  const peaksPath = join(dir, PEAKS_FILE);
  const thumbsPath = join(dir, THUMBS_FILE);

  // The real duration comes from the file: effects and fps conversion both change it.
  const { duration, video } = await probe(path);
  if (!video) throw new Error('Render produced no video stream');
  const thumbGrid = thumbGridFor(duration, settings);

  ctx.report(RENDER_SHARE, 'Making thumbnails');
  await generateThumbs(path, thumbsPath, thumbGrid, ctx.signal);
  ctx.report((RENDER_SHARE + 1) / 2, 'Reading waveform');
  await generatePeaks(path, peaksPath, ctx.signal);

  return {
    id,
    path,
    duration,
    width: video.width,
    height: video.height,
    fps: video.fps,
    hasAudio: true,
    peaksPath,
    thumbsPath,
    thumbGrid,
    origin,
  };
}

export async function importMedia(
  id: MediaId,
  dir: string,
  sourcePath: string,
  settings: ProjectSettings,
  ctx: JobContext,
): Promise<MediaFile> {
  ctx.report(null, 'Reading file');
  const source = await probe(sourcePath);
  if (!source.video && !source.audio) throw new Error('No video or audio found in this file');

  const duration = isStillImage(sourcePath) ? STILL_SECONDS : source.duration;
  ctx.report(duration ? 0 : null, 'Normalizing');
  await runFfmpeg({
    args: buildNormalizeArgs(sourcePath, source, settings, join(dir, MEDIA_FILE)),
    duration,
    onProgress: (fraction) => ctx.report(fraction * RENDER_SHARE),
    signal: ctx.signal,
  });

  return finalizeMedia(id, dir, { kind: 'import', sourcePath }, settings, ctx);
}
