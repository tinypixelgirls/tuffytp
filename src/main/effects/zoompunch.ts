import type { Effect } from './types';
import { AUDIO_PASSTHROUGH, fitToProject, num, number } from './util';

export const zoomPunch: Effect = {
  id: 'zoompunch',
  label: 'ZOOM PUNCH',
  category: 'video',
  description: 'Sudden zoom-in.',
  params: [
    { key: 'zoom', label: 'Zoom', type: 'number', min: 1.2, max: 4, step: 0.1, default: 2 },
    { key: 'centerX', label: 'Center X', type: 'number', min: 0, max: 1, step: 0.05, default: 0.5 },
    { key: 'centerY', label: 'Center Y', type: 'number', min: 0, max: 1, step: 0.05, default: 0.5 },
  ],
  buildFilter: (params, context) => {
    const zoom = num(number(params, 'zoom'));
    const x = num(number(params, 'centerX'));
    const y = num(number(params, 'centerY'));
    const crop = `crop=iw/${zoom}:ih/${zoom}:(iw-iw/${zoom})*${x}:(ih-ih/${zoom})*${y}`;
    return `[0:v]${crop},${fitToProject(context)}[vout];${AUDIO_PASSTHROUGH}`;
  },
};
