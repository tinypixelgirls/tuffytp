import type { EffectParams } from '../../shared/effects';
import type { Effect } from './types';
import { atempoChain, num, number } from './util';

function buildFilter(params: EffectParams): string {
  const factor = number(params, 'factor');
  return `[0:v]setpts=PTS/${num(factor)}[vout];[0:a]${atempoChain(factor)}[aout]`;
}

const expectedDuration = (params: EffectParams, duration: number) => duration / number(params, 'factor');

export const speedUp: Effect = {
  id: 'speed-up',
  label: 'SPEED UP',
  category: 'audio+video',
  description: 'Faster, with the pitch held steady.',
  params: [{ key: 'factor', label: 'Speed', type: 'number', min: 0.25, max: 4, step: 0.05, default: 2 }],
  buildFilter,
  expectedDuration,
};

export const slowMo: Effect = {
  id: 'slow-mo',
  label: 'SLOW MO',
  category: 'audio+video',
  description: 'Slower, with the pitch held steady.',
  params: [{ key: 'factor', label: 'Speed', type: 'number', min: 0.25, max: 4, step: 0.05, default: 0.5 }],
  buildFilter,
  expectedDuration,
};
