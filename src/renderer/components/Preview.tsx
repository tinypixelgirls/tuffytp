import { useEffect, useRef, type DragEvent, type PointerEvent, type WheelEvent } from 'react';
import { clamp, editTransform, findOverlay, transformAt, type Transform } from '../../shared/layers';
import { fileName, formatTimecode } from '../format';
import { mediaForSfx } from '../sfx';
import { importPaths, useStudio } from '../store/project';
import { Compositor, compositor, overlayAt } from '../timeline/compositor';
import { addMediaToLayer, updateSelected } from '../timeline/layers';
import { snapToFrame } from '../timeline/model';
import {
  player,
  programDuration,
  seekProgram,
  setVolume,
  stepBy,
  toggleLoop,
  toggleMute,
  togglePlay,
} from '../timeline/transport';
import { MEDIA_DRAG_TYPE, SFX_DRAG_TYPE } from './MediaBin';

const DRAG_THRESHOLD_PX = 3;
const WHEEL_SCALE_SPEED = 0.0015;
const WHEEL_ROTATE_SPEED = 0.05;

type StageDrag =
  | { kind: 'move'; startX: number; startY: number; from: Transform; moved: boolean }
  | { kind: 'empty'; startX: number; startY: number; moved: boolean };

/** Where a pointer is on the frame, in project pixels. The canvas is letterboxed like the video. */
function framePoint(event: { clientX: number; clientY: number }, element: HTMLElement) {
  const { width: W, height: H } = useStudio.getState().project.settings;
  const rect = element.getBoundingClientRect();
  const scale = Math.min(rect.width / W, rect.height / H);
  return {
    x: (event.clientX - rect.left - (rect.width - W * scale) / 2) / scale,
    y: (event.clientY - rect.top - (rect.height - H * scale) / 2) / scale,
    scale,
  };
}

/** Seconds into the selected clip at the playhead, on a frame boundary. */
function selectedLocalTime(clipStart: number): number {
  const { playhead, project } = useStudio.getState();
  return snapToFrame(playhead - clipStart, project.settings.fps);
}

export function Preview() {
  const firstRef = useRef<HTMLVideoElement>(null);
  const secondRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<StageDrag | null>(null);
  const hasClips = useStudio((state) => state.project.timeline.length > 0);
  const compositing = useStudio((state) => Compositor.active(state.project.layers, state.previewSource !== null));
  const picking = useStudio((state) => state.pickingKey);
  const sourceOrigin = useStudio((state) =>
    state.previewSource ? state.project.media[state.previewSource.mediaId].origin : null,
  );

  useEffect(() => {
    player.attach(firstRef.current!, secondRef.current!);
    compositor.attach(canvasRef.current!, [firstRef.current!, secondRef.current!]);
    return () => {
      compositor.detach();
      player.detach();
    };
  }, []);

  const sourceName = sourceOrigin?.kind === 'import' ? fileName(sourceOrigin.sourcePath) : sourceOrigin?.effectId;

  const onPointerDown = (event: PointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0) return;
    const { project, playhead, overlay, selectOverlay, pickingKey } = useStudio.getState();
    const point = framePoint(event, event.currentTarget);

    if (pickingKey) {
      const found = overlay ? findOverlay(project.layers, overlay) : null;
      const color = found && compositor.sampleClip(found.clip, playhead, point, project.settings);
      useStudio.setState({ pickingKey: false });
      if (color) updateSelected((clip) => ({ ...clip, key: { ...(clip.key ?? { similarity: 0.3, blend: 0.1 }), color } }));
      else useStudio.getState().pushToast('info', 'Click on the selected layer clip to pick its key colour.');
      return;
    }

    event.currentTarget.setPointerCapture(event.pointerId);
    const hit = overlayAt(project.layers, playhead, point, project.settings);
    if (!hit) {
      dragRef.current = { kind: 'empty', startX: event.clientX, startY: event.clientY, moved: false };
      return;
    }
    selectOverlay(hit.clip.id);
    const from = transformAt(hit.clip.keyframes, playhead - hit.clip.start);
    dragRef.current = { kind: 'move', startX: event.clientX, startY: event.clientY, from, moved: false };
  };

  const onPointerMove = (event: PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    drag.moved ||= Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > DRAG_THRESHOLD_PX;
    if (drag.kind !== 'move' || !drag.moved) return;

    const { width: W, height: H } = useStudio.getState().project.settings;
    const { scale } = framePoint(event, event.currentTarget);
    const x = drag.from.x + (event.clientX - drag.startX) / scale / W;
    const y = drag.from.y + (event.clientY - drag.startY) / scale / H;
    updateSelected((clip) => editTransform(clip, selectedLocalTime(clip.start), { x, y }), 'drag');
  };

  const onPointerUp = () => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (drag?.kind !== 'empty' || drag.moved) return;
    // A plain click on empty picture lets go of the layer clip first, and plays after that.
    const { overlay, selectOverlay } = useStudio.getState();
    if (overlay) selectOverlay(null);
    else togglePlay();
  };

  /** Wheel scales the selected clip; with Shift held it turns it. */
  const onWheel = (event: WheelEvent<HTMLCanvasElement>) => {
    const { overlay } = useStudio.getState();
    if (!overlay) return;
    updateSelected((clip) => {
      const local = selectedLocalTime(clip.start);
      const now = transformAt(clip.keyframes, local);
      return event.shiftKey
        ? editTransform(clip, local, { rotation: now.rotation + event.deltaY * WHEEL_ROTATE_SPEED })
        : editTransform(clip, local, { scale: clamp(now.scale * Math.exp(-event.deltaY * WHEEL_SCALE_SPEED), 0.02, 20) });
    }, event.shiftKey ? 'rotate' : 'scale');
  };

  /** Dropping media on the picture floats it on a layer right where it landed. */
  const onDrop = async (event: DragEvent) => {
    event.preventDefault();
    const { project, playhead } = useStudio.getState();
    if (project.timeline.length === 0) {
      useStudio.getState().pushToast('info', 'Put something on the main track first: layers go on top of it.');
      return;
    }
    // Measured before anything is awaited, while the event still knows its element.
    const point = framePoint(event, event.currentTarget as HTMLElement);
    const at = {
      x: clamp(point.x / project.settings.width, 0, 1),
      y: clamp(point.y / project.settings.height, 0, 1),
    };
    let mediaId = event.dataTransfer.getData(MEDIA_DRAG_TYPE);
    const sfxPath = event.dataTransfer.getData(SFX_DRAG_TYPE);
    if (!mediaId && sfxPath) mediaId = (await mediaForSfx(sfxPath))?.id ?? '';
    if (!mediaId && event.dataTransfer.files.length > 0) {
      const [first] = await importPaths([...event.dataTransfer.files].map((file) => window.ytp.pathForFile(file)));
      mediaId = first?.id ?? '';
    }
    if (mediaId) addMediaToLayer(mediaId, playhead, null, at);
  };

  return (
    <section className="panel preview">
      <div
        className="stage"
        onDragOver={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
        onDrop={(event) => {
          event.stopPropagation();
          void onDrop(event);
        }}
      >
        <video ref={firstRef} onClick={togglePlay} />
        <video ref={secondRef} onClick={togglePlay} />
        <canvas
          ref={canvasRef}
          className={picking ? 'compositor picking' : 'compositor'}
          hidden={!compositing}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onWheel={onWheel}
        />
        {picking && <div className="stage-banner">Click the colour to key out</div>}
        {!sourceOrigin && !hasClips && <p className="stage-hint">Click a clip in the bin to watch it.</p>}
        {sourceOrigin && (
          <div className="stage-tag">
            <span>Source: {sourceName}</span>
            <button className="tool" onClick={() => useStudio.getState().showTimeline()}>
              Back to timeline
            </button>
          </div>
        )}
      </div>
      <Transport />
    </section>
  );
}

function Volume() {
  const volume = useStudio((state) => state.volume);
  const muted = useStudio((state) => state.muted);

  return (
    <span className="volume">
      <button className="tool" aria-pressed={muted} title="Mute (M)" onClick={toggleMute}>
        {muted ? 'Muted' : 'Vol'}
      </button>
      <input
        type="range"
        aria-label="Volume"
        min={0}
        max={1}
        step={0.01}
        value={muted ? 0 : volume}
        onChange={(event) => setVolume(Number(event.target.value))}
      />
    </span>
  );
}

function Transport() {
  const time = useStudio((state) => (state.previewSource ? state.sourceTime : state.playhead));
  const duration = useStudio(programDuration);
  const playing = useStudio((state) => state.playing);
  const loop = useStudio((state) => state.loop);
  const fps = useStudio((state) => state.project.settings.fps);
  const empty = duration === 0;

  return (
    <>
      <input
        className="scrubber"
        type="range"
        aria-label="Seek"
        min={0}
        max={duration}
        step={1 / fps}
        value={time}
        disabled={empty}
        onChange={(event) => seekProgram(Number(event.target.value))}
      />
      <div className="transport">
        <button
          className="chunky small"
          aria-label="Back one frame"
          title="Back one frame (Left)"
          disabled={empty}
          onClick={() => stepBy(-1 / fps)}
        >
          ◀|
        </button>
        <button className="chunky play" title="Play / pause (Space)" disabled={empty} onClick={togglePlay}>
          {playing ? 'Pause' : 'Play'}
        </button>
        <button
          className="chunky small"
          aria-label="Forward one frame"
          title="Forward one frame (Right)"
          disabled={empty}
          onClick={() => stepBy(1 / fps)}
        >
          |▶
        </button>
        <button
          className={loop ? 'chunky small active' : 'chunky small'}
          title="Loop-play selection (L)"
          disabled={empty}
          onClick={toggleLoop}
        >
          Loop
        </button>
        <Volume />
        <span className="timecode">
          {formatTimecode(time, fps)} / {formatTimecode(duration, fps)}
        </span>
      </div>
    </>
  );
}
