import type { Effect } from './types';
import { number, text } from './util';

const labels = (prefix: string, count: number) =>
  Array.from({ length: count }, (_, index) => `[${prefix}${index}]`).join('');

export const sus: Effect = {
  id: 'sus',
  label: 'SUS',
  category: 'audio+video',
  requires: ['reverse', 'areverse'],
  description: 'Forward then reversed: "FRI" becomes "FRIIRF".',
  buffersSelection: true,
  params: [
    { key: 'mode', label: 'Mode', type: 'select', default: 'forward-reverse', options: ['forward-reverse', 'reverse-forward'] },
    { key: 'bounces', label: 'Bounces', type: 'int', min: 1, max: 8, step: 1, default: 1, chaosMax: 3 },
  ],
  buildFilter: (params) => {
    const bounces = number(params, 'bounces');
    const forwardFirst = text(params, 'mode') === 'forward-reverse';
    const parts = Array.from({ length: bounces }, (_, index) => {
      const forward = `[f${index}][af${index}]`;
      const backward = `[r${index}][ar${index}]`;
      return forwardFirst ? forward + backward : backward + forward;
    }).join('');

    return [
      '[0:v]split=2[vf][vb]',
      '[vb]reverse[vr]',
      `[vf]split=${bounces}${labels('f', bounces)}`,
      `[vr]split=${bounces}${labels('r', bounces)}`,
      '[0:a]asplit=2[af][ab]',
      '[ab]areverse[ar]',
      `[af]asplit=${bounces}${labels('af', bounces)}`,
      `[ar]asplit=${bounces}${labels('ar', bounces)}`,
      `${parts}concat=n=${bounces * 2}:v=1:a=1[vout][aout]`,
    ].join(';');
  },
  expectedDuration: (params, duration) => duration * 2 * number(params, 'bounces'),
};
