// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ViewportContent } from '../../../../../shared/chat/ViewportContent';

const observers = new Set<Observer>();
class Observer {
  targets = new Set<Element>();
  constructor(private callback: IntersectionObserverCallback) { observers.add(this); }
  observe = (target: Element) => this.targets.add(target);
  unobserve = (target: Element) => this.targets.delete(target);
  disconnect = () => { this.targets.clear(); observers.delete(this); };
  notify(target: Element, visible: boolean) {
    this.callback([{ target, isIntersecting: visible } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver);
  }
}
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('IntersectionObserver', Observer);
  container = document.createElement('div'); document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  expect(observers.size).toBe(0);
  container.remove(); vi.unstubAllGlobals();
});
async function visible(target: Element, next: boolean) {
  await act(async () => {
    for (const observer of observers) if (observer.targets.has(target)) observer.notify(target, next);
  });
}

it('constructs only nearby content, preserves measured height, and shares its viewport observer', async () => {
  const render = vi.fn(() => <p>Expensive rich content</p>);
  await act(async () => root.render(<><ViewportContent image>{render}</ViewportContent>
    <ViewportContent image>{render}</ViewportContent></>));
  const slots = container.querySelectorAll<HTMLElement>('[data-viewport-content]');
  expect(render).not.toHaveBeenCalled();
  expect(observers.size).toBe(1);
  slots[0].getBoundingClientRect = () => ({ height: 320, width: 600 }) as DOMRect;
  await visible(slots[0], true);
  expect(render).toHaveBeenCalledTimes(1);
  await visible(slots[0], false);
  expect(container.querySelector('p')).toBeNull();
  expect(slots[0].style.height).toBe('320px');
  await visible(slots[0], true);
  expect(container.querySelectorAll('p')).toHaveLength(1);
});

it('retains an active editor and an open preview while their message is offscreen', async () => {
  await act(async () => root.render(<ViewportContent>{() => <textarea defaultValue="Draft" />}</ViewportContent>));
  const slot = container.firstElementChild!;
  await visible(slot, true);
  const editor = container.querySelector('textarea')!;
  editor.value = 'Unsaved draft';
  await visible(slot, false);
  expect(container.querySelector('textarea')).toBe(editor);
  expect(editor.value).toBe('Unsaved draft');
});

it('does not construct nested image loaders until their own slot enters the viewport', async () => {
  const image = vi.fn(() => <img alt="Screenshot" src="data:image/png;base64,aQ==" />);
  await act(async () => root.render(<ViewportContent>{() =>
    <ViewportContent image>{image}</ViewportContent>}</ViewportContent>));
  const row = container.firstElementChild!;
  await visible(row, true);
  const slot = row.firstElementChild!;
  expect(image).not.toHaveBeenCalled();
  await visible(slot, true);
  expect(image).toHaveBeenCalledTimes(1);
  await visible(row, false);
  expect(container.querySelector('img')).toBeNull();
  expect([...observers][0].targets.size).toBe(1);
});
