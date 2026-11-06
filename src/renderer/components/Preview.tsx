import { useEffect, useRef } from 'react';
import { fileName, formatTimecode } from '../format';
import { useStudio } from '../store/project';
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

export function Preview() {
  const firstRef = useRef<HTMLVideoElement>(null);
  const secondRef = useRef<HTMLVideoElement>(null);
  const hasClips = useStudio((state) => state.project.timeline.length > 0);
  const sourceOrigin = useStudio((state) =>
    state.previewSource ? state.project.media[state.previewSource.mediaId].origin : null,
  );

  useEffect(() => {
    player.attach(firstRef.current!, secondRef.current!);
    return () => player.detach();
  }, []);

  const sourceName = sourceOrigin?.kind === 'import' ? fileName(sourceOrigin.sourcePath) : sourceOrigin?.effectId;

  return (
    <section className="panel preview">
      <div className="stage">
        <video ref={firstRef} onClick={togglePlay} />
        <video ref={secondRef} onClick={togglePlay} />
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
