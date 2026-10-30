import { Ionicons } from '@expo/vector-icons';
import { Pressable, Text, View } from 'react-native';
import { t, useLanguage } from '../i18n';
import { createThemedStyles } from '../theme/styles';
import { useThemeColor } from '../theme/store';
import { textMetrics } from '../theme/text';

export function PortMappingHeader({ onBack, onAdd, canAdd }: {
  onBack: () => void; onAdd: () => void; canAdd: boolean;
}) {
  useLanguage();
  const styles = useStyles();
  const color = useThemeColor();
  return <View style={styles.header}>
    <View style={styles.side}>
      <Pressable accessibilityRole="button" accessibilityLabel={t('client.discovery.back')}
        onPress={onBack} style={({ pressed }) => [styles.back, pressed && styles.pressed]}>
        <Ionicons name="chevron-back" size={22} color={color('#222', 'ink')} />
      </Pressable>
    </View>
    <Text accessibilityRole="header" style={styles.title}>{t('client.portForwarding.portMapping')}</Text>
    <View style={styles.side}>
      <Pressable accessibilityRole="button" accessibilityLabel={t('client.portMappingEditing.addMapping')}
        accessibilityState={{ disabled: !canAdd }} disabled={!canAdd} onPress={onAdd}
        style={({ pressed }) => [styles.add, (!canAdd || pressed) && styles.pressed]}>
        <Ionicons name="add" size={16} color={color('#008b73', 'accent')} />
        <Text style={styles.addLabel}>{t('client.portMappingEditing.addMapping')}</Text>
      </Pressable>
    </View>
  </View>;
}

const useStyles = createThemedStyles(color => ({
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 6 },
  side: { flex: 1, minWidth: 0 },
  title: { flex: 2, minWidth: 0, textAlign: 'center', ...textMetrics(18, 28),
    fontWeight: '600', color: color('#181818', 'ink') },
  back: { minWidth: 44, minHeight: 44, alignSelf: 'flex-start', justifyContent: 'center' },
  add: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', minHeight: 44, gap: 2 },
  addLabel: { flexShrink: 1, textAlign: 'right', ...textMetrics(13, 21),
    fontWeight: '500', color: color('#008b73', 'accent') },
  pressed: { opacity: 0.5 },
}));
