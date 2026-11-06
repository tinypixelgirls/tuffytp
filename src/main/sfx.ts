import { readdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import type { SfxEntry } from '../shared/types';
import { IMAGE_EXTENSIONS } from './normalize';

const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.ogg', '.flac', '.m4a']);

/** The sound effects and images directly inside a folder, or nothing if it's gone. */
export async function listSfx(folder: string): Promise<SfxEntry[]> {
  const entries = await readdir(folder, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isFile())
    .flatMap((entry): SfxEntry[] => {
      const extension = extname(entry.name).toLowerCase();
      const path = join(folder, entry.name);
      if (AUDIO_EXTENSIONS.has(extension)) return [{ name: entry.name, path, kind: 'audio' }];
      if (IMAGE_EXTENSIONS.has(extension)) return [{ name: entry.name, path, kind: 'image' }];
      return [];
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}
