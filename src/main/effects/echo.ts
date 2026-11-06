import type { EffectParams } from '../../shared/effects';
import type { Effect } from './types';
import { num, number } from './util';

const tailSeconds = (params: EffectParams) => (number(params, 'delayMs') * number(params, 'taps')) / 1000;

export const echo: Effect = {
  id: 'echo',
  label: 'ECHO',
  category: 'audio',
  requires: ['aecho', 'apad', 'tpad'],
  description: 'Dramatic trailing echo. The picture holds until the tail dies away.',
  params: [
    { key: 'delayMs', label: 'Delay (ms)', type: 'int', min: 50, max: 1000, step: 10, default: 400 },
    { key: 'decay', label: 'Decay', type: 'number', min: 0.1, max: 0.9, step: 0.05, default: 0.6 },
    { key: 'taps', label: 'Taps', type: 'int', min: 1, max: 8, step: 1, default: 3 },
  ],
  buildFilter: (params) => {
    const delays = Array.from({ length: number(params, 'taps') }, (_, index) => ({
      delay: number(params, 'delayMs') * (index + 1),
      decay: number(params, 'decay') ** (index + 1),
    }));
    const delayList = delays.map(({ delay }) => num(delay)).join('|');
    const decayList = delays.map(({ decay }) => num(decay)).join('|');
    const tail = num(tailSeconds(params));
    return [
      `[0:v]tpad=stop_mode=clone:stop_duration=${tail}[vout]`,
      `[0:a]apad=pad_dur=${tail},aecho=0.8:0.9:${delayList}:${decayList}[aout]`,
    ].join(';');
  },
  expectedDuration: (params, duration) => duration + tailSeconds(params),
};
