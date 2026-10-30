import { displayError } from '../i18n/index';
import { t, useLanguage } from '../i18n';
import { useEffect, useState } from 'react';
import { BackHandler, FlatList, Text, View } from 'react-native';
import { BottomSheet } from '../components/BottomSheet';
import type { AuthSession } from '../types';
import { DownloadBrowser } from './DownloadBrowser';
import { DownloadCard } from './DownloadCard';
import { DownloadEmptyState } from './DownloadEmptyState';
import { DownloadPageHeader } from './DownloadPageHeader';
import { DownloadSources } from './DownloadSources';
import { useDownloadTasks } from './useDownloadTasks';
import { useStyles } from './styles';
import { useDownloadSelection } from '../../../../shared/downloads/useDownloadSelection';
import { DownloadTaskHeading } from './DownloadTaskHeading';
import { downloadManager } from './manager';

export function DownloadManagerPage({ session, onBack }: { session: AuthSession; onBack: () => void }) {
  const styles = useStyles();
  useLanguage();
  const state = useDownloadTasks(session);
  const [view, setView] = useState<'tasks' | 'project' | 'computer'>('tasks');
  const { tasks, connection, busy, deleting, error, run, setDeleting, removeTasks, owner } = state;
  const { selected, toggle, allSelected, toggleAll } = useDownloadSelection(tasks, owner);
  const browsing = view !== 'tasks' && !!connection;
  useEffect(() => {
    if (browsing) return;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => { onBack(); return true; });
    return () => subscription.remove();
  }, [browsing, onBack]);

  if (view !== 'tasks' && connection) return <DownloadBrowser
    key={`${connection.deviceId}:${view}:${connection.threadId ?? connection.cwd ?? ''}`}
    connection={connection} scope={view} back={() => setView('tasks')} />;

  return <View style={styles.page}>
    <DownloadPageHeader title={t("client.downloads.downloads")} back={onBack} backLabel={t("client.discovery.back")} />
    <FlatList data={tasks} keyExtractor={task => task.id} style={styles.list}
      contentContainerStyle={styles.listContent} showsVerticalScrollIndicator={false}
      ListHeaderComponent={<>
        <DownloadSources connection={connection} browse={setView} />
        {!!error && <Text accessibilityRole="alert" style={styles.error}>{displayError(error)}</Text>}
        <DownloadTaskHeading count={tasks.length} selected={selected.size} busy={!!busy}
          allSelected={allSelected} toggleAll={toggleAll}
          remove={() => setDeleting(tasks.filter(task => selected.has(task.id)))} />
      </>}
      renderItem={({ item }) => <DownloadCard task={item} busy={!!busy}
        selected={selected.has(item.id)} toggleSelection={() => toggle(item.id)}
        connected={!!downloadManager.connectionForSource(item.source)?.ready}
        action={() => { void run(item, 'action'); }} share={() => { void run(item, 'share'); }}
        remove={() => setDeleting([item])} />}
      ListEmptyComponent={<DownloadEmptyState />} />
    <BottomSheet visible={!!deleting.length} maxWidth={400} dismissible={!busy}
      title={t('client.downloads.deleteSelectedTitle', { count: deleting.length })}
      onClose={() => { if (!busy) setDeleting([]); }} actions={[
        { label: t("client.downloads.keep"), disabled: !!busy, onPress: () => setDeleting([]) },
        { label: t("client.projectBrowser.deleted"), tone: 'danger', disabled: !!busy,
          loading: !!busy, onPress: () => { void removeTasks(); } },
      ]}>
      <Text style={styles.text}>{t("client.mobile.deletesThePhoneSFileAndDownloadRecordTheOriginal")}</Text>
      {!!error && <Text style={styles.error}>{displayError(error)}</Text>}
    </BottomSheet>
  </View>;
}
