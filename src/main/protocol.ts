import { protocol } from 'electron';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname } from 'node:path';
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { MEDIA_SCHEME } from '../shared/media';
import { resolveCachePath } from './cache';

const CONTENT_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.jpg': 'image/jpeg',
  '.json': 'application/json',
};

/** Must run before the app is ready. */
export function registerMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: MEDIA_SCHEME,
      privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true, corsEnabled: true },
    },
  ]);
}

function parseRange(header: string | null, size: number): { start: number; end: number } | 'invalid' | null {
  const match = header?.match(/^bytes=(\d*)-(\d*)$/);
  if (!match) return null;
  const [, first, last] = match;
  if (!first && !last) return 'invalid';

  const start = first ? Number(first) : Math.max(0, size - Number(last));
  const end = first && last ? Math.min(Number(last), size - 1) : size - 1;
  return start > end ? 'invalid' : { start, end };
}

/** Serves cache files. <video> needs byte ranges to seek, so those are handled here. */
export function handleMediaProtocol(): void {
  protocol.handle(MEDIA_SCHEME, async (request) => {
    const url = new URL(request.url);
    const path = url.hostname === 'cache' ? resolveCachePath(decodeURIComponent(url.pathname.slice(1))) : null;
    if (!path) return new Response(null, { status: 403 });

    const size = await stat(path).then(
      (stats) => stats.size,
      () => null,
    );
    if (size === null) return new Response(null, { status: 404 });

    const headers: Record<string, string> = {
      'Content-Type': CONTENT_TYPES[extname(path)] ?? 'application/octet-stream',
      'Accept-Ranges': 'bytes',
      'Access-Control-Allow-Origin': '*',
    };

    const range = parseRange(request.headers.get('range'), size);
    if (range === 'invalid') {
      return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${size}` } });
    }

    const { start, end } = range ?? { start: 0, end: size - 1 };
    const body = Readable.toWeb(createReadStream(path, { start, end })) as WebReadableStream as ReadableStream;
    headers['Content-Length'] = String(end - start + 1);
    if (!range) return new Response(body, { status: 200, headers });

    headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    return new Response(body, { status: 206, headers });
  });
}
