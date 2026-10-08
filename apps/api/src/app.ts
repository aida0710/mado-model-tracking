import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { bodyLimit } from 'hono/body-limit';
import {
  ArtifactRangeError,
  createArtifactStoresFromEnv,
  describeEnvironmentBackends,
  type ArtifactStores,
} from '@mmt/platform';
import type { ApiConfig } from './config.js';
import type { Database } from './db/database.js';
import { DomainError } from './domain/errors.js';
import { authentication } from './http/authMiddleware.js';
import { jobTokenGuard } from './http/jobTokenGuard.js';
import { isAllowedOrigin } from './http/originPolicy.js';
import { principal, type ApiEnvironment } from './http/request.js';
import { formatMlflowError, isMlflowArtifactUpload, isMlflowRequest } from './mlflow/errors.js';
import { mlflowInformationRoutes } from './mlflow/informationRoutes.js';
import { mlflowTrackingRoutes } from './mlflow/tracking/index.js';
import { mlflowModelRoutes } from './mlflow/models/index.js';
import { mlflowArtifactRoutes } from './mlflow/artifacts/index.js';
import { MlflowMultipartUploadService } from './mlflow/artifacts/multipartUploadService.js';
import { AuthService } from './services/authService.js';
import { ArtifactService } from './services/artifactService.js';
import { ArtifactMediaInfoService } from './services/artifactMediaInfoService.js';
import { ArtifactUploadService } from './services/artifactUploadService.js';
import { ArtifactUploadFinalizer } from './services/artifactUploadFinalizer.js';
import { ArtifactUploadSweeper } from './services/artifactUploadSweeper.js';
import { ProjectService } from './services/projectService.js';
import { RegistryService } from './services/registryService.js';
import { RunService } from './services/runService.js';
import { RunSearchService } from './services/runSearchService.js';
import { MetricSeriesService } from './services/metricSeriesService.js';
import { TaskService } from './services/taskService.js';
import { AuditService } from './services/auditService.js';
import {
  RunCompletionService,
  type RunCompletionHandler,
} from './services/runCompletionService.js';
import { OutputRegistrationHandler } from './services/outputRegistrationHandler.js';
import { RunOutputRegistrationService } from './services/runOutputRegistrationService.js';
import { runOutputRegistrationRoutes } from './routes/runOutputRegistrationRoutes.js';
import { RepositoryFilesService } from './services/repositoryFilesService.js';
import { GitRepositoryReader, type RepositoryReader } from './services/repositoryReader.js';
import { ModelAutomationService } from './services/modelAutomationService.js';
import { LineageService } from './services/lineageService.js';
import { TargetService } from './services/targetService.js';
import { JobService } from './services/jobService.js';
import { JobTokenService } from './services/jobTokenService.js';
import { WorkerService } from './services/workerService.js';
import { RunOutputDeclarationService } from './services/runOutputDeclarationService.js';
import { TokenService } from './services/tokenService.js';
import { EvaluationService } from './services/evaluationService.js';
import { ModelEvaluationService } from './services/modelEvaluationService.js';
import { PromotionService } from './services/promotionService.js';
import { PromotionRunHandler } from './services/promotionRunHandler.js';
import { PluginService, type PluginClientFactory } from './services/pluginService.js';
import { OutboxDispatcher } from './services/outboxDispatcher.js';
import { AutomationSourceRunHandler } from './services/automationSourceRunHandler.js';
import { AutomationChainHandler } from './services/automationChainHandler.js';
import { AutomationPendingSweeper } from './services/automationPendingSweeper.js';
import { RunNoteService } from './services/runNoteService.js';
import { RunResumeService } from './services/runResumeService.js';
import { CommentService } from './services/commentService.js';
import { createCommentTargetRegistry } from './services/commentTargets.js';
import { SweepController } from './services/sweepController.js';
import { SweepScheduler } from './services/sweepScheduler.js';
import { SweepService } from './services/sweepService.js';
import { SweepTrialCompletionHandler } from './services/sweepTrialCompletionHandler.js';
import { requireScope } from './services/accessService.js';
import { authRoutes } from './routes/authRoutes.js';
import { currentTokenRoutes } from './routes/currentTokenRoutes.js';
import { auditRoutes } from './routes/auditRoutes.js';
import { projectRoutes } from './routes/projectRoutes.js';
import { registryRoutes } from './routes/registryRoutes.js';
import { modelAutomationRoutes } from './routes/modelAutomationRoutes.js';
import { runRoutes } from './routes/runRoutes.js';
import { runSearchRoutes } from './routes/runSearchRoutes.js';
import { metricSeriesRoutes } from './routes/metricSeriesRoutes.js';
import { taskRoutes } from './routes/taskRoutes.js';
import { repositoryRoutes } from './routes/repositoryRoutes.js';
import { artifactRoutes } from './routes/artifactRoutes.js';
import { artifactMediaInfoRoutes } from './routes/artifactMediaInfoRoutes.js';
import { artifactUploadRoutes, PART_SHA256_HEADER } from './routes/artifactUploadRoutes.js';
import {
  jobRoutes,
  targetRoutes,
  workerPresenceRoutes,
  workerRoutes,
} from './routes/executionRoutes.js';
import { tokenRoutes } from './routes/tokenRoutes.js';
import { pluginRoutes } from './routes/pluginRoutes.js';
import { evaluationRoutes } from './routes/evaluationRoutes.js';
import { modelEvaluationRoutes } from './routes/modelEvaluationRoutes.js';
import { promotionRoutes } from './routes/promotionRoutes.js';
import { runNoteRoutes } from './routes/runNoteRoutes.js';
import { runResumeRoutes } from './routes/runResumeRoutes.js';
import { commentRoutes } from './routes/commentRoutes.js';
import { userRoutes } from './routes/userRoutes.js';
import { ProjectGroupBindingService } from './services/projectGroupBindingService.js';
import { UserDirectoryService } from './services/userDirectoryService.js';
import { ArtifactStoreRegistry } from './services/artifactStoreRegistry.js';
import { StorageBackendService } from './services/storageBackendService.js';
import { storageBackendRoutes } from './routes/storageBackendRoutes.js';
import { sweepRoutes } from './routes/sweepRoutes.js';

export interface ApplicationOptions {
  config: ApiConfig;
  database: Database;
  /** Environment backends; DB-configured backends are added by ArtifactStoreRegistry. */
  stores?: ArtifactStores;
  environment?: NodeJS.ProcessEnv;
  pluginClientFactory?: PluginClientFactory;
  repositoryReader?: RepositoryReader;
}

// Registry JSON and code uploads are bounded separately from streamed artifact bodies.
const MAX_JSON_BODY_BYTES = 4 * 1024 * 1024;
// Upload session parts are raw bytes up to the part size, not JSON.
const ARTIFACT_UPLOAD_PART_PATH = /\/artifact-uploads\/[^/]+\/parts\/[^/]+$/;

export function createApplication(options: ApplicationOptions) {
  const { config, database } = options;
  const stores = new ArtifactStoreRegistry({
    database,
    environmentStores: options.stores ?? createArtifactStoresFromEnv(options.environment),
    secretKey: config.storageSecretKey,
  });
  // Load DB backends now so the first request does not wait; failures are retried on use.
  void stores.ensureLoaded();
  const storageBackends = new StorageBackendService({
    database,
    registry: stores,
    secretKey: config.storageSecretKey,
    environmentBackends: describeEnvironmentBackends(options.environment ?? process.env),
  });
  const auth = new AuthService(database, config);
  const audit = new AuditService(database);
  // A disabled backend keeps serving its Artifacts but cannot be chosen for a Project.
  const projects = new ProjectService(database, () => stores.writableBackends());
  // Handlers run in this order inside the terminal-transition transaction. Output registration
  // must precede pending automation so versions it creates start in the same completion.
  // Plugin outbox events are not handlers: RunCompletionService enqueues them on every status change.
  // Handlers depend on services built from runCompletion, so they are appended to this array
  // (which RunCompletionService keeps by reference) once those services exist.
  const terminalHandlers: RunCompletionHandler[] = [];
  const runCompletion = new RunCompletionService(terminalHandlers);
  const runs = new RunService(database, runCompletion);
  const runSearch = new RunSearchService(database);
  const metricSeries = new MetricSeriesService(database, runSearch);
  const lineage = new LineageService(database);
  const artifacts = new ArtifactService(database, stores, {
    maxBytes: config.artifactMaxBytes,
  });
  const artifactUploads = new ArtifactUploadService(database, stores, {
    maxBytes: config.artifactMaxBytes,
  });
  const mlflowMultipartUploads = new MlflowMultipartUploadService({
    database,
    stores,
    uploads: artifactUploads,
    finalizeWaitMs: config.uploadFinalizeWaitMs,
  });
  // Mapping stays on when MLflow multipart is turned off so sessions already open still complete.
  const artifactUploadFinalizer = new ArtifactUploadFinalizer({
    database,
    stores,
    onRegistered: mlflowMultipartUploads.mapRegisteredArtifact,
  });
  const artifactMediaInfo = new ArtifactMediaInfoService(database);
  const artifactUploadSweeper = new ArtifactUploadSweeper({ database, stores });
  const targets = new TargetService(database, config);
  const jobTokens = new JobTokenService(database);
  const jobs = new JobService({ database, runs, config, runCompletion, jobTokens });
  const tasks = new TaskService(database, runs, jobs);
  const gitRepositories = new GitRepositoryReader({ ssh: config.repositorySsh });
  const repositories = new RepositoryFilesService(
    database,
    options.repositoryReader ?? ((request) => gitRepositories.read(request)),
  );
  const automation = new ModelAutomationService(database, runs, jobs);
  const automationSweeper = new AutomationPendingSweeper(database, automation);
  const registry = new RegistryService(database, automation);
  // Output registration must run before the source-run handler releases pending automation.
  terminalHandlers.push(new OutputRegistrationHandler(registry));
  terminalHandlers.push(new AutomationSourceRunHandler(automation));
  terminalHandlers.push(new AutomationChainHandler(automation));
  // Promotion follows automation chaining (wave-wide order: outputs, pending, chain, promotion).
  const promotion = new PromotionService(database);
  terminalHandlers.push(new PromotionRunHandler(promotion));
  // Sweep trials follow chaining, promotion and automatic retry, and precede notifications.
  const sweepController = new SweepController(tasks, jobs);
  terminalHandlers.push(new SweepTrialCompletionHandler(sweepController));
  const sweeps = new SweepService(database, jobs, sweepController);
  const sweepScheduler = new SweepScheduler(database, sweepController);
  const outputDeclarations = new RunOutputDeclarationService(registry);
  const worker = new WorkerService({ database, jobs, config, runCompletion, outputDeclarations });
  const tokens = new TokenService(database);
  const evaluation = new EvaluationService(database);
  const plugins = new PluginService({
    database,
    registry,
    environment: options.environment,
    clientFactory: options.pluginClientFactory,
  });
  const outbox = new OutboxDispatcher(database, plugins);
  const runNotes = new RunNoteService(database);
  const runResumes = new RunResumeService(database, runCompletion);
  // Later services such as reports call commentTargets.registerCommentTarget for their own kind.
  const commentTargets = createCommentTargetRegistry();
  const comments = new CommentService(database, commentTargets);
  const app = new Hono<ApiEnvironment>();
  app.onError((error, context) => {
    if (isMlflowRequest(context.req.path)) {
      const response = formatMlflowError(error);
      if (error instanceof ArtifactRangeError)
        context.header('Content-Range', `bytes */${error.totalSize}`);
      if (response.status >= 500 && !(error instanceof DomainError))
        console.error(JSON.stringify({ event: 'mlflow_request_failed', name: error.name }));
      return context.json(response.body, response.status);
    }
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
  app.notFound((context) =>
    isMlflowRequest(context.req.path)
      ? context.json(
          { error_code: 'ENDPOINT_NOT_FOUND', message: 'このMLflow APIは対応していません' },
          404,
        )
      : context.json({ error: 'APIが見つかりません', code: 'not_found' }, 404),
  );
  app.use(
    '/api/*',
    cors({
      origin: (origin) => (isAllowedOrigin(origin, config) ? origin : undefined),
      credentials: true,
      allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Content-Type', 'Authorization', 'Range', PART_SHA256_HEADER],
      exposeHeaders: ['Content-Range', 'Accept-Ranges', 'Content-Disposition'],
    }),
  );
  app.use('/api/*', async (context, next) => {
    context.header('X-Content-Type-Options', 'nosniff');
    context.header('Cache-Control', 'no-store');
    // Artifact routes accept arbitrary binary MIME types including application/json.
    const isNativeArtifactUpload =
      context.req.method === 'PUT' &&
      (context.req.path.endsWith('/artifacts') || ARTIFACT_UPLOAD_PART_PATH.test(context.req.path));
    if (!isNativeArtifactUpload && !isMlflowArtifactUpload(context.req)) {
      return bodyLimit({
        maxSize: MAX_JSON_BODY_BYTES,
        onError: () => {
          throw new DomainError(413, 'JSONの上限サイズを超えています', 'body_too_large');
        },
      })(context, next);
    }
    await next();
  });
  app.use('/api/*', authentication(auth, jobTokens));
  app.use('/api/*', jobTokenGuard(database));
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
  app.route('/api/auth/token', currentTokenRoutes());
  app.route('/api', auditRoutes(audit));
  app.route('/api/projects', projectRoutes(projects, new ProjectGroupBindingService(database)));
  app.route('/api', userRoutes(new UserDirectoryService(database)));
  app.route('/api/projects', registryRoutes(registry));
  app.route('/api/projects', modelAutomationRoutes(automation));
  app.route('/api/projects', runRoutes(runs, lineage));
  app.route('/api/projects', runSearchRoutes(runSearch));
  app.route('/api/projects', metricSeriesRoutes(metricSeries));
  app.route('/api/projects', taskRoutes(tasks));
  app.route(
    '/api/projects',
    runOutputRegistrationRoutes(new RunOutputRegistrationService(database)),
  );
  app.route('/api/projects', repositoryRoutes(repositories));
  app.route('/api/projects', artifactRoutes(artifacts));
  app.route('/api/projects', artifactUploadRoutes(artifactUploads));
  app.route('/api/projects', artifactMediaInfoRoutes(artifactMediaInfo));
  app.route('/api/projects', jobRoutes(jobs));
  app.route('/api/projects', pluginRoutes(plugins));
  app.route('/api/projects', evaluationRoutes(evaluation));
  app.route('/api/projects', modelEvaluationRoutes(new ModelEvaluationService(database)));
  app.route('/api/projects', promotionRoutes(promotion));
  app.route('/api/projects', runNoteRoutes(runNotes));
  app.route('/api/projects', runResumeRoutes(runResumes));
  app.route('/api/projects', commentRoutes(comments));
  app.route('/api/projects', sweepRoutes(sweeps));
  app.route('/api/targets', targetRoutes(targets));
  app.route('/api/worker', workerRoutes(worker));
  app.route('/api', workerPresenceRoutes(worker));
  app.route('/api/tokens', tokenRoutes(tokens));
  app.route('/api/mlflow/projects/:p', mlflowInformationRoutes(database, config.mlflowMultipart));
  app.route('/api/mlflow/projects/:p', mlflowTrackingRoutes({ database, runs, registry, runCompletion }));
  app.route('/api/mlflow/projects/:p', mlflowModelRoutes({ database, registry }));
  app.route(
    '/api/mlflow/projects/:p',
    mlflowArtifactRoutes({
      database,
      artifacts,
      multipart: config.mlflowMultipart.uploadsEnabled ? mlflowMultipartUploads : undefined,
    }),
  );
  app.route('/api/admin', storageBackendRoutes(storageBackends));
  app.get('/api/storage/backends', async (context) => {
    requireScope(principal(context), 'read');
    await stores.ensureLoaded();
    return context.json({
      items: stores.writableBackends(),
      defaultBackend: await stores.getDefaultBackend(),
    });
  });
  return {
    app,
    outbox,
    automationSweeper,
    artifactUploadFinalizer,
    artifactUploadSweeper,
    sweepScheduler,
    services: {
      auth,
      audit,
      projects,
      registry,
      automation,
      runCompletion,
      runs,
      runSearch,
      metricSeries,
      tasks,
      repositories,
      lineage,
      artifacts,
      artifactUploads,
      artifactMediaInfo,
      targets,
      jobs,
      worker,
      tokens,
      jobTokens,
      plugins,
      evaluation,
      promotion,
      runNotes,
      runResumes,
      commentTargets,
      comments,
      storageBackends,
      artifactStores: stores,
      sweeps,
      sweepController,
    },
  };
}

export function createApp(options: ApplicationOptions): Hono<ApiEnvironment> {
  return createApplication(options).app;
}
