import type { ReactNode } from 'react';
import { Ionicons } from '@expo/vector-icons';
import { Pressable, Text, View } from 'react-native';
import { MAPPING_PROTOCOLS } from '../../../../shared/port-mapping/settings';
import { useMappingFormState, type MappingFormOptions } from '../chat/portMapping/useMappingFormState';
import { displayError, t, useLanguage } from '../i18n';
import { useThemeColor } from '../theme/store';
import { MappingEditorFields } from './MappingEditorFields';
import { useMappingEditorStyles } from './mappingEditorStyles';

export function MappingEditorForm({ devicePicker, ...options }: MappingFormOptions & { devicePicker: ReactNode }) {
  useLanguage();
  const form = useMappingFormState({ ...options, startOnAdd: false });
  const styles = useMappingEditorStyles();
  return <View style={styles.card}>
    <Text accessibilityRole="header" style={styles.title}>
      {t(options.entry ? 'client.portMappingEditing.editMapping' : 'client.portMappingEditing.addMapping')}</Text>
    {devicePicker}
    <View style={styles.section}>
      <Text style={styles.label}>{t('client.mappingEditor.protocolType')}</Text>
      <View style={styles.choices} accessibilityRole="radiogroup"
        accessibilityLabel={t('client.mappingEditor.protocolType')}>
        {MAPPING_PROTOCOLS.map(protocol => <Pressable key={protocol} accessibilityRole="radio"
          accessibilityLabel={protocol === 'both' ? t('client.portForwarding.bothTcpUdp') : protocol.toUpperCase()}
          accessibilityState={{ checked: form.protocol === protocol, disabled: !!form.locked }}
          disabled={form.locked} onPress={() => form.setProtocol(protocol)}
          style={[styles.choice, protocol === 'both' && styles.bothChoice,
            form.protocol === protocol && styles.selected, form.locked && styles.disabled]}>
          <Text style={[styles.choiceText, form.protocol === protocol && styles.selectedText]}>
            {protocol === 'both' ? t('client.portForwarding.bothTcpUdp') : protocol.toUpperCase()}</Text>
        </Pressable>)}
      </View>
    </View>
    <MappingEditorFields form={form} />
    <MappingExplanation />
    {!!form.error && <Text accessibilityRole="alert" style={styles.error}>{displayError(form.error)}</Text>}
    <View style={styles.actions}>
      <Pressable accessibilityRole="button" disabled={form.saving} onPress={form.reset}
        style={[styles.button, form.saving && styles.disabled]}>
        <Text style={styles.buttonText}>{t('client.accounts.cancel')}</Text></Pressable>
      <Pressable accessibilityRole="button" disabled={form.locked} onPress={() => { void form.submit(); }}
        style={[styles.button, styles.submit, form.locked && styles.disabled]}>
        <Text style={[styles.buttonText, styles.submitText]}>{t(options.entry
          ? 'client.portMappingEditing.saveChanges' : 'client.mappingEditor.save')}</Text></Pressable>
    </View>
  </View>;
}

function MappingExplanation() {
  const styles = useMappingEditorStyles();
  const color = useThemeColor();
  return <View style={styles.note}>
    <View style={styles.noteHeading}>
      <Ionicons name="information-circle-outline" size={18} color={color('#009681', 'accent')} />
      <Text style={styles.noteTitle}>{t('client.mappingEditor.explanation')}</Text>
    </View>
    <Text style={styles.noteText}>{t('client.mappingEditor.description')}</Text>
  </View>;
}
