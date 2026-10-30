import { useEffect, useState } from 'react';
import { Text } from 'react-native';
import type { LoungeAttachment } from '../../../../shared/lounge/attachments';
import type { LoungeController } from '../../../../shared/lounge/controller';
import { previewAttachment } from '../../../../shared/lounge/previewAttachment';
import { useFileActions } from '../../../../shared/lounge/useFileActions';
import { FilePreviewSheet } from '../chat/FilePreviewSheet';
import { createThemedStyles } from '../theme/styles';
import { textMetrics } from '../theme/text';
import { t, useLanguage } from '../i18n';
import { LoungeFilePreviewContent } from './LoungeFilePreviewContent';

export function LoungeFilePreview({ file, controller, close }: {
  file: LoungeAttachment; controller: LoungeController; close: () => void;
}) {
  useLanguage();
  const styles = useStyles();
  const [bytes, setBytes] = useState<Uint8Array>();
  const [error, setError] = useState<'' | 'client.filePreview.tooLarge' | 'client.lounge.fileUnavailable'>('');
  const [progress, setProgress] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const actions = useFileActions(file, controller);
  useEffect(() => {
    const abort = new AbortController();
    setError(''); setBytes(undefined); setProgress(0);
    void previewAttachment({ file, attachments: controller.attachments, signal: abort.signal,
      progress: value => { if (!abort.signal.aborted) setProgress(value); },
    }).then(value => { if (!abort.signal.aborted) setBytes(value); }).catch(cause => {
      if (!abort.signal.aborted) setError(cause instanceof Error && cause.message === 'client.filePreview.tooLarge'
        ? cause.message : 'client.lounge.fileUnavailable');
    });
    return () => abort.abort();
  }, [file, controller, attempt]);
  return <FilePreviewSheet path={file.name} previewable close={close} actions={[
    { label: t('client.projectBrowser.download'), onPress: actions.download, loading: actions.busy, tone: 'primary' },
    ...(error ? [{ label: t('client.mobile.retryPreview'), onPress: () => setAttempt(value => value + 1) }] : []),
  ]}>
    {!!actions.notice && <Text style={styles.notice} accessibilityLiveRegion="polite">{t(actions.notice)}</Text>}
    {bytes ? <LoungeFilePreviewContent file={file} bytes={bytes} />
      : <Text style={styles.notice} accessibilityLiveRegion="polite">{error ? t(error)
        : t('client.lounge.fileProgress', { percent: Math.round(progress * 100) })}</Text>}
  </FilePreviewSheet>;
}
const useStyles = createThemedStyles(color => ({
  notice: { ...textMetrics(14, 22), maxWidth: 400, margin: 20, color: color('#708078', 'muted') },
}));
