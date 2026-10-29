import { Pressable, Text, View } from 'react-native';
import { accountName } from '../../../../shared/lounge/names';
import type { LoungeAccount } from '../../../../shared/lounge/types';
import { t } from '../i18n';
import { textMetrics } from '../theme/text';
import { createLoungeStyles } from './theme';

const useStyles = createLoungeStyles(color => ({
  row: { flexDirection: 'row', alignItems: 'center', gap: 5, maxWidth: '100%' },
  name: { ...textMetrics(10, 15), color: color('#687c89', 'muted'), flexShrink: 1 },
  badge: { ...textMetrics(10, 15), flexShrink: 0, paddingHorizontal: 5, borderRadius: 4,
    backgroundColor: '#facc15', color: '#422006', fontWeight: '600' },
}));

export function LoungeSender({ user, manage }: { user: LoungeAccount; manage?: () => void }) {
  const styles = useStyles();
  const name = accountName(user);
  const content = <>
    {user.moderator === true && <Text style={styles.badge}>{t('client.lounge.adminBadge')}</Text>}
    <Text style={styles.name}>{name}</Text>
  </>;
  return manage ? <Pressable style={styles.row} accessibilityRole="button"
    accessibilityLabel={t('client.lounge.manageUser', { account: name })} onPress={manage}>{content}</Pressable>
    : <View style={styles.row}>{content}</View>;
}
