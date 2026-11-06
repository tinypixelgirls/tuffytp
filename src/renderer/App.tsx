import { useEffect } from 'react';
import { EffectPalette } from './components/EffectPalette';
import { MediaBin } from './components/MediaBin';
import { Preview } from './components/Preview';
import { StatusBar } from './components/StatusBar';
import { Timeline } from './components/Timeline';
import { Toasts } from './components/Toasts';
import { useKeyboardShortcuts } from './keyboard';
import { startProject } from './persistence';
import { useStudio } from './store/project';

export function App() {
  useEffect(() => {
    void window.ytp.listEffects().then((effects) => useStudio.setState({ effects }));
    void startProject();
    return window.ytp.onJobUpdate((job) => {
      const { upsertJob, pushToast } = useStudio.getState();
      upsertJob(job);
      // A failed import keeps its card in the bin; nothing else has a place to show it.
      if (job.status === 'failed' && job.kind !== 'import') {
        pushToast('error', `${job.label} failed: ${job.error}`);
        useStudio.getState().dismissJob(job.id);
      }
    });
  }, []);
  useKeyboardShortcuts();

  return (
    <div className="app">
      <MediaBin />
      <Preview />
      <EffectPalette />
      <Timeline />
      <StatusBar />
      <Toasts />
    </div>
  );
}
