import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ffprobePath } from './bin';

const exec = promisify(execFile);

export interface ProbeResult {
  /** Seconds, or 0 when the container doesn't say. */
  duration: number;
  video?: { index: number; width: number; height: number; fps: number };
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
  disposition?: { attached_pic?: number };
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
    },
    audio: audio && { index: audio.index },
  };
}
