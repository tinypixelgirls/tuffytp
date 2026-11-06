import { mediaUrl, PEAKS_FILE, THUMBS_FILE } from '../../shared/media';
import type { MediaId, WaveformPeaks } from '../../shared/types';

const sprites = new Map<MediaId, HTMLImageElement>();
const peaks = new Map<MediaId, WaveformPeaks | 'loading'>();

/** Called when something finishes loading, so the timeline can redraw. */
export const assetEvents = { onLoaded: () => {} };

/** The thumbnail sheet, or null until it has loaded. */
export function getSprite(id: MediaId): HTMLImageElement | null {
  let image = sprites.get(id);
  if (!image) {
    image = new Image();
    image.onload = () => assetEvents.onLoaded();
    image.src = mediaUrl(id, THUMBS_FILE);
    sprites.set(id, image);
  }
  return image.complete && image.naturalWidth > 0 ? image : null;
}

/** The waveform, or null until it has loaded. */
export function getPeaks(id: MediaId): WaveformPeaks | null {
  const existing = peaks.get(id);
  if (existing === 'loading') return null;
  if (existing) return existing;

  peaks.set(id, 'loading');
  void fetch(mediaUrl(id, PEAKS_FILE))
    .then((response) => response.json() as Promise<WaveformPeaks>)
    .then((data) => {
      peaks.set(id, data);
      assetEvents.onLoaded();
    });
  return null;
}
