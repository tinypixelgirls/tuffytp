import type { FilterContext } from './types';
import { num } from './util';

export interface Slice {
  /** First frame and one past the last, in the selection. */
  from: number;
  to: number;
  reversed?: boolean;
  /** Tape-style speed: pitch moves with it. */
  rate?: number;
}

export const frameCount = ({ duration, fps }: FilterContext) => Math.max(1, Math.round(duration * fps));

/** Plays pieces of the selection in any order, each cut on whole frames with its sound matched. */
export function sliceGraph(slices: Slice[], context: FilterContext): string {
  const { fps, sampleRate } = context;
  const samplesPerFrame = sampleRate / fps;
  const count = slices.length;
  const labels = (prefix: string) => slices.map((_, index) => `[${prefix}${index}]`).join('');

  const chains = slices.flatMap(({ from, to, reversed, rate = 1 }, index) => {
    const video = [`trim=start_frame=${from}:end_frame=${to}`, 'setpts=PTS-STARTPTS'];
    const audio = [
      `atrim=start_sample=${Math.round(from * samplesPerFrame)}:end_sample=${Math.round(to * samplesPerFrame)}`,
      'asetpts=N/SR/TB',
    ];
    if (reversed) {
      video.push('reverse');
      audio.push('areverse');
    }
    if (rate !== 1) {
      video.push(`setpts=PTS/${num(rate)}`);
      audio.push(`asetrate=${num(sampleRate * rate)}`, `aresample=${sampleRate}`);
    }
    return [`[pv${index}]${video.join(',')}[v${index}]`, `[pa${index}]${audio.join(',')}[a${index}]`];
  });

  const pairs = slices.map((_, index) => `[v${index}][a${index}]`).join('');
  return [
    `[0:v]split=${count}${labels('pv')}`,
    `[0:a]asplit=${count}${labels('pa')}`,
    ...chains,
    `${pairs}concat=n=${count}:v=1:a=1[vout][aout]`,
  ].join(';');
}
