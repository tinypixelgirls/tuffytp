import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { IpcRendererEvent } from 'electron';
import type { JobState, YtpApi } from '../shared/types';

const api: YtpApi = {
  pickMediaFiles: () => ipcRenderer.invoke('media:pick'),
  pathForFile: (file) => webUtils.getPathForFile(file),
  importMedia: (sourcePath, settings) => ipcRenderer.invoke('media:import', sourcePath, settings),
  listEffects: () => ipcRenderer.invoke('effects:list'),
  renderEffect: (request) => ipcRenderer.invoke('effect:render', request),
  pickExportPath: () => ipcRenderer.invoke('export:pick'),
  exportTimeline: (request) => ipcRenderer.invoke('export:start', request),
  showInFolder: (path) => ipcRenderer.invoke('export:reveal', path),
  pickSfxFolder: () => ipcRenderer.invoke('sfx:pick'),
  listSfx: (folder) => ipcRenderer.invoke('sfx:list', folder),
  autosaveProject: (file) => ipcRenderer.invoke('project:autosave', file),
  restoreProject: () => ipcRenderer.invoke('project:restore'),
  saveProject: (file) => ipcRenderer.invoke('project:save', file),
  openProject: () => ipcRenderer.invoke('project:open'),
  newProject: (hasWork) => ipcRenderer.invoke('project:new', hasWork),
  cacheSize: () => ipcRenderer.invoke('cache:size'),
  clearCache: (keep) => ipcRenderer.invoke('cache:clear', keep),
  cancelJob: (jobId) => ipcRenderer.invoke('job:cancel', jobId),
  aiStatus: () => ipcRenderer.invoke('ai:status'),
  installAi: () => ipcRenderer.invoke('ai:install'),
  removeAi: () => ipcRenderer.invoke('ai:remove'),
  openCutout: (pieces, settings) => ipcRenderer.invoke('cutout:open', pieces, settings),
  cutoutPoints: (sessionId, frame, points) => ipcRenderer.invoke('cutout:points', sessionId, frame, points),
  trackCutout: (sessionId) => ipcRenderer.invoke('cutout:track', sessionId),
  saveCutout: (sessionId, options) => ipcRenderer.invoke('cutout:save', sessionId, options),
  closeCutout: (sessionId) => ipcRenderer.invoke('cutout:close', sessionId),
  onJobUpdate: (listener) => {
    const handler = (_event: IpcRendererEvent, job: JobState) => listener(job);
    ipcRenderer.on('job:update', handler);
    return () => ipcRenderer.removeListener('job:update', handler);
  },
};

contextBridge.exposeInMainWorld('ytp', api);
