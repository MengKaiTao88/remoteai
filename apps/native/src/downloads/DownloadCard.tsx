import { displayError } from '../i18n/index';
import { useThemeColor } from '../theme/store';
import { t, useLanguage } from '../i18n';
import { Ionicons } from '@expo/vector-icons';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import type { DownloadTask } from './types';
import { downloadDetail, downloadPercent, downloadStatusLabel, formatBytes } from './presentation';
import { colors, useStyles } from './styles';
import { downloadCompletionDetails } from '../../../../shared/downloads/completion';

export function DownloadCard({ task, connected, busy, action, share, remove, selected = false, toggleSelection }: {
  task: DownloadTask; connected: boolean; busy: boolean;
  action: () => void; share: () => void; remove: () => void;
  selected?: boolean; toggleSelection?: () => void;
}) {
  const styles = useStyles();
  const color = useThemeColor();
  useLanguage();
  const active = ['downloading', 'queued', 'preparing', 'verifying', 'saving'].includes(task.status);
  const complete = task.status === 'completed';
  const completion = complete ? downloadCompletionDetails(task) : undefined;
  const paused = task.status === 'paused';
  const failed = task.status === 'failed';
  const disabled = busy || (!connected && !active && !complete && !task.readyToSave);
  const label = active ? t("client.downloads.pause") : complete ? t("client.mobile.openFile") : task.readyToSave ? t("client.downloads.saveAgain") : t("client.downloads.resumeDownload");
  const icon = active ? 'pause-outline' : complete ? 'open-outline' : 'play-outline';
  const percent = downloadPercent(task);
  const indeterminate = task.status === 'preparing' && task.preparation?.phase !== 'compressing';
  const progressCaption = indeterminate ? '' : `${percent}%`;
  return <Pressable accessible={false} disabled={busy} onPress={toggleSelection}
    style={[styles.card, selected && styles.selectedCard]}>
    <View style={styles.cardHeader}>
      <View style={styles.fileIcon}><Ionicons name="document-text-outline" size={23} color={color(colors.green, 'accent')} /></View>
      <View style={styles.fileCopy}>
        <Text style={styles.title} numberOfLines={2}>{task.name}</Text>
        <Text style={styles.caption} numberOfLines={1}>{task.source.deviceName}</Text>
      </View>
      {toggleSelection && <Pressable accessibilityRole="checkbox"
        accessibilityLabel={t('client.downloads.selectTask', { name: task.name })}
        accessibilityState={{ checked: selected, disabled: busy }} disabled={busy}
        onPress={event => { event.stopPropagation(); toggleSelection(); }} style={styles.selection}>
        <Ionicons name={selected ? 'checkbox' : 'square-outline'} size={22}
          color={color(selected ? colors.green : colors.muted, selected ? 'accent' : 'muted')} />
      </Pressable>}
    </View>
    <View style={styles.progressCopy}>
      <View style={styles.statusRow}>
        <View style={[styles.statusBadge, paused && styles.pausedBadge, failed && styles.failedBadge]}>
          <Text style={[styles.status, paused && styles.paused, failed && styles.danger]}>
            {downloadStatusLabel(task)}</Text>
        </View>
        <Text style={styles.caption}>{complete ? formatBytes(task.size) : progressCaption}</Text>
      </View>
      {!complete && <>
        <View accessibilityRole="progressbar" accessibilityLabel={t("client.mobile.downloadProgress", { value1: task.name })}
          accessibilityValue={{ min: 0, max: 100, now: percent }} style={styles.track}>
          <View style={[styles.progress, paused && styles.pausedProgress, failed && styles.failedProgress,
            { width: `${percent}%` }]} />
        </View>
        <Text style={styles.caption}>{downloadDetail(task)}</Text>
      </>}
    </View>
    {completion?.summary && <ScrollView horizontal style={styles.completion}>
      <Text style={styles.completionText}>{completion.summary}</Text>
    </ScrollView>}
    {!complete && !!task.message && <Text style={failed ? styles.error : styles.text}>
      {task.source.attachment ? t('client.lounge.fileUnavailable') : displayError(task.message)}</Text>}
    {!connected && !complete && !task.readyToSave && <Text style={styles.text}>
      {t(task.source.attachment ? 'client.lounge.fileUnavailable' : 'client.mobile.connectToThisComputerToContinue')}</Text>}
    <View style={[styles.toolbar, styles.cardActions]}>
      <Pressable accessibilityRole="button" accessibilityLabel={t("client.projectBrowser.deleted")} disabled={busy}
        onPress={event => { event.stopPropagation(); remove(); }}
        style={({ pressed }) => [styles.deleteButton, busy && styles.disabled, pressed && styles.pressed]}>
        <Ionicons name="trash-outline" size={16} color={color(colors.muted, 'muted')} />
        <Text style={styles.deleteText}>{t("client.projectBrowser.deleted")}</Text>
      </Pressable>
      {complete && <Pressable accessibilityRole="button" accessibilityLabel={t("client.downloads.share")}
        accessibilityState={{ disabled: busy }} disabled={busy}
        onPress={event => { event.stopPropagation(); share(); }}
        style={({ pressed }) => [styles.shareButton, busy && styles.disabled, pressed && styles.pressed]}>
        <Ionicons name="share-social-outline" size={16} color={color(colors.green, 'accent')} />
        <Text style={styles.buttonText}>{t("client.downloads.share")}</Text>
      </Pressable>}
      <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled, busy }}
        disabled={disabled} onPress={event => { event.stopPropagation(); action(); }}
        style={({ pressed }) => [styles.button, disabled && styles.disabled, pressed && styles.pressed]}>
        {busy ? <ActivityIndicator size="small" color={color(colors.green, 'accent')} />
          : <Ionicons name={icon} size={16} color={color(colors.green, 'accent')} />}
        <Text style={styles.buttonText}>{label}</Text>
      </Pressable>
    </View>
  </Pressable>;
}
