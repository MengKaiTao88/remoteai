import React, { Children, isValidElement, type ReactNode } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ChatMessage } from './ChatMessage';
import type { Item } from './types';

vi.mock('react', async original => ({ ...await original<typeof import('react')>(),
  memo: <T,>(component: T) => component,
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
}));
vi.mock('react-native', () => ({ Pressable: 'Pressable', Text: 'Text', View: 'View',
  StyleSheet: { create: <T,>(styles: T) => styles },
}));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Icon' }));
vi.mock('./CopyTextButton', () => ({ CopyTextButton: 'Copy' }));
vi.mock('./ChatQuoteView', () => ({ QuoteChip: 'QuoteChip', QuoteDetails: 'QuoteDetails' }));
vi.mock('./Markdown', () => ({ ChatMarkdown: ({ text }: { text: string }) => text }));
vi.mock('./UserMessageText', () => ({ UserMessageText: ({ text }: { text: string }) => text }));
vi.mock('./ChatImage', () => ({ ChatImage: 'Image' }));
vi.mock('./ChatActivityLabel', () => ({ ChatActivityLabel: 'Activity' }));
vi.mock('./ChatQuotes', async () => ({ QuoteSourceContext: (await import('react')).createContext(null) }));

function content(node: ReactNode): string {
  return Children.toArray(node).map(child => {
    if (!isValidElement<{ children?: ReactNode }>(child)) return String(child);
    if (typeof child.type === 'function') {
      return content((child.type as (props: unknown) => ReactNode)(child.props));
    }
    return content(child.props.children);
  }).join('');
}

beforeEach(() => vi.stubGlobal('React', React));
afterEach(() => vi.unstubAllGlobals());

const mention = { type: 'mention', name: '代理日志排查', path: 'codex-thread://logs' };

it.each(['继续这个任务', ''])('renders conversation references in a native user bubble with text "%s"', text => {
  const item: Item = { id: 'user', type: 'userMessage', content: [{ type: 'text', text }, mention] };
  const rendered = content(ChatMessage({ item, onOpen: vi.fn() }));
  expect(rendered).toBe(`引用对话：代理日志排查${text}`);
});

it('restores historical references in the native bubble without showing internal context', () => {
  const envelope = '<codex_gui_conversation_context>' + JSON.stringify({
    kind: 'reference', id: 'logs', name: mention.name, messages: ['PRIVATE CONTEXT'],
  }) + '</codex_gui_conversation_context>';
  const item: Item = { id: 'user', type: 'userMessage', content: ['继续这个任务\n' + envelope] };
  expect(content(ChatMessage({ item, onOpen: vi.fn() }))).toBe('引用对话：代理日志排查继续这个任务');
});
