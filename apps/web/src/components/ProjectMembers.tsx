import { useState } from 'react';
import type { ProjectRole } from '@mmt/contracts';
import type { ProjectMember } from '../api/inputs';
import { administrationApi } from '../api/administration';
import { useProject } from '../hooks/useProject';
import { useQuery } from '../hooks/useQuery';
import { DataTable } from './DataTable';
import { Resource } from './Feedback';
import { FormDialog } from './FormDialog';
import { getFieldValue } from '../lib/formValues';
import { text } from '../i18n/catalog';

export function ProjectMembers() {
  const { project, isProjectAdmin, reloadProjects } = useProject();
  const members = useQuery(`${project.id}:members`, (signal) =>
    administrationApi.members(project.id, signal),
  );
  const [editing, setEditing] = useState<ProjectMember | 'new' | null>(null);
  return (
    <section className="settings-section">
      <div className="section-heading">
        <h2>{text.members}</h2>
        {isProjectAdmin && (
          <button className="button small" onClick={() => setEditing('new')}>
            {text.addMember}
          </button>
        )}
      </div>
      <Resource query={members}>
        {(items) => (
          <DataTable
            items={items}
            rowKey={(member) => member.user.id}
            columns={[
              { key: 'name', label: text.name, render: (member) => member.user.displayName },
              { key: 'email', label: text.email, render: (member) => member.user.email },
              { key: 'role', label: text.role, render: (member) => text[member.role] },
              {
                key: 'actions',
                label: text.details,
                render: (member) =>
                  isProjectAdmin && (
                    <button className="button small" onClick={() => setEditing(member)}>
                      {text.edit}
                    </button>
                  ),
              },
            ]}
          />
        )}
      </Resource>
      {editing && (
        <FormDialog
          title={text.addMember}
          onClose={() => setEditing(null)}
          fields={[
            {
              name: 'userId',
              label: text.userId,
              required: true,
              defaultValue: editing === 'new' ? '' : editing.user.id,
              readOnly: editing !== 'new',
            },
            {
              name: 'role',
              label: text.role,
              type: 'select',
              defaultValue: editing === 'new' ? 'viewer' : editing.role,
              options: (['viewer', 'editor', 'admin'] as const).map((role) => ({
                value: role,
                label: text[role],
              })),
            },
          ]}
          onSubmit={(values) =>
            administrationApi.saveMember(
              project.id,
              getFieldValue(values, 'userId'),
              getFieldValue(values, 'role') as ProjectRole,
            )
          }
          onSaved={() => {
            setEditing(null);
            members.reload();
            reloadProjects();
          }}
        />
      )}
    </section>
  );
}
