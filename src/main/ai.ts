import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { access, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import type { AiStatus } from '../shared/types';
import { JobCancelled, type JobContext } from './ffmpeg';

/**
 * The AI add-on: Python, PyTorch and SAM 2.1, kept in one folder the app can delete. None of
 * it ships with the app. uv fetches a private Python and the packages on first use, so the
 * app itself stays small and nothing touches the system's own Python.
 */

const WINDOWS = process.platform === 'win32';
const MODEL = 'sam2.1 small';
const CHECKPOINT_URL = 'https://dl.fbaipublicfiles.com/segment_anything_2/092824/sam2.1_hiera_small.pt';
export const SAM2_CONFIG = 'configs/sam2.1/sam2.1_hiera_s.yaml';
// CUDA 12.6 wheels still cover Turing cards like the RTX 2070, and need no CUDA install of their own.
const TORCH_CUDA_INDEX = 'https://download.pytorch.org/whl/cu126';
const SAM2_VERSION = 'sam2==1.1.0';
const LOG_TAIL = 4000;
const READY_TIMEOUT_MS = 180_000;

const UV_ASSETS: Record<string, string> = {
  'win32-x64': 'uv-x86_64-pc-windows-msvc.zip',
  'win32-arm64': 'uv-aarch64-pc-windows-msvc.zip',
  'darwin-arm64': 'uv-aarch64-apple-darwin.tar.gz',
  'darwin-x64': 'uv-x86_64-apple-darwin.tar.gz',
  'linux-x64': 'uv-x86_64-unknown-linux-gnu.tar.gz',
  'linux-arm64': 'uv-aarch64-unknown-linux-gnu.tar.gz',
};

export function aiPaths(root: string) {
  return {
    root,
    uvDir: join(root, 'uv'),
    venv: join(root, 'venv'),
    python: WINDOWS ? join(root, 'venv', 'Scripts', 'python.exe') : join(root, 'venv', 'bin', 'python'),
    checkpoint: join(root, 'sam2.1_hiera_small.pt'),
    server: join(root, 'server.py'),
    ready: join(root, 'ready.json'),
  };
}

/** Everything uv downloads stays inside the add-on's folder. */
const uvEnv = (root: string): NodeJS.ProcessEnv => ({
  ...process.env,
  UV_CACHE_DIR: join(root, 'cache'),
  UV_PYTHON_INSTALL_DIR: join(root, 'python'),
  UV_NO_PROGRESS: '1',
});

export async function aiStatus(root: string): Promise<AiStatus> {
  try {
    const ready = JSON.parse(await readFile(aiPaths(root).ready, 'utf8')) as { gpu: string | null; model: string };
    await access(aiPaths(root).python);
    return { installed: true, gpu: ready.gpu, model: ready.model };
  } catch {
    return { installed: false, gpu: null, model: null };
  }
}

/** Runs a program, collecting its output for the error message if it fails. */
function run(command: string, args: string[], options: { env?: NodeJS.ProcessEnv; signal: AbortSignal; onLine?: (line: string) => void }) {
  return new Promise<string>((resolve, reject) => {
    if (options.signal.aborted) return reject(new JobCancelled());
    const child = spawn(command, args, { env: options.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    const take = (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      log = (log + text).slice(-LOG_TAIL);
      for (const line of text.split(/\r?\n/)) if (line.trim()) options.onLine?.(line.trim());
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    const onAbort = () => child.kill();
    options.signal.addEventListener('abort', onAbort, { once: true });
    child.on('error', (error) => {
      options.signal.removeEventListener('abort', onAbort);
      reject(error);
    });
    child.on('close', (code) => {
      options.signal.removeEventListener('abort', onAbort);
      if (options.signal.aborted) reject(new JobCancelled());
      else if (code === 0) resolve(log);
      else reject(new Error(`${command} failed (${code}):\n${log.trim()}`));
    });
  });
}

/** Downloads a file, reporting progress as a fraction when the size is known. */
async function download(url: string, path: string, signal: AbortSignal, onProgress: (fraction: number) => void) {
  const response = await fetch(url, { signal });
  if (!response.ok || !response.body) throw new Error(`Download failed (${response.status}): ${url}`);
  const total = Number(response.headers.get('content-length')) || 0;
  let received = 0;
  const body = Readable.fromWeb(response.body as WebReadableStream);
  body.on('data', (chunk: Buffer) => {
    received += chunk.length;
    if (total) onProgress(received / total);
  });
  const partial = `${path}.part`;
  await pipeline(body, createWriteStream(partial));
  await rename(partial, path);
}

async function findFile(dir: string, name: string): Promise<string | null> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  const found = entries.find((entry) => entry.isFile() && entry.name === name);
  return found ? join(found.parentPath, found.name) : null;
}

async function hasNvidiaGpu(signal: AbortSignal): Promise<boolean> {
  try {
    const output = await run('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader'], { signal });
    return output.trim().length > 0;
  } catch (error) {
    if (error instanceof JobCancelled) throw error;
    return false;
  }
}

/**
 * Sets up the add-on from nothing. Each step can be re-run, so a cancelled or failed install
 * picks up where it stopped when tried again.
 */
export async function installAiPack(root: string, serverSource: string, ctx: JobContext): Promise<AiStatus> {
  const paths = aiPaths(root);
  const { signal } = ctx;
  const env = uvEnv(root);
  await mkdir(paths.uvDir, { recursive: true });
  const step = (index: number, fraction: number, stage?: string) => ctx.report((index + fraction) / 6, stage);

  // 1. uv, which brings Python and the packages.
  const uvName = WINDOWS ? 'uv.exe' : 'uv';
  let uv = await findFile(paths.uvDir, uvName);
  if (!uv) {
    const asset = UV_ASSETS[`${process.platform}-${process.arch}`];
    if (!asset) throw new Error(`The AI pack doesn't support ${process.platform} ${process.arch} yet.`);
    const archive = join(paths.uvDir, asset);
    step(0, 0, 'Downloading uv');
    await download(`https://github.com/astral-sh/uv/releases/latest/download/${asset}`, archive, signal, (f) => step(0, f));
    // Windows 10 and later ship a tar that reads zips too. Call it by its full path: a GNU tar
    // earlier on PATH (Git for Windows, MSYS) reads "C:\..." as a remote host and fails.
    const tar = WINDOWS ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
    await run(tar, ['-xf', archive, '-C', paths.uvDir], { signal });
    uv = await findFile(paths.uvDir, uvName);
    if (!uv) throw new Error('uv was downloaded but its program could not be found.');
  }

  // 2. A private Python.
  step(1, 0, 'Setting up Python');
  try {
    await access(paths.python);
  } catch {
    await run(uv, ['venv', '--python', '3.11', paths.venv], { env, signal });
  }

  // 3. PyTorch, the CUDA build when there's an NVIDIA card.
  const nvidia = await hasNvidiaGpu(signal);
  step(2, 0, nvidia ? 'Installing PyTorch for your NVIDIA GPU (big download)' : 'Installing PyTorch (CPU)');
  const torchIndex = nvidia ? ['--index-url', TORCH_CUDA_INDEX] : [];
  await run(uv, ['pip', 'install', '--python', paths.python, 'torch', 'torchvision', ...torchIndex], {
    env,
    signal,
    onLine: (line) => step(2, 0.5, `PyTorch: ${line.slice(0, 80)}`),
  });

  // 4. SAM 2. Its optional CUDA extension needs a compiler, and it only speeds up a clean-up step.
  step(3, 0, 'Installing SAM 2.1');
  await run(uv, ['pip', 'install', '--python', paths.python, 'setuptools', 'wheel', 'numpy', 'pillow'], { env, signal });
  await run(uv, ['pip', 'install', '--python', paths.python, '--no-build-isolation', SAM2_VERSION], {
    env: { ...env, SAM2_BUILD_CUDA: '0' },
    signal,
  });

  // 5. The model weights.
  try {
    await access(paths.checkpoint);
  } catch {
    step(4, 0, 'Downloading the SAM 2.1 model');
    await download(CHECKPOINT_URL, paths.checkpoint, signal, (f) => step(4, f));
  }

  // 6. Load it once, which proves it works and says what it runs on.
  step(5, 0, 'Checking it works');
  await writeFile(paths.server, serverSource);
  const sidecar = new AiSidecar(paths.python, [paths.server, '--checkpoint', paths.checkpoint, '--config', SAM2_CONFIG]);
  try {
    const ready = await sidecar.start();
    const status: AiStatus = { installed: true, gpu: ready.gpu ?? null, model: MODEL };
    await writeFile(paths.ready, JSON.stringify({ gpu: status.gpu, model: MODEL, device: ready.device }));
    return status;
  } finally {
    sidecar.stop();
  }
}

export async function removeAiPack(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true });
}

interface Pending {
  resolve(value: Record<string, unknown>): void;
  reject(error: Error): void;
  onProgress?: (fraction: number) => void;
}

export interface SidecarReady {
  backend: string;
  device: string;
  gpu: string | null;
}

/**
 * The Python helper, kept running between requests so the model loads once. It reads one JSON
 * request per line and answers in kind; see server.py.
 */
export class AiSidecar {
  private child: ChildProcess | null = null;
  private starting: Promise<SidecarReady> | null = null;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private stderr = '';

  constructor(
    private readonly python: string,
    private readonly args: string[],
  ) {}

  /** Starts the helper if it isn't running, and resolves once the model has loaded. */
  start(): Promise<SidecarReady> {
    if (this.starting) return this.starting;
    this.starting = new Promise<SidecarReady>((resolve, reject) => {
      const child = spawn(this.python, ['-u', ...this.args], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      this.child = child;
      let buffer = '';
      let ready = false;
      const timer = setTimeout(() => {
        if (!ready) fail(new Error('The AI helper took too long to start.'));
      }, READY_TIMEOUT_MS);

      const fail = (error: Error) => {
        clearTimeout(timer);
        if (!ready) reject(error);
        for (const pending of this.pending.values()) pending.reject(error);
        this.pending.clear();
        this.child = null;
        this.starting = null;
        child.kill();
      };

      child.stderr!.setEncoding('utf8').on('data', (text: string) => {
        this.stderr = (this.stderr + text).slice(-LOG_TAIL);
      });
      child.stdout!.setEncoding('utf8').on('data', (text: string) => {
        buffer += text;
        let newline: number;
        while ((newline = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (!line) continue;
          let message: Record<string, unknown>;
          try {
            message = JSON.parse(line) as Record<string, unknown>;
          } catch {
            // Libraries sometimes print to stdout. Anything that isn't a message is ignored.
            continue;
          }
          if ('ready' in message) {
            if (message['ready']) {
              ready = true;
              clearTimeout(timer);
              resolve(message as unknown as SidecarReady);
            } else {
              fail(new Error(String(message['error'] ?? 'The AI model failed to load.')));
            }
            continue;
          }
          const pending = this.pending.get(message['id'] as number);
          if (!pending) continue;
          if ('progress' in message) {
            pending.onProgress?.(Number(message['progress']));
          } else {
            this.pending.delete(message['id'] as number);
            if (message['ok']) pending.resolve(message);
            else pending.reject(new Error(String(message['error'] ?? 'The AI helper failed.')));
          }
        }
      });
      child.on('error', (error) => fail(error));
      child.on('close', (code) => {
        if (this.child === child) fail(new Error(`The AI helper stopped (${code}).${this.stderr ? `\n${this.stderr.trim()}` : ''}`));
      });
    });
    return this.starting;
  }

  async request(
    command: string,
    payload: Record<string, unknown> = {},
    options: { onProgress?: (fraction: number) => void; signal?: AbortSignal } = {},
  ): Promise<Record<string, unknown>> {
    await this.start();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      // A cancelled request can't be stopped halfway in Python, so the helper restarts instead.
      const onAbort = () => {
        this.pending.delete(id);
        this.stop();
        reject(new JobCancelled());
      };
      if (options.signal?.aborted) return onAbort();
      options.signal?.addEventListener('abort', onAbort, { once: true });
      const settle = <T>(done: (value: T) => void) => (value: T) => {
        options.signal?.removeEventListener('abort', onAbort);
        done(value);
      };
      this.pending.set(id, { resolve: settle(resolve), reject: settle(reject), onProgress: options.onProgress });
      this.child!.stdin!.write(`${JSON.stringify({ id, cmd: command, ...payload })}\n`);
    });
  }

  stop(): void {
    const child = this.child;
    this.child = null;
    this.starting = null;
    for (const pending of this.pending.values()) pending.reject(new JobCancelled());
    this.pending.clear();
    child?.kill();
  }
}
