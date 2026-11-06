import type { EffectParam, EffectParams } from '../../shared/effects';
import type { Effect, FilterContext } from './types';
import { audioOnly, both, num, number, safeVibrato, semitoneRatio, steadyPitch, tapePitch } from './util';

function audioEffect(
  id: string,
  label: string,
  description: string,
  chain: (params: EffectParams, context: FilterContext) => string,
  params: EffectParam[] = [],
): Effect {
  return { id, label, category: 'audio', description, params, buildFilter: (p, c) => audioOnly(chain(p, c)) };
}

const LIMIT = 'alimiter=limit=0.9:level=false';

export const audioPack: Effect[] = [
  audioEffect('robot', 'ROBOT', 'Flat, buzzing robot voice.', () =>
    "afftfilt=real='hypot(re,im)*sin(0)':imag='hypot(re,im)*cos(0)':win_size=512:overlap=0.75,volume=6dB," + LIMIT),
  audioEffect('whisper', 'WHISPER', 'Turns any voice into a creepy whisper.', () =>
    "afftfilt=real='hypot(re,im)*cos(2*PI*random(0))':imag='hypot(re,im)*sin(2*PI*random(1))':win_size=128:overlap=0.8"),
  audioEffect('telephone', 'PHONE CALL', 'Tinny phone line.', () =>
    'highpass=f=300,lowpass=f=3400,highpass=f=300,lowpass=f=3400,volume=6dB,' + LIMIT),
  audioEffect('megaphone', 'MEGAPHONE', 'Distorted loudhailer.', () =>
    'highpass=f=500,lowpass=f=2800,volume=18dB,asoftclip=type=tanh,volume=-3dB,' + LIMIT),
  audioEffect('potato', 'POTATO MIC', 'Worst headset in the lobby.', () =>
    'highpass=f=400,lowpass=f=2400,volume=20dB,asoftclip=type=hard,acrusher=bits=6:samples=6:mode=lin:mix=1,' + LIMIT),
  audioEffect(
    'bassboost',
    'BASS BOOSTED',
    'The bass goes to the moon.',
    (params) => `bass=g=${num(number(params, 'amount'))}:f=70:w=1,volume=4dB,asoftclip=type=tanh,${LIMIT}`,
    [{ key: 'amount', label: 'Bass', type: 'number', min: 6, max: 40, step: 1, default: 28 }],
  ),
  audioEffect('mosquito', 'MOSQUITO', 'Nothing but the top end.', () => 'highpass=f=3000,highpass=f=3000,volume=14dB,' + LIMIT),
  audioEffect('muffled', 'NEXT ROOM', 'Heard through the wall of the party next door.', () =>
    'lowpass=f=320,lowpass=f=320,volume=6dB,' + LIMIT),
  audioEffect(
    'flanger',
    'FLANGE',
    'Jet plane sweep.',
    (params) => `flanger=delay=4:depth=8:regen=60:speed=${num(number(params, 'speed'))}`,
    [{ key: 'speed', label: 'Speed', type: 'number', min: 0.1, max: 8, step: 0.1, default: 1 }],
  ),
  audioEffect('phaser', 'PHASER', 'Swirly 70s phaser.', () => 'aphaser=type=t:speed=1.5:decay=0.7:delay=4'),
  audioEffect(
    'chopper',
    'CHOPPER',
    'Hard volume gate, like a helicopter.',
    (params) => `tremolo=f=${num(number(params, 'rate'))}:d=1`,
    [{ key: 'rate', label: 'Chops per second', type: 'number', min: 2, max: 30, step: 1, default: 12 }],
  ),
  audioEffect('8d', '8D AUDIO', 'Spins around your head. Headphones recommended.', () => 'apulsator=hz=0.6:amount=1:width=2'),
  audioEffect('backmask', 'BACKMASK', 'Plays the sound backwards over the normal picture.', () => 'areverse'),
  audioEffect('blown', 'BLOWN SPEAKER', 'Everything clips.', () =>
    'volume=26dB,asoftclip=type=atan,lowpass=f=4000,volume=-4dB,' + LIMIT),
  audioEffect('karaoke', 'KARAOKE', 'Cancels whatever is dead center, usually the vocals. Mono clips go silent.', () =>
    'pan=stereo|c0=c0-c1|c1=c1-c0'),
  audioEffect('seasick', 'SEASICK', 'Slow, deep pitch wobble.', () => safeVibrato(1.5, 1)),
  {
    id: 'chipmunks',
    label: 'CHIPMUNKS',
    category: 'audio',
    description: 'Original voice plus two helium copies.',
    params: [],
    buildFilter: (_params, context) =>
      audioOnly(
        `asplit=3[root][a][b];[a]${steadyPitch(semitoneRatio(12), context)}[up];[b]${steadyPitch(semitoneRatio(19), context)}[high];` +
          `[root][up][high]amix=inputs=3:normalize=0,volume=0.7,${LIMIT}`,
      ),
  },
  {
    id: 'demonvoice',
    label: 'DEMON VOICE',
    category: 'audio',
    description: 'Speaks from below, with a choir of itself.',
    params: [],
    buildFilter: (_params, context) =>
      audioOnly(
        `asplit=2[a][b];[a]${steadyPitch(semitoneRatio(-12), context)}[low];[b]${steadyPitch(semitoneRatio(-5), context)}[mid];` +
          `[low][mid]amix=inputs=2:normalize=0,aecho=0.8:0.8:90|170:0.5|0.3,volume=3dB,${LIMIT}`,
      ),
  },
  {
    id: 'reversereverb',
    label: 'GHOST SWELL',
    category: 'audio',
    description: 'A reverb that swells in before the sound does. The horror movie one.',
    params: [],
    buildFilter: () =>
      both(
        'tpad=start_mode=clone:start_duration=1',
        'apad=pad_dur=1,areverse,aecho=0.8:0.9:90|170|290|430:0.6|0.5|0.4|0.3,areverse',
      ),
    expectedDuration: (_params, duration) => duration + 1,
  },
];

/** Slowed, sped-up, and otherwise pitch-moved vibes, which all change the picture's timing too. */
export const vibePack: Effect[] = [
  {
    id: 'nightcore',
    label: 'NIGHTCORE',
    category: 'audio+video',
    description: 'Fast, high, and pink.',
    params: [],
    buildFilter: (_params, { sampleRate }) =>
      both(`setpts=PTS/${num(semitoneRatio(5))},hue=h=320:s=1.5`, tapePitch(semitoneRatio(5), sampleRate)),
    expectedDuration: (_params, duration) => duration / semitoneRatio(5),
  },
  {
    id: 'vaporwave',
    label: 'VAPORWAVE',
    category: 'audio+video',
    description: 'Ａ Ｅ Ｓ Ｔ Ｈ Ｅ Ｔ Ｉ Ｃ',
    params: [],
    buildFilter: (_params, { sampleRate }) =>
      both(
        `setpts=PTS/${num(semitoneRatio(-5))},hue=h=280:s=1.4,chromashift=crh=-6:cbh=6,noise=alls=8:allf=t`,
        `${tapePitch(semitoneRatio(-5), sampleRate)},aecho=0.8:0.85:120|240:0.4|0.25`,
      ),
    expectedDuration: (_params, duration) => duration / semitoneRatio(-5),
  },
  {
    id: 'slowedreverb',
    label: 'SLOWED + REVERB',
    category: 'audio+video',
    description: 'Every song on the internet at 3am.',
    params: [],
    buildFilter: (_params, { sampleRate }) =>
      both(
        `setpts=PTS/${num(semitoneRatio(-3))}`,
        `${tapePitch(semitoneRatio(-3), sampleRate)},aecho=0.8:0.88:70|130|210|330:0.45|0.38|0.3|0.2`,
      ),
    expectedDuration: (_params, duration) => duration / semitoneRatio(-3),
  },
];
