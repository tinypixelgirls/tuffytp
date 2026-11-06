import { saveVolume, useStudio } from '../store/project';
import { buildSegments, clamp, snapToFrame, timelineDuration } from './model';
import { Player, type Program } from './player';

type State = ReturnType<typeof useStudio.getState>;

export const player = new Player();

/** What the preview should be playing right now: one bin clip, or the timeline. */
function programFor(state: State): Program {
  const { project, previewSource, loop, selection } = state;
  const { fps } = project.settings;
  if (previewSource) {
    const media = project.media[previewSource.mediaId];
    return { segments: [{ mediaId: media.id, in: 0, out: media.duration, start: 0 }], loop: false, fps };
  }
  return { segments: buildSegments(project.timeline, loop ? selection : null), loop, fps };
}

export function programDuration(state: State): number {
  const { project, previewSource } = state;
  if (previewSource) return project.media[previewSource.mediaId].duration;
  return timelineDuration(project.timeline);
}

player.onTime = (time) => {
  const inSourceMode = useStudio.getState().previewSource !== null;
  useStudio.setState(inSourceMode ? { sourceTime: time } : { playhead: time });
};
player.onPlayingChange = (playing) => useStudio.setState({ playing });

useStudio.subscribe((state, previous) => {
  if (state.previewSource !== previous.previewSource) {
    player.pause();
    player.setProgram(programFor(state), state.previewSource ? 0 : state.playhead);
    if (state.previewSource) player.play();
    return;
  }
  if (state.previewSource) return;

  const loopRangeChanged = state.loop && state.selection !== previous.selection;
  if (state.project.timeline !== previous.project.timeline || state.loop !== previous.loop || loopRangeChanged) {
    player.setProgram(programFor(state), state.playhead);
  }
});

function applyVolume(): void {
  const { volume, muted } = useStudio.getState();
  player.setVolume(muted ? 0 : volume);
}

applyVolume();

export function setVolume(volume: number): void {
  useStudio.setState({ volume, muted: false });
  saveVolume(volume);
  applyVolume();
}

export function toggleMute(): void {
  useStudio.setState(({ muted }) => ({ muted: !muted }));
  applyVolume();
}

export function togglePlay(): void {
  player.toggle();
}

/** Moves the playhead on whatever the preview is showing. */
export function seekProgram(time: number): void {
  const state = useStudio.getState();
  const { fps } = state.project.settings;
  const { selection, loop, previewSource } = state;
  const target = clamp(snapToFrame(time, fps), 0, programDuration(state));
  // Seeking out of a looping range would snap straight back, so it ends the loop instead.
  if (!previewSource && loop && selection && (target < selection.start || target > selection.end)) {
    useStudio.setState({ loop: false });
  }
  player.seek(target);
}

export function seekTimeline(time: number): void {
  const state = useStudio.getState();
  if (state.previewSource) player.pause();
  state.showTimeline();
  seekProgram(time);
}

export function stepBy(seconds: number): void {
  const state = useStudio.getState();
  player.pause();
  const current = state.previewSource ? state.sourceTime : state.playhead;
  seekProgram(current + seconds);
}

/** Plays the selection (or the whole timeline) on repeat. Toggling it off stops playback. */
export function toggleLoop(): void {
  const state = useStudio.getState();
  if (state.loop) {
    useStudio.setState({ loop: false });
    player.pause();
    return;
  }
  state.showTimeline();
  if (state.project.timeline.length === 0) return;
  useStudio.setState({ loop: true });
  player.seek(state.selection?.start ?? 0);
  player.play();
}
