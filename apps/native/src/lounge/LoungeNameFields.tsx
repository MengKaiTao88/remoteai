import { Pressable, Text, TextInput, View } from 'react-native';
import { useLoungeNameEditor, type LoungeNameEditorOptions } from '../../../../shared/lounge/useLoungeNameEditor';
import { t } from '../i18n';
import { textMetrics } from '../theme/text';
import { createLoungeStyles, useLoungeColor } from './theme';

export function LoungeNameFields(props: LoungeNameEditorOptions) {
  const editor = useLoungeNameEditor(props);
  const styles = useStyles(); const color = useLoungeColor();
  const label = t(editor.own ? 'client.lounge.nickname' : 'client.lounge.remark');
  return <View style={styles.root}>
    {!editor.own && <View style={styles.readonly}>
      <Text style={styles.label}>{t('client.lounge.nickname')}</Text>
      <Text style={styles.value}>{props.user.nickname || t('client.lounge.nameNotSet')}</Text>
    </View>}
    <Text style={styles.label}>{label}</Text>
    {editor.own && <Text style={styles.hint}>{t('client.lounge.nicknameHint')}</Text>}
    <TextInput value={editor.value} onChangeText={editor.change} onBlur={() => void editor.save()} style={styles.input}
      accessibilityLabel={label} placeholder={t('client.lounge.nameNotSet')} autoCorrect={false}
      placeholderTextColor={color('#687c89', 'muted')} returnKeyType="done" onSubmitEditing={() => void editor.save()} />
    {editor.own && <>
      <Text style={styles.hint}>{t('client.lounge.nameLimit', { limit: editor.limit })}</Text>
      <Text style={styles.hint}>{t('client.lounge.nameAutosaveHint')}</Text>
    </>}
    {!editor.available && <Text style={styles.hint}>{t('client.lounge.namesUnavailable')}</Text>}
    {editor.invalid && <Text accessibilityRole="alert" style={styles.error}>
      {t('client.lounge.nameInvalid', { limit: editor.limit })}</Text>}
    {editor.error && <View style={styles.failure}>
      <Text accessibilityRole="alert" style={styles.error}>{t(editor.error)}</Text>
      <Pressable accessibilityRole="button" disabled={!editor.available || editor.invalid}
        accessibilityState={{ disabled: !editor.available || editor.invalid }} onPress={() => void editor.save()}>
        <Text style={styles.retry}>{t('client.lounge.nameRetry')}</Text></Pressable>
    </View>}
    {editor.busy && <Text accessibilityLiveRegion="polite" style={styles.hint}>{t('client.lounge.nameSaving')}</Text>}
    {editor.saved && <Text accessibilityLiveRegion="polite" style={styles.hint}>{t('client.lounge.nameSaved')}</Text>}
  </View>;
}

const useStyles = createLoungeStyles(color => ({
  root: { marginTop: 24, gap: 8, maxWidth: 400 },
  readonly: { marginBottom: 16, gap: 8 },
  label: { ...textMetrics(14, 21), color: color('#202b33', 'ink'), fontWeight: '600' },
  value: { ...textMetrics(14, 21), color: color('#202b33', 'ink') },
  hint: { ...textMetrics(12, 19), color: color('#687c89', 'muted') },
  input: { ...textMetrics(16, 24), minHeight: 48, borderRadius: 12, paddingHorizontal: 12,
    paddingVertical: 10, color: color('#202b33', 'ink'), backgroundColor: color('#e9eef1', 'elevated') },
  error: { ...textMetrics(12, 19), color: color('#c14c51', 'danger'), flexShrink: 1 },
  failure: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  retry: { ...textMetrics(14, 21), color: color('#456c96', 'info'), padding: 8 },
}));
