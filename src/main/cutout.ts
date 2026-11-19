import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { ALPHA_FILE, MEDIA_FILE } from '../shared/media';
import type {
  CutoutPoint,
  CutoutSaveOptions,
  CutoutSession,
  MediaFile,
  MediaId,
  ProjectSettings,
  RenderPiece,
} from '../shared/types';
import type { AiSidecar } from './ai';
import { runExport } from './export';
import { runFfmpeg, type JobContext } from './ffmpeg';
import { finalizeMedia } from './normalize';
import { probe } from './probe';
import { buildRenderArgs } from './render';

/**
 * Cutting a character out of a stretch of video. The frames go to disk as JPEGs for the model
 * to look at; it writes one mask per frame; saving merges those masks with the original video
 * (not the JPEGs) into transparent media.
 */

const MAX_GROW = 20;
const MAX_FEATHER = 30;

interface Session extends CutoutSession {
  dir: string;
  /** How to read the selection back at full quality when saving. */
  input: string[];
  duration: number;
  settings: ProjectSettings;
  source: RenderPiece;
  version: number;
  tracked: boolean;
}

const sessions = new Map<string, Session>();

const masksDir = (session: Session) => join(session.dir, 'masks');

function sessionFor(id: string): Session {
  const session = sessions.get(id);
  if (!session) throw new Error('That cutout was closed.');
  return session;
}

const publicView = ({ id, folder, frames, fps, width, height }: Session): CutoutSession => ({ id, folder, frames, fps, width, height });

/**
 * Pulls the selection's frames out to `cacheDir/cutout-<id>/frames` and hands them to the AI
 * helper. A selection over several clips is joined into one file first.
 */
export async function openCutout(
  cacheDir: string,
  pieces: RenderPiece[],
  settings: ProjectSettings,
  sidecar: AiSidecar,
  ctx: JobContext,
): Promise<CutoutSession> {
  const id = randomUUID();
  const folder = `cutout-${id}`;
  const dir = join(cacheDir, folder);
  await mkdir(join(dir, 'frames'), { recursive: true });
  await mkdir(join(dir, 'masks'), { recursive: true });

  try {
    let input: string[];
    let duration: number;
    if (pieces.length === 1) {
      const [{ source, in: start, out }] = pieces;
      input = ['-ss', String(start), '-t', String(out - start), '-i', source.path];
      duration = out - start;
    } else {
      ctx.report(null, 'Joining the selection');
      const joined = join(dir, 'source.mp4');
      await runExport(
        join(dir, 'join-work'),
        {
          segments: pieces.map(({ source, in: start, out }) => ({ path: source.path, in: start, out, mediaDuration: source.duration })),
          settings,
          resolution: 'keep',
          fps: settings.fps,
          quality: 'house',
          outputPath: joined,
        },
        { signal: ctx.signal, report: () => {} },
      );
      input = ['-i', joined];
      duration = (await probe(joined)).duration;
    }

    ctx.report(0, 'Pulling out frames');
    await runFfmpeg({
      args: [...input, '-an', '-vf', `fps=${settings.fps}`, '-q:v', '2', '-start_number', '0', join(dir, 'frames', '%05d.jpg')],
      duration,
      onProgress: (fraction) => ctx.report(fraction * 0.5),
      signal: ctx.signal,
    });
    const frames = (await readdir(join(dir, 'frames'))).filter((name) => name.endsWith('.jpg')).length;
    if (frames === 0) throw new Error('No frames came out of that selection.');

    ctx.report(0.5, 'Loading the AI model');
    await sidecar.request('open', { frames_dir: join(dir, 'frames'), masks_dir: join(dir, 'masks') }, { signal: ctx.signal });

    const session: Session = {
      id,
      folder,
      dir,
      frames,
      fps: settings.fps,
      width: settings.width,
      height: settings.height,
      input,
      duration,
      settings,
      source: pieces[0],
      version: 0,
      tracked: false,
    };
    sessions.set(id, session);
    return publicView(session);
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}

/** Replaces one frame's clicks and writes that frame's mask. Resolves to a new version number. */
export async function setCutoutPoints(id: string, frame: number, points: CutoutPoint[], sidecar: AiSidecar): Promise<number> {
  const session = sessionFor(id);
  if (frame < 0 || frame >= session.frames) throw new Error('That frame is outside the cutout.');
  await sidecar.request('points', {
    frame,
    points: points.map(({ x, y }) => [x, y]),
    labels: points.map(({ keep }) => (keep ? 1 : 0)),
  });
  return ++session.version;
}

/** Follows the clicked character through every frame of the selection. */
export async function trackCutout(id: string, sidecar: AiSidecar, ctx: JobContext): Promise<number> {
  const session = sessionFor(id);
  ctx.report(0, 'Tracking');
  await sidecar.request('track', {}, { signal: ctx.signal, onProgress: (fraction) => ctx.report(fraction) });
  session.tracked = true;
  return ++session.version;
}

/** The mask clean-up: grow or shrink the edge a pixel per step, then soften it. */
export function maskFilter({ grow, feather }: Pick<CutoutSaveOptions, 'grow' | 'feather'>, settings: ProjectSettings): string {
  const steps = Math.round(Math.min(MAX_GROW, Math.abs(grow)));
  const filters = ['format=gray', `scale=${settings.width}:${settings.height}`];
  for (let step = 0; step < steps; step++) filters.push(grow > 0 ? 'dilation' : 'erosion');
  const soft = Math.min(MAX_FEATHER, Math.max(0, feather));
  if (soft > 0) filters.push(`gblur=sigma=${(soft / 2).toFixed(2)}`);
  return filters.join(',');
}

/**
 * Turns the masks into new media: a transparent copy for layers, plus a house file with the
 * background filled in a screen colour, which keys straight back out.
 */
export async function saveCutout(
  id: string,
  mediaId: MediaId,
  mediaDir: string,
  options: CutoutSaveOptions,
  ctx: JobContext,
): Promise<MediaFile> {
  const session = sessionFor(id);
  const masks = (await readdir(masksDir(session))).filter((name) => name.endsWith('.png')).length;
  if (!session.tracked || masks < session.frames) throw new Error('Track the character through the shot before saving.');

  const { settings } = session;
  const background = /^#[0-9a-f]{6}$/i.test(options.background) ? `0x${options.background.slice(1)}` : 'green';
  const filter = [
    `[1:v]${maskFilter(options, settings)}[mask]`,
    `[0:v]fps=${settings.fps},format=rgba[colour]`,
    '[colour][mask]alphamerge[vout]',
    '[0:a]anull[aout]',
  ].join(';');
  const input = [...session.input, '-framerate', String(settings.fps), '-start_number', '0', '-i', join(masksDir(session), '%05d.png')];

  ctx.report(0, 'Saving cutout');
  await runFfmpeg({
    args: buildRenderArgs(input, filter, settings, join(mediaDir, MEDIA_FILE), session.duration, {
      kind: 'both',
      alphaPath: join(mediaDir, ALPHA_FILE),
      background,
    }),
    duration: session.duration,
    onProgress: (fraction) => ctx.report(fraction * 0.85),
    signal: ctx.signal,
  });

  const { source } = session;
  return finalizeMedia(
    mediaId,
    mediaDir,
    { kind: 'cutout', name: options.name, fromMedia: source.source.id, in: source.in, out: source.out },
    settings,
    ctx,
    true,
  );
}

export async function closeCutout(id: string, sidecar: AiSidecar | null): Promise<void> {
  const session = sessions.get(id);
  if (!session) return;
  sessions.delete(id);
  await sidecar?.request('close').catch(() => {});
  await rm(session.dir, { recursive: true, force: true });
}

/** For tests and app shutdown. */
export async function closeAllCutouts(sidecar: AiSidecar | null): Promise<void> {
  await Promise.all([...sessions.keys()].map((id) => closeCutout(id, sidecar)));
}


/** Cache folders of cutouts still open, which Clear cache has to leave alone. */
export const openCutoutFolders = (): string[] => [...sessions.values()].map((session) => session.folder);
