import { captureVirtualScroll, type VirtualScrollAnchor } from './virtualScroll';

const OVERSCAN_PX = 400;
type Listener = (visible: boolean, anchor: VirtualScrollAnchor | null) => void;
const observers = new Map<Element | null, {
  observer: IntersectionObserver; listeners: Map<Element, Listener>;
}>();

function scrollRoot(element: Element): Element | null {
  let parent = element.parentElement;
  while (parent) {
    if (/(auto|scroll)/.test(getComputedStyle(parent).overflowY)) return parent;
    parent = parent.parentElement;
  }
  return null;
}

/** Share one observer per scroll surface, including nested tool output panes. */
export function observeViewport(element: Element, listener: Listener) {
  const root = scrollRoot(element);
  let group = observers.get(root);
  if (!group) {
    const listeners = new Map<Element, Listener>();
    // Observe through all clipping ancestors: a tool pane can itself be outside the conversation viewport.
    const observer = new IntersectionObserver(entries => {
      const anchor = captureVirtualScroll(root);
      for (const entry of entries) listeners.get(entry.target)?.(entry.isIntersecting, anchor);
    }, { rootMargin: `${OVERSCAN_PX}px 0px` });
    group = { observer, listeners };
    observers.set(root, group);
  }
  group.listeners.set(element, listener);
  group.observer.observe(element);
  return () => {
    group.listeners.delete(element);
    group.observer.unobserve(element);
    if (!group.listeners.size) {
      group.observer.disconnect();
      observers.delete(root);
    }
  };
}
