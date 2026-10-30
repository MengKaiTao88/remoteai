import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import type { LoungeAttachment } from '../../../../shared/lounge/attachments';
import type { LoungeController } from '../../../../shared/lounge/controller';
import { attachmentExtension, attachmentSize, loungePreviewKind } from '../../../../shared/lounge/filePresentation';
import { useFileActions } from '../../../../shared/lounge/useFileActions';
import { BottomSheet } from '../components/BottomSheet';
import { createThemedStyles } from '../theme/styles';
import { textMetrics } from '../theme/text';
import { t, useLanguage } from '../i18n';
import { LoungeFilePreview } from './LoungeFilePreview';

export function LoungeFileCard({ file, controller, onLongPress }: {
  file: LoungeAttachment; controller: LoungeController; onLongPress?: () => void;
}) {
  useLanguage();
  const styles = useStyles();
  const [sheet, setSheet] = useState(false);
  const [preview, setPreview] = useState(false);
  const actions = useFileActions(file, controller);
  const kind = loungePreviewKind(file);
  const icon = kind === 'pdf' ? 'file-pdf-box' : kind === 'image' ? 'file-image-outline'
    : kind === 'video' ? 'file-video-outline' : kind === 'audio' ? 'file-music-outline'
      : kind === 'html' || kind === 'text' ? 'file-code-outline' : 'file-document-outline';
  const details = (expanded = false) => <View style={styles.summary}>
    <View style={[styles.icon, kind === 'pdf' && styles.pdfIcon]}>
      <MaterialCommunityIcons name={icon} size={32} color={kind === 'pdf' ? '#df5361' : '#398c96'} />
      <Text style={[styles.extension, kind === 'pdf' && styles.pdfExtension]}>{attachmentExtension(file.name)}</Text>
    </View><View style={styles.copy}><Text style={styles.name} numberOfLines={expanded ? undefined : 3}>
      {file.name}</Text>
      <Text style={styles.metadata}>{attachmentSize(file.size)}
        {attachmentExtension(file.name) ? ` · ${attachmentExtension(file.name)}` : ''}</Text></View>
  </View>;
  return <>
    <Pressable accessibilityRole="button" accessibilityLabel={t('client.lounge.fileActions', { name: file.name })}
      onPress={() => setSheet(true)} onLongPress={onLongPress} style={styles.card}>{details()}</Pressable>
    {sheet && <BottomSheet visible title={t('client.chat.files.39932f')} onClose={() => setSheet(false)} actions={[
      ...(kind ? [{ label: t('client.chat.preview'), onPress: () => { setSheet(false); setPreview(true); } }] : []),
      { label: t('client.projectBrowser.download'), onPress: actions.download, tone: 'primary', loading: actions.busy },
    ]}>
      {details(true)}<Text style={styles.notice}>{t('client.lounge.fileOnlineHint')}</Text>
      {!!actions.notice && <Text style={styles.notice} accessibilityLiveRegion="polite">{t(actions.notice)}</Text>}
    </BottomSheet>}
    {preview && <LoungeFilePreview file={file} controller={controller} close={() => setPreview(false)} />}
  </>;
}

const useStyles = createThemedStyles(color => ({
  card: { width: 290, maxWidth: '100%', minWidth: 0, padding: 12, borderRadius: 12,
    borderWidth: 1, borderColor: color('#e6ecef', 'border'), backgroundColor: color('#fff', 'surface') },
  summary: { flexDirection: 'row', alignItems: 'center', gap: 12, minWidth: 0 },
  icon: { width: 48, minHeight: 62, flexShrink: 0, alignItems: 'center', justifyContent: 'center',
    borderRadius: 9, backgroundColor: color('#e8f4f4', 'canvas') },
  pdfIcon: { backgroundColor: color('#fff0f1', 'canvas') },
  extension: { ...textMetrics(9, 12), color: '#398c96', fontWeight: '700' },
  pdfExtension: { color: '#df5361' },
  copy: { flex: 1, minWidth: 0, gap: 3 },
  name: { ...textMetrics(14, 21), flexShrink: 1, color: color('#242e36', 'ink'), fontWeight: '600' },
  metadata: { ...textMetrics(12, 18), color: color('#7e8891', 'muted') },
  notice: { ...textMetrics(13, 20), maxWidth: 400, marginTop: 14, color: color('#7e8891', 'muted') },
}));
