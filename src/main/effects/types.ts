import type { EffectInfo, EffectParams } from '../../shared/effects';

export interface FilterContext {
  duration: number;
  fps: number;
  width: number;
  height: number;
  sampleRate: number;
  /** Whether the bundled ffmpeg has librubberband. */
  hasRubberband: boolean;
}

export interface EffectStep {
  effectId: string;
  params: EffectParams;
}

/** A pass that runs before the filter, for things that only work on the encoded bitstream. */
export interface Prepass {
  /** ffmpeg output options, applied to the selection. The result feeds the filter. */
  args: string[];
  /** Container for the intermediate file. */
  extension: string;
  /** Input options for reading the intermediate file back. */
  inputArgs?: string[];
}

export interface Effect extends EffectInfo {
  /** ffmpeg filters this effect can't work without. It's hidden if any are missing. */
  requires?: string[];
  /** Builds a -filter_complex for one input, [0:v][0:a], ending in [vout] and [aout]. */
  buildFilter(params: EffectParams, context: FilterContext): string;
  /** Rendered length, for the progress bar and tests. Defaults to the input length. */
  expectedDuration?(params: EffectParams, duration: number): number;
  /** Set when the length depends on a dice roll or rounding, so only a rough check applies. */
  variableLength?: boolean;
  /** How this effect reads in a CHAOS toast. Defaults to its label. */
  describe?(params: EffectParams): string;
  /** Combos expand into other effects instead of building a filter of their own. */
  expand?(pool: Effect[], random: () => number): EffectStep[];
  prepass?(params: EffectParams, context: FilterContext): Prepass;
}
