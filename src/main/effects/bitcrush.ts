import type { Effect } from './types';
import { number, VIDEO_PASSTHROUGH } from './util';

export const bitcrush: Effect = {
  id: 'bitcrush',
  label: 'BITCRUSH',
  category: 'audio',
  requires: ['acrusher'],
  description: 'Crunchy low-fi sound.',
  params: [
    { key: 'bits', label: 'Bits', type: 'int', min: 2, max: 12, step: 1, default: 5 },
    { key: 'downsample', label: 'Downsample', type: 'int', min: 1, max: 32, step: 1, default: 8 },
  ],
  buildFilter: (params) => {
    const crusher = `acrusher=bits=${number(params, 'bits')}:samples=${number(params, 'downsample')}:mode=lin:mix=1`;
    return `${VIDEO_PASSTHROUGH};[0:a]${crusher}[aout]`;
  },
};
