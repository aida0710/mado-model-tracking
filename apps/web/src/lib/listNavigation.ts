/** The keys that move the highlighted entry of a listbox (Project switcher, field candidates). */
export type ListNavigationKey = 'ArrowDown' | 'ArrowUp' | 'Home' | 'End';

const LIST_NAVIGATION_KEYS: ReadonlySet<string> = new Set<ListNavigationKey>([
  'ArrowDown',
  'ArrowUp',
  'Home',
  'End',
]);

export function isListNavigationKey(key: string): key is ListNavigationKey {
  return LIST_NAVIGATION_KEYS.has(key);
}

/**
 * The entry highlighted after `key`, for a list of `count` entries where `current` is the
 * highlighted one (-1 when none is). The arrows wrap around the ends, so the last entry is one
 * ArrowUp away from the first. An empty list highlights nothing.
 */
export function moveActiveIndex({
  current,
  key,
  count,
}: {
  current: number;
  key: ListNavigationKey;
  count: number;
}): number {
  if (count === 0) return -1;
  switch (key) {
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    case 'ArrowDown':
      return current < 0 ? 0 : (current + 1) % count;
    case 'ArrowUp':
      return current < 0 ? count - 1 : (current - 1 + count) % count;
  }
}
