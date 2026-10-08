import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { bodyLimit } from 'hono/body-limit';
import {
  ArtifactRangeError,
  createArtifactStoresFromEnv,
  type ArtifactStores,
} from '@mmt/platform';
import type { ApiConfig } from './config.js';
import type { Database } from './db/database.js';
import { DomainError } from './domain/errors.js';
import { authentication } from './http/authMiddleware.js';
import { isAllowedOrigin } from './http/originPolicy.js';
import { principal, type ApiEnvironment } from './http/request.js';
import { AuthService } from './services/authService.js';
import { ArtifactService } from './services/artifactService.js';
import { ProjectService } from './services/projectService.js';
import { RegistryService } from './services/registryService.js';
import { RunService } from './services/runService.js';
import { ModelAutomationService } from './services/modelAutomationService.js';
import { LineageService } from './services/lineageService.js';
import { TargetService } from './services/targetService.js';
import { JobService } from './services/jobService.js';
import { WorkerService } from './services/workerService.js';
import { TokenService } from './services/tokenService.js';
import { PluginService, type PluginClientFactory } from './services/pluginService.js';
import { OutboxDispatcher } from './services/outboxDispatcher.js';
import { requireScope } from './services/accessService.js';
import { authRoutes } from './routes/authRoutes.js';
import { projectRoutes } from './routes/projectRoutes.js';
import { registryRoutes } from './routes/registryRoutes.js';
import { modelAutomationRoutes } from './routes/modelAutomationRoutes.js';
import { runRoutes } from './routes/runRoutes.js';
import { artifactRoutes } from './routes/artifactRoutes.js';
import { jobRoutes, targetRoutes, workerRoutes } from './routes/executionRoutes.js';
import { tokenRoutes } from './routes/tokenRoutes.js';
import { pluginRoutes } from './routes/pluginRoutes.js';

export interface ApplicationOptions {
  config: ApiConfig;
  database: Database;
  stores?: ArtifactStores;
  environment?: NodeJS.ProcessEnv;
  pluginClientFactory?: PluginClientFactory;
}

// Registry JSON and code uploads are bounded separately from streamed artifact bodies.
const MAX_JSON_BODY_BYTES = 4 * 1024 * 1024;

export function createApplication(options: ApplicationOptions) {
  const { config, database } = options;
  const stores = options.stores ?? createArtifactStoresFromEnv(options.environment);
  const auth = new AuthService(database, config);
  const projects = new ProjectService(database, () => stores.backends());
  const runs = new RunService(database);
  const lineage = new LineageService(database);
  const artifacts = new ArtifactService(database, stores);
  const targets = new TargetService(database, config);
  const jobs = new JobService(database, runs, config);
  const automation = new ModelAutomationService(database, runs, jobs);
  const registry = new RegistryService(database, automation);
  const worker = new WorkerService(database, jobs, config);
  const tokens = new TokenService(database);
  const plugins = new PluginService({
    database,
    registry,
    environment: options.environment,
    clientFactory: options.pluginClientFactory,
  });
  const outbox = new OutboxDispatcher(database, plugins);
  const app = new Hono<ApiEnvironment>();
  app.onError((error, context) => {
    if (error instanceof DomainError)
      return context.json({ error: error.message, code: error.code }, error.status);
    if (error instanceof ArtifactRangeError) {
      context.header('Content-Range', `bytes */${error.totalSize}`);
      return context.json({ error: '要求されたRangeは読み込めません', code: 'invalid_range' }, 416);
    }
    const databaseCode = (error as { code?: string }).code;
    if (databaseCode === '23505')
      return context.json(
        { error: '同じ名前または版が既に登録されています', code: 'already_exists' },
        409,
      );
    if (databaseCode === '23503' || databaseCode === '23514')
      return context.json(
        { error: '参照または不変な版の制約に違反しています', code: 'invalid_reference' },
        422,
      );
    // SQL and provider exception details can include sensitive values.
    console.error(
      JSON.stringify({
        event: 'api_request_failed',
        name: error.name,
        code: databaseCode ?? 'internal_error',
      }),
    );
    return context.json({ error: 'リクエストの処理に失敗しました', code: 'internal_error' }, 503);
  });
  app.notFound((context) => context.json({ error: 'APIが見つかりません', code: 'not_found' }, 404));
  app.use(
    '/api/*',
    cors({
      origin: (origin) => (isAllowedOrigin(origin, config) ? origin : undefined),
      credentials: true,
      allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Content-Type', 'Authorization', 'Range'],
      exposeHeaders: ['Content-Range', 'Accept-Ranges', 'Content-Disposition'],
    }),
  );
  app.use('/api/*', async (context, next) => {
    context.header('X-Content-Type-Options', 'nosniff');
    context.header('Cache-Control', 'no-store');
    // Artifact routes accept arbitrary binary MIME types including application/json.
    if (!(context.req.method === 'PUT' && context.req.path.endsWith('/artifacts'))) {
      return bodyLimit({
        maxSize: MAX_JSON_BODY_BYTES,
        onError: () => {
          throw new DomainError(413, 'JSONの上限サイズを超えています', 'body_too_large');
        },
      })(context, next);
    }
    await next();
  });
  app.use('/api/*', authentication(auth));
  const health = async () => {
    try {
      await database.query('SELECT 1');
      return { status: 'ok' as const };
    } catch {
      throw new DomainError(503, 'Databaseに接続できません', 'database_unavailable');
    }
  };
  app.get('/health', async (context) => context.json(await health()));
  app.get('/api/health', async (context) => context.json(await health()));
  app.route('/api/auth', authRoutes(auth));
  app.route('/api/projects', projectRoutes(projects));
  app.route('/api/projects', registryRoutes(registry));
  app.route('/api/projects', modelAutomationRoutes(automation));
  app.route('/api/projects', runRoutes(runs, lineage));
  app.route('/api/projects', artifactRoutes(artifacts));
  app.route('/api/projects', jobRoutes(jobs));
  app.route('/api/projects', pluginRoutes(plugins));
  app.route('/api/targets', targetRoutes(targets));
  app.route('/api/worker', workerRoutes(worker));
  app.route('/api/tokens', tokenRoutes(tokens));
  app.get('/api/storage/backends', (context) => {
    requireScope(principal(context), 'read');
    return context.json({ items: stores.backends() });
  });
  return {
    app,
    outbox,
    services: {
      auth,
      projects,
      registry,
      automation,
      runs,
      lineage,
      artifacts,
      targets,
      jobs,
      worker,
      tokens,
      plugins,
    },
  };
}

export function createApp(options: ApplicationOptions): Hono<ApiEnvironment> {
  return createApplication(options).app;
}
