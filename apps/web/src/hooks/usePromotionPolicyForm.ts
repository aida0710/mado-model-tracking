import { useState } from 'react';
import type { Model, ModelAutomationRule, PromotionPolicy } from '@mmt/contracts';
import { promotionApi } from '../api/promotion';
import {
  buildPromotionPolicyInput,
  createCriterionDraft,
  createPromotionPolicyDraft,
  updatePromotionPolicyDraft,
  type PromotionCriterionDraft,
  type PromotionPolicyDraft,
} from '../lib/promotionPolicyInput';
import { useMutation } from './useMutation';

export function usePromotionPolicyForm({
  projectId,
  models,
  rules,
  initialModelId,
}: {
  projectId: string;
  models: Model[];
  rules: ModelAutomationRule[];
  initialModelId: string;
}) {
  const [draft, setDraft] = useState(() => createPromotionPolicyDraft(initialModelId));
  const mutation = useMutation();
  function changeDraft(changes: Partial<PromotionPolicyDraft>) {
    setDraft((previous) =>
      updatePromotionPolicyDraft({ next: { ...previous, ...changes }, models, rules }),
    );
    mutation.clearError();
  }
  function changeCriterion(key: string, changes: Partial<PromotionCriterionDraft>) {
    setDraft((previous) => ({
      ...previous,
      criteria: previous.criteria.map((criterion) =>
        criterion.key === key ? { ...criterion, ...changes } : criterion,
      ),
    }));
    mutation.clearError();
  }
  function addCriterion() {
    setDraft((previous) => ({
      ...previous,
      criteria: [...previous.criteria, createCriterionDraft()],
    }));
  }
  function removeCriterion(key: string) {
    setDraft((previous) => ({
      ...previous,
      criteria: previous.criteria.filter((criterion) => criterion.key !== key),
    }));
  }
  function save(): Promise<PromotionPolicy | undefined> {
    return mutation.run(() =>
      promotionApi.createPolicy(projectId, buildPromotionPolicyInput({ draft, models, rules })),
    );
  }
  return {
    ...mutation,
    draft,
    changeDraft,
    changeCriterion,
    addCriterion,
    removeCriterion,
    save,
  };
}
