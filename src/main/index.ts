import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type {
  CutoutPoint,
  CutoutSaveOptions,
  CutoutSession,
  EffectRenderRequest,
  EffectRenderResult,
  ExportRequest,
  JobState,
  MediaFile,
  ProjectFile,
  ProjectSettings,
  RenderPiece,
} from '../shared/types';
import { AiSidecar, aiPaths, aiStatus, installAiPack, removeAiPack, SAM2_CONFIG } from './ai';
import serverSource from './ai/script';
import { cacheSize, clearCache, createMediaDir, exportWorkDir, projectCacheDir, removeMediaDir } from './cache';
import { closeAllCutouts, closeCutout, openCutout, openCutoutFolders, saveCutout, setCutoutPoints, trackCutout } from './cutout';
import { availableEffects, getEffect, toEffectInfo } from './effects';
import type { Effect } from './effects/types';
import { runExport } from './export';
import { JobQueue, listFilters, type JobContext } from './ffmpeg';
import { importMedia } from './normalize';
import {
  autosaveProject,
  readProject,
  restoreLastProject,
  savedProjectPath,
  startNewProject,
  writeProject,
} from './project';
import { handleMediaProtocol, registerMediaScheme } from './protocol';
import { renderEffect } from './render';
import { listSfx } from './sfx';

let mainWindow: BrowserWindow | null = null;
let filters = new Set<string>();
let effectPool: Effect[] = [];

const sendJob = (job: JobState) => mainWindow?.webContents.send('job:update', job);
const jobs = new JobQueue(sendJob);
// The AI gets its own line: a big download or a long track shouldn't hold up renders.
const aiJobs = new JobQueue(sendJob);

const aiRoot = () => join(app.getPath('userData'), 'ai');
let sidecar: AiSidecar | null = null;

/** The AI helper, started on first use and kept running so the model loads once. */
async function aiHelper(): Promise<AiSidecar> {
  if (sidecar) return sidecar;
  const paths = aiPaths(aiRoot());
  if (!(await aiStatus(aiRoot())).installed) throw new Error('The AI pack is not installed.');
  // Rewritten every launch, so an app update brings the helper's changes with it.
  await writeFile(paths.server, serverSource);
  sidecar = new AiSidecar(paths.python, [paths.server, '--checkpoint', paths.checkpoint, '--config', SAM2_CONFIG]);
  return sidecar;
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    title: 'TuffYTP',
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 640,
    backgroundColor: '#14101f',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Clip cuts run on animation frames, which must keep firing behind other windows.
      backgroundThrottling: false,
    },
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https:')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  // A file dropped outside a drop zone would otherwise navigate the whole app to it.
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());

  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  if (devUrl) void mainWindow.loadURL(devUrl);
  else void mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
}

/** Runs a job that writes one new media folder, which goes away again if the job doesn't finish. */
function mediaJob<T>(
  kind: 'import' | 'render',
  label: string,
  work: (id: string, dir: string, ctx: JobContext) => Promise<T>,
): Promise<T | null> {
  return jobs
    .add(kind, label, async (ctx) => {
      const id = randomUUID();
      const dir = await createMediaDir(id);
      try {
        return await work(id, dir, ctx);
      } catch (error) {
        await removeMediaDir(dir);
        throw error;
      }
    })
    .catch(() => null);
}

function registerIpc(): void {
  ipcMain.handle('media:pick', async () => {
    const { filePaths } = await dialog.showOpenDialog(mainWindow!, {
      title: 'Import media',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Video and audio', extensions: ['mp4', 'mov', 'mkv', 'webm', 'avi', 'gif', 'mp3', 'wav', 'ogg'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    return filePaths;
  });

  ipcMain.handle(
    'media:import',
    (_event, sourcePath: string, settings: ProjectSettings): Promise<MediaFile | null> =>
      mediaJob('import', basename(sourcePath), (id, dir, ctx) => importMedia(id, dir, sourcePath, settings, ctx)),
  );

  ipcMain.handle('effects:list', () => effectPool.map(toEffectInfo));

  ipcMain.handle(
    'effect:render',
    (_event, request: EffectRenderRequest): Promise<EffectRenderResult | null> =>
      mediaJob('render', getEffect(request.effectId).label, (id, dir, ctx) =>
        renderEffect(id, dir, request, { pool: effectPool, filters }, ctx),
      ),
  );

  ipcMain.handle('export:pick', async () => {
    const { filePath, canceled } = await dialog.showSaveDialog(mainWindow!, {
      title: 'Export video',
      defaultPath: 'my-youtube-poop.mp4',
      filters: [{ name: 'MP4 video', extensions: ['mp4'] }],
    });
    return canceled ? null : filePath;
  });

  ipcMain.handle('export:start', (_event, request: ExportRequest): Promise<string | null> => {
    const dir = exportWorkDir();
    return jobs
      .add('export', basename(request.outputPath), (ctx) => runExport(dir, request, ctx))
      .catch(async () => {
        await removeMediaDir(dir);
        return null;
      });
  });

  ipcMain.handle('export:reveal', (_event, path: string) => shell.showItemInFolder(path));

  ipcMain.handle('sfx:pick', async () => {
    const { filePaths } = await dialog.showOpenDialog(mainWindow!, {
      title: 'Choose your sound effects folder',
      properties: ['openDirectory'],
    });
    return filePaths[0] ?? null;
  });

  ipcMain.handle('sfx:list', (_event, folder: string) => listSfx(folder));

  ipcMain.handle('project:autosave', (_event, file: ProjectFile) => autosaveProject(file));
  ipcMain.handle('project:restore', () => restoreLastProject());

  ipcMain.handle('project:save', async (_event, file: ProjectFile) => {
    const existing = savedProjectPath();
    if (existing) return writeProject(existing, file);
    const { filePath, canceled } = await dialog.showSaveDialog(mainWindow!, {
      title: 'Save project',
      defaultPath: 'my-youtube-poop.ytp',
      filters: [{ name: 'TuffYTP project', extensions: ['ytp'] }],
    });
    return canceled || !filePath ? null : writeProject(filePath, file);
  });

  ipcMain.handle('project:open', async () => {
    const { filePaths } = await dialog.showOpenDialog(mainWindow!, {
      title: 'Open project',
      properties: ['openFile'],
      filters: [{ name: 'TuffYTP project', extensions: ['ytp'] }],
    });
    return filePaths[0] ? readProject(filePaths[0]) : null;
  });

  ipcMain.handle('project:new', async (_event, hasWork: boolean) => {
    if (hasWork) {
      const { response } = await dialog.showMessageBox(mainWindow!, {
        type: 'question',
        title: 'New project',
        message: 'Start a new project?',
        detail: savedProjectPath()
          ? 'Your saved project stays safe.'
          : 'This project was never saved, so it will be lost the next time the cache is cleared.',
        buttons: ['Start new', 'Keep working'],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
      });
      if (response !== 0) return false;
    }
    await startNewProject();
    return true;
  });

  ipcMain.handle('cache:size', () => cacheSize());
  ipcMain.handle('cache:clear', (_event, keep: string[]) => clearCache(new Set([...keep, ...openCutoutFolders()])));

  ipcMain.handle('job:cancel', (_event, jobId: string) => {
    jobs.cancel(jobId);
    aiJobs.cancel(jobId);
  });

  ipcMain.handle('ai:status', () => aiStatus(aiRoot()));

  ipcMain.handle('ai:install', () =>
    aiJobs
      .add('ai', 'AI pack', (ctx) => installAiPack(aiRoot(), serverSource, ctx))
      .then(() => true)
      .catch(() => false),
  );

  ipcMain.handle('ai:remove', async () => {
    sidecar?.stop();
    sidecar = null;
    await removeAiPack(aiRoot());
  });

  ipcMain.handle(
    'cutout:open',
    (_event, pieces: RenderPiece[], settings: ProjectSettings): Promise<CutoutSession | null> =>
      aiJobs
        .add('cutout', 'Cutout', async (ctx) => openCutout(projectCacheDir(), pieces, settings, await aiHelper(), ctx))
        .catch(() => null),
  );

  ipcMain.handle('cutout:points', async (_event, id: string, frame: number, points: CutoutPoint[]) =>
    setCutoutPoints(id, frame, points, await aiHelper()),
  );

  ipcMain.handle('cutout:track', (_event, id: string) =>
    aiJobs
      .add('cutout', 'Tracking', async (ctx) => trackCutout(id, await aiHelper(), ctx))
      .then(() => true)
      .catch(() => false),
  );

  ipcMain.handle(
    'cutout:save',
    (_event, id: string, options: CutoutSaveOptions): Promise<MediaFile | null> =>
      mediaJob('render', 'Saving cutout', (mediaId, dir, ctx) => saveCutout(id, mediaId, dir, options, ctx)),
  );

  ipcMain.handle('cutout:close', (_event, id: string) => closeCutout(id, sidecar));
}

// The app was called YTP Studio first, and its projects and settings still live under that name.
if (!app.commandLine.hasSwitch('user-data-dir')) {
  app.setPath('userData', join(app.getPath('appData'), 'ytp-studio'));
}

registerMediaScheme();

// Clear cache deletes other sessions' folders, so a second copy could wipe this one's media.
if (!app.requestSingleInstanceLock()) app.quit();

app.on('second-instance', () => {
  if (mainWindow?.isMinimized()) mainWindow.restore();
  mainWindow?.focus();
});

void app.whenReady().then(async () => {
  handleMediaProtocol();
  registerIpc();
  filters = await listFilters();
  effectPool = availableEffects(filters);
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  jobs.cancelAll();
  aiJobs.cancelAll();
  void closeAllCutouts(null);
  sidecar?.stop();
});
