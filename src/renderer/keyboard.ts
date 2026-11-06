import { useEffect } from 'react';
import { firePinned } from './effects/apply';
import { openProject, saveProject } from './persistence';
import { useStudio } from './store/project';
import {
  deleteSelection,
  duplicateSelection,
  markIn,
  markOut,
  splitAtPlayhead,
} from './timeline/commands';
import { stepBy, toggleLoop, toggleMute, togglePlay } from './timeline/transport';

function actionFor(event: KeyboardEvent): (() => void) | null {
  const { fps } = useStudio.getState().project.settings;
  const { undo, redo } = useStudio.getState();
  const key = event.key.toLowerCase();

  if (event.ctrlKey || event.metaKey) {
    if (key === 'z') return event.shiftKey ? redo : undo;
    if (key === 'd') return duplicateSelection;
    if (key === 's') return () => void saveProject();
    if (key === 'o') return () => void openProject();
    return null;
  }

  if (/^[1-9]$/.test(key)) return event.repeat ? null : () => firePinned(Number(key) - 1);

  const step = event.shiftKey ? 1 : 1 / fps;
  switch (key) {
    case ' ':
      return event.repeat ? null : togglePlay;
    case 'arrowleft':
      return () => stepBy(-step);
    case 'arrowright':
      return () => stepBy(step);
    case 'i':
      return markIn;
    case 'o':
      return markOut;
    case 's':
      return splitAtPlayhead;
    case 'm':
      return event.repeat ? null : toggleMute;
    case 'delete':
      return deleteSelection;
    case 'l':
      return event.repeat ? null : toggleLoop;
    default:
      return null;
  }
}

export function useKeyboardShortcuts(): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (target.matches('input[type="text"], input[type="number"], textarea, select')) return;
      if (target.closest('.popover, .modal')) return;
      const action = actionFor(event);
      if (!action) return;
      event.preventDefault();
      action();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}
