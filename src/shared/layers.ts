import type { MediaId } from './types';

/**
 * Layers sit on top of the main track. The main track stays what it always was: clips played
 * back to back, where effects chop and swap pieces. Layer clips instead float at a fixed time,
 * so a cutout of Luffy can sit over any scene, move around, and get keyed or blended in.
 */

export type BlendMode = 'normal' | 'add' | 'screen' | 'multiply' | 'overlay' | 'darken' | 'lighten' | 'difference';

export const BLEND_MODES: { id: BlendMode; label: string }[] = [
  { id: 'normal', label: 'Normal' },
  { id: 'add', label: 'Add' },
  { id: 'screen', label: 'Screen' },
  { id: 'multiply', label: 'Multiply' },
  { id: 'overlay', label: 'Overlay' },
  { id: 'darken', label: 'Darken' },
  { id: 'lighten', label: 'Lighten' },
  { id: 'difference', label: 'Difference' },
];

/** How a keyframe moves on to the next one. */
export type Easing = 'linear' | 'ease' | 'hold';

/**
 * Where the clip's picture is at one moment. Layer media is always the project's size, so
 * scale 1 at the centre covers the frame exactly.
 */
export interface Transform {
  /** Centre of the picture, as a fraction of the frame width. 0.5 is the middle. */
  x: number;
  /** Centre of the picture, as a fraction of the frame height. */
  y: number;
  scale: number;
  /** Degrees, clockwise. */
  rotation: number;
}

export interface Keyframe extends Transform {
  /** Seconds from the start of the clip. */
  time: number;
  easing: Easing;
}

export interface ChromaKey {
  /** The colour to remove, as #rrggbb. */
  color: string;
  /** How close a colour has to be to vanish, 0..1. */
  similarity: number;
  /** How softly the edge fades out, 0..1. */
  blend: number;
}

export type TextFont = 'impact' | 'sans';

export interface TextStyle {
  text: string;
  font: TextFont;
  /** Letter height as a fraction of the frame height, so it looks the same at any resolution. */
  size: number;
  color: string;
  outline: string;
  /** Outline thickness as a fraction of the letter height. */
  outlineWidth: number;
}

export type OverlaySource =
  | { kind: 'media'; mediaId: MediaId; in: number; out: number }
  | { kind: 'text'; style: TextStyle; duration: number };

export interface OverlayClip {
  id: string;
  /** Where the clip begins on the timeline, in seconds. */
  start: number;
  source: OverlaySource;
  /** Always at least one. */
  keyframes: Keyframe[];
  /**
   * Whether edits land on keyframes. Off, the clip holds one transform and edits move all of
   * it. Older files don't have this; a clip with two or more keyframes animates regardless.
   */
  animated?: boolean;
  opacity: number;
  blend: BlendMode;
  fadeIn: number;
  fadeOut: number;
  /** Gain on the clip's own sound. 0 leaves it silent. */
  volume: number;
  key: ChromaKey | null;
}

export interface Layer {
  id: string;
  name: string;
  hidden: boolean;
  muted: boolean;
  clips: OverlayClip[];
}

export const GREEN_SCREEN: ChromaKey = { color: '#00ff00', similarity: 0.3, blend: 0.1 };

export const DEFAULT_TEXT: TextStyle = {
  text: 'TEXT',
  font: 'impact',
  size: 0.14,
  color: '#ffffff',
  outline: '#000000',
  outlineWidth: 0.08,
};

const IDENTITY: Transform = { x: 0.5, y: 0.5, scale: 1, rotation: 0 };
const TEXT_SECONDS = 2;
// Well under a frame at any frame rate the app offers.
const SAME_TIME = 1e-3;

export const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

const snap = (time: number, fps: number) => Math.round(time * fps) / fps;

export function overlayDuration(clip: OverlayClip): number {
  return clip.source.kind === 'media' ? clip.source.out - clip.source.in : clip.source.duration;
}

export const overlayEnd = (clip: OverlayClip) => clip.start + overlayDuration(clip);

export function newLayer(layers: Layer[]): Layer {
  const taken = new Set(layers.map((layer) => layer.name));
  let number = layers.length + 1;
  while (taken.has(`Layer ${number}`)) number++;
  return { id: crypto.randomUUID(), name: `Layer ${number}`, hidden: false, muted: false, clips: [] };
}

function baseClip(start: number, source: OverlaySource, transform: Partial<Transform> = {}): OverlayClip {
  return {
    id: crypto.randomUUID(),
    start,
    source,
    keyframes: [{ time: 0, ...IDENTITY, ...transform, easing: 'linear' }],
    opacity: 1,
    blend: 'normal',
    fadeIn: 0,
    fadeOut: 0,
    volume: 1,
    key: null,
  };
}

/** New media on a layer starts a bit smaller than the frame, so it reads as a layer at once. */
export function mediaOverlay(mediaId: MediaId, duration: number, start: number): OverlayClip {
  return baseClip(start, { kind: 'media', mediaId, in: 0, out: duration }, { scale: 0.5 });
}

export function textOverlay(start: number, style: Partial<TextStyle> = {}): OverlayClip {
  const clip = baseClip(start, { kind: 'text', style: { ...DEFAULT_TEXT, ...style }, duration: TEXT_SECONDS }, { y: 0.82 });
  return { ...clip, volume: 0 };
}

export const sortKeyframes = (keyframes: Keyframe[]) => [...keyframes].sort((a, b) => a.time - b.time);

/** How far along an easing curve `progress` (0..1) is. */
export function ease(easing: Easing, progress: number): number {
  if (easing === 'hold') return 0;
  if (easing === 'ease') return progress * progress * (3 - 2 * progress);
  return progress;
}

/** The transform at `time` seconds into the clip. Before the first and after the last key it holds. */
export function transformAt(keyframes: Keyframe[], time: number): Transform {
  const keys = sortKeyframes(keyframes);
  const first = keys[0] ?? { ...IDENTITY, time: 0, easing: 'linear' as const };
  if (keys.length < 2 || time <= first.time) return pick(first);
  const last = keys[keys.length - 1];
  if (time >= last.time) return pick(last);

  const index = keys.findIndex((key) => key.time > time) - 1;
  const from = keys[index];
  const to = keys[index + 1];
  const amount = ease(from.easing, (time - from.time) / (to.time - from.time));
  const mix = (a: number, b: number) => a + (b - a) * amount;
  return { x: mix(from.x, to.x), y: mix(from.y, to.y), scale: mix(from.scale, to.scale), rotation: mix(from.rotation, to.rotation) };
}

const pick = ({ x, y, scale, rotation }: Transform): Transform => ({ x, y, scale, rotation });

export const isAnimated = (clip: OverlayClip) => clip.animated === true || clip.keyframes.length > 1;

export const keyframeAt = (clip: OverlayClip, time: number) =>
  clip.keyframes.findIndex((key) => Math.abs(key.time - time) < SAME_TIME);

/**
 * Changes the transform at `time`. A clip that isn't animated holds one transform, so the
 * change applies to the whole clip. Once it animates, every edit lands on a keyframe at `time`,
 * made on the spot if there isn't one there yet.
 */
export function editTransform(clip: OverlayClip, time: number, change: Partial<Transform>): OverlayClip {
  if (!isAnimated(clip)) {
    return { ...clip, keyframes: [{ ...clip.keyframes[0], ...change }] };
  }
  const index = keyframeAt(clip, time);
  if (index !== -1) {
    return { ...clip, keyframes: clip.keyframes.map((key, position) => (position === index ? { ...key, ...change } : key)) };
  }
  return { ...clip, keyframes: sortKeyframes([...clip.keyframes, { ...transformAt(clip.keyframes, time), ...change, time, easing: 'linear' }]) };
}

/**
 * Adds a keyframe holding the current transform, which is how a still clip starts animating.
 * A still clip's one keyframe moves to `time`, so the motion starts from where it sits now.
 */
export function addKeyframe(clip: OverlayClip, time: number): OverlayClip {
  if (!isAnimated(clip)) return { ...clip, animated: true, keyframes: [{ ...clip.keyframes[0], time }] };
  if (keyframeAt(clip, time) !== -1) return clip;
  const easing = clip.keyframes[0]?.easing ?? 'linear';
  return { ...clip, keyframes: sortKeyframes([...clip.keyframes, { ...transformAt(clip.keyframes, time), time, easing }]) };
}

/**
 * Removing an animated clip's last keyframe stops the animation instead: a clip always has a
 * transform, and the one left becomes the still one.
 */
export function removeKeyframe(clip: OverlayClip, time: number): OverlayClip {
  const index = keyframeAt(clip, time);
  if (index === -1) return clip;
  if (clip.keyframes.length === 1) return isAnimated(clip) ? { ...clip, animated: false, keyframes: [{ ...clip.keyframes[0], time: 0 }] } : clip;
  const keyframes = clip.keyframes.filter((_key, position) => position !== index);
  return { ...clip, animated: true, keyframes };
}

export function setEasing(clip: OverlayClip, time: number, easing: Easing): OverlayClip {
  const keys = sortKeyframes(clip.keyframes);
  // The easing belongs to the keyframe the playhead is leaving.
  const index = Math.max(0, keys.findLastIndex((key) => key.time <= time + SAME_TIME));
  return { ...clip, keyframes: keys.map((key, position) => (position === index ? { ...key, easing } : key)) };
}

/** Trimming the front of a clip moves its keyframes with the picture, so animation stays put. */
export function shiftKeyframes(clip: OverlayClip, seconds: number): OverlayClip {
  if (!isAnimated(clip)) return clip;
  return { ...clip, keyframes: clip.keyframes.map((key) => ({ ...key, time: key.time - seconds })) };
}

/**
 * The clip with one edge dragged by `delta` seconds. Media can't trim past its own ends; text
 * can be any length. Trimming the front keeps the picture where it was in time.
 */
export function trimmedOverlay(
  clip: OverlayClip,
  edge: 'start' | 'end',
  delta: number,
  mediaDuration: number,
  fps: number,
): OverlayClip {
  const frame = 1 / fps;
  const { source } = clip;
  if (edge === 'end') {
    if (source.kind === 'media') {
      return { ...clip, source: { ...source, out: snap(clamp(source.out + delta, source.in + frame, mediaDuration), fps) } };
    }
    return { ...clip, source: { ...source, duration: snap(Math.max(frame, source.duration + delta), fps) } };
  }

  const earliest = source.kind === 'media' ? Math.max(-source.in, -clip.start) : -clip.start;
  const shift = snap(clamp(delta, earliest, overlayDuration(clip) - frame), fps);
  const moved = shiftKeyframes({ ...clip, start: clip.start + shift }, shift);
  return source.kind === 'media'
    ? { ...moved, source: { ...source, in: source.in + shift } }
    : { ...moved, source: { ...source, duration: source.duration - shift } };
}

export function findOverlay(layers: Layer[], clipId: string): { layer: Layer; clip: OverlayClip } | null {
  for (const layer of layers) {
    const clip = layer.clips.find((candidate) => candidate.id === clipId);
    if (clip) return { layer, clip };
  }
  return null;
}

export function updateOverlay(layers: Layer[], clipId: string, update: (clip: OverlayClip) => OverlayClip): Layer[] {
  return layers.map((layer) =>
    layer.clips.some((clip) => clip.id === clipId)
      ? { ...layer, clips: layer.clips.map((clip) => (clip.id === clipId ? update(clip) : clip)) }
      : layer,
  );
}

export function removeOverlay(layers: Layer[], clipId: string): Layer[] {
  return layers.map((layer) =>
    layer.clips.some((clip) => clip.id === clipId) ? { ...layer, clips: layer.clips.filter((clip) => clip.id !== clipId) } : layer,
  );
}

/** Puts a clip on a layer, taking it off whichever layer had it. Clips stay sorted by start. */
export function placeOverlay(layers: Layer[], layerId: string, clip: OverlayClip): Layer[] {
  return removeOverlay(layers, clip.id).map((layer) =>
    layer.id === layerId ? { ...layer, clips: [...layer.clips, clip].sort((a, b) => a.start - b.start) } : layer,
  );
}

/** Everything that will show, bottom layer first, in the order it gets drawn. */
export function visibleOverlays(layers: Layer[]): { layer: Layer; clip: OverlayClip }[] {
  return layers.filter((layer) => !layer.hidden).flatMap((layer) => layer.clips.map((clip) => ({ layer, clip })));
}

export function activeOverlays(layers: Layer[], time: number): { layer: Layer; clip: OverlayClip }[] {
  return visibleOverlays(layers).filter(({ clip }) => time >= clip.start && time < overlayEnd(clip));
}

export function overlayMediaIds(layers: Layer[]): MediaId[] {
  return layers.flatMap((layer) => layer.clips.flatMap((clip) => (clip.source.kind === 'media' ? [clip.source.mediaId] : [])));
}

/** How visible the clip is at `time` seconds into it, counting its opacity and fades. */
export function alphaAt(clip: OverlayClip, time: number): number {
  const duration = overlayDuration(clip);
  let alpha = clip.opacity;
  if (clip.fadeIn > 0 && time < clip.fadeIn) alpha *= clamp(time / clip.fadeIn, 0, 1);
  if (clip.fadeOut > 0 && time > duration - clip.fadeOut) alpha *= clamp((duration - time) / clip.fadeOut, 0, 1);
  return alpha;
}

/** "#00ff00" → [0, 255, 0]. Anything unreadable comes out as green, the usual screen colour. */
export function parseColor(color: string): [number, number, number] {
  const match = /^#?([0-9a-f]{6})$/i.exec(color.trim());
  if (!match) return [0, 255, 0];
  const value = parseInt(match[1], 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

/**
 * How opaque a pixel stays under a chroma key. This is ffmpeg's colorkey maths, so what the
 * preview shows is what the export makes.
 */
export function keyAlpha(key: ChromaKey, keyRgb: [number, number, number], r: number, g: number, b: number): number {
  const dr = r - keyRgb[0];
  const dg = g - keyRgb[1];
  const db = b - keyRgb[2];
  const diff = Math.sqrt((dr * dr + dg * dg + db * db) / (3 * 255 * 255));
  if (key.blend > 0) return clamp((diff - key.similarity) / key.blend, 0, 1);
  return diff > key.similarity ? 1 : 0;
}

/** Files from before layers existed have none. */
export function withLayers<T extends { layers?: Layer[] }>(project: T): T & { layers: Layer[] } {
  return { ...project, layers: project.layers ?? [] };
}
