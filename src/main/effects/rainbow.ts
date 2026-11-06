import type { Effect } from './types';
import { AUDIO_PASSTHROUGH, num, number } from './util';

export const rainbow: Effect = {
  id: 'rainbow',
  label: 'RAINBOW',
  category: 'video',
  requires: ['hue'],
  description: 'Cycles the hue over time.',
  params: [{ key: 'speed', label: 'Cycles per second', type: 'number', min: 0.1, max: 5, step: 0.1, default: 1 }],
  buildFilter: (params) => `[0:v]hue=h=t*360*${num(number(params, 'speed'))}:s=1.5[vout];${AUDIO_PASSTHROUGH}`,
};
