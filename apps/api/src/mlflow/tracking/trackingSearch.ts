import { createHash } from 'node:crypto';
import { inClauseSql } from '../../domain/search/inClauseSql.js';
import type { TrackingSearch } from './trackingTypes.js';
import { invalidParameter } from './trackingValidation.js';

type SearchEntity = 'run' | 'experiment';
interface Token {
  kind: 'word' | 'quoted' | 'number' | 'symbol';
  value: string;
}
interface SearchField {
  expression: string;
  kind: 'string' | 'number';
  group: string;
  key: string;
}
export interface CompiledSearch {
  filter: string;
  orderBy: string;
  parameters: unknown[];
}

// MLflow sorts numeric metrics before NaN and missing metrics in both directions.
const METRIC_SORT_PRIORITY = { number: 0, nan: 1, missing: 2 } as const;

const runAttributes: Record<string, { expression: string; kind: 'string' | 'number' }> = {
  run_id: { expression: 'r.id::text', kind: 'string' },
  run_uuid: { expression: 'r.id::text', kind: 'string' },
  experiment_id: { expression: 'r.experiment_id::text', kind: 'string' },
  run_name: { expression: 'r.name', kind: 'string' },
  user_id: { expression: 'COALESCE(r.mlflow_user_id,r.created_by::text)', kind: 'string' },
  status: {
    expression:
      "CASE r.status WHEN 'queued' THEN 'SCHEDULED' WHEN 'running' THEN 'RUNNING' WHEN 'finished' THEN 'FINISHED' WHEN 'failed' THEN 'FAILED' ELSE 'KILLED' END",
    kind: 'string',
  },
  start_time: {
    expression: '(EXTRACT(EPOCH FROM COALESCE(r.started_at,r.created_at))*1000)',
    kind: 'number',
  },
  end_time: { expression: '(EXTRACT(EPOCH FROM r.ended_at)*1000)', kind: 'number' },
  artifact_uri: {
    expression: "'mlflow-artifacts:/runs/'||r.id::text||'/artifacts'",
    kind: 'string',
  },
  lifecycle_stage: { expression: 'r.lifecycle_stage', kind: 'string' },
};
const experimentAttributes: Record<string, { expression: string; kind: 'string' | 'number' }> = {
  name: { expression: 'e.name', kind: 'string' },
  experiment_id: { expression: 'e.id::text', kind: 'string' },
  creation_time: { expression: '(EXTRACT(EPOCH FROM e.created_at)*1000)', kind: 'number' },
  last_update_time: { expression: '(EXTRACT(EPOCH FROM e.updated_at)*1000)', kind: 'number' },
};

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  const pattern =
    /\s+|`(?:[^`]|``)*`|'(?:[^']|'')*'|"(?:[^"]|"")*"|[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?|!=|>=|<=|[=<>(),.]|[\p{L}_][\p{L}\p{N}_]*/uy;
  let offset = 0;
  while (offset < text.length) {
    pattern.lastIndex = offset;
    const match = pattern.exec(text);
    if (!match) invalidParameter(`検索syntaxに未対応です（位置${offset}）`);
    const value = match[0];
    offset = pattern.lastIndex;
    if (/^\s/.test(value)) continue;
    const quote = value[0];
    if (quote === "'" || quote === '"' || quote === '`') {
      tokens.push({
        kind: 'quoted',
        value: value
          .slice(1, -1)
          .split(quote + quote)
          .join(quote),
      });
    } else if (/^[-+\d]/.test(value) || /^\.\d/.test(value)) {
      tokens.push({ kind: 'number', value });
    } else {
      tokens.push({ kind: /^[\p{L}_]/u.test(value) ? 'word' : 'symbol', value });
    }
  }
  return tokens;
}

class SearchCompiler {
  readonly parameters: unknown[];
  private tokens: Token[] = [];
  private offset = 0;
  constructor(
    private readonly entity: SearchEntity,
    initialParameters: unknown[],
  ) {
    this.parameters = [...initialParameters];
  }
  private bind(value: unknown): string {
    this.parameters.push(value);
    return `$${this.parameters.length}`;
  }
  private take(): Token {
    const token = this.tokens[this.offset++];
    if (!token) invalidParameter('検索式が途中で終わっています');
    return token;
  }
  private accept(value: string): boolean {
    const token = this.tokens[this.offset];
    if (token?.kind === 'quoted' || token?.value.toUpperCase() !== value) return false;
    this.offset++;
    return true;
  }
  private field(): SearchField {
    const first = this.take();
    if (!['word', 'quoted'].includes(first.kind)) invalidParameter('検索属性が不正です');
    let group = 'attributes';
    let key = first.value;
    if (this.accept('.')) {
      group = first.value.toLowerCase();
      const property = this.take();
      if (!['word', 'quoted'].includes(property.kind)) invalidParameter('検索keyが不正です');
      key = property.value;
      while (this.accept('.')) {
        const suffix = this.take();
        if (!['word', 'quoted'].includes(suffix.kind)) invalidParameter('検索keyが不正です');
        key += `.${suffix.value}`;
      }
    }
    if (['attribute', 'attr', 'run'].includes(group)) group = 'attributes';
    if (['metric'].includes(group)) group = 'metrics';
    if (['param', 'parameter', 'parameters'].includes(group)) group = 'params';
    if (group === 'tag') group = 'tags';
    if (group === 'dataset') group = 'datasets';
    if (group === 'attributes') {
      if (['created', 'Created'].includes(key)) key = 'start_time';
      if (['run name', 'Run name', 'Run Name'].includes(key)) key = 'run_name';
      const attributes = this.entity === 'run' ? runAttributes : experimentAttributes;
      if (!Object.hasOwn(attributes, key)) invalidParameter(`未対応の検索属性です: ${key}`);
      const attribute = attributes[key]!;
      return { ...attribute, group, key };
    }
    const alias = this.entity === 'run' ? 'r' : 'e';
    if (group === 'tags' || (this.entity === 'run' && group === 'params')) {
      const values = group === 'params' ? '(r.parameters||r.recorded_parameters)' : `${alias}.tags`;
      return { expression: `${values} ->> ${this.bind(key)}::text`, kind: 'string', group, key };
    }
    if (this.entity === 'run' && group === 'metrics') {
      return {
        expression: `(${alias}.latest_metrics ->> ${this.bind(key)}::text)::double precision`,
        kind: 'number',
        group,
        key,
      };
    }
    if (
      this.entity === 'run' &&
      group === 'datasets' &&
      ['name', 'digest', 'context'].includes(key)
    ) {
      return {
        expression: key === 'context' ? 'i.context' : `d.dataset ->> ${this.bind(key)}::text`,
        kind: 'string',
        group,
        key,
      };
    }
    invalidParameter(`未対応の検索対象です: ${group}`);
  }
  private literal(field: SearchField): string | number {
    const token = this.take();
    if (field.kind === 'number') {
      if (token.kind !== 'number' || !Number.isFinite(Number(token.value)))
        invalidParameter('数値の検索値が必要です');
      return Number(token.value);
    }
    if (token.kind !== 'quoted') invalidParameter('文字列の検索値は引用符で囲んでください');
    return token.value;
  }
  private comparison(): string {
    const field = this.field();
    const token = this.take();
    let operator = token.value.toUpperCase();
    if (token.kind === 'quoted') invalidParameter('比較演算子が不正です');
    if (operator === 'IS') {
      if (!['params', 'tags'].includes(field.group))
        invalidParameter('IS NULLはparams/tagsだけに対応しています');
      const negative = this.accept('NOT');
      if (!this.accept('NULL')) invalidParameter('IS NULLまたはIS NOT NULLが必要です');
      return `(${field.expression}) IS ${negative ? 'NOT ' : ''}NULL`;
    }
    if (operator === 'NOT') {
      if (!this.accept('IN')) invalidParameter('NOT IN以外には対応していません');
      operator = 'NOT IN';
    }
    let comparison: string;
    if (operator === 'IN' || operator === 'NOT IN') {
      if (field.group !== 'datasets' && !(field.group === 'attributes' && field.key === 'run_id'))
        invalidParameter('IN/NOT INはrun_idまたはdatasets属性だけに対応しています');
      if (!this.accept('(')) invalidParameter('INには括弧付きの値一覧が必要です');
      const values: unknown[] = [this.literal(field)];
      while (this.accept(',')) values.push(this.literal(field));
      if (!this.accept(')')) invalidParameter('INの閉じ括弧が必要です');
      comparison = inClauseSql({
        expression: field.expression,
        operator,
        valuesParameter: this.bind(values),
      });
    } else {
      const allowed =
        field.kind === 'number' ? ['=', '!=', '>', '>=', '<', '<='] : ['=', '!=', 'LIKE', 'ILIKE'];
      if (!allowed.includes(operator)) invalidParameter(`未対応の比較演算子です: ${operator}`);
      comparison = `(${field.expression}) ${operator} ${this.bind(this.literal(field))}`;
    }
    if (field.group === 'datasets') {
      return `EXISTS (SELECT 1 FROM mlflow_run_dataset_inputs i JOIN mlflow_datasets d ON d.project_id=i.project_id AND d.dataset_version_id=i.dataset_version_id WHERE i.project_id=r.project_id AND i.run_id=r.id AND ${comparison})`;
    }
    if (field.group === 'metrics') {
      // PostgreSQL treats NaN as larger than every number; the SDK only matches NaN with !=.
      const nan = `(${field.expression}) = 'NaN'::double precision`;
      return operator === '!=' ? `(${nan}) OR (${comparison})` : `NOT (${nan}) AND (${comparison})`;
    }
    return comparison;
  }
  filter(filter: string): string {
    this.tokens = tokenize(filter);
    this.offset = 0;
    if (!this.tokens.length) return 'TRUE';
    const clauses = [this.comparison()];
    while (this.offset < this.tokens.length) {
      if (!this.accept('AND')) invalidParameter('検索式の結合はANDだけに対応しています');
      clauses.push(this.comparison());
    }
    return clauses.map((clause) => `(${clause})`).join(' AND ');
  }
  orderBy(orderBy: string[]): string {
    const clauses: string[] = [];
    for (const order of orderBy) {
      this.tokens = tokenize(order);
      this.offset = 0;
      const field = this.field();
      if (
        field.group === 'datasets' ||
        (this.entity === 'experiment' && field.group !== 'attributes')
      )
        invalidParameter('この対象のorder_byには対応していません');
      const direction = this.accept('DESC') ? 'DESC' : 'ASC';
      if (direction === 'ASC') this.accept('ASC');
      if (this.offset !== this.tokens.length) invalidParameter('order_byのsyntaxが不正です');
      if (field.group === 'metrics') {
        clauses.push(
          `CASE WHEN (${field.expression}) = 'NaN'::double precision THEN ${METRIC_SORT_PRIORITY.nan}
          WHEN (${field.expression}) IS NULL THEN ${METRIC_SORT_PRIORITY.missing}
          ELSE ${METRIC_SORT_PRIORITY.number} END ASC`,
        );
      }
      clauses.push(`(${field.expression}) ${direction} NULLS LAST`);
    }
    const alias = this.entity === 'run' ? 'r' : 'e';
    if (!clauses.length)
      clauses.push(
        this.entity === 'run' ? 'COALESCE(r.started_at,r.created_at) DESC' : 'e.created_at DESC',
      );
    clauses.push(`${alias}.id ASC`);
    return clauses.join(',');
  }
}

export function compileSearch(
  entity: SearchEntity,
  search: TrackingSearch,
  parameters: unknown[],
): CompiledSearch {
  const compiler = new SearchCompiler(entity, parameters);
  const filter = compiler.filter(search.filter);
  const orderBy = compiler.orderBy(search.order_by);
  return { filter, orderBy, parameters: compiler.parameters };
}

function searchFingerprint(search: unknown): string {
  return createHash('sha256').update(JSON.stringify(search)).digest('hex');
}
export function pageOffset(pageToken: string | undefined, search: unknown): number {
  if (!pageToken) return 0;
  try {
    const page = JSON.parse(Buffer.from(pageToken, 'base64url').toString('utf8')) as {
      offset: number;
      query: string;
    };
    if (
      !Number.isSafeInteger(page.offset) ||
      page.offset < 0 ||
      page.query !== searchFingerprint(search)
    )
      invalidParameter('page_tokenが検索条件と一致しません');
    return page.offset;
  } catch {
    invalidParameter('page_tokenが不正です');
  }
}
export function nextPageToken(offset: number, search: unknown): string {
  return Buffer.from(JSON.stringify({ offset, query: searchFingerprint(search) })).toString(
    'base64url',
  );
}
