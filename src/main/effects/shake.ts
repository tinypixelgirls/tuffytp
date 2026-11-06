import type { Effect } from './types';
import { AUDIO_PASSTHROUGH, fitToProject, num, number } from './util';

export const shake: Effect = {
  id: 'shake',
  label: 'SHAKE',
  category: 'video',
  description: 'Screen shake.',
  params: [{ key: 'intensity', label: 'Intensity (px)', type: 'number', min: 2, max: 60, step: 1, default: 24 }],
  buildFilter: (params, context) => {
    const amount = num(number(params, 'intensity'));
    const crop = `crop=iw*0.9:ih*0.9:x='(iw-ow)/2+sin(t*70)*${amount}':y='(ih-oh)/2+cos(t*53)*${amount}'`;
    return `[0:v]${crop},${fitToProject(context)}[vout];${AUDIO_PASSTHROUGH}`;
  },
};
