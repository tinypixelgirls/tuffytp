import type { EffectInfo, EffectParams } from './effects';

export type MediaId = string;

/** Layout of the thumbnail sprite sheet: one tile every `interval` seconds. */
export interface ThumbGrid {
  cols: number;
  rows: number;
  interval: number;
  tileWidth: number;
  tileHeight: number;
}

/** Waveform peaks stored as JSON; values are in -1..1. */
export interface WaveformPeaks {
  bucketsPerSecond: number;
  min: number[];
  max: number[];
}

export type MediaOrigin =
  | { kind: 'import'; sourcePath: string }
  | {
      kind: 'effect';
      effectId: string;
      params: Record<string, unknown>;
      fromMedia: MediaId;
      in: number;
      out: number;
    };

/** A normalized file in the cache. */
export interface MediaFile {
  id: MediaId;
  path: string;
  duration: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: true;
  peaksPath?: string;
  thumbsPath?: string;
  thumbGrid?: ThumbGrid;
  origin: MediaOrigin;
}

export interface Clip {
  id: string;
  mediaId: MediaId;
  in: number;
  out: number;
}

export interface ProjectSettings {
  width: number;
  height: number;
  fps: number;
  sampleRate: 48000;
}

export interface Project {
  version: 1;
  settings: ProjectSettings;
  media: Record<MediaId, MediaFile>;
  timeline: Clip[];
}

export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
export type JobKind = 'import' | 'render' | 'export';

export interface JobState {
  id: string;
  kind: JobKind;
  label: string;
  status: JobStatus;
  stage: string;
  /** 0..1, or null when the total is unknown. */
  progress: number | null;
  error?: string;
}

export interface RenderPiece {
  source: MediaFile;
  in: number;
  out: number;
}

export interface EffectRenderRequest {
  /** One or more stretches of media, joined in order before the effect runs. */
  pieces: RenderPiece[];
  effectId: string;
  params?: EffectParams;
  settings: ProjectSettings;
}

export interface EffectRenderResult {
  media: MediaFile;
  /** What actually ran, e.g. "SUS → PITCH +7 → RAINBOW" for a CHAOS roll. */
  summary: string;
}

export type ExportResolution = 'keep' | '720p' | '1080p';
export type ExportQuality = 'house' | 'draft' | 'high';

export interface ExportSegment {
  path: string;
  in: number;
  out: number;
  mediaDuration: number;
}

export interface ExportRequest {
  segments: ExportSegment[];
  settings: ProjectSettings;
  resolution: ExportResolution;
  fps: number;
  quality: ExportQuality;
  outputPath: string;
}

/** Everything that outlives a launch of the app. */
export interface ProjectFile {
  project: Project;
  sfxMedia: Record<string, MediaId>;
}

export interface LoadedProject {
  file: ProjectFile;
  /** The .ytp file's name, or null if it was never saved as one. */
  name: string | null;
  /** Media whose files are gone, say from clearing the cache by hand. */
  missing: MediaId[];
}

export interface SfxEntry {
  name: string;
  path: string;
  kind: 'audio' | 'image';
}

/** The API the preload script exposes as `window.ytp`. */
export interface YtpApi {
  pickMediaFiles(): Promise<string[]>;
  pathForFile(file: File): string;
  /** Resolves to null when the job failed or was cancelled; the job update has the reason. */
  importMedia(sourcePath: string, settings: ProjectSettings): Promise<MediaFile | null>;
  listEffects(): Promise<EffectInfo[]>;
  /** Resolves to null when the job failed or was cancelled; the job update has the reason. */
  renderEffect(request: EffectRenderRequest): Promise<EffectRenderResult | null>;
  pickExportPath(): Promise<string | null>;
  /** Resolves to the finished file, or null when the job failed or was cancelled. */
  exportTimeline(request: ExportRequest): Promise<string | null>;
  showInFolder(path: string): Promise<void>;
  pickSfxFolder(): Promise<string | null>;
  listSfx(folder: string): Promise<SfxEntry[]>;
  autosaveProject(file: ProjectFile): Promise<void>;
  restoreProject(): Promise<LoadedProject | null>;
  /** Saves over the current .ytp, or asks where if there isn't one. Resolves to its name. */
  saveProject(file: ProjectFile): Promise<string | null>;
  openProject(): Promise<LoadedProject | null>;
  /** Asks first when there's work on screen. Resolves to whether to go ahead. */
  newProject(hasWork: boolean): Promise<boolean>;
  cacheSize(): Promise<number>;
  /** Deletes everything in the cache except these media items. */
  clearCache(keep: MediaId[]): Promise<void>;
  cancelJob(jobId: string): Promise<void>;
  onJobUpdate(listener: (job: JobState) => void): () => void;
}
