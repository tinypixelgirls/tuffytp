import type { Effect } from './types';
import { num, number, semitoneRatio, steadyPitch } from './util';

export const gMajor: Effect = {
  id: 'gmajor',
  label: 'G-MAJOR',
  category: 'combo',
  requires: ['hue'],
  description: 'Hue shift plus a pitch shift, the classic G-Major look.',
  params: [
    { key: 'hue', label: 'Hue shift', type: 'int', min: 0, max: 360, step: 5, default: 120 },
    { key: 'semis', label: 'Semitones', type: 'int', min: -12, max: 12, step: 1, default: 5 },
  ],
  buildFilter: (params, context) => {
    const ratio = semitoneRatio(number(params, 'semis'));
    return `[0:v]hue=h=${num(number(params, 'hue'))}[vout];[0:a]${steadyPitch(ratio, context)}[aout]`;
  },
};
