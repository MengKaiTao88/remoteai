import 'react-native-gesture-handler';
import { registerRootComponent } from 'expo';
import { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useFonts } from 'expo-font';
import { ChatMessages } from '../src/chat/ChatMessages';
import { SelectableChatText } from '../src/chat/SelectableChatText';
import { textMetrics } from '../src/theme/text';
import samples from '../../../shared/chat/userMessageFixture.json';
import { updateThemeMode, useThemeColor, useThemeMode } from '../src/theme/store';
import type { Thread } from '../src/chat/types';

const PROMPT = samples.flicker;
const ANSWER = '已解决 4 处冲突，完成合并并推送到 `origin/devlop`，提交：`bb9ecee`。\n\n'
  + '保留了双方功能，并修复自动合并后关闭任务清理选择的错误。你的 `vite.config.ts` 本地修改未动、未提交。\n\n'
  + '验证：7 组回归、静态检查、页面交互和生产构建通过；既有类型及环境告警详见验证报告。';
const DIFF = Array.from({ length: 8 }, (_, index) => [
  `diff --git a/src/file-${index}.ts b/src/file-${index}.ts`,
  `--- a/src/file-${index}.ts`, `+++ b/src/file-${index}.ts`, '@@ -1 +1 @@', '-before', '+after',
].join('\n')).join('\n');

function App() {
  const mode = useThemeMode();
  const color = useThemeColor();
  const [fonts] = useFonts(Ionicons.font);
  const [, refresh] = useState(0);
  const [narrow, setNarrow] = useState(false);
  const [short, setShort] = useState(false);
  useEffect(() => {
    const timer = setInterval(() => refresh(value => value + 1), 200);
    return () => clearInterval(timer);
  }, []);
  const thread: Thread = { id: 'flicker', cwd: '', preview: '', updatedAt: 1,
    turns: [{ id: 'turn', status: 'completed', diff: DIFF, items: [
      { id: 'question', type: 'userMessage', text: short ? '修复好了' : PROMPT },
      { id: 'answer', type: 'agentMessage', phase: 'final_answer', text: ANSWER },
    ] }] };
  if (!fonts) return null;
  const labelStyle = { ...textMetrics(14, 25), color: color('#17211b', 'ink') };
  return <SafeAreaProvider><SafeAreaView style={{ flex: 1, backgroundColor: color('#f4f4f4', 'canvas') }}>
    <View style={{ flexDirection: 'row', padding: 16, gap: 24 }}>
      <Pressable onPress={() => setNarrow(value => !value)}><Text style={labelStyle}>Width</Text></Pressable>
      <Pressable onPress={() => setShort(value => !value)}><Text style={labelStyle}>Edit</Text></Pressable>
      <Pressable onPress={() => updateThemeMode(mode === 'light' ? 'dark' : 'light')}>
        <Text style={labelStyle}>Theme</Text>
      </Pressable>
    </View>
    <View style={{ width: narrow ? 280 : '100%', flex: 1, alignSelf: 'center' }}>
      <ChatMessages thread={thread} />
    </View>
    <View testID="recovery-container" style={{ padding: 16, backgroundColor: color('#e7f5f4', 'accentSoft') }}>
      {/* Recreate a measured one-line box with two native lines and fresh nested JSX on every refresh. */}
      <SelectableChatText testID="recovery" layoutKey={short}
        style={{ height: 25, fontSize: 14, lineHeight: 25, color: color('#17211b', 'ink') }}>
        <Text>{short ? '修复好了' : '第一行\n末尾不能被裁掉'}</Text>
      </SelectableChatText>
    </View>
  </SafeAreaView></SafeAreaProvider>;
}

registerRootComponent(App);
