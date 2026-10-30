import 'react-native-gesture-handler';
import { registerRootComponent } from 'expo';
import { useFonts } from 'expo-font';
import { Ionicons } from '@expo/vector-icons';
import { useEffect, useState } from 'react';
import { BackHandler, Pressable, StatusBar, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import Storage from 'expo-sqlite/kv-store';
import { DeviceMappingProvider } from '../../../shared/port-mapping/deviceRegistry';
import { mappingFixture } from '../../../shared/port-mapping/testing/fixture';
import { NativeMappingTunnel } from '../src/chat/portMapping/tunnel';
import { DiscoveryPage } from '../src/discovery/DiscoveryPage';
import { PortMappingPage } from '../src/portMapping/PortMappingPage';
import { setInterfaceLanguage } from '../../../shared/localization/interfaceLanguage';
import { textMetrics } from '../src/theme/text';
import { updateThemeMode, useThemeColor } from '../src/theme/store';
import type { RemoteDevice } from '../src/types';

setInterfaceLanguage('zh');
const devices = [
  { deviceId: 'one', name: '办公电脑', online: true },
  { deviceId: 'two', name: '家用电脑', online: true },
] as RemoteDevice[];
const fixture = mappingFixture({
  storage: { getItem: key => Storage.getItemSync(`hub-fixture:${key}`),
    setItem: (key, value) => Storage.setItemSync(`hub-fixture:${key}`, value) },
  createTunnel: (client, options) => new NativeMappingTunnel(client, options),
});

function PortMappingFixture() {
  const color = useThemeColor();
  const [fonts] = useFonts(Ionicons.font);
  const [page, setPage] = useState('discover');
  useEffect(() => {
    const listener = BackHandler.addEventListener('hardwareBackPress', () => { setPage('discover'); return true; });
    return () => listener.remove();
  }, []);
  return <SafeAreaProvider><SafeAreaView style={{ flex: 1, backgroundColor: color('#f8fafc', 'canvas') }}>
    <StatusBar barStyle="dark-content" backgroundColor="#f8fafc" />
    <DeviceMappingProvider registry={fixture.registry} deviceIds={devices.map(device => device.deviceId)}>
      {fonts && (page === 'port-mappings'
        ? <PortMappingPage devices={devices} onBack={() => setPage('discover')} />
        : <DiscoveryPage onOpen={setPage} />)}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12, padding: 8 }}>
        <Pressable onPress={() => fixture.controls.forEach(control => control.ready(false))}>
          <Text style={textMetrics(14, 22)}>Disconnect fixture</Text></Pressable>
        <Pressable onPress={() => fixture.controls.forEach(control => control.ready(true))}>
          <Text style={textMetrics(14, 22)}>Reconnect fixture</Text></Pressable>
        <Pressable onPress={() => setInterfaceLanguage('en')}>
          <Text style={textMetrics(14, 22)}>English</Text></Pressable>
        {page === 'discover' && <Pressable onPress={() => updateThemeMode('dark')}>
          <Text style={textMetrics(14, 22)}>Dark</Text></Pressable>}
      </View>
    </DeviceMappingProvider>
  </SafeAreaView></SafeAreaProvider>;
}
registerRootComponent(PortMappingFixture);
