import type { Clip, MediaFile, MediaId } from '../../shared/types';
import { formatTimecode } from '../format';
import { getPeaks, getSprite } from './assets';
import { RULER_HEIGHT, THUMB_HEIGHT, timeToX, type View } from './hit';
import { clipLength, type TimeRange } from './model';

const COLORS = {
  background: '#181327',
  ruler: '#2e2547',
  rulerText: '#a99fc4',
  tick: '#6b5c94',
  clipFill: ['#2c2447', '#332a52'],
  clipEdge: '#000',
  wave: '#22e3ff',
  selection: 'rgba(255, 230, 0, 0.24)',
  selectionEdge: '#ffe600',
  labelText: '#000',
  playhead: '#ff2e93',
  ghost: 'rgba(255, 255, 255, 0.28)',
};

const RULER_STEPS = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600];
const MIN_LABEL_SPACING = 72;
const MINOR_TICKS = 5;

export interface OverlayState {
  selection: TimeRange | null;
  playhead: number;
  fps: number;
  /** A clip being dragged, drawn following the pointer. */
  ghost: { x: number; width: number } | null;
  /** Timeline time where a dragged clip would land. */
  dropAt: number | null;
}

function drawRuler(ctx: CanvasRenderingContext2D, view: View, fps: number) {
  ctx.fillStyle = COLORS.ruler;
  ctx.fillRect(0, 0, view.width, RULER_HEIGHT);

  const step = RULER_STEPS.find((s) => s * view.pxPerSec >= MIN_LABEL_SPACING) ?? RULER_STEPS[RULER_STEPS.length - 1];
  const minorPx = (step * view.pxPerSec) / MINOR_TICKS;

  ctx.font = '11px Consolas, monospace';
  ctx.textBaseline = 'middle';
  const firstMajor = Math.floor(view.scrollX / view.pxPerSec / step);
  const lastMajor = Math.ceil((view.scrollX + view.width) / view.pxPerSec / step);
  for (let major = firstMajor; major <= lastMajor; major++) {
    const time = major * step;
    const x = timeToX(time, view);
    ctx.fillStyle = COLORS.tick;
    ctx.fillRect(Math.round(x), RULER_HEIGHT - 10, 1, 10);
    for (let minor = 1; minor < MINOR_TICKS; minor++) {
      ctx.fillRect(Math.round(x + minor * minorPx), RULER_HEIGHT - 4, 1, 4);
    }
    ctx.fillStyle = COLORS.rulerText;
    ctx.fillText(formatTimecode(time, fps), x + 4, 8);
  }
}

function drawThumbs(ctx: CanvasRenderingContext2D, view: View, clip: Clip, media: MediaFile, x: number) {
  const grid = media.thumbGrid;
  const sprite = getSprite(media.id);
  if (!grid || !sprite) return;

  const width = clipLength(clip) * view.pxPerSec;
  const tileWidth = (THUMB_HEIGHT * grid.tileWidth) / grid.tileHeight;
  const tiles = grid.cols * grid.rows;

  const firstTile = Math.max(0, Math.floor(-x / tileWidth));
  for (let tile = firstTile; tile * tileWidth < width && x + tile * tileWidth < view.width; tile++) {
    const time = clip.in + (tile * tileWidth) / view.pxPerSec;
    const source = Math.min(tiles - 1, Math.floor(time / grid.interval));
    ctx.drawImage(
      sprite,
      (source % grid.cols) * grid.tileWidth,
      Math.floor(source / grid.cols) * grid.tileHeight,
      grid.tileWidth,
      grid.tileHeight,
      x + tile * tileWidth,
      RULER_HEIGHT,
      tileWidth,
      THUMB_HEIGHT,
    );
  }
}

function drawWaveform(ctx: CanvasRenderingContext2D, view: View, clip: Clip, x: number) {
  const peaks = getPeaks(clip.mediaId);
  if (!peaks) return;

  const top = RULER_HEIGHT + THUMB_HEIGHT;
  const halfHeight = (view.height - top) / 2;
  const middle = top + halfHeight;
  const buckets = peaks.bucketsPerSecond;

  const left = Math.max(0, Math.floor(x));
  const right = Math.min(view.width, Math.ceil(x + clipLength(clip) * view.pxPerSec));

  ctx.fillStyle = COLORS.wave;
  for (let column = left; column < right; column++) {
    const time = clip.in + (column - x) / view.pxPerSec;
    const first = Math.floor(time * buckets);
    const last = Math.max(first + 1, Math.ceil((time + 1 / view.pxPerSec) * buckets));
    let low = 0;
    let high = 0;
    for (let bucket = first; bucket < last && bucket < peaks.min.length; bucket++) {
      if (peaks.min[bucket] < low) low = peaks.min[bucket];
      if (peaks.max[bucket] > high) high = peaks.max[bucket];
    }
    ctx.fillRect(column, middle - high * halfHeight, 1, Math.max(1, (high - low) * halfHeight));
  }
}

/** The slow layer: ruler and clips. Only redrawn when clips or the view change. */
export function drawBase(
  ctx: CanvasRenderingContext2D,
  view: View,
  clips: Clip[],
  media: Record<MediaId, MediaFile>,
  fps: number,
) {
  ctx.fillStyle = COLORS.background;
  ctx.fillRect(0, 0, view.width, view.height);

  let start = 0;
  clips.forEach((clip, index) => {
    const x = timeToX(start, view);
    const width = clipLength(clip) * view.pxPerSec;
    start += clipLength(clip);
    if (x + width < 0 || x > view.width) return;

    ctx.save();
    ctx.beginPath();
    ctx.rect(x, RULER_HEIGHT, width, view.height - RULER_HEIGHT);
    ctx.clip();
    ctx.fillStyle = COLORS.clipFill[index % COLORS.clipFill.length];
    ctx.fillRect(x, RULER_HEIGHT, width, view.height - RULER_HEIGHT);
    drawThumbs(ctx, view, clip, media[clip.mediaId], x);
    drawWaveform(ctx, view, clip, x);
    ctx.restore();

    ctx.fillStyle = COLORS.clipEdge;
    ctx.fillRect(Math.round(x + width) - 1, RULER_HEIGHT, 2, view.height - RULER_HEIGHT);
  });

  drawRuler(ctx, view, fps);
}

function drawSelection(ctx: CanvasRenderingContext2D, view: View, selection: TimeRange, fps: number) {
  const left = timeToX(selection.start, view);
  const right = timeToX(selection.end, view);
  ctx.fillStyle = COLORS.selection;
  ctx.fillRect(left, 0, right - left, view.height);
  ctx.fillStyle = COLORS.selectionEdge;
  ctx.fillRect(Math.round(left), 0, 1, view.height);
  ctx.fillRect(Math.round(right), 0, 1, view.height);

  const length = selection.end - selection.start;
  const label = `${length.toFixed(2)}s · ${Math.round(length * fps)}f`;
  ctx.font = 'bold 11px Consolas, monospace';
  ctx.textBaseline = 'middle';
  const labelWidth = ctx.measureText(label).width + 8;
  const labelX = Math.min(Math.max(left, 0), view.width - labelWidth);
  const labelY = RULER_HEIGHT + THUMB_HEIGHT;
  ctx.fillRect(labelX, labelY, labelWidth, 15);
  ctx.fillStyle = COLORS.labelText;
  ctx.fillText(label, labelX + 4, labelY + 8);
}

/** The fast layer: playhead, selection, and drag feedback. Redrawn on every playback frame. */
export function drawOverlay(ctx: CanvasRenderingContext2D, view: View, state: OverlayState) {
  ctx.clearRect(0, 0, view.width, view.height);

  if (state.selection) drawSelection(ctx, view, state.selection, state.fps);

  if (state.ghost) {
    ctx.fillStyle = COLORS.ghost;
    ctx.fillRect(state.ghost.x, RULER_HEIGHT, state.ghost.width, THUMB_HEIGHT);
  }

  if (state.dropAt !== null) {
    const x = Math.round(timeToX(state.dropAt, view));
    ctx.fillStyle = COLORS.selectionEdge;
    ctx.fillRect(x - 1, 0, 3, view.height);
  }

  const x = Math.round(timeToX(state.playhead, view));
  ctx.fillStyle = COLORS.playhead;
  ctx.fillRect(x, 0, 1, view.height);
  ctx.beginPath();
  ctx.moveTo(x - 6, 0);
  ctx.lineTo(x + 7, 0);
  ctx.lineTo(x + 0.5, 9);
  ctx.closePath();
  ctx.fill();
}
