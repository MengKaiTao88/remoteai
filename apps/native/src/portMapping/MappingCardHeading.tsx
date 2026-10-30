import { Ionicons } from '@expo/vector-icons';
import { Pressable, Text, View } from 'react-native';
import type { DeviceMappingEntry } from '../../../../shared/port-mapping/deviceRegistry';
import type { useMappingRowActions } from '../chat/portMapping/useMappingRowActions';
import { t } from '../i18n';
import { useThemeColor } from '../theme/store';
import { useMappingCardStyles } from './mappingCardStyles';

export function MappingCardHeading({ mapping, deviceName, alias, blue, rename, actions }: {
  mapping: DeviceMappingEntry; deviceName?: string; alias: string; blue: boolean; rename: () => void;
  actions: ReturnType<typeof useMappingRowActions>;
}) {
  const styles = useMappingCardStyles();
  const color = useThemeColor();
  const { entry, runtime } = mapping;
  const { running, enabled, menu, setMenu } = actions;
  return <View style={styles.heading}>
      <View style={[styles.deviceIcon, blue && styles.deviceIconBlue]}>
        <Ionicons name={blue ? 'laptop-outline' : 'desktop-outline'} size={26}
          color={blue ? color('#168de0', 'info') : color('#009879', 'accent')} />
      </View>
      <View style={styles.fill}>
        <View style={styles.titleRow}>
          <Text style={styles.title}>{alias || deviceName || t('client.mappingHub.device')}</Text>
          <Pressable accessibilityRole="button" accessibilityLabel={t('client.mappingEditor.editAlias')}
            onPress={rename} style={styles.iconButton}>
            <Ionicons name="pencil-outline" size={18} color={color('#62768a', 'muted')} />
          </Pressable>
        </View>
        {!!alias && !!deviceName && <Text style={styles.label}>{deviceName}</Text>}
        <View style={[styles.status, running && styles.statusActive]}>
          <View style={[styles.dot, running && styles.dotActive]} />
          <Text style={[styles.statusText, running && styles.accentText]} accessibilityLiveRegion="polite">
            {t(running ? 'client.portForwarding.active' : enabled ? 'client.mappingHub.retrying' : 'client.chat.stopped')}
          </Text>
        </View>
      </View>
      <Pressable accessibilityRole="button" accessibilityLabel={t('client.portMappingEditing.moreActions')}
        accessibilityState={{ expanded: menu }} onPress={() => setMenu(!menu)} style={styles.iconButton}>
        <Ionicons name="ellipsis-vertical" size={20} color={color('#62768a', 'muted')} />
      </Pressable>
      <Pressable accessibilityRole="switch" disabled={entry.status === 'stopping'} style={styles.toggle}
        accessibilityLabel={t(enabled ? 'client.portForwarding.stopMapping' : 'client.portForwarding.startMapping')}
        accessibilityState={{ checked: enabled, disabled: entry.status === 'stopping' }}
        onPress={() => { void (enabled ? runtime.service.stop(entry.id) : runtime.service.start(entry.id)); }}>
        <View style={[styles.toggleTrack, enabled && styles.toggleActive]}><View style={styles.toggleThumb} /></View>
      </Pressable>
    </View>;
}
