import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ffmpegPath, ffprobePath } from '../src/main/bin';
import { concatList, needsFinalEncode, outputSize, runExport } from '../src/main/export';
import { runFfmpeg, type JobContext } from '../src/main/ffmpeg';
import { importMedia } from '../src/main/normalize';
import type { ExportRequest, ExportSegment, MediaFile, ProjectSettings } from '../src/shared/types';

const exec = promisify(execFile);
const settings: ProjectSettings = { width: 1280, height: 720, fps: 30, sampleRate: 48000 };
const ctx: JobContext = { signal: new AbortController().signal, report: () => {} };

let dir: string;
let tone: MediaFile;
let counter = 0;

const segment = (media: MediaFile, start: number, end: number): ExportSegment => ({
  path: media.path,
  in: start,
  out: end,
  mediaDuration: media.duration,
});

async function exportOf(segments: ExportSegment[], overrides: Partial<ExportRequest> = {}) {
  const outputPath = join(dir, `export-${counter++}.mp4`);
  const request: ExportRequest = { segments, settings, resolution: 'keep', fps: 30, quality: 'house', outputPath, ...overrides };
  await runExport(join(dir, `work-${counter}`), request, ctx);
  return outputPath;
}

async function streams(path: string) {
  const { stdout } = await exec(ffprobePath, ['-v', 'error', '-count_frames', '-show_streams', '-of', 'json', path]);
  const parsed = JSON.parse(stdout) as { streams: Record<string, string | number>[] };
  const video = parsed.streams.find((stream) => stream.codec_type === 'video')!;
  const audio = parsed.streams.find((stream) => stream.codec_type === 'audio')!;
  return {
    frames: Number(video.nb_read_frames),
    width: video.width,
    height: video.height,
    rate: video.r_frame_rate,
    videoDuration: Number(video.duration),
    audioDuration: Number(audio.duration),
  };
}

/** Mono 8 kHz samples, for looking at where sounds landed. */
async function samples(path: string): Promise<Int16Array> {
  const { stdout } = await exec(ffmpegPath, ['-v', 'error', '-i', path, '-ac', '1', '-ar', '8000', '-f', 's16le', '-'], {
    encoding: 'buffer',
    maxBuffer: 64 * 1024 * 1024,
  });
  return new Int16Array(stdout.buffer, stdout.byteOffset, Math.floor(stdout.length / 2));
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ytp-export-'));
  const source = join(dir, 'tone.mp4');
  await runFfmpeg({
    args: ['-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=30:d=4', '-f', 'lavfi', '-i', 'sine=f=440:d=4', source],
  });
  const normalized = join(dir, 'tone');
  await mkdir(normalized);
  tone = await importMedia('tone', normalized, source, settings, ctx);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('needsFinalEncode', () => {
  const base = { segments: [], settings, resolution: 'keep', fps: 30, quality: 'house', outputPath: '' } as ExportRequest;

  it('skips encoding when the export matches the house format', () => {
    expect(needsFinalEncode(base)).toBe(false);
    expect(needsFinalEncode({ ...base, resolution: '720p' })).toBe(false);
  });

  it('encodes when anything differs', () => {
    expect(needsFinalEncode({ ...base, resolution: '1080p' })).toBe(true);
    expect(needsFinalEncode({ ...base, fps: 60 })).toBe(true);
    expect(needsFinalEncode({ ...base, quality: 'draft' })).toBe(true);
  });
});

describe('outputSize', () => {
  it('keeps the project shape', () => {
    expect(outputSize({ settings, resolution: '1080p' })).toEqual({ width: 1920, height: 1080 });
    expect(outputSize({ settings, resolution: 'keep' })).toEqual({ width: 1280, height: 720 });
  });
});

describe('concatList', () => {
  it('uses forward slashes and escapes quotes in paths', () => {
    expect(concatList([{ path: "C:\\Bob's clips\\a.mp4", seconds: 1.5 }])).toBe(
      `file 'C:/Bob'\\''s clips/a.mp4'\nduration 1.500000\n`,
    );
  });
});

describe('runExport', () => {
  it('joins clips with every frame accounted for', async () => {
    const path = await exportOf([segment(tone, 0, 1), segment(tone, 2, 3), segment(tone, 1, 1.5)]);
    const info = await streams(path);
    expect(info.frames).toBe(75);
    expect(Math.abs(info.videoDuration - 2.5)).toBeLessThan(0.05);
    expect(Math.abs(info.audioDuration - info.videoDuration)).toBeLessThan(0.05);
  });

  it('keeps sound in sync after many cuts', async () => {
    // A beep sits in the last piece. If each join loses or gains a little, it arrives late or early.
    const beepSource = join(dir, 'beep.mp4');
    await runFfmpeg({
      args: [
        '-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=30:d=2',
        '-f', 'lavfi', '-i', "aevalsrc='if(between(t,1,1.5),0.5*sin(2*PI*880*t),0):s=48000:d=2'",
        beepSource,
      ],
    });
    const beepDir = join(dir, 'beep');
    await mkdir(beepDir);
    const beep = await importMedia('beep', beepDir, beepSource, settings, ctx);

    const silentCuts = Array.from({ length: 20 }, (_, index) => segment(beep, 0.1 + index * 0.03, 0.3 + index * 0.03));
    const path = await exportOf([...silentCuts, segment(beep, 0.5, 2)]);

    const pcm = await samples(path);
    const firstLoud = pcm.findIndex((value) => Math.abs(value) > 3000) / 8000;
    const expected = 20 * 0.2 + 0.5;
    expect(Math.abs(firstLoud - expected)).toBeLessThan(0.005);
  });

  it('has no silent dropouts at the joins', async () => {
    const cuts = Array.from({ length: 10 }, (_, index) => segment(tone, index * 0.2, index * 0.2 + 0.2));
    const pcm = await samples(await exportOf(cuts));

    // 2 ms windows: a tone has no quiet ones, so any quiet window is a hole in the audio.
    const windowSize = 16;
    let longestGap = 0;
    let gap = 0;
    for (let start = 800; start + windowSize < pcm.length - 800; start += windowSize) {
      let peak = 0;
      for (let index = start; index < start + windowSize; index++) peak = Math.max(peak, Math.abs(pcm[index]));
      gap = peak < 200 ? gap + 2 : 0;
      longestGap = Math.max(longestGap, gap);
    }
    expect(longestGap).toBeLessThan(10);
  });

  it('copies whole files without cutting them', async () => {
    const info = await streams(await exportOf([segment(tone, 0, tone.duration), segment(tone, 0, tone.duration)]));
    expect(info.frames).toBe(240);
  });

  it('re-encodes to the requested size and frame rate', async () => {
    const path = await exportOf([segment(tone, 0, 1)], { resolution: '1080p', fps: 60, quality: 'draft' });
    const info = await streams(path);
    expect([info.width, info.height]).toEqual([1920, 1080]);
    expect(info.rate).toBe('60/1');
    expect(Math.abs(info.videoDuration - 1)).toBeLessThan(0.05);
  });

  it('copes with spaces and quotes in the output path', async () => {
    const folder = join(dir, "Bob's exports");
    await mkdir(folder);
    const outputPath = join(folder, 'my poop.mp4');
    await exportOf([segment(tone, 0, 1)], { outputPath });
    expect((await stat(outputPath)).size).toBeGreaterThan(0);
  });

  it('leaves an existing file alone when the export fails, and cleans up after itself', async () => {
    const outputPath = join(dir, 'precious.mp4');
    await writeFile(outputPath, 'do not lose me');
    const work = join(dir, 'failing-work');
    const request: ExportRequest = {
      segments: [segment({ ...tone, path: join(dir, 'missing.mp4') }, 0, 1)],
      settings,
      resolution: 'keep',
      fps: 30,
      quality: 'house',
      outputPath,
    };
    await expect(runExport(work, request, ctx)).rejects.toThrow();
    expect((await stat(outputPath)).size).toBe('do not lose me'.length);
  });

  it('removes its working files when it finishes', async () => {
    const work = join(dir, 'tidy-work');
    const request: ExportRequest = {
      segments: [segment(tone, 0, 1)],
      settings,
      resolution: 'keep',
      fps: 30,
      quality: 'house',
      outputPath: join(dir, 'tidy.mp4'),
    };
    await runExport(work, request, ctx);
    expect(await readdir(dir)).not.toContain('tidy-work');
  });
});
