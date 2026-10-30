import { useState } from 'react';
import { Ionicons } from '@expo/vector-icons';
import { Pressable, Text, TextInput, View, useWindowDimensions } from 'react-native';
import { DEFAULT_MAPPING_HOST } from '../../../../shared/port-mapping/target';
import type { useMappingFormState } from '../chat/portMapping/useMappingFormState';
import { t } from '../i18n';
import { useThemeColor } from '../theme/store';
import { useMappingEditorStyles } from './mappingEditorStyles';

type FormState = ReturnType<typeof useMappingFormState>;
type FieldName = 'host' | 'remote' | 'local';

export function MappingEditorFields({ form }: { form: FormState }) {
  const styles = useMappingEditorStyles();
  const color = useThemeColor();
  const { fontScale } = useWindowDimensions();
  const [help, setHelp] = useState<FieldName>();
  const fields = [
    { name: 'host' as const, label: t('client.portForwarding.targetIp'), value: form.remoteHost,
      change: form.setRemoteHost, placeholder: DEFAULT_MAPPING_HOST,
      hint: t('client.portMappingEditing.leaveBlankToAccessTheRemoteComputerItself') },
    { name: 'remote' as const, label: t('client.portForwarding.remotePort'), value: form.remote,
      change: form.setRemote, placeholder: '8080', hint: t('client.mappingEditor.remotePortHelp') },
    { name: 'local' as const, label: t('client.portForwarding.localPort'), value: form.local,
      change: form.setLocal, placeholder: t('client.mappingEditor.sameAsRemote'),
      hint: t('client.portMappingEditing.leaveBlankToUseTheRemotePort') },
  ];
  return <View style={styles.section}>
    <View style={styles.fields}>{fields.map(field => <View key={field.name}
      style={[field.name === 'host' ? styles.hostField : styles.portField,
        { flexBasis: (field.name === 'remote' ? 82 : 110) * Math.max(1, fontScale) }]}>
      <View style={styles.fieldLabel}>
        <Text style={styles.label}>{field.label}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel={t('client.mappingEditor.fieldHelp',
          { field: field.label })} accessibilityState={{ expanded: help === field.name }}
          style={styles.helpButton} onPress={() => setHelp(help === field.name ? undefined : field.name)}>
          <Ionicons name="help-circle-outline" size={15} color={color('#76899c', 'muted')} />
        </Pressable>
      </View>
      <TextInput accessibilityLabel={field.label} value={field.value} onChangeText={field.change}
          autoCapitalize="none" autoCorrect={false} editable={!form.locked}
          keyboardType={field.name === 'host' ? 'default' : 'number-pad'}
          maxLength={field.name === 'host' ? undefined : 5} placeholder={field.placeholder}
          placeholderTextColor={color('#8a9bad', 'faint')}
          style={styles.input} />
    </View>)}</View>
    {help && <View style={styles.help}><Text accessibilityRole="alert" style={styles.label}>
      {fields.find(field => field.name === help)?.hint}</Text></View>}
  </View>;
}
