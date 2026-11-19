import type { MediaFile } from '../shared/types';

const pad = (value: number) => String(value).padStart(2, '0');

/** Formats seconds as MM:SS.FF, where FF is the frame within the second. */
export function formatTimecode(seconds: number, fps: number): string {
  const totalFrames = Math.round(seconds * fps);
  const wholeSeconds = Math.floor(totalFrames / fps);
  const frames = totalFrames - Math.round(wholeSeconds * fps);
  return `${pad(Math.floor(wholeSeconds / 60))}:${pad(wholeSeconds % 60)}.${pad(frames)}`;
}

export function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/** What a media item is called in the bin, the layer lanes and the preview. */
export function mediaName(media: MediaFile | undefined): string {
  if (!media) return 'Missing';
  switch (media.origin.kind) {
    case 'import':
      return fileName(media.origin.sourcePath);
    case 'cutout':
      return `✂ ${media.origin.name}`;
    default:
      return `${media.origin.effectId} render`;
  }
}
