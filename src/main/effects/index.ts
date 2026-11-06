import type { EffectInfo, EffectParams, ParamValue } from '../../shared/effects';
import { bitcrush } from './bitcrush';
import { chaos, roulette, ultraChaos } from './chaos';
import { choir } from './choir';
import { deepFry } from './deepfry';
import { earRape } from './earrape';
import { echo } from './echo';
import { flip } from './flip';
import { gMajor } from './gmajor';
import { invert } from './invert';
import { loop } from './loop';
import { mirror } from './mirror';
import { mute } from './mute';
import { audioPack, vibePack } from './pack-audio';
import { glitchPack } from './pack-glitch';
import { memePack } from './pack-meme';
import { videoPack } from './pack-video';
import { pitchDown, pitchUp } from './pitch';
import { rainbow } from './rainbow';
import { reverb } from './reverb';
import { reverse } from './reverse';
import { shake } from './shake';
import { slowMo, speedUp } from './speed';
import { stareDown } from './staredown';
import { stretch } from './stretch';
import { stutter } from './stutter';
import { sus } from './sus';
import type { Effect } from './types';
import { wobble } from './wobble';
import { zoomPunch } from './zoompunch';

export const effects: Effect[] = [
  sus,
  stutter,
  reverse,
  pitchUp,
  pitchDown,
  speedUp,
  slowMo,
  stretch,
  loop,
  ...vibePack,
  earRape,
  echo,
  reverb,
  choir,
  bitcrush,
  wobble,
  mute,
  ...audioPack,
  invert,
  rainbow,
  mirror,
  flip,
  deepFry,
  zoomPunch,
  shake,
  stareDown,
  ...videoPack,
  ...glitchPack,
  ...memePack,
  gMajor,
  roulette,
  chaos,
  ultraChaos,
];

const MAX_TEXT_LENGTH = 120;

export function getEffect(id: string): Effect {
  const effect = effects.find((candidate) => candidate.id === id);
  if (!effect) throw new Error(`Unknown effect: ${id}`);
  return effect;
}

/** Effects whose ffmpeg filters are all present in this build. */
export function availableEffects(filters: Set<string>): Effect[] {
  return effects.filter((effect) => (effect.requires ?? []).every((filter) => filters.has(filter)));
}

/** What the renderer gets: everything except the functions, which can't cross IPC. */
export function toEffectInfo(effect: Effect): EffectInfo {
  const { id, label, category, description, params, buffersSelection, randomized } = effect;
  return { id, label, category, description, params, buffersSelection, randomized };
}

/** Fills in defaults and keeps every value in range, since these end up in a filter string. */
export function resolveParams(effect: Effect, given: EffectParams = {}): EffectParams {
  const resolved = effect.params.map((param): [string, ParamValue] => {
    const value = given[param.key] ?? param.default;
    switch (param.type) {
      case 'bool':
        return [param.key, Boolean(value)];
      case 'select':
        return [param.key, param.options?.includes(String(value)) ? String(value) : param.default];
      case 'text':
        // Filters escape this when they use it; it just needs to be one line of sensible length.
        return [param.key, String(value).replace(/[\r\n]+/g, ' ').slice(0, MAX_TEXT_LENGTH)];
      default: {
        const parsed = Number(value);
        const safe = Number.isFinite(parsed) ? parsed : (param.default as number);
        const bounded = Math.min(Math.max(safe, param.min ?? safe), param.max ?? safe);
        return [param.key, param.type === 'int' ? Math.round(bounded) : bounded];
      }
    }
  });
  return Object.fromEntries(resolved);
}
