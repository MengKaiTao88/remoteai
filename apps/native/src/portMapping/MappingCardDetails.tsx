import type { MessageKey } from '@remoteai/i18n';
import { Ionicons } from '@expo/vector-icons';
import { Text, View } from 'react-native';
import type { ForwardingEntry } from '../../../../shared/port-mapping/service';
import { protocolLabel } from '../../../../shared/port-mapping/settings';
import { DEFAULT_MAPPING_HOST } from '../../../../shared/port-mapping/target';
import { displayError, t } from '../i18n';
import { useThemeColor } from '../theme/store';
import { useMappingCardStyles } from './mappingCardStyles';

export function MappingCardDetails({ entry, syncStatus, synced }: {
  entry: ForwardingEntry; syncStatus: string; synced: boolean;
}) {
  const styles = useMappingCardStyles();
  const color = useThemeColor();
  const details: Array<[MessageKey, string | number]> = [
    ['client.portForwarding.protocol', protocolLabel(entry.protocol)],
    ['client.portForwarding.targetIp', entry.remoteHost || DEFAULT_MAPPING_HOST],
    ['client.portForwarding.remotePort', entry.remotePort],
    ['client.portForwarding.localPort', entry.localPort],
  ];
  const edited = entry.updatedAt ? new Date(entry.updatedAt).toLocaleString(undefined,
    { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
  return <>
    <View style={styles.metadata}>{details.map(([label, value], index) =>
      <View key={label} style={[styles.detail, index ? styles.separator : styles.firstDetail,
        index === 1 && styles.hostDetail]}>
        <Text style={styles.label}>{t(label)}</Text><Text style={styles.value}>{value}</Text>
      </View>)}</View>
    <View style={styles.footer}>
      <View style={styles.timestamp}>
        <Ionicons name="time-outline" size={18} color={color('#43576b', 'muted')} />
        <View style={{ flexShrink: 1 }}>
          <Text style={styles.label}>{t('client.portMappingEditing.lastEdited.4f04ab')}</Text>
          <Text style={styles.value}>{edited}</Text>
        </View>
      </View>
      {!!syncStatus && <View style={styles.sync}>
        <Ionicons name={synced ? 'checkmark-circle' : 'cloud-outline'} size={14}
          color={synced ? color('#18b975', 'accent') : color('#62768a', 'muted')} />
        <Text style={styles.syncText} accessibilityLiveRegion="polite">{displayError(syncStatus)}</Text>
      </View>}
    </View>
  </>;
}
