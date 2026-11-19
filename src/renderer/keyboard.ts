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
import {
  addTextAtPlayhead,
  deleteSelectedOverlay,
  duplicateSelectedOverlay,
  splitSelectedOverlay,
  toggleKeyframeAtPlayhead,
} from './timeline/layers';
import { stepBy, toggleLoop, toggleMute, togglePlay } from './timeline/transport';

/** With a layer clip selected, the editing keys act on it rather than the main track. */
function layerActionFor(key: string, event: KeyboardEvent): (() => void) | null {
  if (event.ctrlKey || event.metaKey) return key === 'd' ? duplicateSelectedOverlay : null;
  switch (key) {
    case 'delete':
    case 'backspace':
      return deleteSelectedOverlay;
    case 's':
      return splitSelectedOverlay;
    case 'k':
      return event.repeat ? null : toggleKeyframeAtPlayhead;
    case 'escape':
      return () => useStudio.getState().selectOverlay(null);
    default:
      return null;
  }
}

function actionFor(event: KeyboardEvent): (() => void) | null {
  const { fps } = useStudio.getState().project.settings;
  const { undo, redo, overlay } = useStudio.getState();
  const key = event.key.toLowerCase();

  const layerAction = overlay ? layerActionFor(key, event) : null;
  if (layerAction) return layerAction;
  if (key === 't' && !event.ctrlKey && !event.metaKey && useStudio.getState().project.timeline.length > 0) {
    return addTextAtPlayhead;
  }

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
