import { describe, expect, it } from 'vitest';
import type { ModelAliasProtection, PromotionEvaluation, PromotionPolicy } from '@mmt/contracts';
import {
  hasBaselineMoved,
  currentDecisionsForAlias,
  effectiveAliasProtection,
  meetsProtectionRole,
  promotionEvidenceRequirement,
} from './promotionEvidence';

function protection(overrides: Partial<ModelAliasProtection>): ModelAliasProtection {
  return {
    id: 'protection',
    projectId: 'project',
    modelId: null,
    alias: 'production',
    requiredRole: 'editor',
    requirePassedEvaluation: false,
    createdBy: 'admin',
    createdAt: '2026-10-08T00:00:00Z',
    updatedBy: 'admin',
    updatedAt: '2026-10-08T00:00:00Z',
    ...overrides,
  };
}

function decision(overrides: Partial<PromotionEvaluation>): PromotionEvaluation {
  return {
    id: 'decision',
    projectId: 'project',
    policyId: 'gate',
    modelId: 'model',
    candidateVersionId: 'v2',
    candidateRunId: 'run-1',
    baselineVersionId: null,
    baselineRunId: null,
    decision: 'passed',
    criteriaResults: [],
    reason: null,
    promoted: false,
    aliasEventId: null,
    sequence: 1,
    requestedBy: null,
    createdAt: '2026-10-08T01:00:00Z',
    ...overrides,
  };
}

const policies = [
  { id: 'gate', targetAlias: 'production' },
  { id: 'staging-gate', targetAlias: 'staging' },
] as PromotionPolicy[];

describe('保護aliasと昇格の根拠', () => {
  it('Project全体とModelの保護は、それぞれ厳しい方の設定になる', () => {
    const combined = effectiveAliasProtection(
      [
        protection({ requiredRole: 'admin' }),
        protection({ modelId: 'model', requirePassedEvaluation: true }),
        protection({ modelId: 'other', alias: 'production', requiredRole: 'admin' }),
      ],
      { modelId: 'model', alias: 'production' },
    );
    expect(combined).toEqual({ requiredRole: 'admin', requirePassedEvaluation: true });
    expect(effectiveAliasProtection([protection({})], { modelId: 'model', alias: 'staging' })).toBe(
      null,
    );
  });

  it('保護のroleに届かない利用者を判別する', () => {
    const adminOnly = { requiredRole: 'admin', requirePassedEvaluation: false } as const;
    expect(meetsProtectionRole('editor', adminOnly)).toBe(false);
    expect(meetsProtectionRole('admin', adminOnly)).toBe(true);
    expect(meetsProtectionRole('viewer', null)).toBe(true);
  });

  it('同じ候補Runの再判定は最新だけを残し、別aliasのpolicyや別の版の判定は除く', () => {
    const decisions = [
      decision({ id: 'first', decision: 'failed' }),
      decision({ id: 'retried', sequence: 2, createdAt: '2026-10-08T02:00:00Z' }),
      decision({ id: 'staging', policyId: 'staging-gate' }),
      decision({ id: 'other-version', candidateVersionId: 'v3' }),
    ];
    expect(
      currentDecisionsForAlias(decisions, { policies, alias: 'production', versionId: 'v2' }).map(
        (item) => item.id,
      ),
    ).toEqual(['retried']);
  });

  it('合格判定が要る保護では判定を求め、判定が無い保護aliasや不合格の版には理由を求める', () => {
    const requireEvaluation = { requiredRole: 'editor', requirePassedEvaluation: true } as const;
    expect(
      promotionEvidenceRequirement({
        protection: requireEvaluation,
        decisions: [],
        evaluationId: '',
      }),
    ).toEqual({ evaluationRequired: true, reasonRequired: true });
    expect(
      promotionEvidenceRequirement({
        protection: requireEvaluation,
        decisions: [decision({})],
        evaluationId: 'decision',
      }),
    ).toEqual({ evaluationRequired: true, reasonRequired: false });
    expect(
      promotionEvidenceRequirement({
        protection: null,
        decisions: [decision({ decision: 'failed' })],
        evaluationId: '',
      }),
    ).toEqual({ evaluationRequired: false, reasonRequired: true });
    expect(
      promotionEvidenceRequirement({ protection: null, decisions: [], evaluationId: '' }),
    ).toEqual({ evaluationRequired: false, reasonRequired: false });
  });
});

describe('判定のあとに基準が変わったか', () => {
  const policy = { baselineAlias: 'production' };

  it('基準なしの初回合格は、productionが別の版を指した後は今の基準と比べていない', () => {
    expect(hasBaselineMoved({ baselineVersionId: null }, { policy, aliases: { production: 'v2' } })).toBe(true);
  });

  it('判定時と同じ版が基準のままなら、根拠に使える', () => {
    expect(hasBaselineMoved({ baselineVersionId: 'v1' }, { policy, aliases: { production: 'v1' } })).toBe(false);
    expect(hasBaselineMoved({ baselineVersionId: null }, { policy, aliases: {} })).toBe(false);
  });
});
