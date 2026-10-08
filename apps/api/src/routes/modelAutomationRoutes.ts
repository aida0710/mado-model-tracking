import { Hono } from 'hono';
import {
  automationExecutionCreateSchema,
  automationExecutionQuerySchema,
  modelAutomationRuleSchema,
  modelAutomationToggleSchema,
} from '../domain/modelAutomationValidation.js';
import { jsonBody, parse, principal, uuidParam, type ApiEnvironment } from '../http/request.js';
import { requestMetadata } from '../http/requestMetadata.js';
import type { ModelAutomationService } from '../services/modelAutomationService.js';

export function modelAutomationRoutes(automation: ModelAutomationService): Hono<ApiEnvironment> {
  const routes = new Hono<ApiEnvironment>();
  routes.get('/:p/automation-rules', async (context) =>
    context.json({
      items: await automation.rules(principal(context), uuidParam(context, 'p')),
    }),
  );
  routes.post('/:p/automation-rules', async (context) =>
    context.json(
      await automation.createRule(
        principal(context),
        uuidParam(context, 'p'),
        await jsonBody(context, modelAutomationRuleSchema),
      ),
      201,
    ),
  );
  routes.patch('/:p/automation-rules/:id', async (context) =>
    context.json(
      await automation.toggleRule(principal(context), uuidParam(context, 'p'), {
        ruleId: uuidParam(context, 'id'),
        ...(await jsonBody(context, modelAutomationToggleSchema)),
      }),
    ),
  );
  routes.post('/:p/automation-rules/:id/executions', async (context) =>
    context.json(
      await automation.applyRule(principal(context), uuidParam(context, 'p'), {
        ruleId: uuidParam(context, 'id'),
        input: await jsonBody(context, automationExecutionCreateSchema),
        metadata: requestMetadata(context),
      }),
      201,
    ),
  );
  routes.get('/:p/automation-executions', async (context) =>
    context.json(
      await automation.executions(
        principal(context),
        uuidParam(context, 'p'),
        parse(automationExecutionQuerySchema, context.req.query()),
      ),
    ),
  );
  return routes;
}
