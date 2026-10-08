import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { ModelAutomationRule } from '@mmt/contracts';
import type { AutomationCatalog } from '../types/modelAutomation';
import { DetailsList, JsonDetails } from './JsonDetails';
import { CodeRuntimeDetails } from './CodeRuntimeDetails';
import { AutomationManualApply } from './AutomationManualApply';
import { AutomationOwnerTransfer } from './AutomationOwnerTransfer';
import { automationOwnerLabel } from '../lib/automationOwner';
import { buildCatalogOptions } from '../lib/catalogOptions';
import { formatDate } from '../lib/format';
import { text } from '../i18n/catalog';
import { automationText, automationTriggerLabels } from '../i18n/automation';

export function AutomationRuleDetails({
  rule,
  rules,
  catalog,
  projectId,
  canManage,
  onSelectRule,
  onApplied,
}: {
  rule: ModelAutomationRule;
  rules: ModelAutomationRule[];
  catalog?: AutomationCatalog;
  projectId: string;
  canManage: boolean;
  onSelectRule: (id: string) => void;
  onApplied: () => void;
}) {
  const options = catalog ? buildCatalogOptions(catalog.registry) : undefined;
  const code = catalog?.registry.codeVersions.find((version) => version.id === rule.codeVersionId);
  const base = `/projects/${projectId}`;
  const upstream = rules.find((item) => item.id === rule.upstreamRuleId);
  return (
    <section className="automation-rule-detail">
      <h3>{rule.name}</h3>
      <DetailsList
        entries={[
          [automationText.trigger, automationTriggerLabels[rule.trigger]],
          ...(rule.upstreamRuleId
            ? [
                [
                  automationText.upstreamRule,
                  <button
                    className="link-button"
                    onClick={() => rule.upstreamRuleId && onSelectRule(rule.upstreamRuleId)}
                  >
                    {upstream?.name ?? rule.upstreamRuleId}
                  </button>,
                ] satisfies [string, ReactNode],
              ]
            : []),
          [text.automationModelFamilies, rule.modelFamilies.join(', ')],
          [text.kind, text[rule.kind]],
          [
            text.experiments,
            <Link to={`${base}/experiments?experiment=${rule.experimentId}`}>
              {options?.experiments.find((option) => option.value === rule.experimentId)?.label ??
                rule.experimentId}
            </Link>,
          ],
          [
            text.codeVersion,
            <Link to={`${base}/codes?version=${rule.codeVersionId}`}>
              {options?.codes.find((option) => option.value === rule.codeVersionId)?.label ??
                rule.codeVersionId}
            </Link>,
          ],
          [
            text.target,
            catalog?.targets.find((target) => target.id === rule.targetId)?.name ?? rule.targetId,
          ],
          [text.gpuIds, rule.gpuIds.join(', ') || text.cpuOnly],
          [
            text.inputDatasets,
            rule.inputDatasetVersionIds.length
              ? rule.inputDatasetVersionIds.map((id) => (
                  <Link className="version-link" key={id} to={`${base}/datasets?version=${id}`}>
                    {options?.datasets.find((option) => option.value === id)?.label ?? id}
                  </Link>
                ))
              : text.none,
          ],
          [text.maxAttempts, rule.maxAttempts],
          [
            automationText.owner,
            <span title={automationText.ownerHint}>{automationOwnerLabel(rule)}</span>,
          ],
          [text.user, rule.createdBy],
          [text.created, formatDate(rule.createdAt)],
        ]}
      />
      {code && <CodeRuntimeDetails version={code} />}
      {canManage && catalog && (
        <AutomationManualApply
          key={rule.id}
          rule={rule}
          projectId={projectId}
          registry={catalog.registry}
          onApplied={onApplied}
        />
      )}
      {canManage && (
        <AutomationOwnerTransfer
          key={`${rule.id}:owner`}
          rule={rule}
          projectId={projectId}
          onTransferred={onApplied}
        />
      )}
      <details className="automation-settings">
        <summary>
          {text.parameters} / {text.tags}
        </summary>
        <JsonDetails value={rule.parameters} />
        <JsonDetails value={rule.tags} />
        <p className="muted">{text.automationFixedSettings}</p>
      </details>
    </section>
  );
}
