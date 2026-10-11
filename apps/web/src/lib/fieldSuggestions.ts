/**
 * The candidates worth offering for `value`: a candidate equal to what is already typed adds
 * nothing, so it is left out (choosing a candidate otherwise keeps offering itself).
 */
export function remainingSuggestions(items: string[], value: string): string[] {
  return items.filter((item) => item !== value);
}
