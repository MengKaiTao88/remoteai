// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { imageEditorHtml } from '../../../../shared/chat/imageEditorHtml';
import { MAX_IMAGE_BYTES } from '../../../../shared/lounge/types';
import { LOUNGE_IMAGE_EDITOR_LIMITS, useLoungeImageEditor,
  type LoungeImageAttachmentsProps } from '../../../../shared/lounge/useLoungeImageEditor';

const source = 'data:image/png;base64,aW1hZ2U=';
const marked = 'data:image/jpeg;base64,ZWRpdA==';
let host: HTMLDivElement;
let root: Root;
let editor: ReturnType<typeof useLoungeImageEditor>;
let props: LoungeImageAttachmentsProps;
function Fixture() { editor = useLoungeImageEditor(props); return null; }
const render = () => act(async () => root.render(<Fixture />));

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div'); root = createRoot(host);
  props = { images: [source, source], disabled: false, onEditingChange: vi.fn(),
    setImages: value => { props.images = typeof value === 'function' ? value(props.images) : value; } };
  await render();
});
afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); });

it('cancels without changing the draft, and replaces only the chosen duplicate on save', async () => {
  await act(async () => editor.open(1));
  expect(props.onEditingChange).toHaveBeenLastCalledWith(true);
  await act(async () => editor.close());
  expect(props.images).toEqual([source, source]);
  await act(async () => editor.open(1));
  editor.save(marked);
  expect(props.images).toEqual([source, marked]);
});

it('closes when sending starts or the selected image disappears and ignores stale saves', async () => {
  await act(async () => editor.open(1));
  const staleSave = editor.save;
  props.images = [source]; await render();
  expect(editor.editing).toBeUndefined();
  staleSave(marked);
  expect(props.images).toEqual([source]);
  await act(async () => editor.open(0));
  props.disabled = true; await render();
  expect(editor.editing).toBeUndefined();
  expect(props.onEditingChange).toHaveBeenLastCalledWith(false);
});

it('rejects oversized or invalid edits before changing the draft', async () => {
  await act(async () => editor.open(0));
  const oversized = `data:image/jpeg;base64,${'A'.repeat(Math.ceil((MAX_IMAGE_BYTES + 1) / 3) * 4)}`;
  for (const invalid of [oversized, 'https://example.test/image.png', 'data:image/webp;base64,YQ==']) {
    expect(() => editor.save(invalid)).toThrow();
    expect(props.images).toEqual([source, source]);
  }
});

it('uses lounge export limits in both the browser and native editor regardless of chat mode', () => {
  for (const scriptUrl of [undefined, '/image-editor.js']) {
    const html = imageEditorHtml(source, undefined, undefined, { mode: 'direct', scriptUrl,
      outputLimits: LOUNGE_IMAGE_EDITOR_LIMITS });
    expect(html).toContain(`"targetBytes":${MAX_IMAGE_BYTES}`);
    expect(html).toContain('"maxEdge":2048');
  }
});
