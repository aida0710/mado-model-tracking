import type { CodeVersion, ModelVersion, RunKind } from '@mmt/contracts';
import { text } from '../i18n/catalog';

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
