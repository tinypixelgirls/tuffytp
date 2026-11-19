import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ffmpegPath } from '../src/main/bin';
import { filterPath, findFonts, planComposite } from '../src/main/composite';
import { runExport, stackLayers } from '../src/main/export';
import { runFfmpeg, type JobContext } from '../src/main/ffmpeg';
import { importMedia } from '../src/main/normalize';
import { probe } from '../src/main/probe';
import { GREEN_SCREEN, mediaOverlay, textOverlay, type Layer, type OverlayClip } from '../src/shared/layers';
import type { CompositeRequest, ExportRequest, MediaFile, ProjectSettings } from '../src/shared/types';

const exec = promisify(execFile);
// Small frames keep these renders quick; nothing here depends on the size.
const settings: ProjectSettings = { width: 320, height: 180, fps: 30, sampleRate: 48000 };
const ctx: JobContext = { signal: new AbortController().signal, report: () => {} };

let dir: string;
let blue: MediaFile;
let gray: MediaFile;
/** A red square on a green screen. */
let screen: MediaFile;
let red: MediaFile;
let counter = 0;

type Rgb = [number, number, number];

async function frameAt(path: string, seconds: number): Promise<Buffer> {
  const { stdout } = await exec(
    ffmpegPath,
    ['-v', 'error', '-ss', String(seconds), '-i', path, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
    { encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 },
  );
  return stdout;
}

function pixel(frame: Buffer, x: number, y: number): Rgb {
  const offset = (Math.round(y) * settings.width + Math.round(x)) * 3;
  return [frame[offset], frame[offset + 1], frame[offset + 2]];
}

/** Within a few levels per channel: the house encode is lossy. */
function near(actual: Rgb, expected: Rgb, tolerance = 24): boolean {
  return actual.every((value, index) => Math.abs(value - expected[index]) <= tolerance);
}

async function makeMedia(name: string, video: string, audio = 'anullsrc=r=48000:cl=stereo'): Promise<MediaFile> {
  const source = join(dir, `${name}.mp4`);
  await runFfmpeg({ args: ['-f', 'lavfi', '-i', video, '-f', 'lavfi', '-i', audio, '-t', '3', source] });
  const folder = join(dir, name);
  await mkdir(folder);
  return importMedia(name, folder, source, settings, ctx);
}

const layer = (clips: OverlayClip[], extra: Partial<Layer> = {}): Layer => ({
  id: crypto.randomUUID(),
  name: 'Layer',
  hidden: false,
  muted: false,
  clips,
  ...extra,
});

async function exportWith(base: MediaFile, layers: Layer[], seconds = 3): Promise<string> {
  const outputPath = join(dir, `composite-${counter++}.mp4`);
  const media = Object.fromEntries([blue, gray, screen, red].map((item) => [item.id, item]));
  const request: ExportRequest = {
    segments: [{ path: base.path, in: 0, out: seconds, mediaDuration: base.duration }],
    settings,
    resolution: 'keep',
    fps: settings.fps,
    quality: 'house',
    outputPath,
    composite: { layers, media },
  };
  await runExport(join(dir, `work-${counter}`), request, ctx);
  return outputPath;
}

const BLUE: Rgb = [0, 0, 255];
const RED: Rgb = [255, 0, 0];
const CENTER = { x: settings.width / 2, y: settings.height / 2 };

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ytp-composite-'));
  blue = await makeMedia('blue', 'color=c=blue:s=320x180:r=30:d=3', 'sine=f=440:d=3');
  gray = await makeMedia('gray', 'color=c=0x808080:s=320x180:r=30:d=3');
  red = await makeMedia('red', 'color=c=red:s=320x180:r=30:d=3');
  screen = await makeMedia(
    'screen',
    'color=c=0x00ff00:s=320x180:r=30:d=3,drawbox=x=120:y=50:w=80:h=80:color=red:t=fill',
    'sine=f=880:d=3',
  );
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('filterPath', () => {
  it('escapes drive colons and quotes for filter options', () => {
    expect(filterPath("C:\\Windows\\Fonts\\Bob's.ttf")).toBe(`'C\\:/Windows/Fonts/Bob'\\''s.ttf'`);
  });
});

describe('planComposite', () => {
  const composite = (layers: Layer[]): CompositeRequest => ({ layers, media: { m: { path: '/m.mp4', duration: 3 } } });

  it('leaves out hidden layers and clips that start after the end', () => {
    const late = { ...mediaOverlay('m', 1, 5) };
    const hidden = layer([mediaOverlay('m', 1, 0)], { hidden: true });
    const plan = planComposite(composite([layer([late]), hidden]), 3, settings, {}, dir, 'null');
    expect(plan.inputs).toEqual([]);
    expect(plan.filter).toContain('[0:v]null[vout]');
  });

  it('cuts a clip that runs past the end', () => {
    const plan = planComposite(composite([layer([mediaOverlay('m', 3, 2)])]), 3, settings, {}, dir, 'null');
    expect(plan.inputs).toEqual(['-ss', '0', '-t', '1', '-i', '/m.mp4']);
  });

  it('mixes in sound only from unmuted layers with volume', () => {
    const loud = mediaOverlay('m', 1, 0);
    const quiet = { ...mediaOverlay('m', 1, 0), volume: 0 };
    const muted = layer([mediaOverlay('m', 1, 0)], { muted: true });
    const plan = planComposite(composite([layer([loud, quiet]), muted]), 3, settings, {}, dir, 'null');
    expect(plan.filter).toContain('amix=inputs=2');
  });
});

describe('composite export', () => {
  it('keys out the green screen and places the clip at the right time', async () => {
    const clip = { ...mediaOverlay(screen.id, 1, 1), key: GREEN_SCREEN };
    const path = await exportWith(blue, [layer([clip])]);

    const before = await frameAt(path, 0.5);
    const during = await frameAt(path, 1.5);
    const after = await frameAt(path, 2.5);
    expect(near(pixel(before, CENTER.x, CENTER.y), BLUE)).toBe(true);
    // Half size and centred: the red square shows in the middle, the green around it is gone.
    expect(near(pixel(during, CENTER.x, CENTER.y), RED)).toBe(true);
    expect(near(pixel(during, CENTER.x + 60, CENTER.y), BLUE)).toBe(true);
    expect(near(pixel(after, CENTER.x, CENTER.y), BLUE)).toBe(true);

    const info = await probe(path);
    expect(Math.abs(info.duration - 3)).toBeLessThan(0.1);
  });

  it('follows keyframes as the clip plays', async () => {
    const clip: OverlayClip = {
      ...mediaOverlay(red.id, 2, 0.5),
      keyframes: [
        { time: 0, x: 0.25, y: 0.5, scale: 0.2, rotation: 0, easing: 'linear' },
        { time: 2, x: 0.75, y: 0.5, scale: 0.2, rotation: 0, easing: 'linear' },
      ],
    };
    const path = await exportWith(blue, [layer([clip])]);

    // Half a second in it's an eighth of the way across; at 1.5 s in, near the far side.
    const early = await frameAt(path, 1);
    const late = await frameAt(path, 2);
    const at = (fraction: number) => settings.width * fraction;
    expect(near(pixel(early, at(0.3125), CENTER.y), RED)).toBe(true);
    expect(near(pixel(early, at(0.6875), CENTER.y), BLUE)).toBe(true);
    expect(near(pixel(late, at(0.6875), CENTER.y), RED)).toBe(true);
    expect(near(pixel(late, at(0.3125), CENTER.y), BLUE)).toBe(true);
  });

  it('rotates, fades and blends', async () => {
    const spun: OverlayClip = {
      ...mediaOverlay(red.id, 3, 0),
      keyframes: [{ time: 0, x: 0.5, y: 0.5, scale: 0.4, rotation: 45, easing: 'linear' }],
      opacity: 0.5,
      blend: 'multiply',
    };
    const path = await exportWith(gray, [layer([spun])]);
    const frame = await frameAt(path, 1);
    // Multiply by red keeps the red channel, half strength since the layer is half see-through.
    expect(near(pixel(frame, CENTER.x, CENTER.y), [128, 64, 64])).toBe(true);
    // The unrotated corner of the box is outside the diamond a 45° turn makes.
    expect(near(pixel(frame, CENTER.x - 60, CENTER.y - 33), [128, 128, 128])).toBe(true);
  });

  it('draws text', async () => {
    const fonts = await findFonts();
    if (!fonts.sans) return;
    const text = textOverlay(0, { text: 'YTP\nTIME', size: 0.3, color: '#ffff00', font: 'sans' });
    const path = await exportWith(blue, [layer([{ ...text, keyframes: [{ ...text.keyframes[0], y: 0.5 }] }])]);
    const frame = await frameAt(path, 1);
    let yellow = 0;
    for (let y = 0; y < settings.height; y += 2) {
      for (let x = 0; x < settings.width; x += 2) {
        if (near(pixel(frame, x, y), [255, 255, 0], 60)) yellow++;
      }
    }
    expect(yellow).toBeGreaterThan(200);
  });

  it('mixes in a layer clip\'s sound', async () => {
    const path = await exportWith(gray, [layer([{ ...mediaOverlay(screen.id, 1, 1), volume: 1 }])]);
    const { stdout } = await exec(
      ffmpegPath,
      ['-v', 'error', '-i', path, '-ac', '1', '-ar', '8000', '-f', 's16le', '-'],
      { encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 },
    );
    const samples = new Int16Array(stdout.buffer, stdout.byteOffset, Math.floor(stdout.length / 2));
    const loudest = (from: number, to: number) => {
      let peak = 0;
      for (let index = from * 8000; index < to * 8000; index++) peak = Math.max(peak, Math.abs(samples[index] ?? 0));
      return peak;
    };
    expect(loudest(0.1, 0.9)).toBeLessThan(500);
    // ffmpeg's sine source plays at an eighth of full scale, about 4000.
    expect(loudest(1.1, 1.9)).toBeGreaterThan(2000);
  });
});

describe('stackLayers', () => {
  it('stacks clips over several passes in the same order as one pass', async () => {
    // Three overlapping squares, each drawn over the last. The top one must win in the middle.
    const square = (media: MediaFile, x: number): OverlayClip => ({
      ...mediaOverlay(media.id, 2, 0.5),
      keyframes: [{ time: 0, x, y: 0.5, scale: 0.3, rotation: 0, easing: 'linear' }],
    });
    const layers = [layer([square(red, 0.45)]), layer([square(gray, 0.5)]), layer([square(screen, 0.55)])];
    const media = Object.fromEntries([gray, screen, red].map((item) => [item.id, item]));
    const request: ExportRequest = {
      segments: [],
      settings,
      resolution: 'keep',
      fps: settings.fps,
      quality: 'house',
      outputPath: '',
      composite: { layers, media },
    };
    const outPath = join(dir, 'passes.mp4');
    const work = join(dir, 'passes-work');
    await mkdir(work);
    await stackLayers(work, blue.path, request, outPath, ctx, 1);

    const frame = await frameAt(outPath, 1.5);
    // The screen clip is green with a red middle; its green sits on top at the centre-right.
    expect(near(pixel(frame, CENTER.x + 40, CENTER.y), [0, 255, 0])).toBe(true);
    // Left of the green square's edge, the gray one shows over the red one.
    expect(near(pixel(frame, settings.width * 0.37, CENTER.y), [128, 128, 128])).toBe(true);
    // Further left, only the red one reaches.
    expect(near(pixel(frame, settings.width * 0.32, CENTER.y), RED)).toBe(true);
    expect(Math.abs((await probe(outPath)).duration - 3)).toBeLessThan(0.1);
  });
});
