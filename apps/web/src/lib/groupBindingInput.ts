import type { ProjectGroupBinding } from '@mmt/contracts';

/**
 * The binding a newly typed group name would replace. PUT /group-bindings/:group both adds and
 * changes, so the add dialog checks this first instead of silently overwriting the role.
 * Authentik group names are compared as-is, the same way the API stores them.
 */
export function findExistingGroupBinding(
  bindings: readonly ProjectGroupBinding[],
  groupName: string,
): ProjectGroupBinding | undefined {
  const typedName = groupName.trim();
  return bindings.find((binding) => binding.group === typedName);
}
