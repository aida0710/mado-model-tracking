import { useState } from 'react';
import type { ModelAutomationRule } from '@mmt/contracts';
import type { ExecutionCatalog } from '../types/executionCatalog';
import { automationApi } from '../api/automation';
import { useQuery } from '../hooks/useQuery';
import { FormFields } from './FormFields';
import { ConfirmDialog } from './ConfirmDialog';
import { ErrorNotice } from './Feedback';
import { buildCatalogOptions, withEmptyOption } from '../lib/catalogOptions';
import { getFieldValue } from '../lib/formValues';
import {
  manualExecutionErrorMessage,
  manualExecutionRequest,
  manualUpstreamRunOptions,
  manualVersionOptions,
} from '../lib/automationManualExecution';
import { automationText } from '../i18n/automation';

/** Lets a Project admin run a rule on a version (or upstream Run) registered before the rule. */
export function AutomationManualApply({
  rule,
  projectId,
  registry,
  onApplied,
}: {
  rule: ModelAutomationRule;
  projectId: string;
  registry: ExecutionCatalog;
  onApplied: () => void;
}) {
  const isChained = rule.trigger === 'upstream_run_finished';
  const executions = useQuery(
    isChained ? `${projectId}:automation-executions:manual-apply` : null,
    (signal) => automationApi.executions(projectId, signal),
  );
  const [values, setValues] = useState<Record<string, string>>({ target: '' });
  const [isConfirming, setIsConfirming] = useState(false);
  const [isApplied, setIsApplied] = useState(false);
  const versionOptions = buildCatalogOptions(registry).models;
  const options = isChained
    ? manualUpstreamRunOptions({
        rule,
        executions: executions.value ?? [],
        versionLabel: (id) => versionOptions.find((option) => option.value === id)?.label ?? id,
      })
    : manualVersionOptions(rule, registry);
  const selectedId = getFieldValue(values, 'target');
  const selectedLabel = options.find((option) => option.value === selectedId)?.label ?? selectedId;
  const isLoading = isChained && executions.loading && !executions.value;
  return (
    <section className="automation-manual-apply">
      <h4>{automationText.applyToVersion}</h4>
      <ErrorNotice message={executions.error} retry={executions.reload} />
      {!isLoading && !options.length ? (
        <p className="muted">
          {isChained ? automationText.applyNoUpstreamRuns : automationText.applyNoVersions}
        </p>
      ) : (
        <FormFields
          fields={[
            {
              name: 'target',
              label: isChained ? automationText.applyUpstreamRun : automationText.applyVersion,
              type: 'select',
              options: withEmptyOption(options),
            },
          ]}
          values={values}
          onChange={(next) => {
            setValues({ target: getFieldValue(next, 'target') });
            setIsApplied(false);
          }}
        />
      )}
      <button
        className="button small"
        disabled={!selectedId}
        onClick={() => setIsConfirming(true)}
      >
        {automationText.applyToVersion}
      </button>
      {isApplied && <p className="notice">{automationText.applied}</p>}
      {isConfirming && (
        <ConfirmDialog
          title={automationText.applyToVersion}
          message={automationText.applyConfirmMessage(rule.name, selectedLabel)}
          confirmLabel={automationText.applyConfirm}
          onConfirm={() =>
            automationApi
              .createExecution(projectId, rule.id, manualExecutionRequest(rule, selectedId))
              .catch((failure: unknown) => {
                throw new Error(manualExecutionErrorMessage(failure));
              })
          }
          onConfirmed={() => {
            setIsConfirming(false);
            setIsApplied(true);
            onApplied();
          }}
          onClose={() => setIsConfirming(false)}
        />
      )}
    </section>
  );
}
