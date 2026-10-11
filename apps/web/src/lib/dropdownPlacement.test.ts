import { describe, expect, it } from 'vitest';
import { DROPDOWN_VIEWPORT_MARGIN, placeDropdown } from './dropdownPlacement';

const viewport = { width: 1280, height: 800 };

describe('placeDropdown', () => {
  it('ボタンの下に、ボタンの左端にそろえて開く', () => {
    const placement = placeDropdown({
      anchor: { top: 60, bottom: 90, left: 16, width: 160 },
      viewport,
      minWidth: 280,
      maxHeight: 420,
    });
    expect(placement).toEqual({ left: 16, width: 280, maxHeight: 420, top: 94 });
  });

  it('ボタンが幅より広ければボタンの幅に合わせる', () => {
    const placement = placeDropdown({
      anchor: { top: 60, bottom: 90, left: 16, width: 400 },
      viewport,
      minWidth: 280,
      maxHeight: 420,
    });
    expect(placement.width).toBe(400);
  });

  it('右端からはみ出すときは左へずらす', () => {
    const placement = placeDropdown({
      anchor: { top: 60, bottom: 90, left: 1200, width: 60 },
      viewport,
      minWidth: 280,
      maxHeight: 420,
    });
    expect(placement.left + placement.width).toBe(viewport.width - DROPDOWN_VIEWPORT_MARGIN);
  });

  it('画面より狭い幅に縮め、左右に余白を残す', () => {
    const placement = placeDropdown({
      anchor: { top: 60, bottom: 100, left: 14, width: 200 },
      viewport: { width: 360, height: 640 },
      minWidth: 400,
      maxHeight: 420,
    });
    expect(placement.left).toBe(DROPDOWN_VIEWPORT_MARGIN);
    expect(placement.width).toBe(360 - 2 * DROPDOWN_VIEWPORT_MARGIN);
  });

  it('下に余裕が無く上の方が広いときは上へ開き、高さを上の余裕に収める', () => {
    const placement = placeDropdown({
      anchor: { top: 700, bottom: 730, left: 16, width: 160 },
      viewport,
      minWidth: 280,
      maxHeight: 420,
    });
    expect(placement.top).toBeUndefined();
    expect(placement.bottom).toBe(800 - 700 + 4);
    expect(placement.maxHeight).toBe(420);
  });

  it('下に開くときは高さを下の余裕に収める', () => {
    const placement = placeDropdown({
      anchor: { top: 300, bottom: 330, left: 16, width: 160 },
      viewport: { width: 1280, height: 600 },
      minWidth: 280,
      maxHeight: 420,
    });
    expect(placement.top).toBe(334);
    expect(placement.maxHeight).toBe(600 - 330 - 4 - DROPDOWN_VIEWPORT_MARGIN);
  });
});
