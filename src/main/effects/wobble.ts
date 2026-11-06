import type { Effect } from './types';
import { num, number, VIDEO_PASSTHROUGH } from './util';

const PREROLL_SECONDS = 0.02;

export const wobble: Effect = {
  id: 'wobble',
  label: 'WOBBLE',
  category: 'audio',
  requires: ['vibrato', 'adelay', 'atrim'],
  description: 'Seasick vibrato.',
  params: [
    { key: 'rate', label: 'Rate (Hz)', type: 'number', min: 0.5, max: 20, step: 0.5, default: 6 },
    { key: 'depth', label: 'Depth', type: 'number', min: 0.1, max: 1, step: 0.05, default: 0.8 },
  ],
  // vibrato's first 5 ms read from a history buffer it never cleared, so they sometimes come out
  // as NaN, and the AAC encoder refuses to continue. It gets silence to chew through first, and
  // that stretch is trimmed off again before anything reaches the encoder.
  buildFilter: (params) => {
    const vibrato = `vibrato=f=${num(number(params, 'rate'))}:d=${num(number(params, 'depth'))}`;
    const preroll = `adelay=delays=${PREROLL_SECONDS * 1000}:all=1`;
    const trim = `atrim=start=${PREROLL_SECONDS},asetpts=N/SR/TB`;
    return `${VIDEO_PASSTHROUGH};[0:a]${preroll},${vibrato},${trim}[aout]`;
  },
};
