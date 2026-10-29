export interface MenuAnchor { x: number; y: number; width: number; height: number }
const MENU_MARGIN = 12;
const MENU_GAP = 10;
const ARROW_INSET = 24;
export const MESSAGE_MENU_MAX_WIDTH = 360;

/** Place the whole menu inside the visible viewport, including when the keyboard is open. */
export function messageMenuPosition({ anchor, menu, viewport }: {
  anchor: MenuAnchor; menu: { width: number; height: number }; viewport: MenuAnchor;
}) {
  const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, max));
  const center = anchor.x + anchor.width / 2;
  const left = clamp(center - menu.width / 2, viewport.x + MENU_MARGIN,
    viewport.x + viewport.width - menu.width - MENU_MARGIN);
  const below = anchor.y + anchor.height + MENU_GAP;
  const above = below + menu.height > viewport.y + viewport.height - MENU_MARGIN;
  const top = clamp(above ? anchor.y - menu.height - MENU_GAP : below,
    viewport.y + MENU_MARGIN, viewport.y + viewport.height - menu.height - MENU_MARGIN);
  return { left, top, above, arrow: clamp(center - left, ARROW_INSET, menu.width - ARROW_INSET) };
}
