import { text, textTemplates } from '../i18n/catalog';

/** What the Run search box sends: a name substring, or an MLflow search filter. */
export type RunSearchConditions = { name: string } | { filter: string } | Record<string, never>;

// A leading `group.` marks a filter; anything else is matched against Run names.
const FILTER_PREFIX =
  /^\s*(?:metrics?|params?|parameters?|tags?|attributes?|attr|run|datasets?|dataset)\s*\./i;
const PLAIN_KEY = /^[\p{L}_][\p{L}\p{N}_]*$/u;
// Same token shapes as the API compiler, so the check rejects nothing the API accepts.
const TOKEN_PATTERN =
  /\s+|`(?:[^`]|``)*`|'(?:[^']|'')*'|"(?:[^"]|"")*"|[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?|!=|>=|<=|[=<>(),.]|[\p{L}_][\p{L}\p{N}_]*/uy;
const COMPARISON_OPERATORS = new Set(['=', '!=', '<', '<=', '>', '>=', 'LIKE', 'ILIKE']);

export function toRunSearchConditions(searchText: string): RunSearchConditions {
  const trimmed = searchText.trim();
  if (!trimmed) return {};
  return FILTER_PREFIX.test(trimmed) ? { filter: trimmed } : { name: trimmed };
}

interface Token {
  kind: 'word' | 'quoted' | 'number' | 'symbol';
  value: string;
  position: number;
}

class FilterSyntaxError extends Error {}

function tokenize(filter: string): Token[] {
  const tokens: Token[] = [];
  let offset = 0;
  while (offset < filter.length) {
    TOKEN_PATTERN.lastIndex = offset;
    const match = TOKEN_PATTERN.exec(filter);
    if (!match) throw new FilterSyntaxError(textTemplates.filterUnexpectedAt(offset + 1));
    const value = match[0];
    const position = offset;
    offset = TOKEN_PATTERN.lastIndex;
    if (/^\s/.test(value)) continue;
    const kind = /^[`'"]/.test(value)
      ? 'quoted'
      : /^[-+\d.]/.test(value) && value !== '.'
        ? 'number'
        : /^[\p{L}_]/u.test(value)
          ? 'word'
          : 'symbol';
    tokens.push({ kind, value, position });
  }
  return tokens;
}

/**
 * Checks the grammar of a filter before it is sent: `field op value` comparisons joined by AND.
 * Whether a field or operator is supported is left to the API, which reports it with a 400.
 */
class FilterGrammar {
  private offset = 0;
  constructor(
    private readonly tokens: Token[],
    private readonly length: number,
  ) {}
  check(): void {
    this.comparison();
    while (this.offset < this.tokens.length) {
      if (!this.accept('AND')) this.fail();
      this.comparison();
    }
  }
  private peek(): Token | undefined {
    return this.tokens[this.offset];
  }
  private fail(): never {
    const position = this.peek()?.position ?? this.length;
    throw new FilterSyntaxError(textTemplates.filterUnexpectedAt(position + 1));
  }
  private accept(keyword: string): boolean {
    const token = this.peek();
    if (!token || token.kind === 'quoted' || token.value.toUpperCase() !== keyword) return false;
    this.offset++;
    return true;
  }
  private name(): void {
    const token = this.peek();
    if (!token || (token.kind !== 'word' && token.kind !== 'quoted')) this.fail();
    this.offset++;
  }
  private value(): void {
    const token = this.peek();
    if (!token || (token.kind !== 'quoted' && token.kind !== 'number')) this.fail();
    this.offset++;
  }
  private comparison(): void {
    this.name();
    while (this.accept('.')) this.name();
    if (this.accept('IS')) {
      this.accept('NOT');
      if (!this.accept('NULL')) this.fail();
      return;
    }
    const negated = this.accept('NOT');
    if (negated || this.accept('IN')) {
      if (negated && !this.accept('IN')) this.fail();
      if (!this.accept('(')) this.fail();
      this.value();
      while (this.accept(',')) this.value();
      if (!this.accept(')')) this.fail();
      return;
    }
    const operator = this.peek();
    if (
      !operator ||
      operator.kind === 'quoted' ||
      !COMPARISON_OPERATORS.has(operator.value.toUpperCase())
    )
      this.fail();
    this.offset++;
    this.value();
  }
}

/** Returns the message for a filter the API would reject as malformed, or null. */
export function findRunFilterSyntaxError(filter: string): string | null {
  try {
    const tokens = tokenize(filter);
    if (!tokens.length) return text.filterEmpty;
    new FilterGrammar(tokens, filter.length).check();
    return null;
  } catch (error) {
    if (error instanceof FilterSyntaxError) return error.message;
    throw error;
  }
}

/** Run list orders. `metric:<direction>:<key>` sorts by the latest value of that metric. */
export type RunSort = 'newest' | 'oldest' | 'name' | `metric:${'asc' | 'desc'}:${string}`;

export function metricRunSort(key: string, direction: 'asc' | 'desc'): RunSort {
  return `metric:${direction}:${key}`;
}

export function parseMetricRunSort(
  sort: string,
): { key: string; direction: 'asc' | 'desc' } | null {
  const match = /^metric:(asc|desc):(.+)$/s.exec(sort);
  return match ? { direction: match[1] as 'asc' | 'desc', key: match[2]! } : null;
}

function quoteSearchKey(key: string): string {
  return PLAIN_KEY.test(key) ? key : `\`${key.replaceAll('`', '``')}\``;
}

/** The API orderBy for a sort. Newest first is the API default and keeps the keyset cursor. */
export function runSortOrderBy(sort: string): string[] {
  if (sort === 'oldest') return ['attributes.start_time ASC'];
  if (sort === 'name') return ['attributes.run_name ASC'];
  const metric = parseMetricRunSort(sort);
  if (metric) return [`metrics.${quoteSearchKey(metric.key)} ${metric.direction.toUpperCase()}`];
  return [];
}
