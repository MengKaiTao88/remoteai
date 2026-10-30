import { useState } from 'react';
import { Text, TextInput, View } from 'react-native';
import type { DeviceMappingEntry } from '../../../../shared/port-mapping/deviceRegistry';
import { MAX_MAPPING_ALIAS_LENGTH } from '../../../../shared/port-mapping/localAliases';
import { BottomSheet } from '../components/BottomSheet';
import { displayError, t } from '../i18n';
import { useThemeColor } from '../theme/store';
import { useMappingEditorStyles } from './mappingEditorStyles';

export function MappingAliasEditor({ mapping, deviceName, close }: {
  mapping: DeviceMappingEntry; deviceName?: string; close: () => void;
}) {
  const styles = useMappingEditorStyles();
  const color = useThemeColor();
  const [alias, setAlias] = useState(mapping.runtime.aliases.get(mapping.entry.id));
  const [error, setError] = useState('');
  const save = () => {
    try { mapping.runtime.aliases.set(mapping.entry.id, alias); close(); }
    catch (reason) { setError(displayError(reason)); }
  };
  return <BottomSheet visible title={t('client.mappingEditor.editAlias')} onClose={close} maxWidth={400}
    actions={[{ label: t('client.accounts.cancel'), onPress: close },
      { label: t('client.mappingEditor.save'), onPress: save, tone: 'primary' }]}>
    <View style={styles.section}>
      <Text style={styles.label}>{t('client.mappingEditor.alias')}</Text>
      <TextInput accessibilityLabel={t('client.mappingEditor.alias')} value={alias} onChangeText={setAlias}
        maxLength={MAX_MAPPING_ALIAS_LENGTH} placeholder={deviceName ?? t('client.mappingHub.device')}
        placeholderTextColor={color('#8a9bad', 'faint')} style={styles.input} autoFocus selectTextOnFocus />
      <Text style={styles.label}>{t('client.mappingEditor.aliasHint')}</Text>
      {!!error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
    </View>
  </BottomSheet>;
}
