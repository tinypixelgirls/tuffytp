import type { EffectParams } from '../../shared/effects';
import { frameCount, sliceGraph, type Slice } from './slices';
import { SOUNDS, soundSource } from './synth';
import type { Effect, FilterContext } from './types';
import { both, drawText, fittedSize, num, number, replaceAudio, replaceVideo, videoOnly } from './util';

const picker = () => (limit: number) => Math.floor(Math.random() * limit);

function shuffled<T>(items: T[]): T[] {
  const pick = picker();
  const result = [...items];
  for (let index = result.length - 1; index > 0; index--) {
    const other = pick(index + 1);
    [result[index], result[other]] = [result[other], result[index]];
  }
  return result;
}

function evenSlices(count: number, frames: number): Slice[] {
  const parts = Math.min(count, frames);
  return Array.from({ length: parts }, (_, index) => ({
    from: Math.floor((index * frames) / parts),
    to: Math.floor(((index + 1) * frames) / parts),
  }));
}

function buildBrokenCd(context: FilterContext): Slice[] {
  const pick = picker();
  const frames = frameCount(context);
  const slices: Slice[] = [];
  let position = 0;
  while (position < frames) {
    const length = Math.min(2 + pick(3), frames - position);
    const repeats = 1 + pick(5);
    for (let repeat = 0; repeat < repeats; repeat++) slices.push({ from: position, to: position + length });
    position += length;
  }
  return slices;
}

/** The opening repeats faster and faster, then the whole thing plays. */
function buildDrumRoll(context: FilterContext): Slice[] {
  const frames = frameCount(context);
  const slices: Slice[] = [];
  for (const divisor of [4, 8, 16]) {
    const length = Math.max(1, Math.round(frames / divisor));
    for (let repeat = 0; repeat < divisor / 2; repeat++) slices.push({ from: 0, to: length });
  }
  slices.push({ from: 0, to: frames });
  return slices;
}

function rampSlices(context: FilterContext, rateAt: (progress: number) => number): Slice[] {
  return evenSlices(14, frameCount(context)).map((slice, index, all) => ({
    ...slice,
    rate: rateAt(all.length > 1 ? index / (all.length - 1) : 0),
  }));
}

/** Zigs back and forth over one short stretch, like a hand on a record. */
function buildScratch(context: FilterContext): Slice[] {
  const frames = frameCount(context);
  const length = Math.max(1, Math.min(8, Math.round(frames / 3)));
  const zigzag = Array.from({ length: 6 }, (_, index) => ({
    from: 0,
    to: length,
    reversed: index % 2 === 1,
    rate: 2.5,
  }));
  return [...zigzag, { from: 0, to: frames }];
}

const sliceEffect = (
  id: string,
  label: string,
  description: string,
  build: (params: EffectParams, context: FilterContext) => Slice[],
  extra: Partial<Effect> = {},
): Effect => ({
  id,
  label,
  category: 'glitch',
  description,
  params: [],
  buffersSelection: true,
  variableLength: true,
  buildFilter: (params, context) => sliceGraph(build(params, context), context),
  ...extra,
});

const CRASH_HOLD = 1.2;

const holdThenCut = (duration: number) =>
  `tpad=stop_mode=clone:stop_duration=${num(duration)},trim=duration=${num(duration)}`;

export const glitchPack: Effect[] = [
  sliceEffect(
    'shuffle',
    'SHUFFLE',
    'Chops the selection up and plays the pieces in a random order.',
    (params, context) => shuffled(evenSlices(number(params, 'pieces'), frameCount(context))),
    {
      randomized: true,
      variableLength: false,
      params: [{ key: 'pieces', label: 'Pieces', type: 'int', min: 2, max: 32, step: 1, default: 8 }],
    },
  ),
  sliceEffect('brokencd', 'BROKEN CD', 'Skips and sticks like a scratched disc.', (_params, context) => buildBrokenCd(context), {
    randomized: true,
  }),
  sliceEffect('drumroll', 'DRUM ROLL', 'Stutters faster and faster, then lets go.', (_params, context) => buildDrumRoll(context)),
  sliceEffect('recordstop', 'RECORD STOP', 'Slows to a halt with the pitch sliding down.', (_params, context) =>
    rampSlices(context, (progress) => 1 - progress * 0.82)),
  sliceEffect('windup', 'WIND UP', 'Starts dead slow and spins up to speed.', (_params, context) =>
    rampSlices(context, (progress) => 0.18 + progress * 0.82)),
  sliceEffect('scratch', 'DJ SCRATCH', 'Wicka wicka.', (_params, context) => buildScratch(context)),
  {
    id: 'datamosh',
    label: 'DATAMOSH',
    category: 'glitch',
    description: 'Real datamoshing: deletes the keyframes so motion smears over the wrong picture.',
    params: [],
    randomized: false,
    prepass: () => ({
      args: [
        // An upside-down negative as frame 0 is the "wrong picture" for the rest to paint over.
        '-filter_complex', '[0:v]split[a][b];[b]trim=end_frame=1,vflip,negate,setpts=PTS-STARTPTS[c];[c][a]concat=n=2:v=1:a=0[out]',
        '-map', '[out]',
        '-map', '0:a',
        '-c:v', 'mpeg4',
        '-q:v', '3',
        '-bf', '0',
        '-g', '600',
        '-force_key_frames', 'expr:eq(n,1)',
        '-bsf:v', "noise=drop='key*gt(n\\,0)'",
        '-c:a', 'pcm_s16le',
      ],
      extension: 'mkv',
      inputArgs: ['-err_detect', 'ignore_err'],
    }),
    // Frames lost to the damage leave gaps, so the end gets held and then cut to the right length.
    buildFilter: (_params, { duration }) =>
      both(`trim=start_frame=1,setpts=PTS-STARTPTS,${holdThenCut(duration)}`, 'anull'),
    variableLength: true,
  },
  {
    id: 'corrupt',
    label: 'CORRUPT',
    category: 'glitch',
    description: 'Flips random bits in the video file itself. Different every time.',
    randomized: true,
    variableLength: true,
    params: [{ key: 'damage', label: 'Damage', type: 'int', min: 1, max: 10, step: 1, default: 5 }],
    prepass: (params) => ({
      args: [
        '-c:v', 'mpeg4',
        '-q:v', '4',
        '-bf', '0',
        '-g', '30',
        '-bsf:v', `noise=amount=${Math.round(40000 / number(params, 'damage'))}`,
        '-c:a', 'pcm_s16le',
      ],
      extension: 'mkv',
      inputArgs: ['-err_detect', 'ignore_err'],
    }),
    buildFilter: (_params, { duration }) => both(holdThenCut(duration), 'anull'),
  },
  {
    id: 'crash',
    label: 'CONSOLE CRASH',
    category: 'glitch',
    description: 'Freezes on one frame with a looping buzz, like a game that just died.',
    params: [],
    buildFilter: (_params, { duration, fps, sampleRate }) => {
      const frames = Math.max(0, Math.round((duration * fps) / 2));
      const grain = Math.round(sampleRate / fps);
      const loops = Math.round(CRASH_HOLD * fps);
      return both(
        `loop=loop=${loops}:size=1:start=${frames},setpts=N/FRAME_RATE/TB`,
        `aloop=loop=${loops}:size=${grain}:start=${Math.round((frames / fps) * sampleRate)},asetpts=N/SR/TB,volume=3dB,alimiter=limit=0.9:level=false`,
      );
    },
    expectedDuration: (_params, duration) => duration + CRASH_HOLD,
    variableLength: true,
  },
  {
    id: 'lag',
    label: 'LAG',
    category: 'glitch',
    description: 'Drops to 4 frames per second with choppy audio.',
    params: [],
    buildFilter: () => both('fps=4', 'tremolo=f=8:d=0.9,acrusher=bits=8:samples=4:mode=lin:mix=1'),
  },
  {
    id: 'framescramble',
    label: 'FRAME SCRAMBLE',
    category: 'glitch',
    description: 'Throws the frames into a random order.',
    randomized: true,
    params: [],
    buildFilter: () => videoOnly('random=frames=24'),
  },
  {
    id: 'rewind',
    label: 'REWIND',
    category: 'glitch',
    description: 'Tape rewinding at speed, with tracking lines.',
    params: [],
    buffersSelection: true,
    buildFilter: (_params, context) =>
      both(
        `reverse,setpts=PTS/3,chromashift=cbh=5:crh=-5,noise=alls=20:allf=t,${drawText('<< REW', { size: context.height / 10, x: '40', y: '30' })}`,
        `areverse,asetrate=${context.sampleRate * 3},aresample=${context.sampleRate},highpass=f=300,volume=-4dB`,
      ),
    expectedDuration: (_params, duration) => duration / 3,
  },
  {
    id: 'static',
    label: 'TV STATIC',
    category: 'glitch',
    description: 'Dead channel.',
    params: [],
    buildFilter: (_params, { duration, sampleRate }) =>
      videoStatic(duration, sampleRate),
  },
  {
    id: 'bsod',
    label: 'BLUE SCREEN',
    category: 'glitch',
    description: 'Your PC ran into a problem and has to restart.',
    params: [{ key: 'holdSec', label: 'Hold (s)', type: 'number', min: 1, max: 8, step: 0.5, default: 3, chaosMax: 3 }],
    buildFilter: (params, { width, height, fps, sampleRate }) => {
      const hold = number(params, 'holdSec');
      const lines = [
        drawText(':(', { size: height / 4, x: 'w/9', y: 'h/6', border: 0 }),
        drawText('YOUR VIDEO RAN INTO A PROBLEM', { size: fittedSize('YOUR VIDEO RAN INTO A PROBLEM', width * 0.7, height / 14), x: 'w/9', y: 'h/2', border: 0 }),
        drawText('AND NEEDS TO POOP', { size: height / 14, x: 'w/9', y: 'h*0.6', border: 0 }),
      ];
      return [
        replaceVideo(`color=c=0x0078d7:s=${width}x${height}:r=${fps}:d=${num(hold)},${lines.join(',')},format=yuv420p`),
        replaceAudio(soundSource(SOUNDS.crashBuzz, sampleRate, hold)),
      ].join(';');
    },
    expectedDuration: (params) => number(params, 'holdSec'),
  },
  {
    id: 'difficulties',
    label: 'TECHNICAL DIFFICULTIES',
    category: 'glitch',
    description: 'Color bars and a test tone.',
    params: [{ key: 'holdSec', label: 'Hold (s)', type: 'number', min: 1, max: 8, step: 0.5, default: 3, chaosMax: 3 }],
    buildFilter: (params, { width, height, fps, sampleRate }) => {
      const hold = number(params, 'holdSec');
      const text = drawText('PLEASE STAND BY', { size: height / 8, y: 'h*0.42' });
      return [
        replaceVideo(`smptehdbars=s=${width}x${height}:r=${fps}:d=${num(hold)},${text},format=yuv420p,setsar=1`),
        replaceAudio(`sine=f=1000:r=${sampleRate}:d=${num(hold)},volume=0.35,aformat=channel_layouts=stereo:sample_fmts=fltp`),
      ].join(';');
    },
    expectedDuration: (params) => number(params, 'holdSec'),
  },
];

function videoStatic(duration: number, sampleRate: number): string {
  return [
    `[0:v]geq=lum='random(1)*255':cb=128:cr=128[vout]`,
    replaceAudio(`anoisesrc=c=white:a=0.25:r=${sampleRate}:d=${num(duration)},aformat=channel_layouts=stereo:sample_fmts=fltp`),
  ].join(';');
}
