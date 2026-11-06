import type { Effect } from './types';
import { num, number, steadyStretch } from './util';

export const stretch: Effect = {
  id: 'stretch',
  label: 'STRETCH',
  category: 'audio+video',
  description: 'Holds a syllable without changing its pitch: "FRIIIIIIICK".',
  params: [
    { key: 'amount', label: 'Amount', type: 'number', min: 2, max: 8, step: 0.5, default: 3, chaosMax: 4 },
    { key: 'smooth', label: 'Smooth motion (slow)', type: 'bool', default: false },
  ],
  buildFilter: (params, context) => {
    const amount = number(params, 'amount');
    const smooth = params.smooth ? `,minterpolate=fps=${context.fps}:mi_mode=mci` : '';
    return `[0:v]setpts=PTS*${num(amount)}${smooth}[vout];[0:a]${steadyStretch(amount, context)}[aout]`;
  },
  expectedDuration: (params, duration) => duration * number(params, 'amount'),
};
