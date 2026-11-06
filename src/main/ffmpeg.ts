import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { JobKind, JobState } from '../shared/types';
import { ffmpegPath } from './bin';

const STDERR_TAIL_BYTES = 4000;

export class JobCancelled extends Error {
  constructor() {
    super('Cancelled');
  }
}

export interface RunOptions {
  args: string[];
  /** Expected output duration in seconds, used to turn out_time into a fraction. */
  duration?: number;
  onProgress?: (fraction: number) => void;
  /** Receives raw stdout. Progress reporting is off in this mode because it shares the pipe. */
  onStdout?: (chunk: Buffer) => void;
  signal?: AbortSignal;
}

export function runFfmpeg({ args, duration, onProgress, onStdout, signal }: RunOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new JobCancelled());

    const progressArgs = onStdout ? [] : ['-progress', 'pipe:1', '-nostats'];
    const child = spawn(
      ffmpegPath,
      ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y', ...progressArgs, ...args],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    );

    const onAbort = () => child.kill();
    signal?.addEventListener('abort', onAbort, { once: true });

    let stderr = '';
    child.stderr.setEncoding('utf8').on('data', (text: string) => {
      stderr = (stderr + text).slice(-STDERR_TAIL_BYTES);
    });

    if (onStdout) {
      child.stdout.on('data', onStdout);
    } else {
      child.stdout.setEncoding('utf8').on('data', (text: string) => {
        if (!duration || !onProgress) return;
        // Each block holds several key=value lines; the last out_time_us is the freshest.
        const matches = [...text.matchAll(/^out_time_us=(\d+)/gm)];
        const latest = matches.at(-1);
        if (latest) onProgress(Math.min(1, Number(latest[1]) / 1e6 / duration));
      });
    }

    child.on('error', (error) => {
      signal?.removeEventListener('abort', onAbort);
      reject(error);
    });
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) reject(new JobCancelled());
      else if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `ffmpeg exited with code ${code}`));
    });
  });
}

/** The filter names this ffmpeg build supports, from `ffmpeg -filters`. */
export async function listFilters(): Promise<Set<string>> {
  let output = '';
  await runFfmpeg({ args: ['-filters'], onStdout: (chunk) => (output += chunk.toString('utf8')) });
  const names = [...output.matchAll(/^ [T.][S.][C.] (\S+)/gm)].map((match) => match[1]);
  return new Set(names);
}

export interface JobContext {
  signal: AbortSignal;
  report(progress: number | null, stage?: string): void;
}

interface Entry {
  state: JobState;
  controller: AbortController;
  start(): void;
}

/** Runs ffmpeg jobs one at a time, because each one already uses every core. */
export class JobQueue {
  private waiting: Entry[] = [];
  private active: Entry | null = null;

  constructor(private readonly onUpdate: (job: JobState) => void) {}

  add<T>(kind: JobKind, label: string, work: (ctx: JobContext) => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const controller = new AbortController();
      const entry: Entry = {
        state: { id: randomUUID(), kind, label, status: 'queued', stage: 'Queued', progress: 0 },
        controller,
        start: () => {
          this.update(entry, { status: 'running' });
          const report = (progress: number | null, stage = entry.state.stage) =>
            this.update(entry, { progress, stage });
          work({ signal: controller.signal, report })
            .then((value) => {
              this.update(entry, { status: 'done', progress: 1 });
              resolve(value);
            })
            .catch((error: unknown) => {
              if (error instanceof JobCancelled) this.update(entry, { status: 'cancelled' });
              else this.update(entry, { status: 'failed', error: String((error as Error).message ?? error) });
              reject(error);
            })
            .finally(() => {
              this.active = null;
              this.next();
            });
        },
      };
      controller.signal.addEventListener('abort', () => {
        const index = this.waiting.indexOf(entry);
        if (index === -1) return;
        this.waiting.splice(index, 1);
        this.update(entry, { status: 'cancelled' });
        reject(new JobCancelled());
      });
      this.waiting.push(entry);
      this.onUpdate(entry.state);
      this.next();
    });
  }

  cancel(jobId: string): void {
    const entries = this.active ? [this.active, ...this.waiting] : this.waiting;
    entries.find((entry) => entry.state.id === jobId)?.controller.abort();
  }

  cancelAll(): void {
    for (const entry of [...this.waiting]) entry.controller.abort();
    this.active?.controller.abort();
  }

  private next(): void {
    if (this.active) return;
    const entry = this.waiting.shift();
    if (!entry) return;
    this.active = entry;
    entry.start();
  }

  private update(entry: Entry, patch: Partial<JobState>): void {
    entry.state = { ...entry.state, ...patch };
    this.onUpdate(entry.state);
  }
}
