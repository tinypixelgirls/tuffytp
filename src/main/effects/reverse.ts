import type { Effect } from './types';

export const reverse: Effect = {
  id: 'reverse',
  label: 'REVERSE',
  category: 'audio+video',
  requires: ['reverse', 'areverse'],
  description: 'Plays the selection backwards.',
  buffersSelection: true,
  params: [],
  buildFilter: () => '[0:v]reverse[vout];[0:a]areverse[aout]',
};
