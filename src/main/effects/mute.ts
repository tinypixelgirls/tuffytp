import type { Effect } from './types';
import { VIDEO_PASSTHROUGH } from './util';

export const mute: Effect = {
  id: 'mute',
  label: 'MUTE',
  category: 'audio',
  description: 'Silence.',
  params: [],
  buildFilter: () => `${VIDEO_PASSTHROUGH};[0:a]volume=0[aout]`,
};
