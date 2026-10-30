import { displayError } from '../../i18n/index';
import { useEffect, useState } from 'react';
import { Platform, Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { ForwardingClient, ForwardingEntry } from '../../../../../shared/port-mapping/service';
import { MAX_PORT_MAPPINGS } from '../../../../../shared/port-mapping/settings';
import { BottomSheet } from '../../components/BottomSheet';
import { SheetScrollView } from '../../components/SheetScrollView';
import type { AuthSession } from '../../types';
import { t } from '../../i18n';
import { usePortMappings } from './usePortMappings';
import { MappingPreview } from './MappingPreview';
import { MappingOpenActions } from './MappingOpenActions';
import { MappingForm } from './MappingForm';
import { MappingRow } from './MappingRow';
import { useMappingStyles } from './mappingStyles';

export function PortMappings(props: {
  client: ForwardingClient; scope: string; connected: boolean; active: boolean; session?: AuthSession;
  open: boolean; close: () => void; deviceName?: string;
}) {
  const styles = useMappingStyles();
  const { entries, service, syncStatus, connected = props.connected } = usePortMappings(props);
  const [selection, setSelection] = useState<{ id: string; view: 'actions' | 'preview' }>();
  const [editing, setEditing] = useState<ForwardingEntry>();
  const [newestFirst, setNewestFirst] = useState(false);
  const selected = entries.find(entry => entry.id === selection?.id && entry.status === 'running'
    && entry.protocol !== 'udp');
  const previewing = !!selected && selection?.view === 'preview';
  const closeActions = () => setSelection(undefined);
  useEffect(() => {
    if (!props.active || !props.open || !selected) setSelection(undefined);
  }, [props.active, props.open, selected]);
  useEffect(() => { setEditing(undefined); }, [service]);
  const sorted = [...entries].sort((a, b) => newestFirst ? (b.updatedAt ?? 0) - (a.updatedAt ?? 0) : 0);
  return <>
    <BottomSheet visible={props.active && props.open && !previewing}
      title={t(selected ? "client.portForwarding.openMappedAddress" : "client.portForwarding.portMapping")}
      titleIcon={!selected && <View style={styles.heroIcon}>
        <Ionicons name="swap-horizontal-outline" size={26} color="#008b73" /></View>}
      subtitle={selected ? `http://127.0.0.1:${selected.localPort}` : t("client.portMappingEditing.accessAnIpAndPortThroughTheRemoteComputer")}
      onClose={selected ? closeActions : props.close} onBack={selected ? closeActions : undefined}
      maxWidth={540} horizontalPadding={16} fullWidthContent={!selected}>
      {selected ? <MappingOpenActions key={selected.id} port={selected.localPort}
        preview={() => setSelection({ id: selected.id, view: 'preview' })} opened={closeActions} /> :
      <SheetScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}>
        <View style={styles.notice}><Ionicons name="information-circle" size={21} color="#008b73" />
          <Text style={[styles.muted, styles.fill]}>
            {t("client.portForwarding.chooseAProtocolToAddAMappingTapTcpWeb")}</Text></View>
        {!connected && <Text style={styles.muted}>{t("client.portForwarding.disconnectedReconnectToStartMappingAgain")}</Text>}
        <View style={styles.row}><Text style={[styles.sectionTitle, styles.fill]}>
          {t("client.portMappingEditing.currentMappings")} ({entries.length})</Text>
          <Pressable accessibilityRole="button" accessibilityLabel={t("client.portMappingEditing.sortByLastEdit")}
            accessibilityState={{ selected: newestFirst }} style={styles.iconButton}
            onPress={() => setNewestFirst(!newestFirst)}>
            <Ionicons name="swap-vertical" size={21} color={newestFirst ? '#008b73' : '#718078'} /></Pressable></View>
        {!entries.length && <Text style={styles.empty}>{t("client.portForwarding.noPortMappingsYet")}</Text>}
        {sorted.map(entry => editing?.id === entry.id
          ? <MappingForm key={entry.id} service={service} entry={editing} done={() => setEditing(undefined)} />
          : <MappingRow key={entry.id} entry={entry} service={service} connected={connected}
            edit={() => setEditing(entry)} open={() => setSelection({ id: entry.id, view: 'actions' })} />)}
        {editing && !entries.some(entry => entry.id === editing.id) && <Pressable accessibilityRole="button"
          onPress={() => setEditing(undefined)}><Text style={styles.muted}>
          {t("client.portMappingEditing.thisMappingWasRemovedAddItAgainToContinue")}</Text></Pressable>}
        {!editing && <MappingForm service={service} disabled={entries.length >= MAX_PORT_MAPPINGS}
          connected={connected} />}
        <Text style={styles.footer}>{t("client.portForwarding.tcpAndUdpAccessibleOnlyOnThisDevice")}</Text>
        {!!syncStatus && <Text style={styles.sync} accessibilityLiveRegion="polite">{displayError(syncStatus)}</Text>}
        {Platform.OS === 'ios' && <Text style={styles.muted}>
          {t("client.portForwarding.switchingAppsMayInterruptTheMappingPreviewHereForA")}</Text>}
      </SheetScrollView>}
    </BottomSheet>
    {selected && previewing && props.active && props.open && <MappingPreview
      key={`${selected.id}:${selected.updatedAt}`} port={selected.localPort} close={closeActions} />}
  </>;
}
