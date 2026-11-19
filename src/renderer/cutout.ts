import { formatTimecode, mediaName } from './format';
import { useStudio } from './store/project';
import { targetsForRange } from './timeline/model';

// Every frame is held in memory while the model tracks, so long selections get turned down.
const LONGEST_SECONDS = 30;

/** Opens the cutout studio on the main track's selection. */
export function startCutout(): void {
  const { project, selection, pushToast } = useStudio.getState();
  if (!selection) {
    pushToast('info', 'Select the shot to cut a character out of first.');
    return;
  }
  const seconds = selection.end - selection.start;
  if (seconds > LONGEST_SECONDS) {
    pushToast('warning', `Cutouts can be up to ${LONGEST_SECONDS} seconds. Select one shot at a time.`);
    return;
  }
  const targets = targetsForRange(project.timeline, selection);
  if (targets.length === 0) return;

  const pieces = targets.map(({ mediaId, in: start, out }) => ({ source: project.media[mediaId], in: start, out }));
  const first = project.media[targets[0].mediaId];
  const name = `${mediaName(first).replace(/\.[^.]+$/, '')} @ ${formatTimecode(targets[0].in, project.settings.fps).slice(0, 5)}`;
  useStudio.getState().showTimeline();
  useStudio.setState({ cutout: { pieces, start: selection.start, name } });
}

export function endCutout(): void {
  useStudio.setState({ cutout: null });
}
