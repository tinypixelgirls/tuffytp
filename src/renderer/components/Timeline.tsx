import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type DragEvent,
  type MouseEvent,
  type PointerEvent,
} from 'react';
import type { Clip } from '../../shared/types';
import { importPaths, useStudio } from '../store/project';
import { assetEvents, getPeaks } from '../timeline/assets';
import {
  deleteSelection,
  duplicateSelection,
  insertMedia,
  markIn,
  markOut,
  moveClipTo,
  selectClip,
  splitAtPlayhead,
} from '../timeline/commands';
import { drawBase, drawOverlay, type OverlayState } from '../timeline/draw';
import { hitTest, timeToX, xToTime, type Hit, type View } from '../timeline/hit';
import {
  clamp,
  clipLength,
  clipStarts,
  makeRange,
  nearestBoundary,
  snapToFrame,
  timelineDuration,
  trimClip,
  wordBounds,
} from '../timeline/model';
import { seekTimeline, toggleLoop } from '../timeline/transport';
import { addLayer, addTextAtPlayhead } from '../timeline/layers';
import { mediaForSfx } from '../sfx';
import { ExportDialog } from './ExportDialog';
import { LayerLanes } from './LayerLanes';
import { MEDIA_DRAG_TYPE, SFX_DRAG_TYPE } from './MediaBin';

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 2000;
const WHEEL_ZOOM_SPEED = 0.002;
const DRAG_THRESHOLD_PX = 3;
const EDGE_SCROLL_PX = 24;
const FOLLOW_MARGIN_PX = 48;
const TAIL_PX = 200;

type Drag =
  | { kind: 'seek' }
  | { kind: 'select'; anchor: number; startX: number; moved: boolean }
  | { kind: 'move'; index: number; grabX: number; startX: number; moved: boolean; x: number }
  | { kind: 'trim'; index: number; edge: 'start' | 'end'; startX: number; original: Clip[] };

const CURSORS: Record<Hit['zone'], string> = {
  ruler: 'col-resize',
  select: 'text',
  body: 'grab',
  'edge-start': 'ew-resize',
  'edge-end': 'ew-resize',
};

export function Timeline() {
  const clipCount = useStudio((state) => state.project.timeline.length);
  const hasSelection = useStudio((state) => state.selection !== null);
  const canUndo = useStudio((state) => state.past.length > 0);
  const canRedo = useStudio((state) => state.future.length > 0);
  const duration = useStudio((state) => timelineDuration(state.project.timeline));
  const loop = useStudio((state) => state.loop);
  const undo = useStudio((state) => state.undo);
  const redo = useStudio((state) => state.redo);

  const wrapRef = useRef<HTMLDivElement>(null);
  const baseRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);

  const [zoom, setZoom] = useState(100);
  const [scrollX, setScrollX] = useState(0);
  const [viewWidth, setViewWidth] = useState(0);
  const [exporting, setExporting] = useState(false);
  const viewRef = useRef<View>({ pxPerSec: zoom, scrollX: 0, width: 0, height: 0 });
  const dragRef = useRef<Drag | null>(null);
  const draftRef = useRef<Clip[] | null>(null);
  const dropAtRef = useRef<number | null>(null);
  const pendingScrollRef = useRef<number | null>(null);
  const frameRef = useRef(0);
  const dirtyBaseRef = useRef(true);

  const visibleClips = () => draftRef.current ?? useStudio.getState().project.timeline;

  const requestDraw = useCallback((base: boolean) => {
    dirtyBaseRef.current ||= base;
    if (frameRef.current) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = 0;
      const view = viewRef.current;
      const baseCtx = baseRef.current?.getContext('2d');
      const overlayCtx = overlayRef.current?.getContext('2d');
      if (!baseCtx || !overlayCtx || view.width === 0) return;

      const state = useStudio.getState();
      const { fps } = state.project.settings;
      if (dirtyBaseRef.current) {
        dirtyBaseRef.current = false;
        drawBase(baseCtx, view, visibleClips(), state.project.media, fps);
      }

      const drag = dragRef.current;
      const moving = drag?.kind === 'move' && drag.moved ? drag : null;
      const overlay: OverlayState = {
        selection: state.selection,
        playhead: state.playhead,
        fps,
        ghost: moving && {
          x: moving.x - moving.grabX,
          width: clipLength(state.project.timeline[moving.index]) * view.pxPerSec,
        },
        dropAt: dropAtRef.current,
      };
      drawOverlay(overlayCtx, view, overlay);
    });
  }, []);

  useEffect(() => {
    assetEvents.onLoaded = () => requestDraw(true);
    return useStudio.subscribe((state, previous) => {
      if (state.project.timeline !== previous.project.timeline) requestDraw(true);
      if (state.playhead !== previous.playhead || state.selection !== previous.selection) requestDraw(false);
      if (state.playing && state.playhead !== previous.playhead && !dragRef.current) {
        followPlayhead(state.playhead);
      }
    });
  }, [requestDraw]);

  useEffect(() => {
    const wrap = wrapRef.current!;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      const ratio = window.devicePixelRatio;
      for (const canvas of [baseRef.current!, overlayRef.current!]) {
        canvas.width = Math.round(width * ratio);
        canvas.height = Math.round(height * ratio);
        canvas.getContext('2d')!.scale(ratio, ratio);
      }
      Object.assign(viewRef.current, { width, height });
      setViewWidth(width);
      requestDraw(true);
    });
    observer.observe(wrap);
    return () => observer.disconnect();
  }, [requestDraw]);

  const spacerWidth = Math.max(viewWidth, duration * zoom + TAIL_PX);

  useLayoutEffect(() => {
    const scroller = scrollerRef.current!;
    if (pendingScrollRef.current !== null) {
      scroller.scrollLeft = pendingScrollRef.current;
      pendingScrollRef.current = null;
    }
    viewRef.current.scrollX = scroller.scrollLeft;
    setScrollX(scroller.scrollLeft);
    requestDraw(true);
  }, [zoom, spacerWidth, requestDraw]);

  const applyZoom = useCallback((pxPerSec: number, anchorX: number) => {
    const view = viewRef.current;
    const next = clamp(pxPerSec, MIN_ZOOM, MAX_ZOOM);
    if (next === view.pxPerSec) return;
    pendingScrollRef.current = Math.max(0, xToTime(anchorX, view) * next - anchorX);
    view.pxPerSec = next;
    setZoom(next);
  }, []);

  /** Resolves to whether it could fit: it can't before the panel has been measured. */
  const fitToView = useCallback(() => {
    const seconds = timelineDuration(useStudio.getState().project.timeline);
    if (seconds === 0 || viewRef.current.width === 0) return false;
    scrollerRef.current!.scrollLeft = 0;
    viewRef.current.scrollX = 0;
    applyZoom((viewRef.current.width - 40) / seconds, 0);
    return true;
  }, [applyZoom]);

  // The first clip gets fitted to the window; after that, the zoom is left alone. A restored
  // project can arrive before the panel has a size, so the fit waits for one.
  const hadClips = useRef(false);
  useEffect(() => {
    if (clipCount === 0) hadClips.current = false;
    else if (!hadClips.current) hadClips.current = fitToView();
  }, [clipCount, viewWidth, fitToView]);

  /** Ctrl+wheel zooms around the pointer; a plain wheel scrolls. The layer lanes share it. */
  const onWheel = useCallback(
    (event: WheelEvent) => {
      event.preventDefault();
      if (event.ctrlKey) {
        const anchorX = event.clientX - wrapRef.current!.getBoundingClientRect().left;
        applyZoom(viewRef.current.pxPerSec * Math.exp(-event.deltaY * WHEEL_ZOOM_SPEED), anchorX);
      } else {
        scrollerRef.current!.scrollLeft += event.deltaY + event.deltaX;
      }
    },
    [applyZoom],
  );

  useEffect(() => {
    const wrap = wrapRef.current!;
    wrap.addEventListener('wheel', onWheel, { passive: false });
    return () => wrap.removeEventListener('wheel', onWheel);
  }, [onWheel]);

  function followPlayhead(time: number) {
    const view = viewRef.current;
    const x = timeToX(time, view);
    if (x > view.width - FOLLOW_MARGIN_PX || x < 0) {
      scrollerRef.current!.scrollLeft = time * view.pxPerSec - FOLLOW_MARGIN_PX;
    }
  }

  const pointerX = (event: { clientX: number }) => event.clientX - wrapRef.current!.getBoundingClientRect().left;

  const timeAtX = (x: number) => {
    const { project } = useStudio.getState();
    const time = snapToFrame(xToTime(x, viewRef.current), project.settings.fps);
    return clamp(time, 0, timelineDuration(project.timeline));
  };

  const onPointerDown = (event: PointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const x = pointerX(event);
    const y = event.clientY - event.currentTarget.getBoundingClientRect().top;
    const hit = hitTest(x, y, viewRef.current, useStudio.getState().project.timeline);

    switch (hit.zone) {
      case 'ruler':
        dragRef.current = { kind: 'seek' };
        seekTimeline(xToTime(x, viewRef.current));
        break;
      case 'select':
        dragRef.current = { kind: 'select', anchor: timeAtX(x), startX: x, moved: false };
        break;
      case 'body': {
        const start = clipStarts(useStudio.getState().project.timeline)[hit.index];
        const grabX = x - timeToX(start, viewRef.current);
        dragRef.current = { kind: 'move', index: hit.index, grabX, startX: x, moved: false, x };
        break;
      }
      default:
        dragRef.current = {
          kind: 'trim',
          index: hit.index,
          edge: hit.zone === 'edge-start' ? 'start' : 'end',
          startX: x,
          original: useStudio.getState().project.timeline,
        };
    }
  };

  const onPointerMove = (event: PointerEvent<HTMLCanvasElement>) => {
    const x = pointerX(event);
    const view = viewRef.current;
    const drag = dragRef.current;
    const { project, setSelection } = useStudio.getState();

    if (!drag) {
      const y = event.clientY - event.currentTarget.getBoundingClientRect().top;
      event.currentTarget.style.cursor = CURSORS[hitTest(x, y, view, project.timeline).zone];
      return;
    }

    if (x < EDGE_SCROLL_PX) scrollerRef.current!.scrollLeft -= EDGE_SCROLL_PX - x;
    else if (x > view.width - EDGE_SCROLL_PX) scrollerRef.current!.scrollLeft += x - (view.width - EDGE_SCROLL_PX);

    switch (drag.kind) {
      case 'seek':
        seekTimeline(xToTime(x, view));
        break;
      case 'select':
        drag.moved ||= Math.abs(x - drag.startX) > DRAG_THRESHOLD_PX;
        if (drag.moved) setSelection(makeRange(drag.anchor, timeAtX(x)));
        break;
      case 'move':
        drag.moved ||= Math.abs(x - drag.startX) > DRAG_THRESHOLD_PX;
        if (drag.moved) {
          drag.x = x;
          const boundary = nearestBoundary(project.timeline, xToTime(x, view));
          const edges = [...clipStarts(project.timeline), timelineDuration(project.timeline)];
          dropAtRef.current = edges[boundary];
          requestDraw(false);
        }
        break;
      case 'trim': {
        const clip = drag.original[drag.index];
        const { duration: mediaDuration } = project.media[clip.mediaId];
        const delta = (x - drag.startX) / view.pxPerSec;
        draftRef.current = trimClip(drag.original, drag.index, drag.edge, delta, mediaDuration, project.settings.fps);
        requestDraw(true);
        break;
      }
    }
  };

  const onPointerUp = (event: PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag) return;
    const x = pointerX(event);
    const { project, setSelection, commit } = useStudio.getState();

    if (drag.kind === 'select' && !drag.moved) {
      setSelection(null);
      useStudio.getState().selectOverlay(null);
      seekTimeline(timeAtX(x));
    } else if (drag.kind === 'select') {
      useStudio.getState().showTimeline();
    } else if (drag.kind === 'move' && !drag.moved) {
      selectClip(drag.index);
      seekTimeline(timeAtX(x));
    } else if (drag.kind === 'move') {
      dropAtRef.current = null;
      moveClipTo(drag.index, nearestBoundary(project.timeline, xToTime(x, viewRef.current)));
    } else if (drag.kind === 'trim' && draftRef.current) {
      const draft = draftRef.current;
      draftRef.current = null;
      commit(draft);
    }
    requestDraw(true);
  };

  /** Double-clicking the waveform grabs the whole word or syllable under the pointer. */
  const onDoubleClick = (event: MouseEvent<HTMLCanvasElement>) => {
    const y = event.clientY - event.currentTarget.getBoundingClientRect().top;
    const x = pointerX(event);
    const view = viewRef.current;
    const { project, setSelection, pushToast } = useStudio.getState();
    if (hitTest(x, y, view, project.timeline).zone !== 'select') return;

    const time = xToTime(x, view);
    const starts = clipStarts(project.timeline);
    const index = starts.findLastIndex((start) => start <= time);
    const clip = project.timeline[index];
    if (!clip || time > starts[index] + clipLength(clip)) return;

    const peaks = getPeaks(clip.mediaId);
    const word = peaks && wordBounds(peaks, clip.in + time - starts[index], clip.in, clip.out);
    if (!word) {
      pushToast('info', 'Nothing to grab there: that spot is silent.');
      return;
    }

    const { fps } = project.settings;
    const offset = starts[index] - clip.in;
    setSelection(makeRange(snapToFrame(word.start + offset, fps), snapToFrame(word.end + offset, fps)));
  };

  const onScroll = () => {
    viewRef.current.scrollX = scrollerRef.current!.scrollLeft;
    setScrollX(scrollerRef.current!.scrollLeft);
    requestDraw(true);
  };

  const onDragOver = (event: DragEvent) => {
    event.preventDefault();
    const { timeline } = useStudio.getState().project;
    const boundary = nearestBoundary(timeline, xToTime(pointerX(event), viewRef.current));
    dropAtRef.current = [...clipStarts(timeline), timelineDuration(timeline)][boundary];
    requestDraw(false);
  };

  const onDragLeave = (event: DragEvent) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    dropAtRef.current = null;
    requestDraw(false);
  };

  const onDrop = async (event: DragEvent) => {
    event.preventDefault();
    dropAtRef.current = null;
    requestDraw(false);

    const { timeline } = useStudio.getState().project;
    const index = nearestBoundary(timeline, xToTime(pointerX(event), viewRef.current));
    const mediaId = event.dataTransfer.getData(MEDIA_DRAG_TYPE);
    if (mediaId) {
      insertMedia([mediaId], index);
      return;
    }
    const sfxPath = event.dataTransfer.getData(SFX_DRAG_TYPE);
    if (sfxPath) {
      const media = await mediaForSfx(sfxPath);
      if (media) insertMedia([media.id], index);
      return;
    }
    const paths = [...event.dataTransfer.files].map((file) => window.ytp.pathForFile(file));
    const imported = await importPaths(paths);
    if (imported.length > 0) insertMedia(imported.map((media) => media.id), index);
  };

  return (
    <section className="panel timeline" onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
      <div className="timeline-tools">
        <h2>Timeline</h2>
        <button className="tool" disabled={clipCount === 0} title="Split at playhead (S)" onClick={splitAtPlayhead}>
          Split
        </button>
        <button className="tool" disabled={!hasSelection} title="Delete selection (Delete)" onClick={deleteSelection}>
          Delete
        </button>
        <button className="tool" disabled={!hasSelection} title="Duplicate selection (Ctrl+D)" onClick={duplicateSelection}>
          Duplicate
        </button>
        <span className="tool-gap" />
        <button className="tool" disabled={clipCount === 0} title="Set selection in at playhead (I)" onClick={markIn}>
          In
        </button>
        <button className="tool" disabled={clipCount === 0} title="Set selection out at playhead (O)" onClick={markOut}>
          Out
        </button>
        <button
          className={loop ? 'tool active' : 'tool'}
          disabled={clipCount === 0}
          title="Loop-play selection (L)"
          onClick={toggleLoop}
        >
          Loop
        </button>
        <span className="tool-gap" />
        <button className="tool" disabled={clipCount === 0} title="Add an empty layer on top" onClick={addLayer}>
          + Layer
        </button>
        <button className="tool" disabled={clipCount === 0} title="Add a text caption at the playhead (T)" onClick={addTextAtPlayhead}>
          + Text
        </button>
        <span className="tool-gap" />
        <button className="tool" disabled={!canUndo} title="Undo (Ctrl+Z)" onClick={undo}>
          Undo
        </button>
        <button className="tool" disabled={!canRedo} title="Redo (Ctrl+Shift+Z)" onClick={redo}>
          Redo
        </button>
        <span className="zoom">
          <button className="tool" disabled={clipCount === 0} title="Fit the whole timeline" onClick={() => fitToView()}>
            Fit
          </button>
          <input
            type="range"
            aria-label="Zoom"
            title="Zoom (Ctrl+wheel)"
            min={Math.log(MIN_ZOOM)}
            max={Math.log(MAX_ZOOM)}
            step={0.01}
            value={Math.log(zoom)}
            onChange={(event) => applyZoom(Math.exp(Number(event.target.value)), viewRef.current.width / 2)}
          />
          <button className="chunky small" disabled={clipCount === 0} onClick={() => setExporting(true)}>
            Export
          </button>
        </span>
      </div>
      <LayerLanes pxPerSec={zoom} scrollX={scrollX} duration={duration} onWheel={onWheel} />
      <div className="timeline-canvas" ref={wrapRef}>
        <canvas ref={baseRef} />
        <canvas
          ref={overlayRef}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onDoubleClick={onDoubleClick}
        />
        {clipCount === 0 && (
          <p className="timeline-hint">Drag a clip here from the bin, or press + on it.</p>
        )}
      </div>
      <div className="timeline-scroller" ref={scrollerRef} onScroll={onScroll}>
        <div style={{ width: spacerWidth, height: 1 }} />
      </div>
      {exporting && <ExportDialog onClose={() => setExporting(false)} />}
    </section>
  );
}
