import type { MediaId } from '../../shared/types';
import { useStudio } from '../store/project';
import {
  clipFromMedia,
  clipLength,
  clipStarts,
  deleteRange,
  duplicateRange,
  insertClips,
  makeRange,
  moveClip,
  splitAt,
  timelineDuration,
} from './model';

/** Edits always act on the timeline, so they bring it back into the preview first. */
function editState() {
  useStudio.getState().showTimeline();
  return useStudio.getState();
}

export function insertMedia(mediaIds: MediaId[], index: number): void {
  const { project, commit } = editState();
  const added = mediaIds.map((id) => clipFromMedia(project.media[id]));
  commit(insertClips(project.timeline, index, added));
}

export function appendMedia(mediaIds: MediaId[]): void {
  insertMedia(mediaIds, useStudio.getState().project.timeline.length);
}

export function splitAtPlayhead(): void {
  const { project, playhead, selection, commit } = editState();
  const split = splitAt(project.timeline, playhead, project.settings.fps);
  if (split !== project.timeline) commit(split, { selection });
}

export function deleteSelection(): void {
  const { project, selection, commit } = editState();
  if (!selection) return;
  commit(deleteRange(project.timeline, selection, project.settings.fps), { playhead: selection.start });
}

/** Selects the copy, so pressing it again keeps stacking repeats. */
export function duplicateSelection(): void {
  const { project, selection, commit } = editState();
  if (!selection) return;
  const { timeline, copy } = duplicateRange(project.timeline, selection, project.settings.fps);
  commit(timeline, { selection: copy });
}

export function moveClipTo(from: number, to: number): void {
  const { project, commit } = editState();
  const moved = moveClip(project.timeline, from, to);
  if (moved === project.timeline) return;
  const start = clipStarts(moved)[to > from ? to - 1 : to];
  commit(moved, { selection: { start, end: start + clipLength(project.timeline[from]) } });
}

export function selectClip(index: number): void {
  const { project, setSelection } = editState();
  const start = clipStarts(project.timeline)[index];
  setSelection({ start, end: start + clipLength(project.timeline[index]) });
}

export function markIn(): void {
  const { project, selection, playhead, setSelection } = editState();
  const end = selection && selection.end > playhead ? selection.end : timelineDuration(project.timeline);
  setSelection(makeRange(playhead, end));
}

export function markOut(): void {
  const { selection, playhead, setSelection } = editState();
  const start = selection && selection.start < playhead ? selection.start : 0;
  setSelection(makeRange(start, playhead));
}
