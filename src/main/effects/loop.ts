import type { Effect } from './types';
import { number } from './util';

export const loop: Effect = {
  id: 'loop',
  label: 'LOOP',
  category: 'audio+video',
  requires: ['loop', 'aloop'],
  description: 'Repeats the whole selection.',
  params: [{ key: 'count', label: 'Times', type: 'int', min: 2, max: 20, step: 1, default: 3, chaosMax: 5 }],
  buildFilter: (params, { duration, fps, sampleRate }) => {
    const extra = number(params, 'count') - 1;
    // Sizes run a little long on purpose: both filters loop whatever they hold when input ends.
    const frames = Math.ceil(duration * fps) + 1;
    const samples = Math.ceil(duration * sampleRate) + sampleRate;
    return [
      `[0:v]loop=loop=${extra}:size=${frames}:start=0,setpts=N/FRAME_RATE/TB[vout]`,
      `[0:a]aloop=loop=${extra}:size=${samples}:start=0,asetpts=N/SR/TB[aout]`,
    ].join(';');
  },
  expectedDuration: (params, duration) => duration * number(params, 'count'),
};
