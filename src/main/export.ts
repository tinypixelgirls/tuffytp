import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ExportRequest, ExportSegment, ProjectSettings } from '../shared/types';
import { runFfmpeg, type JobContext } from './ffmpeg';
import { houseEncodeArgs } from './normalize';

const HEIGHTS = { '720p': 720, '1080p': 1080 };
const QUALITY = {
  draft: { preset: 'veryfast', crf: '26' },
  high: { preset: 'medium', crf: '16' },
};
// How close to a file's ends a clip must be to count as the whole file.
const WHOLE_FILE_TOLERANCE = 0.001;
// Share of the progress bar for cutting clips when a final encode follows.
const CUT_SHARE = 0.5;
const AAC_ENCODER_DELAY = 1024;

/** The size the export comes out at, kept to the project's shape and to even numbers. */
export function outputSize({ settings, resolution }: Pick<ExportRequest, 'settings' | 'resolution'>) {
  if (resolution === 'keep') return { width: settings.width, height: settings.height };
  const height = HEIGHTS[resolution];
  const width = Math.round(((height * settings.width) / settings.height) / 2) * 2;
  return { width, height };
}

/** Everything in the cache is already in the house format, so a matching export can skip encoding. */
export function needsFinalEncode(request: ExportRequest): boolean {
  const { width, height } = outputSize(request);
  const { settings, fps, quality } = request;
  return width !== settings.width || height !== settings.height || fps !== settings.fps || quality !== 'house';
}

function isWholeFile(segment: ExportSegment): boolean {
  return segment.in < WHOLE_FILE_TOLERANCE && segment.mediaDuration - segment.out < WHOLE_FILE_TOLERANCE;
}

function buildCutArgs(segment: ExportSegment, settings: ProjectSettings, outPath: string): string[] {
  return [
    '-ss', String(segment.in),
    '-t', String(segment.out - segment.in),
    '-i', segment.path,
    '-filter_complex', `[0:v]fps=${settings.fps}[v];[0:a]apad=pad_dur=2[a]`,
    '-map', '[v]',
    '-map', '[a]',
    '-shortest',
    ...houseEncodeArgs(settings),
    outPath,
  ];
}

/**
 * Paths in a concat list go in single quotes; a quote inside one has to step out and back in.
 * Each piece states its exact length, or the joiner uses the slightly longer audio track, and
 * those few milliseconds per join add up to audible drift on a heavily chopped timeline.
 */
export function concatList(pieces: { path: string; seconds: number }[]): string {
  return pieces
    .map(({ path, seconds }) => {
      const escaped = path.replace(/\\/g, '/').replace(/'/g, `'\\''`);
      return `file '${escaped}'\nduration ${seconds.toFixed(6)}\n`;
    })
    .join('');
}

function buildFinalArgs(request: ExportRequest, listPath: string, outPath: string): string[] {
  const concat = ['-f', 'concat', '-safe', '0', '-i', listPath];
  // Audio is always re-encoded: AAC joined as-is clicks at each seam. AAC also only comes in
  // ~21 ms blocks, so each piece's audio ends a little off from its picture. Left alone those
  // errors add up, so this holds every piece to its timestamp, filling or trimming as needed.
  // The concat demuxer also keeps each file's 1024-sample encoder delay, so that comes off first.
  const audio = [
    '-af',
    `asetpts=PTS-${AAC_ENCODER_DELAY}/SR/TB,` +
      `aresample=${request.settings.sampleRate}:async=1:min_hard_comp=0.001:first_pts=0`,
    '-c:a', 'aac',
    '-b:a', '192k',
    '-movflags', '+faststart',
  ];
  if (!needsFinalEncode(request)) return [...concat, '-c:v', 'copy', ...audio, outPath];

  const { width, height } = outputSize(request);
  const { preset, crf } = request.quality === 'house' ? { preset: 'veryfast', crf: '18' } : QUALITY[request.quality];
  return [
    ...concat,
    '-vf', `scale=${width}:${height}:flags=lanczos,setsar=1,fps=${request.fps},format=yuv420p`,
    '-c:v', 'libx264',
    '-preset', preset,
    '-crf', crf,
    ...audio,
    outPath,
  ];
}

/**
 * Cuts any partial clips, joins everything with the concat demuxer, and only then moves the
 * result to the chosen path, so a failed export can't damage a file that was already there.
 */
export async function runExport(dir: string, request: ExportRequest, ctx: JobContext): Promise<string> {
  const { segments, settings, outputPath } = request;
  const encoding = needsFinalEncode(request);
  const totalSeconds = segments.reduce((total, { in: start, out }) => total + out - start, 0);
  const cutShare = encoding ? CUT_SHARE : 0.9;

  await mkdir(dir, { recursive: true });
  const pieces: { path: string; seconds: number }[] = [];
  let doneSeconds = 0;

  ctx.report(0, 'Cutting clips');
  for (const [index, segment] of segments.entries()) {
    const seconds = segment.out - segment.in;
    if (isWholeFile(segment)) {
      pieces.push({ path: segment.path, seconds });
    } else {
      const piece = join(dir, `piece-${index}.mp4`);
      await runFfmpeg({
        args: buildCutArgs(segment, settings, piece),
        duration: seconds,
        onProgress: (fraction) => ctx.report(((doneSeconds + fraction * seconds) / totalSeconds) * cutShare),
        signal: ctx.signal,
      });
      pieces.push({ path: piece, seconds });
    }
    doneSeconds += seconds;
    ctx.report((doneSeconds / totalSeconds) * cutShare);
  }

  const listPath = join(dir, 'list.txt');
  await writeFile(listPath, concatList(pieces));

  const finished = join(dir, 'export.mp4');
  ctx.report(cutShare, encoding ? 'Encoding' : 'Joining');
  await runFfmpeg({
    args: buildFinalArgs(request, listPath, finished),
    duration: totalSeconds,
    onProgress: (fraction) => ctx.report(cutShare + fraction * (1 - cutShare)),
    signal: ctx.signal,
  });

  await copyFile(finished, outputPath);
  await rm(dir, { recursive: true, force: true });
  return outputPath;
}
