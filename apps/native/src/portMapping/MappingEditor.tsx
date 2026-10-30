import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useDeviceMapping, useMappingRuntime,
  type DeviceMappingEntry } from '../../../../shared/port-mapping/deviceRegistry';
import { MAX_PORT_MAPPINGS } from '../../../../shared/port-mapping/settings';
import { BottomSheet } from '../components/BottomSheet';
import { SheetScrollView } from '../components/SheetScrollView';
import { MappingForm } from '../chat/portMapping/MappingForm';
import { useMappingStyles } from '../chat/portMapping/mappingStyles';
import { t } from '../i18n';
import type { RemoteDevice } from '../types';

export function MappingEditor({ devices, mapping, done }: {
  devices: RemoteDevice[]; mapping?: DeviceMappingEntry; done: () => void;
}) {
  const [deviceId, setDeviceId] = useState(mapping?.deviceId ?? devices[0]?.deviceId ?? '');
  const runtime = useDeviceMapping(deviceId);
  if (!runtime) return null;
  return <EditorForm devices={devices} mapping={mapping} done={done} deviceId={deviceId}
    setDeviceId={setDeviceId} runtime={runtime} />;
}

function EditorForm({ devices, mapping, done, deviceId, setDeviceId, runtime }: {
  devices: RemoteDevice[]; mapping?: DeviceMappingEntry; done: () => void; deviceId: string;
  setDeviceId: (deviceId: string) => void; runtime: NonNullable<ReturnType<typeof useDeviceMapping>>;
}) {
  const styles = useMappingStyles();
  const { entries, service } = useMappingRuntime(runtime);
  const [choosing, setChoosing] = useState(false);
  return <>
    <MappingForm service={service} entry={mapping?.entry} done={done}
      disabled={!mapping && entries.length >= MAX_PORT_MAPPINGS}
      devicePicker={<View>
        <Text style={styles.muted}>{t('client.mappingHub.device')}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel={t('client.mappingHub.device')}
          disabled={!!mapping} style={[styles.input, styles.row]} onPress={() => setChoosing(true)}>
          <Text style={[styles.title, styles.fill]}>{devices.find(device => device.deviceId === deviceId)?.name}</Text>
          {!mapping && <Ionicons name="chevron-down" size={18} color="#62768a" />}
        </Pressable>
      </View>} />
    <BottomSheet visible={choosing} title={t('client.mappingHub.device')} onClose={() => setChoosing(false)}>
      <SheetScrollView contentContainerStyle={styles.content}>
        {devices.map(device => <Pressable key={device.deviceId} accessibilityRole="button"
          style={styles.button} onPress={() => { setDeviceId(device.deviceId); setChoosing(false); }}>
          <Text style={styles.buttonText}>{device.name}</Text></Pressable>)}
      </SheetScrollView>
    </BottomSheet>
  </>;
}
