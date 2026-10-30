import { Ionicons } from '@expo/vector-icons';
import { Pressable, Text, View } from 'react-native';
import type { DeviceMappingEntry } from '../../../../shared/port-mapping/deviceRegistry';
import type { useMappingRowActions } from '../chat/portMapping/useMappingRowActions';
import { t } from '../i18n';
import { useThemeColor } from '../theme/store';
import { useMappingCardStyles } from './mappingCardStyles';

export function MappingCardAddress({ mapping, open, actions }: {
  mapping: DeviceMappingEntry; open: () => void; actions: ReturnType<typeof useMappingRowActions>;
}) {
  const styles = useMappingCardStyles();
  const color = useThemeColor();
  const { entry } = mapping;
  const { running, canOpen, copy } = actions;
  return <View style={styles.address}>
      <View style={styles.addressMain}>
        <Text style={styles.label}>{t('client.portMappingEditing.accessAddress')}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel={`127.0.0.1:${entry.localPort}`}
          disabled={!canOpen} onPress={open}>
          <Text style={[styles.addressValue, !running && styles.disabled]}>127.0.0.1:{entry.localPort}</Text>
        </Pressable>
      </View>
      <View style={styles.row}>
        <Pressable accessibilityRole="button" accessibilityLabel={t('client.portForwarding.copyLocalAddress')}
          style={styles.copy} onPress={() => { void copy(); }}>
          <Ionicons name="copy-outline" size={19} color={color('#34495e', 'ink')} />
        </Pressable>
        {entry.protocol !== 'udp' && <Pressable accessibilityRole="button" disabled={!canOpen}
          accessibilityLabel={t('client.portForwarding.open')} onPress={open}
          style={[styles.open, !canOpen && styles.disabled]}>
          <Ionicons name="open-outline" size={18} color={color('#009879', 'accent')} />
          <Text style={styles.openText}>{t('client.portForwarding.open')}</Text>
        </Pressable>}
      </View>
    </View>;
}
