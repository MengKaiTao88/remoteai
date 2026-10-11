// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { GitDrawer } from '../../../web/src/chat/git/GitDrawer';
import { DetailsWorkspace } from '../pages/codexGui/DetailsWorkspace';

vi.mock('../../../web/src/useDesktopLayout', () => ({ useDesktopLayout: () => true }));
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;
const visibility = vi.fn();
const panel = () => container.querySelector<HTMLElement>('[role="dialog"]')!;
const button = (label: string) => container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;
function Fixture() {
  const [open, setOpen] = useState(true);
  return <DetailsWorkspace active selected="/project">
    <button>聊天</button>
    {open && <GitDrawer active desktopDiffs onClose={() => setOpen(false)} onVisibilityChange={visibility}>
      {() => <input aria-label="草稿" defaultValue="draft" />}</GitDrawer>}
  </DetailsWorkspace>;
}
beforeEach(async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 48, 1400, 800));
  vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1400);
  localStorage.clear(); visibility.mockClear();
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(<Fixture />));
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); });

it('lives in its workspace, reserves chat space and keeps a separate resizable width preference', async () => {
  expect(panel().closest('[data-workspace-drawers]')).not.toBeNull();
  expect(panel().style.width).toBe('800px');
  expect(container.querySelector<HTMLElement>('[style*="margin-right"]')!.style.marginRight).toBe('800px');
  expect(document.activeElement).toBe(button('关闭 Git'));
  const grip = container.querySelector('[role="separator"]')!;
  await act(async () => grip.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })));
  expect(panel().style.width).toBe('776px');
  expect(localStorage.getItem('codex-switch:git-width')).toBe('776');
  expect(localStorage.getItem('codex-switch:gui-details-width')).toBeNull();
  await act(async () => grip.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
  vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(900);
  await act(async () => window.dispatchEvent(new Event('resize')));
  expect(panel().style.width).toBe('720px');
});

it('pauses refresh when minimized or the page is hidden and preserves mounted content', async () => {
  expect(visibility).toHaveBeenLastCalledWith(true);
  await act(async () => button('最小化 Git').click());
  expect(panel().hidden).toBe(true);
  expect(visibility).toHaveBeenLastCalledWith(false);
  await act(async () => [...container.querySelectorAll('button')].find(node => node.textContent === '恢复 Git')!.click());
  expect(panel().hidden).toBe(false);
  expect(container.querySelector<HTMLInputElement>('input')!.value).toBe('draft');
  expect(visibility).toHaveBeenLastCalledWith(true);
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  await act(async () => document.dispatchEvent(new Event('visibilitychange')));
  expect(visibility).toHaveBeenLastCalledWith(false);
  await act(async () => button('关闭 Git').click());
  expect(panel()).toBeNull();
});
