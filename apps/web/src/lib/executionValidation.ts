import type { CodeVersion, ModelVersion, RunKind } from '@mmt/contracts';
import { text } from '../i18n/catalog';
import { parsePositiveInteger } from './formValues';

// Match the API retry bound for manual and automatic jobs.
export const MAX_JOB_ATTEMPTS = 100;
// Use the API default before the user chooses a different retry budget.
export const DEFAULT_JOB_ATTEMPTS = 3;
export function parseMaxAttempts(value: string): number {
  const attempts = parsePositiveInteger(value);
  if (attempts > MAX_JOB_ATTEMPTS) throw new Error(text.maxAttemptsError);
  return attempts;
}

export const RUN_KINDS: RunKind[] = [
  'inference',
  'evaluation',
  'training',
  'finetuning',
  'processing',
];
export function isCodeCompatible(code: CodeVersion, kind: RunKind, model?: ModelVersion): boolean {
  return (
    code.taskTypes.includes(kind) && (!model || code.supportedModelFamilies.includes(model.family))
  );
}
export function validateCodeCompatibility(
  code: CodeVersion | undefined,
  kind: RunKind,
  model?: ModelVersion,
) {
  if (code && !isCodeCompatible(code, kind, model)) throw new Error(text.launchBlocked);
}
