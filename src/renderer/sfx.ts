import type { MediaFile } from '../shared/types';
import { importPaths, useStudio } from './store/project';

const FOLDER_KEY = 'ytp.sfxFolder';

export function loadSfxFolder(): string | null {
  try {
    return localStorage.getItem(FOLDER_KEY);
  } catch {
    return null;
  }
}

export function saveSfxFolder(folder: string): void {
  try {
    localStorage.setItem(FOLDER_KEY, folder);
  } catch {
    // The folder just needs choosing again next time.
  }
}

/** Sounds and images are normalized the first time they're used, then reused. */
export async function mediaForSfx(path: string): Promise<MediaFile | null> {
  const { project, sfxMedia } = useStudio.getState();
  const existing = project.media[sfxMedia[path]];
  if (existing) return existing;

  const [media] = await importPaths([path]);
  if (!media) return null;
  useStudio.setState((state) => ({ sfxMedia: { ...state.sfxMedia, [path]: media.id } }));
  return media;
}
