import type { ModelVersion } from '@mmt/contracts';
import { defaultBaselineAlias } from './evaluationComparisonDisplay';

/** The version a model version is compared with: the one an alias points to, or a chosen one. */
export type BaselineChoice = { kind: 'alias'; alias: string } | { kind: 'version'; versionId: string };

type VersionOrder = Pick<ModelVersion, 'id' | 'createdAt'>;

/**
 * The default alias (production first), unless it points at the candidate itself, as it does once
 * the candidate has been promoted: comparing a version with itself shows only zeros, so the
 * version registered just before the candidate is taken instead. Null when there is nothing else.
 */
export function defaultBaselineChoice(input: {
  aliases: Record<string, string>;
  candidateVersionId: string;
  versions: readonly VersionOrder[];
}): BaselineChoice | null {
  const alias = defaultBaselineAlias(input.aliases);
  if (alias && input.aliases[alias] !== input.candidateVersionId) return { kind: 'alias', alias };
  const candidate = input.versions.find((version) => version.id === input.candidateVersionId);
  const previous = input.versions
    .filter((version) => version.id !== input.candidateVersionId)
    .filter((version) => !candidate || version.createdAt < candidate.createdAt)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
  if (previous) return { kind: 'version', versionId: previous.id };
  return alias ? { kind: 'alias', alias } : null;
}

/** Whether a choice made earlier still names an alias or version of the Model. */
export function isBaselineChoiceAvailable(
  choice: BaselineChoice,
  model: { aliases: Record<string, string>; versions: readonly Pick<ModelVersion, 'id'>[] },
): boolean {
  return choice.kind === 'alias'
    ? Object.hasOwn(model.aliases, choice.alias)
    : model.versions.some((version) => version.id === choice.versionId);
}

export function baselineVersionIdOf(
  choice: BaselineChoice | null,
  aliases: Record<string, string>,
): string | null {
  if (!choice) return null;
  return choice.kind === 'alias' ? (aliases[choice.alias] ?? null) : choice.versionId;
}

// The value of the baseline <select>: aliases and versions share one list.
export function encodeBaselineChoice(choice: BaselineChoice | null): string {
  if (!choice) return '';
  return choice.kind === 'alias' ? `alias:${choice.alias}` : `version:${choice.versionId}`;
}

export function decodeBaselineChoice(value: string): BaselineChoice | null {
  if (value.startsWith('alias:')) return { kind: 'alias', alias: value.slice('alias:'.length) };
  if (value.startsWith('version:'))
    return { kind: 'version', versionId: value.slice('version:'.length) };
  return null;
}
