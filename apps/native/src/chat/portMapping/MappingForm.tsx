import { displayError } from '../../i18n/index';
import { useState, type ReactNode } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import type { ForwardingEntry, PortForwardingService } from '../../../../../shared/port-mapping/service';
import { t } from '../../i18n';
import { useMappingStyles } from './mappingStyles';
import { MAPPING_PROTOCOLS, type MappingProtocol } from '../../../../../shared/port-mapping/settings';

export function MappingForm({ service, disabled, connected = true, entry, done, devicePicker }: {
  service: PortForwardingService; disabled?: boolean; connected?: boolean; entry?: ForwardingEntry; done?: () => void;
  devicePicker?: ReactNode;
}) {
  const styles = useMappingStyles();
  const [remoteHost, setRemoteHost] = useState(entry?.remoteHost ?? '');
  const [protocol, setProtocol] = useState<MappingProtocol>(entry?.protocol ?? 'tcp');
  const [remote, setRemote] = useState(entry ? String(entry.remotePort) : '');
  const [local, setLocal] = useState(entry ? String(entry.localPort) : '');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const reset = () => { setRemoteHost(''); setRemote(''); setLocal(''); setProtocol('tcp'); setError(''); done?.(); };
  const submit = async () => {
    if (disabled || saving) return;
    setSaving(true);
    try {
      const target = { remoteHost, remotePort: Number(remote), localPort: Number(local || remote), protocol };
      if (entry) await service.edit(entry.id, target);
      else service.add(target.remotePort, target.localPort, target.remoteHost, protocol);
      reset();
    } catch (reason) { setError(reason instanceof Error ? reason.message : '映射未能保存，请重试。'); }
    finally { setSaving(false); }
  };
  const locked = disabled || saving;
  return <View style={styles.form}>
    <Text style={styles.title}>{t(entry ? "client.portMappingEditing.editMapping" : "client.portMappingEditing.addMapping")}</Text>
    {devicePicker}
    <View style={styles.fields} accessibilityRole="radiogroup" accessibilityLabel={t("client.portForwarding.protocol")}>
      {MAPPING_PROTOCOLS.map(value => <Pressable key={value} accessibilityRole="radio"
        accessibilityLabel={value === 'both' ? t("client.portForwarding.bothTcpUdp") : value.toUpperCase()}
        accessibilityState={{ checked: protocol === value, disabled: !!locked }} disabled={locked}
        onPress={() => setProtocol(value)} style={[styles.button, protocol === value && styles.primary]}>
        <Text style={protocol === value ? styles.primaryText : styles.buttonText}>
          {value === 'both' ? t("client.portForwarding.bothTcpUdp") : value.toUpperCase()}</Text></Pressable>)}
    </View>
    <View style={styles.fields}>
      <View style={styles.hostField}><Text style={styles.muted}>{t("client.portForwarding.targetIp")}</Text>
        <TextInput accessibilityLabel={t("client.portForwarding.targetIp")} value={remoteHost} onChangeText={setRemoteHost}
          autoCapitalize="none" autoCorrect={false} placeholder="192.168.1.100" placeholderTextColor="#8a9bad"
          style={styles.input} editable={!locked} /></View>
      <View style={styles.portField}><Text style={styles.muted}>{t("client.portForwarding.remotePort")}</Text>
        <TextInput accessibilityLabel={t("client.portForwarding.remotePort")} value={remote} onChangeText={setRemote}
          keyboardType="number-pad" maxLength={5} placeholder="8080" placeholderTextColor="#8a9bad"
          style={styles.input} editable={!locked} /></View>
      <View style={styles.portField}><Text style={styles.muted}>{t("client.portForwarding.localPort")}</Text>
        <TextInput accessibilityLabel={t("client.portForwarding.localPort")} value={local} onChangeText={setLocal}
          keyboardType="number-pad" maxLength={5} placeholder={remote || t("client.portForwarding.sameAsRemote")}
          placeholderTextColor="#8a9bad" style={styles.input} editable={!locked} /></View>
    </View>
    {!!error && <Text accessibilityRole="alert" style={styles.error}>{displayError(error)}</Text>}
    <View style={styles.actions}>
      <Pressable accessibilityRole="button" onPress={reset} disabled={saving} style={styles.button}>
        <Text style={styles.buttonText}>{t("client.accounts.cancel")}</Text></Pressable>
      <Pressable accessibilityRole="button" disabled={locked} onPress={() => { void submit(); }}
        style={[styles.button, styles.primary, locked && styles.disabled]}>
        <Text style={styles.primaryText}>{t(entry ? "client.portMappingEditing.saveChanges" : connected ? "client.portForwarding.addAndStart" : "client.portMappingEditing.addMapping")}</Text>
      </Pressable>
    </View>
  </View>;
}
