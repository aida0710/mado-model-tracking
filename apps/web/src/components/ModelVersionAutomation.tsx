import type { ModelAutomationExecutionPage, ModelAutomationRule } from '@mmt/contracts';
import type { QueryState } from '../hooks/useQuery';
import { AutomationExecutionsTable } from './AutomationExecutionsTable';
import { Resource } from './Feedback';
import { text } from '../i18n/catalog';

/**
 * One version's automation executions: rule, kind, registration outcome, Run and Job state,
 * duration, and why a rule failed or was skipped. The caller polls while work is in progress.
 */
export function ModelVersionAutomation({
  projectId,
  executions,
  rules,
}: {
  projectId: string;
  executions: QueryState<ModelAutomationExecutionPage>;
  rules: ModelAutomationRule[];
}) {
  return (
    <section className="model-version-section" aria-label={text.modelVersionAutomation}>
      <div className="section-heading">
        <h2>{text.modelVersionAutomation}</h2>
      </div>
      <Resource query={executions}>
        {(page) => (
          <>
            {page.items.length ? (
              <AutomationExecutionsTable
                executions={page.items}
                rules={rules}
                projectId={projectId}
                variant="version"
              />
            ) : (
              <p className="muted">{text.modelVersionNoExecutions}</p>
            )}
            {page.nextCursor && <p className="muted">{text.modelVersionAutomationTruncated}</p>}
          </>
        )}
      </Resource>
    </section>
  );
}
