import { File, Folder, HardDrive } from 'lucide-react';
import { entryDate, entrySize, entryType, SORTS, textKey, type ExplorerEntry, type ExplorerProps } from './model';
import type { ExplorerState } from './useExplorer';
import type { ExplorerActions } from './useExplorerActions';

export function EntryIcon({ entry, root = false }: { entry: ExplorerEntry; root?: boolean }) {
  const Icon = root ? HardDrive : entry.directory ? Folder : File;
  return <Icon className={`pe-entry-icon ${entry.directory && !root ? 'pe-folder-icon' : ''}`} aria-hidden="true" />;
}

export function ExplorerEntries({ state, props, actions }: {
  state: ExplorerState; props: ExplorerProps; actions: ExplorerActions;
}) {
  const { t, locale } = props;
  return <div className={`pe-files pe-view-${state.view}`} role="listbox" aria-label={t(textKey('selection'))}
    aria-busy={state.loading} tabIndex={0} onKeyDown={event => {
      if (event.target !== event.currentTarget && !(event.target instanceof HTMLButtonElement)) return;
      const index = state.entries.findIndex(entry => entry.path === state.selected);
      const delta = event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : -1;
      if (['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? state.entries.length - 1
          : Math.max(0, Math.min(state.entries.length - 1, index + delta));
        const entry = state.entries[next];
        if (entry && !actions.busy) {
          state.setSelected(entry.path);
          event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="option"]')[next]?.focus();
        }
      }
    }}>
    {state.view === 'details' && <div className="pe-columns">
      {SORTS.map(sort => <button type="button" key={sort} disabled={actions.busy}
        onClick={() => { if (sort === state.sort) state.setDescending(!state.descending); else state.setSort(sort); }}>
        {t(textKey(sort))}{state.sort === sort && <span aria-hidden="true">{state.descending ? ' ↓' : ' ↑'}</span>}
      </button>)}
    </div>}
    <div className="pe-items">{state.entries.map(entry => <button type="button" key={entry.path}
      role="option" aria-selected={state.selected === entry.path} data-path={entry.path}
      className="pe-entry" disabled={actions.busy} title={entry.name}
      data-cut={actions.clipboard?.cut && actions.clipboard.entry.path === entry.path || undefined}
      onClick={() => state.setSelected(entry.path)}
      onDoubleClick={() => { if (entry.directory) state.navigate(entry.path); }}
      onKeyDown={event => {
        if (event.key === 'Enter' && entry.directory) { event.preventDefault(); state.navigate(entry.path); }
      }}>
      <span className="pe-entry-name"><EntryIcon entry={entry} root={!state.directory} /><span>{entry.name}</span></span>
      <span className="pe-entry-date">{entryDate(entry, locale)}</span>
      <span className="pe-entry-type">{entryType(entry, t)}</span>
      <span className="pe-entry-size">{entrySize(entry, locale)}</span>
    </button>)}</div>
    {state.loading && <p className="pe-empty" role="status">{t('client.downloads.readingFolder')}</p>}
    {state.error && <div className="pe-empty"><p role="alert">{t(textKey('loadError'))}</p>
      <button type="button" onClick={state.refresh}>{t('client.terminal.retry')}</button></div>}
    {!state.loading && !state.error && !state.entries.length
      && <p className="pe-empty">{t(textKey(state.query ? 'noMatches' : 'empty'))}</p>}
    {state.result?.truncated && <p className="pe-notice">{t(textKey('truncated'))}</p>}
  </div>;
}

export function ExplorerDetails({ state, props }: { state: ExplorerState; props: ExplorerProps }) {
  const { t, locale } = props;
  const entry = state.selection;
  return <aside className="pe-details" aria-label={t(textKey('details'))}>
    {entry ? <><EntryIcon entry={entry} root={!state.directory} /><h3>{entry.name}</h3><dl>
      <dt>{t(textKey('type'))}</dt><dd>{entryType(entry, t)}</dd>
      <dt>{t(textKey('modified'))}</dt><dd>{entryDate(entry, locale)}</dd>
      {!entry.directory && <><dt>{t(textKey('size'))}</dt><dd>{entrySize(entry, locale)}</dd></>}
      <dt>{t(textKey('location'))}</dt><dd>{entry.path}</dd>
    </dl></> : <p>{t(textKey('chooseHint'))}</p>}
  </aside>;
}
