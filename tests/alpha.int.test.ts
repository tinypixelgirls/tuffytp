import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ffmpegPath } from '../src/main/bin';
import { runExport } from '../src/main/export';
import { runFfmpeg, type JobContext } from '../src/main/ffmpeg';
import { importMedia } from '../src/main/normalize';
import { probe } from '../src/main/probe';
import { renderEffect } from '../src/main/render';
import { availableEffects } from '../src/main/effects';
import { listFilters } from '../src/main/ffmpeg';
import { mediaOverlay } from '../src/shared/layers';
import type { ExportRequest, MediaFile, ProjectSettings } from '../src/shared/types';

const exec = promisify(execFile);
const settings: ProjectSettings = { width: 320, height: 180, fps: 30, sampleRate: 48000 };
const ctx: JobContext = { signal: new AbortController().signal, report: () => {} };

let dir: string;
let blue: MediaFile;
let sticker: MediaFile;
let clip: MediaFile;

/** One frame as RGBA, read with libvpx when it's VP9 so the alpha survives. */
async function rgbaAt(path: string, seconds: number, width = settings.width): Promise<{ data: Buffer; width: number }> {
  const decoder = path.endsWith('.webm') ? ['-c:v', 'libvpx-vp9'] : [];
  const { stdout } = await exec(
    ffmpegPath,
    ['-v', 'error', '-ss', String(seconds), ...decoder, '-i', path, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'],
    { encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 },
  );
  return { data: stdout, width };
}

const at = ({ data, width }: { data: Buffer; width: number }, x: number, y: number) => {
  const offset = (y * width + x) * 4;
  return [data[offset], data[offset + 1], data[offset + 2], data[offset + 3]];
};

const near = (actual: number[], expected: number[], tolerance = 30) =>
  actual.every((value, index) => Math.abs(value - expected[index]) <= tolerance);

/** A red frame that's only opaque inside a square. drawbox can't make alpha, so geq does. */
const square = (x: string, y: string, size: number) =>
  `format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(between(X,${x},${x}+${size - 1})*between(Y,${y},${y}+${size - 1}),255,0)'`;

async function source(name: string, args: string[]): Promise<string> {
  const path = join(dir, name);
  await runFfmpeg({ args: [...args, path] });
  return path;
}

async function load(id: string, path: string): Promise<MediaFile> {
  const folder = join(dir, id);
  await mkdir(folder);
  return importMedia(id, folder, path, settings, ctx);
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ytp-alpha-'));
  blue = await load('blue', await source('blue.mp4', ['-f', 'lavfi', '-i', 'color=c=blue:s=320x180:r=30:d=3', '-f', 'lavfi', '-i', 'anullsrc', '-t', '3']));
  // A red square on a clear background, at a different size, so fitting gets tested too.
  sticker = await load(
    'sticker',
    await source('sticker.png', ['-f', 'lavfi', '-i', `color=c=red:s=160x90,${square('60', '25', 40)}`, '-frames:v', '1']),
  );
  // A transparent VP9 video: a moving red square, the way most "transparent webm" memes come.
  clip = await load(
    'clip',
    await source('clip.webm', [
      '-f', 'lavfi', '-i', `color=c=red:s=320x180:r=30:d=2,${square('40+T*40', '60', 60)}`,
      '-f', 'lavfi', '-i', 'sine=d=2',
      '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-auto-alt-ref', '0', '-c:a', 'libopus',
    ]),
  );
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('importing transparent media', () => {
  it('makes a transparent copy beside the house file', async () => {
    expect(sticker.alphaPath).toBeDefined();
    expect(clip.alphaPath).toBeDefined();
    expect(blue.alphaPath).toBeUndefined();

    const frame = await rgbaAt(sticker.alphaPath!, 0.5);
    expect(near(at(frame, 160, 90), [255, 0, 0, 255])).toBe(true);
    expect(at(frame, 20, 20)[3]).toBeLessThan(20);
    // The house file fills the clear parts with black.
    const flat = await rgbaAt(sticker.path, 0.5);
    expect(near(at(flat, 20, 20), [0, 0, 0, 255])).toBe(true);
  });

  it('reads VP9 alpha with libvpx, keeping it', async () => {
    const frame = await rgbaAt(clip.alphaPath!, 0.1);
    expect(at(frame, 300, 170)[3]).toBeLessThan(20);
    expect(at(frame, 70, 90)[3]).toBeGreaterThan(230);
    expect((await probe(clip.alphaPath!)).video?.alpha).toBe(true);
  });
});

describe('transparent media on layers', () => {
  it('shows the base through the clear parts in the export', async () => {
    const outputPath = join(dir, 'layered.mp4');
    const request: ExportRequest = {
      segments: [{ path: blue.path, in: 0, out: 3, mediaDuration: blue.duration }],
      settings,
      resolution: 'keep',
      fps: 30,
      quality: 'house',
      outputPath,
      composite: {
        layers: [{ id: 'l', name: 'L', hidden: false, muted: false, clips: [{ ...mediaOverlay(sticker.id, 2, 0.5), keyframes: [{ time: 0, x: 0.5, y: 0.5, scale: 1, rotation: 0, easing: 'linear' }] }] }],
        media: { [sticker.id]: sticker },
      },
    };
    await runExport(join(dir, 'work'), request, ctx);
    const frame = await rgbaAt(outputPath, 1);
    expect(near(at(frame, 160, 90), [255, 0, 0, 255])).toBe(true);
    expect(near(at(frame, 20, 20), [0, 0, 255, 255])).toBe(true);
  });
});

describe('effects on transparent media', () => {
  it('keeps the alpha through a timing effect', async () => {
    const pool = availableEffects(await listFilters());
    const folder = join(dir, 'sus');
    await mkdir(folder);
    const result = await renderEffect(
      'sus',
      folder,
      { pieces: [{ source: clip, in: 0, out: 1 }], effectId: 'sus', settings, keepAlpha: true },
      { pool, filters: await listFilters() },
      ctx,
    );
    expect(result.media.alphaPath).toBeDefined();
    expect(Math.abs(result.media.duration - 2)).toBeLessThan(0.1);
    // Reversed half: at 1.9 s it's back near the start position, still with a clear background.
    const frame = await rgbaAt(result.media.alphaPath!, 1.9);
    expect(at(frame, 300, 170)[3]).toBeLessThan(20);
    expect(at(frame, 70, 90)[3]).toBeGreaterThan(230);
    // The house copy has the clear parts filled in.
    const flat = await rgbaAt(result.media.path, 1.9);
    expect(near(at(flat, 300, 170), [0, 0, 0, 255])).toBe(true);
  });

  it('keeps the alpha through a CHAOS roll', async () => {
    const pool = availableEffects(await listFilters());
    const folder = join(dir, 'chaos');
    await mkdir(folder);
    const result = await renderEffect(
      'chaos',
      folder,
      { pieces: [{ source: clip, in: 0, out: 0.5 }], effectId: 'chaos', settings, keepAlpha: true },
      { pool, filters: await listFilters(), random: (() => { let seed = 7; return () => ((seed = (seed * 16807) % 2147483647) / 2147483647); })() },
      ctx,
    );
    expect(result.media.alphaPath).toBeDefined();
    expect((await probe(result.media.alphaPath!)).duration).toBeGreaterThan(0);
  });
});
