import { describe, expect, it } from 'vitest';
import { hitTest, RULER_HEIGHT, THUMB_HEIGHT, type View } from '../src/renderer/timeline/hit';
import {
  buildSegments,
  deleteRange,
  duplicateRange,
  locateSegment,
  moveClip,
  nearestBoundary,
  replaceRange,
  replaceTarget,
  splitAt,
  targetsForRange,
  timelineDuration,
  trimClip,
  wordBounds,
} from '../src/renderer/timeline/model';
import type { Clip } from '../src/shared/types';

const fps = 30;
const clip = (id: string, mediaId: string, start: number, end: number): Clip => ({
  id,
  mediaId,
  in: start,
  out: end,
});
const pieces = (clips: Clip[]) => clips.map((c) => [c.mediaId, c.in, c.out]);
const ids = (clips: Clip[]) => clips.map((c) => c.id);

const two = [clip('a', 'A', 0, 3), clip('b', 'B', 1, 3)];

describe('splitAt', () => {
  it('cuts a clip into two pieces that cover the same media', () => {
    const result = splitAt(two, 1, fps);
    expect(pieces(result)).toEqual([
      ['A', 0, 1],
      ['A', 1, 3],
      ['B', 1, 3],
    ]);
    expect(new Set(ids(result)).size).toBe(3);
  });

  it('uses the offset inside the second clip, not the timeline time', () => {
    expect(pieces(splitAt(two, 4, fps))).toEqual([
      ['A', 0, 3],
      ['B', 1, 2],
      ['B', 2, 3],
    ]);
  });

  it('lands on a frame boundary', () => {
    const [left] = splitAt(two, 1.01, fps);
    expect(left.out * fps).toBeCloseTo(Math.round(1.01 * fps));
  });

  it('does nothing at a clip boundary or outside the timeline', () => {
    expect(splitAt(two, 0, fps)).toBe(two);
    expect(splitAt(two, 3, fps)).toBe(two);
    expect(splitAt(two, 99, fps)).toBe(two);
  });
});

describe('deleteRange', () => {
  it('ripples out the middle of a clip', () => {
    expect(pieces(deleteRange(two, { start: 1, end: 2 }, fps))).toEqual([
      ['A', 0, 1],
      ['A', 2, 3],
      ['B', 1, 3],
    ]);
  });

  it('removes a span that crosses a clip boundary', () => {
    expect(pieces(deleteRange(two, { start: 2, end: 4 }, fps))).toEqual([
      ['A', 0, 2],
      ['B', 2, 3],
    ]);
  });

  it('can empty the timeline', () => {
    expect(deleteRange(two, { start: 0, end: 5 }, fps)).toEqual([]);
  });
});

describe('duplicateRange', () => {
  it('puts the copy right after the selection and reports where it went', () => {
    const { timeline, copy } = duplicateRange(two, { start: 1, end: 2 }, fps);
    expect(pieces(timeline)).toEqual([
      ['A', 0, 1],
      ['A', 1, 2],
      ['A', 1, 2],
      ['A', 2, 3],
      ['B', 1, 3],
    ]);
    expect(copy).toEqual({ start: 2, end: 3 });
    expect(new Set(ids(timeline)).size).toBe(timeline.length);
  });

  it('duplicates at the very end of the timeline', () => {
    const { timeline, copy } = duplicateRange(two, { start: 3, end: 5 }, fps);
    expect(timelineDuration(timeline)).toBe(7);
    expect(copy).toEqual({ start: 5, end: 7 });
  });

  it('copies a span that crosses clips in order', () => {
    const { timeline } = duplicateRange(two, { start: 2, end: 4 }, fps);
    expect(pieces(timeline).slice(3, 5)).toEqual([
      ['A', 2, 3],
      ['B', 1, 2],
    ]);
  });
});

describe('targetsForRange', () => {
  it('converts a timeline range into media time', () => {
    expect(targetsForRange(two, { start: 4, end: 4.5 })).toEqual([{ clipId: 'b', mediaId: 'B', in: 2, out: 2.5 }]);
  });

  it('returns a piece of each clip a range crosses, in order', () => {
    expect(targetsForRange(two, { start: 2.5, end: 4.5 })).toEqual([
      { clipId: 'a', mediaId: 'A', in: 2.5, out: 3 },
      { clipId: 'b', mediaId: 'B', in: 1, out: 2.5 },
    ]);
  });

  it('finds nothing in empty space', () => {
    expect(targetsForRange(two, { start: 10, end: 11 })).toEqual([]);
  });
});

describe('replaceRange', () => {
  it('swaps a span across clips for one new clip', () => {
    const result = replaceRange(two, { start: 2, end: 4 }, clip('new', 'R', 0, 5), fps);
    expect(pieces(result.timeline)).toEqual([
      ['A', 0, 2],
      ['R', 0, 5],
      ['B', 2, 3],
    ]);
    expect(result.range).toEqual({ start: 2, end: 7 });
  });
});

describe('wordBounds', () => {
  // Two words with a gap between: loud from 0.5 to 1.0 and from 1.3 to 2.0, quiet elsewhere.
  const levels = Array.from({ length: 300 }, (_, bucket) => {
    const time = bucket / 100;
    return (time >= 0.5 && time < 1) || (time >= 1.3 && time < 2) ? 0.8 : 0.02;
  });
  const peaks = { bucketsPerSecond: 100, max: levels, min: levels.map((value) => -value) };

  it('finds the word around a click', () => {
    const word = wordBounds(peaks, 0.7, 0, 3)!;
    expect(word.start).toBeCloseTo(0.5, 1);
    expect(word.end).toBeCloseTo(1, 1);
  });

  it('picks the right word of two', () => {
    const word = wordBounds(peaks, 1.6, 0, 3)!;
    expect(word.start).toBeCloseTo(1.3, 1);
    expect(word.end).toBeCloseTo(2, 1);
  });

  it('stops at the clip it was clicked in', () => {
    expect(wordBounds(peaks, 0.7, 0.6, 0.9)).toEqual({ start: 0.6, end: 0.9 });
  });

  it('finds nothing in silence', () => {
    expect(wordBounds(peaks, 1.15, 0, 3)).toBeNull();
  });

  it('survives a small dip inside a word', () => {
    const dipped = [...levels];
    dipped[70] = 0.02;
    const word = wordBounds({ ...peaks, max: dipped, min: dipped.map((value) => -value) }, 0.6, 0, 3)!;
    expect(word.end).toBeCloseTo(1, 1);
  });
});

describe('replaceTarget', () => {
  const longer = clip('new', 'R', 0, 2);
  const target = { clipId: 'a', mediaId: 'A', in: 1, out: 1.5 };

  it('splits into before, new, and after, taking the rendered length', () => {
    const result = replaceTarget(two, target, longer, fps)!;
    expect(pieces(result.timeline)).toEqual([
      ['A', 0, 1],
      ['R', 0, 2],
      ['A', 1.5, 3],
      ['B', 1, 3],
    ]);
    expect(result.range).toEqual({ start: 1, end: 3 });
  });

  it('replaces a whole clip with no empty pieces left behind', () => {
    const result = replaceTarget(two, { clipId: 'a', mediaId: 'A', in: 0, out: 3 }, longer, fps)!;
    expect(pieces(result.timeline)).toEqual([
      ['R', 0, 2],
      ['B', 1, 3],
    ]);
  });

  it('still finds the target after the timeline moved around it', () => {
    const moved = moveClip(splitAt(two, 0.5, fps), 2, 0);
    const result = replaceTarget(moved, target, longer, fps)!;
    expect(pieces(result.timeline).map(([id]) => id)).toEqual(['B', 'A', 'A', 'R', 'A']);
  });

  it('gives up when the media is gone', () => {
    expect(replaceTarget([clip('b', 'B', 1, 3)], target, longer, fps)).toBeNull();
  });
});

describe('after a rendered clip knocks the timeline off the frame grid', () => {
  // 1.017 s isn't a whole number of frames, so cuts in the next clip snap away from the time asked for.
  const offGrid = [clip('rendered', 'R', 0, 1.017), clip('b', 'B', 0, 6)];
  const length = timelineDuration(offGrid);
  const cases = Array.from({ length: 40 }, (_, index) => {
    const start = 1.1 + index * 0.0931;
    return { start, end: start + 0.21 };
  });

  it.each(cases)('replacing $start keeps everything else exactly once', (range) => {
    const [target] = targetsForRange(offGrid, range);
    const result = replaceTarget(offGrid, target, clip('new', 'N', 0, 1), fps)!;
    expect(result.timeline.filter((piece) => piece.id === 'rendered')).toHaveLength(1);
    expect(result.timeline.filter((piece) => piece.mediaId === 'N')).toHaveLength(1);
    // Cuts move by at most half a frame at each end, so the length can't stray further than that.
    expect(Math.abs(timelineDuration(result.timeline) - (length - 0.21 + 1))).toBeLessThan(1 / fps);
  });

  it.each(cases)('deleting $start removes that stretch and nothing else', (range) => {
    const result = deleteRange(offGrid, range, fps);
    expect(result.filter((piece) => piece.id === 'rendered')).toHaveLength(1);
    expect(Math.abs(timelineDuration(result) - (length - 0.21))).toBeLessThan(1 / fps);
  });

  it.each(cases)('duplicating $start copies that stretch and nothing else', (range) => {
    const { timeline, copy } = duplicateRange(offGrid, range, fps);
    expect(timeline.filter((piece) => piece.mediaId === 'R')).toHaveLength(1);
    expect(Math.abs(timelineDuration(timeline) - (length + 0.21))).toBeLessThan(1 / fps);
    expect(Math.abs(copy.end - copy.start - 0.21)).toBeLessThan(1 / fps);
  });
});

describe('moveClip', () => {
  const three = [clip('a', 'A', 0, 1), clip('b', 'B', 0, 1), clip('c', 'C', 0, 1)];

  it('moves a clip forwards and backwards', () => {
    expect(ids(moveClip(three, 0, 3))).toEqual(['b', 'c', 'a']);
    expect(ids(moveClip(three, 2, 0))).toEqual(['c', 'a', 'b']);
    expect(ids(moveClip(three, 0, 2))).toEqual(['b', 'a', 'c']);
  });

  it('treats the boundaries on either side of a clip as no move', () => {
    expect(moveClip(three, 1, 1)).toBe(three);
    expect(moveClip(three, 1, 2)).toBe(three);
  });
});

describe('trimClip', () => {
  it('trims either edge', () => {
    expect(pieces(trimClip(two, 1, 'start', 0.5, 10, fps))[1]).toEqual(['B', 1.5, 3]);
    expect(pieces(trimClip(two, 1, 'end', -0.5, 10, fps))[1]).toEqual(['B', 1, 2.5]);
  });

  it('can reveal media that was trimmed away, but not more than exists', () => {
    expect(pieces(trimClip(two, 1, 'start', -5, 10, fps))[1]).toEqual(['B', 0, 3]);
    expect(pieces(trimClip(two, 1, 'end', 50, 4, fps))[1]).toEqual(['B', 1, 4]);
  });

  it('always leaves at least one frame', () => {
    const [first] = trimClip(two, 0, 'end', -50, 10, fps);
    expect((first.out - first.in) * fps).toBeCloseTo(1);
  });
});

describe('nearestBoundary', () => {
  it('picks the closest edge', () => {
    expect(nearestBoundary(two, 0.4)).toBe(0);
    expect(nearestBoundary(two, 2.9)).toBe(1);
    expect(nearestBoundary(two, 100)).toBe(2);
  });
});

describe('buildSegments', () => {
  it('merges pieces that continue the same media', () => {
    expect(buildSegments(splitAt(splitAt(two, 1, fps), 2, fps))).toEqual([
      { mediaId: 'A', in: 0, out: 3, start: 0 },
      { mediaId: 'B', in: 1, out: 3, start: 3 },
    ]);
  });

  it('keeps pieces apart once they no longer continue each other', () => {
    const swapped = moveClip(splitAt(two, 1, fps), 1, 0);
    expect(buildSegments(swapped)).toEqual([
      { mediaId: 'A', in: 1, out: 3, start: 0 },
      { mediaId: 'A', in: 0, out: 1, start: 2 },
      { mediaId: 'B', in: 1, out: 3, start: 3 },
    ]);
  });

  it('crops to a loop range across clips', () => {
    expect(buildSegments(two, { start: 2, end: 4 })).toEqual([
      { mediaId: 'A', in: 2, out: 3, start: 2 },
      { mediaId: 'B', in: 1, out: 2, start: 3 },
    ]);
  });

  it('finds the segment playing at a given time', () => {
    const segments = buildSegments(two);
    expect(locateSegment(segments, 0)).toBe(0);
    expect(locateSegment(segments, 2.9)).toBe(0);
    expect(locateSegment(segments, 3)).toBe(1);
    expect(locateSegment(segments, 100)).toBe(1);
  });
});

describe('hitTest', () => {
  const view: View = { pxPerSec: 100, scrollX: 0, width: 800, height: 200 };
  const thumbY = RULER_HEIGHT + THUMB_HEIGHT / 2;
  const waveY = RULER_HEIGHT + THUMB_HEIGHT + 10;

  it('sorts the canvas into lanes', () => {
    expect(hitTest(50, 5, view, two)).toEqual({ zone: 'ruler' });
    expect(hitTest(50, waveY, view, two)).toEqual({ zone: 'select' });
    expect(hitTest(50, thumbY, view, two)).toEqual({ zone: 'body', index: 0 });
  });

  it('finds clip edges on the thumbnail lane', () => {
    expect(hitTest(2, thumbY, view, two)).toEqual({ zone: 'edge-start', index: 0 });
    expect(hitTest(298, thumbY, view, two)).toEqual({ zone: 'edge-end', index: 0 });
    expect(hitTest(302, thumbY, view, two)).toEqual({ zone: 'edge-start', index: 1 });
  });

  it('treats the space after the last clip as selectable', () => {
    expect(hitTest(700, thumbY, view, two)).toEqual({ zone: 'select' });
  });

  it('accounts for scrolling', () => {
    expect(hitTest(50, thumbY, { ...view, scrollX: 300 }, two)).toEqual({ zone: 'body', index: 1 });
  });

  it('keeps a tiny clip grabbable in the middle', () => {
    const tiny = [clip('a', 'A', 0, 0.06)];
    expect(hitTest(3, thumbY, view, tiny)).toEqual({ zone: 'body', index: 0 });
  });
});
