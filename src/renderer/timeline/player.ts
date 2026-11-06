import { MEDIA_FILE, mediaUrl } from '../../shared/media';
import { clamp, locateSegment, type PlaybackSegment } from './model';

export interface Program {
  segments: PlaybackSegment[];
  loop: boolean;
  fps: number;
}

const EMPTY_PROGRAM: Program = { segments: [], loop: false, fps: 30 };

// Lands inside the frame, so float rounding on the seek can't show the one before it.
const SEEK_NUDGE = 0.001;
// Roughly half a screen refresh: the cut lands on the tick closest to the real out point.
const END_TOLERANCE = 0.008;
// If the running video is already this close, an edit doesn't need to interrupt it.
const IN_SYNC_SECONDS = 0.1;

// A video's clock only runs once its audio reaches the speakers, so the next clip has to start
// this far ahead of the cut. It depends on the output device, so it's measured on every cut.
const DEFAULT_START_LEAD = 0.08;
const MAX_START_LEAD = 0.5;
const START_LEAD_SMOOTHING = 0.3;
// The clock creeps at first, so a reading this far in is the first one worth trusting.
const MIN_MOVE_TO_MEASURE = 0.04;

const urlOf = (segment: PlaybackSegment) => mediaUrl(segment.mediaId, MEDIA_FILE);

/** One <video> element plus the seek it's working towards. */
class Slot {
  url = '';
  ready = false;
  private target: number | null = null;
  private readonly listeners = new AbortController();

  constructor(readonly el: HTMLVideoElement) {
    el.preload = 'auto';
    const { signal } = this.listeners;
    el.addEventListener('loadedmetadata', this.settle, { signal });
    el.addEventListener('seeked', this.settle, { signal });
  }

  /** Gets the video to `time`. Only the latest request matters, so fast scrubbing can't queue up. */
  cue(url: string, time: number): void {
    this.ready = false;
    this.target = time;
    if (url !== this.url) {
      this.url = url;
      this.el.src = url;
    } else if (this.el.readyState >= HTMLMediaElement.HAVE_METADATA && !this.el.seeking) {
      this.settle();
    }
  }

  clear(): void {
    this.el.pause();
    this.el.removeAttribute('src');
    this.el.load();
    this.url = '';
    this.ready = false;
    this.target = null;
  }

  dispose(): void {
    this.listeners.abort();
  }

  private settle = () => {
    if (this.target === null) {
      this.ready = true;
      return;
    }
    this.el.currentTime = this.target + SEEK_NUDGE;
    this.target = null;
  };
}

/**
 * Plays a list of segments as one program using two stacked <video> elements. One is on
 * screen while the other waits, already seeked to the next segment, so a cut is a swap
 * rather than a load. The playhead comes from the video's own clock.
 */
export class Player {
  onTime: (time: number) => void = () => {};
  onPlayingChange: (playing: boolean) => void = () => {};

  private slots: [Slot, Slot] | null = null;
  private activeSlot = 0;
  private program = EMPTY_PROGRAM;
  private index = 0;
  private time = 0;
  private playing = false;
  private frame = 0;
  private startLead = DEFAULT_START_LEAD;
  /** When the waiting video was told to play, if it has been. */
  private incomingStartedAt: number | null = null;
  private leadProbe: { slot: Slot; startedAt: number; from: number } | null = null;
  private volume = 1;

  attach(a: HTMLVideoElement, b: HTMLVideoElement): void {
    this.slots = [new Slot(a), new Slot(b)];
    this.activeSlot = 0;
    this.showActive();
    this.applyVolume();
    this.setProgram(this.program, this.time);
  }

  setVolume(volume: number): void {
    this.volume = volume;
    this.applyVolume();
  }

  detach(): void {
    this.pause();
    this.slots?.forEach((slot) => slot.dispose());
    this.slots = null;
  }

  /** Swaps what's being played. Playback carries on if the video is already in the right place. */
  setProgram(program: Program, time: number): void {
    this.program = program;
    if (!this.slots) {
      this.time = time;
      return;
    }
    if (program.segments.length === 0) {
      this.pause();
      this.slots.forEach((slot) => slot.clear());
      this.report(0);
      return;
    }
    this.moveTo(time, true);
  }

  play(): void {
    const { segments } = this.program;
    if (this.playing || !this.slots || segments.length === 0) return;
    if (this.time >= this.end - 0.5 / this.program.fps) this.moveTo(segments[0].start, false);
    this.setPlaying(true);
    this.startActive();
    this.frame = requestAnimationFrame(this.tick);
  }

  pause(): void {
    this.current?.el.pause();
    // If the next clip had already started rolling, it has to go back to its first frame.
    if (this.incomingStartedAt !== null) this.cueStandby();
    this.setPlaying(false);
    cancelAnimationFrame(this.frame);
  }

  toggle(): void {
    if (this.playing) this.pause();
    else this.play();
  }

  seek(time: number): void {
    if (this.program.segments.length > 0) this.moveTo(time, false);
  }

  private get current(): Slot | undefined {
    return this.slots?.[this.activeSlot];
  }

  private get standby(): Slot {
    return this.slots![1 - this.activeSlot];
  }

  private get end(): number {
    const last = this.program.segments[this.program.segments.length - 1];
    return last ? last.start + (last.out - last.in) : 0;
  }

  private tick = () => {
    if (!this.playing) return;
    this.frame = requestAnimationFrame(this.tick);

    const slot = this.current!;
    if (!slot.ready) return;
    const segment = this.program.segments[this.index];
    const mediaTime = slot.el.currentTime;
    this.measureStartLead(mediaTime);

    const remaining = segment.out - mediaTime;
    if (slot.el.ended || remaining <= END_TOLERANCE) {
      this.advance();
      return;
    }
    this.report(segment.start + Math.max(0, mediaTime - segment.in));
    if (remaining <= this.startLead) this.startIncoming();
  };

  /** Rolls the waiting video so that its sound arrives just as the current clip ends. */
  private startIncoming(): void {
    const { segments, loop } = this.program;
    const hasNext = loop || this.index < segments.length - 1;
    if (this.incomingStartedAt !== null || !hasNext || !this.standby.ready) return;
    this.incomingStartedAt = performance.now();
    this.standby.el.play().catch(() => {});
  }

  /** How long the running video took to get going is how early the next one should start. */
  private measureStartLead(mediaTime: number): void {
    const probe = this.leadProbe;
    if (!probe || probe.slot !== this.current) return;
    const moved = mediaTime - probe.from;
    if (moved < MIN_MOVE_TO_MEASURE) return;
    this.leadProbe = null;

    const lag = (performance.now() - probe.startedAt) / 1000 - moved;
    const blended = this.startLead + (lag - this.startLead) * START_LEAD_SMOOTHING;
    this.startLead = clamp(blended, 0, MAX_START_LEAD);
  }

  /** Cuts to the next segment, or holds on the last frame until it's ready. */
  private advance(): void {
    const { segments, loop } = this.program;
    const last = this.index === segments.length - 1;
    if (last && !loop) {
      this.pause();
      this.report(this.end);
      return;
    }

    const incoming = this.standby;
    if (!incoming.ready) {
      this.current!.el.pause();
      return;
    }

    this.startIncoming();
    const outgoing = this.current!;
    this.index = last ? 0 : this.index + 1;
    this.activeSlot = 1 - this.activeSlot;
    this.leadProbe = { slot: incoming, startedAt: this.incomingStartedAt!, from: segments[this.index].in };
    this.showActive();
    outgoing.el.pause();
    this.report(segments[this.index].start);
    this.cueStandby();
  }

  private moveTo(time: number, keepRunning: boolean): void {
    const { segments, fps } = this.program;
    const first = segments[0];
    const target = clamp(time, first.start, this.end);
    const index = locateSegment(segments, target);
    const segment = segments[index];
    // The very end of a clip is the frame after it, so stop one short.
    const mediaTime = Math.min(segment.in + target - segment.start, segment.out - 1 / fps);

    const slot = this.current!;
    const url = urlOf(segment);
    const inSync =
      keepRunning &&
      this.playing &&
      slot.ready &&
      slot.url === url &&
      Math.abs(slot.el.currentTime - mediaTime) < IN_SYNC_SECONDS;

    this.index = index;
    if (!inSync) {
      slot.cue(url, mediaTime);
      if (this.playing) this.startActive();
    }
    this.cueStandby();
    this.report(target);
  }

  /** The next segment, wrapping when looping so even a single looped range swaps cleanly. */
  private cueStandby(): void {
    const { segments, loop } = this.program;
    const next = segments[this.index + 1] ?? (loop ? segments[0] : undefined);
    this.incomingStartedAt = null;
    if (!next) return;
    this.standby.el.pause();
    this.standby.cue(urlOf(next), next.in);
  }

  private startActive(): void {
    // A pause during the swap rejects this promise, which is expected.
    this.current!.el.play().catch(() => {});
  }

  /** Opacity rather than display, so the waiting video keeps its decoded frame ready. */
  private showActive(): void {
    this.slots!.forEach((slot, index) => {
      slot.el.style.opacity = index === this.activeSlot ? '1' : '0';
    });
  }

  private applyVolume(): void {
    this.slots?.forEach((slot) => {
      slot.el.volume = this.volume;
    });
  }

  private report(time: number): void {
    this.time = time;
    this.onTime(time);
  }

  private setPlaying(playing: boolean): void {
    if (this.playing === playing) return;
    this.playing = playing;
    this.onPlayingChange(playing);
  }
}
