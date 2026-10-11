import 'react-native-gesture-handler';
import { registerRootComponent } from 'expo';
import { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useFonts } from 'expo-font';
import { markdownAnswer, markdownQuestion } from '../../../shared/chat/markdownFixture.json';
import { ChatMessage } from '../src/chat/ChatMessage';
import lists from '../../../shared/chat/listAlignmentFixture.json';
import { updateThemeMode, useThemeMode } from '../src/theme/store';

function MarkdownFixture() {
  const [fonts] = useFonts(Ionicons.font);
  const [sample, setSample] = useState<keyof typeof lists | 'math'>('reported');
  const theme = useThemeMode();
  if (!fonts) return null;
  return <SafeAreaProvider><SafeAreaView style={{ flex: 1,
    backgroundColor: theme === 'dark' ? '#121513' : '#f4f4f4' }}>
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12, padding: 16 }}>
      {([...Object.keys(lists), 'math'] as (keyof typeof lists | 'math')[]).map(key =>
        <Pressable key={key} onPress={() => setSample(key)}><Text style={{ color: '#14806f' }}>{key}</Text></Pressable>)}
      <Pressable onPress={() => updateThemeMode(theme === 'dark' ? 'light' : 'dark')}>
        <Text style={{ color: '#14806f' }}>切换主题</Text>
      </Pressable>
    </View>
    <ScrollView contentContainerStyle={{ padding: 16, gap: 20 }}>
      {sample !== 'math' ? <ChatMessage item={{ id: sample, type: 'agentMessage', text: lists[sample] }}
        onOpen={() => {}} /> : <>
        <Text>Markdown 显示验证</Text>
        <ChatMessage item={{ id: 'question', type: 'userMessage', text: markdownQuestion }} onOpen={() => {}} />
        <ChatMessage item={{ id: 'answer', type: 'agentMessage', text: markdownAnswer }} onOpen={() => {}} />
        <View><ChatMessage item={{ id: 'math-question', type: 'userMessage', text: String.raw`\(x^2+1\)` }}
          onOpen={() => {}} /></View>
      </>}
    </ScrollView>
  </SafeAreaView></SafeAreaProvider>;
}

registerRootComponent(MarkdownFixture);
