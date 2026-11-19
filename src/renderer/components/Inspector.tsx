import type { ReactNode } from 'react';
import {
  BLEND_MODES,
  clamp,
  editTransform,
  GREEN_SCREEN,
  isAnimated,
  keyframeAt,
  overlayDuration,
  setEasing,
  sortKeyframes,
  transformAt,
  type BlendMode,
  type Easing,
  type OverlayClip,
  type TextFont,
  type TextStyle,
  type Transform,
} from '../../shared/layers';
import { fileName } from '../format';
import { useStudio } from '../store/project';
import {
  deleteSelectedOverlay,
  duplicateSelectedOverlay,
  keyframeNeighbour,
  splitSelectedOverlay,
  toggleKeyframeAtPlayhead,
  updateSelected,
} from '../timeline/layers';
import { snapToFrame } from '../timeline/model';
import { seekTimeline } from '../timeline/transport';

interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  /** Shown next to the slider. Defaults to the value with two decimals. */
  format?: (value: number) => string;
  onChange(value: number): void;
}

function Slider({ label, value, min, max, step, format, onChange }: SliderProps) {
  return (
    <label className="param inspector-slider">
      <span>
        {label}
        <output>{format ? format(value) : value.toFixed(2)}</output>
      </span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} />
    </label>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="inspector-section">
      <h3>{title}</h3>
      {children}
    </div>
  );
}

const percent = (value: number) => `${Math.round(value * 100)}%`;
const seconds = (value: number) => `${value.toFixed(2)}s`;

/** Settings for the selected layer clip: where it sits, how it animates, keys and blends. */
export function Inspector() {
  const clip = useStudio((state) => {
    if (!state.overlay) return null;
    for (const layer of state.project.layers) {
      const found = layer.clips.find((candidate) => candidate.id === state.overlay);
      if (found) return found;
    }
    return null;
  });
  const playhead = useStudio((state) => state.playhead);
  const fps = useStudio((state) => state.project.settings.fps);
  const media = useStudio((state) => (clip?.source.kind === 'media' ? state.project.media[clip.source.mediaId] : null));
  if (!clip) return null;

  const duration = overlayDuration(clip);
  const rawLocal = playhead - clip.start;
  const inside = rawLocal >= -1e-3 && rawLocal <= duration + 1e-3;
  const local = snapToFrame(clamp(rawLocal, 0, duration), fps);
  const transform = transformAt(clip.keyframes, local);
  const animated = isAnimated(clip);
  const onKey = animated && keyframeAt(clip, local) !== -1;
  const leaving = sortKeyframes(clip.keyframes).findLast((key) => key.time <= local + 1e-3) ?? clip.keyframes[0];

  const move = (change: Partial<Transform>, coalesce: string) =>
    updateSelected((current) => editTransform(current, local, change), coalesce);
  const set = (change: Partial<OverlayClip>, coalesce?: string) => updateSelected((current) => ({ ...current, ...change }), coalesce);
  const setText = (change: Partial<TextStyle>, coalesce?: string) =>
    updateSelected(
      (current) => (current.source.kind === 'text' ? { ...current, source: { ...current.source, style: { ...current.source.style, ...change } } } : current),
      coalesce,
    );

  const jump = (direction: 1 | -1) => {
    const time = keyframeNeighbour(direction);
    if (time !== null) seekTimeline(time);
  };

  const name =
    clip.source.kind === 'text'
      ? 'Text'
      : media?.origin.kind === 'import'
        ? fileName(media.origin.sourcePath)
        : `${media?.origin.kind === 'effect' ? media.origin.effectId : 'Clip'} render`;

  return (
    <div className="inspector">
      <div className="inspector-head">
        <h3>Layer clip</h3>
        <span className="inspector-name" title={name}>
          {name}
        </span>
        <button className="icon-button" aria-label="Deselect" title="Deselect (Esc)" onClick={() => useStudio.getState().selectOverlay(null)}>
          ×
        </button>
      </div>

      {!inside && (
        <p className="inspector-note">
          The playhead isn't over this clip.{' '}
          <button className="link-button" onClick={() => seekTimeline(clip.start)}>
            Jump to it
          </button>
        </p>
      )}

      {clip.source.kind === 'text' && (
        <Section title="Text">
          <textarea
            className="inspector-text"
            rows={2}
            value={clip.source.style.text}
            onChange={(event) => setText({ text: event.target.value }, 'text')}
          />
          <div className="inspector-row">
            <select value={clip.source.style.font} onChange={(event) => setText({ font: event.target.value as TextFont })}>
              <option value="impact">Impact</option>
              <option value="sans">Bold sans</option>
            </select>
            <input type="color" title="Text colour" value={clip.source.style.color} onChange={(event) => setText({ color: event.target.value }, 'color')} />
            <input type="color" title="Outline colour" value={clip.source.style.outline} onChange={(event) => setText({ outline: event.target.value }, 'outline')} />
          </div>
          <Slider label="Size" value={clip.source.style.size} min={0.03} max={0.5} step={0.005} format={percent} onChange={(size) => setText({ size }, 'size')} />
          <Slider
            label="Outline"
            value={clip.source.style.outlineWidth}
            min={0}
            max={0.25}
            step={0.005}
            format={percent}
            onChange={(outlineWidth) => setText({ outlineWidth }, 'outlineWidth')}
          />
        </Section>
      )}

      <Section title={animated ? `Motion · ${clip.keyframes.length} keyframe${clip.keyframes.length === 1 ? '' : 's'}` : 'Position'}>
        <div className="inspector-row">
          <button className="tool" title="Previous keyframe" disabled={!animated} onClick={() => jump(-1)}>
            ◀
          </button>
          <button
            className={onKey ? 'tool active' : 'tool'}
            title="Add or remove a keyframe at the playhead (K). With keyframes on, moving the clip at another time adds one there."
            disabled={!inside}
            onClick={toggleKeyframeAtPlayhead}
          >
            ◆ {onKey ? 'Remove key' : 'Keyframe'}
          </button>
          <button className="tool" title="Next keyframe" disabled={!animated} onClick={() => jump(1)}>
            ▶
          </button>
          {animated && (
            <select
              title="How it moves on from this keyframe"
              value={leaving.easing}
              onChange={(event) => updateSelected((current) => setEasing(current, local, event.target.value as Easing))}
            >
              <option value="linear">Linear</option>
              <option value="ease">Smooth</option>
              <option value="hold">Hold (snap)</option>
            </select>
          )}
        </div>
        <Slider label="X" value={transform.x} min={-0.5} max={1.5} step={0.001} format={percent} onChange={(x) => move({ x }, 'x')} />
        <Slider label="Y" value={transform.y} min={-0.5} max={1.5} step={0.001} format={percent} onChange={(y) => move({ y }, 'y')} />
        <Slider label="Scale" value={transform.scale} min={0.02} max={4} step={0.01} format={percent} onChange={(scale) => move({ scale }, 'scale')} />
        <Slider
          label="Rotation"
          value={transform.rotation}
          min={-360}
          max={360}
          step={1}
          format={(value) => `${Math.round(value)}°`}
          onChange={(rotation) => move({ rotation }, 'rotation')}
        />
        <div className="inspector-row">
          <button className="tool" title="Fill the whole frame" onClick={() => move({ x: 0.5, y: 0.5, scale: 1, rotation: 0 }, 'reset')}>
            Full frame
          </button>
          <button className="tool" title="Centre it" onClick={() => move({ x: 0.5, y: 0.5 }, 'centre')}>
            Centre
          </button>
        </div>
        <p className="inspector-hint">Drag it on the preview to move it. Wheel scales, Shift+wheel turns.</p>
      </Section>

      <Section title="Look">
        <Slider label="Opacity" value={clip.opacity} min={0} max={1} step={0.01} format={percent} onChange={(opacity) => set({ opacity }, 'opacity')} />
        <label className="param">
          Blend
          <select value={clip.blend} onChange={(event) => set({ blend: event.target.value as BlendMode })}>
            {BLEND_MODES.map(({ id, label }) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <Slider label="Fade in" value={clip.fadeIn} min={0} max={Math.min(5, duration)} step={0.05} format={seconds} onChange={(fadeIn) => set({ fadeIn }, 'fadeIn')} />
        <Slider label="Fade out" value={clip.fadeOut} min={0} max={Math.min(5, duration)} step={0.05} format={seconds} onChange={(fadeOut) => set({ fadeOut }, 'fadeOut')} />
      </Section>

      {clip.source.kind === 'media' && (
        <Section title="Green screen">
          <label className="param inspector-check">
            <input type="checkbox" checked={clip.key !== null} onChange={(event) => set({ key: event.target.checked ? GREEN_SCREEN : null })} />
            Key out a colour
          </label>
          {clip.key && (
            <>
              <div className="inspector-row">
                <input
                  type="color"
                  title="Colour to remove"
                  value={clip.key.color}
                  onChange={(event) => set({ key: { ...clip.key!, color: event.target.value } }, 'keyColor')}
                />
                <button className="tool" title="Click the preview to pick the colour" onClick={() => useStudio.setState({ pickingKey: true })}>
                  Pick from preview
                </button>
                <button className="tool" title="Pure green" onClick={() => set({ key: { ...clip.key!, color: '#00ff00' } })}>
                  Green
                </button>
                <button className="tool" title="Pure blue" onClick={() => set({ key: { ...clip.key!, color: '#0000ff' } })}>
                  Blue
                </button>
              </div>
              <Slider
                label="Strength"
                value={clip.key.similarity}
                min={0.01}
                max={0.8}
                step={0.01}
                onChange={(similarity) => set({ key: { ...clip.key!, similarity } }, 'keySimilarity')}
              />
              <Slider label="Softness" value={clip.key.blend} min={0} max={0.5} step={0.01} onChange={(blend) => set({ key: { ...clip.key!, blend } }, 'keyBlend')} />
            </>
          )}
        </Section>
      )}

      {clip.source.kind === 'media' && (
        <Section title="Sound">
          <Slider label="Volume" value={clip.volume} min={0} max={2} step={0.01} format={percent} onChange={(volume) => set({ volume }, 'volume')} />
        </Section>
      )}

      <div className="inspector-row">
        <button className="tool" title="Copy it right after itself (Ctrl+D)" onClick={duplicateSelectedOverlay}>
          Duplicate
        </button>
        <button className="tool" title="Cut it at the playhead (S)" disabled={!inside} onClick={splitSelectedOverlay}>
          Split
        </button>
        <button className="tool" title="Delete it (Delete)" onClick={deleteSelectedOverlay}>
          Delete
        </button>
      </div>
      {clip.source.kind === 'media' && <p className="inspector-hint">Effect buttons now hit this clip instead of the main track.</p>}
    </div>
  );
}
