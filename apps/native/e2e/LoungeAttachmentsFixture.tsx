import 'react-native-gesture-handler';
import { registerRootComponent } from 'expo';
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { useFonts } from 'expo-font';
import { Ionicons } from '@expo/vector-icons';
import { LoungeComposer } from '../src/lounge/LoungeComposer';
import { LoungeAttachment } from '../src/lounge/LoungeAttachment';
import { LoungeController } from '../../../shared/lounge/controller';
import type { LoungeDraft } from '../../../shared/lounge/types';
import type { LoungeAttachment as Attachment } from '../../../shared/lounge/attachments';
import { nativeLoungeRuntime } from '../src/lounge/useNativeLounge';
import { nativeLoungeSync } from '../src/lounge/syncTransport';
import { textMetrics } from '../src/theme/text';
import { setInterfaceLanguage } from '../../../shared/localization/interfaceLanguage';
import { updateThemeMode, useThemeColor } from '../src/theme/store';

setInterfaceLanguage('zh');
// This physical-device fixture exercises the system picker and native streaming download target.
// Cross-device encryption and path transitions are exercised by the paired browser and transport tests.
const controller = new LoungeController({ baseUrl: 'http://127.0.0.1:1', sync: nativeLoungeSync,
  authorize: async () => { throw new Error('fixture-offline'); } }, nativeLoungeRuntime);
controller.attachments.ready(true);

function Fixture() {
  const [fonts] = useFonts(Ionicons.font);
  const [open, setOpen] = useState(false), [file, setFile] = useState<Attachment>();
  const [draft, setDraft] = useState<LoungeDraft>({ text: '', images: [] });
  const color = useThemeColor();
  const label = { ...textMetrics(16, 24), color: color('#24262c', 'ink') };
  return <SafeAreaProvider><SafeAreaView style={{ flex: 1, backgroundColor: color('#fff', 'surface') }}>
    <Pressable onPress={() => updateThemeMode('dark')}><Text style={label}>Dark fixture</Text></Pressable>
    <Pressable onPress={() => updateThemeMode('light')}><Text style={label}>Light fixture</Text></Pressable>
    {!open ? <Pressable onPress={() => setOpen(true)}><Text style={label}>在线交流</Text></Pressable> : <>
      <Pressable onPress={() => setOpen(false)}><Text style={label}>返回</Text></Pressable>
      <View style={{ flex: 1, padding: 16 }}>
        {file && <LoungeAttachment file={file} controller={controller} preview={() => {}} />}
      </View>
      {fonts && <LoungeComposer connected direct filesAvailable send={async value => {
        const sent = controller.attachments.prepare({ ...value, to: 'private' }); setFile(sent.attachments?.[0]);
      }} onHistory={() => {}} cancelReply={() => {}} draftState={{ draft, change: setDraft }}
        extraActions={() => null} onOverlayChange={() => {}} viewportHeight={800} />}
    </>}
  </SafeAreaView></SafeAreaProvider>;
}
registerRootComponent(Fixture);
