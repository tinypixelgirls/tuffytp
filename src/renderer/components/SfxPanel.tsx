import { useCallback, useEffect, useState } from 'react';
import type { SfxEntry } from '../../shared/types';
import { fileName } from '../format';
import { loadSfxFolder, mediaForSfx, saveSfxFolder } from '../sfx';
import { useStudio } from '../store/project';
import { appendMedia } from '../timeline/commands';
import { SFX_DRAG_TYPE } from './MediaBin';

export function SfxPanel() {
  const [folder, setFolder] = useState(loadSfxFolder);
  const [entries, setEntries] = useState<SfxEntry[]>([]);

  const refresh = useCallback(() => {
    if (folder) void window.ytp.listSfx(folder).then(setEntries);
  }, [folder]);

  useEffect(refresh, [refresh]);

  const choose = async () => {
    const picked = await window.ytp.pickSfxFolder();
    if (!picked) return;
    saveSfxFolder(picked);
    setFolder(picked);
  };

  const audition = async (entry: SfxEntry) => {
    const media = await mediaForSfx(entry.path);
    if (media) useStudio.getState().playInPreview(media.id);
  };

  const add = async (entry: SfxEntry) => {
    const media = await mediaForSfx(entry.path);
    if (media) appendMedia([media.id]);
  };

  return (
    <>
      <div className="sfx-folder">
        <button className="tool" onClick={() => void choose()}>
          {folder ? 'Change folder' : 'Choose folder'}
        </button>
        {folder && (
          <>
            <span className="sfx-path" title={folder}>
              {fileName(folder)}
            </span>
            <button className="tool" onClick={refresh}>
              Refresh
            </button>
          </>
        )}
      </div>
      <div className="bin-list">
        {entries.map((entry) => (
          <div
            key={entry.path}
            className="media-row"
            draggable
            onDragStart={(event) => event.dataTransfer.setData(SFX_DRAG_TYPE, entry.path)}
          >
            <button className="media-card" title={`Listen to ${entry.name}`} onClick={() => void audition(entry)}>
              <span className="sfx-icon">{entry.kind === 'audio' ? '♪' : '▣'}</span>
              <span className="media-info">
                <span className="media-name">{entry.name}</span>
              </span>
            </button>
            <button
              className="add-button"
              aria-label={`Add ${entry.name} to the timeline`}
              title="Add to the end of the timeline"
              onClick={() => void add(entry)}
            >
              +
            </button>
          </div>
        ))}
        {entries.length === 0 && (
          <p className="placeholder">
            {folder ? 'No sounds or images in that folder.' : 'Pick a folder of sound effects and images.'}
          </p>
        )}
      </div>
    </>
  );
}
