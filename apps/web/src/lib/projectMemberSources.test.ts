import { describe, expect, it } from 'vitest';
import type { ProjectMember } from '@mmt/contracts';
import { hasDirectGrant, listProjectMemberSources } from './projectMemberSources';

function member(overrides: Partial<ProjectMember>): ProjectMember {
  return {
    user: {
      id: 'user',
      email: 'user@example.com',
      displayName: 'User',
      isAdmin: false,
      username: null,
      status: 'active',
      authSources: ['oidc'],
      kind: 'human',
    },
    role: 'viewer',
    directRole: null,
    groups: [],
    ...overrides,
  };
}

describe('メンバーの付与元', () => {
  it('直接付与だけのメンバーは直接付与の1件だけを示し、変更・削除できる', () => {
    const directOnly = member({ role: 'editor', directRole: 'editor' });
    expect(listProjectMemberSources(directOnly)).toEqual([{ kind: 'direct', role: 'editor' }]);
    expect(hasDirectGrant(directOnly)).toBe(true);
  });

  it('groupだけで権限を得たメンバーはgroupを示し、この画面では変更・削除できない', () => {
    const groupOnly = member({ role: 'editor', groups: [{ group: 'ml-team', role: 'editor' }] });
    expect(listProjectMemberSources(groupOnly)).toEqual([
      { kind: 'group', group: 'ml-team', role: 'editor' },
    ]);
    expect(hasDirectGrant(groupOnly)).toBe(false);
  });

  it('直接付与とgroupの両方があれば直接付与を先に、groupを名前順に並べる', () => {
    const both = member({
      role: 'admin',
      directRole: 'viewer',
      groups: [
        { group: 'research', role: 'admin' },
        { group: 'ml-team', role: 'editor' },
      ],
    });
    expect(listProjectMemberSources(both)).toEqual([
      { kind: 'direct', role: 'viewer' },
      { kind: 'group', group: 'ml-team', role: 'editor' },
      { kind: 'group', group: 'research', role: 'admin' },
    ]);
    expect(hasDirectGrant(both)).toBe(true);
  });

  it('付与元を並べ替えても受け取ったメンバーのgroupの順は変えない', () => {
    const groups = [
      { group: 'b', role: 'viewer' as const },
      { group: 'a', role: 'viewer' as const },
    ];
    listProjectMemberSources(member({ groups }));
    expect(groups.map(({ group }) => group)).toEqual(['b', 'a']);
  });
});
