import type { MiddlewareHandler } from 'hono';
import type { JobTokenBinding } from '../auth/principal.js';
import type { Database } from '../db/database.js';
import { DomainError } from '../domain/errors.js';
import { decodeArtifactLocation } from '../mlflow/artifacts/artifactPath.js';
import { decodeMultipartDirectory } from '../mlflow/artifacts/multipartProtocol.js';
import type { ArtifactLocation } from '../mlflow/artifacts/artifactTypes.js';
import {
  findArtifactUploadRunId,
  findLoggedModelSourceRunId,
} from '../repositories/jobTokenRepository.js';
import type { ApiContext, ApiEnvironment } from './request.js';

/**
 * Limits what a Job token (mmtj_) can reach. The code a Job runs is not trusted with its
 * creator's full role: it may read its Project and write only its own Run, that Run's
 * artifacts, and registrations whose source is that Run. Everything else is refused, so a
 * route added later stays closed to Job tokens until it is listed here.
 */

export interface JobTokenRequest {
  projectId: string;
  job: JobTokenBinding;
  params: Record<string, string>;
  body: () => Promise<Record<string, unknown> | null>;
  database: Database;
}

export interface JobTokenRule {
  methods: readonly string[];
  // Path template in Hono syntax: `:name` matches one segment, a trailing `*` the rest.
  route: string;
  allows: (request: JobTokenRequest) => boolean | Promise<boolean>;
}

const NATIVE = '/api/projects/:p';
const MLFLOW = '/api/mlflow/projects/:p/api/2.0/mlflow';
const MLFLOW_ARTIFACTS = '/api/mlflow/projects/:p/api/2.0/mlflow-artifacts/artifacts';
const MLFLOW_MULTIPART = '/api/mlflow/projects/:p/api/2.0/mlflow-artifacts/mpu';

function sameId(value: unknown, expected: string): boolean {
  return typeof value === 'string' && value.toLowerCase() === expected.toLowerCase();
}

// Allowed for any request inside the token's Project (no Run to compare).
export const allowWithinProject = () => true;
const ownRunInPath = (request: JobTokenRequest) => sameId(request.params.r, request.job.runId);
const ownRunInBody = (field: string) => async (request: JobTokenRequest) =>
  sameId((await request.body())?.[field], request.job.runId);
// MLflow accepts run_uuid as an alias; the tracking validation rejects a mismatched pair.
const ownMlflowRunInBody = async (request: JobTokenRequest) => {
  const body = await request.body();
  const runId = body?.run_id ?? body?.run_uuid;
  return (
    sameId(runId, request.job.runId) &&
    (body?.run_uuid === undefined || sameId(body.run_uuid, request.job.runId))
  );
};
const ownLoggedModel = async (request: JobTokenRequest) =>
  sameId(
    await findLoggedModelSourceRunId(request.database, {
      projectId: request.projectId,
      id: request.params.model_id!,
    }),
    request.job.runId,
  );
const ownArtifactUpload = async (request: JobTokenRequest) =>
  sameId(
    await findArtifactUploadRunId(request.database, {
      projectId: request.projectId,
      id: request.params.u!,
    }),
    request.job.runId,
  );
const ownArtifactLocation = (decode: (encodedPath: string) => ArtifactLocation) => async (
  request: JobTokenRequest,
) => {
  let location;
  try {
    location = decode(request.params['*']!);
  } catch {
    return false;
  }
  if (location.owner.kind === 'run') return sameId(location.owner.id, request.job.runId);
  if (location.owner.kind !== 'model') return false;
  return ownLoggedModel({
    ...request,
    params: { ...request.params, model_id: location.owner.id },
  });
};

// The registered files must come from this Run or one of its Logged Models; copying another
// Run's files or another registered version under this Run's name is refused.
const ownRegistrationSource = async (request: JobTokenRequest) => {
  const body = await request.body();
  if (body?.run_id !== undefined && !sameId(body.run_id, request.job.runId)) return false;
  const source = typeof body?.source === 'string' ? body.source : '';
  const loggedModelId =
    /^models:\/(m-[a-f0-9]{32})$/.exec(source)?.[1] ??
    /^mlflow-artifacts:\/models\/(m-[a-f0-9]{32})\/artifacts\/?$/.exec(source)?.[1];
  if (loggedModelId)
    return ownLoggedModel({ ...request, params: { ...request.params, model_id: loggedModelId } });
  const runId =
    /^runs:\/([0-9a-f-]{36})\//.exec(source)?.[1] ??
    /^mlflow-artifacts:\/runs\/([0-9a-f-]{36})\/artifacts(?:\/|$)/.exec(source)?.[1];
  return sameId(runId, request.job.runId);
};

const MLFLOW_RUN_WRITES = [
  'update',
  'log-parameter',
  'log-metric',
  'log-batch',
  'set-tag',
  'delete-tag',
  'log-inputs',
  'outputs',
  'log-model',
];

export const JOB_TOKEN_WRITE_RULES: readonly JobTokenRule[] = [
  { methods: ['PATCH'], route: `${NATIVE}/runs/:r`, allows: ownRunInPath },
  { methods: ['POST'], route: `${NATIVE}/runs/:r/metrics`, allows: ownRunInPath },
  { methods: ['POST'], route: `${NATIVE}/runs/:r/logs`, allows: ownRunInPath },
  { methods: ['PUT'], route: `${NATIVE}/runs/:r/artifacts`, allows: ownRunInPath },
  { methods: ['POST'], route: `${NATIVE}/runs/:r/checkpoints`, allows: ownRunInPath },
  { methods: ['POST'], route: `${NATIVE}/artifact-uploads`, allows: ownRunInBody('runId') },
  {
    methods: ['PUT'],
    route: `${NATIVE}/artifact-uploads/:u/parts/:n`,
    allows: ownArtifactUpload,
  },
  {
    methods: ['POST'],
    route: `${NATIVE}/artifact-uploads/:u/complete`,
    allows: ownArtifactUpload,
  },
  { methods: ['DELETE'], route: `${NATIVE}/artifact-uploads/:u`, allows: ownArtifactUpload },
  // Creating the output Model lets a Task register into a model name that does not exist yet.
  { methods: ['POST'], route: `${NATIVE}/models`, allows: allowWithinProject },
  {
    methods: ['POST'],
    route: `${NATIVE}/models/:m/versions`,
    allows: ownRunInBody('sourceRunId'),
  },
  {
    methods: ['POST'],
    route: `${NATIVE}/datasets/:d/versions`,
    allows: ownRunInBody('sourceRunId'),
  },
  ...MLFLOW_RUN_WRITES.map((action) => ({
    methods: ['POST'],
    route: `${MLFLOW}/runs/${action}`,
    allows: ownMlflowRunInBody,
  })),
  {
    methods: ['POST'],
    route: `${MLFLOW}/model-versions/create`,
    allows: ownRegistrationSource,
  },
  { methods: ['POST'], route: `${MLFLOW}/registered-models/create`, allows: allowWithinProject },
  {
    methods: ['POST'],
    route: `${MLFLOW}/logged-models`,
    allows: ownRunInBody('source_run_id'),
  },
  { methods: ['PATCH'], route: `${MLFLOW}/logged-models/:model_id`, allows: ownLoggedModel },
  { methods: ['PATCH'], route: `${MLFLOW}/logged-models/:model_id/tags`, allows: ownLoggedModel },
  {
    methods: ['DELETE'],
    route: `${MLFLOW}/logged-models/:model_id/tags/:tag_key`,
    allows: ownLoggedModel,
  },
  {
    methods: ['POST'],
    route: `${MLFLOW}/logged-models/:model_id/params`,
    allows: ownLoggedModel,
  },
  {
    methods: ['PUT'],
    route: `${MLFLOW_ARTIFACTS}/*`,
    allows: ownArtifactLocation(decodeArtifactLocation),
  },
  // Part PUTs carry no Authorization (the part token is checked by the session), so only the
  // session-opening and closing requests reach this guard.
  ...['create', 'complete', 'abort'].map((action) => ({
    methods: ['POST'],
    route: `${MLFLOW_MULTIPART}/${action}/*`,
    allows: ownArtifactLocation(decodeMultipartDirectory),
  })),
];

// Reads stay inside the token's Project; upstream Run artifacts are read this way.
// The POST entries are searches that only read.
export const JOB_TOKEN_READ_RULES: readonly JobTokenRule[] = [
  { methods: ['GET', 'HEAD'], route: '/api/health', allows: allowWithinProject },
  { methods: ['GET', 'HEAD'], route: NATIVE, allows: allowWithinProject },
  { methods: ['GET', 'HEAD'], route: `${NATIVE}/*`, allows: allowWithinProject },
  { methods: ['GET', 'HEAD'], route: '/api/mlflow/projects/:p/*', allows: allowWithinProject },
  { methods: ['POST'], route: `${NATIVE}/runs/search`, allows: allowWithinProject },
  { methods: ['POST'], route: `${MLFLOW}/runs/search`, allows: allowWithinProject },
  { methods: ['POST'], route: `${MLFLOW}/experiments/search`, allows: allowWithinProject },
  { methods: ['POST'], route: `${MLFLOW}/logged-models/search`, allows: allowWithinProject },
  { methods: ['POST'], route: `${MLFLOW}/registered-models/get-latest-versions`, allows: allowWithinProject },
];

interface CompiledRule {
  rule: JobTokenRule;
  pattern: RegExp;
  names: string[];
}

function compile(rule: JobTokenRule): CompiledRule {
  const names: string[] = [];
  const source = rule.route
    .split('/')
    .map((segment) => {
      if (segment === '*') {
        names.push('*');
        return '(.*)';
      }
      if (segment.startsWith(':')) {
        names.push(segment.slice(1));
        return '([^/]+)';
      }
      return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return { rule, pattern: new RegExp(`^${source}$`), names };
}

const COMPILED_RULES = [...JOB_TOKEN_WRITE_RULES, ...JOB_TOKEN_READ_RULES].map(compile);

function matchingRules(method: string, path: string) {
  const matches: { rule: JobTokenRule; params: Record<string, string> }[] = [];
  for (const { rule, pattern, names } of COMPILED_RULES) {
    if (!rule.methods.includes(method)) continue;
    const match = pattern.exec(path);
    if (!match) continue;
    const params: Record<string, string> = {};
    names.forEach((name, index) => (params[name] = match[index + 1]!));
    matches.push({ rule, params });
  }
  return matches;
}

function forbidden(): never {
  throw new DomainError(403, 'Job tokenではこの操作はできません', 'job_token_forbidden');
}

async function readJsonObject(context: ApiContext): Promise<Record<string, unknown> | null> {
  try {
    // Hono caches the parsed body, so the route handler still reads it afterwards.
    const body: unknown = await context.req.json();
    return body && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function jobTokenGuard(database: Database): MiddlewareHandler<ApiEnvironment> {
  return async (context, next) => {
    const token = context.get('principal')?.token;
    if (!token?.job || !token.projectId) return next();
    const { job, projectId } = token;
    // The raw path is matched so that a percent-encoded segment can only fail to match;
    // only the artifact path itself is decoded, the same way its route decodes it.
    const path = new URL(context.req.url).pathname;
    for (const { rule, params } of matchingRules(context.req.method, path)) {
      if (!sameId(params.p, projectId)) continue;
      const allowed = await rule.allows({
        projectId,
        job,
        params,
        body: () => readJsonObject(context),
        database,
      });
      if (allowed) return next();
    }
    forbidden();
  };
}
