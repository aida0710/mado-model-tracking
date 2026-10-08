import { Hono } from 'hono';
import { z } from 'zod';
import type { Database } from '../../db/database.js';
import type { RegistryService } from '../../services/registryService.js';
import type { RunCompletionService } from '../../services/runCompletionService.js';
import type { RunService } from '../../services/runService.js';
import { jsonBody, parse, principal, uuidParam, type ApiEnvironment } from '../../http/request.js';
import { uuidSchema } from '../../domain/validation.js';
import { ExperimentService } from './experimentService.js';
import { RunTrackingService } from './runTrackingService.js';
import { serializeExperiment } from './trackingSerialization.js';
import {
  createExperimentSchema,
  createRunSchema,
  experimentReferenceSchema,
  experimentTagSchema,
  integerSchema,
  MAX_METRIC_HISTORY_RESULTS,
  logBatchSchema,
  logInputsSchema,
  logOutputsSchema,
  metricSchema,
  paramSchema,
  runId,
  runReferenceSchema,
  searchExperimentsSchema,
  searchRunsSchema,
  tagSchema,
  trackingKeySchema,
  updateRunSchema,
  withRunReference,
} from './trackingValidation.js';

const PREFIX = '/api/2.0/mlflow';
const runTagSchema = withRunReference(tagSchema);
const runMetricSchema = withRunReference(metricSchema.omit({ run_id: true }));
const runParamSchema = withRunReference(paramSchema);

export function mlflowTrackingRoutes(options: {
  database: Database;
  runs: RunService;
  registry: RegistryService;
  runCompletion: RunCompletionService;
}): Hono<ApiEnvironment> {
  const routes = new Hono<ApiEnvironment>();
  const experiments = new ExperimentService(options.database);
  const runs = new RunTrackingService(options);

  routes.post(`${PREFIX}/experiments/create`, async (context) => {
    const experiment = await experiments.create(
      principal(context),
      uuidParam(context, 'p'),
      await jsonBody(context, createExperimentSchema),
    );
    return context.json({ experiment_id: experiment.id });
  });
  routes.get(`${PREFIX}/experiments/get`, async (context) => {
    const input = parse(experimentReferenceSchema, context.req.query());
    return context.json({
      experiment: serializeExperiment(
        await experiments.get(principal(context), uuidParam(context, 'p'), input.experiment_id),
      ),
    });
  });
  routes.get(`${PREFIX}/experiments/get-by-name`, async (context) => {
    const input = parse(z.strictObject({ experiment_name: z.string() }), context.req.query());
    return context.json({
      experiment: serializeExperiment(
        await experiments.getByName(
          principal(context),
          uuidParam(context, 'p'),
          input.experiment_name,
        ),
      ),
    });
  });
  routes.post(`${PREFIX}/experiments/search`, async (context) => {
    const page = await experiments.search(
      principal(context),
      uuidParam(context, 'p'),
      await jsonBody(context, searchExperimentsSchema),
    );
    return context.json({
      experiments: page.items.map(serializeExperiment),
      ...(page.next_page_token ? { next_page_token: page.next_page_token } : {}),
    });
  });
  routes.post(`${PREFIX}/experiments/update`, async (context) => {
    const input = await jsonBody(
      context,
      experimentReferenceSchema.extend({ new_name: createExperimentSchema.shape.name }),
    );
    await experiments.rename(principal(context), uuidParam(context, 'p'), input);
    return context.json({});
  });
  for (const [action, lifecycleStage] of [
    ['delete', 'deleted'],
    ['restore', 'active'],
  ] as const) {
    routes.post(`${PREFIX}/experiments/${action}`, async (context) => {
      const input = await jsonBody(context, experimentReferenceSchema);
      await experiments.setLifecycle(principal(context), uuidParam(context, 'p'), {
        ...input,
        lifecycleStage,
      });
      return context.json({});
    });
    routes.post(`${PREFIX}/runs/${action}`, async (context) => {
      const input = await jsonBody(context, z.strictObject({ run_id: uuidSchema }));
      await runs.setLifecycle(principal(context), uuidParam(context, 'p'), {
        runId: input.run_id,
        lifecycleStage,
      });
      return context.json({});
    });
  }
  routes.post(`${PREFIX}/experiments/set-experiment-tag`, async (context) => {
    const input = await jsonBody(
      context,
      experimentReferenceSchema.extend(experimentTagSchema.shape),
    );
    await experiments.setTag(principal(context), uuidParam(context, 'p'), input);
    return context.json({});
  });
  routes.post(`${PREFIX}/experiments/delete-experiment-tag`, async (context) => {
    const input = await jsonBody(
      context,
      experimentReferenceSchema.extend({ key: trackingKeySchema }),
    );
    await experiments.setTag(principal(context), uuidParam(context, 'p'), input);
    return context.json({});
  });

  routes.post(`${PREFIX}/runs/create`, async (context) =>
    context.json({
      run: await runs.create(
        principal(context),
        uuidParam(context, 'p'),
        await jsonBody(context, createRunSchema),
      ),
    }),
  );
  routes.get(`${PREFIX}/runs/get`, async (context) => {
    const input = parse(runReferenceSchema, context.req.query());
    return context.json({
      run: await runs.get(principal(context), uuidParam(context, 'p'), runId(input)),
    });
  });
  routes.post(`${PREFIX}/runs/search`, async (context) =>
    context.json(
      await runs.search(
        principal(context),
        uuidParam(context, 'p'),
        await jsonBody(context, searchRunsSchema),
      ),
    ),
  );
  routes.post(`${PREFIX}/runs/update`, async (context) => {
    const input = await jsonBody(context, updateRunSchema);
    return context.json({
      run_info: await runs.update(principal(context), uuidParam(context, 'p'), {
        ...input,
        runId: runId(input),
      }),
    });
  });
  routes.post(`${PREFIX}/runs/log-parameter`, async (context) => {
    const input = await jsonBody(context, runParamSchema);
    await runs.batch(principal(context), uuidParam(context, 'p'), {
      runId: runId(input),
      params: [{ key: input.key, value: input.value }],
      metrics: [],
      tags: [],
    });
    return context.json({});
  });
  routes.post(`${PREFIX}/runs/log-metric`, async (context) => {
    const input = await jsonBody(context, runMetricSchema);
    const { run_id: _runId, run_uuid: _runUuid, ...metric } = input;
    await runs.batch(principal(context), uuidParam(context, 'p'), {
      runId: runId(input),
      params: [],
      metrics: [metric],
      tags: [],
    });
    return context.json({});
  });
  routes.post(`${PREFIX}/runs/log-batch`, async (context) => {
    const input = await jsonBody(context, logBatchSchema);
    await runs.batch(principal(context), uuidParam(context, 'p'), {
      ...input,
      runId: input.run_id,
    });
    return context.json({});
  });
  routes.post(`${PREFIX}/runs/set-tag`, async (context) => {
    const input = await jsonBody(context, runTagSchema);
    await runs.batch(principal(context), uuidParam(context, 'p'), {
      runId: runId(input),
      params: [],
      metrics: [],
      tags: [{ key: input.key, value: input.value }],
    });
    return context.json({});
  });
  routes.post(`${PREFIX}/runs/delete-tag`, async (context) => {
    const input = await jsonBody(
      context,
      z.strictObject({ run_id: uuidSchema, key: trackingKeySchema }),
    );
    await runs.deleteTag(principal(context), uuidParam(context, 'p'), {
      runId: input.run_id,
      key: input.key,
    });
    return context.json({});
  });
  routes.get(`${PREFIX}/metrics/get-history`, async (context) => {
    const input = parse(
      withRunReference(
        z.strictObject({
          metric_key: trackingKeySchema,
          max_results: integerSchema
            .pipe(z.number().positive().max(MAX_METRIC_HISTORY_RESULTS))
            .optional(),
          page_token: z.string().optional(),
        }),
      ),
      context.req.query(),
    );
    return context.json(
      await runs.history(principal(context), uuidParam(context, 'p'), {
        runId: runId(input),
        metricKey: input.metric_key,
        maxResults: input.max_results,
        pageToken: input.page_token,
      }),
    );
  });
  routes.post(`${PREFIX}/runs/log-inputs`, async (context) => {
    const input = await jsonBody(context, logInputsSchema);
    await runs.inputs(principal(context), uuidParam(context, 'p'), {
      ...input,
      runId: input.run_id,
    });
    return context.json({});
  });
  routes.post(`${PREFIX}/runs/outputs`, async (context) => {
    const input = await jsonBody(context, logOutputsSchema);
    await runs.outputs(principal(context), uuidParam(context, 'p'), {
      ...input,
      runId: input.run_id,
    });
    return context.json({});
  });
  routes.post(`${PREFIX}/runs/log-model`, async (context) => {
    const input = await jsonBody(
      context,
      z.strictObject({ run_id: uuidSchema, model_json: z.string() }),
    );
    await runs.logModel(principal(context), uuidParam(context, 'p'), {
      runId: input.run_id,
      modelJson: input.model_json,
    });
    return context.json({});
  });
  return routes;
}
