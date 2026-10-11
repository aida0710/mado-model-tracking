import { describe, expect, it } from 'vitest';
import { buildProjectCreate, DEFAULT_PROJECT_VISIBILITY } from './projectCreateInput';

const alice = { id: 'u-alice', email: 'alice@example.com', displayName: 'Alice' };

describe('buildProjectCreate', () => {
  it('新しいプロジェクトの公開範囲は既定でPublic', () => {
    expect(DEFAULT_PROJECT_VISIBILITY).toBe('public');
  });

  it('名前と説明の前後の空白を除き、空の説明は送らない', () => {
    expect(
      buildProjectCreate({
        name: '  音声合成  ',
        description: '   ',
        visibility: 'public',
        artifactBackend: 'local',
        memberDrafts: [],
      }),
    ).toEqual({ name: '音声合成', artifactBackend: 'local', visibility: 'public' });
  });

  it('Privateのときは選んだメンバーをRoleつきで送る', () => {
    expect(
      buildProjectCreate({
        name: 'p',
        description: '説明',
        visibility: 'private',
        artifactBackend: 's3-main',
        memberDrafts: [{ user: alice, role: 'viewer' }],
      }),
    ).toEqual({
      name: 'p',
      description: '説明',
      artifactBackend: 's3-main',
      visibility: 'private',
      members: [{ userId: 'u-alice', role: 'viewer' }],
    });
  });

  it('Publicに戻したときは、選んでいたメンバーを送らない', () => {
    const body = buildProjectCreate({
      name: 'p',
      description: '',
      visibility: 'public',
      artifactBackend: 'local',
      memberDrafts: [{ user: alice, role: 'editor' }],
    });
    expect(body.members).toBeUndefined();
  });
});
