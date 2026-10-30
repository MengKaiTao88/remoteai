import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useDeviceMapping, useMappingRuntime,
  type DeviceMappingEntry } from '../../../../shared/port-mapping/deviceRegistry';
import { MAX_PORT_MAPPINGS } from '../../../../shared/port-mapping/settings';
import { BottomSheet } from '../components/BottomSheet';
import { SheetScrollView } from '../components/SheetScrollView';
import { MappingEditorForm } from './MappingEditorForm';
import { useMappingStyles } from '../chat/portMapping/mappingStyles';
import { useMappingEditorStyles } from './mappingEditorStyles';
import { useThemeColor } from '../theme/store';
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
  const editorStyles = useMappingEditorStyles();
  const color = useThemeColor();
  const { entries, service } = useMappingRuntime(runtime);
  const [choosing, setChoosing] = useState(false);
  return <>
    <MappingEditorForm service={service} entry={mapping?.entry} done={done}
      disabled={!mapping && entries.length >= MAX_PORT_MAPPINGS}
      devicePicker={<View style={editorStyles.section}>
        <Text style={editorStyles.label}>{t('client.mappingEditor.chooseDevice')}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel={t('client.mappingHub.device')}
          disabled={!!mapping} accessibilityState={{ disabled: !!mapping }}
          style={editorStyles.device} onPress={() => setChoosing(true)}>
          <View style={editorStyles.deviceIcon}>
            <Ionicons name="desktop-outline" size={23} color={color('#009681', 'accent')} />
          </View>
          <Text style={editorStyles.deviceName}>{devices.find(device => device.deviceId === deviceId)?.name}</Text>
          {!mapping && <Ionicons name="chevron-down" size={18} color={color('#23364d', 'ink')} />}
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
