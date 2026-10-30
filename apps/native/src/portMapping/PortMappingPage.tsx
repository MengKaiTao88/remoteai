import { useRef, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import type { RemoteDevice } from '../types';
import { t, useLanguage } from '../i18n';
import { useDeviceMappings, type DeviceMappingEntry } from '../../../../shared/port-mapping/deviceRegistry';
import { MappingPreview } from '../chat/portMapping/MappingPreview';
import { useMappingStyles } from '../chat/portMapping/mappingStyles';
import { MappingEditor } from './MappingEditor';
import { PortMappingHeader } from './PortMappingHeader';
import { PortMappingCard } from './PortMappingCard';
import { useMappingCardStyles } from './mappingCardStyles';

export function PortMappingPage({ devices, onBack }: { devices: RemoteDevice[]; onBack: () => void }) {
  useLanguage();
  const styles = useMappingStyles();
  const cardStyles = useMappingCardStyles();
  const scroll = useRef<ScrollView>(null);
  const mappings = useDeviceMappings().filter(mapping => devices.some(device => device.deviceId === mapping.deviceId));
  const [editing, setEditing] = useState<DeviceMappingEntry | 'new'>();
  const [preview, setPreview] = useState<string>();
  const selected = mappings.find(mapping => `${mapping.deviceId}:${mapping.entry.id}` === preview
    && mapping.entry.status === 'running');
  const edit = (mapping: DeviceMappingEntry | 'new') => {
    setEditing(mapping); scroll.current?.scrollTo({ y: 0, animated: true });
  };
  return <View style={cardStyles.page}>
    <PortMappingHeader onBack={onBack} onAdd={() => edit('new')} canAdd={!!devices.length} />
    <ScrollView ref={scroll} contentContainerStyle={cardStyles.content} keyboardShouldPersistTaps="handled">
    {!devices.length && <Text style={styles.empty}>{t('client.mappingHub.noDevices')}</Text>}
    {!!devices.length && !mappings.length && !editing && <Text style={styles.empty}>
      {t('client.portForwarding.noPortMappingsYet')}</Text>}
    {editing && <MappingEditor key={typeof editing === 'string' ? editing : editing.entry.id}
      devices={devices} mapping={typeof editing === 'string' ? undefined : editing}
      done={() => setEditing(undefined)} />}
    {mappings.map(mapping => <PortMappingCard key={`${mapping.deviceId}:${mapping.entry.id}`}
      mapping={mapping} blue={devices.findIndex(device => device.deviceId === mapping.deviceId) % 2 === 0}
      deviceName={devices.find(device => device.deviceId === mapping.deviceId)?.name}
      edit={() => edit(mapping)} open={() => setPreview(`${mapping.deviceId}:${mapping.entry.id}`)} />)}
    {selected && <MappingPreview port={selected.entry.localPort} close={() => setPreview(undefined)} />}
    </ScrollView>
  </View>;
}
