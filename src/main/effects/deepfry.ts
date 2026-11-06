import type { Effect } from './types';
import { AUDIO_PASSTHROUGH, num, number } from './util';

export const deepFry: Effect = {
  id: 'deepfry',
  label: 'DEEP FRY',
  category: 'video',
  requires: ['eq', 'unsharp', 'noise'],
  description: 'Oversaturated, oversharpened, noisy, and crushed.',
  params: [{ key: 'intensity', label: 'Intensity', type: 'number', min: 1, max: 10, step: 0.5, default: 5 }],
  buildFilter: (params, context) => {
    const intensity = number(params, 'intensity');
    const shrink = num(1 + intensity * 0.6);
    return [
      `[0:v]scale=trunc(iw/${shrink}/2)*2:trunc(ih/${shrink}/2)*2`,
      `scale=${context.width}:${context.height}:flags=neighbor`,
      `eq=saturation=${num(1 + intensity * 0.4)}:contrast=${num(1 + intensity * 0.16)}:brightness=0.05`,
      'unsharp=7:7:2.5',
      `noise=alls=${num(intensity * 5)}:allf=t`,
      'setsar=1[vout]',
    ].join(',') + `;${AUDIO_PASSTHROUGH}`;
  },
};
