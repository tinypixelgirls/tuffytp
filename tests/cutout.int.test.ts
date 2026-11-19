import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AiSidecar } from '../src/main/ai';
import { ffmpegPath } from '../src/main/bin';
import { closeAllCutouts, maskFilter, openCutout, saveCutout, setCutoutPoints, trackCutout } from '../src/main/cutout';
import { runFfmpeg, type JobContext } from '../src/main/ffmpeg';
import { importMedia } from '../src/main/normalize';
import type { MediaFile, ProjectSettings } from '../src/shared/types';

const exec = promisify(execFile);
const settings: ProjectSettings = { width: 320, height: 180, fps: 30, sampleRate: 48000 };
const ctx: JobContext = { signal: new AbortController().signal, report: () => {} };
const SERVER = fileURLToPath(new URL('../src/main/ai/server.py', import.meta.url));

let dir: string;
let shot: MediaFile;
let sidecar: AiSidecar;

async function rgbaAt(path: string, seconds: number) {
  const decoder = path.endsWith('.webm') ? ['-c:v', 'libvpx-vp9'] : [];
  const { stdout } = await exec(
    ffmpegPath,
    ['-v', 'error', '-ss', String(seconds), ...decoder, '-i', path, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'],
    { encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 },
  );
  return (x: number, y: number) => {
    const offset = (y * settings.width + x) * 4;
    return [stdout[offset], stdout[offset + 1], stdout[offset + 2], stdout[offset + 3]];
  };
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ytp-cutout-'));
  // A red "character" walking across a blue background.
  const source = join(dir, 'shot.mp4');
  await runFfmpeg({
    args: [
      '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:r=30:d=2',
      '-f', 'lavfi', '-i', 'color=c=red:s=60x80:r=30:d=2',
      '-f', 'lavfi', '-i', 'sine=d=2',
      // drawbox's "t" is its line thickness, so the movement comes from overlay, where t is time.
      '-filter_complex', "[0:v][1:v]overlay=x='40+t*60':y=50[v]",
      '-map', '[v]', '-map', '2:a',
      source,
    ],
  });
  await mkdir(join(dir, 'shot'));
  shot = await importMedia('shot', join(dir, 'shot'), source, settings, ctx);
  sidecar = new AiSidecar('python3', [SERVER, '--fake']);
});

afterAll(async () => {
  await closeAllCutouts(sidecar);
  sidecar.stop();
  await rm(dir, { recursive: true, force: true });
});

describe('maskFilter', () => {
  it('grows, shrinks and feathers', () => {
    expect(maskFilter({ grow: 2, feather: 0 }, settings)).toBe('format=gray,scale=320:180,dilation,dilation');
    expect(maskFilter({ grow: -1, feather: 4 }, settings)).toBe('format=gray,scale=320:180,erosion,gblur=sigma=2.00');
    expect(maskFilter({ grow: 999, feather: 0 }, settings).split('dilation')).toHaveLength(21);
  });
});

describe('cutout', () => {
  it('cuts the character out of every frame into transparent media', async () => {
    const cacheDir = join(dir, 'cache');
    const session = await openCutout(cacheDir, [{ source: shot, in: 0.5, out: 1.5 }], settings, sidecar, ctx);
    expect(session.frames).toBe(30);
    expect(await readdir(join(cacheDir, session.folder, 'frames'))).toHaveLength(30);

    // Saving before tracking isn't allowed.
    await expect(saveCutout(session.id, 'early', join(dir, 'early'), { grow: 0, feather: 0, background: '#00ff00', name: 'x' }, ctx)).rejects.toThrow(/Track/);

    // At 0.5 s the square spans x 70..130.
    const version = await setCutoutPoints(session.id, 0, [{ x: 100, y: 90, keep: true }], sidecar);
    expect(version).toBe(1);
    expect(await readdir(join(cacheDir, session.folder, 'masks'))).toEqual(['00000.png']);

    const progress: number[] = [];
    await trackCutout(session.id, sidecar, { ...ctx, report: (value) => value !== null && progress.push(value) });
    expect(progress.at(-1)).toBe(1);
    expect(await readdir(join(cacheDir, session.folder, 'masks'))).toHaveLength(30);

    const mediaDir = join(dir, 'cut');
    await mkdir(mediaDir);
    const media = await saveCutout(session.id, 'cut', mediaDir, { grow: 0, feather: 0, background: '#00ff00', name: 'Shot @ 0:00' }, ctx);
    expect(media.alphaPath).toBeDefined();
    expect(media.origin).toMatchObject({ kind: 'cutout', name: 'Shot @ 0:00', fromMedia: 'shot', in: 0.5, out: 1.5 });
    expect(Math.abs(media.duration - 1)).toBeLessThan(0.1);

    // Half a second in, the square has moved to x 100..160.
    const alpha = await rgbaAt(media.alphaPath!, 0.5);
    expect(alpha(130, 90)[3]).toBeGreaterThan(230);
    expect(alpha(130, 90)[0]).toBeGreaterThan(200);
    expect(alpha(30, 90)[3]).toBeLessThan(20);
    expect(alpha(250, 160)[3]).toBeLessThan(20);

    // The flat copy sits on green, ready to key.
    const flat = await rgbaAt(media.path, 0.5);
    expect(flat(30, 90)[1]).toBeGreaterThan(200);
    expect(flat(30, 90)[2]).toBeLessThan(60);
  });

  it('says so when there is nothing to track', async () => {
    const session = await openCutout(join(dir, 'cache'), [{ source: shot, in: 0, out: 0.3 }], settings, sidecar, ctx);
    await expect(trackCutout(session.id, sidecar, ctx)).rejects.toThrow(/Click on the character/);
  });

  it('joins a selection that spans clips', async () => {
    const session = await openCutout(
      join(dir, 'cache'),
      [
        { source: shot, in: 0, out: 0.5 },
        { source: shot, in: 1, out: 1.5 },
      ],
      settings,
      sidecar,
      ctx,
    );
    // Joining can round up to one extra frame.
    expect(session.frames).toBeGreaterThanOrEqual(30);
    expect(session.frames).toBeLessThanOrEqual(31);
  });
});

describe('AiSidecar', () => {
  it("reports why the model couldn't load", async () => {
    // No PyTorch in the test environment, so the real backend fails to start.
    const broken = new AiSidecar('python3', [SERVER, '--checkpoint', 'missing.pt']);
    await expect(broken.start()).rejects.toThrow(/Error/);
    broken.stop();
  });

  it('rejects requests when the helper dies', async () => {
    const helper = new AiSidecar('python3', ['-c', 'import json,sys; print(json.dumps({"ready": True, "backend": "x", "device": "cpu", "gpu": None})); sys.stdout.flush(); sys.stdin.readline()']);
    await helper.start();
    await expect(helper.request('open', {})).rejects.toThrow(/stopped/);
  });
});
