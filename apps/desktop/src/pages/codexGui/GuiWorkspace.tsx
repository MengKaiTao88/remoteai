import { useEffect, useRef, type ReactNode } from "react";
import { isDesktopApp } from "../../api/backend";
import type { Account, Provider } from "../../types";
import type { SkillsMarketPageProps } from "../skillsMarket/types";
import { CodexGuiPage } from "../CodexGuiPage";
import { ProxyAccountPicker, type ProxyAccountPickerProps } from "./ProxyAccountPicker";
import { CliGuiProvider, useCliGui } from '../../../../../shared/cli-gui/context';
import { localCliTransport } from '../../../../../shared/cli-gui/localTransport';
import { useGuiAccountSelection } from "./useGuiAccountSelection";
import { useGuiComputers } from "./remote/useGuiComputers";
import { useGuiLayout } from "./useGuiLayout";
import { GuiHostPicker } from "../../../../../shared/conversation/GuiHostPicker";
import { RemoteGuiWorkspaces } from "./remote/RemoteGuiWorkspaces";
import type { ThreadNavigation } from "./useNotificationNavigation";
import { backendSnapshot } from './backendScope';
import { CodexAppearance } from '../../../../../shared/appearance/CodexAppearance';

type Props = {
  active: boolean; accounts: Account[]; providers: Provider[]; privacyMode: boolean;
  loading: boolean; windowControls?: ReactNode;
  notificationTarget?: ThreadNavigation;
  plugins: Omit<SkillsMarketPageProps, "active">;
};

export function GuiWorkspace(props: Props) {
  return <CliGuiProvider transport={localCliTransport} enabled={false}>
    <Workspace {...props} /></CliGuiProvider>;
}

function WorkspaceAccountPicker(props: ProxyAccountPickerProps) {
  const cli = useCliGui();
  if (backendSnapshot().backend === 'official' && cli?.state.engine === 'codex') return null;
  return <ProxyAccountPicker {...props} />;
}

function Workspace(props: Props) {
  const computers = useGuiComputers({ active: props.active, login: props.plugins.onLogin,
    identity: props.plugins.authenticated && props.plugins.baseUrl && props.plugins.currentUserId
      ? { baseUrl: props.plugins.baseUrl, userId: props.plugins.currentUserId } : null });
  const { choose } = computers;
  const notificationRequest = props.notificationTarget?.requestId;
  const handledNotification = useRef<string>();
  useEffect(() => {
    if (!notificationRequest || handledNotification.current === notificationRequest) return;
    handledNotification.current = notificationRequest;
    choose(null);
  }, [notificationRequest, choose]);
  const remote = isDesktopApp ? computers.current : null;
  const localActive = props.active && !remote;
  const cli = useCliGui();
  useEffect(() => localActive ? cli?.controller.start() : undefined, [localActive, cli?.controller]);
  const focusMode = useGuiLayout(props.active);
  const selection = useGuiAccountSelection({ ...props, active: localActive });
  return <CodexAppearance><div hidden={Boolean(remote)} style={{ height: '100%' }}>
    <CodexGuiPage active={localActive} notificationTarget={props.notificationTarget}
    syncComputers={computers}
    focusMode={focusMode} providers={selection.providers} aggregateApis={selection.aggregateApis ?? []}
    hostPicker={isDesktopApp && <GuiHostPicker navigation={computers} active={localActive} />}
    windowControls={props.windowControls} plugins={props.plugins} accountPicker={
      <WorkspaceAccountPicker active={localActive}
        computers={isDesktopApp ? computers : undefined}
        accounts={selection.accounts} providers={selection.providers}
        aggregateApis={selection.aggregateApis ?? []} privacyMode={props.privacyMode}
        busy={false} loading={props.loading || selection.loading} selectionError={selection.error}
        onSwitchAccount={selection.switchAccount} onSwitchProvider={selection.switchProvider}
        onSwitchAggregate={selection.switchAggregate} />
    } /></div>
    {isDesktopApp && computers.identity &&
      <RemoteGuiWorkspaces key={JSON.stringify([computers.identity.baseUrl, computers.identity.userId])}
        active={props.active} current={remote} identity={computers.identity} computers={computers}
        privacyMode={props.privacyMode} focusMode={focusMode} windowControls={props.windowControls} />
    }
  </CodexAppearance>;
}
