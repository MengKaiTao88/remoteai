// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ChatActivity } from '../../../../shared/remote-chat/views/ChatActivity';
import { ChatMessage } from '../../../../shared/remote-chat/views/ChatMessage';
import type { Item } from '../../../../shared/conversation/types';

let root: Root;
let container: HTMLDivElement;
const command: Item = { id: 'one', type: 'commandExecution', status: 'completed',
  command: 'npm test', aggregatedOutput: 'ALL TESTS PASSED' };
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false,
    addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  container = document.createElement('div'); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); });

it('opens command output in place on mobile and releases it when collapsed', async () => {
  const onOpen = vi.fn();
  await act(async () => root.render(<ChatMessage item={command} onOpen={onOpen} />));
  expect(container.textContent).not.toContain('ALL TESTS PASSED');
  const button = container.querySelector('button')!;
  await act(async () => button.click());
  expect(button.getAttribute('aria-expanded')).toBe('true');
  expect(container.textContent).toContain('ALL TESTS PASSED');
  expect(onOpen).not.toHaveBeenCalled();
  await act(async () => button.click());
  expect(container.textContent).not.toContain('ALL TESTS PASSED');
});

it('retains open grouped operations as streamed items arrive and shows earlier failures', async () => {
  const inspect = vi.fn();
  const render = (items: Item[]) => act(async () => root.render(
    <ChatActivity item={items.at(-1)!} items={items} inline onOpen={vi.fn()} onInspect={inspect}
      content={() => items.map(item => <ChatMessage key={item.id} item={item} onOpen={vi.fn()} />)} />));
  await render([command, { ...command, id: 'two', status: 'inProgress' }]);
  const group = container.querySelector('button')!;
  expect(group.textContent).toContain('运行命令（2）');
  await act(async () => group.click());
  expect(inspect).toHaveBeenCalledOnce();
  const first = container.querySelector('.chat-activity-list button') as HTMLButtonElement;
  await act(async () => first.click());
  await render([{ ...command, status: 'failed' }, { ...command, id: 'two' }, { ...command, id: 'three' }]);
  expect(group.getAttribute('aria-expanded')).toBe('true');
  expect(group.textContent).toBe('运行命令（3）失败');
  expect(container.textContent).toContain('ALL TESTS PASSED');
  expect(container.querySelector('.chat-activity-list button')).toBe(first);
});
