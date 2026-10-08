import { Hono } from 'hono';
import {
  metricGroupsRequestSchema,
  metricSeriesRequestSchema,
} from '../domain/metricSeries/metricSeriesValidation.js';
import { jsonBody, principal, uuidParam, type ApiEnvironment } from '../http/request.js';
import type { MetricSeriesService } from '../services/metricSeriesService.js';

export function metricSeriesRoutes(metricSeries: MetricSeriesService): Hono<ApiEnvironment> {
  const routes = new Hono<ApiEnvironment>();
  routes.post('/:p/metrics/series', async (context) =>
    context.json(
      await metricSeries.readSeries(
        principal(context),
        uuidParam(context, 'p'),
        await jsonBody(context, metricSeriesRequestSchema),
      ),
    ),
  );
  routes.post('/:p/metrics/groups', async (context) =>
    context.json(
      await metricSeries.readGroups(
        principal(context),
        uuidParam(context, 'p'),
        await jsonBody(context, metricGroupsRequestSchema),
      ),
    ),
  );
  return routes;
}
