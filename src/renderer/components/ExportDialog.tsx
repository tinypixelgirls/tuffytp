import { useState } from 'react';
import { overlayMediaIds } from '../../shared/layers';
import type { ExportQuality, ExportResolution } from '../../shared/types';
import { fileName } from '../format';
import { useStudio } from '../store/project';
import { buildSegments } from '../timeline/model';
import { ProgressBar } from './MediaBin';

const FRAME_RATES = [24, 25, 30, 60];

export function ExportDialog({ onClose }: { onClose(): void }) {
  const settings = useStudio((state) => state.project.settings);
  const job = useStudio((state) => state.jobs.find((candidate) => candidate.kind === 'export'));
  const [resolution, setResolution] = useState<ExportResolution>('keep');
  const [fps, setFps] = useState(settings.fps);
  const [quality, setQuality] = useState<ExportQuality>('house');
  const [running, setRunning] = useState(false);
  const [finished, setFinished] = useState<string | null>(null);

  const start = async () => {
    const outputPath = await window.ytp.pickExportPath();
    if (!outputPath) return;

    const { project } = useStudio.getState();
    const segments = buildSegments(project.timeline).map((segment) => {
      const media = project.media[segment.mediaId];
      return { path: media.path, in: segment.in, out: segment.out, mediaDuration: media.duration };
    });

    setRunning(true);
    setFinished(null);
    // Only the media the layers use goes along, not the whole bin.
    const layerMedia = Object.fromEntries(
      overlayMediaIds(project.layers).map((id) => {
        const { path, duration, alphaPath } = project.media[id];
        return [id, { path, duration, alphaPath }];
      }),
    );
    const composite = { layers: project.layers, media: layerMedia };
    const result = await window.ytp.exportTimeline({ segments, settings, resolution, fps, quality, outputPath, composite });
    setRunning(false);
    setFinished(result);
  };

  return (
    <div className="modal-backdrop">
      <div className="modal" role="dialog" aria-label="Export">
        <div className="popover-head">
          <strong>Export video</strong>
          <button className="icon-button" aria-label="Close" disabled={running} onClick={onClose}>
            ×
          </button>
        </div>

        {finished ? (
          <>
            <p className="popover-description">Saved {fileName(finished)}.</p>
            <div className="popover-actions">
              <button className="tool" onClick={() => setFinished(null)}>
                Export again
              </button>
              <button className="chunky small" onClick={() => void window.ytp.showInFolder(finished)}>
                Show in folder
              </button>
            </div>
          </>
        ) : running ? (
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
          <>
            <label className="param">
              Resolution
              <select value={resolution} onChange={(event) => setResolution(event.target.value as ExportResolution)}>
                <option value="keep">
                  Keep ({settings.width}×{settings.height})
                </option>
                <option value="720p">720p</option>
                <option value="1080p">1080p</option>
              </select>
            </label>
            <label className="param">
              Frame rate
              <select value={fps} onChange={(event) => setFps(Number(event.target.value))}>
                {FRAME_RATES.map((rate) => (
                  <option key={rate} value={rate}>
                    {rate} fps
                  </option>
                ))}
              </select>
            </label>
            <label className="param">
              Quality
              <select value={quality} onChange={(event) => setQuality(event.target.value as ExportQuality)}>
                <option value="house">Fast, as edited</option>
                <option value="high">High, slower</option>
                <option value="draft">Draft, smaller file</option>
              </select>
            </label>
            <div className="popover-actions">
              <button className="chunky small" onClick={() => void start()}>
                Export
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
