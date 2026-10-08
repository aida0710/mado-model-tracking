import type {
  PromotionEvaluation,
  PromotionEvaluationPage,
  PromotionPolicy,
  PromotionPolicyCreate,
} from '@mmt/contracts';
import {
  encodeId,
  invalidResponseError,
  jsonRequest,
  projectPath,
  request,
  requestItems,
} from './http';

// One server page per "load more"; the API caps limit at 200.
export const PROMOTION_EVALUATION_PAGE_SIZE = 50;

const policiesPath = (projectId: string) => `${projectPath(projectId)}/promotion-policies`;
const evaluationsPath = (projectId: string) => `${projectPath(projectId)}/promotion-evaluations`;

export const promotionApi = {
  policies: (projectId: string, signal?: AbortSignal) =>
    requestItems<PromotionPolicy>(policiesPath(projectId), signal),
  createPolicy: (projectId: string, body: PromotionPolicyCreate) =>
    request<PromotionPolicy>(policiesPath(projectId), jsonRequest('POST', body)),
  setPolicyEnabled: (projectId: string, policyId: string, enabled: boolean) =>
    request<PromotionPolicy>(
      `${policiesPath(projectId)}/${encodeId(policyId)}`,
      jsonRequest('PATCH', { enabled }),
    ),
  // Filtered by a policy, by a candidate version (the version page), or both.
  evaluations: async (
    projectId: string,
    {
      policyId,
      candidateVersionId,
      cursor,
      signal,
    }: { policyId?: string; candidateVersionId?: string; cursor?: string; signal?: AbortSignal },
  ): Promise<PromotionEvaluationPage> => {
    const query = new URLSearchParams({ limit: String(PROMOTION_EVALUATION_PAGE_SIZE) });
    if (policyId) query.set('policyId', policyId);
    if (candidateVersionId) query.set('candidateVersionId', candidateVersionId);
    if (cursor) query.set('cursor', cursor);
    const page = await request<PromotionEvaluationPage>(`${evaluationsPath(projectId)}?${query}`, {
      signal,
    });
    if (
      !Array.isArray(page.items) ||
      (page.nextCursor !== null && typeof page.nextCursor !== 'string')
    )
      throw invalidResponseError();
    return page;
  },
  transferPolicyOwner: (projectId: string, policyId: string, serviceAccountId: string) =>
    request<PromotionPolicy>(
      `${policiesPath(projectId)}/${encodeId(policyId)}/owner`,
      jsonRequest('PUT', { serviceAccountId }),
    ),
  reevaluate: (projectId: string, evaluationId: string) =>
    request<PromotionEvaluation>(
      `${evaluationsPath(projectId)}/${encodeId(evaluationId)}/reevaluate`,
      { method: 'POST' },
    ),
};
