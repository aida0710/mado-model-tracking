import { createHash } from 'node:crypto';
import { inClauseSql, type InListOperator } from '../../domain/search/inClauseSql.js';
import { invalidParameter } from './validation.js';

export class SqlParameters {
  readonly values: unknown[];
  constructor(initial: unknown[] = []) {
    this.values = [...initial];
  }
  add(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }
}

export interface SearchField {
  expression: string;
  numeric: boolean;
  // MLflow accepts IN / NOT IN only for string attributes of model version search.
  acceptsInList?: boolean;
  compileComparison?: (comparison: { operator: string; valueParameter: string }) => string;
}
type ResolveField = (field: string) => SearchField;
// PostgreSQL epoch values use seconds; protobuf and JavaScript dates use whole milliseconds.
const MILLISECONDS_PER_SECOND = 1000;

export function timestampInMillisecondsSql(column: string): string {
  return `(floor(extract(epoch FROM ${column})*${MILLISECONDS_PER_SECOND}))::bigint`;
}

// Tokenize one clause at a time so AND inside a quoted tag value remains a literal.
const FIELD_AND_OPERATOR_PATTERN =
  /\s*([A-Za-z_][A-Za-z_0-9]*(?:\.(?:`[^`]+`|"[^"]+"|'[^']+'|[A-Za-z_0-9./-]+))?)\s*(!=|>=|<=|=|>|<|ILIKE\b|LIKE\b|NOT\s+IN\b|IN\b)\s*/iy;
const LITERAL_PATTERN =
  /('(?:[^']|'')*'|"(?:[^"]|"")*"|[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)/y;
const LIST_START_PATTERN = /\(\s*/y;
const LIST_ITEM_PATTERN = /('(?:[^']|'')*'|"(?:[^"]|"")*")\s*(,\s*|\))/y;

interface CompiledComparison {
  sql: string;
  end: number;
}
interface ComparisonInput {
  filter: string;
  offset: number;
  field: SearchField;
  parameters: SqlParameters;
}

function readPattern(pattern: RegExp, text: string, offset: number): RegExpExecArray | null {
  pattern.lastIndex = offset;
  return pattern.exec(text);
}

function unquote(literal: string): string {
  return literal.slice(1, -1).replace(literal[0] === "'" ? /''/g : /""/g, literal[0]!);
}

function readValueList(filter: string, offset: number): { values: string[]; end: number } {
  if (!readPattern(LIST_START_PATTERN, filter, offset))
    invalidParameter('IN/NOT INには括弧で囲んだ値一覧が必要です');
  const values: string[] = [];
  let position = LIST_START_PATTERN.lastIndex;
  for (;;) {
    const item = readPattern(LIST_ITEM_PATTERN, filter, position);
    if (!item) invalidParameter('IN/NOT INの値一覧は引用符付きの文字列をカンマで区切ってください');
    values.push(unquote(item[1]!));
    position = LIST_ITEM_PATTERN.lastIndex;
    if (item[2] === ')') return { values, end: position };
  }
}

function compileListComparison(
  input: ComparisonInput & { operator: InListOperator },
): CompiledComparison {
  if (!input.field.acceptsInList)
    invalidParameter('IN/NOT INはModel versionの文字列属性だけに対応しています');
  const list = readValueList(input.filter, input.offset);
  return {
    sql: inClauseSql({
      expression: input.field.expression,
      operator: input.operator,
      valuesParameter: input.parameters.add(list.values),
    }),
    end: list.end,
  };
}

function compileValueComparison(input: ComparisonInput & { operator: string }): CompiledComparison {
  const match = readPattern(LITERAL_PATTERN, input.filter, input.offset);
  if (!match) invalidParameter('検索filterの構文に対応していません');
  const { field, operator } = input;
  const literal = match[1]!;
  const isQuoted = literal.startsWith("'") || literal.startsWith('"');
  const value = isQuoted ? unquote(literal) : literal;
  if (
    field.numeric
      ? isQuoted || !Number.isFinite(Number(value)) || ['LIKE', 'ILIKE'].includes(operator)
      : !isQuoted || !['=', '!=', 'LIKE', 'ILIKE'].includes(operator)
  ) {
    invalidParameter('検索fieldの型と比較演算子が一致しません');
  }
  // Preserve integer precision; PostgreSQL infers the numeric type from the compared field.
  const valueParameter = input.parameters.add(value);
  return {
    sql: field.compileComparison
      ? field.compileComparison({ operator, valueParameter })
      : `${field.expression} ${operator} ${valueParameter}`,
    end: LITERAL_PATTERN.lastIndex,
  };
}

export function compileFilter(input: {
  filter: string;
  parameters: SqlParameters;
  resolveField: ResolveField;
}): string {
  if (!input.filter.trim()) return 'TRUE';
  let offset = 0;
  const comparisons: string[] = [];
  while (offset < input.filter.length) {
    const clause = readPattern(FIELD_AND_OPERATOR_PATTERN, input.filter, offset);
    if (!clause) invalidParameter('検索filterの構文に対応していません');
    const comparisonInput: ComparisonInput = {
      filter: input.filter,
      offset: FIELD_AND_OPERATOR_PATTERN.lastIndex,
      field: input.resolveField(clause[1]!),
      parameters: input.parameters,
    };
    const operator = clause[2]!.toUpperCase().replace(/\s+/g, ' ');
    const comparison =
      operator === 'IN' || operator === 'NOT IN'
        ? compileListComparison({ ...comparisonInput, operator })
        : compileValueComparison({ ...comparisonInput, operator });
    comparisons.push(comparison.sql);
    offset = comparison.end;
    const remainder = input.filter.slice(offset);
    if (!remainder.trim()) break;
    const separator = /^\s+AND\s+/i.exec(remainder);
    if (!separator) invalidParameter('検索filterはANDによる条件指定に対応しています');
    offset += separator[0].length;
    if (offset === input.filter.length) invalidParameter('ANDの後に検索条件が必要です');
  }
  return comparisons.join(' AND ');
}

export function splitSearchField(field: string): { kind: string; key: string } {
  const separator = field.indexOf('.');
  if (separator < 0) return { kind: 'attributes', key: field };
  const kind = field.slice(0, separator);
  const rawKey = field.slice(separator + 1);
  const key = /^[`'"]/.test(rawKey) ? rawKey.slice(1, -1) : rawKey;
  if (!key) invalidParameter('検索keyが空です');
  return { kind, key };
}

export function searchFingerprint(input: unknown): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

export function pageOffset(token: string | undefined, fingerprint: string): number {
  if (!token) return 0;
  try {
    const page = JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as {
      offset?: unknown;
      fingerprint?: unknown;
    };
    if (
      typeof page.offset === 'number' &&
      Number.isSafeInteger(page.offset) &&
      page.offset >= 0 &&
      page.fingerprint === fingerprint
    )
      return page.offset;
  } catch {
    /* Invalid input is translated to the same public validation error. */
  }
  return invalidParameter('page_tokenが検索条件に一致しません');
}

export function nextPageToken(offset: number, fingerprint: string): string {
  return Buffer.from(JSON.stringify({ offset, fingerprint })).toString('base64url');
}
