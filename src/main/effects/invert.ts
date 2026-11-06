import type { Effect } from './types';
import { AUDIO_PASSTHROUGH } from './util';

export const invert: Effect = {
  id: 'invert',
  label: 'INVERT',
  category: 'video',
  description: 'Negative colors.',
  params: [],
  buildFilter: () => `[0:v]negate[vout];${AUDIO_PASSTHROUGH}`,
};
