import { Hono } from 'hono';
import {
  promotionEvaluationQuerySchema,
  promotionPolicyCreateSchema,
  promotionPolicyOwnerSchema,
  promotionPolicyPatchSchema,
  promotionPolicyQuerySchema,
} from '../domain/promotionPolicyValidation.js';
import { jsonBody, parse, principal, uuidParam, type ApiEnvironment } from '../http/request.js';
import { requestMetadata } from '../http/requestMetadata.js';
import type { PromotionService } from '../services/promotionService.js';

export function promotionRoutes(promotion: PromotionService): Hono<ApiEnvironment> {
  const routes = new Hono<ApiEnvironment>();
  routes.get('/:p/promotion-policies', async (context) =>
    context.json({
      items: await promotion.policies(
        principal(context),
        uuidParam(context, 'p'),
        parse(promotionPolicyQuerySchema, context.req.query()),
      ),
    }),
  );
  routes.post('/:p/promotion-policies', async (context) =>
    context.json(
      await promotion.createPolicy(
        principal(context),
        uuidParam(context, 'p'),
        await jsonBody(context, promotionPolicyCreateSchema),
        requestMetadata(context),
      ),
      201,
    ),
  );
  routes.patch('/:p/promotion-policies/:id', async (context) => {
    const { enabled } = await jsonBody(context, promotionPolicyPatchSchema);
    return context.json(
      await promotion.setPolicyEnabled(
        principal(context),
        { projectId: uuidParam(context, 'p'), policyId: uuidParam(context, 'id'), enabled },
        requestMetadata(context),
      ),
    );
  });
  routes.put('/:p/promotion-policies/:id/owner', async (context) => {
    const { serviceAccountId } = await jsonBody(context, promotionPolicyOwnerSchema);
    return context.json(
      await promotion.transferPolicyOwner(
        principal(context),
        { projectId: uuidParam(context, 'p'), policyId: uuidParam(context, 'id'), serviceAccountId },
        requestMetadata(context),
      ),
    );
  });
  routes.get('/:p/promotion-evaluations', async (context) =>
    context.json(
      await promotion.evaluations(
        principal(context),
        uuidParam(context, 'p'),
        parse(promotionEvaluationQuerySchema, context.req.query()),
      ),
    ),
  );
  routes.post('/:p/promotion-evaluations/:id/reevaluate', async (context) =>
    context.json(
      await promotion.reevaluate(
        principal(context),
        { projectId: uuidParam(context, 'p'), evaluationId: uuidParam(context, 'id') },
        requestMetadata(context),
      ),
      201,
    ),
  );
  return routes;
}
