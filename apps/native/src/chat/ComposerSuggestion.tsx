import { Pressable, StyleSheet, Text } from 'react-native';
import { t } from '../i18n';
import { useThemeColor } from '../theme/store';

export function ComposerSuggestion({ text, accept }: { text: string; accept: () => void }) {
  const color = useThemeColor();
  if (!text) return null;
  const ink = color('#25332b', 'ink');
  return <Pressable accessibilityRole="button" accessibilityLabel={t('填入建议')}
    onPress={accept} style={styles.button}>
    <Text style={[styles.text, { color: ink }]}>{text}</Text>
    <Text style={[styles.hint, { color: ink, borderColor: ink }]}>{t('填入')}</Text>
  </Pressable>;
}
const styles = StyleSheet.create({
  button: { flexDirection: 'row', alignItems: 'center', gap: 10, alignSelf: 'flex-start',
    maxWidth: '100%', width: 400, minHeight: 44, paddingVertical: 6, paddingHorizontal: 8 },
  text: { flexShrink: 1, fontSize: 16, lineHeight: 23, opacity: 0.5 },
  hint: { flexShrink: 0, fontSize: 12, lineHeight: 18, opacity: 0.7, borderWidth: 1,
    borderRadius: 5, paddingVertical: 1, paddingHorizontal: 5 },
});
