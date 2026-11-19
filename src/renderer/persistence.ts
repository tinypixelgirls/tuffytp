import { withLayers, type Layer } from '../shared/layers';
import type { LoadedProject, ProjectFile } from '../shared/types';
import { forgetRenders } from './effects/apply';
import { blankProject, useStudio } from './store/project';
import { player } from './timeline/transport';

const AUTOSAVE_DELAY_MS = 300;

const overlayCount = (layers: Layer[]) => layers.reduce((total, layer) => total + layer.clips.length, 0);

function currentFile(): ProjectFile {
  const { project, sfxMedia } = useStudio.getState();
  return { project, sfxMedia };
}

/**
 * Replaces what's on screen. Clips whose files have gone are dropped rather than left broken.
 * Stacked renders that nothing plays any more are fine to lose: Clear cache removes them on
 * purpose, and their records stay because the effect history reads its labels from them.
 */
function show(loaded: LoadedProject): void {
  const { name, missing } = loaded;
  const file = { ...loaded.file, project: withLayers(loaded.file.project) };
  const gone = new Set(missing);
  const lostImport = (id: string) => gone.has(id) && file.project.media[id].origin.kind !== 'effect';
  const media = Object.fromEntries(Object.entries(file.project.media).filter(([id]) => !lostImport(id)));
  const timeline = file.project.timeline.filter((clip) => !gone.has(clip.mediaId));
  const layers = file.project.layers.map((layer) => ({
    ...layer,
    clips: layer.clips.filter((clip) => clip.source.kind !== 'media' || !gone.has(clip.source.mediaId)),
  }));
  const lostLayered = overlayCount(file.project.layers) - overlayCount(layers);
  const sfxMedia = Object.fromEntries(Object.entries(file.sfxMedia).filter(([, id]) => !gone.has(id)));
  const lost =
    file.project.timeline.length -
    timeline.length +
    lostLayered +
    Object.keys(file.project.media).length -
    Object.keys(media).length;

  player.pause();
  forgetRenders();
  useStudio.setState({
    project: { ...file.project, media, timeline, layers },
    sfxMedia,
    projectName: name,
    past: [],
    future: [],
    selection: null,
    overlay: null,
    playhead: 0,
    loop: false,
    previewSource: null,
  });
  if (lost > 0) {
    useStudio.getState().pushToast('warning', `${lost} clip(s) in this project were deleted from the cache.`);
  }
}

/** Saves a moment after each change, so closing the app never costs any work. */
function startAutosave(): void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  useStudio.subscribe((state, previous) => {
    if (state.project === previous.project && state.sfxMedia === previous.sfxMedia) return;
    clearTimeout(timer);
    timer = setTimeout(() => void window.ytp.autosaveProject(currentFile()), AUTOSAVE_DELAY_MS);
  });
}

let started = false;

export async function startProject(): Promise<void> {
  if (started) return;
  started = true;
  const loaded = await window.ytp.restoreProject();
  if (loaded && loaded.file.project.timeline.length + Object.keys(loaded.file.project.media).length > 0) {
    show(loaded);
    useStudio.getState().pushToast('info', 'Picked up right where you left off.');
  }
  startAutosave();
}

export async function saveProject(): Promise<void> {
  const name = await window.ytp.saveProject(currentFile());
  if (!name) return;
  useStudio.setState({ projectName: name });
  useStudio.getState().pushToast('info', `Saved ${name}.`);
}

export async function openProject(): Promise<void> {
  try {
    const loaded = await window.ytp.openProject();
    if (loaded) show(loaded);
  } catch {
    useStudio.getState().pushToast('error', 'That project file could not be opened.');
  }
}

export async function newProject(): Promise<void> {
  const { project } = useStudio.getState();
  const hasWork = project.timeline.length + overlayCount(project.layers) + Object.keys(project.media).length > 0;
  if (await window.ytp.newProject(hasWork)) {
    show({ file: { project: blankProject(), sfxMedia: {} }, name: null, missing: [] });
  }
}
