import type { Clip } from '../../shared/types';
import { clipLength } from './model';

export const RULER_HEIGHT = 22;
export const THUMB_HEIGHT = 54;
const EDGE_GRAB_PX = 7;

export interface View {
  pxPerSec: number;
  scrollX: number;
  width: number;
  height: number;
}

export const timeToX = (time: number, view: View) => time * view.pxPerSec - view.scrollX;
export const xToTime = (x: number, view: View) => (x + view.scrollX) / view.pxPerSec;

export type Hit =
  | { zone: 'ruler' }
  | { zone: 'select' }
  | { zone: 'body' | 'edge-start' | 'edge-end'; index: number };

/**
 * The ruler seeks and the thumbnail lane grabs clips. The track is full of clips, so the
 * waveform lane is what stands in for the spec's "empty space" to drag a selection on.
 */
export function hitTest(x: number, y: number, view: View, clips: Clip[]): Hit {
  if (y < RULER_HEIGHT) return { zone: 'ruler' };
  if (y >= RULER_HEIGHT + THUMB_HEIGHT) return { zone: 'select' };

  let start = 0;
  for (let index = 0; index < clips.length; index++) {
    const left = timeToX(start, view);
    const width = clipLength(clips[index]) * view.pxPerSec;
    if (x >= left && x < left + width) {
      const grab = Math.min(EDGE_GRAB_PX, width / 3);
      if (x < left + grab) return { zone: 'edge-start', index };
      if (x >= left + width - grab) return { zone: 'edge-end', index };
      return { zone: 'body', index };
    }
    start += clipLength(clips[index]);
  }
  return { zone: 'select' };
}
