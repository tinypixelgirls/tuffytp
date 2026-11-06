import { defaultParams, type EffectInfo, type EffectParams } from '../../shared/effects';
import type { Clip, EffectRenderResult, MediaFile, MediaOrigin } from '../../shared/types';
import { savePins, useStudio } from '../store/project';
import {
  clamp,
  clipFromMedia,
  clipLength,
  clipStarts,
  replaceRange,
  replaceTarget,
  snapToFrame,
  targetsForRange,
  timelineDuration,
  type ClipTarget,
  type TimeRange,
} from '../timeline/model';

const BUFFER_WARNING_SECONDS = 20;
const POOP_SECONDS_PER_SPOT = 2.5;
const POOP_MIN_SPOTS = 3;
const POOP_MAX_SPOTS = 12;
const POOP_SHORTEST_SPOT = 0.2;
const POOP_LONGEST_SPOT = 1.2;
// Rolled effects multiply each other's length, and one bad roll shouldn't bury the whole video.
const POOP_LONGEST_RESULT = 6;

/** What an effect is working on, and how the timeline looked when it was chosen. */
interface Target {
  pieces: ClipTarget[];
  range: TimeRange;
  timeline: Clip[];
}

/** Rendered previews, kept so that pressing Apply afterwards doesn't render it all again. */
const rendered = new Map<string, EffectRenderResult>();

/** The newest effect still in flight. The next one waits for it and stacks on its result. */
let lastInChain: Promise<Target | null> | null = null;

const findEffect = (id: string): EffectInfo | undefined =>
  useStudio.getState().effects.find((effect) => effect.id === id);

const cacheKey = ({ pieces }: Target, effectId: string, params: EffectParams) =>
  JSON.stringify([pieces.map(({ mediaId, in: start, out }) => [mediaId, start, out]), effectId, params]);

function queued(effectId: string): () => void {
  useStudio.setState(({ effectQueue }) => ({ effectQueue: [...effectQueue, effectId] }));
  return () =>
    useStudio.setState(({ effectQueue }) => {
      const index = effectQueue.indexOf(effectId);
      return { effectQueue: effectQueue.filter((_id, position) => position !== index) };
    });
}

function currentTarget(): Target | null {
  const { project, selection } = useStudio.getState();
  if (!selection) return null;
  const pieces = targetsForRange(project.timeline, selection);
  return pieces.length > 0 ? { pieces, range: selection, timeline: project.timeline } : null;
}

/** Plain presses of a dice-roll effect always roll again; Apply after a Preview keeps that roll. */
async function render(target: Target, effectId: string, params: EffectParams, keepRoll: boolean) {
  const { project, pushToast } = useStudio.getState();
  const effect = findEffect(effectId);
  const seconds = target.range.end - target.range.start;
  if (effect?.buffersSelection && seconds > BUFFER_WARNING_SECONDS) {
    pushToast('warning', `${effect.label} holds the whole selection in memory, so a long one can take a while.`);
  }

  const key = cacheKey(target, effectId, params);
  const cached = rendered.get(key);
  if (cached && (keepRoll || !effect?.randomized)) return cached;

  const result = await window.ytp.renderEffect({
    pieces: target.pieces.map(({ mediaId, in: start, out }) => ({ source: project.media[mediaId], in: start, out })),
    effectId,
    params,
    settings: project.settings,
  });
  if (result) {
    useStudio.getState().addMedia(result.media);
    rendered.set(key, result);
  }
  return result;
}

function place(target: Target, media: MediaFile, longest = Infinity): Target | null {
  useStudio.getState().showTimeline();
  const { project, commit, pushToast } = useStudio.getState();
  const { fps } = project.settings;
  const whole = clipFromMedia(media);
  const clip = { ...whole, out: Math.min(whole.out, longest) };

  const [only, ...rest] = target.pieces;
  const placed =
    rest.length === 0
      ? replaceTarget(project.timeline, only, clip, fps)
      : project.timeline === target.timeline
        ? replaceRange(project.timeline, target.range, clip, fps)
        : null;
  if (!placed) {
    pushToast('warning', 'That part of the timeline changed during the render, so the result was left out.');
    return null;
  }

  // The new clip ends up selected, so pressing another button stacks on it.
  commit(placed.timeline, { selection: placed.range, playhead: placed.range.start });
  const { project: updated } = useStudio.getState();
  return {
    pieces: [{ clipId: clip.id, mediaId: media.id, in: 0, out: clipLength(clip) }],
    range: placed.range,
    timeline: updated.timeline,
  };
}

function announce(effectId: string, { summary }: EffectRenderResult): void {
  const effect = findEffect(effectId);
  if (effect && summary !== effect.label) {
    useStudio.getState().pushToast('info', `${effect.label}: ${summary}`);
  }
}

/**
 * Renders the selection and swaps the result in. Pressing buttons while a render runs queues
 * them up, each one stacking on the result of the one before it.
 */
export function applyEffect(effectId: string, params: EffectParams, keepRoll = false): void {
  const previous = lastInChain;
  const selected = previous ? null : currentTarget();
  if (!previous && !selected) return;

  const done = queued(effectId);
  const run = (async () => {
    const target = previous ? await previous : selected;
    if (!target) return null;
    const result = await render(target, effectId, params, keepRoll);
    if (!result) return null;
    announce(effectId, result);
    return place(target, result.media);
  })();

  lastInChain = run;
  void run.finally(() => {
    if (lastInChain === run) lastInChain = null;
    done();
  });
}

/** Renders the selection and plays the result without touching the timeline. */
export async function previewEffect(effectId: string, params: EffectParams): Promise<void> {
  const target = currentTarget();
  if (!target) return;
  const done = queued(effectId);
  try {
    const result = await render(target, effectId, params, false);
    if (result) {
      announce(effectId, result);
      useStudio.getState().playInPreview(result.media.id);
    }
  } finally {
    done();
  }
}

/** Fires whatever is pinned to a number key, with its default settings. */
export function firePinned(slot: number): void {
  const { pins } = useStudio.getState();
  const effect = findEffect(pins[slot] ?? '');
  if (effect) applyEffect(effect.id, defaultParams(effect.params));
}

/** Pins an effect to the first free key, or takes it off the key it's on. */
export function togglePin(effectId: string): void {
  const { pins, pushToast } = useStudio.getState();
  const current = pins.indexOf(effectId);
  const slot = current === -1 ? pins.indexOf(null) : current;
  if (slot === -1) {
    pushToast('info', 'All nine keys are taken. Right-click a pinned effect to free one up.');
    return;
  }
  const next = pins.map((pin, index) => (index === slot ? (current === -1 ? effectId : null) : pin));
  useStudio.setState({ pins: next });
  savePins(next);
}

/** Forgets cached previews, since their files are about to go. */
export function forgetRenders(): void {
  rendered.clear();
}

/** A random stretch of untouched footage, so one pass doesn't keep hitting the same spot. */
function randomSpot(): Target | null {
  const { project } = useStudio.getState();
  const { timeline, media, settings } = project;
  const starts = clipStarts(timeline);
  const fresh = timeline
    .map((clip, index) => ({ clip, start: starts[index] }))
    .filter(({ clip }) => media[clip.mediaId].origin.kind === 'import' && clipLength(clip) >= POOP_SHORTEST_SPOT);
  if (fresh.length === 0) return null;

  // Long clips should get hit more often, so this picks a moment rather than a clip.
  const total = fresh.reduce((sum, { clip }) => sum + clipLength(clip), 0);
  let moment = Math.random() * total;
  const spot = fresh.find(({ clip }) => (moment -= clipLength(clip)) <= 0) ?? fresh[fresh.length - 1];

  const length = clipLength(spot.clip);
  const seconds = clamp(POOP_SHORTEST_SPOT + Math.random() * POOP_LONGEST_SPOT, POOP_SHORTEST_SPOT, length);
  const offset = Math.random() * (length - seconds);
  const start = snapToFrame(spot.start + offset, settings.fps);
  const end = snapToFrame(start + seconds, settings.fps);
  const range = { start, end };
  const pieces = targetsForRange(timeline, range);
  return pieces.length === 1 ? { pieces, range, timeline } : null;
}

/** Throws random effects at random spots across the whole timeline. One undo takes it all back. */
export async function fullPoop(): Promise<void> {
  const { project, past, collapseHistory, pushToast } = useStudio.getState();
  const seconds = timelineDuration(project.timeline);
  const spots = clamp(Math.round(seconds / POOP_SECONDS_PER_SPOT), POOP_MIN_SPOTS, POOP_MAX_SPOTS);
  const firstStep = past.length;
  const done = queued('fullpoop');

  let hits = 0;
  try {
    for (let attempt = 0; attempt < spots; attempt++) {
      const target = randomSpot();
      if (!target) continue;
      const effectId = Math.random() < 0.6 ? 'roulette' : 'chaos';
      const result = await render(target, effectId, {}, false);
      // No result means it failed or was cancelled, and either way the run stops here.
      if (!result) break;
      if (place(target, result.media, POOP_LONGEST_RESULT)) hits += 1;
    }
  } finally {
    done();
  }

  if (hits > 0) {
    collapseHistory(firstStep);
    useStudio.getState().setSelection(null);
    pushToast('info', `FULL POOP: wrecked ${hits} spot${hits === 1 ? '' : 's'}. Ctrl+Z takes it all back.`);
  } else {
    pushToast('info', 'FULL POOP needs some untouched footage on the timeline.');
  }
}

export interface HistoryEntry {
  clipIndex: number;
  clipId: string;
  text: string;
}

/** What's been applied to each clip on the timeline, walking back through stacked renders. */
export function effectHistory(): HistoryEntry[] {
  const { project } = useStudio.getState();
  return project.timeline.flatMap((clip, clipIndex) => {
    const labels: string[] = [];
    let media: MediaFile | undefined = project.media[clip.mediaId];
    while (media?.origin.kind === 'effect') {
      const origin: Extract<MediaOrigin, { kind: 'effect' }> = media.origin;
      const label = findEffect(origin.effectId)?.label ?? origin.effectId;
      const { summary } = origin.params;
      labels.unshift(summary ? `${label} (${summary as string})` : label);
      media = project.media[origin.fromMedia];
    }
    return labels.length > 0 ? [{ clipIndex, clipId: clip.id, text: labels.join(' → ') }] : [];
  });
}
