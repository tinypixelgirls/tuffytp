import { describe, expect, it } from 'vitest';
import { keyframeExpr } from '../src/main/composite';
import {
  addKeyframe,
  alphaAt,
  editTransform,
  keyAlpha,
  mediaOverlay,
  removeKeyframe,
  setEasing,
  shiftKeyframes,
  transformAt,
  trimmedOverlay,
  type Keyframe,
  type OverlayClip,
} from '../src/shared/layers';


const key = (time: number, x: number, easing: Keyframe['easing'] = 'linear'): Keyframe => ({
  time,
  x,
  y: 0.5,
  scale: 1,
  rotation: 0,
  easing,
});

/** Runs an ffmpeg expression from keyframeExpr in JavaScript, to check it against transformAt. */
function evaluate(expr: string, time: number): number {
  const js = expr.replace(/\bT\b/g, String(time)).replace(/if\(/g, 'iff(').replace(/lt\(/g, 'lt(');
  const iff = (condition: number, a: number, b: number) => (condition ? a : b);
  const lt = (a: number, b: number) => (a < b ? 1 : 0);
  return new Function('iff', 'lt', `return ${js};`)(iff, lt) as number;
}

describe('transformAt', () => {
  const keys = [key(0, 0), key(1, 1), key(2, 1, 'hold'), key(3, 0)];

  it('interpolates between keyframes and holds outside them', () => {
    expect(transformAt(keys, -1).x).toBe(0);
    expect(transformAt(keys, 0.25).x).toBeCloseTo(0.25);
    expect(transformAt(keys, 2.5).x).toBe(1);
    expect(transformAt(keys, 10).x).toBe(0);
  });

  it('eases with a smoothstep', () => {
    const eased = [key(0, 0, 'ease'), key(1, 1)];
    expect(transformAt(eased, 0.25).x).toBeCloseTo(0.15625);
    expect(transformAt(eased, 0.5).x).toBeCloseTo(0.5);
  });

  it('matches the expression the export runs', () => {
    const mixed = [key(0, 0.2, 'ease'), key(0.5, 0.9), key(1.5, 0.4, 'hold'), key(2, 0.1)];
    const expr = keyframeExpr(mixed, (k) => k.x, 'T');
    for (const time of [-0.2, 0, 0.1, 0.33, 0.5, 0.9, 1.49, 1.7, 2, 3]) {
      expect(evaluate(expr, time)).toBeCloseTo(transformAt(mixed, time).x, 5);
    }
  });
});

describe('editing keyframes', () => {
  const clip: OverlayClip = mediaOverlay('m', 4, 1);

  it('moves a still clip as a whole', () => {
    const moved = editTransform(clip, 2, { x: 0.1 });
    expect(moved.keyframes).toHaveLength(1);
    expect(moved.keyframes[0].x).toBe(0.1);
  });

  it('starts animating from the first keyframe, then adds one wherever it is moved', () => {
    const animated = addKeyframe(clip, 2);
    expect(animated.animated).toBe(true);
    expect(animated.keyframes.map((k) => k.time)).toEqual([2]);
    const moved = editTransform(animated, 3, { x: 0.9 });
    expect(moved.keyframes.map((k) => k.time)).toEqual([2, 3]);
    expect(transformAt(moved.keyframes, 2.5).x).toBeCloseTo(0.7);
    expect(transformAt(moved.keyframes, 1).x).toBe(0.5);
  });

  it('stops animating when the last keyframe is removed', () => {
    const animated = editTransform(addKeyframe(addKeyframe(clip, 0), 2), 2, { x: 0.8 });
    const one = removeKeyframe(animated, 0);
    expect(one.animated).toBe(true);
    expect(one.keyframes).toEqual([animated.keyframes[1]]);
    const still = removeKeyframe(one, 2);
    expect(still.animated).toBe(false);
    expect(still.keyframes).toEqual([{ ...animated.keyframes[1], time: 0 }]);
    expect(editTransform(still, 3, { x: 0.1 }).keyframes).toHaveLength(1);
  });

  it('sets the easing of the keyframe being left', () => {
    const animated = addKeyframe(addKeyframe(addKeyframe(clip, 0), 1), 2);
    const eased = setEasing(animated, 1.5, 'hold');
    expect(eased.keyframes.map((k) => k.easing)).toEqual(['linear', 'hold', 'linear']);
  });

  it('keeps animation in place when the front is trimmed', () => {
    const animated = addKeyframe(addKeyframe(clip, 0), 2);
    expect(shiftKeyframes(animated, 0.5).keyframes.map((k) => k.time)).toEqual([-0.5, 1.5]);
    const trimmed = trimmedOverlay(animated, 'start', 0.5, 4, 30);
    expect(trimmed.start).toBe(1.5);
    expect(trimmed.source).toEqual({ kind: 'media', mediaId: 'm', in: 0.5, out: 4 });
    expect(transformAt(trimmed.keyframes, 1.5)).toEqual(transformAt(animated.keyframes, 2));
  });

  it("doesn't trim media past its own ends", () => {
    expect(trimmedOverlay(clip, 'start', -3, 4, 30).source).toMatchObject({ in: 0 });
    expect(trimmedOverlay(clip, 'end', 10, 4, 30).source).toMatchObject({ out: 4 });
  });
});

describe('alphaAt', () => {
  it('multiplies opacity by the fades', () => {
    const clip = { ...mediaOverlay('m', 4, 0), opacity: 0.5, fadeIn: 1, fadeOut: 2 };
    expect(alphaAt(clip, 0.5)).toBeCloseTo(0.25);
    expect(alphaAt(clip, 1.5)).toBeCloseTo(0.5);
    expect(alphaAt(clip, 3)).toBeCloseTo(0.25);
  });
});

describe('keyAlpha', () => {
  const green: [number, number, number] = [0, 255, 0];

  it('removes the key colour and keeps others', () => {
    const key = { color: '#00ff00', similarity: 0.3, blend: 0.1 };
    expect(keyAlpha(key, green, 0, 250, 5)).toBe(0);
    expect(keyAlpha(key, green, 255, 0, 0)).toBe(1);
  });

  it('cuts hard with no softness', () => {
    const key = { color: '#00ff00', similarity: 0.3, blend: 0 };
    expect(keyAlpha(key, green, 0, 200, 0)).toBe(0);
    expect(keyAlpha(key, green, 200, 200, 200)).toBe(1);
  });
});
