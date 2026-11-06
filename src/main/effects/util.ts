import type { EffectParams } from '../../shared/effects';
import type { FilterContext } from './types';

export const VIDEO_PASSTHROUGH = '[0:v]null[vout]';
export const AUDIO_PASSTHROUGH = '[0:a]anull[aout]';

/** Keeps filter strings in plain decimals; ffmpeg won't parse 1e-7 everywhere. */
export const num = (value: number) => String(Number(value.toFixed(6)));

export const number = (params: EffectParams, key: string) => params[key] as number;
export const text = (params: EffectParams, key: string) => params[key] as string;

export const semitoneRatio = (semitones: number) => 2 ** (semitones / 12);

/** atempo only works between 0.5 and 2 at a time, so larger changes are chained. */
export function atempoChain(factor: number): string {
  const stages: string[] = [];
  let remaining = factor;
  while (remaining > 2) {
    stages.push('atempo=2');
    remaining /= 2;
  }
  while (remaining < 0.5) {
    stages.push('atempo=0.5');
    remaining /= 0.5;
  }
  stages.push(`atempo=${num(remaining)}`);
  return stages.join(',');
}

/** Tape-style pitch: speed changes with it, like a record played too fast. */
export function tapePitch(ratio: number, sampleRate: number): string {
  return `asetrate=${num(sampleRate * ratio)},aresample=${sampleRate}`;
}

/** Pitch that holds its length, using rubberband when the build has it. */
export function steadyPitch(ratio: number, context: FilterContext): string {
  if (context.hasRubberband) return `rubberband=pitch=${num(ratio)}`;
  return `${tapePitch(ratio, context.sampleRate)},${atempoChain(1 / ratio)}`;
}

/** Stretches audio without changing its pitch. */
export function steadyStretch(amount: number, context: FilterContext): string {
  if (context.hasRubberband) return `rubberband=tempo=${num(1 / amount)}`;
  return atempoChain(1 / amount);
}

/** A crop and rescale can land on a slightly different size or shape, so everything ends here. */
export const fitToProject = (context: FilterContext) => `scale=${context.width}:${context.height},setsar=1`;

export const videoOnly = (chain: string) => `[0:v]${chain}[vout];${AUDIO_PASSTHROUGH}`;
export const audioOnly = (chain: string) => `${VIDEO_PASSTHROUGH};[0:a]${chain}[aout]`;
export const both = (video: string, audio: string) => `[0:v]${video}[vout];[0:a]${audio}[aout]`;

/** Discards the selection's sound in favor of a chain that makes its own. */
export const replaceAudio = (source: string) => `[0:a]anullsink;${source}[aout]`;
/** Discards the selection's picture in favor of a chain that makes its own. */
export const replaceVideo = (source: string) => `[0:v]nullsink;${source}[vout]`;

/**
 * Text and paths in a filter string go through two parsers: the filter's options, then the
 * filtergraph. Escaping for both means nothing a user types can break out of the value.
 */
export function escapeFilterValue(value: string): string {
  const forOption = value.replace(/[\\':]/g, '\\$&');
  return forOption.replace(/[\\'[\],;]/g, '\\$&');
}

const IMPACT_PATH = 'C:/Windows/Fonts/impact.ttf';

export function fontOption(): string {
  return process.platform === 'win32' ? `fontfile=${escapeFilterValue(IMPACT_PATH)}` : 'font=sans';
}

export interface TextOptions {
  size: number;
  /** ffmpeg expressions, in terms of w, h, text_w and text_h. */
  x?: string;
  y?: string;
  color?: string;
  border?: number;
  borderColor?: string;
  /** When to show it, as a timeline expression. */
  enable?: string;
}

/** Impact, outlined, centered unless told otherwise. Of course. */
export function drawText(text: string, options: TextOptions): string {
  const { size, x = '(w-text_w)/2', y = '(h-text_h)/2', color = 'white', border = 4, borderColor = 'black' } = options;
  const parts = [
    `drawtext=${fontOption()}`,
    `text=${escapeFilterValue(text)}`,
    'expansion=none',
    `fontsize=${Math.round(size)}`,
    `fontcolor=${color}`,
    `borderw=${border}`,
    `bordercolor=${borderColor}`,
    `x='${x}'`,
    `y='${y}'`,
  ];
  if (options.enable) parts.push(`enable='${options.enable}'`);
  return parts.join(':');
}

/** Big as it can be while still fitting the width, at roughly half an em per character. */
export function fittedSize(text: string, width: number, largest: number): number {
  return Math.min(largest, (width * 1.7) / Math.max(1, text.length));
}

/** Holds the last frame for this long, for sounds and titles that outlast the selection. */
export const holdLastFrame = (seconds: number) =>
  seconds > 0 ? `tpad=stop_mode=clone:stop_duration=${num(seconds)}` : 'null';

/** Zooms by an expression in t, by scaling up and cropping back to the project's size. */
export function zoomBy(zoom: string, { width, height }: FilterContext): string {
  const dimension = (size: number) => `trunc(${size}*(${zoom})/2)*2`;
  return `scale=w='${dimension(width)}':h='${dimension(height)}':eval=frame,crop=${width}:${height},setsar=1`;
}

/** vibrato's first 5 ms can be NaN, so it gets silence to chew through that's trimmed off after. */
export function safeVibrato(rate: number, depth: number): string {
  return `adelay=delays=20:all=1,vibrato=f=${num(rate)}:d=${num(depth)},atrim=start=0.02,asetpts=N/SR/TB`;
}
