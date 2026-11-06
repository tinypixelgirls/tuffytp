import type { Effect } from './types';
import { number } from './util';

export const stutter: Effect = {
  id: 'stutter',
  label: 'STUTTER',
  category: 'audio+video',
  requires: ['loop', 'aloop'],
  description: 'Repeats the start of the selection: "F-F-F-FRICK".',
  params: [
    { key: 'chunkMs', label: 'Chunk (ms)', type: 'int', min: 30, max: 500, step: 10, default: 100 },
    { key: 'repeats', label: 'Repeats', type: 'int', min: 1, max: 16, step: 1, default: 4, chaosMax: 8 },
  ],
  buildFilter: (params, { fps, sampleRate, duration }) => {
    const repeats = number(params, 'repeats');
    // Whole frames, with audio cut to match, so each repeat stays in sync with its picture.
    const seconds = Math.min(number(params, 'chunkMs') / 1000, duration);
    const frames = Math.max(1, Math.round(seconds * fps));
    const samples = Math.round((frames / fps) * sampleRate);
    return [
      `[0:v]loop=loop=${repeats}:size=${frames}:start=0,setpts=N/FRAME_RATE/TB[vout]`,
      `[0:a]aloop=loop=${repeats}:size=${samples}:start=0,asetpts=N/SR/TB[aout]`,
    ].join(';');
  },
  expectedDuration: (params, duration) =>
    duration + Math.min(number(params, 'chunkMs') / 1000, duration) * number(params, 'repeats'),
};
