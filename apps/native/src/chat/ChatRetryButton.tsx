import { createThemedStyles } from '../theme/styles';
import { useThemeColor } from '../theme/store';
import { Pressable, Text } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTurnRetry } from '../../../../shared/chat/TurnRetryContext';
import { t } from '../i18n';

export function ChatRetryButton({ turnId }: { turnId: string }) {
  const styles = useStyles();
  const color = useThemeColor();
  const action = useTurnRetry(turnId);
  if (!action) return null;
  return <Pressable accessibilityRole="button" accessibilityState={{ disabled: action.disabled }}
    disabled={action.disabled} hitSlop={{ top: 8, bottom: 8 }} onPress={() => { void action.retry(); }}
    style={[styles.button, action.disabled && styles.disabled]}>
    <Ionicons name="refresh-outline" size={14} color={color("#c96c3d", 'warning')} />
    <Text style={styles.label}>{action.pending ? t('正在重试…') : t('重试')}</Text>
  </Pressable>;
}

const useStyles = createThemedStyles((color) => ({
  button: { flexDirection: 'row', alignItems: 'center', gap: 2, padding: 2,
    borderWidth: 1, borderColor: color('#c96c3d', 'warning'), borderRadius: 4 },
  label: { color: color('#c96c3d', 'warning'), fontSize: 12, lineHeight: 16 },
  disabled: { opacity: 0.5 },
}));
