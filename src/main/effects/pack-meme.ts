import type { EffectParam, EffectParams } from '../../shared/effects';
import { SOUNDS, soundOverrun, soundSource, withSound, type Sound } from './synth';
import type { Effect, FilterContext } from './types';
import {
  both,
  drawText,
  fittedSize,
  holdLastFrame,
  num,
  number,
  replaceAudio,
  replaceVideo,
  text,
  tapePitch,
  videoOnly,
  zoomBy,
} from './util';

const textParam = (key: string, label: string, fallback: string): EffectParam => ({ key, label, type: 'text', default: fallback });

/** A sound dropped on the selection, optionally with something happening to the picture too. */
function soundEffect(
  id: string,
  label: string,
  description: string,
  sound: Sound,
  video: (context: FilterContext) => string = () => 'null',
  audio = 'anull',
): Effect {
  return {
    id,
    label,
    category: 'meme',
    description,
    params: [],
    buildFilter: (_params, context) => withSound(sound, context, video(context), audio),
    expectedDuration: (_params, duration) => Math.max(duration, sound.seconds),
  };
}

const SHAKE = (amount: number) =>
  `crop=iw*0.9:ih*0.9:x='(iw-ow)/2+sin(t*70)*${amount}':y='(ih-oh)/2+cos(t*53)*${amount}',scale=iw/0.9:ih/0.9,setsar=1`;

/** Freezes the last frame and holds it under a title. */
function freezeTitle(
  id: string,
  label: string,
  description: string,
  hold: number,
  look: (context: FilterContext, params: EffectParams) => string,
  sound?: Sound,
  params: EffectParam[] = [],
): Effect {
  return {
    id,
    label,
    category: 'meme',
    description,
    params,
    buildFilter: (values, context) => {
      const { duration, sampleRate } = context;
      const video = `tpad=stop_mode=clone:stop_duration=${hold},${look(context, values)}`;
      const silence = `apad=pad_dur=${hold}`;
      if (!sound) return both(video, silence);
      return [
        `[0:v]${video}[vout]`,
        `[0:a]${silence}[own]`,
        `${soundSource(sound, sampleRate)},adelay=delays=${Math.round(duration * 1000)}:all=1[sound]`,
        '[own][sound]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.9:level=false[aout]',
      ].join(';');
    },
    expectedDuration: (_params, duration) => duration + hold,
  };
}

const afterSelection = ({ duration }: FilterContext) => `gte(t,${num(duration)})`;

const SEPIA = 'colorchannelmixer=.393:.769:.189:0:.349:.686:.168:0:.272:.534:.131';

export const memePack: Effect[] = [
  {
    id: 'impacttext',
    label: 'IMPACT TEXT',
    category: 'meme',
    description: 'Top text. Bottom text.',
    params: [textParam('top', 'Top text', 'TOP TEXT'), textParam('bottom', 'Bottom text', 'BOTTOM TEXT')],
    buildFilter: (params, { width, height }) => {
      const top = text(params, 'top').toUpperCase();
      const bottom = text(params, 'bottom').toUpperCase();
      const lines = [
        top && drawText(top, { size: fittedSize(top, width * 0.95, height / 6), y: '20', border: 5 }),
        bottom && drawText(bottom, { size: fittedSize(bottom, width * 0.95, height / 6), y: 'h-text_h-24', border: 5 }),
      ].filter(Boolean);
      return videoOnly(lines.join(',') || 'null');
    },
  },
  {
    id: 'bigtext',
    label: 'BIG WORD',
    category: 'meme',
    description: 'One enormous word, slammed in the middle of the screen.',
    params: [textParam('word', 'Word', 'WOW')],
    buildFilter: (params, { width, height }) => {
      const word = text(params, 'word').toUpperCase();
      return videoOnly(word ? drawText(word, { size: fittedSize(word, width * 0.95, height / 2), color: 'yellow', border: 10 }) : 'null');
    },
  },
  {
    id: 'breakingnews',
    label: 'BREAKING NEWS',
    category: 'meme',
    description: 'Red banner and a scrolling ticker.',
    params: [textParam('headline', 'Headline', 'LOCAL MAN DOES IT AGAIN'), textParam('ticker', 'Ticker', 'MORE AT 11 ... SCIENTISTS BAFFLED ... NOBODY ASKED FOR THIS ...')],
    buildFilter: (params, { width, height }) => {
      const headline = text(params, 'headline').toUpperCase();
      const ticker = text(params, 'ticker').toUpperCase();
      const barTop = Math.round(height * 0.72);
      const barHeight = Math.round(height * 0.17);
      const tickerTop = barTop + barHeight;
      return videoOnly(
        [
          `drawbox=x=0:y=${barTop}:w=iw:h=${barHeight}:c=0xc40000:t=fill`,
          `drawbox=x=0:y=${tickerTop}:w=iw:h=${height - tickerTop}:c=black:t=fill`,
          drawText('BREAKING NEWS', { size: height / 22, x: '30', y: String(barTop + 6), border: 0, color: 'yellow' }),
          drawText(headline || ' ', { size: fittedSize(headline, width * 0.92, height / 13), x: '30', y: String(barTop + height / 15), border: 0 }),
          drawText(ticker || ' ', { size: height / 18, x: 'w-mod(t*260,w+text_w)', y: String(tickerTop + 8), border: 0 }),
        ].join(','),
      );
    },
  },
  {
    id: 'titlecard',
    label: 'TIME CARD',
    category: 'meme',
    description: 'Replaces the selection with a cartoon-style title card.',
    params: [
      textParam('title', 'Title', 'A FEW MOMENTS LATER'),
      { key: 'holdSec', label: 'Hold (s)', type: 'number', min: 1, max: 6, step: 0.5, default: 2, chaosMax: 2 },
    ],
    buildFilter: (params, { width, height, fps, sampleRate }) => {
      const title = text(params, 'title').toUpperCase() || ' ';
      const hold = num(number(params, 'holdSec'));
      const card = drawText(title, { size: fittedSize(title, width * 0.9, height / 7), color: 'yellow', border: 6, borderColor: '0x003060' });
      return [
        replaceVideo(`color=c=0x1a7ad0:s=${width}x${height}:r=${fps}:d=${hold},${card},format=yuv420p`),
        replaceAudio(`anullsrc=r=${sampleRate}:cl=stereo:d=${hold},aformat=sample_fmts=fltp`),
      ].join(';');
    },
    expectedDuration: (params) => number(params, 'holdSec'),
  },
  soundEffect('vineboom', 'VINE BOOM', 'Deep thud with a zoom punch.', SOUNDS.boom, (context) =>
    zoomBy(`1+0.5*exp(-t*5)`, context)),
  soundEffect('airhorn', 'AIRHORN', 'BWAH BWAH BWAH BWAAAAAH', SOUNDS.airhorn),
  soundEffect('sadtrombone', 'SAD TROMBONE', 'Wah wah wah waaaaah.', SOUNDS.sadTrombone, () => 'hue=s=0.4'),
  soundEffect('fart', 'FART', 'Scientifically generated.', SOUNDS.fart),
  soundEffect('laser', 'PEW PEW', 'Sci-fi laser zap.', SOUNDS.laser),
  soundEffect('boing', 'BOING', 'Cartoon spring.', SOUNDS.boing, (context) =>
    zoomBy('1+0.3*abs(sin(t*18))*exp(-t*4)', context)),
  soundEffect('dundundun', 'DUN DUN DUN', 'Dramatic stabs and a slow push in.', SOUNDS.dunDunDun, (context) =>
    zoomBy('1+0.35*min(t/1.2,1)', context)),
  soundEffect('explosion', 'EXPLOSION', 'White flash, screen shake, and a big bang.', SOUNDS.explosion, () =>
    `fade=t=in:st=0:d=0.35:c=white,${SHAKE(26)}`),
  soundEffect('earthquake', 'EARTHQUAKE', 'Violent shaking and a low rumble.', SOUNDS.rumble, () => SHAKE(34)),
  soundEffect('hitmarker', 'HITMARKER', 'Tick. Tick. Tick. Are you even trying?', SOUNDS.tick, ({ height }) =>
    drawText('X', { size: height / 6, enable: 'lt(mod(t,0.4),0.12)', border: 3 })),
  {
    id: 'mlg',
    label: 'MLG',
    category: 'meme',
    description: 'Airhorn, hue spin, shake, and a word of your choice.',
    params: [textParam('word', 'Word', 'WOMBO COMBO')],
    buildFilter: (params, context) => {
      const word = text(params, 'word').toUpperCase() || ' ';
      const title = drawText(word, { size: fittedSize(word, context.width * 0.9, context.height / 5), color: 'lime', border: 8 });
      return withSound(SOUNDS.airhorn, context, `hue=h=t*720:s=2,${SHAKE(18)},${title}`);
    },
    expectedDuration: (_params, duration) => Math.max(duration, SOUNDS.airhorn.seconds),
  },
  {
    id: 'censored',
    label: 'CENSORED',
    category: 'meme',
    description: 'A big beep and a mosaic over the middle of the screen.',
    params: [],
    buildFilter: (_params, { width, height, duration, sampleRate }) => {
      const boxWidth = Math.round((width * 0.5) / 2) * 2;
      const boxHeight = Math.round((height * 0.4) / 2) * 2;
      const x = Math.round((width - boxWidth) / 2);
      const y = Math.round((height - boxHeight) / 2);
      return [
        '[0:v]split[picture][copy]',
        `[copy]crop=${boxWidth}:${boxHeight}:${x}:${y},scale=${Math.round(boxWidth / 24)}:-2:flags=neighbor,scale=${boxWidth}:${boxHeight}:flags=neighbor[mosaic]`,
        `[picture][mosaic]overlay=${x}:${y}[vout]`,
        replaceAudio(`sine=f=1000:r=${sampleRate}:d=${num(duration)},volume=0.4,aformat=channel_layouts=stereo:sample_fmts=fltp`),
      ].join(';');
    },
  },
  {
    id: 'crickets',
    label: 'CRICKETS',
    category: 'meme',
    description: 'Awkward silence, then nothing but crickets.',
    params: [],
    buildFilter: (_params, context) => {
      const overrun = soundOverrun(SOUNDS.crickets, context.duration);
      return [
        `[0:v]${holdLastFrame(overrun)}[vout]`,
        `[0:a]volume=0[own]`,
        `${soundSource(SOUNDS.crickets, context.sampleRate)}[sound]`,
        '[own][sound]amix=inputs=2:duration=longest:normalize=0[aout]',
      ].join(';');
    },
    expectedDuration: (_params, duration) => Math.max(duration, SOUNDS.crickets.seconds),
  },
  {
    id: 'camcorder',
    label: 'CAMCORDER',
    category: 'meme',
    description: 'Blinking REC in the corner of a grainy home video.',
    params: [],
    buildFilter: (_params, { height }) =>
      videoOnly(
        [
          'eq=saturation=0.8,noise=alls=10:allf=t,vignette=PI/4.5',
          drawText('REC', { size: height / 12, x: '70', y: '40', border: 0, enable: 'lt(mod(t,1),0.6)' }),
          `drawbox=x=30:y=${Math.round(40 + height / 60)}:w=28:h=28:c=red:t=fill:enable='lt(mod(t,1),0.6)'`,
          drawText('PLAY', { size: height / 16, x: 'w-text_w-40', y: 'h-text_h-30', border: 0 }),
        ].join(','),
      ),
  },
  {
    id: 'tvoff',
    label: 'TV OFF',
    category: 'meme',
    description: 'The picture collapses into a line, like an old set switching off.',
    params: [],
    buildFilter: (_params, { width, height, duration, fps }) => {
      const start = num(Math.max(0, duration - 0.35));
      const squash = `max(0.01,1-(t-${start})/0.3)`;
      const scale = `scale=w=${width}:h='max(2,trunc(${height}*if(lt(t,${start}),1,${squash})/2)*2)':eval=frame`;
      const pad = `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:eval=frame`;
      return videoOnly(`${scale},${pad},setsar=1,fps=${fps}`);
    },
  },
  freezeTitle('tobecontinued', 'TO BE CONTINUED', 'Sepia freeze with the classic title.', 2.5, (context) => {
    const when = afterSelection(context);
    return [
      `${SEPIA}:enable='${when}'`,
      drawText('TO BE CONTINUED', { size: context.height / 10, x: '40', y: 'h-text_h-40', enable: when, color: '0xf3e5ab', border: 5 }),
    ].join(',');
  }),
  freezeTitle(
    'yepthatsme',
    "YEP THAT'S ME",
    'Record scratch, freeze frame, you\'re probably wondering how I got here.',
    3,
    (context, params) => {
      const when = afterSelection(context);
      const caption = text(params, 'caption').toUpperCase() || ' ';
      return [
        `hue=s=0.25:enable='${when}'`,
        drawText(caption, { size: fittedSize(caption, context.width * 0.9, context.height / 10), y: 'h-text_h-40', enable: when }),
      ].join(',');
    },
    SOUNDS.recordScratch,
    [textParam('caption', 'Caption', "YEP. THAT'S ME.")],
  ),
  freezeTitle('youdied', 'YOU DIED', 'The dark souls of video editing.', 3, (context) => {
    const { duration, height } = context;
    const when = afterSelection(context);
    return [
      `fade=t=out:st=${num(duration)}:d=0.8:alpha=0`,
      `drawbox=x=0:y=${Math.round(height * 0.38)}:w=iw:h=${Math.round(height * 0.24)}:c=black@0.75:t=fill:enable='${when}'`,
      drawText('YOU DIED', { size: height / 5, color: '0xa01010', border: 0, enable: when }),
    ].join(',');
  }),
  {
    id: 'wasted',
    label: 'WASTED',
    category: 'meme',
    description: 'Slow motion, black and white, big red letters.',
    params: [],
    buildFilter: (_params, { height, sampleRate, duration }) => {
      const slowed = duration * 2;
      return both(
        `setpts=PTS*2,hue=s=0,${drawText('WASTED', { size: height / 4, color: '0xc01818', border: 6, enable: `gte(t,${num(slowed * 0.35)})` })}`,
        `${tapePitch(0.5, sampleRate)},lowpass=f=1800,aecho=0.8:0.8:120:0.4`,
      );
    },
    expectedDuration: (_params, duration) => duration * 2,
  },
];
