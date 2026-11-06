import type { EffectParam, EffectParams } from '../../shared/effects';
import type { Effect, FilterContext } from './types';
import { fitToProject, num, number, safeVibrato, videoOnly, zoomBy } from './util';

function videoEffect(
  id: string,
  label: string,
  description: string,
  chain: (params: EffectParams, context: FilterContext) => string,
  params: EffectParam[] = [],
): Effect {
  return { id, label, category: 'video', description, params, buildFilter: (p, c) => videoOnly(chain(p, c)) };
}

const FREQ_WINDOW = 2048;

const speedParam = (fallback: number): EffectParam => ({
  key: 'speed',
  label: 'Speed',
  type: 'number',
  min: 0.1,
  max: 6,
  step: 0.1,
  default: fallback,
});

export const videoPack: Effect[] = [
  videoEffect(
    'pixelate',
    'PIXELATE',
    'Giant blocky pixels.',
    (params, context) => {
      const size = number(params, 'size');
      return `scale=trunc(iw/${size}/2)*2:trunc(ih/${size}/2)*2:flags=neighbor,scale=${context.width}:${context.height}:flags=neighbor,setsar=1`;
    },
    [{ key: 'size', label: 'Block size', type: 'int', min: 4, max: 64, step: 2, default: 16 }],
  ),
  videoEffect('posterize', 'POSTERIZE', 'Crushes the picture down to a few flat colors.', () =>
    "lutyuv=y='floor(val/48)*48':u='floor(val/48)*48':v='floor(val/48)*48',eq=saturation=1.6"),
  videoEffect('thermal', 'THERMAL', 'Predator vision.', () => 'format=yuv444p,pseudocolor=preset=turbo'),
  videoEffect('nightvision', 'NIGHT VISION', 'Grainy green goggles.', () =>
    'hue=s=0,eq=brightness=0.08:contrast=1.5,colorchannelmixer=rr=0.15:gg=1.1:bb=0.2,noise=alls=28:allf=t,vignette=PI/3.2'),
  videoEffect('neon', 'NEON EDGES', 'Glowing outlines on black.', () =>
    'eq=saturation=3,split[color][lines];[lines]edgedetect=low=0.05:high=0.15:mode=wires,format=yuv420p,dilation,gblur=sigma=0.8[edges];[color]format=gbrp[flat];[edges]format=gbrp[mask];[flat][mask]blend=all_mode=multiply,format=yuv420p'),
  videoEffect('sketch', 'PENCIL', 'Black outlines on white paper.', () => 'edgedetect=low=0.1:high=0.3,negate'),
  videoEffect('xray', 'X-RAY', 'Inverted, cold, and medical.', () =>
    'negate,hue=s=0,eq=contrast=1.4,colorchannelmixer=rr=0.7:gg=0.9:bb=1.2'),
  videoEffect('noir', 'NOIR', 'Hard-boiled black and white.', () => 'hue=s=0,eq=contrast=1.6:brightness=-0.06,vignette=PI/3.5'),
  videoEffect('sepia', 'SEPIA', 'Great-grandpa\'s photo album.', () =>
    'colorchannelmixer=.393:.769:.189:0:.349:.686:.168:0:.272:.534:.131,vignette=PI/4'),
  videoEffect('cursed', 'CURSED COLORS', 'Swaps the color channels around.', () =>
    'colorchannelmixer=rr=0:rb=1:gg=0:gr=1:bb=0:bg=1,eq=saturation=1.5'),
  videoEffect('gameboy', 'GAME BOY', '160 pixels of pea soup.', (_params, { width, height }) =>
    `scale=160:90:flags=neighbor,hue=s=0,lutyuv=y='floor(val/64)*85',colorchannelmixer=rr=0.55:gg=0.75:bb=0.3,scale=${width}:${height}:flags=neighbor,setsar=1`),
  videoEffect('rgbsplit', 'RGB SPLIT', 'Color channels slide apart.', (params) => {
    const amount = number(params, 'amount');
    return `rgbashift=rh=${-amount}:bh=${amount}:rv=${Math.round(amount / 2)}:edge=smear`;
  }, [{ key: 'amount', label: 'Pixels', type: 'int', min: 4, max: 80, step: 2, default: 24 }]),
  videoEffect('scanlines', 'SCANLINES', 'Old arcade monitor.', () =>
    'drawgrid=w=iw:h=4:t=1:c=black@0.6,eq=saturation=1.3,vignette=PI/5'),
  videoEffect('vhs', 'VHS', 'Found in a shoebox in the attic.', () =>
    'chromashift=cbh=7:crh=-7,gblur=sigma=1,eq=saturation=1.4:contrast=0.9,noise=alls=16:allf=t,drawgrid=w=iw:h=3:t=1:c=black@0.2'),
  videoEffect('vhold', 'V-HOLD', 'The picture rolls like a dying TV.', (params) =>
    `scroll=vertical=${num(number(params, 'speed') / 30)}`, [speedParam(0.6)]),
  videoEffect('spin', 'SPIN', 'Spins the whole picture.', (params) =>
    `rotate=a=t*2*PI*${num(number(params, 'speed'))}:c=black`, [speedParam(1)]),
  videoEffect('fisheye', 'FISHEYE', 'Doorbell camera bulge.', () => 'lenscorrection=k1=0.55:k2=0.45:i=bilinear'),
  videoEffect('pinch', 'PINCH', 'Sucks the picture in toward the middle.', () => 'lenscorrection=k1=-0.55:k2=0.1:i=bilinear'),
  videoEffect('melt', 'MELT', 'The picture wobbles like jelly. Slow to render.', () =>
    "geq=lum='lum(X+14*sin(Y/28+T*7),Y)':cb='cb(X+7*sin(Y/14+T*7),Y)':cr='cr(X+7*sin(Y/14+T*7),Y)'"),
  videoEffect('trails', 'GHOST TRAILS', 'Everything leaves a fading trail.', () => 'lagfun=decay=0.96'),
  videoEffect('acid', 'ACID TRIP', 'Trails plus a spinning color wheel.', () =>
    "lagfun=decay=0.95,hue=H=2*PI*t*0.8:s=3,eq=contrast=1.3"),
  videoEffect('motionblur', 'MOTION BLUR', 'Long smeary exposure.', () => 'tmix=frames=12'),
  videoEffect('movement', 'ONLY MOVEMENT', 'Shows only what changed since the last frame.', () =>
    'format=gbrp,tblend=all_mode=difference,format=yuv420p,eq=contrast=3:brightness=0.1:saturation=2'),
  videoEffect('amplify', 'MOTION AMPLIFY', 'Exaggerates every tiny movement into noise.', () =>
    'amplify=radius=2:factor=40:threshold=3'),
  videoEffect('emboss', 'EMBOSS', 'Pressed into metal.', () =>
    "convolution='-2 -1 0 -1 1 1 0 1 2:-2 -1 0 -1 1 1 0 1 2:-2 -1 0 -1 1 1 0 1 2:-2 -1 0 -1 1 1 0 1 2'"),
  videoEffect('strobe', '⚠ STROBE', 'Rapid flashing. Warning: flashing lights.', (params) => {
    const period = num(1 / number(params, 'rate'));
    return `eq=brightness='if(lt(mod(t,${period}),${period}/2),0.65,-0.25)':eval=frame`;
  }, [{ key: 'rate', label: 'Flashes per second', type: 'number', min: 1, max: 12, step: 1, default: 6 }]),
  videoEffect('wide', 'WIDE BOY', 'Stretched out sideways.', (_params, context) =>
    `crop=iw*0.42:ih,${fitToProject(context)}`),
  videoEffect('tall', 'TALL BOY', 'Stretched out upwards.', (_params, context) =>
    `crop=iw:ih*0.42,${fitToProject(context)}`),
  videoEffect('squish', 'SQUISH', 'Bounces like a hydraulic press.', (_params, { width, height }) =>
    `scale=w=${width}:h='trunc(${height}*(0.5+0.5*abs(sin(t*7)))/2)*2':eval=frame,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:eval=frame,setsar=1`),
  videoEffect('pulse', 'PULSE', 'Zooms in and out on the beat.', (params, context) =>
    zoomBy(`1.25+0.25*sin(2*PI*${num(number(params, 'speed'))}*t)`, context), [speedParam(2)]),
  videoEffect('dramaticzoom', 'DRAMATIC ZOOM', 'Slow push in, right up the nose.', (_params, context) =>
    zoomBy(`1+1.6*t/${num(Math.max(context.duration, 0.1))}`, context)),
  videoEffect('dvd', 'DVD BOUNCE', 'Will it hit the corner?', (_params, { width, height, fps, duration }) => {
    const small = Math.round(width / 3 / 2) * 2;
    const x = "x='abs(mod(t*341,2*(W-w))-(W-w))'";
    const y = "y='abs(mod(t*227,2*(H-h))-(H-h))'";
    return `scale=${small}:-2,hue=H=t*4[small];color=black:s=${width}x${height}:r=${fps}:d=${num(duration)}[bg];[bg][small]overlay=${x}:${y}:shortest=1,format=yuv420p`;
  }),
  videoEffect('kaleidoscope', 'KALEIDOSCOPE', 'Four-way mirror.', (_params, context) =>
    `crop=iw/2:ih/2:0:0,split=4[tl][tr][bl][br];[tr]hflip[tr2];[bl]vflip[bl2];[br]hflip,vflip[br2];[tl][tr2]hstack[top];[bl2][br2]hstack[bottom];[top][bottom]vstack,${fitToProject(context)}`),
  videoEffect('clones', 'CLONE ARMY', 'Sixteen of them.', (_params, context) =>
    `scale=iw/4:ih/4,split[a][b];[a][b]hstack,split[c][d];[c][d]hstack,split[e][f];[e][f]vstack,split[g][h];[g][h]vstack,${fitToProject(context)}`),
  {
    id: 'drunk',
    label: 'DRUNK',
    category: 'audio+video',
    description: 'Swaying camera, blurry eyes, slurred sound.',
    params: [],
    buildFilter: () =>
      `[0:v]rotate=a='0.07*sin(t*1.7)':c=black,gblur=sigma=4[vout];[0:a]${safeVibrato(2, 0.7)},lowpass=f=2500[aout]`,
  },
  {
    id: 'underwater',
    label: 'UNDERWATER',
    category: 'audio+video',
    description: 'Glug glug glug. Slow to render.',
    params: [],
    buildFilter: () =>
      `[0:v]geq=lum='lum(X+10*sin(Y/40+T*3),Y)':cb='cb(X+5*sin(Y/20+T*3),Y)':cr='cr(X+5*sin(Y/20+T*3),Y)',colorchannelmixer=rr=0.45:gg=0.75:bb=1.15,gblur=sigma=2[vout];[0:a]lowpass=f=420,lowpass=f=420,volume=8dB,${safeVibrato(4, 0.4)},alimiter=limit=0.9:level=false[aout]`,
  },
  {
    id: 'visualizer',
    label: 'VISUALIZER',
    category: 'video',
    description: 'Glowing sound wave drawn over the picture.',
    params: [],
    buildFilter: (_params, { width, height, fps }) =>
      [
        '[0:a]asplit[keep][scope]',
        `[scope]showwaves=s=${width}x${height}:mode=cline:rate=${fps}:colors=0x22e3ff,format=yuv420p[wave]`,
        '[0:v][wave]blend=all_mode=screen:shortest=1[vout]',
        '[keep]anull[aout]',
      ].join(';'),
  },
  {
    id: 'spectrum',
    label: 'WINAMP',
    category: 'video',
    description: 'Replaces the picture with jumping frequency bars.',
    params: [],
    buildFilter: (_params, { width, height, sampleRate, duration }) => {
      // showfreqs stamps its frames with unusable times, so they're rebuilt from the frame count.
      const secondsPerFrame = FREQ_WINDOW / sampleRate;
      const bars = `showfreqs=s=${width}x${height}:mode=bar:fscale=log:ascale=log:win_size=${FREQ_WINDOW}:overlap=0:cmode=combined:colors=0x7dff6b`;
      return [
        '[0:v]nullsink',
        '[0:a]asplit[keep][scope]',
        `[scope]${bars},setpts=N*${num(secondsPerFrame)}/TB,trim=duration=${num(duration)},colorchannelmixer=rr=0.3:gg=1:bb=0.35,format=yuv420p,setsar=1[vout]`,
        '[keep]anull[aout]',
      ].join(';');
    },
  },
];
