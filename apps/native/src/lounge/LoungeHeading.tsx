import { accountName } from '../../../../shared/lounge/names';
import { Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { MobileLounge } from '../../../../shared/lounge/useMobileLounge';
import { contactStatus } from '../../../../shared/lounge/contacts';
import { t } from '../i18n';
import { useLoungeStyles } from './styles';
import { useLoungeColor } from './theme';
import { LoungeAvatar } from './LoungeMessage';

export function LoungeHeading({ model, back }: { model: MobileLounge; back: () => void }) {
  const styles = useLoungeStyles();
  const color = useLoungeColor();
  const { state, contact } = model;
  const status = state.status !== 'connected' ? t(`client.lounge.${state.status}`)
    : contact ? t(contactStatus(contact)) : state.onlineCount !== undefined
      ? t('client.lounge.mobileOnlineCount', { count: state.onlineCount }) : t('client.lounge.membersShort');
  const title = <Text accessibilityRole="header" style={[styles.title, styles.headerTitle]}
    numberOfLines={contact ? 1 : undefined} ellipsizeMode="tail">
    {contact ? accountName(contact.user) : t('client.lounge.title')}</Text>;
  return <View style={styles.header}>
    <Pressable accessibilityRole="button" style={styles.iconButton} onPress={back}
      accessibilityLabel={t('client.lounge.backToChats')}>
      <Ionicons name="chevron-back" size={22} color={color('#202b33', 'ink')} /></Pressable>
    <View style={[styles.headerIdentity, contact && styles.privateHeading]}>
      {contact && <LoungeAvatar user={contact.user} onProfile={() => model.setProfile(contact.user)} />}
      <View style={[styles.headerIdentity, contact && styles.privateIdentity]}>
        {contact ? <Pressable accessibilityRole="button" style={styles.headerAccount}
          accessibilityLabel={t('client.lounge.viewProfile', { account: accountName(contact.user) })}
          onPress={() => model.setProfile(contact.user)}>{title}</Pressable> : title}
        <Pressable accessibilityRole="button" style={[styles.memberTrigger, contact && styles.privateStatus]}
          onPress={() => model.setSheet('members')}>
          <View style={[styles.onlineDot, (state.status !== 'connected' || contact && contact.online !== true)
            && styles.offlineDot]} /><Text style={styles.headerStatus}>{status}</Text></Pressable>
      </View>
    </View>
    <Pressable accessibilityRole="button" accessibilityLabel={t('client.lounge.chats')} style={styles.chatsTrigger}
      onPress={() => model.setChats(true)}>
      <Ionicons name="chatbubbles-outline" size={17} color={color('#456c96', 'info')} />
      <Text style={styles.chatsLabel}>{t('client.lounge.chats')}</Text>
      {state.unread > 0 && <View style={[styles.unread, styles.floatingBadge]}><Text style={styles.unreadText}>
        {state.unread > 99 ? '99+' : state.unread}</Text></View>}
    </Pressable>
  </View>;
}
