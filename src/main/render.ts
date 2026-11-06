import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { MEDIA_FILE } from '../shared/media';
import type { EffectRenderRequest, EffectRenderResult, MediaId, ProjectSettings } from '../shared/types';
import { getEffect, resolveParams } from './effects';
import type { Effect, EffectStep, FilterContext } from './effects/types';
import { runExport } from './export';
import { runFfmpeg, type JobContext } from './ffmpeg';
import { finalizeMedia, houseEncodeArgs, RENDER_SHARE } from './normalize';
import { probe } from './probe';

export interface RenderOptions {
  pool: Effect[];
  filters: Set<string>;
  random?: () => number;
}

/**
 * No effect makes anything near this long. A filter that hands out broken timestamps can otherwise
 * make ffmpeg render forever, and CHAOS is free to roll combinations nobody has tried.
 */
const lengthCap = (expected: number) => expected * 6 + 30;

export function buildRenderArgs(
  input: string[],
  filter: string,
  settings: ProjectSettings,
  outPath: string,
  expected: number,
): string[] {
  return [
    ...input,
    // Retiming inside the graph, not with -r alone, which holds the last frame for its old length
    // and leaves a sped-up clip a couple of frames too long.
    //
    // A filter can leave the audio a hair short. Padding it and stopping with the picture
    // means every render's audio and video match, so concat never drifts. The pad has to be
    // finite: -shortest doesn't stop an endless apad inside a -filter_complex, and ffmpeg hangs.
    '-filter_complex', `${filter};[vout]fps=${settings.fps}[vfinal];[aout]apad=pad_dur=2[apadded]`,
    '-map', '[vfinal]',
    '-map', '[apadded]',
    '-shortest',
    '-t', String(lengthCap(expected)),
    ...houseEncodeArgs(settings),
    outPath,
  ];
}

/** The selection as ffmpeg input. A selection across clips gets joined into one file first. */
async function prepareInput(
  dir: string,
  request: EffectRenderRequest,
  ctx: JobContext,
): Promise<{ input: string[]; duration: number; temporary: string[] }> {
  const { pieces, settings } = request;
  if (pieces.length === 1) {
    const [{ source, in: start, out: end }] = pieces;
    // -ss before -i with a re-encode is still frame-accurate, and it spares a generation of loss.
    return {
      input: ['-ss', String(start), '-t', String(end - start), '-i', source.path],
      duration: end - start,
      temporary: [],
    };
  }

  const outputPath = join(dir, 'joined.mp4');
  await runExport(
    join(dir, 'join-work'),
    {
      segments: pieces.map(({ source, in: start, out: end }) => ({
        path: source.path,
        in: start,
        out: end,
        mediaDuration: source.duration,
      })),
      settings,
      resolution: 'keep',
      fps: settings.fps,
      quality: 'house',
      outputPath,
    },
    { signal: ctx.signal, report: () => {} },
  );
  return { input: ['-i', outputPath], duration: (await probe(outputPath)).duration, temporary: [outputPath] };
}

/**
 * Renders the selection through an effect into a new cached file. CHAOS is several passes in
 * a row, because each step's filter needs the real length of what the step before it made.
 */
export async function renderEffect(
  id: MediaId,
  dir: string,
  request: EffectRenderRequest,
  options: RenderOptions,
  ctx: JobContext,
): Promise<EffectRenderResult> {
  const { pieces, settings } = request;
  const effect = getEffect(request.effectId);
  const random = options.random ?? Math.random;
  const steps: EffectStep[] = effect.expand
    ? effect.expand(options.pool, random)
    : [{ effectId: effect.id, params: resolveParams(effect, request.params) }];

  ctx.report(null, effect.label);
  const prepared = await prepareInput(dir, request, ctx);
  let { input, duration } = prepared;
  const temporary = [...prepared.temporary];

  for (const [index, step] of steps.entries()) {
    const stepEffect = getEffect(step.effectId);
    const context: FilterContext = {
      duration,
      fps: settings.fps,
      width: settings.width,
      height: settings.height,
      sampleRate: settings.sampleRate,
      hasRubberband: options.filters.has('rubberband'),
    };
    const last = index === steps.length - 1;
    const outPath = join(dir, last ? MEDIA_FILE : `pass-${index}.mp4`);
    if (!last) temporary.push(outPath);

    ctx.report(null, `${stepEffect.label} (${index + 1}/${steps.length})`);

    const prepass = stepEffect.prepass?.(step.params, context);
    if (prepass) {
      const prepassPath = join(dir, `prepass-${index}.${prepass.extension}`);
      temporary.push(prepassPath);
      await runFfmpeg({ args: [...input, ...prepass.args, prepassPath], signal: ctx.signal });
      input = [...(prepass.inputArgs ?? []), '-i', prepassPath];
    }

    const expected = stepEffect.expectedDuration?.(step.params, duration) ?? duration;
    await runFfmpeg({
      args: buildRenderArgs(input, stepEffect.buildFilter(step.params, context), settings, outPath, expected),
      duration: expected,
      onProgress: (fraction) => ctx.report(((index + fraction) / steps.length) * RENDER_SHARE),
      signal: ctx.signal,
    });

    input = ['-i', outPath];
    duration = (await probe(outPath)).duration;
  }

  const summary = steps
    .map(({ effectId, params }) => {
      const stepEffect = getEffect(effectId);
      return stepEffect.describe?.(params) ?? stepEffect.label;
    })
    .join(' → ');

  const [first] = pieces;
  const origin = {
    kind: 'effect' as const,
    effectId: effect.id,
    params: effect.expand ? { summary } : (steps[0].params as Record<string, unknown>),
    fromMedia: first.source.id,
    in: first.in,
    out: pieces[pieces.length - 1].out,
  };
  const media = await finalizeMedia(id, dir, origin, settings, ctx);
  await Promise.all(temporary.map((path) => rm(path, { force: true })));
  return { media, summary };
}
