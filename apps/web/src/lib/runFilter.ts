import type { Run } from '@mmt/contracts';
import { text } from '../i18n/catalog';

interface Comparison {
  namespace: 'metrics' | 'params' | 'tags';
  key: string;
  operator: string;
  expected: string | number | boolean;
}
export interface RunFilter {
  search: string;
  comparisons: Comparison[];
}
export function parseRunFilter(query: string): RunFilter {
  const trimmed = query.trim();
  if (!/^(metrics|params|tags)\./.test(trimmed)) return { search: trimmed, comparisons: [] };
  const expressions = trimmed.match(/(?:[^"']|"[^"]*"|'[^']*')+/g)?.join('') ?? trimmed;
  const parts = expressions.split(/\s+and\s+(?=(?:[^"']|"[^"]*"|'[^']*')*$)/i);
  const comparisons = parts.map((part) => {
    const match =
      /^(metrics|params|tags)\.([^\s<>=!]+)\s*(<=|>=|!=|=|<|>)\s*("[^"]*"|'[^']*'|true|false|[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)$/i.exec(
        part.trim(),
      );
    if (!match) throw new Error(text.invalidFilter);
    const [, namespace, key, operator, literal] = match;
    if (!namespace || !key || !operator || literal === undefined)
      throw new Error(text.invalidFilter);
    const expected = /^['"]/.test(literal)
      ? literal.slice(1, -1)
      : /^(true|false)$/i.test(literal)
        ? literal.toLowerCase() === 'true'
        : Number(literal);
    return { namespace: namespace as Comparison['namespace'], key, operator, expected };
  });
  return { search: '', comparisons };
}
export function matchesRunFilter(run: Run, filter: RunFilter): boolean {
  if (filter.search && !run.name.toLowerCase().includes(filter.search.toLowerCase())) return false;
  return filter.comparisons.every(({ namespace, key, operator, expected }) => {
    const values =
      namespace === 'metrics'
        ? run.latestMetrics
        : namespace === 'params'
          ? run.parameters
          : run.tags;
    const actual = values[key];
    if (actual === undefined) return false;
    if (operator === '=') return actual === expected;
    if (operator === '!=') return actual !== expected;
    if (typeof actual !== 'number' || typeof expected !== 'number') return false;
    if (operator === '<') return actual < expected;
    if (operator === '>') return actual > expected;
    if (operator === '<=') return actual <= expected;
    return actual >= expected;
  });
}
