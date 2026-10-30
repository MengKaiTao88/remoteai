import { useEffect, useRef, useState, type ComponentType } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, ArrowRight, Globe, Maximize2, Minimize2, Plus, RotateCw, X } from 'lucide-react';
import { marketText, type MarketText } from './i18n';
import type { Language } from '@remoteai/i18n';
import { pageUrl } from './pageLink';
import type { BrowserAction, BrowserTab } from './browserState';
import './providerBrowser.css';

export interface BrowserSurfaceProps {
  tab: BrowserTab; active: boolean; command: { sequence: number; action: BrowserAction } | null;
  onNavigate: (url: string) => void; t: MarketText;
  onPopup: (url: string) => void;
}
export interface BrowserWindowProps {
  open: boolean; tabs: BrowserTab[]; activeId: string; language: Language;
  onSelect: (id: string) => void; onCloseTab: (id: string) => void; onNewTab: () => void; onClose: () => void;
  onNavigate: (id: string, url: string) => void; onAction: (id: string, action: BrowserAction) => void;
  onPopup: (id: string, url: string) => void;
  commands: Record<string, BrowserSurfaceProps['command']>; Surface: ComponentType<BrowserSurfaceProps>;
}

function BrowserToolbar({ tab, fullscreen, toggleFullscreen, navigate, action, t }: {
  tab?: BrowserTab; fullscreen: boolean; toggleFullscreen: () => void;
  navigate: (url: string) => void; action: (action: BrowserAction) => void; t: MarketText;
}) {
  const [address, setAddress] = useState(tab?.url ?? '');
  const [invalid, setInvalid] = useState(false);
  useEffect(() => { setAddress(tab?.url ?? ''); setInvalid(false); }, [tab?.id, tab?.url]);
  return <div className="pm-browser-toolbar">
    <button aria-label={t('market.browserBack')} title={t('market.browserBack')}
      disabled={!tab?.url} onClick={() => action('back')}><ArrowLeft size={17} /></button>
    <button aria-label={t('market.browserForward')} title={t('market.browserForward')}
      disabled={!tab?.url} onClick={() => action('forward')}><ArrowRight size={17} /></button>
    <button aria-label={t('market.browserReload')} title={t('market.browserReload')}
      disabled={!tab?.url} onClick={() => action('reload')}><RotateCw size={17} /></button>
    <form onSubmit={(event) => {
      event.preventDefault();
      const url = pageUrl(address.trim());
      setInvalid(!url);
      if (url) navigate(url.toString());
    }}>
      <Globe size={15} /><input aria-label={t('market.browserAddress')} aria-invalid={invalid}
        value={address} onChange={(event) => { setAddress(event.target.value); setInvalid(false); }}
        placeholder="https://example.com" spellCheck={false} autoComplete="off" />
      <button type="submit" aria-label={t('market.visitPage')}><ArrowRight size={16} /></button>
    </form>
    <button aria-label={t(fullscreen ? 'market.browserRestore' : 'market.browserFullscreen')}
      title={t(fullscreen ? 'market.browserRestore' : 'market.browserFullscreen')} onClick={toggleFullscreen}>
      {fullscreen ? <Minimize2 size={17} /> : <Maximize2 size={17} />}</button>
    {invalid && <span className="pm-browser-address-error" role="alert">{t('market.browserInvalidUrl')}</span>}
  </div>;
}

export function ProviderBrowser(props: BrowserWindowProps) {
  const { tabs, activeId, open, Surface, commands } = props;
  const [fullscreen, setFullscreen] = useState(false);
  const t = marketText(props.language);
  const dialog = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.current?.focus();
    return () => { previous?.focus(); };
  }, [open]);
  const tab = tabs.find((entry) => entry.id === activeId);
  return createPortal(<div className="pm-browser-backdrop" hidden={!open}>
    <section ref={dialog} role="dialog" aria-modal="true" aria-label={t('market.browserTitle')} tabIndex={-1}
      className={`pm-browser${fullscreen ? ' pm-browser-fullscreen' : ''}`} onKeyDown={(event) => {
        if (event.key === 'Escape') { event.stopPropagation(); fullscreen ? setFullscreen(false) : props.onClose(); }
        if (event.key === 'Tab') {
          const elements = [...(dialog.current?.querySelectorAll<HTMLElement>(
            'button:not(:disabled), input, iframe') ?? [])].filter((element) => element.getClientRects().length);
          const first = elements[0]; const last = elements.at(-1);
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
          if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }
      }}>
      <div className="pm-browser-titlebar"><div className="pm-browser-tabs" role="tablist"
        aria-label={t('market.browserTabs')}>
        {tabs.map((entry) => <div className={`pm-browser-tab${entry.id === activeId ? ' active' : ''}`} key={entry.id}>
          <button role="tab" aria-selected={entry.id === activeId} aria-controls={`page-${entry.id}`}
            onClick={() => props.onSelect(entry.id)} title={entry.title || t('market.browserNewTab')}>
            <Globe size={14} /><span>{entry.title || t('market.browserNewTab')}</span></button>
          <button aria-label={t('market.browserCloseTab', { name: entry.title || t('market.browserNewTab') })}
            onClick={() => props.onCloseTab(entry.id)}><X size={14} /></button>
        </div>)}
      </div><button aria-label={t('market.browserNewTab')} title={t('market.browserNewTab')}
        onClick={props.onNewTab}><Plus size={17} /></button>
      <button aria-label={t('market.close')} title={t('market.close')} onClick={props.onClose}><X size={19} /></button></div>
      <BrowserToolbar tab={tab} fullscreen={fullscreen} toggleFullscreen={() => setFullscreen((value) => !value)}
        navigate={(url) => { if (tab) props.onNavigate(tab.id, url); }}
        action={(action) => { if (tab) props.onAction(tab.id, action); }} t={t} />
      <div className="pm-browser-pages">{tabs.map((entry) => <div key={entry.id} id={`page-${entry.id}`}
        role="tabpanel" className="pm-browser-page" hidden={entry.id !== activeId}>
        <Surface tab={entry} active={open && entry.id === activeId} command={commands[entry.id] ?? null}
          onNavigate={(url) => props.onNavigate(entry.id, url)} onPopup={(url) => props.onPopup(entry.id, url)} t={t} />
      </div>)}</div>
    </section>
  </div>, document.body);
}
