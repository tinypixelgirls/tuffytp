import type { EffectParam, EffectParams, ParamValue } from '../../shared/effects';
import type { Effect } from './types';
import { AUDIO_PASSTHROUGH, VIDEO_PASSTHROUGH } from './util';

// Silence or a blank card would make a roll dull rather than funny.
const SKIPPED = new Set(['mute', 'titlecard', 'bsod', 'difficulties', 'spectrum', 'karaoke']);

const CHAOS_WORDS = ['BRUH', 'WHAT', 'OH NO', 'SPEECHLESS', 'WHY', 'BOTTOM TEXT', 'CRINGE', 'BASED', 'HELP', 'GOTTEM', 'YIKES'];

function rollParam(param: EffectParam, random: () => number): ParamValue {
  if (param.type === 'bool') return param.key === 'smooth' ? false : random() < 0.5;
  if (param.type === 'text') return CHAOS_WORDS[Math.floor(random() * CHAOS_WORDS.length)];
  if (param.type === 'select') {
    const options = param.options ?? [];
    return options[Math.floor(random() * options.length)];
  }
  const min = param.min ?? 0;
  const max = param.chaosMax ?? param.max ?? 1;
  const value = min + random() * (max - min);
  if (param.type === 'int') return Math.round(value);
  const step = param.step ?? 0.1;
  return Number((Math.round(value / step) * step).toFixed(4));
}

function rollParams(effect: Effect, random: () => number): EffectParams {
  return Object.fromEntries(effect.params.map((param) => [param.key, rollParam(param, random)]));
}

function chaosEffect(id: string, label: string, description: string, fewest: number, most: number): Effect {
  return {
    id,
    label,
    category: 'combo',
    description,
    params: [],
    randomized: true,
    buildFilter: () => `${VIDEO_PASSTHROUGH};${AUDIO_PASSTHROUGH}`,
    expand: (pool, random) => {
      const choices = pool.filter((effect) => !effect.expand && !SKIPPED.has(effect.id));
      const count = fewest + Math.floor(random() * (most - fewest + 1));
      return Array.from({ length: count }, () => {
        const effect = choices.splice(Math.floor(random() * choices.length), 1)[0];
        return { effectId: effect.id, params: rollParams(effect, random) };
      });
    },
  };
}

export const roulette = chaosEffect('roulette', 'ROULETTE', 'One random effect with random settings.', 1, 1);
export const chaos = chaosEffect('chaos', 'CHAOS', 'Rolls 2 to 4 random effects with random settings. Anything could happen.', 2, 4);
export const ultraChaos = chaosEffect('ultrachaos', '☢ ULTRA CHAOS', 'Rolls 5 to 8 random effects. You were warned.', 5, 8);
