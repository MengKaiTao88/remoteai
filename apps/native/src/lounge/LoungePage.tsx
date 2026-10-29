import { useEffect, useRef, useState } from 'react';
import { BackHandler, FlatList, KeyboardAvoidingView, Platform, Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { LoungeController } from '../../../../shared/lounge/controller';
import type { LoungeMessage as Message } from '../../../../shared/lounge/types';
import { useMobileLounge } from '../../../../shared/lounge/useMobileLounge';
import { getLocale, t, useLanguage } from '../i18n';
import { LoungeMessage } from './LoungeMessage';
import { LoungeComposer } from './LoungeComposer';
import { LoungeAvatarSettings, LoungeModeration } from './LoungeDialogs';
import { LoungePreview } from './LoungePreview';
import { LoungeHistory } from './LoungeHistory';
import { LoungeBlockDialog } from './LoungeBlockDialog';
import { LoungeChats, LoungeMembers } from './LoungeChats';
import { LoungeAbout } from './LoungeSheet';
import { LoungeHeading } from './LoungeHeading';
import { LoungeSyncNotice } from './LoungeSyncNotice';
import { useLoungeStyles } from './styles';
import { useLoungeColor } from './theme';
import { LoungeProfile } from './LoungeProfile';
import { LoungeDeleteDialog } from './LoungeDeleteDialog';
import { LoungeNewChat } from './LoungeNewChat';
import { historyKey } from '../../../../shared/lounge/archive';
import { useLoungeListFocus } from './useLoungeListFocus';
import type { LoungeComposerHandle } from '../../../../shared/lounge/mention';

export function LoungePage({ controller, onBack }: { controller: LoungeController; onBack: () => void }) {
  useLanguage();
  const styles = useLoungeStyles();
  const color = useLoungeColor();
  const model = useMobileLounge(controller);
  const { state, contact } = model;
  const list = useRef<FlatList<Message>>(null);
  const composer = useRef<LoungeComposerHandle>(null);
  const messages = [...model.navigation.messages].reverse();
  const focus = useLoungeListFocus({ list, messages, focus: model.navigation.focus });
  const [viewportHeight, setViewportHeight] = useState(0);
  const scrollBottom = () => { if (model.atBottom) list.current?.scrollToOffset({ offset: 0, animated: false }); };
  const back = () => {
    if (model.chats) onBack();
    else model.setChats(true);
  };
  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => { back(); return true; });
    return () => subscription.remove();
  }, [model.chats, onBack]);
  return <KeyboardAvoidingView style={styles.page} behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    onLayout={event => setViewportHeight(event.nativeEvent.layout.height)}>
    {model.chats ? <LoungeChats model={model} controller={controller} onBack={onBack} /> : <>
      <LoungeHeading model={model} back={back} />
      <FlatList key={`thread:${state.conversation}`} ref={list} inverted data={messages}
        contentContainerStyle={styles.list} style={styles.spacer} keyExtractor={item => `${item.sender.id}:${item.id}`}
        keyboardShouldPersistTaps="handled" scrollEventThrottle={32} onScrollToIndexFailed={focus.failed}
        onContentSizeChange={() => { if (model.navigation.highlight) focus.reveal(); else scrollBottom(); }}
        onLayout={() => !model.navigation.focus && list.current?.scrollToOffset({
          offset: model.offsets.current.get(state.conversation) ?? 0, animated: false,
        })} onScroll={({ nativeEvent: event }) => {
          model.offsets.current.set(state.conversation, event.contentOffset.y);
          model.setAtBottom(!model.navigation.focus && event.contentOffset.y < 48);
        }} renderItem={({ item }) => <LoungeMessage message={item} own={item.sender.id === state.user?.id}
          reply={model.quote} blocked={state.blocked.includes(item.sender.id)}
          direct={item.sender.id !== state.user?.id && state.directAvailable ? () => model.select(item.sender) : undefined}
          profile={() => model.setProfile(item.sender)} controller={controller} locate={model.locate}
          mention={item.sender.id !== state.user?.id ? () => composer.current?.mention(item.sender) : undefined}
          highlighted={model.navigation.highlight === historyKey(item)}
          block={item.sender.id !== state.user?.id && state.directAvailable ? () => model.setBlocking(item.sender) : undefined}
          manage={state.policy.moderator ? model.setModerating : undefined}
          preview={model.setPreview} onImageLoad={scrollBottom} />}
        ListEmptyComponent={<View style={styles.empty}>
          <View style={styles.emptySymbol}>
            <Ionicons name="chatbubbles-outline" size={27} color={color('#456c96', 'info')} /></View>
          <Text style={styles.emptyTitle}>{t(contact ? 'client.lounge.directEmpty' : 'client.lounge.empty')}</Text>
          <Text style={styles.muted}>{t('client.lounge.emptyHint')}</Text>
          <Pressable accessibilityRole="button" style={styles.greeting} onPress={() => model.draftState.change({
            ...model.draftState.draft, text: t(contact ? 'client.lounge.directGreeting' : 'client.lounge.greeting'),
          })}><Text style={styles.chatsLabel}>{t(contact ? 'client.lounge.directGreeting' : 'client.lounge.greeting')}</Text>
          </Pressable>
        </View>} />
      {(!model.atBottom || model.navigation.focus) && <Pressable accessibilityRole="button" style={styles.iconButton} onPress={() => {
        model.latest(); list.current?.scrollToOffset({ offset: 0, animated: true });
      }}><Text style={styles.link}>{t('client.lounge.latest')}</Text></Pressable>}
      {model.muted && <View style={styles.notice}><Text style={styles.muted}>{t('client.lounge.mutedUntil', {
        time: new Date(state.policy.mutedUntil!).toLocaleString(getLocale()),
      })}</Text></View>}
      {!!state.conversation && state.status === 'connected' && !state.directAvailable && <View style={styles.notice}>
        <Text style={styles.muted}>{t('client.lounge.directUpgrade')}</Text></View>}
      {state.historyError && <View style={styles.notice}><Text style={styles.muted}>
        {t('client.lounge.historySaveFailed')}</Text><Pressable accessibilityRole="button" style={styles.iconButton}
          onPress={() => void controller.retryHistory()}><Text style={styles.link}>{t('client.lounge.historyRetry')}</Text>
        </Pressable></View>}
      {model.navigation.error && <View style={styles.notice}><Text accessibilityRole="alert" style={styles.muted}>
        {t(model.navigation.error)}</Text></View>}
      <Pressable accessibilityRole="button" style={styles.retention} onPress={() => model.setSheet('about')}>
        <Ionicons name="information-circle-outline" size={13} color={color('#687c89', 'muted')} />
        <Text style={styles.retentionText}>{t(contact ? 'client.lounge.directRetention' : 'client.lounge.retention')}</Text>
      </Pressable>
      <LoungeComposer direct={!!state.conversation} filesAvailable={state.attachmentsAvailable}
        key={`composer:${state.conversation}`} draftState={model.draftState} reply={model.draftState.draft.reply}
        viewportHeight={viewportHeight} composerRef={composer}
        onOverlayChange={model.setComposerOverlay}
        cancelReply={model.cancelReply}
        connected={state.status === 'connected' && !model.muted && (!state.conversation || state.directAvailable)}
        send={draft => controller.send({ ...draft, to: state.conversation || undefined })}
        onHistory={() => model.setHistory(true)} extraActions={close => <>
          <Pressable accessibilityRole="button" style={styles.extraAction}
            onPress={() => { close(); model.setAvatar(true); }}>
            <Ionicons name="person-circle-outline" size={24} color={color('#456c96', 'info')} />
            <Text style={styles.chatsLabel}>{t('client.lounge.avatarSettings')}</Text></Pressable>
          {contact && state.directAvailable && <Pressable accessibilityRole="button" style={styles.extraAction}
            onPress={() => { close(); model.setBlocking(contact.user); }}>
            <Ionicons name="ban-outline" size={24} color={color('#456c96', 'info')} />
            <Text style={styles.chatsLabel}>{t(state.blocked.includes(contact.user.id)
              ? 'client.lounge.unblockUser' : 'client.lounge.blockUser')}</Text></Pressable>}
        </>} />
    </>}
    <LoungeSyncNotice failed={state.deviceSyncError} controller={controller} />
    {model.sheet === 'members' && <LoungeMembers model={model} />}
    {model.sheet === 'new-chat' && <LoungeNewChat controller={controller} state={state}
      select={model.select} close={() => model.setSheet(undefined)} />}
    {model.sheet === 'about' && <LoungeAbout direct={!!contact} close={() => model.setSheet(undefined)} />}
    {model.history && <LoungeHistory controller={controller} close={() => model.setHistory(false)}
      mention={user => { model.setHistory(false); composer.current?.mention(user); }}
      reply={model.quote} direct={model.select} profile={model.setProfile} locate={model.locate}
      navigationError={model.navigation.error} />}
    {model.avatar && !model.profile && state.user && <LoungeAvatarSettings user={state.user} controller={controller}
      close={() => model.setAvatar(false)} />}
    {model.moderating && state.policy.moderator && <LoungeModeration user={model.moderating} controller={controller}
      close={() => model.setModerating(undefined)} />}
    {model.preview && <LoungePreview uri={model.preview} close={() => model.setPreview(undefined)} />}
    {model.blocking && <LoungeBlockDialog user={model.blocking} blocked={state.blocked.includes(model.blocking.id)}
      controller={controller} close={() => model.setBlocking(undefined)} />}
    <LoungeProfile model={model} controller={controller} />
    <LoungeDeleteDialog model={model} />
  </KeyboardAvoidingView>;
}
