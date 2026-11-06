import type { EffectParams } from '../../shared/effects';
import type { Effect, FilterContext } from './types';
import { num, number, semitoneRatio, steadyPitch, tapePitch, text, VIDEO_PASSTHROUGH } from './util';

function buildFilter(params: EffectParams, context: FilterContext): string {
  const ratio = semitoneRatio(number(params, 'semis'));
  if (text(params, 'mode') === 'keep-speed') {
    return `${VIDEO_PASSTHROUGH};[0:a]${steadyPitch(ratio, context)}[aout]`;
  }
  return `[0:v]setpts=PTS/${num(ratio)}[vout];[0:a]${tapePitch(ratio, context.sampleRate)}[aout]`;
}

function expectedDuration(params: EffectParams, duration: number): number {
  return text(params, 'mode') === 'tape' ? duration / semitoneRatio(number(params, 'semis')) : duration;
}

function describe(params: EffectParams): string {
  const semis = number(params, 'semis');
  return `PITCH ${semis > 0 ? '+' : ''}${semis}`;
}

const modeParam = {
  key: 'mode',
  label: 'Mode',
  type: 'select' as const,
  default: 'tape',
  options: ['tape', 'keep-speed'],
};

export const pitchUp: Effect = {
  id: 'pitch-up',
  label: 'PITCH UP',
  category: 'audio+video',
  description: 'Chipmunk. Tape mode speeds it up too, classic YTP style.',
  params: [{ key: 'semis', label: 'Semitones', type: 'int', min: -24, max: 24, step: 1, default: 7 }, modeParam],
  buildFilter,
  expectedDuration,
  describe,
};

export const pitchDown: Effect = {
  id: 'pitch-down',
  label: 'PITCH DOWN',
  category: 'audio+video',
  description: 'Demon. Tape mode slows it down too, classic YTP style.',
  params: [{ key: 'semis', label: 'Semitones', type: 'int', min: -24, max: 24, step: 1, default: -7 }, modeParam],
  buildFilter,
  expectedDuration,
  describe,
};
