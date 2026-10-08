import { Hono } from 'hono';
import {
  modelVersionEvaluationQuerySchema,
  runDownstreamQuerySchema,
} from '../domain/modelEvaluationValidation.js';
import { parse, principal, uuidParam, type ApiEnvironment } from '../http/request.js';
import type { ModelEvaluationService } from '../services/modelEvaluationService.js';

export function modelEvaluationRoutes(evaluations: ModelEvaluationService): Hono<ApiEnvironment> {
  const routes = new Hono<ApiEnvironment>();
  routes.get('/:p/model-versions/:id', async (context) =>
    context.json(
      await evaluations.versionDetail(principal(context), {
        projectId: uuidParam(context, 'p'),
        versionId: uuidParam(context, 'id'),
      }),
    ),
  );
  routes.get('/:p/model-versions/:id/evaluations', async (context) =>
    context.json(
      await evaluations.versionEvaluations(
        principal(context),
        { projectId: uuidParam(context, 'p'), versionId: uuidParam(context, 'id') },
        parse(modelVersionEvaluationQuerySchema, context.req.query()),
      ),
    ),
  );
  // Kept here rather than in runRoutes: the downstream list belongs to the version page's reads.
  routes.get('/:p/runs/:r/downstream', async (context) =>
    context.json(
      await evaluations.downstream(
        principal(context),
        { projectId: uuidParam(context, 'p'), runId: uuidParam(context, 'r') },
        parse(runDownstreamQuerySchema, context.req.query()),
      ),
    ),
  );
  return routes;
}
