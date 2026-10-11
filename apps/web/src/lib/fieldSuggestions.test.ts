import { describe, expect, it } from 'vitest';
import { remainingSuggestions } from './fieldSuggestions';

describe('remainingSuggestions', () => {
  it('入力済みの値と同じ候補を除き、ほかは順を保って残す', () => {
    expect(remainingSuggestions(['/data/mmt', '/data/mmt-old', '/data/mmt2'], '/data/mmt')).toEqual([
      '/data/mmt-old',
      '/data/mmt2',
    ]);
  });

  it('一致が無ければすべて残す', () => {
    expect(remainingSuggestions(['/data/a', '/data/b'], '/data/')).toEqual(['/data/a', '/data/b']);
  });
});
