import type { Clip, MediaFile, MediaId, WaveformPeaks } from '../../shared/types';

export interface TimeRange {
  start: number;
  end: number;
}

/** A stretch of one media file to play, starting at `start` on the program clock. */
export interface PlaybackSegment {
  mediaId: MediaId;
  in: number;
  out: number;
  start: number;
}

// Well under one frame, and big enough to absorb float error from summing clip lengths.
const EPSILON = 1e-4;

const WORD_SEARCH_SECONDS = 1.5;
const WORD_QUIET_RATIO = 0.14;
const WORD_MIN_LEVEL = 0.01;
const WORD_GAP_BUCKETS = 3;

export const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

export const snapToFrame = (time: number, fps: number) => Math.round(time * fps) / fps;

export const clipLength = (clip: Clip) => clip.out - clip.in;

export const timelineDuration = (clips: Clip[]) => clips.reduce((total, clip) => total + clipLength(clip), 0);

export function clipStarts(clips: Clip[]): number[] {
  const starts: number[] = [];
  let start = 0;
  for (const clip of clips) {
    starts.push(start);
    start += clipLength(clip);
  }
  return starts;
}

export function makeRange(a: number, b: number): TimeRange | null {
  if (Math.abs(a - b) < EPSILON) return null;
  return { start: Math.min(a, b), end: Math.max(a, b) };
}

export function clipFromMedia(media: MediaFile): Clip {
  return { id: crypto.randomUUID(), mediaId: media.id, in: 0, out: media.duration };
}

/** Returns the same array when `time` isn't strictly inside a clip. */
export function splitAt(clips: Clip[], time: number, fps: number): Clip[] {
  let start = 0;
  for (let index = 0; index < clips.length; index++) {
    const clip = clips[index];
    const end = start + clipLength(clip);
    if (time > start + EPSILON && time < end - EPSILON) {
      const cut = snapToFrame(clip.in + time - start, fps);
      if (cut <= clip.in + EPSILON || cut >= clip.out - EPSILON) return clips;
      const left = { ...clip, out: cut };
      const right = { ...clip, id: crypto.randomUUID(), in: cut };
      return [...clips.slice(0, index), left, right, ...clips.slice(index + 1)];
    }
    start = end;
  }
  return clips;
}

/**
 * Splits at both ends of the range and returns which clips now fill it, as `first` up to but not
 * including `end`. Cuts snap to the frames of the media being cut, which needn't line up with the
 * timeline's own time once rendered clips have shifted things, so the range's edges are taken
 * from wherever the cuts really landed rather than compared against the times asked for.
 */
function isolateRange(clips: Clip[], range: TimeRange, fps: number) {
  const split = splitAt(splitAt(clips, range.start, fps), range.end, fps);
  const first = nearestBoundary(split, range.start);
  const end = Math.max(first, nearestBoundary(split, range.end));
  return { split, first, end };
}

export function deleteRange(clips: Clip[], range: TimeRange, fps: number): Clip[] {
  const { split, first, end } = isolateRange(clips, range, fps);
  return [...split.slice(0, first), ...split.slice(end)];
}

/** Inserts a copy of the range right after itself and reports where the copy landed. */
export function duplicateRange(clips: Clip[], range: TimeRange, fps: number): { timeline: Clip[]; copy: TimeRange } {
  const { split, first, end } = isolateRange(clips, range, fps);
  if (first === end) return { timeline: clips, copy: range };

  const copies = split.slice(first, end).map((clip) => ({ ...clip, id: crypto.randomUUID() }));
  const timeline = [...split.slice(0, end), ...copies, ...split.slice(end)];
  const start = clipStarts(split)[end] ?? timelineDuration(split);
  return { timeline, copy: { start, end: start + timelineDuration(copies) } };
}

function swapRange(clips: Clip[], range: TimeRange, replacement: Clip, fps: number) {
  const { split, first, end } = isolateRange(clips, range, fps);
  const timeline = [...split.slice(0, first), replacement, ...split.slice(end)];
  const start = clipStarts(split)[first] ?? timelineDuration(split);
  return { timeline, range: { start, end: start + clipLength(replacement) } };
}

/** A stretch of one clip, in media time, so it stays findable if the timeline shifts around it. */
export interface ClipTarget {
  clipId: string;
  mediaId: MediaId;
  in: number;
  out: number;
}

/** The pieces of each clip a range covers, in order. */
export function targetsForRange(clips: Clip[], range: TimeRange): ClipTarget[] {
  const starts = clipStarts(clips);
  return clips.flatMap((clip, index) => {
    const from = Math.max(range.start, starts[index]);
    const to = Math.min(range.end, starts[index] + clipLength(clip));
    if (to - from <= EPSILON) return [];
    const offset = clip.in - starts[index];
    return [{ clipId: clip.id, mediaId: clip.mediaId, in: from + offset, out: to + offset }];
  });
}

/** Swaps everything inside a range for one clip. */
export function replaceRange(
  clips: Clip[],
  range: TimeRange,
  replacement: Clip,
  fps: number,
): { timeline: Clip[]; range: TimeRange } {
  return swapRange(clips, range, replacement, fps);
}

/**
 * The word or syllable around a moment: walks outward from it until the sound drops away and
 * stays down. Returns null when the moment itself is silence.
 */
export function wordBounds(peaks: WaveformPeaks, time: number, floor: number, ceiling: number): TimeRange | null {
  const { bucketsPerSecond: rate, min, max } = peaks;
  const level = (bucket: number) => Math.max(max[bucket] ?? 0, -(min[bucket] ?? 0));
  const clicked = Math.round(time * rate);
  const reach = Math.round(WORD_SEARCH_SECONDS * rate);

  let loudest = 0;
  for (let bucket = Math.max(0, clicked - reach); bucket <= clicked + reach; bucket++) {
    loudest = Math.max(loudest, level(bucket));
  }
  const quiet = Math.max(WORD_MIN_LEVEL, loudest * WORD_QUIET_RATIO);
  if (level(clicked) < quiet) return null;

  const walk = (direction: 1 | -1, limit: number) => {
    let bucket = clicked;
    let lastLoud = clicked;
    while (direction > 0 ? bucket < limit : bucket > limit) {
      bucket += direction;
      if (level(bucket) >= quiet) lastLoud = bucket;
      else if (Math.abs(bucket - lastLoud) >= WORD_GAP_BUCKETS) break;
    }
    return lastLoud;
  };

  const start = walk(-1, Math.floor(floor * rate));
  const end = walk(1, Math.ceil(ceiling * rate));
  return { start: Math.max(floor, start / rate), end: Math.min(ceiling, (end + 1) / rate) };
}

/**
 * Swaps the targeted stretch for a new clip: before | new | after. Returns null if nothing on
 * the timeline holds that stretch any more, which happens if it was edited during a render.
 */
export function replaceTarget(
  clips: Clip[],
  target: ClipTarget,
  replacement: Clip,
  fps: number,
): { timeline: Clip[]; range: TimeRange } | null {
  const holds = (clip: Clip) =>
    clip.mediaId === target.mediaId && clip.in <= target.in + EPSILON && clip.out >= target.out - EPSILON;
  const index = clips.findIndex((clip) => clip.id === target.clipId && holds(clip));
  const position = index === -1 ? clips.findIndex(holds) : index;
  if (position === -1) return null;

  const start = clipStarts(clips)[position] + target.in - clips[position].in;
  return swapRange(clips, { start, end: start + target.out - target.in }, replacement, fps);
}

export function insertClips(clips: Clip[], index: number, added: Clip[]): Clip[] {
  return [...clips.slice(0, index), ...added, ...clips.slice(index)];
}

/**
 * Moves a clip to boundary `to`, where boundary N sits just before clip N.
 * Returns the same array when the clip would land where it already is.
 */
export function moveClip(clips: Clip[], from: number, to: number): Clip[] {
  if (to === from || to === from + 1) return clips;
  const without = clips.filter((_clip, index) => index !== from);
  return insertClips(without, to > from ? to - 1 : to, [clips[from]]);
}

export function trimClip(
  clips: Clip[],
  index: number,
  edge: 'start' | 'end',
  delta: number,
  mediaDuration: number,
  fps: number,
): Clip[] {
  const clip = clips[index];
  const frame = 1 / fps;
  const trimmed =
    edge === 'start'
      ? { ...clip, in: snapToFrame(clamp(clip.in + delta, 0, clip.out - frame), fps) }
      : { ...clip, out: snapToFrame(clamp(clip.out + delta, clip.in + frame, mediaDuration), fps) };
  return clips.map((existing, position) => (position === index ? trimmed : existing));
}

/** The clip boundary closest to `time`, as an index usable with insertClips and moveClip. */
export function nearestBoundary(clips: Clip[], time: number): number {
  const boundaries = [...clipStarts(clips), timelineDuration(clips)];
  let best = 0;
  boundaries.forEach((boundary, index) => {
    if (Math.abs(boundary - time) < Math.abs(boundaries[best] - time)) best = index;
  });
  return best;
}

/**
 * Turns clips into what the player actually has to do. Pieces that continue the same media
 * merge into one segment, so a split plays straight through with no video swap at all.
 */
export function buildSegments(clips: Clip[], range?: TimeRange | null): PlaybackSegment[] {
  const segments: PlaybackSegment[] = [];
  let start = 0;
  for (const clip of clips) {
    const end = start + clipLength(clip);
    const from = Math.max(start, range?.start ?? start);
    const to = Math.min(end, range?.end ?? end);
    if (to - from > EPSILON) {
      const segmentIn = clip.in + from - start;
      const segmentOut = clip.in + to - start;
      const last = segments[segments.length - 1];
      if (last && last.mediaId === clip.mediaId && Math.abs(last.out - segmentIn) < EPSILON) {
        last.out = segmentOut;
      } else {
        segments.push({ mediaId: clip.mediaId, in: segmentIn, out: segmentOut, start: from });
      }
    }
    start = end;
  }
  return segments;
}

export function locateSegment(segments: PlaybackSegment[], time: number): number {
  for (let index = segments.length - 1; index > 0; index--) {
    if (time >= segments[index].start - EPSILON) return index;
  }
  return 0;
}
