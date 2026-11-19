import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ffprobePath } from './bin';

const exec = promisify(execFile);

export interface ProbeResult {
  /** Seconds, or 0 when the container doesn't say. */
  duration: number;
  video?: {
    index: number;
    width: number;
    height: number;
    fps: number;
    /** Whether the picture has transparency in it. */
    alpha: boolean;
    /**
     * VP9 keeps its alpha in a side channel that ffmpeg's own decoder throws away, so these
     * have to be read with libvpx.
     */
    needsLibvpx: boolean;
  };
  audio?: { index: number };
}

interface RawStream {
  index: number;
  codec_type?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  duration?: string;
  codec_name?: string;
  pix_fmt?: string;
  tags?: Record<string, string>;
  disposition?: { attached_pic?: number };
}

// Pixel formats with an alpha channel: rgba, yuva420p, argb, ya8, gbrap and the like.
const ALPHA_FORMAT = /^(yuva|gbrap|ya\d)|a(rgb|bgr)|(rgb|bgr)a/;

function vp9Alpha(stream: RawStream): boolean {
  const mode = Object.entries(stream.tags ?? {}).find(([key]) => key.toLowerCase() === 'alpha_mode')?.[1];
  return stream.codec_name === 'vp9' && mode === '1';
}

function parseRate(rate: string | undefined): number {
  const [num, den] = (rate ?? '').split('/').map(Number);
  return num > 0 && den > 0 ? num / den : 0;
}

export async function probe(path: string): Promise<ProbeResult> {
  const { stdout } = await exec(
    ffprobePath,
    ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', path],
    { maxBuffer: 16 * 1024 * 1024, windowsHide: true },
  );
  const raw = JSON.parse(stdout) as { streams?: RawStream[]; format?: { duration?: string } };
  const streams = raw.streams ?? [];

  // Cover art shows up as a video stream on mp3s and mkvs, but it isn't one.
  const video = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  const audio = streams.find((s) => s.codec_type === 'audio');

  return {
    duration: Number(video?.duration ?? raw.format?.duration ?? audio?.duration) || 0,
    video: video && {
      index: video.index,
      width: video.width ?? 0,
      height: video.height ?? 0,
      fps: parseRate(video.avg_frame_rate) || parseRate(video.r_frame_rate),
      // Paletted PNGs and GIFs can carry transparency in the palette, which pix_fmt doesn't show.
      alpha:
        ALPHA_FORMAT.test(video.pix_fmt ?? '') ||
        vp9Alpha(video) ||
        (video.pix_fmt === 'pal8' && ['png', 'gif'].includes(video.codec_name ?? '')),
      needsLibvpx: vp9Alpha(video),
    },
    audio: audio && { index: audio.index },
  };
}
