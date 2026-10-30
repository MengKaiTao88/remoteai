import { Dropdown, type MenuProps } from 'antd';
import { ArrowDownUp, Check, ChevronDown, ClipboardPaste, Copy, Ellipsis, FolderPlus,
  LayoutList, PanelRight, Plus, Scissors, Share2, SquarePen, Trash2 } from 'lucide-react';
import { SORTS, VIEWS, textKey, type Translate } from './model';
import type { ExplorerState } from './useExplorer';
import type { Command, ExplorerActions } from './useExplorerActions';

type Items = NonNullable<MenuProps['items']>;
export function explorerMenus(state: ExplorerState, actions: ExplorerActions, t: Translate) {
  const item = (key: Command, enabled: boolean) => ({ key, label: t(textKey(key)), disabled: !enabled,
    onClick: () => actions.command(key) });
  const views: Items = VIEWS.map(view => ({ key: view, label: t(textKey(view)),
    icon: state.view === view ? <Check size={15} /> : <span className="pe-menu-spacer" />,
    onClick: () => state.setView(view) }));
  const sorts: Items = [
    ...SORTS.map(sort => ({ key: sort, label: t(textKey(sort)),
      icon: state.sort === sort ? <Check size={15} /> : <span className="pe-menu-spacer" />,
      onClick: () => state.setSort(sort) })), { type: 'divider' },
    ...[false, true].map(descending => ({ key: String(descending),
      label: t(textKey(descending ? 'descending' : 'ascending')),
      icon: state.descending === descending ? <Check size={15} /> : <span className="pe-menu-spacer" />,
      onClick: () => state.setDescending(descending) })),
  ];
  const create: Items = [
    { key: 'createFolder', label: t(textKey('newFolder')), icon: <FolderPlus size={16} />,
      disabled: !actions.writable, onClick: () => actions.command('createFolder') },
    { key: 'createFile', label: t(textKey('newFile')), disabled: !actions.writable,
      onClick: () => actions.command('createFile') },
  ];
  const more: Items = [{ key: 'hidden', label: t(textKey('showHidden')),
    icon: state.hidden ? <Check size={15} /> : <span className="pe-menu-spacer" />,
    onClick: () => state.setHidden(!state.hidden) }, item('copyPath', !!state.directory || !!state.selection)];
  const context: Items = [
    { key: 'open', label: t(textKey('open')), disabled: !state.selection?.directory || actions.busy,
      onClick: () => { if (state.selection?.directory) state.navigate(state.selection.path); } },
    { key: 'view', label: t(textKey('view')), children: views },
    { key: 'sort', label: t(textKey('sort')), children: sorts },
    { key: 'refresh', label: t(textKey('refresh')), disabled: actions.busy, onClick: state.refresh },
    { type: 'divider' }, { key: 'new', label: t(textKey('new')), children: create },
    item('cut', actions.mutableSelection), item('copy', actions.mutableSelection), item('paste', actions.canPaste),
    item('rename', actions.mutableSelection), item('delete', actions.mutableSelection),
    item('copyPath', !!state.directory || !!state.selection),
  ];
  return { views, sorts, create, more, context };
}

export function ExplorerToolbar({ state, actions, t }: {
  state: ExplorerState; actions: ExplorerActions; t: Translate;
}) {
  const menus = explorerMenus(state, actions, t);
  const commands = [
    { key: 'cut', icon: Scissors, enabled: actions.mutableSelection },
    { key: 'copy', icon: Copy, enabled: actions.mutableSelection },
    { key: 'paste', icon: ClipboardPaste, enabled: actions.canPaste },
    { key: 'rename', icon: SquarePen, enabled: actions.mutableSelection },
    { key: 'share', icon: Share2, enabled: !!state.directory || !!state.selection },
    { key: 'delete', icon: Trash2, enabled: actions.mutableSelection },
  ] as const;
  const menuButtons = [
    { key: 'sort', icon: ArrowDownUp, items: menus.sorts },
    { key: 'view', icon: LayoutList, items: menus.views },
  ];
  return <div className="pe-toolbar" role="toolbar" aria-label={t(textKey('more'))}>
    <Dropdown trigger={['click']} menu={{ items: menus.create }} overlayClassName="pe-menu">
      <button type="button" disabled={!actions.writable}><Plus size={20} />{t(textKey('new'))}<ChevronDown size={13} /></button>
    </Dropdown><span className="pe-separator" />
    {commands.map(command => <button type="button" key={command.key} title={t(textKey(command.key))}
      aria-label={t(textKey(command.key))} disabled={!command.enabled || actions.busy || state.loading}
      onClick={() => actions.command(command.key)}><command.icon size={19} /></button>)}
    <span className="pe-separator" />
    {menuButtons.map(button => <Dropdown key={button.key} trigger={['click']} overlayClassName="pe-menu"
      menu={{ items: button.items }}><button type="button" disabled={actions.busy}>
        <button.icon size={19} />{t(textKey(button.key))}<ChevronDown size={13} /></button></Dropdown>)}
    <Dropdown trigger={['click']} menu={{ items: menus.more }} overlayClassName="pe-menu">
      <button type="button" disabled={actions.busy} aria-label={t(textKey('more'))}><Ellipsis size={21} /></button>
    </Dropdown>
    <button type="button" className="pe-details-toggle" aria-pressed={state.details}
      onClick={() => state.setDetails(!state.details)}><PanelRight size={19} />{t(textKey('details'))}</button>
  </div>;
}
