import { Text, View } from 'react-native';
import { t, useLanguage } from '../i18n';
import { createThemedStyles } from '../theme/styles';
import { messageReferences } from '../../../../shared/chat/messageReferences';
import type { Item } from './types';

export function ChatMessageReferences({ item }: { item: Item }) {
  const styles = useReferenceStyles();
  useLanguage();
  const references = messageReferences(item);
  if (!references.length) return null;
  return <View style={styles.list}>
    {references.map(reference => <View key={reference.path} style={styles.reference}>
      <Text style={styles.name}>{t(reference.label)}：{reference.name}</Text>
    </View>)}
  </View>;
}

const useReferenceStyles = createThemedStyles(color => ({
  list: { alignItems: 'flex-start', gap: 6 },
  reference: { maxWidth: '100%', borderRadius: 8, paddingHorizontal: 9, paddingVertical: 5,
    backgroundColor: color('#e6f8f1', 'accentSoft') },
  name: { flexShrink: 1, maxWidth: 400, fontSize: 13, lineHeight: 20, color: color('#14806f', 'accent') },
}));
