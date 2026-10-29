// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { LoungePreview } from '../../../../shared/lounge/LoungePreview';
import { saveLoungeImage } from '../../../../shared/lounge/saveImage';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), isTauri: vi.fn(() => true) }));
const source = 'data:image/gif;base64,R0lGODlh';
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isTauri).mockReturnValue(true);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it('passes unchanged image bytes to the viewing desktop save dialog and accepts cancellation', async () => {
  vi.mocked(invoke).mockResolvedValue({ completed: false });
  await expect(saveLoungeImage(source)).resolves.toBeUndefined();
  expect(invoke).toHaveBeenCalledExactlyOnceWith('codex_gui_image_action', {
    request: { source, action: 'saveAs' },
  });
});

it('rejects unsupported sources before invoking a native action', async () => {
  await expect(saveLoungeImage('https://example.test/image.png')).rejects.toThrow();
  expect(invoke).not.toHaveBeenCalled();
});

it('saves cached images larger than the current default sending limit', async () => {
  vi.mocked(invoke).mockResolvedValue({ completed: true });
  const cached = 'data:image/png;base64,' + 'AAAA'.repeat(500_000);
  await expect(saveLoungeImage(cached)).resolves.toBeUndefined();
  expect(invoke).toHaveBeenCalledExactlyOnceWith('codex_gui_image_action', {
    request: { source: cached, action: 'saveAs' },
  });
});

it('keeps saving single-flight and leaves the preview open after cancellation', async () => {
  let finish: (result: { completed: boolean }) => void = () => {};
  vi.mocked(invoke).mockReturnValue(new Promise(resolve => { finish = resolve; }));
  const close = vi.fn();
  await act(async () => root.render(<LoungePreview uri={source} close={close} />));
  const save = container.querySelector<HTMLButtonElement>('.cs-image-download')!;
  await act(async () => { save.click(); save.click(); });
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(save.disabled).toBe(true);
  expect(save.getAttribute('aria-busy')).toBe('true');
  await act(async () => finish({ completed: false }));
  expect(save.disabled).toBe(false);
  expect(container.querySelector('[role="status"]')).toBeNull();
  expect(close).not.toHaveBeenCalled();
});

it('shows a safe error and lets the user retry without closing the image', async () => {
  vi.mocked(invoke).mockRejectedValueOnce(new Error('private path and stack'))
    .mockResolvedValueOnce({ completed: true });
  await act(async () => root.render(<LoungePreview uri={source} close={() => {}} />));
  const save = container.querySelector<HTMLButtonElement>('.cs-image-download')!;
  await act(async () => save.click());
  expect(container.querySelector('[role="status"]')?.textContent).toBe('图片未能保存，请重试。');
  expect(container.textContent).not.toContain('private path');
  await act(async () => save.click());
  expect(invoke).toHaveBeenCalledTimes(2);
  expect(container.querySelector('[role="status"]')).toBeNull();
});
