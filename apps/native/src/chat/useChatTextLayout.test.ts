import { beforeEach, expect, it, vi } from 'vitest';
import type { LayoutChangeEvent, Text } from 'react-native';
import { useChatTextLayout } from './useChatTextLayout';

const state = vi.hoisted(() => ({
  measurement: undefined as unknown,
  content: { current: undefined as unknown },
  mounted: false,
  fontScale: 1,
  cleanup: undefined as (() => void) | undefined,
  listen: vi.fn(), remove: vi.fn(), platform: { OS: 'android' },
}));
vi.mock('react', () => ({
  useRef: () => state.content,
  useState: () => [state.measurement, (update: (value: unknown) => unknown) => {
    state.measurement = update(state.measurement);
  }],
  useEffect: (effect: () => (() => void) | undefined) => {
    if (state.mounted) return;
    state.mounted = true;
    state.cleanup = effect();
  },
}));
vi.mock('react-native', () => ({
  Platform: state.platform, findNodeHandle: () => 42,
  useWindowDimensions: () => ({ fontScale: state.fontScale }),
  DeviceEventEmitter: { addListener: state.listen },
}));

const ref = { current: null as Text | null };
const overflow = { tag: 42, width: 148, height: 50.2 };
const render = (text = '.idea变化帮我加入忽略') => useChatTextLayout(ref, text);
const receive = (value: unknown) => state.listen.mock.calls[0][1](value);

beforeEach(() => {
  vi.clearAllMocks();
  state.measurement = undefined;
  state.mounted = false;
  state.fontScale = 1;
  state.platform.OS = 'android';
  state.listen.mockReturnValue({ remove: state.remove });
});

it('expands a clipped message to the actual native line height without repeated updates', () => {
  expect(render().height).toBeUndefined();
  expect(state.listen).toHaveBeenCalledWith('chatTextOverflow', expect.any(Function));
  receive(overflow);
  expect(render().height).toBe(51);
  const previous = state.measurement;
  receive(overflow);
  expect(state.measurement).toBe(previous);
  state.cleanup?.();
  expect(state.remove).toHaveBeenCalledOnce();
});

it('ignores other messages and invalid native measurements', () => {
  render();
  for (const value of [{ ...overflow, tag: 43 }, { ...overflow, height: NaN },
    { ...overflow, height: 0 }, { ...overflow, width: Infinity }, { ...overflow, width: -1 }]) receive(value);
  expect(render().height).toBeUndefined();
});

it('lets edited messages and wider layouts shrink instead of retaining an obsolete height', () => {
  render();
  receive(overflow);
  expect(render('短消息').height).toBeUndefined();
  receive(overflow);
  const layout = render('短消息');
  expect(layout.height).toBe(51);
  layout.onLayout({ nativeEvent: { layout: { width: 280 } } } as LayoutChangeEvent);
  expect(render('短消息').height).toBeUndefined();
});

it('does not subscribe to Android layout corrections on iOS', () => {
  state.platform.OS = 'ios';
  expect(render().height).toBeUndefined();
  expect(state.listen).not.toHaveBeenCalled();
});

it('remeasures after the system font scale changes in either direction', () => {
  render();
  receive(overflow);
  state.fontScale = 1.3;
  expect(render().height).toBeUndefined();
  receive({ ...overflow, height: 70 });
  expect(render().height).toBe(70);
  state.fontScale = 1;
  expect(render().height).toBeUndefined();
});
