import { access } from 'node:fs/promises';
import { join } from 'node:path';
import {
  overlayDuration,
  parseColor,
  sortKeyframes,
  type BlendMode,
  type Keyframe,
  type Layer,
  type OverlayClip,
  type TextFont,
  type TextStyle,
} from '../shared/layers';
import type { CompositeRequest, ProjectSettings } from '../shared/types';

/**
 * Builds the ffmpeg graph that stacks layers over the main track. Each layer clip becomes a
 * full-frame RGBA stream: keyed, faded, then moved into place by a perspective warp, which
 * does move, scale and rotate in one go and can follow keyframes frame by frame.
 */

// Transparent margin around a clip before it's warped. The warp copies edge pixels outward,
// so without this the picture's border would smear across the whole frame.
const MARGIN = 2;
// Blend modes other than normal mix against a canvas that leaves the base untouched.
const NEUTRAL: Record<Exclude<BlendMode, 'normal'>, string> = {
  add: 'black',
  screen: 'black',
  lighten: 'black',
  difference: 'black',
  multiply: 'white',
  darken: 'white',
  overlay: '0x808080',
};
const FFMPEG_BLEND: Record<Exclude<BlendMode, 'normal'>, string> = {
  add: 'addition',
  screen: 'screen',
  lighten: 'lighten',
  difference: 'difference',
  multiply: 'multiply',
  darken: 'darken',
  overlay: 'overlay',
};
const LINE_HEIGHT = 1.15;

export type FontFiles = Partial<Record<TextFont, string>>;

const FONT_CANDIDATES: Record<TextFont, string[]> = {
  impact: [
    join(process.env['WINDIR'] ?? 'C:\\Windows', 'Fonts', 'impact.ttf'),
    '/System/Library/Fonts/Supplemental/Impact.ttf',
    '/Library/Fonts/Impact.ttf',
    '/usr/share/fonts/truetype/msttcorefonts/Impact.ttf',
  ],
  sans: [
    join(process.env['WINDIR'] ?? 'C:\\Windows', 'Fonts', 'arialbd.ttf'),
    '/System/Library/Fonts/Supplemental/Arial Bold.ttf',
    '/Library/Fonts/Arial Bold.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
    '/usr/share/fonts/TTF/DejaVuSans-Bold.ttf',
  ],
};

async function firstExisting(paths: string[]): Promise<string | undefined> {
  for (const path of paths) {
    try {
      await access(path);
      return path;
    } catch {
      // Try the next one.
    }
  }
  return undefined;
}

/** Impact where the system has it. Anywhere it doesn't, text falls back to a bold sans. */
export async function findFonts(): Promise<FontFiles> {
  const sans = await firstExisting(FONT_CANDIDATES.sans);
  const impact = (await firstExisting(FONT_CANDIDATES.impact)) ?? sans;
  return { impact, sans };
}

/** A number for an ffmpeg expression: fixed point, since exponents read badly in some spots. */
const num = (value: number) => (Number.isFinite(value) ? Number(value.toFixed(6)).toString() : '0');

/**
 * A path as a filter option value. The graph level is handled by the quotes; the option level
 * still splits on colons, which every Windows drive letter has.
 */
export function filterPath(path: string): string {
  const escaped = path.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, `'\\''`);
  return `'${escaped}'`;
}

const hex = (color: string) => {
  const [r, g, b] = parseColor(color);
  return `0x${[r, g, b].map((part) => part.toString(16).padStart(2, '0')).join('')}`;
};

/**
 * One transform property as an expression of `time`, following the keyframes. It mirrors
 * transformAt, so the preview and the export move the same way.
 */
export function keyframeExpr(keys: Keyframe[], value: (key: Keyframe) => number, time: string): string {
  const sorted = sortKeyframes(keys);
  if (sorted.length === 1) return num(value(sorted[0]));

  let expr = num(value(sorted[sorted.length - 1]));
  for (let index = sorted.length - 2; index >= 0; index--) {
    const from = sorted[index];
    const to = sorted[index + 1];
    const span = to.time - from.time;
    const a = value(from);
    const b = value(to);
    let segment: string;
    if (span <= 0 || from.easing === 'hold' || a === b) {
      segment = num(a);
    } else {
      const p = `((${time}-(${num(from.time)}))/${num(span)})`;
      const curve = from.easing === 'ease' ? `(${p}*${p}*(3-2*${p}))` : p;
      segment = `(${num(a)}+(${num(b - a)})*${curve})`;
    }
    expr = `if(lt(${time},${num(to.time)}),${segment},${expr})`;
  }
  return `if(lt(${time},${num(sorted[0].time)}),${num(value(sorted[0]))},${expr})`;
}

const isIdentity = (keys: Keyframe[]) =>
  keys.length === 1 && keys[0].x === 0.5 && keys[0].y === 0.5 && keys[0].scale === 1 && keys[0].rotation === 0;

/** Moves, scales and rotates a W×H RGBA picture into place, frame by frame when animated. */
export function transformFilter(keys: Keyframe[], settings: ProjectSettings): string {
  if (isIdentity(keys)) return '';
  const { width: W, height: H, fps } = settings;
  const time = `(on/${fps})`;
  const x = keyframeExpr(keys, (key) => key.x, time);
  const y = keyframeExpr(keys, (key) => key.y, time);
  const scale = keyframeExpr(keys, (key) => key.scale, time);
  const angle = keyframeExpr(keys, (key) => (key.rotation * Math.PI) / 180, time);

  const halfW = W / 2 + MARGIN;
  const halfH = H / 2 + MARGIN;
  // Top left, top right, bottom left, bottom right: the order perspective takes them in.
  const corners: [number, number][] = [
    [-halfW, -halfH],
    [halfW, -halfH],
    [-halfW, halfH],
    [halfW, halfH],
  ];
  const points = corners.flatMap(([dx, dy], index) => [
    `x${index}='${MARGIN}+${W}*(${x})+(${scale})*(${num(dx)}*cos(${angle})-(${num(dy)})*sin(${angle}))'`,
    `y${index}='${MARGIN}+${H}*(${y})+(${scale})*(${num(dx)}*sin(${angle})+(${num(dy)})*cos(${angle}))'`,
  ]);

  return [
    `pad=${W + 2 * MARGIN}:${H + 2 * MARGIN}:${MARGIN}:${MARGIN}:color=black@0`,
    `perspective=${points.join(':')}:sense=destination:eval=${keys.length > 1 ? 'frame' : 'init'}`,
    `crop=${W}:${H}:${MARGIN}:${MARGIN}`,
  ].join(',');
}

/** A text card on a clear frame, one drawtext per line so every line is centred. */
function textSource(
  style: TextStyle,
  seconds: number,
  settings: ProjectSettings,
  font: string,
  lineFile: (line: string) => string,
): string {
  const { width: W, height: H, fps } = settings;
  const size = Math.max(4, Math.round(style.size * H));
  const border = Math.round(size * style.outlineWidth);
  const lines = style.text.split(/\r?\n/);
  const lineHeight = Math.round(size * LINE_HEIGHT);
  const top = (H - lines.length * lineHeight) / 2;
  const draws = lines
    .map((line, index) =>
      line.trim()
        ? 'drawtext=' +
          [
            `fontfile=${filterPath(font)}`,
            `textfile=${filterPath(lineFile(line))}`,
            'expansion=none',
            `fontsize=${size}`,
            `fontcolor=${hex(style.color)}`,
            `borderw=${border}`,
            `bordercolor=${hex(style.outline)}`,
            'x=(w-text_w)/2',
            `y=${num(top + index * lineHeight + (lineHeight - size) / 2)}`,
          ].join(':')
        : null,
    )
    .filter((draw): draw is string => draw !== null);
  return [`color=c=black@0:s=${W}x${H}:r=${fps}:d=${num(seconds)}`, 'format=rgba', ...draws].join(',');
}

export interface CompositePlan {
  /** Input options for the clips, in input order after the base video. */
  inputs: string[];
  /** The graph, from [0:v][0:a] to [vout][aout]. */
  filter: string;
  /** Text files the graph reads, to write before ffmpeg starts. */
  files: { path: string; contents: string }[];
}

interface PlannedClip {
  clip: OverlayClip;
  layer: Layer;
  /** How much of it fits before the video ends. */
  seconds: number;
}

/**
 * Plans the composite over a base video `duration` seconds long. Clips that start after the
 * end are left out, and ones that run past it get cut there, since the main track sets the
 * video's length.
 */
export function planComposite(
  composite: CompositeRequest,
  duration: number,
  settings: ProjectSettings,
  fonts: FontFiles,
  workDir: string,
  /** The video stream's last filters: scaling and format for the export. */
  finish: string,
): CompositePlan {
  const { width: W, height: H, fps } = settings;
  const planned: PlannedClip[] = composite.layers
    .filter((layer) => !layer.hidden)
    .flatMap((layer) =>
      layer.clips
        .filter((clip) => clip.start < duration - 1e-3)
        .map((clip) => ({ clip, layer, seconds: Math.min(overlayDuration(clip), duration - clip.start) })),
    );

  const inputs: string[] = [];
  const files: CompositePlan['files'] = [];
  const graph: string[] = [];
  const audio: string[] = [];
  let video = '[0:v]';
  let nextInput = 1;

  planned.forEach(({ clip, layer, seconds }, index) => {
    const { source } = clip;
    let chain: string;
    let audioInput: number | null = null;

    if (source.kind === 'media') {
      const media = composite.media[source.mediaId];
      if (!media) throw new Error('A layer uses media that is no longer in the project.');
      // Transparent media is read through libvpx, the only VP9 decoder that keeps the alpha.
      const read = media.alphaPath ? ['-c:v', 'libvpx-vp9', '-i', media.alphaPath] : ['-i', media.path];
      inputs.push('-ss', num(source.in), '-t', num(seconds), ...read);
      audioInput = nextInput;
      chain = `[${nextInput++}:v]setpts=PTS-STARTPTS,fps=${fps},format=rgba`;
    } else {
      const font = fonts[source.style.font] ?? fonts.sans ?? fonts.impact;
      if (!font) throw new Error('No font was found for text layers.');
      let line = 0;
      chain = textSource(source.style, seconds, settings, font, (text) => {
        const path = join(workDir, `text-${index}-${line++}.txt`);
        files.push({ path, contents: text });
        return path;
      });
    }

    const filters: string[] = [];
    if (clip.key) {
      const { similarity, blend } = clip.key;
      filters.push(`colorkey=color=${hex(clip.key.color)}:similarity=${num(Math.max(0.001, similarity))}:blend=${num(blend)}`);
    }
    if (clip.opacity < 1) filters.push(`colorchannelmixer=aa=${num(Math.max(0, clip.opacity))}`);
    if (clip.fadeIn > 0) filters.push(`fade=t=in:st=0:d=${num(clip.fadeIn)}:alpha=1`);
    if (clip.fadeOut > 0) {
      const end = overlayDuration(clip);
      filters.push(`fade=t=out:st=${num(Math.max(0, end - clip.fadeOut))}:d=${num(clip.fadeOut)}:alpha=1`);
    }
    const transform = transformFilter(clip.keyframes, settings);
    if (transform) filters.push(transform);
    filters.push(`setpts=PTS+${num(clip.start)}/TB`);
    graph.push(`${chain},${filters.join(',')}[c${index}]`);

    if (clip.blend === 'normal') {
      graph.push(`${video}[c${index}]overlay=0:0:eof_action=pass:repeatlast=0:format=auto[v${index}]`);
    } else {
      graph.push(
        `color=c=${NEUTRAL[clip.blend]}:s=${W}x${H}:r=${fps}:d=${num(duration)},format=rgba[n${index}]`,
        `[n${index}][c${index}]overlay=0:0:eof_action=pass:repeatlast=0:format=rgb,format=gbrp[l${index}]`,
        `${video}format=gbrp[b${index}]`,
        `[b${index}][l${index}]blend=all_mode=${FFMPEG_BLEND[clip.blend]}:shortest=1[v${index}]`,
      );
    }
    video = `[v${index}]`;

    if (audioInput !== null && clip.volume > 0 && !layer.muted) {
      const fades: string[] = [];
      if (clip.fadeIn > 0) fades.push(`afade=t=in:st=0:d=${num(clip.fadeIn)}`);
      if (clip.fadeOut > 0) fades.push(`afade=t=out:st=${num(Math.max(0, seconds - clip.fadeOut))}:d=${num(clip.fadeOut)}`);
      const delay = Math.round(clip.start * 1000);
      graph.push(
        [`[${audioInput}:a]asetpts=PTS-STARTPTS`, `volume=${num(clip.volume)}`, ...fades, `adelay=${delay}:all=1`].join(',') +
          `[a${index}]`,
      );
      audio.push(`[a${index}]`);
    }
  });

  graph.push(`${video}${finish}[vout]`);
  graph.push(
    audio.length > 0
      ? `[0:a]${audio.join('')}amix=inputs=${audio.length + 1}:normalize=0:duration=first:dropout_transition=0[aout]`
      : '[0:a]anull[aout]',
  );

  return { inputs, filter: graph.join(';'), files };
}

/**
 * Splits the layer clips into groups of at most `size`, keeping the order they're drawn in.
 * Every clip is an ffmpeg input with its own decoder, so a YTP with hundreds of layer clips
 * can't go in one pass; it goes in several, each stacking on what the last one made.
 */
export function batchOverlays(composite: CompositeRequest, size: number): CompositeRequest[] {
  const clips = composite.layers.filter((layer) => !layer.hidden).flatMap((layer) => layer.clips.map((clip) => ({ layer, clip })));
  const batches: CompositeRequest[] = [];
  for (let first = 0; first < clips.length; first += size) {
    // One layer per clip keeps both the stacking order and each clip's layer settings.
    const layers = clips.slice(first, first + size).map(({ layer, clip }) => ({ ...layer, clips: [clip] }));
    batches.push({ layers, media: composite.media });
  }
  return batches;
}

/** Whether a composite has anything to draw over the main track. */
export function hasOverlays(composite: CompositeRequest | undefined): composite is CompositeRequest {
  return !!composite && composite.layers.some((layer) => !layer.hidden && layer.clips.length > 0);
}
