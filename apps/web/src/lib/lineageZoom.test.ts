import { describe, expect, it } from 'vitest';
import {
  LINEAGE_MAX_ZOOM,
  LINEAGE_MIN_ZOOM,
  LINEAGE_READABLE_ZOOM,
  fitLineageZoom,
  openingLineageZoom,
  stepLineageZoom,
} from './lineageZoom';

describe('lineage zoom', () => {
  it('fits a wide diagram into a phone-width viewport by shrinking it', () => {
    expect(fitLineageZoom(360, 1200)).toBeCloseTo(0.3);
  });

  it('does not enlarge a diagram that already fits', () => {
    expect(fitLineageZoom(1400, 700)).toBe(1);
  });

  it('stops shrinking at the smallest legible size', () => {
    expect(fitLineageZoom(200, 5000)).toBe(LINEAGE_MIN_ZOOM);
  });

  it('keeps the size until the viewport has been measured', () => {
    expect(fitLineageZoom(0, 1200)).toBe(1);
  });

  it('opens a narrow window at a readable size instead of a tiny overview', () => {
    expect(openingLineageZoom(360, 1200)).toBe(LINEAGE_READABLE_ZOOM);
    expect(openingLineageZoom(600, 800)).toBeCloseTo(0.75);
  });

  it('zooming in and out stays within the limits', () => {
    expect(stepLineageZoom(LINEAGE_MAX_ZOOM, 'in')).toBe(LINEAGE_MAX_ZOOM);
    expect(stepLineageZoom(LINEAGE_MIN_ZOOM, 'out')).toBe(LINEAGE_MIN_ZOOM);
    expect(stepLineageZoom(1, 'in')).toBeGreaterThan(1);
    expect(stepLineageZoom(1, 'out')).toBeLessThan(1);
  });
});
