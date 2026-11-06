import type { Effect } from './types';
import { semitoneRatio, steadyPitch, text, VIDEO_PASSTHROUGH } from './util';

const CHORDS: Record<string, [number, number]> = {
  major: [4, 7],
  minor: [3, 7],
  power: [7, 12],
  octaves: [-12, 12],
};

export const choir: Effect = {
  id: 'choir',
  label: 'CHOIR',
  category: 'audio',
  requires: ['amix'],
  description: 'Stacks pitched copies into a chord.',
  params: [{ key: 'chord', label: 'Chord', type: 'select', default: 'major', options: Object.keys(CHORDS) }],
  buildFilter: (params, context) => {
    const [second, third] = CHORDS[text(params, 'chord')];
    return [
      VIDEO_PASSTHROUGH,
      '[0:a]asplit=3[root][a][b]',
      `[a]${steadyPitch(semitoneRatio(second), context)}[second]`,
      `[b]${steadyPitch(semitoneRatio(third), context)}[third]`,
      '[root][second][third]amix=inputs=3:normalize=0,volume=0.6[aout]',
    ].join(';');
  },
};
