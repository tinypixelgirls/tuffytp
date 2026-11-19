import { useState, type CSSProperties, type DragEvent } from 'react';
import logoUrl from '../assets/logo.png';
import { mediaUrl, THUMBS_FILE } from '../../shared/media';
import type { JobState, MediaFile } from '../../shared/types';
import { formatTimecode, mediaName } from '../format';
import { newProject, openProject, saveProject } from '../persistence';
import { importPaths, useStudio } from '../store/project';
import { appendMedia } from '../timeline/commands';
import { addMediaToLayer } from '../timeline/layers';
import { SfxPanel } from './SfxPanel';

export const MEDIA_DRAG_TYPE = 'application/x-ytp-media';
export const SFX_DRAG_TYPE = 'application/x-ytp-sfx';

export function MediaBin() {
  const media = useStudio((state) => state.project.media);
  const sfxMedia = useStudio((state) => state.sfxMedia);
  const projectName = useStudio((state) => state.projectName);
  const jobs = useStudio((state) => state.jobs);
  const [dragging, setDragging] = useState(false);
  const [tab, setTab] = useState<'clips' | 'sfx'>('clips');

  // Rendered effects live on the timeline and sounds in their own tab; this is what was imported.
  const sfxIds = new Set(Object.values(sfxMedia));
  // Cutouts live here too: they're the cast for running gags.
  const items = Object.values(media).filter(
    (item) => (item.origin.kind === 'import' || item.origin.kind === 'cutout') && !sfxIds.has(item.id),
  );
  const binJobs = jobs.filter((job) => job.kind === 'import');

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    void importPaths([...event.dataTransfer.files].map((file) => window.ytp.pathForFile(file)));
  };

  const onDragLeave = (event: DragEvent) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
  };

  const onImportClick = async () => {
    await importPaths(await window.ytp.pickMediaFiles());
  };

  return (
    <section
      className={dragging ? 'panel bin bin-dragging' : 'panel bin'}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes('Files')) return;
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <h1 className="logo">
        <img className="logo-mark" src={logoUrl} alt="" />
        TUFFYTP
      </h1>
      <div className="project-row">
        <span className="project-name" title={projectName ?? 'Autosaved, but not saved as a project file yet'}>
          {projectName ?? 'Untitled'}
        </span>
        <button className="tool" onClick={() => void newProject()}>
          New
        </button>
        <button className="tool" title="Open a project (Ctrl+O)" onClick={() => void openProject()}>
          Open
        </button>
        <button className="tool" title="Save the project (Ctrl+S)" onClick={() => void saveProject()}>
          Save
        </button>
      </div>
      <button className="chunky" onClick={onImportClick}>
        + Import
      </button>
      <div className="bin-tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'clips'} className={tab === 'clips' ? 'tab active' : 'tab'} onClick={() => setTab('clips')}>
          Clips
        </button>
        <button role="tab" aria-selected={tab === 'sfx'} className={tab === 'sfx' ? 'tab active' : 'tab'} onClick={() => setTab('sfx')}>
          SFX
        </button>
      </div>
      {tab === 'sfx' ? (
        <SfxPanel />
      ) : (
        <div className="bin-list">
          {items.map((item) => (
            <MediaCard key={item.id} media={item} />
          ))}
          {binJobs.map((job) => (
            <JobCard key={job.id} job={job} />
          ))}
          {items.length === 0 && binJobs.length === 0 && (
            <p className="placeholder">Drop videos or audio here, or hit Import.</p>
          )}
        </div>
      )}
    </section>
  );
}

function MediaCard({ media }: { media: MediaFile }) {
  const selected = useStudio((state) => state.previewSource?.mediaId === media.id);
  const playInPreview = useStudio((state) => state.playInPreview);
  const hasTimeline = useStudio((state) => state.project.timeline.length > 0);
  const name = mediaName(media);

  // The sprite is a grid of tiles; scaling it to `cols` wide shows just the first one.
  const grid = media.thumbGrid;
  const thumbStyle: CSSProperties | undefined = grid && {
    backgroundImage: `url(${mediaUrl(media.id, THUMBS_FILE)})`,
    backgroundSize: `${grid.cols * 100}% ${grid.rows * 100}%`,
  };

  return (
    <div
      className={selected ? 'media-row selected' : 'media-row'}
      draggable
      onDragStart={(event) => event.dataTransfer.setData(MEDIA_DRAG_TYPE, media.id)}
    >
      <button className="media-card" onClick={() => playInPreview(media.id)} title={name}>
        <span className="thumb" style={thumbStyle} />
        <span className="media-info">
          <span className="media-name">{name}</span>
          <span className="media-meta">{formatTimecode(media.duration, media.fps)}</span>
        </span>
      </button>
      <button
        className="add-button"
        aria-label={`Add ${name} to the timeline`}
        title="Add to the end of the timeline"
        onClick={() => appendMedia([media.id])}
      >
        +
      </button>
      <button
        className="add-button layer-add"
        aria-label={`Put ${name} on a layer`}
        title="Put it on a layer at the playhead, over the main track"
        disabled={!hasTimeline}
        onClick={() => addMediaToLayer(media.id, useStudio.getState().playhead)}
      >
        ⧉
      </button>
    </div>
  );
}

function JobCard({ job }: { job: JobState }) {
  const dismissJob = useStudio((state) => state.dismissJob);
  const failed = job.status === 'failed';

  return (
    <div className={failed ? 'job-card failed' : 'job-card'}>
      <div className="job-head">
        <span className="media-name" title={job.label}>
          {job.label}
        </span>
        <button
          className="icon-button"
          aria-label={failed ? 'Dismiss' : 'Cancel'}
          title={failed ? 'Dismiss' : 'Cancel'}
          onClick={() => (failed ? dismissJob(job.id) : window.ytp.cancelJob(job.id))}
        >
          ×
        </button>
      </div>
      {failed ? (
        <p className="job-error">{job.error}</p>
      ) : (
        <>
          <ProgressBar value={job.progress} />
          <span className="media-meta">{job.stage}</span>
        </>
      )}
    </div>
  );
}

export function ProgressBar({ value }: { value: number | null }) {
  return (
    <div className={value === null ? 'progress indeterminate' : 'progress'}>
      <div className="progress-fill" style={value === null ? undefined : { width: `${value * 100}%` }} />
    </div>
  );
}
