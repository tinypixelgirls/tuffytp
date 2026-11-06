import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ffmpegPath, ffprobePath } from '../src/main/bin';
import { availableEffects, effects, getEffect, resolveParams } from '../src/main/effects';
import { listFilters, runFfmpeg, type JobContext } from '../src/main/ffmpeg';
import { importMedia } from '../src/main/normalize';
import { renderEffect, type RenderOptions } from '../src/main/render';
import { defaultParams, type EffectParams } from '../src/shared/effects';
import type { MediaFile, ProjectSettings, WaveformPeaks } from '../src/shared/types';

const exec = promisify(execFile);
const settings: ProjectSettings = { width: 1280, height: 720, fps: 30, sampleRate: 48000 };
const ctx: JobContext = { signal: new AbortController().signal, report: () => {} };

let dir: string;
let clip: MediaFile;
let options: RenderOptions;
let counter = 0;

const render = async (source: MediaFile, start: number, end: number, effectId: string, params?: EffectParams) => {
  const out = join(dir, `render-${counter++}`);
  await mkdir(out);
  const request = { pieces: [{ source, in: start, out: end }], effectId, params, settings };
  return renderEffect(`media-${counter}`, out, request, options, ctx);
};

async function streamDurations(path: string) {
  const { stdout } = await exec(ffprobePath, ['-v', 'error', '-show_streams', '-of', 'json', path]);
  const { streams } = JSON.parse(stdout) as { streams: { codec_type: string; duration: string }[] };
  const of = (type: string) => Number(streams.find((stream) => stream.codec_type === type)!.duration);
  return { video: of('video'), audio: of('audio') };
}

/** One frame as tiny grayscale pixels, for comparing pictures without worrying about codecs. */
async function frameAt(path: string, seconds: number) {
  const { stdout } = await exec(
    ffmpegPath,
    ['-v', 'error', '-ss', String(seconds), '-i', path, '-frames:v', '1', '-vf', 'scale=64:36,format=gray', '-f', 'rawvideo', '-'],
    { encoding: 'buffer', maxBuffer: 1024 * 1024 },
  );
  return stdout;
}

function pictureDistance(a: Buffer, b: Buffer): number {
  let total = 0;
  for (let index = 0; index < a.length; index++) total += Math.abs(a[index] - b[index]);
  return total / a.length;
}

const loudness = async (media: MediaFile) => {
  const peaks = JSON.parse(await readFile(media.peaksPath!, 'utf8')) as WaveformPeaks;
  return Math.max(...peaks.max.map((value, index) => Math.max(value, -peaks.min[index])));
};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ytp-render-'));
  const source = join(dir, 'source.mp4');
  await runFfmpeg({
    args: ['-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=30:d=3', '-f', 'lavfi', '-i', 'sine=f=440:d=3', source],
  });
  const normalized = join(dir, 'clip');
  await mkdir(normalized);
  clip = await importMedia('clip', normalized, source, settings, ctx);
  options = { pool: effects, filters: await listFilters() };
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('every effect', () => {
  const single = effects.filter((effect) => !effect.expand);

  it.each(single)('$id renders at its expected length with audio and video matched', async (effect) => {
    const { media } = await render(clip, 0, 3, effect.id);
    const params = resolveParams(effect, defaultParams(effect.params));
    const expected = effect.expectedDuration?.(params, 3) ?? 3;

    // Within a frame and a bit: on a short clip, anything looser is an audible timing error.
    if (effect.variableLength) expect(media.duration).toBeGreaterThan(0.2);
    else expect(Math.abs(media.duration - expected)).toBeLessThan(0.05);
    expect([media.width, media.height, media.fps]).toEqual([1280, 720, 30]);

    const { video, audio } = await streamDurations(media.path);
    expect(Math.abs(video - audio)).toBeLessThan(0.05);
  });

  it.each(single.flatMap((effect) =>
    effect.params.flatMap((param) =>
      (param.options ?? []).slice(1).map((option) => ({ id: effect.id, key: param.key, option })),
    ),
  ))('$id also renders with $key=$option', async ({ id, key, option }) => {
    const { media } = await render(clip, 0, 1, id, { [key]: option });
    expect(media.duration).toBeGreaterThan(0.2);
  });
});

describe('selections and text', () => {
  it('joins a selection across two clips before applying the effect', async () => {
    const out = join(dir, 'multi');
    await mkdir(out);
    const pieces = [{ source: clip, in: 0, out: 0.5 }, { source: clip, in: 2, out: 2.5 }];
    const { media } = await renderEffect('multi', out, { pieces, effectId: 'sus', settings }, options, ctx);
    expect(media.duration).toBeCloseTo(2, 1);

    const start = await frameAt(clip.path, 0);
    const join2 = await frameAt(clip.path, 2);
    expect(pictureDistance(await frameAt(media.path, 0), start)).toBeLessThan(2);
    expect(pictureDistance(await frameAt(media.path, 0.5), join2)).toBeLessThan(5);
  });

  it.each([
    ["it's got: colons, commas; and 'quotes'"],
    ['back\\slash and 100% and [brackets]'],
    ['%{pts} is not expanded'],
    ['"; rm -rf /'],
    ['ÜÑÍÇÖDÉ 🔥'],
  ])('survives typing %s into a text effect', async (typed) => {
    const { media } = await render(clip, 0, 0.5, 'impacttext', { top: typed, bottom: typed });
    expect(media.duration).toBeCloseTo(0.5, 1);
  });
});

describe('what the effects actually do', () => {
  it('SUS plays the selection, then the same frames backwards', async () => {
    const { media } = await render(clip, 1, 2, 'sus');
    expect(media.duration).toBeCloseTo(2, 1);

    const first = await frameAt(media.path, 0);
    const middleForward = await frameAt(media.path, 0.5);
    const middleBackward = await frameAt(media.path, 1.5);
    const last = await frameAt(media.path, media.duration - 0.04);

    expect(pictureDistance(first, last)).toBeLessThan(2);
    expect(pictureDistance(middleForward, middleBackward)).toBeLessThan(2);
    expect(pictureDistance(first, middleForward)).toBeGreaterThan(pictureDistance(first, last) + 1);
  });

  it('SUS mirrors the audio too, which is what makes "FRI" into "FRIIRF"', async () => {
    const source = join(dir, 'ramp.mp4');
    const rampIn = join(dir, 'ramp');
    await mkdir(rampIn);
    await runFfmpeg({
      args: [
        '-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=30:d=2',
        '-f', 'lavfi', '-i', "aevalsrc='0.45*t*sin(2*PI*440*t):s=48000:d=2'",
        source,
      ],
    });
    const ramp = await importMedia('ramp', rampIn, source, settings, ctx);

    const { media } = await render(ramp, 0, 2, 'sus');
    const { max, bucketsPerSecond } = JSON.parse(await readFile(media.peaksPath!, 'utf8')) as WaveformPeaks;
    const levelAt = (seconds: number) => max[Math.round(seconds * bucketsPerSecond)];

    // Quiet to loud, then loud back to quiet, peaking at the join.
    expect(levelAt(0.2)).toBeLessThan(levelAt(1.0));
    expect(levelAt(1.0)).toBeLessThan(levelAt(1.9));
    expect(levelAt(2.1)).toBeGreaterThan(levelAt(3.0));
    expect(levelAt(3.0)).toBeGreaterThan(levelAt(3.8));
    expect(levelAt(1.0)).toBeCloseTo(levelAt(3.0), 1);
  });

  it('cuts exactly where the selection says', async () => {
    const { media } = await render(clip, 1, 2, 'invert');
    const expected = await frameAt(clip.path, 1);
    const got = await render(clip, 1, 2, 'mute');
    expect(media.duration).toBeCloseTo(1, 1);
    expect(pictureDistance(await frameAt(got.media.path, 0), expected)).toBeLessThan(2);
  });

  it('REVERSE ends on the frame the selection started on', async () => {
    const { media } = await render(clip, 1, 2, 'reverse');
    const start = await frameAt(clip.path, 1);
    expect(pictureDistance(await frameAt(media.path, media.duration - 0.04), start)).toBeLessThan(2);
  });

  it('MUTE really is silent, and EAR RAPE is loud but held under the limit', async () => {
    const quiet = await render(clip, 0, 1, 'mute');
    expect(await loudness(quiet.media)).toBeLessThan(0.01);

    const loud = await render(clip, 0, 1, 'earrape', { intensity: 10 });
    const original = await loudness(clip);
    const level = await loudness(loud.media);
    expect(level).toBeGreaterThan(original * 2);
    expect(level).toBeLessThanOrEqual(1);
  });

  it('STAREDOWN freezes, zooms in during the hold, and goes silent', async () => {
    const { media } = await render(clip, 1, 2, 'staredown', { holdSec: 2 });
    expect(media.duration).toBeCloseTo(3, 1);

    const lastFrame = await frameAt(clip.path, 1.96);
    const distanceAt = async (seconds: number) => pictureDistance(await frameAt(media.path, seconds), lastFrame);

    // Up to the hold it's the selection itself; after that the frozen frame drifts further away.
    expect(await distanceAt(0.97)).toBeLessThan(2);
    const early = await distanceAt(1.3);
    const late = await distanceAt(2.9);
    expect(late).toBeGreaterThan(early);

    const { max, bucketsPerSecond } = JSON.parse(await readFile(media.peaksPath!, 'utf8')) as WaveformPeaks;
    const held = max.slice(Math.round(1.1 * bucketsPerSecond));
    expect(Math.max(...held)).toBeLessThan(0.01);
    expect(Math.max(...max.slice(0, bucketsPerSecond))).toBeGreaterThan(0.05);
  });

  it('stacks: an effect can run on the output of another', async () => {
    const first = await render(clip, 1, 2, 'sus');
    const second = await render(first.media, 0, first.media.duration, 'stutter', { chunkMs: 100, repeats: 2 });
    const third = await render(second.media, 0, second.media.duration, 'reverse');
    expect(third.media.duration).toBeCloseTo(2.2, 1);
    expect(third.media.origin).toMatchObject({ kind: 'effect', effectId: 'reverse', fromMedia: second.media.id });
  });

  it.each([
    ['speed-up', { factor: 4 }, 1, 8],
    ['speed-up', { factor: 2 }, 1, 15],
    ['slow-mo', { factor: 0.5 }, 1, 60],
    ['pitch-up', { semis: 12, mode: 'tape' }, 1, 15],
    ['pitch-down', { semis: -12, mode: 'tape' }, 0.5, 30],
  ])('%s %o stays frame-exact on a short selection', async (id, params, length, frames) => {
    const { media } = await render(clip, 1, 1 + length, id, params);
    expect(Math.round(media.duration * 30)).toBe(frames);
  });

  it('survives a selection only a few frames long', async () => {
    for (const id of ['sus', 'stutter', 'reverse', 'stretch', 'loop', 'staredown', 'echo']) {
      const { media } = await render(clip, 1, 1 + 3 / 30, id);
      expect(media.duration).toBeGreaterThan(0.05);
    }
  });

  it('WOBBLE changes the sound, and does so reliably', async () => {
    const pcm = async (path: string) => {
      const { stdout } = await exec(
        ffmpegPath,
        ['-v', 'error', '-i', path, '-t', '1', '-ac', '1', '-ar', '8000', '-f', 's16le', '-'],
        { encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 },
      );
      return new Int16Array(stdout.buffer, stdout.byteOffset, Math.floor(stdout.length / 2));
    };

    // It used to fail about 40% of the time, so a few passes in a row would have caught it.
    for (let attempt = 0; attempt < 12; attempt++) await render(clip, 0, 1, 'wobble');

    const original = await pcm(clip.path);
    const wobbled = await pcm((await render(clip, 0, 1, 'wobble')).media.path);
    const length = Math.min(original.length, wobbled.length);
    let difference = 0;
    let level = 0;
    for (let index = 0; index < length; index++) {
      difference += Math.abs(original[index] - wobbled[index]);
      level += Math.abs(original[index]);
    }
    expect(difference / level).toBeGreaterThan(0.2);
  });

  it('gives tiny clips a thumbnail and a waveform', async () => {
    const { media } = await render(clip, 1, 1 + 3 / 30, 'invert');
    expect(media.duration).toBeLessThan(0.5);
    expect((await stat(media.thumbsPath!)).size).toBeGreaterThan(0);
    expect((await stat(media.peaksPath!)).size).toBeGreaterThan(0);
  });
});

describe('CHAOS', () => {
  it.each([1, 2, 3, 4, 5, 6])('renders roll %i into one file and names what it picked', async (seed) => {
    let state = seed * 104729;
    const random = () => {
      state = (state * 16807) % 2147483647;
      return state / 2147483647;
    };
    const out = join(dir, `chaos-${seed}`);
    await mkdir(out);
    const request = { pieces: [{ source: clip, in: 0, out: 1 }], effectId: 'chaos', settings };
    const { media, summary } = await renderEffect(`chaos-${seed}`, out, request, { ...options, random }, ctx);

    expect(summary.split(' → ').length).toBeGreaterThanOrEqual(2);
    expect(media.origin).toMatchObject({ kind: 'effect', effectId: 'chaos' });
    const { video, audio } = await streamDurations(media.path);
    expect(Math.abs(video - audio)).toBeLessThan(0.1);
  });
});

describe('the bundled ffmpeg', () => {
  it('reports its filters, and has what the spec leans on', async () => {
    const filters = await listFilters();
    for (const name of ['rubberband', 'reverse', 'areverse', 'loop', 'aloop']) {
      expect(filters.has(name), name).toBe(true);
    }
    expect(getEffect('sus')).toBeDefined();
  });

  it('can run every effect, so none are hidden here', async () => {
    const filters = await listFilters();
    expect(availableEffects(filters).map((effect) => effect.id)).toEqual(effects.map((effect) => effect.id));
    expect(effects.filter((effect) => effect.requires).length).toBeGreaterThan(10);
  });
});
