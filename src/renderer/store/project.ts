import { create } from 'zustand';
import type { EffectInfo } from '../../shared/effects';
import type { Layer } from '../../shared/layers';
import type { Clip, JobState, MediaFile, MediaId, Project, RenderPiece } from '../../shared/types';
import { clamp, timelineDuration, type TimeRange } from '../timeline/model';

const HISTORY_LIMIT = 200;
const TOAST_SECONDS = { info: 5, warning: 7, error: 12 };

/**
 * Undo restores the edit, not the whole project: the media list only ever grows,
 * so undoing never pulls a finished import or render out of the bin.
 */
interface Snapshot {
  timeline: Clip[];
  layers: Layer[];
  selection: TimeRange | null;
  overlay: string | null;
}

/**
 * Dragging a slider makes dozens of edits. Ones that share a coalesce key in a row fold into
 * a single undo step.
 */
let lastCoalesce: string | null = null;
let lastCoalesceAt = 0;
// A pause this long between edits starts a new undo step, even on the same slider.
const COALESCE_MS = 800;

const PINS_KEY = 'ytp.pins';
const DEFAULT_PINS = ['sus', 'stutter', 'reverse', 'pitch-up', 'pitch-down', 'speed-up', 'earrape', 'staredown', 'chaos'];

function loadPins(): (string | null)[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(PINS_KEY) ?? 'null');
    return Array.isArray(saved) && saved.length === DEFAULT_PINS.length ? saved : DEFAULT_PINS;
  } catch {
    return DEFAULT_PINS;
  }
}

const VOLUME_KEY = 'ytp.volume';
// Starts below full, because this app contains a button called EAR RAPE.
const DEFAULT_VOLUME = 0.7;

function loadVolume(): number {
  try {
    const saved = Number(localStorage.getItem(VOLUME_KEY));
    return localStorage.getItem(VOLUME_KEY) !== null && saved >= 0 && saved <= 1 ? saved : DEFAULT_VOLUME;
  } catch {
    return DEFAULT_VOLUME;
  }
}

export function saveVolume(volume: number): void {
  try {
    localStorage.setItem(VOLUME_KEY, String(volume));
  } catch {
    // It just goes back to the default next time.
  }
}

export function savePins(pins: (string | null)[]): void {
  try {
    localStorage.setItem(PINS_KEY, JSON.stringify(pins));
  } catch {
    // Pins are a convenience; if storage is unavailable they just last until the app closes.
  }
}

/** A stretch of the main track to cut a character out of. */
export interface CutoutRequest {
  pieces: RenderPiece[];
  /** Where the stretch starts on the timeline, so the cutout can go back over it. */
  start: number;
  name: string;
}

export interface Toast {
  id: string;
  kind: keyof typeof TOAST_SECONDS;
  text: string;
}

interface StudioState {
  project: Project;
  /** The saved .ytp file's name, or null if it was never saved as one. */
  projectName: string | null;
  volume: number;
  muted: boolean;
  past: Snapshot[];
  future: Snapshot[];
  selection: TimeRange | null;
  /** The layer clip being edited, by id. Only one of this and `selection` is set at a time. */
  overlay: string | null;
  /** Waiting for a click on the preview to choose the selected clip's key colour. */
  pickingKey: boolean;
  /** What the cutout studio is open on, or null when it's closed. */
  cutout: CutoutRequest | null;
  playhead: number;
  playing: boolean;
  loop: boolean;
  /** A bin clip showing in the preview, or null when it shows the timeline. */
  previewSource: { mediaId: MediaId; nonce: number } | null;
  sourceTime: number;
  jobs: JobState[];
  effects: EffectInfo[];
  /** Effect ids waiting or rendering, oldest first. One effect can be in here twice. */
  effectQueue: string[];
  /** Keys 1 to 9: the effect fired by each, or null. */
  pins: (string | null)[];
  /** Sound effects normalized so far, by source path, so each only converts once. */
  sfxMedia: Record<string, MediaId>;
  toasts: Toast[];
  addMedia(media: MediaFile): void;
  playInPreview(mediaId: MediaId): void;
  showTimeline(): void;
  setSelection(selection: TimeRange | null): void;
  selectOverlay(clipId: string | null): void;
  commit(timeline: Clip[], next?: { selection?: TimeRange | null; playhead?: number }): void;
  commitLayers(layers: Layer[], next?: { overlay?: string | null; coalesce?: string }): void;
  undo(): void;
  redo(): void;
  /** Folds every undo step taken since `firstStep` into one. */
  collapseHistory(firstStep: number): void;
  upsertJob(job: JobState): void;
  dismissJob(jobId: string): void;
  pushToast(kind: Toast['kind'], text: string): void;
  dismissToast(id: string): void;
}

export const blankProject = (): Project => ({
  version: 1,
  settings: { width: 1280, height: 720, fps: 30, sampleRate: 48000 },
  media: {},
  timeline: [],
  layers: [],
});

export const useStudio = create<StudioState>((set, get) => ({
  project: blankProject(),
  projectName: null,
  volume: loadVolume(),
  muted: false,
  past: [],
  future: [],
  selection: null,
  overlay: null,
  pickingKey: false,
  cutout: null,
  playhead: 0,
  playing: false,
  loop: false,
  previewSource: null,
  sourceTime: 0,
  jobs: [],
  effects: [],
  effectQueue: [],
  pins: loadPins(),
  sfxMedia: {},
  toasts: [],

  addMedia: (media) =>
    set(({ project }) => ({
      project: { ...project, media: { ...project.media, [media.id]: media } },
    })),

  playInPreview: (mediaId) =>
    set(({ previewSource }) => ({
      previewSource: { mediaId, nonce: (previewSource?.nonce ?? 0) + 1 },
      sourceTime: 0,
    })),

  showTimeline: () => set((state) => (state.previewSource ? { previewSource: null } : state)),

  setSelection: (selection) => set((state) => ({ selection, overlay: selection ? null : state.overlay })),

  selectOverlay: (overlay) =>
    set((state) => ({ overlay, selection: overlay ? null : state.selection, pickingKey: false })),

  commit: (timeline, next = {}) => {
    lastCoalesce = null;
    set(({ project, past, selection, overlay, playhead }) => ({
      project: { ...project, timeline },
      past: [...past, { timeline: project.timeline, layers: project.layers, selection, overlay }].slice(-HISTORY_LIMIT),
      future: [],
      selection: next.selection ?? null,
      overlay: next.selection ? null : overlay,
      playhead: clamp(next.playhead ?? playhead, 0, timelineDuration(timeline)),
    }));
  },

  commitLayers: (layers, next = {}) => {
    const now = performance.now();
    const fold = next.coalesce !== undefined && next.coalesce === lastCoalesce && now - lastCoalesceAt < COALESCE_MS;
    lastCoalesce = next.coalesce ?? null;
    lastCoalesceAt = now;
    set(({ project, past, future, selection, overlay }) => {
      const nextOverlay = next.overlay === undefined ? overlay : next.overlay;
      return {
        project: { ...project, layers },
        past: fold
          ? past
          : [...past, { timeline: project.timeline, layers: project.layers, selection, overlay }].slice(-HISTORY_LIMIT),
        future: fold ? future : [],
        overlay: nextOverlay,
        selection: nextOverlay ? null : selection,
      };
    });
  },

  undo: () => {
    lastCoalesce = null;
    set(({ project, past, future, selection, overlay, playhead }) => {
      const snapshot = past[past.length - 1];
      if (!snapshot) return {};
      return {
        project: { ...project, timeline: snapshot.timeline, layers: snapshot.layers },
        past: past.slice(0, -1),
        future: [...future, { timeline: project.timeline, layers: project.layers, selection, overlay }],
        selection: snapshot.selection,
        overlay: snapshot.overlay,
        playhead: clamp(playhead, 0, timelineDuration(snapshot.timeline)),
      };
    });
  },

  redo: () => {
    lastCoalesce = null;
    set(({ project, past, future, selection, overlay, playhead }) => {
      const snapshot = future[future.length - 1];
      if (!snapshot) return {};
      return {
        project: { ...project, timeline: snapshot.timeline, layers: snapshot.layers },
        past: [...past, { timeline: project.timeline, layers: project.layers, selection, overlay }],
        future: future.slice(0, -1),
        selection: snapshot.selection,
        overlay: snapshot.overlay,
        playhead: clamp(playhead, 0, timelineDuration(snapshot.timeline)),
      };
    });
  },

  collapseHistory: (firstStep) => set(({ past }) => ({ past: past.slice(0, firstStep + 1) })),

  upsertJob: (job) =>
    set(({ jobs }) => {
      const others = jobs.filter((existing) => existing.id !== job.id);
      if (job.status === 'done' || job.status === 'cancelled') return { jobs: others };
      const exists = others.length !== jobs.length;
      return { jobs: exists ? jobs.map((existing) => (existing.id === job.id ? job : existing)) : [...jobs, job] };
    }),

  dismissJob: (jobId) => set(({ jobs }) => ({ jobs: jobs.filter((job) => job.id !== jobId) })),

  pushToast: (kind, text) => {
    const id = crypto.randomUUID();
    set(({ toasts }) => ({ toasts: [...toasts, { id, kind, text }] }));
    setTimeout(() => get().dismissToast(id), TOAST_SECONDS[kind] * 1000);
  },

  dismissToast: (id) => set(({ toasts }) => ({ toasts: toasts.filter((toast) => toast.id !== id) })),
}));

/** Whether effect buttons have something to hit: a stretch of the main track, or a video layer clip. */
export function hasEffectTarget(state: Pick<StudioState, 'selection' | 'overlay' | 'project'>): boolean {
  if (state.selection) return true;
  if (!state.overlay) return false;
  return state.project.layers.some((layer) =>
    layer.clips.some((clip) => clip.id === state.overlay && clip.source.kind === 'media'),
  );
}

/** Resolves to what imported successfully, in the order the paths were given. */
export async function importPaths(paths: string[]): Promise<MediaFile[]> {
  const { settings } = useStudio.getState().project;
  const results = await Promise.all(
    paths.map(async (path) => {
      const media = await window.ytp.importMedia(path, settings);
      if (media) useStudio.getState().addMedia(media);
      return media;
    }),
  );
  return results.filter((media) => media !== null);
}
