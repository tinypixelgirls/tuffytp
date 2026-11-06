import { create } from 'zustand';
import type { EffectInfo } from '../../shared/effects';
import type { Clip, JobState, MediaFile, MediaId, Project } from '../../shared/types';
import { clamp, timelineDuration, type TimeRange } from '../timeline/model';

const HISTORY_LIMIT = 200;
const TOAST_SECONDS = { info: 5, warning: 7, error: 12 };

/**
 * Undo restores the edit, not the whole project: the media list only ever grows,
 * so undoing never pulls a finished import or render out of the bin.
 */
interface Snapshot {
  timeline: Clip[];
  selection: TimeRange | null;
}

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
  commit(timeline: Clip[], next?: { selection?: TimeRange | null; playhead?: number }): void;
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
});

export const useStudio = create<StudioState>((set, get) => ({
  project: blankProject(),
  projectName: null,
  volume: loadVolume(),
  muted: false,
  past: [],
  future: [],
  selection: null,
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

  setSelection: (selection) => set({ selection }),

  commit: (timeline, next = {}) =>
    set(({ project, past, selection, playhead }) => ({
      project: { ...project, timeline },
      past: [...past, { timeline: project.timeline, selection }].slice(-HISTORY_LIMIT),
      future: [],
      selection: next.selection ?? null,
      playhead: clamp(next.playhead ?? playhead, 0, timelineDuration(timeline)),
    })),

  undo: () =>
    set(({ project, past, future, selection, playhead }) => {
      const snapshot = past[past.length - 1];
      if (!snapshot) return {};
      return {
        project: { ...project, timeline: snapshot.timeline },
        past: past.slice(0, -1),
        future: [...future, { timeline: project.timeline, selection }],
        selection: snapshot.selection,
        playhead: clamp(playhead, 0, timelineDuration(snapshot.timeline)),
      };
    }),

  redo: () =>
    set(({ project, past, future, selection, playhead }) => {
      const snapshot = future[future.length - 1];
      if (!snapshot) return {};
      return {
        project: { ...project, timeline: snapshot.timeline },
        past: [...past, { timeline: project.timeline, selection }],
        future: future.slice(0, -1),
        selection: snapshot.selection,
        playhead: clamp(playhead, 0, timelineDuration(snapshot.timeline)),
      };
    }),

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
