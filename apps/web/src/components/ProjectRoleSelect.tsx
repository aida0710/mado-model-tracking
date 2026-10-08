import { useId } from 'react';
import type { ProjectRole } from '@mmt/contracts';
import { text } from '../i18n/catalog';

// Weakest first, the order people read the roles in.
const PROJECT_ROLES: readonly ProjectRole[] = ['viewer', 'editor', 'admin'];

export function ProjectRoleSelect({
  label,
  value,
  onChange,
}: {
  label: string;
  value: ProjectRole;
  onChange: (role: ProjectRole) => void;
}) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <select
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value as ProjectRole)}
      >
        {PROJECT_ROLES.map((role) => (
          <option key={role} value={role}>
            {text[role]}
          </option>
        ))}
      </select>
    </div>
  );
}
