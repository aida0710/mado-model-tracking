import { useState } from 'react';
import { Plus } from 'lucide-react';
import type { Model, ModelAliasProtection, ModelAliasProtectionRole } from '@mmt/contracts';
import { registryApi } from '../api/registry';
import { useAuth } from '../hooks/useAuth';
import { useProject } from '../hooks/useProject';
import { useQuery } from '../hooks/useQuery';
import { canManageAliasProtections } from '../lib/permissions';
import { formatDate } from '../lib/format';
import { getFieldValue } from '../lib/formValues';
import { ConfirmDialog } from './ConfirmDialog';
import { ResponsiveTable } from './ResponsiveTable';
import { Resource } from './Feedback';
import { FormDialog } from './FormDialog';
import { aliasProtectionRoleLabels, promotionTextTemplates } from '../i18n/promotion';
import { text } from '../i18n/catalog';

// The scope select uses this value for the Project-wide protection (modelId null).
const PROJECT_SCOPE = '';

/** The "保護alias" tab of the Models page: who may change which alias by hand. */
export function AliasProtectionSettings({ models }: { models: Model[] }) {
  const { project } = useProject();
  const { user } = useAuth();
  const canManage = canManageAliasProtections(project.role, user.isAdmin);
  const protections = useQuery(`${project.id}:alias-protections`, (signal) =>
    registryApi.aliasProtections(project.id, null, signal),
  );
  const [editing, setEditing] = useState<ModelAliasProtection | 'new' | null>(null);
  const [removing, setRemoving] = useState<ModelAliasProtection | null>(null);
  const scopeLabel = (modelId: string | null) =>
    modelId === null
      ? text.aliasProtectionScopeProject
      : (models.find((model) => model.id === modelId)?.name ?? modelId);
  return (
    <section className="automation-panel">
      <div className="section-heading">
        <h2>{text.aliasProtections}</h2>
        {canManage && (
          <button className="button primary small" onClick={() => setEditing('new')}>
            <Plus size={15} />
            {text.aliasProtectionAdd}
          </button>
        )}
      </div>
      <p className="muted">{text.aliasProtectionsHint}</p>
      <Resource query={protections}>
        {(items) => (
          <ResponsiveTable
            rows={items}
            rowKey={(protection) => protection.id}
            empty={text.aliasProtectionsEmpty}
            columns={[
              {
                key: 'alias',
                priority: 'primary',
                header: text.alias,
                className: 'mono',
                render: (protection) => protection.alias,
              },
              {
                key: 'scope',
                priority: 'primary',
                header: text.aliasProtectionScope,
                render: (protection) => scopeLabel(protection.modelId),
              },
              {
                key: 'requiredRole',
                priority: 'secondary',
                header: text.aliasProtectionRequiredRole,
                render: (protection) => aliasProtectionRoleLabels[protection.requiredRole],
              },
              {
                key: 'requirePassedEvaluation',
                priority: 'secondary',
                header: text.aliasProtectionRequirePassedEvaluationColumn,
                render: (protection) =>
                  protection.requirePassedEvaluation
                    ? text.aliasProtectionRequired
                    : text.aliasProtectionNotRequired,
              },
              {
                key: 'updatedAt',
                priority: 'secondary',
                header: text.aliasProtectionUpdatedAt,
                render: (protection) => formatDate(protection.updatedAt),
              },
              ...(canManage
                ? [
                    {
                      key: 'actions',
                      priority: 'secondary' as const,
                      header: text.details,
                      render: (protection: ModelAliasProtection) => (
                        <div className="access-actions">
                          <button className="button small" onClick={() => setEditing(protection)}>
                            {text.edit}
                          </button>
                          <button
                            className="button small danger"
                            onClick={() => setRemoving(protection)}
                          >
                            {text.aliasProtectionRemove}
                          </button>
                        </div>
                      ),
                    },
                  ]
                : []),
            ]}
          />
        )}
      </Resource>
      {editing && (
        <FormDialog
          title={editing === 'new' ? text.aliasProtectionAdd : text.aliasProtectionEdit}
          onClose={() => setEditing(null)}
          fields={[
            {
              name: 'scope',
              label: text.aliasProtectionScope,
              type: 'select',
              defaultValue: PROJECT_SCOPE,
              options: [
                { value: PROJECT_SCOPE, label: text.aliasProtectionScopeProject },
                ...models.map((model) => ({ value: model.id, label: model.name })),
              ],
              visible: () => editing === 'new',
            },
            {
              name: 'alias',
              label: text.alias,
              required: true,
              defaultValue: editing === 'new' ? '' : editing.alias,
              readOnly: editing !== 'new',
            },
            {
              name: 'requiredRole',
              label: text.aliasProtectionRequiredRole,
              type: 'select',
              defaultValue: editing === 'new' ? 'admin' : editing.requiredRole,
              options: (['admin', 'editor'] as const).map((role) => ({
                value: role,
                label: aliasProtectionRoleLabels[role],
              })),
            },
            {
              name: 'requirePassedEvaluation',
              label: text.aliasProtectionRequirePassedEvaluation,
              type: 'checkbox',
              defaultValue: String(editing !== 'new' && editing.requirePassedEvaluation),
            },
          ]}
          onSubmit={(values) =>
            registryApi.setAliasProtection(project.id, {
              alias: editing === 'new' ? getFieldValue(values, 'alias').trim() : editing.alias,
              modelId: editing === 'new' ? getFieldValue(values, 'scope') || null : editing.modelId,
              requiredRole: getFieldValue(values, 'requiredRole') as ModelAliasProtectionRole,
              requirePassedEvaluation: getFieldValue(values, 'requirePassedEvaluation') === 'true',
            })
          }
          onSaved={() => {
            setEditing(null);
            protections.reload();
          }}
        />
      )}
      {removing && (
        <ConfirmDialog
          title={text.aliasProtectionRemove}
          message={promotionTextTemplates.removeAliasProtectionConfirm(
            removing.alias,
            scopeLabel(removing.modelId),
          )}
          confirmLabel={text.aliasProtectionRemove}
          destructive
          onConfirm={() =>
            registryApi.removeAliasProtection(project.id, {
              alias: removing.alias,
              modelId: removing.modelId,
            })
          }
          onConfirmed={() => {
            setRemoving(null);
            protections.reload();
          }}
          onClose={() => setRemoving(null)}
        />
      )}
    </section>
  );
}
