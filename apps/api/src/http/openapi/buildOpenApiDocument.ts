import type { z } from 'zod';
import { apiErrorSchema, jsonValueSchema } from '@mmt/contracts/schemas';
import { SESSION_COOKIE } from '../authMiddleware.js';
import { MAX_JSON_BODY_BYTES } from '../requestBodyLimits.js';
import { JsonSchemaComponents, type JsonSchema } from './jsonSchemaComponents.js';
import {
  isNonJsonContent,
  type NativeRoute,
  type NonJsonContent,
  type RouteError,
} from './nativeRoute.js';
import { errorsOf, jobTokenAccess } from './operationErrors.js';
import { NATIVE_ROUTES } from './routeCatalog.js';

export const OPENAPI_VERSION = '3.1.0';
// The contract version of docs/api-contract.md ("API契約 v0.1").
const API_CONTRACT_VERSION = '0.1';

const DESCRIPTION = [
  'Mado Model Tracking の独自API（native API）。',
  '振る舞いの正本は docs/api-contract.md（文章）で、この文書はその形式（route・認可・入出力・エラーコード）を機械可読にしたもの。両者の食い違いは apps/api/test/openapi-coverage.test.ts が検出する。',
  'MLflow 互換API（/api/mlflow/projects/{p}/...）は MLflow 公式の REST API・proto に従うので、この文書には含めない。',
  'JSONはcamelCase、IDはUUID、日時はISO 8601（UTC）。一覧は {items: T[]}。エラーは ApiError {error, code}。',
  `JSON本文の上限は既定で${MAX_JSON_BODY_BYTES}バイト。例外は requestBody の x-mmt-max-body-bytes に書く。`,
  '各 operation の x-mmt-access は認可（Project role と API token の scope）、x-mmt-job-token は Job 限定 token（mmtj_）で呼べるか（write は token の Run に対する書き込みだけ）を示す。',
].join('\n\n');

const TAGS: { name: string; description: string }[] = [
  { name: 'system', description: '稼働確認とこの文書' },
  { name: 'auth', description: 'login・session・自分のアカウント' },
  { name: 'access', description: 'Projectのメンバー・SSO groupのbinding' },
  { name: 'tokens', description: 'API token・Service Account' },
  { name: 'projects', description: 'Project・Experiment' },
  { name: 'registry', description: 'Model・Code・Datasetの版（版は不変）' },
  { name: 'automation', description: 'モデル登録後の自動実行と連鎖' },
  { name: 'runs', description: 'Runの記録・検索・比較・再開' },
  { name: 'analysis', description: 'メトリクス系列・探索結果の分析' },
  { name: 'tasks', description: 'Task（実行の既定値）と起動' },
  { name: 'artifacts', description: 'Artifactの保存・一覧・本体・media情報' },
  { name: 'artifact-uploads', description: '再開可能なArtifact upload session' },
  { name: 'execution', description: 'Job・計算機・worker' },
  {
    name: 'worker',
    description: 'worker専用のprotocol（Projectに限定された worker:execute token）',
  },
  { name: 'sites', description: 'site（外部の計算機）の設定・job shell・個人設定・鍵・array・手動投入・runnerの報告' },
  { name: 'launcher', description: 'launcher専用のprotocol（Webで登録したlauncherのtoken）' },
  { name: 'hooks', description: 'フック（任意のタイミングの自動実行）・webhook・ドライバーの子Job' },
  { name: 'plugins', description: 'Mado plugin接続' },
  { name: 'evaluation', description: '評価結果の集約と比較' },
  { name: 'promotion', description: '昇格policyと判定履歴' },
  { name: 'collaboration', description: 'Runの説明文・コメント' },
  { name: 'media', description: 'Runのstepごとの音声・画像・動画・表' },
  { name: 'saved-views', description: 'Run一覧の保存ビュー' },
  { name: 'reports', description: '共有レポートと版の履歴' },
  { name: 'sync', description: 'オフライン記録の後送り' },
  { name: 'checkpoints', description: '学習の途中再開のcheckpoint' },
  { name: 'sweeps', description: 'ハイパーパラメータ探索' },
  { name: 'audit', description: '監査ログ' },
  { name: 'admin', description: '全体管理（保存先・ユーザー）' },
  { name: 'notifications', description: '通知先・通知rule' },
  { name: 'operations', description: '運用アラート' },
];

const SECURITY_SCHEMES = {
  sessionCookie: {
    type: 'apiKey',
    in: 'cookie',
    name: SESSION_COOKIE,
    description:
      'Webのlogin session（HttpOnly）。GET以外はOriginを検証する（許可されないOriginは403 invalid_origin）。',
  },
  bearerToken: {
    type: 'http',
    scheme: 'bearer',
    description: [
      'API token（mmt_）またはJob限定token（mmtj_）。operationのsecurityに並ぶ値は必要なscope。Project roleとtokenのProject制限も確認する。',
      'Job限定tokenはtokenのProjectの読み出し（GET・runs/search）と、x-mmt-job-token=writeのrouteのうち自分のRunへの書き込みだけを許し、それ以外は403 job_token_forbidden。',
    ].join('\n'),
  },
  mlflowBasic: {
    type: 'http',
    scheme: 'basic',
    description:
      'MLflow互換API（/api/mlflow/*）だけで受け付けるBasic認証（passwordにAPI token、usernameは無視）。native APIへのBasicは401 basic_auth_unsupported。',
  },
};

// Descriptions of the path parameters used by the catalog; every `:name` must be listed here.
const PATH_PARAMETERS: Record<string, { description: string; schema: JsonSchema }> = {
  p: { description: 'Project ID', schema: { type: 'string', format: 'uuid' } },
  projectId: { description: 'Project ID', schema: { type: 'string', format: 'uuid' } },
  r: { description: 'Run ID', schema: { type: 'string', format: 'uuid' } },
  a: { description: 'Artifact ID', schema: { type: 'string', format: 'uuid' } },
  g: { description: 'Job array（JobArrayGroup）ID', schema: { type: 'string', format: 'uuid' } },
  u: { description: 'upload session ID', schema: { type: 'string', format: 'uuid' } },
  n: { description: 'part番号（1から）', schema: { type: 'integer', minimum: 1 } },
  j: { description: 'Job ID', schema: { type: 'string', format: 'uuid' } },
  s: { description: 'Sweep ID', schema: { type: 'string', format: 'uuid' } },
  c: { description: 'Comment ID', schema: { type: 'string', format: 'uuid' } },
  mediaId: { description: 'RunMedia ID', schema: { type: 'string', format: 'uuid' } },
  reportId: { description: 'Report ID', schema: { type: 'string', format: 'uuid' } },
  v: { description: '版または保存ビューのID', schema: { type: 'string', format: 'uuid' } },
  id: { description: '対象のID', schema: { type: 'string', format: 'uuid' } },
  userId: { description: 'User ID', schema: { type: 'string', format: 'uuid' } },
  channelId: { description: '通知先ID', schema: { type: 'string', format: 'uuid' } },
  ruleId: { description: '通知rule ID', schema: { type: 'string', format: 'uuid' } },
  targetId: { description: 'ComputeTarget ID', schema: { type: 'string', format: 'uuid' } },
  shellId: { description: 'job shellの版のID', schema: { type: 'string', format: 'uuid' } },
  keyId: { description: '鍵（SiteKey）のID', schema: { type: 'string', format: 'uuid' } },
  checkId: { description: '接続確認のID', schema: { type: 'string', format: 'uuid' } },
  alias: { description: 'alias名', schema: { type: 'string', minLength: 1, maxLength: 200 } },
  group: { description: 'SSO group名', schema: { type: 'string', minLength: 1, maxLength: 256 } },
  name: {
    description: '保存先の名前',
    schema: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,62}$' },
  },
};

const SUCCESS_DESCRIPTIONS: Record<number, string> = {
  200: 'OK',
  201: '作成した',
  202: '受け付けた（非同期に処理する）',
  204: '本文なし',
  206: 'Rangeの部分',
  302: 'リダイレクト',
  304: '変更なし（If-None-Match）',
};

// Error responses carry the codes in x-mmt-error-codes; the description names the status only.
const ERROR_DESCRIPTIONS: Record<number, string> = {
  400: '要求を読めない',
  401: '認証されていない',
  403: '権限がない',
  404: '見つからない（他Projectのものを含む）',
  409: '現在の状態と衝突する',
  413: '大きすぎる',
  416: 'Rangeを読めない',
  422: '入力が不正',
  429: '試行回数の上限（Retry-After秒後に再試行）',
  503: '一時的に処理できない',
};

export interface OpenApiDocument {
  openapi: string;
  info: { title: string; version: string; description: string };
  servers: { url: string }[];
  tags: { name: string; description: string }[];
  paths: Record<string, Record<string, unknown>>;
  components: { schemas: Record<string, JsonSchema>; securitySchemes: typeof SECURITY_SCHEMES };
}

/** Builds the OpenAPI 3.1 document of the native API from the route catalog. */
export function buildOpenApiDocument(
  routes: readonly NativeRoute[] = NATIVE_ROUTES,
): OpenApiDocument {
  const components = new JsonSchemaComponents();
  // Converted first so recursive JSON values in request schemas reuse the JsonValue component.
  components.convert(jsonValueSchema, 'output');
  // Every error response refers to ApiError.
  components.convert(apiErrorSchema, 'output');
  const paths: Record<string, Record<string, unknown>> = {};
  for (const route of routes) {
    const path = openApiPath(route.path);
    paths[path] ??= {};
    if (paths[path][route.method]) throw new Error(`Duplicate route ${route.method} ${route.path}`);
    if (!TAGS.some((tag) => tag.name === route.tag))
      throw new Error(`Route ${route.method} ${route.path} has the undeclared tag ${route.tag}`);
    paths[path][route.method] = operation(route, components);
  }
  return {
    openapi: OPENAPI_VERSION,
    info: {
      title: 'Mado Model Tracking native API',
      version: API_CONTRACT_VERSION,
      description: DESCRIPTION,
    },
    servers: [{ url: '/' }],
    tags: TAGS,
    paths,
    components: {
      schemas: components.components(),
      securitySchemes: SECURITY_SCHEMES,
    },
  };
}

/** `/api/projects/:p/runs/:r` → `/api/projects/{p}/runs/{r}`. */
export function openApiPath(honoPath: string): string {
  return honoPath.replace(/:([A-Za-z]+)/g, '{$1}');
}

function operation(route: NativeRoute, components: JsonSchemaComponents): Record<string, unknown> {
  const jobToken = jobTokenAccess(route);
  return {
    operationId: operationId(route),
    tags: [route.tag],
    summary: route.summary,
    security: security(route),
    'x-mmt-access': route.access,
    ...(route.access.kind === 'public' ? {} : { 'x-mmt-job-token': jobToken ?? 'forbidden' }),
    parameters: [
      ...pathParameters(route),
      ...objectParameters(route.query, 'query', components),
      ...objectParameters(route.headers, 'header', components),
    ],
    ...(route.body ? { requestBody: requestBody(route, components) } : {}),
    responses: { ...successResponses(route, components), ...errorResponses(errorsOf(route)) },
  };
}

// Paths outside /api (the root /health) get a prefix so they differ from their /api twins.
const ROOT_OPERATION_PREFIX = 'Root';

function operationId(route: NativeRoute): string {
  const isApiPath = route.path.startsWith('/api/');
  const words = route.path
    .split('/')
    .filter((segment) => segment && !(isApiPath && segment === 'api'))
    .map((segment) => (segment.startsWith(':') ? `By${capitalize(segment.slice(1))}` : segment))
    .flatMap((segment) => segment.split(/[^A-Za-z0-9]+/))
    .filter(Boolean)
    .map(capitalize);
  return `${route.method}${isApiPath ? '' : ROOT_OPERATION_PREFIX}${words.join('')}`;
}

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

function security(route: NativeRoute): Record<string, string[]>[] {
  const { access } = route;
  if (access.kind === 'public') return [];
  if (access.kind === 'session' || ('sessionOnly' in access && access.sessionOnly))
    return [{ sessionCookie: [] }];
  // A Job token carries fixed scopes (read, runs:write, artifacts:write, registry:write).
  if (access.kind === 'jobToken') return [{ bearerToken: [] }];
  if (access.kind === 'apiToken') return [{ bearerToken: [access.scope] }];
  if (access.kind === 'launcher') return [{ bearerToken: ['launcher:execute'] }];
  const scope =
    access.kind === 'worker'
      ? 'worker:execute'
      : access.kind === 'globalAdmin'
        ? 'admin'
        : access.scope;
  return [{ sessionCookie: [] }, { bearerToken: [scope] }];
}

function pathParameters(route: NativeRoute): Record<string, unknown>[] {
  return [...route.path.matchAll(/:([A-Za-z]+)/g)].map(([, name]) => {
    const parameter = PATH_PARAMETERS[name!];
    if (!parameter) throw new Error(`Path parameter :${name} of ${route.path} has no description`);
    return { name, in: 'path', required: true, ...parameter };
  });
}

function objectParameters(
  schema: z.ZodType | undefined,
  location: 'query' | 'header',
  components: JsonSchemaComponents,
): Record<string, unknown>[] {
  if (!schema) return [];
  const converted = components.convert(schema, 'input');
  const properties = converted.properties as Record<string, JsonSchema> | undefined;
  if (converted.type !== 'object' || !properties)
    throw new Error(`The ${location} schema must be an object of named values`);
  const required = new Set((converted.required as string[] | undefined) ?? []);
  return Object.entries(properties).map(([name, property]) => {
    const { description, ...propertySchema } = property;
    return {
      name,
      in: location,
      required: required.has(name),
      ...(typeof description === 'string' ? { description } : {}),
      schema: propertySchema,
    };
  });
}

function requestBody(
  route: NativeRoute,
  components: JsonSchemaComponents,
): Record<string, unknown> {
  const body = route.body!;
  return {
    required: !route.bodyOptional,
    ...(route.maxBodyBytes ? { 'x-mmt-max-body-bytes': route.maxBodyBytes } : {}),
    ...(isNonJsonContent(body)
      ? { description: body.description, content: rawContent(body) }
      : { content: { 'application/json': { schema: components.convert(body, 'input') } } }),
  };
}

function rawContent(content: NonJsonContent): Record<string, unknown> {
  return {
    [content.contentType]: { schema: { type: 'string', contentMediaType: content.contentType } },
  };
}

function successResponses(
  route: NativeRoute,
  components: JsonSchemaComponents,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(route.responses).map(([status, content]) => {
      const description = isNonJsonContent(content)
        ? content.description
        : SUCCESS_DESCRIPTIONS[Number(status)]!;
      const response: Record<string, unknown> = { description };
      if (Number(status) === 302)
        response.headers = { Location: { schema: { type: 'string' }, description: '移動先' } };
      if (isNonJsonContent(content)) {
        if (Number(status) !== 302) response.content = rawContent(content);
      } else if (content) {
        response.content = {
          'application/json': { schema: components.convert(content, 'output') },
        };
      }
      return [status, response];
    }),
  );
}

function errorResponses(errors: RouteError[]): Record<string, unknown> {
  const codesByStatus = new Map<number, string[]>();
  for (const { status, code } of errors)
    codesByStatus.set(status, [...(codesByStatus.get(status) ?? []), code]);
  return Object.fromEntries(
    [...codesByStatus]
      .sort(([left], [right]) => left - right)
      .map(([status, codes]) => [
        String(status),
        {
          description: errorDescription(status),
          'x-mmt-error-codes': codes,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
        },
      ]),
  );
}

function errorDescription(status: number): string {
  const description = ERROR_DESCRIPTIONS[status];
  if (!description) throw new Error(`HTTP ${status} has no error description`);
  return description;
}

/** The text of docs/openapi.json; the coverage test compares the committed file with it. */
export function formatOpenApiDocument(document: OpenApiDocument): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}
