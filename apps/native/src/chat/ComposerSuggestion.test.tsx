import * as React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ComposerSuggestion } from './ComposerSuggestion';
import { useComposerSuggestion } from '../../../../shared/chat/useComposerSuggestion';

const prediction = vi.hoisted(() => ({ text: '按这个方案实现', dismiss: vi.fn() }));
vi.mock('../../../../shared/chat/usePromptSuggestion', () => ({ usePromptSuggestion: () => prediction }));
vi.mock('react', async () => ({ ...await vi.importActual<typeof React>('react'),
  useRef: (value: unknown) => ({ current: value }),
}));
vi.mock('react-native', () => ({ Pressable: 'Button', Text: 'Text',
  StyleSheet: { create: <T,>(styles: T) => styles } }));
vi.mock('../theme/store', () => ({ useThemeColor: () => () => '#25332b' }));
vi.mock('../i18n', () => ({ t: (text: string) => text }));
beforeEach(() => { vi.stubGlobal('React', React); vi.clearAllMocks(); });
afterEach(() => vi.unstubAllGlobals());

it('accepts a native tap once into a draft without a send action', () => {
  const fill = vi.fn();
  const suggestion = useComposerSuggestion({ value: '', blocked: false, fill });
  const button = ComposerSuggestion({ text: suggestion.text, accept: suggestion.accept })!;
  expect(button.props.accessibilityRole).toBe('button');
  expect(button.props.accessibilityLabel).toBe('填入建议');
  button.props.onPress(); button.props.onPress();
  expect(fill).toHaveBeenCalledExactlyOnceWith('按这个方案实现');
  expect(prediction.dismiss).toHaveBeenCalledOnce();
});
it('keeps the native suggestion translucent, wrapping, and within a 400px touch target', () => {
  const button = ComposerSuggestion({ text: prediction.text, accept: vi.fn() })!;
  expect(button.props.style).toMatchObject({ maxWidth: '100%', width: 400, minHeight: 44 });
  expect(button.props.children[0].props.style[0]).toMatchObject({ opacity: 0.5, flexShrink: 1 });
  expect(ComposerSuggestion({ text: '', accept: vi.fn() })).toBeNull();
});
it('discards acceptance immediately when native text entry starts', () => {
  const fill = vi.fn();
  const suggestion = useComposerSuggestion({ value: '', blocked: false, fill });
  suggestion.dismiss();
  expect(suggestion.accept()).toBe(false); expect(fill).not.toHaveBeenCalled();
});
it.each([{ value: '自己的输入', blocked: false }, { value: '', blocked: true }])(
  'never fills an occupied or unavailable native composer: %j', options => {
    const fill = vi.fn();
    expect(useComposerSuggestion({ ...options, fill }).accept()).toBe(false);
    expect(fill).not.toHaveBeenCalled();
  });
