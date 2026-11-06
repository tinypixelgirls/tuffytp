import { app } from 'electron';
import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import type { LoadedProject, MediaId, ProjectFile } from '../shared/types';
import { currentProjectId, projectCacheDir, SAVED_MARKER, switchProject } from './cache';

const AUTOSAVE_FILE = 'project.json';

interface YtpFile {
  format: 'ytp-studio';
  version: 1;
  cacheId: string;
  file: ProjectFile;
}

/** Where Save writes to without asking again. */
let savedPath: string | null = null;

const lastProjectPointer = () => join(app.getPath('userData'), 'last-project.json');

export const savedProjectPath = () => savedPath;

function displayName(path: string | null): string | null {
  return path ? basename(path, extname(path)) : null;
}

async function missingMedia({ project }: ProjectFile): Promise<MediaId[]> {
  const media = Object.values(project.media);
  const present = await Promise.all(
    media.map((item) =>
      access(item.path).then(
        () => true,
        () => false,
      ),
    ),
  );
  return media.filter((_item, index) => !present[index]).map((item) => item.id);
}

export async function autosaveProject(file: ProjectFile): Promise<void> {
  await mkdir(projectCacheDir(), { recursive: true });
  await writeFile(join(projectCacheDir(), AUTOSAVE_FILE), JSON.stringify(file));
  await writeFile(lastProjectPointer(), JSON.stringify({ cacheId: currentProjectId(), savedPath }));
}

/** Picks up the project that was open when the app last closed, if there is one. */
export async function restoreLastProject(): Promise<LoadedProject | null> {
  try {
    const { cacheId, savedPath: path } = JSON.parse(await readFile(lastProjectPointer(), 'utf8')) as {
      cacheId: string;
      savedPath: string | null;
    };
    const file = JSON.parse(await readFile(join(projectCacheDir(cacheId), AUTOSAVE_FILE), 'utf8')) as ProjectFile;
    switchProject(cacheId);
    savedPath = path;
    return { file, name: displayName(path), missing: await missingMedia(file) };
  } catch {
    return null;
  }
}

export async function writeProject(path: string, file: ProjectFile): Promise<string> {
  const saved: YtpFile = { format: 'ytp-studio', version: 1, cacheId: currentProjectId(), file };
  await writeFile(path, JSON.stringify(saved));
  await mkdir(projectCacheDir(), { recursive: true });
  await writeFile(join(projectCacheDir(), SAVED_MARKER), '');
  savedPath = path;
  return displayName(path)!;
}

export async function readProject(path: string): Promise<LoadedProject> {
  const saved = JSON.parse(await readFile(path, 'utf8')) as YtpFile;
  if (saved.format !== 'ytp-studio') throw new Error('That is not a TuffYTP project.');
  switchProject(saved.cacheId);
  savedPath = path;
  return { file: saved.file, name: displayName(path), missing: await missingMedia(saved.file) };
}

export async function startNewProject(): Promise<void> {
  switchProject(randomUUID());
  savedPath = null;
  await rm(lastProjectPointer(), { force: true });
}
