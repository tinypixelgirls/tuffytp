import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ffprobePath } from '../src/main/bin';
import { JobCancelled, JobQueue, runFfmpeg, type JobContext } from '../src/main/ffmpeg';
import { importMedia } from '../src/main/normalize';
import { probe } from '../src/main/probe';
import type { ProjectSettings, WaveformPeaks } from '../src/shared/types';

const settings: ProjectSettings = { width: 1280, height: 720, fps: 30, sampleRate: 48000 };

const video = (size: string, rate = 25) => `testsrc2=s=${size}:r=${rate}:d=3`;
const tone = 'sine=f=440:d=3';

// Each source differs from the house format in a way that normalization has to fix.
const sources: { name: string; inputs: string[]; encode: string[]; duration: number }[] = [
  {
    name: 'plain.mp4',
    inputs: ['-f', 'lavfi', '-i', video('640x360'), '-f', 'lavfi', '-i', tone],
    encode: ['-c:v', 'libx264', '-c:a', 'aac'],
    duration: 3,
  },
  {
    name: 'plain.mkv',
    inputs: ['-f', 'lavfi', '-i', video('640x360'), '-f', 'lavfi', '-i', tone],
    encode: ['-c:v', 'libx264', '-c:a', 'libopus'],
    duration: 3,
  },
  {
    name: 'portrait-no-audio.mp4',
    inputs: ['-f', 'lavfi', '-i', video('360x640')],
    encode: ['-c:v', 'libx264'],
    duration: 3,
  },
  {
    name: 'short-audio.mkv',
    inputs: ['-f', 'lavfi', '-i', video('640x360'), '-f', 'lavfi', '-i', 'sine=f=440:d=1.5'],
    encode: ['-c:v', 'libx264', '-c:a', 'aac'],
    duration: 3,
  },
  {
    name: 'modern.webm',
    inputs: ['-f', 'lavfi', '-i', video('640x360'), '-f', 'lavfi', '-i', tone],
    encode: ['-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-c:a', 'libopus'],
    duration: 3,
  },
  {
    name: 'av1.mp4',
    inputs: ['-f', 'lavfi', '-i', video('320x180'), '-f', 'lavfi', '-i', tone],
    encode: ['-c:v', 'libaom-av1', '-cpu-used', '8', '-crf', '40', '-c:a', 'aac'],
    duration: 3,
  },
  {
    name: 'animation.gif',
    inputs: ['-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=10:d=2'],
    encode: [],
    duration: 2,
  },
  {
    name: 'still.png',
    inputs: ['-f', 'lavfi', '-i', 'testsrc2=s=640x480:r=1:d=1'],
    encode: ['-frames:v', '1'],
    duration: 2,
  },
  {
    name: 'audio-only.mp3',
    inputs: ['-f', 'lavfi', '-i', tone],
    encode: ['-c:a', 'libmp3lame'],
    duration: 3,
  },
];

function testContext(): JobContext & { reports: (number | null)[] } {
  const reports: (number | null)[] = [];
  return { signal: new AbortController().signal, reports, report: (value) => reports.push(value) };
}

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ytp-normalize-'));
  for (const source of sources) {
    await runFfmpeg({ args: [...source.inputs, ...source.encode, join(dir, source.name)] });
  }
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('importMedia', () => {
  it.each(sources)('normalizes $name to the house format', async (source) => {
    const out = join(dir, `out-${source.name}`);
    await mkdir(out);
    const ctx = testContext();

    const media = await importMedia('test', out, join(dir, source.name), settings, ctx);

    expect(media.width).toBe(1280);
    expect(media.height).toBe(720);
    expect(media.fps).toBe(30);
    expect(media.duration).toBeGreaterThan(source.duration - 0.1);
    expect(media.duration).toBeLessThan(source.duration + 0.1);

    // Audio and video must stay the same length or concat will drift later.
    const streams = await probeStreams(media.path);
    expect(streams.video).toEqual({ codec: 'h264', pixFmt: 'yuv420p' });
    expect(streams.audio).toEqual({ codec: 'aac', sampleRate: '48000', channels: 2 });
    expect(Math.abs(streams.audioDuration - streams.videoDuration)).toBeLessThan(0.05);

    const peaks = JSON.parse(await readFile(media.peaksPath!, 'utf8')) as WaveformPeaks;
    expect(peaks.min.length).toBeGreaterThan(source.duration * peaks.bucketsPerSecond - 5);
    expect(peaks.min.length).toBe(peaks.max.length);

    const grid = media.thumbGrid!;
    expect(grid.cols).toBe(Math.ceil(media.duration));
    const sprite = await probe(media.thumbsPath!);
    expect(sprite.video).toMatchObject({ width: grid.cols * grid.tileWidth, height: grid.rows * grid.tileHeight });

    const fractions = ctx.reports.filter((value): value is number => value !== null);
    expect(fractions.every((value) => value >= 0 && value <= 1)).toBe(true);
  });

  it('rejects a file that has no media in it', async () => {
    const out = join(dir, 'out-junk');
    await mkdir(out);
    await expect(importMedia('test', out, join(dir, 'missing.mp4'), settings, testContext())).rejects.toThrow();
  });
});

describe('JobQueue', () => {
  // Generates far more video than the test will ever wait for.
  const endless = (out: string) => ['-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=30:d=600', join(dir, out)];

  it('kills a running job on cancel', async () => {
    const updates: string[] = [];
    let jobId = '';
    const queue = new JobQueue((job) => {
      jobId = job.id;
      updates.push(job.status);
    });

    const job = queue.add('import', 'slow', (ctx) => runFfmpeg({ args: endless('cancelled.mp4'), signal: ctx.signal }));
    await new Promise((resolve) => setTimeout(resolve, 300));
    const started = Date.now();
    queue.cancel(jobId);

    await expect(job).rejects.toBeInstanceOf(JobCancelled);
    expect(Date.now() - started).toBeLessThan(3000);
    expect(updates.at(-1)).toBe('cancelled');
  });

  it('runs jobs in order and can cancel one still in the queue', async () => {
    const order: string[] = [];
    const ids = new Map<string, string>();
    const queue = new JobQueue((job) => ids.set(job.label, job.id));

    const work = (label: string) => async () => {
      order.push(label);
    };
    const first = queue.add('import', 'first', work('first'));
    const second = queue.add('import', 'second', work('second'));
    const third = queue.add('import', 'third', work('third'));
    queue.cancel(ids.get('second')!);

    await first;
    await third;
    await expect(second).rejects.toBeInstanceOf(JobCancelled);
    expect(order).toEqual(['first', 'third']);
  });
});

async function probeStreams(path: string) {
  const { stdout } = await promisify(execFile)(ffprobePath, ['-v', 'error', '-show_streams', '-of', 'json', path]);
  const { streams } = JSON.parse(stdout) as {
    streams: Record<string, string | number>[];
  };
  const video = streams.find((stream) => stream.codec_type === 'video')!;
  const audio = streams.find((stream) => stream.codec_type === 'audio')!;
  return {
    video: { codec: video.codec_name, pixFmt: video.pix_fmt },
    audio: { codec: audio.codec_name, sampleRate: audio.sample_rate, channels: audio.channels },
    videoDuration: Number(video.duration),
    audioDuration: Number(audio.duration),
  };
}
