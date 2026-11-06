import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { randomUUID } from 'node:crypto';
import { basename, join } from 'node:path';
import type {
  EffectRenderRequest,
  EffectRenderResult,
  ExportRequest,
  MediaFile,
  ProjectFile,
  ProjectSettings,
} from '../shared/types';
import { cacheSize, clearCache, createMediaDir, exportWorkDir, removeMediaDir } from './cache';
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

const jobs = new JobQueue((job) => mainWindow?.webContents.send('job:update', job));

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
  ipcMain.handle('cache:clear', (_event, keep: string[]) => clearCache(new Set(keep)));

  ipcMain.handle('job:cancel', (_event, jobId: string) => jobs.cancel(jobId));
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

app.on('before-quit', () => jobs.cancelAll());
