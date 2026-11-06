import { describe, expect, it } from 'vitest';
import { defaultParams, type EffectParams } from '../src/shared/effects';
import { availableEffects, effects, getEffect, resolveParams } from '../src/main/effects';
import { chaos } from '../src/main/effects/chaos';
import type { Effect, FilterContext } from '../src/main/effects/types';
import { atempoChain, semitoneRatio } from '../src/main/effects/util';

const context: FilterContext = {
  duration: 3,
  fps: 30,
  width: 1280,
  height: 720,
  sampleRate: 48000,
  hasRubberband: true,
};

/** Every setting a select can take, so each branch of each effect gets checked. */
function variants(effect: Effect): EffectParams[] {
  const base = defaultParams(effect.params);
  const selects = effect.params.filter((param) => param.type === 'select');
  return [
    base,
    ...selects.flatMap((param) => (param.options ?? []).map((option) => ({ ...base, [param.key]: option }))),
  ];
}

const labelsIn = (chain: string) => [...chain.matchAll(/\[([^\]]+)\]/g)].map((match) => match[1]);

/** Each chain's leading labels are inputs and its trailing labels are outputs. */
function parseGraph(filter: string) {
  const inputs: string[] = [];
  const outputs: string[] = [];
  for (const chain of filter.split(';')) {
    const leading = chain.match(/^(\[[^\]]+\])+/)?.[0] ?? '';
    const trailing = chain.match(/(\[[^\]]+\])+$/)?.[0] ?? '';
    inputs.push(...labelsIn(leading));
    outputs.push(...labelsIn(trailing));
  }
  return { inputs, outputs };
}

describe.each(effects)('$id', (effect) => {
  it.each(variants(effect))('builds a well-formed graph for %o', (params) => {
    const filter = effect.buildFilter(resolveParams(effect, params), context);
    const { inputs, outputs } = parseGraph(filter);

    expect(outputs.filter((label) => label === 'vout')).toHaveLength(1);
    expect(outputs.filter((label) => label === 'aout')).toHaveLength(1);
    expect(inputs).toContain('0:v');
    expect(inputs).toContain('0:a');

    // A label made and never used stalls the graph; one used and never made is a parse error.
    const internal = outputs.filter((label) => label !== 'vout' && label !== 'aout');
    expect([...internal].sort()).toEqual(inputs.filter((label) => !label.startsWith('0:')).sort());
    expect(new Set(outputs).size).toBe(outputs.length);

    expect(filter).not.toMatch(/\bNaN\b|undefined|e-\d/);
  });

  it('has defaults that survive range checking', () => {
    const defaults = defaultParams(effect.params);
    expect(resolveParams(effect, defaults)).toEqual(defaults);
  });
});

describe('specific recipes', () => {
  it('SUS chains one forward and one reversed pass per bounce', () => {
    const filter = getEffect('sus').buildFilter({ mode: 'forward-reverse', bounces: 3 }, context);
    expect(filter).toContain('concat=n=6:v=1:a=1');
  });

  it('SUS can start reversed', () => {
    const filter = getEffect('sus').buildFilter({ mode: 'reverse-forward', bounces: 1 }, context);
    expect(filter).toContain('[r0][ar0][f0][af0]concat');
  });

  it('STUTTER keeps its audio chunk the same length as its video chunk', () => {
    const filter = getEffect('stutter').buildFilter({ chunkMs: 100, repeats: 4 }, context);
    expect(filter).toContain('loop=loop=4:size=3:start=0');
    expect(filter).toContain('aloop=loop=4:size=4800:start=0');
  });

  it('STUTTER never asks for a chunk longer than the selection', () => {
    const filter = getEffect('stutter').buildFilter({ chunkMs: 500, repeats: 2 }, { ...context, duration: 0.1 });
    expect(filter).toContain('size=3:');
  });

  it('pitch falls back when rubberband is missing', () => {
    const filter = getEffect('pitch-up').buildFilter(
      { semis: 12, mode: 'keep-speed' },
      { ...context, hasRubberband: false },
    );
    expect(filter).not.toContain('rubberband');
    expect(filter).toContain('asetrate=96000');
    expect(filter).toContain('atempo=0.5');
  });

  it('EAR RAPE always ends with a limiter, at any intensity', () => {
    for (const intensity of [1, 5, 10]) {
      const filter = getEffect('earrape').buildFilter({ intensity }, context);
      expect(filter).toMatch(/alimiter=[^,\[]*\[aout\]/);
    }
  });
});

describe('atempoChain', () => {
  const product = (chain: string) =>
    [...chain.matchAll(/atempo=([\d.]+)/g)].reduce((total, match) => total * Number(match[1]), 1);

  it.each([0.25, 0.3, 0.5, 1, 2, 3.7, 4])('multiplies out to %f with every stage in range', (factor) => {
    const chain = atempoChain(factor);
    expect(product(chain)).toBeCloseTo(factor, 4);
    for (const match of chain.matchAll(/atempo=([\d.]+)/g)) {
      expect(Number(match[1])).toBeGreaterThanOrEqual(0.5);
      expect(Number(match[1])).toBeLessThanOrEqual(2);
    }
  });
});

describe('semitoneRatio', () => {
  it('doubles at an octave', () => {
    expect(semitoneRatio(12)).toBeCloseTo(2);
    expect(semitoneRatio(-12)).toBeCloseTo(0.5);
  });
});

describe('resolveParams', () => {
  const stutter = getEffect('stutter');

  it('fills in anything missing', () => {
    expect(resolveParams(stutter, {})).toEqual({ chunkMs: 100, repeats: 4 });
  });

  it('keeps numbers in range and whole where they should be', () => {
    expect(resolveParams(stutter, { chunkMs: 99999, repeats: 2.6 })).toEqual({ chunkMs: 500, repeats: 3 });
  });

  it('refuses values that would end up raw in a filter string', () => {
    const resolved = resolveParams(stutter, { chunkMs: '1;[0:v]evil' as unknown as number });
    expect(resolved.chunkMs).toBe(100);
    expect(resolveParams(getEffect('sus'), { mode: 'evil' }).mode).toBe('forward-reverse');
  });
});

describe('CHAOS', () => {
  const seeded = (seed: number) => () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };

  it.each([1, 2, 3, 4, 5, 6, 7, 8])('rolls 2 to 4 distinct valid effects (seed %i)', (seed) => {
    const steps = chaos.expand!(effects, seeded(seed * 7919));
    expect(steps.length).toBeGreaterThanOrEqual(2);
    expect(steps.length).toBeLessThanOrEqual(4);
    expect(new Set(steps.map((step) => step.effectId)).size).toBe(steps.length);
    for (const { effectId, params } of steps) {
      const effect = getEffect(effectId);
      expect(effectId).not.toBe('chaos');
      expect(resolveParams(effect, params)).toEqual(params);
    }
  });
});

describe('availableEffects', () => {
  it('hides an effect when a filter it needs is missing', () => {
    const filters = new Set(effects.flatMap((effect) => effect.requires ?? []));
    expect(availableEffects(filters)).toHaveLength(effects.length);

    filters.delete('acrusher');
    const ids = availableEffects(filters).map((effect) => effect.id);
    expect(ids).not.toContain('bitcrush');
    expect(ids).toContain('sus');
  });
});
