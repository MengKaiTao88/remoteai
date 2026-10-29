import { useRef, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { LoungeDraft } from '../../../../shared/lounge/types';
import { checkAttachmentSize } from '../../../../shared/lounge/attachments';
import { pickLoungeFile } from './attachments';
import { displayText, t } from '../i18n';
import { useLoungeStyles } from './styles';
import { useLoungeColor } from './theme';
import { sendError } from '../../../../shared/lounge/contacts';

export function LoungeFileButton({ send, disabled, close }: {
  send: (draft: LoungeDraft) => Promise<void>; disabled: boolean; close: () => void;
}) {
  const styles = useLoungeStyles(), color = useLoungeColor();
  const locked = useRef(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const choose = async () => {
    if (locked.current) return;
    locked.current = true; setBusy(true); setError('');
    try {
      const file = await pickLoungeFile();
      if (!file) return;
      checkAttachmentSize(file, 'file', 'private');
      await send({ text: '', images: [], files: [file] }); close();
    } catch (failure) { setError(sendError(failure)); }
    finally { locked.current = false; setBusy(false); }
  };
  return <View><Pressable accessibilityRole="button" style={styles.extraAction} disabled={disabled || busy}
    onPress={() => void choose()}>
    <Ionicons name="attach-outline" size={24} color={color('#456c96', 'info')} />
    <Text style={styles.chatsLabel}>{t('client.lounge.sendFile')}</Text>
  </Pressable>{!!error && <Text accessibilityRole="alert" style={[styles.error, { maxWidth: 400 }]}>
    {displayText(error)}</Text>}</View>;
}
