import { Hono } from 'hono';
import { z } from 'zod';
import type { EvaluationService } from '../services/evaluationService.js';
import { nameSchema, uuidSchema } from '../domain/validation.js';
import { parse, principal, uuidParam, type ApiContext, type ApiEnvironment } from '../http/request.js';

// Bounds the metric filter so one request cannot ask for an unbounded key list.
const MAX_COMPARED_METRICS = 200;
const MAX_REFERENCE_DATASET_VERSIONS = 1000;

// List parameters accept both repetition (?a=x&a=y) and commas (?a=x,y). A present but empty
// parameter is an explicit empty list, which differs from omitting it (take it from the Run).
function listQuery(context: ApiContext, name: string): string[] | undefined {
  const values = context.req.queries(name);
  if (!values) return undefined;
  return values.flatMap((value) => value.split(',')).filter((value) => value !== '');
}

function optionalQuery(context: ApiContext, name: string): string | undefined {
  return context.req.query(name) || undefined;
}

export function evaluationRoutes(evaluation: EvaluationService): Hono<ApiEnvironment> {
  const routes = new Hono<ApiEnvironment>();
  routes.get('/:p/models/:id/versions/:v/evaluation-comparison', async (context) =>
    context.json(
      await evaluation.compareToBaseline(principal(context), uuidParam(context, 'p'), {
        modelId: uuidParam(context, 'id'),
        candidateVersionId: uuidParam(context, 'v'),
        baselineAlias: parse(nameSchema.optional(), optionalQuery(context, 'baselineAlias')),
        baselineVersionId: parse(uuidSchema.optional(), optionalQuery(context, 'baselineVersionId')),
        referenceDatasetVersionIds: parse(
          z.array(uuidSchema).max(MAX_REFERENCE_DATASET_VERSIONS).optional(),
          listQuery(context, 'referenceDatasetVersionIds'),
        ),
        codeVersionId: parse(uuidSchema.optional(), optionalQuery(context, 'codeVersionId')),
        evaluationRuleId: parse(uuidSchema.optional(), optionalQuery(context, 'evaluationRuleId')),
        metrics: parse(
          z.array(nameSchema).max(MAX_COMPARED_METRICS).optional(),
          listQuery(context, 'metrics'),
        ),
      }),
    ),
  );
  return routes;
}
