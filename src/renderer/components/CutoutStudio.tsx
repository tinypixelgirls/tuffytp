import { useCallback, useEffect, useRef, useState, type MouseEvent, type PointerEvent } from 'react';
import { mediaUrl } from '../../shared/media';
import type { AiStatus, CutoutPoint, CutoutSession } from '../../shared/types';
import { endCutout } from '../cutout';
import { useStudio, type CutoutRequest } from '../store/project';
import { addMediaToLayer } from '../timeline/layers';
import { ProgressBar } from './MediaBin';

type Phase = 'checking' | 'setup' | 'installing' | 'loading' | 'editing' | 'tracking' | 'saving' | 'failed';

const TINT: [number, number, number] = [255, 46, 147];
const TINT_ALPHA = 0.5;
// How close a click has to be to a dot, in screen pixels, to take that dot away.
const HIT_PX = 12;
const BACKGROUNDS = [
  { color: '#00ff00', label: 'Green' },
  { color: '#ff00ff', label: 'Magenta' },
  { color: '#0000ff', label: 'Blue' },
];

const frameFile = (frame: number) => `${String(frame).padStart(5, '0')}`;

/** Images load once and stay cached by URL; `onLoad` asks for a redraw when one arrives. */
const images = new Map<string, HTMLImageElement>();
function image(url: string, onLoad: () => void): HTMLImageElement | null {
  let img = images.get(url);
  if (!img) {
    img = new Image();
    // Pixels get read back to tint the mask, which only works on images loaded with CORS.
    img.crossOrigin = 'anonymous';
    img.onload = onLoad;
    img.src = url;
    images.set(url, img);
    if (images.size > 400) images.delete(images.keys().next().value!);
  }
  return img.complete && img.naturalWidth > 0 ? img : null;
}

/** The studio for cutting a character out of a selection with the AI model. */
export function CutoutStudio() {
  const request = useStudio((state) => state.cutout);
  return request ? <Studio request={request} /> : null;
}

function Studio({ request }: { request: CutoutRequest }) {
  const job = useStudio((state) => state.jobs.find((candidate) => candidate.kind === 'ai' || candidate.kind === 'cutout'));
  const [phase, setPhase] = useState<Phase>('checking');
  const [ai, setAi] = useState<AiStatus | null>(null);
  const [session, setSession] = useState<CutoutSession | null>(null);
  const [frame, setFrame] = useState(0);
  const [points, setPoints] = useState<Record<number, CutoutPoint[]>>({});
  const [versions, setVersions] = useState<Record<number, number>>({});
  const [trackVersion, setTrackVersion] = useState(0);
  const [tracked, setTracked] = useState(false);
  const [stale, setStale] = useState(false);
  const [view, setView] = useState<'mask' | 'cutout'>('mask');
  const [grow, setGrow] = useState(0);
  const [feather, setFeather] = useState(1);
  const [background, setBackground] = useState(BACKGROUNDS[0].color);
  const [name, setName] = useState(request.name);
  const [onLayer, setOnLayer] = useState(true);
  const [, setLoaded] = useState(0);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sessionRef = useRef<CutoutSession | null>(null);
  const redraw = useCallback(() => setLoaded((count) => count + 1), []);

  const open = useCallback(async () => {
    setPhase('loading');
    const opened = await window.ytp.openCutout(request.pieces, useStudio.getState().project.settings);
    sessionRef.current = opened;
    setSession(opened);
    setPhase(opened ? 'editing' : 'failed');
  }, [request]);

  useEffect(() => {
    void window.ytp.aiStatus().then((status) => {
      setAi(status);
      if (status.installed) void open();
      else setPhase('setup');
    });
    // Closing the studio throws its frames away, whatever state it was in.
    return () => {
      if (sessionRef.current) void window.ytp.closeCutout(sessionRef.current.id);
    };
  }, [open]);

  const install = async () => {
    setPhase('installing');
    const done = await window.ytp.installAi();
    const status = await window.ytp.aiStatus();
    setAi(status);
    if (done && status.installed) void open();
    else setPhase('setup');
  };

  const maskUrl = (index: number) =>
    session && `${mediaUrl(session.folder, `masks/${frameFile(index)}.png`)}?v=${versions[index] ?? 0}-${trackVersion}`;

  // Draws the frame with the mask tinted over it, or the cut-out character on a checkerboard.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !session) return;
    const { width, height } = session;
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    const picture = image(mediaUrl(session.folder, `frames/${frameFile(frame)}.jpg`), redraw);
    const hasMask = (versions[frame] ?? 0) > 0 || tracked;
    const mask = hasMask ? image(maskUrl(frame)!, redraw) : null;
    if (!picture) return;

    ctx.globalCompositeOperation = 'source-over';
    if (view === 'cutout' && mask) {
      drawChecker(ctx, width, height);
      ctx.drawImage(withMaskAlpha(picture, mask, width, height, null), 0, 0);
    } else {
      ctx.drawImage(picture, 0, 0, width, height);
      if (mask) ctx.drawImage(withMaskAlpha(null, mask, width, height, TINT), 0, 0);
    }

    for (const point of points[frame] ?? []) {
      ctx.beginPath();
      ctx.arc(point.x, point.y, Math.max(6, width / 120), 0, Math.PI * 2);
      ctx.fillStyle = point.keep ? '#22ff66' : '#ff3b30';
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#000';
      ctx.stroke();
    }
  });

  const framePoint = (event: { clientX: number; clientY: number }) => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const scale = Math.min(rect.width / canvas.width, rect.height / canvas.height);
    return {
      x: (event.clientX - rect.left - (rect.width - canvas.width * scale) / 2) / scale,
      y: (event.clientY - rect.top - (rect.height - canvas.height * scale) / 2) / scale,
      scale,
    };
  };

  /** Left click keeps what's under it, right click (or Alt) cuts it away, clicking a dot removes it. */
  const onPointerDown = async (event: PointerEvent<HTMLCanvasElement>) => {
    if (!session || phase !== 'editing' || (event.button !== 0 && event.button !== 2)) return;
    const { x, y, scale } = framePoint(event);
    if (x < 0 || y < 0 || x >= session.width || y >= session.height) return;
    const current = points[frame] ?? [];
    const near = current.findIndex((point) => Math.hypot(point.x - x, point.y - y) * scale < HIT_PX);
    const next =
      near !== -1
        ? current.filter((_point, index) => index !== near)
        : [...current, { x: Math.round(x), y: Math.round(y), keep: event.button === 0 && !event.altKey }];
    setPoints((all) => ({ ...all, [frame]: next }));
    try {
      const version = await window.ytp.cutoutPoints(session.id, frame, next);
      setVersions((all) => ({ ...all, [frame]: version }));
      if (tracked) setStale(true);
    } catch (error) {
      useStudio.getState().pushToast('error', `The AI couldn't use that click: ${(error as Error).message}`);
    }
  };

  const track = async () => {
    if (!session) return;
    setPhase('tracking');
    const done = await window.ytp.trackCutout(session.id);
    if (done) {
      setTracked(true);
      setStale(false);
      setTrackVersion((version) => version + 1);
    }
    setPhase('editing');
  };

  const save = async () => {
    if (!session) return;
    setPhase('saving');
    const media = await window.ytp.saveCutout(session.id, { grow, feather, background, name: name.trim() || request.name });
    if (!media) {
      setPhase('editing');
      return;
    }
    const { addMedia, pushToast } = useStudio.getState();
    addMedia(media);
    // Full frame and lined up in time, it sits exactly over the character it came from.
    if (onLayer) addMediaToLayer(media.id, request.start, null, { x: 0.5, y: 0.5, scale: 1, rotation: 0 });
    pushToast('info', `Cut out ${name}. It's in the bin${onLayer ? ' and on a layer' : ''}.`);
    endCutout();
  };

  const step = useCallback(
    (by: number) => setFrame((current) => (session ? Math.min(session.frames - 1, Math.max(0, current + by)) : current)),
    [session],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement).matches('input[type="text"]')) return;
      if (event.key === 'ArrowLeft') step(event.shiftKey ? -10 : -1);
      else if (event.key === 'ArrowRight') step(event.shiftKey ? 10 : 1);
      else if (event.key === 'Escape') endCutout();
      else return;
      event.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [step]);

  const busy = phase === 'tracking' || phase === 'saving' || phase === 'loading' || phase === 'installing';
  const clicked = Object.values(points).some((list) => list.some((point) => point.keep));

  return (
    <div className="modal-backdrop">
      <div className="modal cutout-studio" role="dialog" aria-label="Cut out">
        <div className="popover-head">
          <strong>✂ Cut out a character</strong>
          {ai?.installed && (
            <span className="cutout-device">
              {ai.model} on {ai.gpu ?? 'CPU (slow)'}
            </span>
          )}
          <button className="icon-button" aria-label="Close" disabled={phase === 'saving'} onClick={endCutout}>
            ×
          </button>
        </div>

        {(phase === 'setup' || phase === 'installing') && (
          <div className="cutout-setup">
            <h3>One-time download: the AI pack</h3>
            <p>
              Cutting out uses <b>SAM 2.1</b>, Meta&apos;s segmentation model. It doesn&apos;t ship with TuffYTP, to keep the app
              small. It downloads once into TuffYTP&apos;s own folder: a private Python, PyTorch (the CUDA build for NVIDIA cards)
              and the model. That&apos;s a few GB, mostly PyTorch. Nothing else on your PC changes, and you can remove it any time.
            </p>
            {phase === 'installing' ? (
              <>
                <ProgressBar value={job?.progress ?? null} />
                <p className="popover-description">{job?.stage ?? 'Starting'}</p>
                <div className="popover-actions">
                  <button className="tool" disabled={!job} onClick={() => job && void window.ytp.cancelJob(job.id)}>
                    Cancel
                  </button>
                </div>
              </>
            ) : (
              <div className="popover-actions">
                <button className="chunky small" onClick={() => void install()}>
                  Download AI pack
                </button>
              </div>
            )}
          </div>
        )}

        {(phase === 'checking' || phase === 'loading') && (
          <div className="cutout-setup">
            <ProgressBar value={phase === 'loading' ? (job?.progress ?? null) : null} />
            <p className="popover-description">{phase === 'loading' ? (job?.stage ?? 'Starting') : 'Checking the AI pack'}</p>
          </div>
        )}

        {phase === 'failed' && (
          <div className="cutout-setup">
            <p>That didn&apos;t work. The error is in the message at the bottom right.</p>
            <div className="popover-actions">
              <button className="chunky small" onClick={() => void open()}>
                Try again
              </button>
            </div>
          </div>
        )}

        {session && phase !== 'failed' && phase !== 'loading' && (
          <div className="cutout-body">
            <div className="cutout-stage">
              <canvas
                ref={canvasRef}
                className={busy ? 'busy' : undefined}
                onPointerDown={(event) => void onPointerDown(event)}
                onContextMenu={(event: MouseEvent) => event.preventDefault()}
              />
              {phase === 'tracking' && (
                <div className="cutout-overlay">
                  <ProgressBar value={job?.progress ?? null} />
                  Following them through {session.frames} frames…
                </div>
              )}
            </div>
            <div className="cutout-scrub">
              <button className="tool" onClick={() => step(-1)} title="Previous frame (Left)">
                ◀
              </button>
              <input
                type="range"
                min={0}
                max={session.frames - 1}
                value={frame}
                aria-label="Frame"
                onChange={(event) => setFrame(Number(event.target.value))}
              />
              <button className="tool" onClick={() => step(1)} title="Next frame (Right)">
                ▶
              </button>
              <span className="timecode small">
                {frame + 1}/{session.frames}
              </span>
              <span className="tool-gap" />
              <button className={view === 'mask' ? 'tool active' : 'tool'} onClick={() => setView('mask')}>
                Mask
              </button>
              <button className={view === 'cutout' ? 'tool active' : 'tool'} onClick={() => setView('cutout')}>
                Cut out
              </button>
            </div>

            <div className="cutout-side">
              <ol className="cutout-steps">
                <li className={clicked ? 'done' : 'now'}>
                  <b>Click the character.</b> Left click keeps, right click cuts away, clicking a dot removes it. A few dots
                  on different parts (head, body, legs) work best.
                </li>
                <li className={tracked && !stale ? 'done' : clicked ? 'now' : ''}>
                  <b>Track</b> follows them through the whole shot.
                  <button className="chunky small" disabled={!clicked || busy} onClick={() => void track()}>
                    {tracked ? 'Track again' : 'Track'}
                  </button>
                  {stale && <span className="cutout-note">You changed some dots: track again to carry that through.</span>}
                </li>
                <li className={tracked ? 'now' : ''}>
                  <b>Check it.</b> Scrub through, fix any frame with more clicks, and track again.
                </li>
              </ol>

              <label className="param">
                Name
                <input className="effect-search" type="text" value={name} onChange={(event) => setName(event.target.value)} />
              </label>
              <label className="param">
                <span className="param-row">
                  Edge
                  <span className="param-value">{grow > 0 ? `+${grow}px` : `${grow}px`}</span>
                </span>
                <input type="range" min={-5} max={10} step={1} value={grow} onChange={(event) => setGrow(Number(event.target.value))} />
              </label>
              <label className="param">
                <span className="param-row">
                  Softness
                  <span className="param-value">{feather}px</span>
                </span>
                <input type="range" min={0} max={10} step={1} value={feather} onChange={(event) => setFeather(Number(event.target.value))} />
              </label>
              <label className="param">
                Flat copy background (for keying anywhere else)
                <span className="inspector-row">
                  {BACKGROUNDS.map(({ color, label }) => (
                    <button
                      key={color}
                      className={background === color ? 'tool active' : 'tool'}
                      onClick={(event) => {
                        event.preventDefault();
                        setBackground(color);
                      }}
                    >
                      {label}
                    </button>
                  ))}
                </span>
              </label>
              <label className="param param-inline">
                <input type="checkbox" checked={onLayer} onChange={(event) => setOnLayer(event.target.checked)} />
                Put it on a layer over the original
              </label>
              <div className="popover-actions">
                <button className="chunky small" disabled={!tracked || busy} onClick={() => void save()}>
                  {phase === 'saving' ? 'Saving…' : 'Save cutout'}
                </button>
              </div>
              {ai?.installed && (
                <button
                  className="link-button cutout-remove"
                  onClick={async () => {
                    endCutout();
                    await window.ytp.removeAi();
                    useStudio.getState().pushToast('info', 'Removed the AI pack. It can be downloaded again any time.');
                  }}
                >
                  Remove the AI pack
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function drawChecker(ctx: CanvasRenderingContext2D, width: number, height: number) {
  const size = Math.max(8, Math.round(width / 64));
  for (let y = 0; y < height; y += size) {
    for (let x = 0; x < width; x += size) {
      ctx.fillStyle = (x / size + y / size) % 2 === 0 ? '#3a3058' : '#211a33';
      ctx.fillRect(x, y, size, size);
    }
  }
}

const scratch = document.createElement('canvas');

/**
 * Uses the mask's brightness as alpha: on the picture to show the cut-out character, or on a
 * flat colour to tint the mask over the frame.
 */
function withMaskAlpha(
  picture: HTMLImageElement | null,
  mask: HTMLImageElement,
  width: number,
  height: number,
  tint: [number, number, number] | null,
): HTMLCanvasElement {
  scratch.width = width;
  scratch.height = height;
  const ctx = scratch.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(mask, 0, 0, width, height);
  const maskData = ctx.getImageData(0, 0, width, height);
  let output: ImageData;
  if (picture) {
    ctx.drawImage(picture, 0, 0, width, height);
    output = ctx.getImageData(0, 0, width, height);
  } else {
    output = ctx.createImageData(width, height);
  }
  const m = maskData.data;
  const o = output.data;
  for (let index = 0; index < o.length; index += 4) {
    if (tint) {
      o[index] = tint[0];
      o[index + 1] = tint[1];
      o[index + 2] = tint[2];
      o[index + 3] = m[index] * TINT_ALPHA;
    } else {
      o[index + 3] = m[index];
    }
  }
  ctx.putImageData(output, 0, 0);
  return scratch;
}
