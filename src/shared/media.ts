import type { MediaId } from './types';

export const MEDIA_SCHEME = 'ytp-media';

/** Every media item is a folder in the project cache holding these three files. */
export const MEDIA_FILE = 'media.mp4';
export const PEAKS_FILE = 'peaks.json';
export const THUMBS_FILE = 'thumbs.jpg';

export function mediaUrl(id: MediaId, file: string): string {
  return `${MEDIA_SCHEME}://cache/${id}/${file}`;
}
