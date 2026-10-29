import { describe, expect, it } from 'vitest';
import { messageMenuPosition } from '../../../../shared/lounge/messageMenuLayout';

describe('mobile message menu placement', () => {
  const menu = { width: 296, height: 96 };
  const viewport = { x: 0, y: 24, width: 320, height: 500 };
  it('stays beside a short message without crossing the left screen edge', () => {
    const result = messageMenuPosition({ anchor: { x: 16, y: 100, width: 60, height: 40 }, menu, viewport });
    expect(result).toEqual({ left: 12, top: 150, above: false, arrow: 34 });
  });
  it('flips above a message near the keyboard and keeps the arrow inside the rounded edge', () => {
    const result = messageMenuPosition({ anchor: { x: 275, y: 430, width: 35, height: 50 }, menu, viewport });
    expect(result).toEqual({ left: 12, top: 324, above: true, arrow: 272 });
  });
  it('keeps a tall-image menu inside an offset visual viewport', () => {
    const result = messageMenuPosition({ anchor: { x: 40, y: -100, width: 200, height: 800 }, menu,
      viewport: { x: 0, y: 100, width: 320, height: 250 } });
    expect(result.top).toBe(112);
    expect(result.top + menu.height).toBeLessThanOrEqual(338);
  });
});
