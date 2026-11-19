import type { EffectInfo, EffectParams } from './effects';
import type { Layer } from './layers';

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
      kind: 'cutout';
      /** What it shows in the bin, e.g. "One Piece 001 @ 00:12". */
      name: string;
      fromMedia: MediaId;
      in: number;
      out: number;
    }
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
  /**
   * The same media with real transparency, as VP9 with alpha. Layers use this; the main track
   * and the bin use `path`, where the transparent parts are filled with a solid colour.
   */
  alphaPath?: string;
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
  /** The main track: clips played back to back. It sets how long the video is. */
  timeline: Clip[];
  /** Layers stacked over the main track, bottom first. */
  layers: Layer[];
}

export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
export type JobKind = 'import' | 'render' | 'export' | 'ai' | 'cutout';

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
  /** Render through the media's transparent version and keep the transparency, where the effect allows. */
  keepAlpha?: boolean;
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
  /** Layers to stack over the joined main track, with the media they use. */
  composite?: CompositeRequest;
}

export interface CompositeRequest {
  layers: Layer[];
  media: Record<MediaId, Pick<MediaFile, 'path' | 'duration' | 'alphaPath'>>;
}

/** Whether the AI add-on is installed, and what it runs on. */
export interface AiStatus {
  installed: boolean;
  /** Set once installed: the GPU's name, or null when it runs on the CPU. */
  gpu: string | null;
  model: string | null;
}

/** An open cutout: the selection's frames on disk, ready to click on. */
export interface CutoutSession {
  id: string;
  /** Cache folder holding frames/00000.jpg… and masks/00000.png… */
  folder: string;
  frames: number;
  fps: number;
  width: number;
  height: number;
}

export interface CutoutPoint {
  /** Pixels in the frame. */
  x: number;
  y: number;
  /** True to keep what's under it, false to cut it away. */
  keep: boolean;
}

export interface CutoutSaveOptions {
  /** Pixels to grow (positive) or shrink (negative) the edge by. */
  grow: number;
  /** Edge softness in pixels. */
  feather: number;
  /** Fill for the flat version the bin and main track use: a screen colour, so it keys back out. */
  background: string;
  name: string;
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
  aiStatus(): Promise<AiStatus>;
  /** Downloads and sets up the AI add-on. Resolves to whether it finished. */
  installAi(): Promise<boolean>;
  removeAi(): Promise<void>;
  /** Pulls the selection's frames out for cutting. Null when it failed or was cancelled. */
  openCutout(pieces: RenderPiece[], settings: ProjectSettings): Promise<CutoutSession | null>;
  /** Sets one frame's clicks and resolves to the mask's version, for cache-busting its URL. */
  cutoutPoints(sessionId: string, frame: number, points: CutoutPoint[]): Promise<number>;
  /** Follows the mask through every frame. Resolves to whether it finished. */
  trackCutout(sessionId: string): Promise<boolean>;
  saveCutout(sessionId: string, options: CutoutSaveOptions): Promise<MediaFile | null>;
  closeCutout(sessionId: string): Promise<void>;
  onJobUpdate(listener: (job: JobState) => void): () => void;
}
