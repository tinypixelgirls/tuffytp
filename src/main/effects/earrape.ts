import type { Effect } from './types';
import { num, number, VIDEO_PASSTHROUGH } from './util';

export const earRape: Effect = {
  id: 'earrape',
  label: '⚠ EAR RAPE',
  category: 'audio',
  requires: ['asoftclip', 'alimiter'],
  description: 'Massively loud, clipped, and bass-boosted. A final limiter caps the peak level.',
  params: [{ key: 'intensity', label: 'Intensity', type: 'number', min: 1, max: 10, step: 0.5, default: 5 }],
  buildFilter: (params) => {
    const intensity = number(params, 'intensity');
    const chain = [
      `bass=g=${num(intensity * 3)}`,
      `treble=g=${num(intensity * 1.2)}`,
      `volume=${num(intensity * 4)}dB`,
      'asoftclip=type=hard',
      'volume=-3dB',
      'alimiter=limit=0.7:level=false',
    ].join(',');
    return `${VIDEO_PASSTHROUGH};[0:a]${chain}[aout]`;
  },
};
