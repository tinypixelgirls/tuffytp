import type { Effect } from './types';
import { AUDIO_PASSTHROUGH, fitToProject, text } from './util';

const LAYOUTS: Record<string, { crop: string; flip: string; stack: string; keptFirst: boolean }> = {
  left: { crop: 'iw/2:ih:0:0', flip: 'hflip', stack: 'hstack', keptFirst: true },
  right: { crop: 'iw/2:ih:iw/2:0', flip: 'hflip', stack: 'hstack', keptFirst: false },
  top: { crop: 'iw:ih/2:0:0', flip: 'vflip', stack: 'vstack', keptFirst: true },
  bottom: { crop: 'iw:ih/2:0:ih/2', flip: 'vflip', stack: 'vstack', keptFirst: false },
};

export const mirror: Effect = {
  id: 'mirror',
  label: 'MIRROR',
  category: 'video',
  description: 'Reflects one half of the picture onto the other.',
  params: [{ key: 'side', label: 'Keep side', type: 'select', default: 'left', options: Object.keys(LAYOUTS) }],
  buildFilter: (params, context) => {
    const { crop, flip, stack, keptFirst } = LAYOUTS[text(params, 'side')];
    const order = keptFirst ? '[kept][flipped]' : '[flipped][kept]';
    return [
      `[0:v]crop=${crop},split[kept][copy]`,
      `[copy]${flip}[flipped]`,
      `${order}${stack},${fitToProject(context)}[vout]`,
      AUDIO_PASSTHROUGH,
    ].join(';');
  },
};
