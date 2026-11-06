import { useEffect, useState } from 'react';
import { forgetRenders } from '../effects/apply';
import { useStudio } from '../store/project';
import { ProgressBar } from './MediaBin';

function formatSize(bytes: number): string {
  if (bytes < 1024 ** 2) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 ** 3) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

/** Everything the project could still need: the bin, the timeline, and every undo step. */
function mediaInUse(): string[] {
  const { project, past, future } = useStudio.getState();
  const imports = Object.values(project.media).filter((media) => media.origin.kind === 'import');
  const timelines = [project.timeline, ...past.map((step) => step.timeline), ...future.map((step) => step.timeline)];
  const clips = timelines.flat().map((clip) => clip.mediaId);
  return [...new Set([...imports.map((media) => media.id), ...clips])];
}

export function StatusBar() {
  const jobs = useStudio((state) => state.jobs);
  const settings = useStudio((state) => state.project.settings);
  const [cacheBytes, setCacheBytes] = useState(0);

  const running = jobs.find((job) => job.status === 'running');
  const queued = jobs.filter((job) => job.status === 'queued').length;
  const busy = jobs.length > 0;

  // Measured whenever work settles: that's the only time the cache changes.
  useEffect(() => {
    if (!busy) void window.ytp.cacheSize().then(setCacheBytes);
  }, [busy]);

  const clearCache = async () => {
    forgetRenders();
    await window.ytp.clearCache(mediaInUse());
    setCacheBytes(await window.ytp.cacheSize());
    useStudio.getState().pushToast('info', 'Cleared everything the project no longer needs.');
  };

  return (
    <footer className="status-bar">
      {running ? (
        <>
          <span className="status-text">
            {running.stage}: {running.label}
          </span>
          <ProgressBar value={running.progress} />
          <button
            className="icon-button"
            aria-label={`Cancel ${running.label}`}
            title="Cancel"
            onClick={() => window.ytp.cancelJob(running.id)}
          >
            ×
          </button>
          {queued > 0 && <span>{queued} queued</span>}
        </>
      ) : (
        <span className="status-text">Ready</span>
      )}
      <span className="status-settings">
        <span className="cache-size">Cache {formatSize(cacheBytes)}</span>
        <button className="link-button" disabled={busy} title="Delete files the project no longer needs" onClick={() => void clearCache()}>
          Clear cache
        </button>
        <span>
          {settings.width}×{settings.height} · {settings.fps} fps
        </span>
      </span>
    </footer>
  );
}
