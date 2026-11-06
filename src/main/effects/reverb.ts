import type { EffectParams } from '../../shared/effects';
import type { Effect } from './types';
import { num, number } from './util';

// Primes keep the taps from lining up, which is what makes this a hall and not a slapback.
const TAPS_MS = [61, 97, 139, 191, 263, 347];
const TAP_DECAYS = [0.5, 0.42, 0.35, 0.28, 0.2, 0.12];

const tailSeconds = (params: EffectParams) => number(params, 'size');

export const reverb: Effect = {
  id: 'reverb',
  label: 'REVERB',
  category: 'audio',
  requires: ['aecho', 'apad', 'tpad'],
  description: 'Big empty hall.',
  params: [
    { key: 'size', label: 'Hall size', type: 'number', min: 0.5, max: 3, step: 0.1, default: 1.5 },
    { key: 'mix', label: 'Wetness', type: 'number', min: 0.2, max: 1, step: 0.05, default: 0.8 },
  ],
  buildFilter: (params) => {
    const size = number(params, 'size');
    const mix = number(params, 'mix');
    const delays = TAPS_MS.map((delay) => num(delay * size)).join('|');
    const decays = TAP_DECAYS.map((decay) => num(decay * mix)).join('|');
    const tail = num(tailSeconds(params));
    return [
      `[0:v]tpad=stop_mode=clone:stop_duration=${tail}[vout]`,
      `[0:a]apad=pad_dur=${tail},aecho=0.8:0.88:${delays}:${decays}[aout]`,
    ].join(';');
  },
  expectedDuration: (params, duration) => duration + tailSeconds(params),
};
