import type { Effect } from './types';
import { num, number } from './util';

const MAX_ZOOM_GAIN = 0.6;

export const stareDown: Effect = {
  id: 'staredown',
  label: 'STAREDOWN',
  category: 'video',
  requires: ['tpad', 'apad'],
  description: 'Freezes the last frame, slowly zooms in, and drops to silence.',
  params: [{ key: 'holdSec', label: 'Hold (s)', type: 'number', min: 1, max: 10, step: 0.5, default: 3, chaosMax: 4 }],
  buildFilter: (params, { duration, width, height }) => {
    const hold = num(number(params, 'holdSec'));
    const zoom = `(1+${MAX_ZOOM_GAIN}*clip((t-${num(duration)})/${hold},0,1))`;
    // Not zoompan: it ignores the incoming timing and emits frames by the thousand here.
    const grow = `scale=w='trunc(${width}*${zoom}/2)*2':h='trunc(${height}*${zoom}/2)*2':eval=frame`;
    return [
      `[0:v]tpad=stop_mode=clone:stop_duration=${hold},${grow},crop=${width}:${height},setsar=1[vout]`,
      `[0:a]apad=pad_dur=${hold}[aout]`,
    ].join(';');
  },
  expectedDuration: (params, duration) => duration + number(params, 'holdSec'),
};
