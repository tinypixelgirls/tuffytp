import { app } from 'electron';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import type { MediaId } from '../shared/types';

/** Marks a project folder as belonging to a saved .ytp file, so Clear cache leaves it alone. */
export const SAVED_MARKER = '.saved';

let projectId: string = randomUUID();

export const currentProjectId = () => projectId;

/** Everything from here on reads and writes this project's folder. */
export function switchProject(id: string): void {
  projectId = id;
}

function cacheRoot(): string {
  // Not "cache": Chromium owns userData/Cache, and Windows paths ignore case.
  return join(app.getPath('userData'), 'media-cache');
}

export function projectCacheDir(id = projectId): string {
  return join(cacheRoot(), id);
}

export async function createMediaDir(id: MediaId): Promise<string> {
  const dir = join(projectCacheDir(), id);
  await mkdir(dir, { recursive: true });
  return dir;
}

export function exportWorkDir(): string {
  return join(projectCacheDir(), `export-${randomUUID()}`);
}

export async function removeMediaDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

/** Resolves a path relative to the cache, or null if it would escape the cache. */
export function resolveCachePath(relativePath: string): string | null {
  const root = projectCacheDir();
  const target = resolve(root, relativePath);
  return target.startsWith(root + sep) ? target : null;
}

export async function cacheSize(): Promise<number> {
  const entries = await readdir(cacheRoot(), { recursive: true, withFileTypes: true }).catch(() => []);
  const sizes = await Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .map((entry) =>
        stat(join(entry.parentPath, entry.name)).then(
          (stats) => stats.size,
          () => 0,
        ),
      ),
  );
  return sizes.reduce((total, size) => total + size, 0);
}

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

/** Drops unsaved past projects and whatever the current project no longer refers to. */
export async function clearCache(keep: Set<MediaId>): Promise<void> {
  const root = cacheRoot();
  const projects = await readdir(root).catch(() => [] as string[]);
  await Promise.all(
    projects
      .filter((name) => name !== projectId)
      .map(async (name) => {
        const saved = await exists(join(root, name, SAVED_MARKER));
        if (!saved) await rm(join(root, name), { recursive: true, force: true });
      }),
  );

  const current = await readdir(projectCacheDir(), { withFileTypes: true }).catch(() => []);
  const unused = current.filter((entry) => entry.isDirectory() && !keep.has(entry.name));
  await Promise.all(unused.map(({ name }) => rm(join(projectCacheDir(), name), { recursive: true, force: true })));
}
