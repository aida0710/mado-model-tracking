import { Hono } from 'hono';
import {
  parameterImportanceRequestSchema,
  runAnalysisTableRequestSchema,
} from '../domain/runAnalysisValidation.js';
import { jsonBody, principal, uuidParam, type ApiEnvironment } from '../http/request.js';
import type { RunAnalysisService } from '../services/runAnalysisService.js';

export function runAnalysisRoutes(runAnalysis: RunAnalysisService): Hono<ApiEnvironment> {
  const routes = new Hono<ApiEnvironment>();
  routes.post('/:p/runs/analysis/table', async (context) =>
    context.json(
      await runAnalysis.readTable(
        principal(context),
        uuidParam(context, 'p'),
        await jsonBody(context, runAnalysisTableRequestSchema),
      ),
    ),
  );
  routes.post('/:p/runs/analysis/parameter-importance', async (context) =>
    context.json(
      await runAnalysis.computeParameterImportance(
        principal(context),
        uuidParam(context, 'p'),
        await jsonBody(context, parameterImportanceRequestSchema),
      ),
    ),
  );
  return routes;
}
