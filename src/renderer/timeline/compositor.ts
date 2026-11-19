import {
  activeOverlays,
  alphaAt,
  clamp,
  keyAlpha,
  overlayDuration,
  parseColor,
  transformAt,
  visibleOverlays,
  type BlendMode,
  type Layer,
  type OverlayClip,
  type TextStyle,
  type Transform,
} from '../../shared/layers';
import { ALPHA_FILE, MEDIA_FILE, mediaUrl } from '../../shared/media';
import type { MediaFile, MediaId, ProjectSettings } from '../../shared/types';
import { useStudio } from '../store/project';
import { player } from './transport';

/**
 * Draws the preview when there are layers: the main track's video first, then every layer
 * clip on top with its transform, key, opacity and blend mode. It has to look like the export,
 * so the maths for keyframes and keys comes from the same shared code the export uses.
 */

const COMPOSITE: Record<BlendMode, GlobalCompositeOperation> = {
  normal: 'source-over',
  add: 'lighter',
  screen: 'screen',
  multiply: 'multiply',
  overlay: 'overlay',
  darken: 'darken',
  lighten: 'lighten',
  difference: 'difference',
};

// Keying runs per pixel in JavaScript, so it works on a smaller copy of the frame.
const KEY_WIDTH = 640;
// A layer clip's own video can wander this far from the playhead before it's pulled back.
const DRIFT_SECONDS = 0.25;
// Clips starting this soon get their video loaded and seeked ahead of time.
const PRELOAD_SECONDS = 1.5;
const POOL_LIMIT = 16;
const LINE_HEIGHT = 1.15;
const SELECTED = '#ffe600';

/** A canvas font string matching the export's font files: Impact, or a bold sans. */
export const canvasFont = (font: TextStyle['font'], size: number) =>
  font === 'impact' ? `${size}px Impact, 'Arial Black', sans-serif` : `bold ${size}px Arial, 'Segoe UI', sans-serif`;

/** Lays text out the way the export's drawtext lines do: each line centred, the block centred. */
export function textLines(style: TextStyle, height: number) {
  const size = Math.max(4, Math.round(style.size * height));
  const lineHeight = Math.round(size * LINE_HEIGHT);
  const lines = style.text.split(/\r?\n/);
  const top = (height - lines.length * lineHeight) / 2;
  return { size, lines, lineHeight, top, border: Math.round(size * style.outlineWidth) };
}

interface Pooled {
  el: HTMLVideoElement;
  url: string;
}

export class Compositor {
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private readonly pool = new Map<string, Pooled>();
  private readonly keyCanvas = document.createElement('canvas');
  private readonly textCache = new Map<string, HTMLCanvasElement>();
  private frame = 0;
  private dirty = true;
  private unsubscribe: (() => void) | null = null;
  private readonly listeners = new AbortController();

  attach(canvas: HTMLCanvasElement, baseVideos: HTMLVideoElement[]): void {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    const { signal } = this.listeners;
    for (const video of baseVideos) {
      for (const event of ['seeked', 'loadeddata', 'playing']) {
        video.addEventListener(event, this.markDirty, { signal });
      }
    }
    this.unsubscribe = useStudio.subscribe(this.markDirty);
    this.frame = requestAnimationFrame(this.tick);
  }

  detach(): void {
    cancelAnimationFrame(this.frame);
    this.unsubscribe?.();
    this.listeners.abort();
    for (const { el } of this.pool.values()) this.release(el);
    this.pool.clear();
    this.canvas = null;
    this.ctx = null;
  }

  /** Whether the preview needs compositing at all. */
  static active(layers: Layer[], previewing: boolean): boolean {
    return !previewing && visibleOverlays(layers).length > 0;
  }

  private markDirty = () => {
    this.dirty = true;
  };

  private tick = () => {
    this.frame = requestAnimationFrame(this.tick);
    const state = useStudio.getState();
    const { project, playhead, playing, previewSource } = state;
    if (!this.canvas || !this.ctx || !Compositor.active(project.layers, previewSource !== null)) {
      this.pauseAll();
      return;
    }
    this.syncVideos(project.layers, project.media, playhead, playing, state.muted ? 0 : state.volume, project.settings);
    if (!playing && !this.dirty) return;
    this.dirty = false;
    this.draw(project.layers, playhead, project.settings, state.overlay);
  };

  /** Keeps each layer clip's video at the playhead, and loads the ones about to start. */
  private syncVideos(
    layers: Layer[],
    media: Record<MediaId, MediaFile>,
    time: number,
    playing: boolean,
    volume: number,
    settings: ProjectSettings,
  ): void {
    const wanted = new Set<string>();
    for (const { layer, clip } of visibleOverlays(layers)) {
      const { source } = clip;
      if (source.kind !== 'media') continue;
      const local = time - clip.start;
      const live = local >= 0 && local < overlayDuration(clip);
      const soon = local < 0 && -local < PRELOAD_SECONDS;
      if (!live && !soon) continue;
      wanted.add(clip.id);

      // Transparent media plays from its VP9 copy, which Chromium decodes with the alpha.
      const file = media[source.mediaId]?.alphaPath ? ALPHA_FILE : MEDIA_FILE;
      const pooled = this.videoFor(clip.id, mediaUrl(source.mediaId, file));
      const { el } = pooled;
      const target = source.in + Math.max(0, local);
      el.muted = layer.muted || clip.volume <= 0 || volume <= 0;
      el.volume = clamp(clip.volume * volume, 0, 1);

      if (live && playing) {
        if (el.paused) {
          el.currentTime = target;
          el.play().catch(() => {});
        } else if (Math.abs(el.currentTime - target) > DRIFT_SECONDS) {
          el.currentTime = target;
        }
      } else {
        if (!el.paused) el.pause();
        if (!el.seeking && Math.abs(el.currentTime - target) > 0.5 / settings.fps) el.currentTime = target;
      }
    }

    for (const [clipId, { el }] of this.pool) {
      if (wanted.has(clipId)) continue;
      if (!el.paused) el.pause();
      if (this.pool.size > POOL_LIMIT) {
        this.release(el);
        this.pool.delete(clipId);
      }
    }
  }

  private videoFor(clipId: string, url: string): Pooled {
    const existing = this.pool.get(clipId);
    if (existing && existing.url === url) return existing;
    if (existing) this.release(existing.el);

    const el = document.createElement('video');
    // Keying reads pixels back, which only works on video loaded with CORS.
    el.crossOrigin = 'anonymous';
    el.preload = 'auto';
    el.playsInline = true;
    el.src = url;
    for (const event of ['seeked', 'loadeddata']) el.addEventListener(event, this.markDirty);
    const pooled = { el, url };
    this.pool.set(clipId, pooled);
    return pooled;
  }

  private release(el: HTMLVideoElement): void {
    el.pause();
    el.removeAttribute('src');
    el.load();
  }

  private pauseAll(): void {
    for (const { el } of this.pool.values()) if (!el.paused) el.pause();
  }

  private draw(layers: Layer[], time: number, settings: ProjectSettings, selected: string | null): void {
    const canvas = this.canvas!;
    const ctx = this.ctx!;
    const { width: W, height: H } = settings;
    if (canvas.width !== W || canvas.height !== H) {
      canvas.width = W;
      canvas.height = H;
    }

    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    const base = player.activeVideo();
    if (base && base.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) ctx.drawImage(base, 0, 0, W, H);

    let outline: { clip: OverlayClip; transform: Transform } | null = null;
    for (const { clip } of activeOverlays(layers, time)) {
      const local = time - clip.start;
      const picture = this.pictureFor(clip, settings);
      if (!picture) continue;
      const transform = transformAt(clip.keyframes, local);
      ctx.save();
      ctx.globalAlpha = clamp(alphaAt(clip, local), 0, 1);
      ctx.globalCompositeOperation = COMPOSITE[clip.blend];
      applyTransform(ctx, transform, W, H);
      ctx.drawImage(picture, -W / 2, -H / 2, W, H);
      ctx.restore();
      if (clip.id === selected) outline = { clip, transform };
    }

    if (outline) {
      ctx.save();
      applyTransform(ctx, outline.transform, W, H);
      const box = boundsOf(outline.clip, W, H, ctx);
      ctx.lineWidth = 3 / Math.max(0.05, Math.abs(outline.transform.scale));
      ctx.setLineDash([10, 6]);
      ctx.strokeStyle = SELECTED;
      ctx.strokeRect(box.x, box.y, box.width, box.height);
      ctx.restore();
    }
  }

  /** The clip's frame as something drawImage takes, full frame size, or null if it isn't ready. */
  private pictureFor(clip: OverlayClip, settings: ProjectSettings): CanvasImageSource | null {
    if (clip.source.kind === 'text') return this.textPicture(clip.source.style, settings);
    const el = this.pool.get(clip.id)?.el;
    if (!el || el.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return null;
    if (!clip.key) return el;
    return this.keyed(el, clip, settings);
  }

  private keyed(el: HTMLVideoElement, clip: OverlayClip, settings: ProjectSettings): CanvasImageSource {
    const key = clip.key!;
    const width = Math.min(KEY_WIDTH, settings.width);
    const height = Math.round((width * settings.height) / settings.width);
    const scratch = this.keyCanvas;
    if (scratch.width !== width || scratch.height !== height) {
      scratch.width = width;
      scratch.height = height;
    }
    const ctx = scratch.getContext('2d', { willReadFrequently: true });
    if (!ctx) return el;
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(el, 0, 0, width, height);
    let image: ImageData;
    try {
      image = ctx.getImageData(0, 0, width, height);
    } catch {
      // A video that somehow loaded without CORS can't be read; show it unkeyed rather than not at all.
      return el;
    }
    const data = image.data;
    const rgb = parseColor(key.color);
    for (let index = 0; index < data.length; index += 4) {
      data[index + 3] = Math.round(data[index + 3] * keyAlpha(key, rgb, data[index], data[index + 1], data[index + 2]));
    }
    ctx.putImageData(image, 0, 0);
    return scratch;
  }

  private textPicture(style: TextStyle, settings: ProjectSettings): HTMLCanvasElement {
    const cacheKey = JSON.stringify([style, settings.width, settings.height]);
    const cached = this.textCache.get(cacheKey);
    if (cached) return cached;

    const canvas = document.createElement('canvas');
    canvas.width = settings.width;
    canvas.height = settings.height;
    const ctx = canvas.getContext('2d')!;
    const { size, lines, lineHeight, top, border } = textLines(style, settings.height);
    ctx.font = canvasFont(style.font, size);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.fillStyle = style.color;
    ctx.strokeStyle = style.outline;
    // drawtext's border grows outward; a canvas stroke is centred on the edge, so it's doubled.
    ctx.lineWidth = border * 2;
    lines.forEach((line, index) => {
      const y = top + index * lineHeight + lineHeight / 2;
      if (border > 0) ctx.strokeText(line, settings.width / 2, y);
      ctx.fillText(line, settings.width / 2, y);
    });

    if (this.textCache.size > 64) this.textCache.clear();
    this.textCache.set(cacheKey, canvas);
    return canvas;
  }

  /** The colour of the selected clip's own picture under a point on the preview, for the key picker. */
  sampleClip(clip: OverlayClip, time: number, point: { x: number; y: number }, settings: ProjectSettings): string | null {
    if (clip.source.kind !== 'media') return null;
    const el = this.pool.get(clip.id)?.el;
    if (!el || el.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return null;
    const local = toClipSpace(clip, time - clip.start, point, settings);
    if (!local) return null;
    const probe = document.createElement('canvas');
    probe.width = 1;
    probe.height = 1;
    const ctx = probe.getContext('2d', { willReadFrequently: true })!;
    const sx = (local.x / settings.width) * el.videoWidth;
    const sy = (local.y / settings.height) * el.videoHeight;
    ctx.drawImage(el, sx, sy, 1, 1, 0, 0, 1, 1);
    try {
      const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
      return `#${[r, g, b].map((part) => part.toString(16).padStart(2, '0')).join('')}`;
    } catch {
      return null;
    }
  }
}

function applyTransform(ctx: CanvasRenderingContext2D, transform: Transform, W: number, H: number): void {
  ctx.translate(transform.x * W, transform.y * H);
  ctx.rotate((transform.rotation * Math.PI) / 180);
  ctx.scale(transform.scale, transform.scale);
}

/** The part of the clip's full-frame picture worth grabbing: the whole frame, or just the words. */
function boundsOf(clip: OverlayClip, W: number, H: number, ctx: CanvasRenderingContext2D) {
  if (clip.source.kind !== 'text') return { x: -W / 2, y: -H / 2, width: W, height: H };
  const { style } = clip.source;
  const { size, lines, lineHeight, top, border } = textLines(style, H);
  ctx.save();
  ctx.font = canvasFont(style.font, size);
  const widest = Math.max(...lines.map((line) => ctx.measureText(line).width), size);
  ctx.restore();
  const pad = border + size * 0.1;
  return { x: -widest / 2 - pad, y: top - H / 2 - pad, width: widest + pad * 2, height: lines.length * lineHeight + pad * 2 };
}

/** A point on the frame, in the clip's own untransformed picture, or null if it misses the picture. */
export function toClipSpace(
  clip: OverlayClip,
  local: number,
  point: { x: number; y: number },
  settings: ProjectSettings,
): { x: number; y: number } | null {
  const { width: W, height: H } = settings;
  const transform = transformAt(clip.keyframes, local);
  if (Math.abs(transform.scale) < 1e-6) return null;
  const angle = (-transform.rotation * Math.PI) / 180;
  const dx = point.x - transform.x * W;
  const dy = point.y - transform.y * H;
  const x = (dx * Math.cos(angle) - dy * Math.sin(angle)) / transform.scale + W / 2;
  const y = (dx * Math.sin(angle) + dy * Math.cos(angle)) / transform.scale + H / 2;
  return x >= 0 && x < W && y >= 0 && y < H ? { x, y } : null;
}

/** The topmost clip under a point on the frame. Text only counts where its words are. */
export function overlayAt(layers: Layer[], time: number, point: { x: number; y: number }, settings: ProjectSettings) {
  const ctx = document.createElement('canvas').getContext('2d')!;
  const hits = activeOverlays(layers, time).filter(({ clip }) => {
    const local = toClipSpace(clip, time - clip.start, point, settings);
    if (!local) return false;
    const box = boundsOf(clip, settings.width, settings.height, ctx);
    const x = local.x - settings.width / 2;
    const y = local.y - settings.height / 2;
    return x >= box.x && x <= box.x + box.width && y >= box.y && y <= box.y + box.height;
  });
  return hits[hits.length - 1] ?? null;
}

export const compositor = new Compositor();
