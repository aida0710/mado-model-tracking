import type { CodeVersion, ModelVersion, RunKind } from '@mmt/contracts';
import { DomainError } from './errors.js';

export function validateCodeCompatibility(
  code: CodeVersion,
  execution: { model: Pick<ModelVersion, 'family'> | null; kind?: RunKind },
): void {
  if (execution.model && !code.supportedModelFamilies.includes(execution.model.family)) {
    throw new DomainError(
      422,
      `モデル系列${execution.model.family}に対応していないCodeVersionです`,
      'incompatible_model_family',
    );
  }
  if (execution.kind && !code.taskTypes.includes(execution.kind)) {
    throw new DomainError(
      422,
      `Run kind ${execution.kind}に対応していないCodeVersionです`,
      'incompatible_task_type',
    );
  }
}
