import { Link } from 'react-router-dom';
import type { ModelAutomationRule } from '@mmt/contracts';
import type { AutomationCatalog } from '../types/modelAutomation';
import { DetailsList, JsonDetails } from './JsonDetails';
import { CodeRuntimeDetails } from './CodeRuntimeDetails';
import { buildCatalogOptions } from '../lib/catalogOptions';
import { formatDate } from '../lib/format';
import { text } from '../i18n/catalog';

export function AutomationRuleDetails({
  rule,
  catalog,
  projectId,
}: {
  rule: ModelAutomationRule;
  catalog?: AutomationCatalog;
  projectId: string;
}) {
  const options = catalog ? buildCatalogOptions(catalog.registry) : undefined;
  const code = catalog?.registry.codeVersions.find((version) => version.id === rule.codeVersionId);
  const base = `/projects/${projectId}`;
  return (
    <section className="automation-rule-detail">
      <h3>{rule.name}</h3>
      <DetailsList
        entries={[
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
          [text.user, rule.createdBy],
          [text.created, formatDate(rule.createdAt)],
        ]}
      />
      {code && <CodeRuntimeDetails version={code} />}
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
