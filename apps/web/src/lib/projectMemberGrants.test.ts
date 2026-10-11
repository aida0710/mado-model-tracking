import { describe, expect, it } from 'vitest';
import {
  addMemberGrant,
  changeMemberGrantRole,
  DEFAULT_MEMBER_GRANT_ROLE,
  removeMemberGrant,
  toProjectMemberGrants,
} from './projectMemberGrants';

const alice = { id: 'u-alice', email: 'alice@example.com', displayName: 'Alice' };
const bob = { id: 'u-bob', email: 'bob@example.com', displayName: 'Bob' };

describe('作成時に追加するメンバー', () => {
  it('追加した人は既定でEditorになり、追加した順に並ぶ', () => {
    const drafts = addMemberGrant(addMemberGrant([], alice), bob);
    expect(DEFAULT_MEMBER_GRANT_ROLE).toBe('editor');
    expect(drafts.map((draft) => [draft.user.id, draft.role])).toEqual([
      ['u-alice', 'editor'],
      ['u-bob', 'editor'],
    ]);
  });

  it('同じ人を2回選んでも1行のままで、変えたRoleも保つ', () => {
    const drafts = changeMemberGrantRole(addMemberGrant([], alice), { userId: 'u-alice', role: 'admin' });
    expect(addMemberGrant(drafts, alice)).toEqual([{ user: alice, role: 'admin' }]);
  });

  it('行ごとにRoleを変えて外せる', () => {
    const drafts = changeMemberGrantRole(addMemberGrant(addMemberGrant([], alice), bob), {
      userId: 'u-bob',
      role: 'viewer',
    });
    expect(removeMemberGrant(drafts, 'u-alice')).toEqual([{ user: bob, role: 'viewer' }]);
  });

  it('送るときはuserIdとroleだけにする', () => {
    expect(toProjectMemberGrants([{ user: alice, role: 'viewer' }])).toEqual([
      { userId: 'u-alice', role: 'viewer' },
    ]);
  });
});
