import { useState } from 'react';
import type { ProjectMember } from '@mmt/contracts';
import type { useProjectMembers } from '../hooks/useProjectMembers';
import { useProject } from '../hooks/useProject';
import { ResponsiveTable } from './ResponsiveTable';
import { Resource } from './Feedback';
import { ConfirmDialog } from './ConfirmDialog';
import { MemberDialog } from '../dialogs/MemberDialog';
import {
  hasDirectGrant,
  listProjectMemberSources,
  type ProjectMemberSource,
} from '../lib/projectMemberSources';
import { text } from '../i18n/catalog';
import { projectAccessTextTemplates } from '../i18n/projectAccess';

/** Everyone with a Project role, where that role comes from, and direct grants for admins. */
export function ProjectMembers({
  projectMembers,
}: {
  projectMembers: ReturnType<typeof useProjectMembers>;
}) {
  const { isProjectAdmin, reloadProjects } = useProject();
  const { members, saveMember, removeMember } = projectMembers;
  const [editing, setEditing] = useState<ProjectMember | 'new' | null>(null);
  const [removing, setRemoving] = useState<ProjectMember | null>(null);
  // The signed-in user's own role may have changed, which decides what the shell shows.
  const reloadAfterChange = () => {
    members.reload();
    reloadProjects();
  };
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
          <ResponsiveTable
            rows={items}
            rowKey={(member) => member.user.id}
            columns={[
              {
                key: 'name',
                priority: 'primary',
                header: text.name,
                render: (member) => (
                  <span className="member-name">
                    {member.user.displayName}
                    {member.user.status === 'disabled' && (
                      <span className="user-status disabled" title={text.memberDisabledHint}>
                        {text.memberDisabled}
                      </span>
                    )}
                  </span>
                ),
              },
              {
                key: 'email',
                priority: 'secondary',
                header: text.email,
                render: (member) => member.user.email,
              },
              {
                key: 'role',
                priority: 'primary',
                header: text.effectiveRole,
                render: (member) => text[member.role],
              },
              {
                key: 'sources',
                priority: 'secondary',
                header: text.memberSources,
                render: (member) => (
                  <ul className="member-sources">
                    {listProjectMemberSources(member).map((source) => (
                      <li key={source.kind === 'direct' ? 'direct' : `group:${source.group}`}>
                        {describeSource(source)}
                      </li>
                    ))}
                  </ul>
                ),
              },
              ...(isProjectAdmin
                ? [
                    {
                      key: 'actions',
                      priority: 'secondary' as const,
                      header: text.actions,
                      render: (member: ProjectMember) =>
                        hasDirectGrant(member) ? (
                          <div className="access-actions">
                            <button className="button small" onClick={() => setEditing(member)}>
                              {text.edit}
                            </button>
                            <button
                              className="button small danger"
                              onClick={() => setRemoving(member)}
                            >
                              {text.remove}
                            </button>
                          </div>
                        ) : (
                          <span className="muted">{text.memberGrantedByGroup}</span>
                        ),
                    },
                  ]
                : []),
            ]}
          />
        )}
      </Resource>
      {editing && (
        <MemberDialog
          member={editing === 'new' ? undefined : editing}
          onSave={saveMember}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            reloadAfterChange();
          }}
        />
      )}
      {removing && (
        <ConfirmDialog
          title={text.removeMember}
          message={projectAccessTextTemplates.removeMemberConfirm(
            removing.user.displayName,
            removing.groups.length > 0,
          )}
          confirmLabel={text.remove}
          destructive
          onClose={() => setRemoving(null)}
          onConfirm={() => removeMember(removing.user.id)}
          onConfirmed={() => {
            setRemoving(null);
            reloadAfterChange();
          }}
        />
      )}
    </section>
  );
}

function describeSource(source: ProjectMemberSource): string {
  const origin =
    source.kind === 'direct'
      ? text.memberSourceDirect
      : projectAccessTextTemplates.memberSourceGroup(source.group);
  return `${origin}: ${text[source.role]}`;
}
