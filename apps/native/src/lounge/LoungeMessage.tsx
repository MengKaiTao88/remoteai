import { accountName } from '../../../../shared/lounge/names';
import { Image, Pressable, Text, View, useWindowDimensions } from 'react-native';
import { useState, type ReactNode } from 'react';
import { initials, type LoungeAccount, type LoungeMessage as Message } from '../../../../shared/lounge/types';
import { getLocale, t } from '../i18n';
import { UNREAD_BADGE_FONT_SIZE, UNREAD_BADGE_HORIZONTAL_PADDING, useLoungeStyles } from './styles';
import { LoungeReplyPreview } from './LoungeReplyPreview';
import { LoungeMessageActions } from './LoungeMessageActions';
import { LoungeImage } from './LoungeImage';
import { LoungeDeliveryStatus } from './LoungeDeliveryStatus';
import { messageMinimumWidth } from './messageLayout';
import { LoungeSender } from './LoungeSender';
import type { LoungeReply } from '../../../../shared/lounge/reply';
import type { LoungeController } from '../../../../shared/lounge/controller';

const MESSAGE_AVATAR_TOUCH_PADDING = 7;

export function LoungeAvatar({ user, size, onDirect, onProfile, onLongPress }: {
  user: LoungeAccount; size?: 'small' | 'profile'; onDirect?: () => void;
  onProfile?: () => void; onLongPress?: () => void;
}) {
  const styles = useLoungeStyles();
  const small = size === 'small';
  const avatarStyle = [styles.avatar, small && styles.messageAvatar, size === 'profile' && styles.profileAvatar];
  const avatar = user.avatar ? <Image source={{ uri: user.avatar }}
    style={avatarStyle} />
    : <View style={avatarStyle}>
      <Text style={[small ? styles.messageName : styles.initials, size === 'profile' && styles.profileInitials]}>
        {initials(accountName(user))}</Text></View>;
  const action = onProfile ?? onDirect;
  return action ? <Pressable accessibilityRole="button" onPress={action} onLongPress={onLongPress}
    hitSlop={small ? MESSAGE_AVATAR_TOUCH_PADDING : 0}
    accessibilityLabel={t(onProfile ? 'client.lounge.viewProfile' : 'client.lounge.directWith', {
      account: accountName(user) })}>{avatar}</Pressable> : avatar;
}

export function LoungeUnread({ count, children }: { count: number; children: ReactNode }) {
  const styles = useLoungeStyles();
  const { fontScale } = useWindowDimensions();
  const label = count > 99 ? '99+' : String(count);
  // Absolute children are measured against the icon width; reserve scalable space for every glyph.
  const minWidth = UNREAD_BADGE_HORIZONTAL_PADDING * 2 + label.length * UNREAD_BADGE_FONT_SIZE * fontScale;
  return <View style={styles.badgeWrap}>{children}{count > 0 && <View style={[styles.badge, { minWidth }]}>
    <Text style={styles.badgeText}>{label}</Text>
  </View>}</View>;
}

interface Props {
  message: Message; own?: boolean; manage?: (user: LoungeAccount) => void;
  preview: (uri: string) => void; onImageLoad?: () => void;
  reply?: (message: Message) => void;
  direct?: () => void; block?: () => void; blocked?: boolean;
  profile?: () => void;
  controller: LoungeController; locate?: (reference: LoungeReply) => void; highlighted?: boolean;
}
export function LoungeMessage({ message, own, manage, preview, onImageLoad, reply, direct, block, blocked,
  profile, controller, locate, highlighted }: Props) {
  const styles = useLoungeStyles();
  const [menu, setMenu] = useState(false);
  const [availableWidth, setAvailableWidth] = useState(0);
  const { fontScale } = useWindowDimensions();
  const minWidth = Math.min(availableWidth, messageMinimumWidth(message.text, fontScale));
  const openMenu = reply ? () => setMenu(true) : undefined;
  return <View style={[styles.message, own && styles.own, highlighted && styles.highlighted]}>
    <LoungeAvatar user={message.sender} size="small" onDirect={direct} onProfile={profile} />
    <View style={[styles.messageMain, own && styles.ownMain]}
      onLayout={event => setAvailableWidth(event.nativeEvent.layout.width)}>
      <LoungeSender user={message.sender} manage={!own && manage ? () => manage(message.sender) : undefined} />
      <Pressable onLongPress={openMenu} style={[styles.bubble, own && styles.ownBubble,
        { minWidth }, message.reply && styles.quotedBubble,
        !message.text.trim() && !message.reply && styles.imageOnly]}>
        {message.reply && <LoungeReplyPreview reply={message.reply} controller={controller}
          locate={locate} onLongPress={openMenu} />}
        {!!message.text && <Text selectable={!reply} onLongPress={openMenu} style={styles.messageText}>{message.text}</Text>}
        {message.images.map((uri, index) => <LoungeImage key={index} uri={uri} preview={preview}
          onLongPress={openMenu} onLoad={onImageLoad} />)}
      </Pressable>
      <Text style={styles.messageTime}>{new Date(message.sentAt).toLocaleTimeString(getLocale(),
        { hour: '2-digit', minute: '2-digit' })}</Text>
      <LoungeDeliveryStatus delivery={message.delivery} />
    </View>
    {menu && reply && <LoungeMessageActions message={message} reply={reply} close={() => setMenu(false)}
      direct={direct} block={block} blocked={blocked} />}
  </View>;
}
