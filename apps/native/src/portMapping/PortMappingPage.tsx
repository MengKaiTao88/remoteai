import { useRef, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import type { RemoteDevice } from '../types';
import { t, useLanguage } from '../i18n';
import { useDeviceMappings, type DeviceMappingEntry } from '../../../../shared/port-mapping/deviceRegistry';
import { MappingRow } from '../chat/portMapping/MappingRow';
import { MappingPreview } from '../chat/portMapping/MappingPreview';
import { useMappingStyles } from '../chat/portMapping/mappingStyles';
import { MappingEditor } from './MappingEditor';

export function PortMappingPage({ devices }: { devices: RemoteDevice[] }) {
  useLanguage();
  const styles = useMappingStyles();
  const scroll = useRef<ScrollView>(null);
  const mappings = useDeviceMappings().filter(mapping => devices.some(device => device.deviceId === mapping.deviceId));
  const [editing, setEditing] = useState<DeviceMappingEntry | 'new'>();
  const [preview, setPreview] = useState<string>();
  const selected = mappings.find(mapping => `${mapping.deviceId}:${mapping.entry.id}` === preview
    && mapping.entry.status === 'running');
  const edit = (mapping: DeviceMappingEntry | 'new') => {
    setEditing(mapping); scroll.current?.scrollTo({ y: 0, animated: true });
  };
  return <ScrollView ref={scroll} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
    <View style={styles.row}>
      <Text accessibilityRole="header" style={[styles.pageTitle, styles.fill]}>
        {t('client.portForwarding.portMapping')}</Text>
      <Pressable accessibilityRole="button" style={styles.button} disabled={!devices.length}
        onPress={() => edit('new')}><Text style={styles.buttonText}>
          {t('client.portMappingEditing.addMapping')}</Text></Pressable>
    </View>
    {!devices.length && <Text style={styles.empty}>{t('client.mappingHub.noDevices')}</Text>}
    {!!devices.length && !mappings.length && !editing && <Text style={styles.empty}>
      {t('client.portForwarding.noPortMappingsYet')}</Text>}
    {editing && <MappingEditor key={typeof editing === 'string' ? editing : editing.entry.id}
      devices={devices} mapping={typeof editing === 'string' ? undefined : editing}
      done={() => setEditing(undefined)} />}
    {mappings.map(mapping => <MappingRow key={`${mapping.deviceId}:${mapping.entry.id}`}
      entry={mapping.entry} service={mapping.runtime.service} connected={mapping.connected}
      deviceName={devices.find(device => device.deviceId === mapping.deviceId)?.name}
      connectionError={mapping.connectionError} syncStatus={mapping.syncStatus}
      edit={() => edit(mapping)} open={() => setPreview(`${mapping.deviceId}:${mapping.entry.id}`)} />)}
    {selected && <MappingPreview port={selected.entry.localPort} close={() => setPreview(undefined)} />}
  </ScrollView>;
}
