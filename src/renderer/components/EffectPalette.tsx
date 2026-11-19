import { useMemo, useState, type MouseEvent } from 'react';
import { defaultParams, type EffectCategory, type EffectInfo } from '../../shared/effects';
import { applyEffect, effectHistory, fullPoop, togglePin } from '../effects/apply';
import { hasEffectTarget, useStudio } from '../store/project';
import { selectClip } from '../timeline/commands';
import { clipStarts } from '../timeline/model';
import { seekTimeline } from '../timeline/transport';
import { EffectParamsPopover } from './EffectParamsPopover';
import { Inspector } from './Inspector';

const CATEGORIES: { id: EffectCategory; title: string; tab: string }[] = [
  { id: 'audio+video', title: 'Audio + video', tab: 'A+V' },
  { id: 'audio', title: 'Audio', tab: 'Audio' },
  { id: 'video', title: 'Video', tab: 'Video' },
  { id: 'glitch', title: 'Glitch', tab: 'Glitch' },
  { id: 'meme', title: 'Memes', tab: 'Memes' },
  { id: 'combo', title: 'Combos', tab: 'Combos' },
];

const WIDE_EFFECTS = new Set(['chaos', 'ultrachaos']);

export function EffectPalette() {
  const effects = useStudio((state) => state.effects);
  const hasSelection = useStudio(hasEffectTarget);
  const [editing, setEditing] = useState<EffectInfo | null>(null);
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState<EffectCategory | 'all'>('all');

  const visible = useMemo(() => {
    const words = query.trim().toLowerCase();
    return effects.filter(
      (effect) =>
        (words ? true : tab === 'all' || effect.category === tab) &&
        (!words || `${effect.label} ${effect.description}`.toLowerCase().includes(words)),
    );
  }, [effects, query, tab]);

  return (
    <section className="panel palette">
      <div className="palette-head">
        <h2>Effects</h2>
        <input
          className="effect-search"
          type="text"
          placeholder={`Search ${effects.length} effects`}
          aria-label="Search effects"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              setQuery('');
              event.currentTarget.blur();
            }
          }}
        />
      </div>
      <div className="palette-tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'all'} className={tab === 'all' ? 'tab active' : 'tab'} onClick={() => setTab('all')}>
          All
        </button>
        {CATEGORIES.map(({ id, tab: label }) => (
          <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'tab active' : 'tab'} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>
      <div className="palette-scroll">
        <Inspector />
        {CATEGORIES.map(({ id, title }) => {
          const group = visible.filter((effect) => effect.category === id);
          if (group.length === 0 && (query || id !== 'combo' || (tab !== 'all' && tab !== 'combo'))) return null;
          return (
            <div key={id} className={`effect-group category-${id.replace('+', '-')}`}>
              <h3>{title}</h3>
              <div className="effect-grid">
                {group.map((effect) => (
                  <EffectButton key={effect.id} effect={effect} enabled={hasSelection} onEdit={() => setEditing(effect)} />
                ))}
                {id === 'combo' && !query && <FullPoopButton />}
              </div>
            </div>
          );
        })}
        {visible.length === 0 && <p className="placeholder">Nothing matches that. Yet.</p>}
        <EffectHistory />
      </div>
      {editing && <EffectParamsPopover effect={editing} onClose={() => setEditing(null)} />}
    </section>
  );
}

function FullPoopButton() {
  const hasClips = useStudio((state) => state.project.timeline.length > 0);
  const busy = useStudio((state) => state.effectQueue.length > 0);
  const running = useStudio((state) => state.effectQueue.includes('fullpoop'));

  return (
    <div className={running ? 'effect full-poop busy' : 'effect full-poop'}>
      <button
        className="effect-button"
        data-effect="fullpoop"
        disabled={!hasClips || busy}
        title="Throws random effects at random spots across the whole timeline. Needs no selection. Ctrl+Z undoes all of it."
        onClick={() => void fullPoop()}
      >
        💩 FULL POOP
      </button>
    </div>
  );
}

function EffectButton({ effect, enabled, onEdit }: { effect: EffectInfo; enabled: boolean; onEdit(): void }) {
  const busy = useStudio((state) => state.effectQueue.includes(effect.id));
  const pin = useStudio((state) => state.pins.indexOf(effect.id));
  const hasParams = effect.params.length > 0;

  const onClick = (event: MouseEvent) => {
    if (event.shiftKey && hasParams) onEdit();
    else applyEffect(effect.id, defaultParams(effect.params));
  };

  const hints = [effect.description, hasParams && 'Shift+click for settings.', 'Right-click to pin to a number key.'];

  return (
    <div
      className={`effect${busy ? ' busy' : ''}${WIDE_EFFECTS.has(effect.id) ? ' chaos' : ''}`}
      onContextMenu={(event) => {
        event.preventDefault();
        togglePin(effect.id);
      }}
    >
      <button
        className="effect-button"
        disabled={!enabled}
        title={hints.filter(Boolean).join(' ')}
        data-effect={effect.id}
        onClick={onClick}
      >
        {effect.label}
      </button>
      {pin !== -1 && <span className="effect-pin">{pin + 1}</span>}
      {hasParams && (
        <button className="effect-gear" aria-label={`${effect.label} settings`} title="Settings" onClick={onEdit}>
          ⚙
        </button>
      )}
    </div>
  );
}

function EffectHistory() {
  // Read fresh on every change: it's derived from the timeline, so undo keeps it honest.
  useStudio((state) => state.project.timeline);
  const entries = effectHistory();
  if (entries.length === 0) return null;

  const select = (clipIndex: number) => {
    selectClip(clipIndex);
    seekTimeline(clipStarts(useStudio.getState().project.timeline)[clipIndex]);
  };

  return (
    <div className="effect-history">
      <h3>History</h3>
      {entries.map(({ clipId, clipIndex, text }) => (
        <button key={clipId} className="history-entry" title={text} onClick={() => select(clipIndex)}>
          {text}
        </button>
      ))}
    </div>
  );
}
