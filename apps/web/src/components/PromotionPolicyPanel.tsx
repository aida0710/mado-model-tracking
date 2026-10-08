import { useState } from 'react';
import { Plus, RefreshCw } from 'lucide-react';
import type { PromotionPolicy } from '@mmt/contracts';
import { useAuth } from '../hooks/useAuth';
import { useProject } from '../hooks/useProject';
import { useQuery } from '../hooks/useQuery';
import { useExecutionCatalog } from '../hooks/useExecutionCatalog';
import { usePromotionPolicies } from '../hooks/usePromotionPolicies';
import { usePromotionEvaluations } from '../hooks/usePromotionEvaluations';
import { automationApi } from '../api/automation';
import { accessApi } from '../api/access';
import { canManagePromotionPolicies, canReevaluatePromotion } from '../lib/permissions';
import { PromotionPolicyDialog } from '../dialogs/PromotionPolicyDialog';
import { PromotionOwnerDialog } from '../dialogs/PromotionOwnerDialog';
import { PromotionPolicyTable } from './PromotionPolicyTable';
import { PromotionEvaluationTable } from './PromotionEvaluationTable';
import { QueryDialog } from './QueryDialog';
import { ErrorNotice, Resource } from './Feedback';
import { text } from '../i18n/catalog';

/** The "昇格policy" tab of the Models page: policies and the decision history of the selected one. */
export function PromotionPolicyPanel({ initialModelId }: { initialModelId: string }) {
  const { project } = useProject();
  const { user } = useAuth();
  const canManage = canManagePromotionPolicies(project.role, user.isAdmin);
  const promotion = usePromotionPolicies(project.id);
  const rules = useQuery(`${project.id}:automation-rules`, (signal) =>
    automationApi.rules(project.id, signal),
  );
  const catalog = useExecutionCatalog(project.id);
  // Only managers transfer owners, and listing Service Accounts is theirs too.
  const serviceAccounts = useQuery(canManage ? `${project.id}:service-accounts` : null, (signal) =>
    accessApi.serviceAccounts(project.id, signal),
  );
  const [transferring, setTransferring] = useState<PromotionPolicy | null>(null);
  // Without an explicit choice the history follows the first (newest) policy.
  const policyId = promotion.selectedPolicyId || promotion.policies.value?.[0]?.id || null;
  const evaluations = usePromotionEvaluations(project.id, policyId);
  const versionLabel = (versionId: string) =>
    catalog.value?.modelVersions.find((version) => version.id === versionId)?.version ?? versionId;
  return (
    <section className="automation-panel">
      <div className="section-heading">
        <h2>{text.promotionPolicies}</h2>
        <div>
          {canManage && (
            <button className="button primary small" onClick={promotion.startCreating}>
              <Plus size={15} />
              {text.newPromotionPolicy}
            </button>
          )}
          <button
            className="icon-button"
            aria-label={text.refresh}
            onClick={() => {
              promotion.policies.reload();
              rules.reload();
              catalog.reload();
              evaluations.reload();
            }}
          >
            <RefreshCw size={17} />
          </button>
        </div>
      </div>
      <ErrorNotice message={promotion.error} />
      <ErrorNotice message={rules.error} retry={rules.reload} />
      <ErrorNotice message={catalog.error} retry={catalog.reload} />
      <ErrorNotice message={serviceAccounts.error} retry={serviceAccounts.reload} />
      <Resource query={promotion.policies}>
        {(policies) => (
          <PromotionPolicyTable
            policies={policies}
            models={catalog.value?.models ?? []}
            rules={rules.value ?? []}
            serviceAccounts={serviceAccounts.value ?? []}
            selectedPolicyId={policyId ?? ''}
            canManage={canManage}
            pending={promotion.pending}
            onSelect={promotion.selectPolicy}
            onSetEnabled={(id, enabled) => {
              void promotion.setEnabled(id, enabled);
            }}
            onTransferOwner={setTransferring}
          />
        )}
      </Resource>
      {policyId && (
        <>
          <h3>{text.promotionEvaluations}</h3>
          <ErrorNotice message={evaluations.error} retry={evaluations.reload} />
          <ErrorNotice message={evaluations.reevaluateError} />
          <PromotionEvaluationTable
            evaluations={evaluations.items}
            projectId={project.id}
            versionLabel={versionLabel}
            canReevaluate={canReevaluatePromotion(project.role)}
            reevaluating={evaluations.reevaluating}
            onReevaluate={(id) => {
              void evaluations.reevaluate(id);
            }}
            empty={evaluations.loading ? text.loading : text.promotionEvaluationsEmpty}
          />
          {evaluations.hasMore && (
            <div className="section-actions">
              <button
                className="button small"
                disabled={evaluations.loading}
                onClick={evaluations.loadMore}
              >
                {text.promotionLoadMore}
              </button>
            </div>
          )}
        </>
      )}
      {canManage && transferring && (
        <PromotionOwnerDialog
          projectId={project.id}
          policy={transferring}
          serviceAccounts={serviceAccounts.value ?? []}
          onClose={() => setTransferring(null)}
          onSaved={() => {
            setTransferring(null);
            promotion.policies.reload();
          }}
        />
      )}
      {canManage && promotion.isCreating && (
        <QueryDialog fullScreenOnNarrow
          title={text.newPromotionPolicy}
          onClose={promotion.stopCreating}
          query={catalog}
        >
          {(choices) => (
            <QueryDialog fullScreenOnNarrow
              title={text.newPromotionPolicy}
              onClose={promotion.stopCreating}
              query={rules}
            >
              {(automationRules) => (
                <PromotionPolicyDialog
                  models={choices.models}
                  rules={automationRules}
                  catalog={choices}
                  initialModelId={initialModelId}
                  onClose={promotion.stopCreating}
                  onSaved={(policy) => {
                    promotion.stopCreating();
                    promotion.selectPolicy(policy.id);
                    promotion.policies.reload();
                  }}
                />
              )}
            </QueryDialog>
          )}
        </QueryDialog>
      )}
    </section>
  );
}
