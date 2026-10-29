import { useState, type HTMLAttributes, type ReactElement } from 'react';
import { message as toast } from 'antd';
import { ThreadContextMenu } from '../chat/ThreadContextMenu';
import { displayText as t } from '../localization/messages';
import type { LoungeMessage } from './types';
import { copyLoungeMessage } from './clipboard';
import { MobileLoungeMessageMenu } from './MobileLoungeMessageMenu';
import { messageMenuActions } from './messageMenuActions';
import './contextMenu.css';

export interface LoungeMessageMenuActions {
  reply: (message: LoungeMessage) => void;
  direct?: () => void; block?: () => void; blocked?: boolean;
}

export function LoungeMessageMenu({ message, reply, children, direct, block, blocked, mobile }: LoungeMessageMenuActions & {
  message: LoungeMessage;
  mobile?: boolean;
  children: ReactElement<HTMLAttributes<HTMLElement>>;
}) {
  const [open, setOpen] = useState(false);
  const [notice, holder] = toast.useMessage();
  const copy = async () => {
    try {
      await copyLoungeMessage(message);
      void notice.success({ content: t('client.lounge.messageCopied'), className: 'lounge-copy-notice' });
    } catch {
      void notice.error({ content: t('client.lounge.messageCopyFailed'), className: 'lounge-copy-notice' });
    }
  };
  const select = (key: string) => {
    setOpen(false);
    if (key === 'copy') void copy();
    else if (key === 'direct') direct?.();
    else if (key === 'block') block?.();
    else reply(message);
  };
  if (mobile) return <>{holder}<MobileLoungeMessageMenu reply={reply} direct={direct} block={block}
    blocked={blocked} select={select}>{children}</MobileLoungeMessageMenu></>;
  return <>{holder}<ThreadContextMenu open={open} onOpenChange={setOpen} overlayClassName="lounge-context-menu"
    menu={{ items: messageMenuActions({ direct, block, blocked }).map(action => ({ ...action, label: t(action.label) })),
      onClick: ({ key }) => select(key) }}>{children}</ThreadContextMenu></>;
}
