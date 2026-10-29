import 'react-native-gesture-handler';
import { registerRootComponent } from 'expo';
import { useState } from 'react';
import { Image, Pressable, Text, View } from 'react-native';
import { useFonts } from 'expo-font';
import { Ionicons } from '@expo/vector-icons';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { LoungeComposer } from '../src/lounge/LoungeComposer';
import type { LoungeDraft } from '../../../shared/lounge/types';
import { setInterfaceLanguage } from '../../../shared/localization/interfaceLanguage';
import { updateThemeMode, useThemeColor } from '../src/theme/store';
import { textMetrics } from '../src/theme/text';

// Two identical attachments also exercise selecting one image without replacing its duplicate.
const source = 'data:image/png;base64,'
  + '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';
const initial: LoungeDraft = { text: '保留文字和第二张图片', images: [source, source] };
setInterfaceLanguage('zh');

function Fixture() {
  const [fonts] = useFonts(Ionicons.font);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(initial);
  const [sent, setSent] = useState<LoungeDraft>();
  const color = useThemeColor();
  const label = { ...textMetrics(16, 24), color: color('#24262c', 'ink') };
  return <SafeAreaProvider><SafeAreaView style={{ flex: 1, backgroundColor: color('#fff', 'surface') }}>
    <Pressable onPress={() => updateThemeMode('dark')}><Text style={label}>Dark fixture</Text></Pressable>
    <Pressable onPress={() => updateThemeMode('light')}><Text style={label}>Light fixture</Text></Pressable>
    {!open ? <Pressable onPress={() => { setDraft(initial); setSent(undefined); setOpen(true); }}>
      <Text style={label}>在线交流</Text></Pressable> : <>
      <Pressable onPress={() => setOpen(false)}><Text style={label}>返回</Text></Pressable>
      <View style={{ flex: 1 }}>
        {sent && <><Text style={label}>{sent.text}</Text>
          <Text style={label}>{sent.images[0] !== source && sent.images[1] === source ? 'Edited image sent' : 'Original sent'}</Text>
          {sent.images.map((uri, index) => <Image key={index} source={{ uri }} style={{ width: 180, height: 180 }} />)}</>}
      </View>
      {fonts && <LoungeComposer connected send={async value => setSent(value)} onHistory={() => {}}
        cancelReply={() => {}} draftState={{ draft, change: setDraft }} extraActions={() => null}
        onOverlayChange={() => {}} viewportHeight={800} />}
    </>}
  </SafeAreaView></SafeAreaProvider>;
}
registerRootComponent(Fixture);
