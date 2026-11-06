import type { FilterContext } from './types';
import { holdLastFrame, num } from './util';

// Every sound here is generated from math, so nothing needs bundling or licensing.

const saw = (frequency: string) => `(2*mod((${frequency})*t,1)-1)`;

export interface Sound {
  seconds: number;
  /** An aevalsrc expression in t. */
  expression?: string;
  /** A full source chain, for sounds that need filtering after generation. */
  source?: (sampleRate: number) => string;
}

const stab = (frequency: number, start: number, length: number) =>
  `${saw(String(frequency))}*between(t,${start},${start + length})*exp(-(t-${start})*2.5)`;

export const SOUNDS = {
  boom: {
    seconds: 1.3,
    expression: '0.9*sin(2*PI*(52+90*exp(-t*16))*t)*exp(-t*3.2)+0.5*sin(2*PI*180*t)*exp(-t*50)',
  },
  airhorn: {
    seconds: 1.6,
    expression: `0.28*(${saw('466')}+${saw('470')}+${saw('698')})*(lt(mod(t,0.2),0.15)*lt(t,0.6)+gte(t,0.6)*lt(t,1.55))`,
  },
  sadTrombone: {
    seconds: 2,
    expression: `0.4*${saw('if(lt(t,0.42),294,if(lt(t,0.84),277,if(lt(t,1.26),262,247+5*sin(2*PI*6*t))))')}*(1-exp(-t*30))*if(lt(t,1.26),1,exp(-(t-1.26)*2.2))`,
  },
  fart: {
    seconds: 1.2,
    expression: '0.75*sin(2*PI*(68+26*sin(2*PI*9*t))*t+3*sin(2*PI*33*t))*exp(-t*1.1)*(0.65+0.35*random(0))',
  },
  laser: {
    seconds: 0.5,
    expression: '0.6*sin(2*PI*(1900*exp(-t*9)+130)*t)*exp(-t*5)',
  },
  boing: {
    seconds: 0.9,
    expression: '0.65*sin(2*PI*(210+130*sin(2*PI*5*t)*exp(-t*3))*t)*exp(-t*3)',
  },
  tick: {
    seconds: 0.25,
    expression: '0.9*sin(2*PI*2600*t)*exp(-t*55)+0.6*sin(2*PI*1200*t)*exp(-t*70)',
  },
  dunDunDun: {
    seconds: 2,
    expression: `0.3*(${[110, 165, 220].flatMap((f) => [stab(f, 0, 0.3), stab(f, 0.36, 0.3), stab(f * 0.84, 0.72, 1.25)]).join('+')})`,
  },
  crickets: {
    seconds: 2.5,
    expression: '0.32*sin(2*PI*4200*t)*lt(mod(t,0.5),0.17)*lt(mod(t,0.042),0.021)',
  },
  recordScratch: {
    seconds: 0.6,
    expression: '0.6*sin(2*PI*(500+900*sin(2*PI*7*t))*t)*exp(-t*4)*(0.7+0.3*random(0))',
  },
  explosion: {
    seconds: 1.8,
    source: (sampleRate) =>
      `aevalsrc='(2*random(0)-1)*exp(-t*2.4)':s=${sampleRate}:d=1.8,lowpass=f=1100,lowpass=f=1100,volume=12dB`,
  },
  rumble: {
    seconds: 3,
    source: (sampleRate) =>
      `aevalsrc='(2*random(0)-1)*(0.6+0.4*sin(2*PI*3*t))':s=${sampleRate}:d=3,lowpass=f=160,lowpass=f=160,volume=14dB`,
  },
  crashBuzz: {
    seconds: 1,
    expression: `0.4*${saw('60')}`,
  },
} satisfies Record<string, Sound>;

export function soundSource(sound: Sound, sampleRate: number, seconds = sound.seconds): string {
  const chain = sound.source?.(sampleRate) ?? `aevalsrc='${sound.expression}':s=${sampleRate}:d=${num(seconds)}`;
  return `${chain},aformat=channel_layouts=stereo:sample_fmts=fltp`;
}

/** How long a selection needs its last frame held so a sound can ring out. */
export const soundOverrun = (sound: Sound, duration: number) => Math.max(0, sound.seconds - duration);

/** The selection with a sound over the top, starting at the first frame and allowed to outlast it. */
export function withSound(sound: Sound, context: FilterContext, video = 'null', audio = 'anull'): string {
  const { duration, sampleRate } = context;
  const overrun = soundOverrun(sound, duration);
  return [
    `[0:v]${video},${holdLastFrame(overrun)}[vout]`,
    `${soundSource(sound, sampleRate)}[sound]`,
    `[0:a]${audio}[own]`,
    '[own][sound]amix=inputs=2:duration=longest:normalize=0,alimiter=limit=0.9:level=false[aout]',
  ].join(';');
}
