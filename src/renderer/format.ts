const pad = (value: number) => String(value).padStart(2, '0');

/** Formats seconds as MM:SS.FF, where FF is the frame within the second. */
export function formatTimecode(seconds: number, fps: number): string {
  const totalFrames = Math.round(seconds * fps);
  const wholeSeconds = Math.floor(totalFrames / fps);
  const frames = totalFrames - Math.round(wholeSeconds * fps);
  return `${pad(Math.floor(wholeSeconds / 60))}:${pad(wholeSeconds % 60)}.${pad(frames)}`;
}

export function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}
