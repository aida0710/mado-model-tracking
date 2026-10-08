// 24 hues 15 degrees apart at two lightness levels: 48 colors that stay readable on the light and
// the dark theme. Ids hash onto them, so two Runs can share a color; the legend tells them apart.
const SERIES_HUE_COUNT = 24;
const SERIES_HUE_STEP_DEGREES = 15;
const SERIES_SATURATION_PERCENT = 62;
const SERIES_LIGHTNESS_PERCENTS = [44, 58];
// Starts the hue circle at the application teal.
const SERIES_HUE_OFFSET_DEGREES = 177;

/**
 * The color of a series, decided by its id alone (a Run id, or a group id). The same Run gets the
 * same color in every chart and keeps it when Runs are reordered, added or removed.
 */
export function seriesColor(id: string): string {
  const slot = hashId(id) % (SERIES_HUE_COUNT * SERIES_LIGHTNESS_PERCENTS.length);
  const hue = (SERIES_HUE_OFFSET_DEGREES + (slot % SERIES_HUE_COUNT) * SERIES_HUE_STEP_DEGREES) % 360;
  const lightness = SERIES_LIGHTNESS_PERCENTS[Math.floor(slot / SERIES_HUE_COUNT)];
  return `hsl(${hue} ${SERIES_SATURATION_PERCENT}% ${lightness}%)`;
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
