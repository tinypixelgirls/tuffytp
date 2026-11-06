import ffmpegStatic from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';

// A packaged app can't spawn from inside the asar, so the binaries are unpacked next to it.
const unpacked = (path: string) => path.replace('app.asar', 'app.asar.unpacked');

export const ffmpegPath = unpacked(ffmpegStatic as unknown as string);
export const ffprobePath = unpacked(ffprobeStatic.path);
