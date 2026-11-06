export type EffectCategory = 'audio+video' | 'audio' | 'video' | 'glitch' | 'meme' | 'combo';

export type ParamValue = number | boolean | string;
export type EffectParams = Record<string, ParamValue>;

export interface EffectParam {
  key: string;
  label: string;
  type: 'number' | 'int' | 'bool' | 'select' | 'text';
  min?: number;
  max?: number;
  step?: number;
  default: ParamValue;
  options?: string[];
  /** CHAOS stays below this, so a random roll can't turn a short clip into minutes of video. */
  chaosMax?: number;
}

/** The part of an effect the renderer needs to draw its button. */
export interface EffectInfo {
  id: string;
  label: string;
  category: EffectCategory;
  description: string;
  params: EffectParam[];
  /** Holds the whole selection in RAM, so long selections deserve a warning. */
  buffersSelection?: boolean;
  /** Comes out different every time, so pressing it again should render again. */
  randomized?: boolean;
}

export function defaultParams(params: EffectParam[]): EffectParams {
  return Object.fromEntries(params.map((param) => [param.key, param.default]));
}
