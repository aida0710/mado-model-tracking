import { describe, expect, it } from 'vitest';
import { auditActionLabel, auditActorLabel, auditProjectLabel } from './auditEventDisplay';

const userId = '9235a979-c325-4f6a-a0e2-7a5ee6eb0e65';

describe('監査ログの表示', () => {
  it('操作者はUUIDではなく表示名で出し、tokenでの操作はその旨を添える', () => {
    expect(auditActorLabel({ actorType: 'user', actorUserId: userId, actorName: 'Admin' })).toBe(
      'Admin',
    );
    expect(auditActorLabel({ actorType: 'token', actorUserId: userId, actorName: 'worker' })).toBe(
      'worker (API token)',
    );
    expect(auditActorLabel({ actorType: 'system', actorUserId: null, actorName: null })).toBe(
      'システム',
    );
  });

  it('名前を引けない操作者もUUIDのままにしない', () => {
    expect(auditActorLabel({ actorType: 'user', actorUserId: userId, actorName: null })).not.toContain(
      userId,
    );
  });

  it('操作名は内部codeではなく日本語にし、未知のcodeはそのまま残す', () => {
    expect(auditActionLabel('report.create')).toBe('レポートの作成');
    expect(auditActionLabel('sweep.create')).toBe('Sweepの作成');
    expect(auditActionLabel('promotion_policy.owner.transfer')).toBe('昇格policyの所有者の変更');
    expect(auditActionLabel('project.group_binding.set')).toBe('groupへの権限付与');
    expect(auditActionLabel('future.action')).toBe('future.action');
  });

  it('全体の監査ログでは、Projectに属さない記録をそれと分かるように出す', () => {
    expect(auditProjectLabel({ projectId: null, projectName: null })).toContain('Projectに属さない');
    expect(auditProjectLabel({ projectId: 'p', projectName: '音声モデル実験' })).toBe('音声モデル実験');
  });
});
