// 24 hues 15 degrees apart at two lightness levels: 48 colors that stay readable on the light and
// the dark theme. Ids hash onto them; within one chart close hues are moved apart (below).
const SERIES_HUE_COUNT = 24;
const SERIES_HUE_STEP_DEGREES = 15;
const SERIES_SATURATION_PERCENT = 62;
const SERIES_LIGHTNESS_PERCENTS = [44, 58];
// Starts the hue circle at the application teal.
const SERIES_HUE_OFFSET_DEGREES = 177;

// Thin lines whose hues are closer than this many steps (45 degrees) read as one color, such as
// purple next to magenta. A chart moves a line's hue until its neighbors are at least this far.
const DISTINCT_HUE_STEPS = 3;

interface ColorSlot {
  hueStep: number;
  lightnessIndex: number;
}

function preferredSlot(id: string): ColorSlot {
  const slot = hashId(id) % (SERIES_HUE_COUNT * SERIES_LIGHTNESS_PERCENTS.length);
  return { hueStep: slot % SERIES_HUE_COUNT, lightnessIndex: Math.floor(slot / SERIES_HUE_COUNT) };
}

function slotColor({ hueStep, lightnessIndex }: ColorSlot): string {
  const hue = (SERIES_HUE_OFFSET_DEGREES + hueStep * SERIES_HUE_STEP_DEGREES) % 360;
  return `hsl(${hue} ${SERIES_SATURATION_PERCENT}% ${SERIES_LIGHTNESS_PERCENTS[lightnessIndex]}%)`;
}

const hueDistance = (left: number, right: number) => {
  const distance = Math.abs(left - right) % SERIES_HUE_COUNT;
  return Math.min(distance, SERIES_HUE_COUNT - distance);
};

/**
 * Colors for the series of one chart. A series' own color comes from its id alone (a Run id, or a
 * group id), so a Run keeps it across charts and when Runs are reordered, added or removed. It
 * keeps that color unless a series
 * before it (by id, so the result does not depend on the order drawn) took a hue too close; then
 * it moves to the nearest hue far enough from all of them. With many series the required distance
 * shrinks step by step, so every series still gets a color.
 */
export function distinctSeriesColors(ids: readonly string[]): Map<string, string> {
  const taken: number[] = [];
  const colors = new Map<string, string>();
  for (const id of [...new Set(ids)].sort()) {
    const preferred = preferredSlot(id);
    let hueStep = preferred.hueStep;
    search: for (let required = DISTINCT_HUE_STEPS; required > 0; required -= 1) {
      for (let offset = 0; offset < SERIES_HUE_COUNT; offset += 1) {
        // Tries the preferred hue, then one step either side, two steps, and so on.
        const shift = offset % 2 === 0 ? offset / 2 : -(offset + 1) / 2;
        const candidate = (preferred.hueStep + shift + SERIES_HUE_COUNT) % SERIES_HUE_COUNT;
        if (taken.every((step) => hueDistance(step, candidate) >= required)) {
          hueStep = candidate;
          break search;
        }
      }
    }
    taken.push(hueStep);
    colors.set(id, slotColor({ hueStep, lightnessIndex: preferred.lightnessIndex }));
  }
  return colors;
}

/** 32-bit FNV-1a: fast, and spreads similar ids (uuid prefixes, sequential names) apart. */
function hashId(id: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < id.length; index += 1) {
    hash ^= id.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
