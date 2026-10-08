import { Hono } from 'hono';
import { z } from 'zod';
import type { RunSearchService } from '../services/runSearchService.js';
import { runKindSchema, runStatusSchema, uuidSchema } from '../domain/validation.js';
import { jsonBody, principal, uuidParam, type ApiEnvironment } from '../http/request.js';

// Limits published in docs/api-contract.md. 500 summaries stay well below the polling budget.
const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 500;
const MAX_FILTER_LENGTH = 2000;
const MAX_ORDER_BY = 5;
const MAX_ORDER_BY_LENGTH = 500;
// Bounds each bound array; the UI sends a handful of IDs and SDK callers can page instead.
const MAX_ID_CONDITIONS = 100;
// Equal to the existing GET /runs name query.
const MAX_NAME_LENGTH = 200;
// A cursor carries a UUID or an offset with a SHA-256 fingerprint, far below this.
const MAX_CURSOR_LENGTH = 1000;

const uuidListSchema = z.array(uuidSchema).max(MAX_ID_CONDITIONS).default([]);
export const runSearchSchema = z.strictObject({
  experimentIds: uuidListSchema,
  filter: z.string().max(MAX_FILTER_LENGTH).default(''),
  orderBy: z.array(z.string().max(MAX_ORDER_BY_LENGTH)).max(MAX_ORDER_BY).default([]),
  kinds: z.array(runKindSchema).max(MAX_ID_CONDITIONS).default([]),
  statuses: z.array(runStatusSchema).max(MAX_ID_CONDITIONS).default([]),
  modelVersionIds: uuidListSchema,
  inputDatasetVersionIds: uuidListSchema,
  parentRunId: uuidSchema.nullable().default(null),
  name: z
    .string()
    .max(MAX_NAME_LENGTH)
    .transform((name) => name.trim() || null)
    .nullable()
    .default(null),
  limit: z.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  cursor: z.string().min(1).max(MAX_CURSOR_LENGTH).nullable().default(null),
});

export function runSearchRoutes(runSearch: RunSearchService): Hono<ApiEnvironment> {
  const routes = new Hono<ApiEnvironment>();
  routes.post('/:p/runs/search', async (context) =>
    context.json(
      await runSearch.search(
        principal(context),
        uuidParam(context, 'p'),
        await jsonBody(context, runSearchSchema),
      ),
    ),
  );
  return routes;
}
