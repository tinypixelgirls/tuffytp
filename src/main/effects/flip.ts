import type { Effect } from './types';
import { AUDIO_PASSTHROUGH, text } from './util';

const FILTERS: Record<string, string> = {
  horizontal: 'hflip',
  vertical: 'vflip',
  both: 'hflip,vflip',
};

export const flip: Effect = {
  id: 'flip',
  label: 'FLIP',
  category: 'video',
  description: 'Flips the picture.',
  params: [{ key: 'axis', label: 'Axis', type: 'select', default: 'horizontal', options: Object.keys(FILTERS) }],
  buildFilter: (params) => `[0:v]${FILTERS[text(params, 'axis')]}[vout];${AUDIO_PASSTHROUGH}`,
};
