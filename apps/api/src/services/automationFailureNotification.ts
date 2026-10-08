import type { ModelAutomationRule, ModelVersion } from '@mmt/contracts';
import type { Connection } from '../db/database.js';
import { enqueueNotificationEvent } from './notificationEvents.js';

/** An execution that ended without starting a Run: the rule could not run for the version. */
export interface UnstartedAutomationExecution {
  executionId: string;
  rule: Pick<ModelAutomationRule, 'id' | 'name' | 'kind' | 'experimentId'>;
  model: Pick<ModelVersion, 'id' | 'modelId' | 'projectId' | 'version'>;
  status: 'failed' | 'skipped';
  // Stored as '<code>: <message>'; only the code goes into the notification.
  error: string;
}

/**
 * Queues automation.failed in the caller's transaction. The subject carries the rule's Run kind
 * and Experiment, so rules filtered on them still match although no Run exists.
 */
export async function enqueueAutomationFailure(
  connection: Connection,
  failure: UnstartedAutomationExecution & { webOrigin: string },
): Promise<void> {
  const { rule, model } = failure;
  await enqueueNotificationEvent(connection, {
    projectId: model.projectId,
    type: 'automation.failed',
    dedupeKey: `automation.failed:${failure.executionId}`,
    subject: {
      runKind: rule.kind,
      experimentId: rule.experimentId,
      isAutomation: async () => true,
    },
    describe: async () => ({
      title: `自動実行を開始できませんでした: ${rule.name}`,
      run: null,
      details: {
        executionId: failure.executionId,
        ruleId: rule.id,
        ruleName: rule.name,
        modelVersionId: model.id,
        modelVersion: model.version,
        status: failure.status,
        reason: failure.error.split(':', 1)[0]!,
      },
      url: `${failure.webOrigin}/projects/${encodeURIComponent(model.projectId)}/models/${encodeURIComponent(model.modelId)}/versions/${encodeURIComponent(model.id)}`,
    }),
  });
}
