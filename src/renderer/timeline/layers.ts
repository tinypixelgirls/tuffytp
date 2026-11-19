import {
  addKeyframe,
  findOverlay,
  isAnimated,
  keyframeAt,
  mediaOverlay,
  newLayer,
  overlayDuration,
  overlayEnd,
  placeOverlay,
  removeKeyframe,
  removeOverlay,
  shiftKeyframes,
  textOverlay,
  updateOverlay,
  type Layer,
  type OverlayClip,
} from '../../shared/layers';
import type { MediaId } from '../../shared/types';
import { useStudio } from '../store/project';
import { snapToFrame } from './model';

/** Layer edits act on the timeline too, so they bring it back into the preview first. */
function editState() {
  useStudio.getState().showTimeline();
  return useStudio.getState();
}

export function selectedOverlay(): { layer: Layer; clip: OverlayClip } | null {
  const { project, overlay } = useStudio.getState();
  return overlay ? findOverlay(project.layers, overlay) : null;
}

/** Seconds into the selected clip that the playhead sits at, or null when it's outside the clip. */
export function timeInSelected(): number | null {
  const found = selectedOverlay();
  if (!found) return null;
  const local = useStudio.getState().playhead - found.clip.start;
  return local >= 0 && local <= overlayDuration(found.clip) ? local : null;
}

export function addLayer(): void {
  const { project, commitLayers } = editState();
  commitLayers([...project.layers, newLayer(project.layers)]);
}

export function removeLayer(layerId: string): void {
  const { project, overlay, commitLayers } = editState();
  const layer = project.layers.find((candidate) => candidate.id === layerId);
  const keepsSelection = !layer?.clips.some((clip) => clip.id === overlay);
  commitLayers(
    project.layers.filter((candidate) => candidate.id !== layerId),
    keepsSelection ? {} : { overlay: null },
  );
}

export function updateLayer(layerId: string, change: Partial<Pick<Layer, 'hidden' | 'muted' | 'name'>>): void {
  const { project, commitLayers } = editState();
  commitLayers(project.layers.map((layer) => (layer.id === layerId ? { ...layer, ...change } : layer)));
}

/** Moves a layer up (towards the front) or down the stack. */
export function moveLayer(layerId: string, direction: 1 | -1): void {
  const { project, commitLayers } = editState();
  const from = project.layers.findIndex((layer) => layer.id === layerId);
  const to = from + direction;
  if (from === -1 || to < 0 || to >= project.layers.length) return;
  const layers = [...project.layers];
  [layers[from], layers[to]] = [layers[to], layers[from]];
  commitLayers(layers);
}

/** The highest layer with room for a clip over that stretch, adding a new layer on top if none has. */
function roomyLayer(layers: Layer[], start: number, seconds: number): { layers: Layer[]; layerId: string } {
  const free = [...layers]
    .reverse()
    .find((layer) => layer.clips.every((clip) => overlayEnd(clip) <= start + 1e-3 || clip.start >= start + seconds - 1e-3));
  if (free) return { layers, layerId: free.id };
  const added = newLayer(layers);
  return { layers: [...layers, added], layerId: added.id };
}

function place(clip: OverlayClip, layerId: string | null): void {
  const { project, commitLayers } = editState();
  const target = layerId ? { layers: project.layers, layerId } : roomyLayer(project.layers, clip.start, overlayDuration(clip));
  commitLayers(placeOverlay(target.layers, target.layerId, clip), { overlay: clip.id });
}

/**
 * Puts media on a layer at `start`, or on the first layer with room when no layer is given.
 * `at` centres it on a spot in the frame, given as fractions of the width and height.
 */
export function addMediaToLayer(
  mediaId: MediaId,
  start: number,
  layerId: string | null = null,
  at?: { x: number; y: number },
): void {
  const { project } = useStudio.getState();
  const media = project.media[mediaId];
  if (!media) return;
  const clip = mediaOverlay(mediaId, media.duration, snapToFrame(Math.max(0, start), project.settings.fps));
  place(at ? { ...clip, keyframes: [{ ...clip.keyframes[0], ...at }] } : clip, layerId);
}

export function addTextAtPlayhead(): void {
  const { playhead, project } = useStudio.getState();
  place(textOverlay(snapToFrame(playhead, project.settings.fps)), null);
}

/**
 * Edits the selected clip. Pass a coalesce key for edits that come in a stream, such as a
 * slider being dragged, so the whole drag undoes in one step.
 */
export function updateSelected(update: (clip: OverlayClip) => OverlayClip, coalesce?: string): void {
  const { project, overlay, commitLayers } = editState();
  const found = overlay ? findOverlay(project.layers, overlay) : null;
  if (!overlay || !found) return;
  const updated = update(found.clip);
  if (updated === found.clip) return;
  commitLayers(updateOverlay(project.layers, overlay, () => updated), { coalesce: coalesce && `${overlay}:${coalesce}` });
}

export function deleteSelectedOverlay(): void {
  const { project, overlay, commitLayers } = editState();
  if (overlay) commitLayers(removeOverlay(project.layers, overlay), { overlay: null });
}

/** Puts a copy right after the clip on the same layer, and selects the copy. */
export function duplicateSelectedOverlay(): void {
  const found = selectedOverlay();
  if (!found) return;
  const copy = { ...found.clip, id: crypto.randomUUID(), start: overlayEnd(found.clip) };
  const { project, commitLayers } = editState();
  commitLayers(placeOverlay(project.layers, found.layer.id, copy), { overlay: copy.id });
}

/** Cuts the selected clip in two at the playhead. The animation carries on across the cut. */
export function splitSelectedOverlay(): void {
  const found = selectedOverlay();
  const local = timeInSelected();
  const { project, commitLayers } = editState();
  if (!found || local === null) return;
  const cut = snapToFrame(local, project.settings.fps);
  const { clip } = found;
  if (cut <= 0 || cut >= overlayDuration(clip)) return;

  const { source } = clip;
  const left: OverlayClip = {
    ...clip,
    fadeOut: 0,
    source: source.kind === 'media' ? { ...source, out: source.in + cut } : { ...source, duration: cut },
  };
  const right: OverlayClip = {
    ...shiftKeyframes(clip, cut),
    id: crypto.randomUUID(),
    start: clip.start + cut,
    fadeIn: 0,
    source: source.kind === 'media' ? { ...source, in: source.in + cut } : { ...source, duration: overlayDuration(clip) - cut },
  };
  const layers = placeOverlay(updateOverlay(project.layers, clip.id, () => left), found.layer.id, right);
  commitLayers(layers, { overlay: right.id });
}

/** Moves a clip in time and, optionally, to another layer. */
export function moveOverlay(clipId: string, start: number, layerId: string): void {
  const { project, commitLayers } = editState();
  const found = findOverlay(project.layers, clipId);
  if (!found) return;
  const moved = { ...found.clip, start: snapToFrame(Math.max(0, start), project.settings.fps) };
  if (moved.start === found.clip.start && layerId === found.layer.id) return;
  commitLayers(placeOverlay(project.layers, layerId, moved), { overlay: clipId });
}

export function toggleKeyframeAtPlayhead(): void {
  const found = selectedOverlay();
  const local = timeInSelected();
  if (!found || local === null) return;
  const time = snapToFrame(local, useStudio.getState().project.settings.fps);
  const hasKey = isAnimated(found.clip) && keyframeAt(found.clip, time) !== -1;
  updateSelected((clip) => (hasKey ? removeKeyframe(clip, time) : addKeyframe(clip, time)));
}

/** Seeks to the selected clip's next or previous keyframe. */
export function keyframeNeighbour(direction: 1 | -1): number | null {
  const found = selectedOverlay();
  if (!found) return null;
  const local = useStudio.getState().playhead - found.clip.start;
  const times = found.clip.keyframes.map((key) => key.time).sort((a, b) => a - b);
  const next = direction > 0 ? times.find((time) => time > local + 1e-3) : times.findLast((time) => time < local - 1e-3);
  return next === undefined ? null : found.clip.start + next;
}
