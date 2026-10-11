import { useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Drawer } from 'antd';
import { GitBranch, Maximize2, Minimize2, Minus, PanelRightOpen, X } from 'lucide-react';
import { WorkspaceDrawerContext } from '../../../../../shared/chat/workspaceDrawer';
import { useDrawerResize } from '../../../../desktop/src/pages/codexGui/useDrawerResize';
import styles from '../../../../desktop/src/pages/codexGui/DetailsWorkspace.module.less';
import { useDesktopLayout } from '../../useDesktopLayout';
import { useGitTheme } from './gitTheme';
import { t } from '../../i18n';
import './gitDrawer.less';

const MIN_CHAT_WIDTH = 520;

export function GitDrawer({ active, desktopDiffs, deviceName, onClose, onVisibilityChange, children }: {
  active: boolean; desktopDiffs?: boolean; deviceName?: string; onClose: () => void;
  onVisibilityChange: (visible: boolean) => void;
  children: (visible: boolean) => ReactNode;
}) {
  const workspace = useContext(WorkspaceDrawerContext);
  const desktop = useDesktopLayout();
  const internal = desktop || Boolean(desktopDiffs);
  const theme = useGitTheme(Boolean(desktopDiffs));
  const host = useMemo(() => ({ current: workspace?.host ?? null }), [workspace?.host]);
  const resize = useDrawerResize(host, { storageKey: 'codex-switch:git-width', defaultWidth: 800, defaultRatio: .8 });
  const [minimized, setMinimized] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [pageVisible, setPageVisible] = useState(document.visibilityState !== 'hidden');
  const closeButton = useRef<HTMLButtonElement>(null);
  const opener = useRef(document.activeElement);
  const id = useId();
  const visible = active && workspace?.active !== false && (!internal || !minimized);
  const width = expanded ? resize.available : resize.width;
  const reserve = workspace?.reserve;
  useEffect(() => { onVisibilityChange(visible && pageVisible); }, [visible, pageVisible, onVisibilityChange]);
  useEffect(() => {
    reserve?.(internal && visible && !expanded && resize.available - width >= MIN_CHAT_WIDTH ? width : 0);
    return () => reserve?.(0);
  }, [reserve, internal, visible, expanded, resize.available, width]);
  useEffect(() => {
    const update = () => setPageVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);
  useEffect(() => {
    if (visible && internal) closeButton.current?.focus();
    if (!visible || expanded) resize.cancel();
  }, [visible, internal, expanded, resize.cancel, host]);
  useEffect(() => () => { if (opener.current instanceof HTMLElement) opener.current.focus(); }, []);
  const content = children(visible && pageVisible);
  if (!internal) return <Drawer open={active} title="Git" placement="bottom" height="90%" onClose={onClose}
    rootStyle={theme} rootClassName="chat-terminal-drawer chat-git-drawer"
    closable={{ 'aria-label': t('关闭 Git'), placement: 'end' }}
    extra={<span className="chat-terminal-device">{deviceName}</span>}>{content}</Drawer>;
  if (!workspace?.host) return null;
  return createPortal(<div className="git-workspace-drawer chat-git-drawer" style={theme}>
    <aside id={id} hidden={!visible} role="dialog" aria-label="Git" className={`${styles.drawer} git-drawer-surface`}
      style={{ width }} data-dragging={resize.dragging || undefined}
      onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); onClose(); } }}>
      {!expanded && <div className={styles.resizeHandle} role="separator" tabIndex={0}
        aria-label={t('调整 Git 抽屉宽度')} aria-orientation="vertical" aria-controls={id}
        aria-valuemin={resize.minimum} aria-valuemax={resize.maximum} aria-valuenow={width} {...resize.handle} />}
      <header className={styles.header}>
        <span className="git-drawer-title"><GitBranch size={16} />Git</span>
        <span className="chat-terminal-device">{deviceName}</span>
        <div className={styles.controls}>
          <button aria-label={t(expanded ? '还原 Git 宽度' : '展开 Git')} onClick={() => setExpanded(!expanded)}>
            {expanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}</button>
          <button aria-label={t('最小化 Git')} onClick={() => setMinimized(true)}><Minus size={16} /></button>
          <button ref={closeButton} aria-label={t('关闭 Git')} onClick={onClose}><X size={17} /></button>
        </div>
      </header>
      <div className="git-drawer-body">{content}</div>
    </aside>
    {minimized && active && workspace.active && <button className={`${styles.restore} git-drawer-surface`}
      onClick={() => setMinimized(false)}><PanelRightOpen size={16} />{t('恢复 Git')}</button>}
  </div>, workspace.host);
}
