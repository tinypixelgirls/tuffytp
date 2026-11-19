import { useEffect, useRef, useState, type DragEvent, type PointerEvent } from 'react';
import { isAnimated, overlayDuration, trimmedOverlay, updateOverlay, type Layer, type OverlayClip } from '../../shared/layers';
import { mediaName } from '../format';
import { mediaForSfx } from '../sfx';
import { importPaths, useStudio } from '../store/project';
import { addMediaToLayer, moveLayer, moveOverlay, removeLayer, updateLayer } from '../timeline/layers';
import { snapToFrame } from '../timeline/model';
import { seekTimeline } from '../timeline/transport';
import { MEDIA_DRAG_TYPE, SFX_DRAG_TYPE } from './MediaBin';

const EDGE_GRAB_PX = 6;
const DRAG_THRESHOLD_PX = 3;

interface LanesProps {
  pxPerSec: number;
  scrollX: number;
  /** The main track's length: layer clips past it are cut off in the export. */
  duration: number;
  onWheel(event: WheelEvent): void;
}

type ClipDrag =
  | { kind: 'move'; clip: OverlayClip; layerId: string; startX: number; moved: boolean }
  | { kind: 'trim'; clip: OverlayClip; edge: 'start' | 'end'; startX: number };

/** What a clip drag would do if it ended now, drawn in place of the real clip. */
interface Draft {
  clip: OverlayClip;
  layerId: string;
}

function clipLabel(clip: OverlayClip): string {
  if (clip.source.kind === 'text') return `T  ${clip.source.style.text.replace(/\s+/g, ' ')}`;
  return mediaName(useStudio.getState().project.media[clip.source.mediaId]);
}

async function droppedMedia(event: DragEvent): Promise<string | null> {
  const mediaId = event.dataTransfer.getData(MEDIA_DRAG_TYPE);
  if (mediaId) return mediaId;
  const sfxPath = event.dataTransfer.getData(SFX_DRAG_TYPE);
  if (sfxPath) return (await mediaForSfx(sfxPath))?.id ?? null;
  const [first] = await importPaths([...event.dataTransfer.files].map((file) => window.ytp.pathForFile(file)));
  return first?.id ?? null;
}

/**
 * The layer tracks above the main track, top layer first. They share the main track's zoom
 * and scroll, so a clip lines up with the footage under it.
 */
export function LayerLanes({ pxPerSec, scrollX, duration, onWheel }: LanesProps) {
  const layers = useStudio((state) => state.project.layers);
  const selected = useStudio((state) => state.overlay);
  const fps = useStudio((state) => state.project.settings.fps);
  const dragRef = useRef<ClipDrag | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const lanesRef = useRef<HTMLDivElement>(null);
  const empty = layers.length === 0;

  // Not a React handler: those are passive, and the wheel mustn't scroll the lanes as well.
  useEffect(() => {
    const lanes = lanesRef.current;
    if (!lanes || empty) return;
    lanes.addEventListener('wheel', onWheel, { passive: false });
    return () => lanes.removeEventListener('wheel', onWheel);
  }, [empty, onWheel]);

  const timeAt = (clientX: number) => {
    const rect = lanesRef.current!.getBoundingClientRect();
    return Math.max(0, (clientX - rect.left + scrollX) / pxPerSec);
  };

  const laneAt = (clientX: number, clientY: number): string | null => {
    const element = document.elementFromPoint(clientX, clientY)?.closest<HTMLElement>('[data-layer-id]');
    return element?.dataset['layerId'] ?? null;
  };

  const onClipDown = (event: PointerEvent<HTMLDivElement>, clip: OverlayClip, layerId: string) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    useStudio.getState().selectOverlay(clip.id);

    const rect = event.currentTarget.getBoundingClientRect();
    const grab = Math.min(EDGE_GRAB_PX, rect.width / 3);
    if (event.clientX < rect.left + grab) dragRef.current = { kind: 'trim', clip, edge: 'start', startX: event.clientX };
    else if (event.clientX > rect.right - grab) dragRef.current = { kind: 'trim', clip, edge: 'end', startX: event.clientX };
    else dragRef.current = { kind: 'move', clip, layerId, startX: event.clientX, moved: false };
  };

  const onClipMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const delta = (event.clientX - drag.startX) / pxPerSec;
    if (drag.kind === 'move') {
      drag.moved ||= Math.abs(event.clientX - drag.startX) > DRAG_THRESHOLD_PX;
      if (!drag.moved) return;
      const layerId = laneAt(event.clientX, event.clientY) ?? drag.layerId;
      setDraft({ clip: { ...drag.clip, start: snapToFrame(Math.max(0, drag.clip.start + delta), fps) }, layerId });
    } else {
      const { project } = useStudio.getState();
      const mediaDuration = drag.clip.source.kind === 'media' ? (project.media[drag.clip.source.mediaId]?.duration ?? 0) : 0;
      const layerId = layers.find((layer) => layer.clips.some((clip) => clip.id === drag.clip.id))?.id ?? '';
      setDraft({ clip: trimmedOverlay(drag.clip, drag.edge, delta, mediaDuration, fps), layerId });
    }
  };

  const onClipUp = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    dragRef.current = null;
    const finished = draft;
    setDraft(null);
    if (!drag) return;
    if (drag.kind === 'move' && !drag.moved) {
      seekTimeline(timeAt(event.clientX));
      return;
    }
    if (!finished) return;
    if (drag.kind === 'move') {
      moveOverlay(drag.clip.id, finished.clip.start, finished.layerId);
    } else {
      const { project, commitLayers } = useStudio.getState();
      commitLayers(updateOverlay(project.layers, drag.clip.id, () => finished.clip), { overlay: drag.clip.id });
    }
  };

  const onLaneDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest('.lane-head')) return;
    useStudio.getState().selectOverlay(null);
    seekTimeline(timeAt(event.clientX));
  };

  const onDrop = async (event: DragEvent, layerId: string | null) => {
    event.preventDefault();
    event.stopPropagation();
    const time = timeAt(event.clientX);
    const mediaId = await droppedMedia(event);
    if (mediaId) addMediaToLayer(mediaId, time, layerId);
  };

  const dragOver = (event: DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
  };

  if (empty) {
    return (
      <div className="layer-lanes empty" ref={lanesRef} onDragOver={dragOver} onDrop={(event) => void onDrop(event, null)}>
        Drop a clip here (or onto the preview) to stack it on a layer above the main track.
      </div>
    );
  }

  const endX = duration * pxPerSec - scrollX;

  return (
    <div className="layer-lanes" ref={lanesRef}>
      {[...layers].reverse().map((layer, row) => (
        <div
          key={layer.id}
          className={layer.hidden ? 'lane hidden' : 'lane'}
          data-layer-id={layer.id}
          onPointerDown={onLaneDown}
          onDragOver={dragOver}
          onDrop={(event) => void onDrop(event, layer.id)}
        >
          {/* The dragged clip stays mounted, dimmed: it holds the pointer capture for the drag. */}
          {layer.clips.map((clip) => (
            <LaneClip
              key={clip.id}
              clip={clip}
              {...{ pxPerSec, scrollX, endX }}
              selected={clip.id === selected}
              dragging={draft?.clip.id === clip.id}
              layerId={layer.id}
              handlers={{ onClipDown, onClipMove, onClipUp }}
            />
          ))}
          {draft?.layerId === layer.id && (
            <LaneClip
              clip={draft.clip}
              {...{ pxPerSec, scrollX, endX }}
              selected
              ghost
              layerId={layer.id}
              handlers={{ onClipDown, onClipMove, onClipUp }}
            />
          )}
          <LaneHead layer={layer} top={row === 0} bottom={row === layers.length - 1} />
        </div>
      ))}
      {endX > 0 && <div className="lanes-end" style={{ left: endX }} title="The main track ends here, and so does the video" />}
      <LanesPlayhead pxPerSec={pxPerSec} scrollX={scrollX} />
    </div>
  );
}

interface LaneClipProps {
  clip: OverlayClip;
  pxPerSec: number;
  scrollX: number;
  endX: number;
  selected: boolean;
  layerId: string;
  /** Where the clip would land: drawn while dragging, and never hit by the pointer. */
  ghost?: boolean;
  /** The clip being dragged, left in place and dimmed. */
  dragging?: boolean;
  handlers: {
    onClipDown(event: PointerEvent<HTMLDivElement>, clip: OverlayClip, layerId: string): void;
    onClipMove(event: PointerEvent<HTMLDivElement>): void;
    onClipUp(event: PointerEvent<HTMLDivElement>): void;
  };
}

function LaneClip({ clip, pxPerSec, scrollX, endX, selected, layerId, ghost, dragging, handlers }: LaneClipProps) {
  const left = clip.start * pxPerSec - scrollX;
  const width = Math.max(2, overlayDuration(clip) * pxPerSec);
  const past = left + width > endX;
  const classes = ['lane-clip', clip.source.kind, selected && 'selected', ghost && 'ghost', dragging && 'dragging', past && 'past-end'];
  const animated = isAnimated(clip);

  return (
    <div
      className={classes.filter(Boolean).join(' ')}
      style={{ left, width }}
      title={`${clipLabel(clip)}${clip.key ? ' · keyed' : ''}${clip.blend !== 'normal' ? ` · ${clip.blend}` : ''}`}
      onPointerDown={(event) => handlers.onClipDown(event, clip, layerId)}
      onPointerMove={handlers.onClipMove}
      onPointerUp={handlers.onClipUp}
      onPointerCancel={handlers.onClipUp}
    >
      <span className="lane-clip-label">
        {clip.key && <b className="lane-badge">KEY</b>}
        {clipLabel(clip)}
      </span>
      {animated &&
        clip.keyframes.map((key) => (
          <i key={key.time} className="lane-key" style={{ left: key.time * pxPerSec }} />
        ))}
    </div>
  );
}

function LaneHead({ layer, top, bottom }: { layer: Layer; top: boolean; bottom: boolean }) {
  const [editing, setEditing] = useState(false);

  return (
    <div className="lane-head" onPointerDown={(event) => event.stopPropagation()}>
      {editing ? (
        <input
          className="lane-name-input"
          autoFocus
          defaultValue={layer.name}
          onBlur={(event) => {
            setEditing(false);
            const name = event.target.value.trim();
            if (name && name !== layer.name) updateLayer(layer.id, { name });
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === 'Escape') event.currentTarget.blur();
          }}
        />
      ) : (
        <span className="lane-name" title="Double-click to rename" onDoubleClick={() => setEditing(true)}>
          {layer.name}
        </span>
      )}
      <button
        className={layer.hidden ? 'lane-button off' : 'lane-button'}
        title={layer.hidden ? 'Show layer' : 'Hide layer'}
        onClick={() => updateLayer(layer.id, { hidden: !layer.hidden })}
      >
        👁
      </button>
      <button
        className={layer.muted ? 'lane-button off' : 'lane-button'}
        title={layer.muted ? 'Unmute layer' : 'Mute layer'}
        onClick={() => updateLayer(layer.id, { muted: !layer.muted })}
      >
        ♪
      </button>
      <button className="lane-button" title="Move layer up (in front)" disabled={top} onClick={() => moveLayer(layer.id, 1)}>
        ▲
      </button>
      <button className="lane-button" title="Move layer down (behind)" disabled={bottom} onClick={() => moveLayer(layer.id, -1)}>
        ▼
      </button>
      <button className="lane-button" title="Delete layer" onClick={() => removeLayer(layer.id)}>
        ×
      </button>
    </div>
  );
}

function LanesPlayhead({ pxPerSec, scrollX }: { pxPerSec: number; scrollX: number }) {
  const playhead = useStudio((state) => state.playhead);
  return <div className="lanes-playhead" style={{ left: Math.round(playhead * pxPerSec - scrollX) }} />;
}
