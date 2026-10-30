import { Pressable, Text, View } from 'react-native';
import { useState, useSyncExternalStore } from 'react';
import type { DeviceMappingEntry } from '../../../../shared/port-mapping/deviceRegistry';
import { useMappingRowActions } from '../chat/portMapping/useMappingRowActions';
import { displayError, t, useLanguage } from '../i18n';
import { useMappingCardStyles } from './mappingCardStyles';
import { MappingCardDetails } from './MappingCardDetails';
import { MappingCardHeading } from './MappingCardHeading';
import { MappingCardAddress } from './MappingCardAddress';
import { MappingAliasEditor } from './MappingAliasEditor';

export function PortMappingCard({ mapping, deviceName, blue, edit, open }: {
  mapping: DeviceMappingEntry; deviceName?: string; blue: boolean; edit: () => void; open: () => void;
}) {
  useLanguage();
  const styles = useMappingCardStyles();
  const { entry, runtime } = mapping;
  const [renaming, setRenaming] = useState(false);
  const alias = useSyncExternalStore(runtime.aliases.subscribe, () => runtime.aliases.get(entry.id));
  const actions = useMappingRowActions(entry);
  const { enabled, busy, menu, setMenu, notice } = actions;
  return <View style={styles.card}>
    <MappingCardHeading mapping={mapping} deviceName={deviceName} alias={alias} blue={blue}
      rename={() => setRenaming(true)} actions={actions} />
    {renaming && <MappingAliasEditor mapping={mapping} deviceName={deviceName} close={() => setRenaming(false)} />}
    {menu && <View style={styles.menu}>
      <Pressable accessibilityRole="button" disabled={busy} style={styles.menuAction}
        onPress={() => { setMenu(false); edit(); }}>
        <Text style={styles.value}>{t('client.portMappingEditing.editMapping')}</Text>
      </Pressable>
      <Pressable accessibilityRole="button" disabled={entry.status === 'stopping'} style={styles.menuAction}
        onPress={() => { void runtime.service.remove(entry.id); }}>
        <Text style={styles.error}>{t('client.portForwarding.removeMapping')}</Text>
      </Pressable>
    </View>}
    <MappingCardAddress mapping={mapping} open={open} actions={actions} />
    <MappingCardDetails entry={entry} syncStatus={mapping.syncStatus} synced={runtime.sync.isSynced()} />
    {!!entry.error && <Text accessibilityRole="alert" style={styles.error}>{displayError(entry.error)}</Text>}
    {!!enabled && !!mapping.connectionError && <Text style={styles.error}>{displayError(mapping.connectionError)}</Text>}
    {!!notice && <Text style={[styles.label, styles.message]}>{t(notice)}</Text>}
  </View>;
}
