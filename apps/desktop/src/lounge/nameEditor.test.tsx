// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LoungeController } from '../../../../shared/lounge/controller';
import { useLoungeNameEditor } from '../../../../shared/lounge/useLoungeNameEditor';
import { useLoungeNameNavigation } from '../../../../shared/lounge/useLoungeNameNavigation';
import type { LoungeAccount, LoungeSnapshot } from '../../../../shared/lounge/types';

let controller: LoungeController;
let user: LoungeAccount;
let state: LoungeSnapshot;
let editor: ReturnType<typeof useLoungeNameEditor>;
let navigation: ReturnType<typeof useLoungeNameNavigation>;
let root: ReturnType<typeof createRoot>;
const render = () => act(() => root.render(<Harness />));
function Harness() {
  navigation = useLoungeNameNavigation();
  editor = useLoungeNameEditor({ user, state, controller, saveRef: navigation.saveRef });
  return null;
}
function deferred() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>(finish => { resolve = finish; });
  return { promise, resolve };
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  controller = new LoungeController(undefined);
  user = { id: 'alice', account: 'alice@example.test', nickname: 'Alice' };
  state = { ...controller.snapshot(), user, status: 'connected', namesAvailable: true };
  root = createRoot(document.createElement('div'));
});
afterEach(() => { act(() => root.unmount()); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('skips untouched and unchanged values, and blocks invalid or offline edits', async () => {
  const save = vi.spyOn(controller, 'setName'); render();
  await act(async () => { expect(await editor.save()).toBe(true); });
  act(() => editor.change(' Alice '));
  await act(async () => { expect(await editor.save()).toBe(true); });
  act(() => editor.change('x'.repeat(33)));
  await act(async () => { expect(await editor.save()).toBe(false); });
  state = { ...state, status: 'connecting' }; render(); act(() => editor.change('offline'));
  await act(async () => { expect(await editor.save()).toBe(false); });
  expect(editor.value).toBe('offline'); expect(save).not.toHaveBeenCalled();
});

it('deduplicates blur and Enter and preserves a newer draft while saving', async () => {
  const first = deferred();
  const save = vi.spyOn(controller, 'setName').mockReturnValue(first.promise); render();
  act(() => editor.change('First'));
  let saving!: Promise<boolean>; let duplicate!: Promise<boolean>;
  await act(async () => { saving = editor.save(); duplicate = editor.save(); });
  expect(save).toHaveBeenCalledTimes(1);
  await act(async () => {
    user = { ...user, nickname: 'First' }; first.resolve();
    expect(await saving).toBe(true); expect(await duplicate).toBe(true);
  });
  expect(save).toHaveBeenCalledTimes(1); expect(editor.saved).toBe(true);
  const second = deferred(); save.mockReturnValue(second.promise);
  act(() => editor.change('Second'));
  await act(async () => { saving = editor.save(); });
  act(() => editor.change('Still typing'));
  await act(async () => { user = { ...user, nickname: 'Second' }; second.resolve(); await saving; });
  expect(editor.value).toBe('Still typing'); expect(editor.saved).toBe(false);
});

it('saves the latest blurred edit after an in-flight request without overlapping requests', async () => {
  const first = deferred(); const second = deferred();
  const save = vi.spyOn(controller, 'setName').mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  render(); act(() => editor.change('First'));
  let next!: Promise<boolean>;
  await act(async () => { void editor.save(); });
  act(() => editor.change('Latest'));
  await act(async () => { next = editor.save(); });
  expect(save).toHaveBeenCalledTimes(1);
  await act(async () => { user = { ...user, nickname: 'First' }; first.resolve(); });
  expect(save).toHaveBeenCalledTimes(2);
  expect(save).toHaveBeenLastCalledWith({ kind: 'nickname', userId: 'alice', value: 'Latest' });
  await act(async () => { user = { ...user, nickname: 'Latest' }; second.resolve(); await next; });
  expect(editor.value).toBe('Latest'); expect(editor.saved).toBe(true);
});

it('keeps failed remarks and the profile open, then retries and closes only once', async () => {
  user = { id: 'bob', account: 'bob@example.test', remark: 'Old' };
  const save = vi.spyOn(controller, 'setName').mockRejectedValueOnce(new Error('offline'));
  const close = vi.fn(); render(); act(() => editor.change('Colleague'));
  await act(async () => { await navigation.leave(close); });
  expect(close).not.toHaveBeenCalled(); expect(editor.value).toBe('Colleague');
  expect(editor.error).toBe('client.lounge.remarkSaveFailed');
  const request = deferred(); save.mockReturnValue(request.promise);
  let leaving!: Promise<void>;
  await act(async () => { leaving = navigation.leave(close); void navigation.leave(close); });
  expect(close).not.toHaveBeenCalled();
  await act(async () => { user = { ...user, remark: 'Colleague' }; request.resolve(); await leaving; });
  expect(close).toHaveBeenCalledTimes(1); expect(editor.error).toBe('');
});

it('clears a remark and follows remote updates without overwriting unsaved input', async () => {
  user = { id: 'bob', account: 'bob@example.test', remark: 'Old' };
  const save = vi.spyOn(controller, 'setName').mockImplementation(async () => { user = { ...user, remark: '' }; });
  render(); act(() => editor.change(''));
  await act(async () => { expect(await editor.save()).toBe(true); });
  expect(save).toHaveBeenCalledWith({ kind: 'remark', userId: 'bob', value: '' });
  user = { ...user, remark: 'Remote' }; render(); expect(editor.value).toBe('Remote');
  act(() => editor.change('Draft'));
  user = { ...user, remark: 'Another update' }; render(); expect(editor.value).toBe('Draft');
});
