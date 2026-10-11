// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ChatComposer } from '../../../web/src/chat/ChatComposer';
import type { ComposerProps } from '../../../web/src/chat/composerProps';
import type { Thread } from '../../../../shared/remote-chat/client/types';

vi.mock('../pages/codexGui/api', () => ({ guiApi: { request: vi.fn() } }));
const threads: Thread[] = [
  { id: 'current', name: '当前对话', preview: '', cwd: '/remote/project', updatedAt: 3 },
  { id: 'design', name: '远程设计讨论', preview: '', cwd: '/remote/design', updatedAt: 2 },
  { id: 'build', name: '远程构建', preview: '', cwd: '/remote/build', updatedAt: 1, status: { type: 'active' } },
];
let host: HTMLDivElement;
let root: Root;
let props: ComposerProps;

beforeEach(async () => {
  vi.useFakeTimers(); vi.clearAllMocks(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false,
    addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  props = { connection: { deviceName: '远程电脑', chooseDevice: vi.fn(), client: {
    read: vi.fn(), select: vi.fn(), subscribe: vi.fn(() => vi.fn()),
  } }, models: [], selection: { model: 'astra', effort: 'high', access: 'workspace-write' },
    contextSettings: { read: vi.fn(), write: vi.fn() }, readUsage: vi.fn(),
    readConversationMetrics: vi.fn(),
    goals: { load: vi.fn(), clear: vi.fn() }, goalBusy: false,
    catalog: { skills: [], loaded: true, loading: false, error: '', refresh: vi.fn() }, cwd: '/remote/project',
    compactReason: null, compacting: false, compact: vi.fn(), loadFiles: vi.fn(),
    loadCatalog: vi.fn().mockResolvedValue({ data: [], plugins: [
      { id: 'github', name: 'GitHub', installed: true, enabled: true },
    ] }), loadConversations: vi.fn().mockResolvedValue({ data: threads, nextCursor: null }),
    settingsBusy: false, settingsError: '', updateSettings: vi.fn(), active: true, ready: true,
    sending: false, running: false, threadId: 'current', send: vi.fn().mockResolvedValue(true), interrupt: vi.fn() };
  props.suggestions = { enabled: true,
    target: { threadId: 'current', sourceTurnId: 'turn', model: 'astra', effort: 'low' },
    request: vi.fn().mockResolvedValue({ suggestion: '按这个方案实现' }) };
  await render();
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); vi.unstubAllGlobals();
});
async function render(update: Partial<ComposerProps> = {}) {
  props = { ...props, ...update };
  await act(async () => root.render(<ChatComposer {...props} />));
}
const input = () => host.querySelector('textarea')!;
const options = () => [...host.querySelectorAll<HTMLButtonElement>('.chat-conversation-menu [role="menuitem"]')];
async function type(text: string) {
  await act(async () => {
    const node = input();
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(node, text);
    node.setSelectionRange(text.length, text.length);
    node.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => { await vi.advanceTimersByTimeAsync(180); });
}
const key = (value: string) => act(async () => {
  input().dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }));
});


const ghost = () => host.querySelector<HTMLButtonElement>('.chat-prompt-suggestion');
const advance = () => act(async () => { await vi.advanceTimersByTimeAsync(500); });

it('taps a suggestion into the draft without sending and keeps the keyboard focused', async () => {
  await advance();
  expect(ghost()?.textContent).toContain('按这个方案实现');
  expect(input().value).toBe('');
  expect(host.querySelector<HTMLButtonElement>('[aria-label="发送消息"]')?.disabled).toBe(true);
  await act(async () => ghost()!.click());
  expect(input().value).toBe('按这个方案实现');
  expect(document.activeElement).toBe(input());
  expect(ghost()).toBeNull();
  expect(props.send).not.toHaveBeenCalled();
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="发送消息"]')!.click());
  expect(props.send).toHaveBeenCalledExactlyOnceWith({ text: '按这个方案实现', images: [], ...props.selection });
});

it('accepts with Tab and leaves Enter as a newline on mobile', async () => {
  await advance(); await key('Tab');
  expect(input().value).toBe('按这个方案实现');
  await key('Enter');
  expect(props.send).not.toHaveBeenCalled();
});

it.each(['compositionstart', 'paste'])('dismisses on %s before changing the draft', async event => {
  await advance();
  await act(async () => {
    const action = new Event(event, { bubbles: true, cancelable: true });
    if (event === 'paste') Object.defineProperty(action, 'clipboardData', { value: { items: [], getData: () => '' } });
    input().dispatchEvent(action);
  });
  expect(ghost()).toBeNull();
  await key('Tab'); expect(input().value).toBe('');
  expect(props.send).not.toHaveBeenCalled();
});

it('clears on typing and never returns after clearing the draft', async () => {
  await advance(); await type('我自己的内容');
  expect(ghost()).toBeNull();
  await type(''); await advance();
  expect(ghost()).toBeNull(); expect(props.suggestions!.request).toHaveBeenCalledTimes(1);
});

it('discards a late result after typing even when the draft is cleared', async () => {
  let finish!: (value: { suggestion: string }) => void;
  vi.mocked(props.suggestions!.request).mockReturnValue(new Promise(resolve => { finish = resolve; }));
  await advance(); await type('自己的草稿'); await type('');
  await act(async () => finish({ suggestion: '过期建议' }));
  expect(ghost()).toBeNull(); expect(input().value).toBe('');
});

it('keeps ordinary chat working with a host that does not support predictions', async () => {
  vi.mocked(props.suggestions!.request).mockRejectedValue(new Error('Unsupported operation'));
  await advance(); expect(ghost()).toBeNull();
  await type('正常发送');
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="发送消息"]')!.click());
  expect(props.send).toHaveBeenCalledExactlyOnceWith({ text: '正常发送', images: [], ...props.selection });
});

it.each([{ active: false }, { ready: false }, { running: true }, { sending: true }])(
  'does not request while the composer is unavailable: %j', async update => {
    await render(update); await advance();
    expect(props.suggestions!.request).not.toHaveBeenCalled(); expect(ghost()).toBeNull();
  });

it('does not replace a draft that was written before the request delay', async () => {
  await type('保留草稿'); await advance();
  expect(props.suggestions!.request).not.toHaveBeenCalled(); expect(input().value).toBe('保留草稿');
});
