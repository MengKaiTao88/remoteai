import { useEffect, useRef, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import type { LoungeAttachment as Attachment } from '../../../../shared/lounge/attachments';
import type { LoungeController } from '../../../../shared/lounge/controller';
import { nativeAttachmentSink } from './attachments';
import { LoungeImage } from './LoungeImage';
import { useLoungeStyles } from './styles';
import { t } from '../i18n';
import { textMetrics } from '../theme/text';
import { LoungeFileCard } from './LoungeFileCard';

export function LoungeAttachment(props: {
  file: Attachment; controller: LoungeController; preview: (uri: string) => void; onLoad?: () => void;
  onLongPress?: () => void;
}) {
  return props.file.kind === 'file' ? <LoungeFileCard {...props} /> : <ImageAttachment {...props} />;
}
function ImageAttachment({ file, controller, preview, onLoad, onLongPress }: {
  file: Attachment; controller: LoungeController; preview: (uri: string) => void; onLoad?: () => void;
  onLongPress?: () => void;
}) {
  const styles = useLoungeStyles();
  const [uri, setUri] = useState(''), [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0), [failed, setFailed] = useState(false);
  const active = useRef<AbortController | undefined>(undefined);
  const download = async () => {
    if (active.current) return;
    const abort = new AbortController(); active.current = abort;
    setBusy(true); setFailed(false); setProgress(0);
    try {
      const result = file.kind === 'image' ? await controller.attachments.image(file)
        : await controller.attachments.download(file, await nativeAttachmentSink(file),
          { signal: abort.signal, progress: setProgress });
      if (!abort.signal.aborted) setUri(result);
    } catch { if (!abort.signal.aborted) setFailed(true); }
    finally { if (active.current === abort) active.current = undefined; if (!abort.signal.aborted) setBusy(false); }
  };
  useEffect(() => {
    if (file.kind === 'image') void download();
    return () => { active.current?.abort(); active.current = undefined; };
  }, [file.id, controller]);
  if (uri) return <LoungeImage uri={uri} preview={preview} onLoad={onLoad} onLongPress={onLongPress} />;
  return <View style={{ maxWidth: 300, flexShrink: 1 }}>
    <Pressable accessibilityRole="button" disabled={busy} onPress={() => void download()} onLongPress={onLongPress}>
      <Text style={[styles.link, textMetrics(14, 22)]}>{file.name}</Text>
      <Text style={[styles.muted, textMetrics(12, 19)]}>{(file.size / 1024 / 1024).toFixed(2)} MB</Text>
    </Pressable>
    <Text accessibilityRole={failed ? 'alert' : undefined} style={[styles.muted, textMetrics(12, 19)]}>
      {busy ? t('client.lounge.fileProgress', { percent: Math.round(progress * 100) })
        : t(failed ? 'client.lounge.fileUnavailable' : 'client.lounge.fileOnlineHint')}</Text>
    {busy && <Pressable accessibilityRole="button" onPress={() => { active.current?.abort(); setBusy(false); }}>
      <Text style={[styles.link, textMetrics(12, 19)]}>{t('client.lounge.cancel')}</Text></Pressable>}
  </View>;
}
