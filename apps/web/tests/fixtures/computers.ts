import type { ComputeTargetOverview } from '@mmt/contracts';

// Rows of 全体設定 → コンピュータ as Bob (a researcher) sees them.
const row: ComputeTargetOverview = {
  id: 'target',
  name: 'Container worker',
  executor: 'ssh',
  submissionMode: 'automatic',
  cpuArch: 'amd64',
  supportsArray: false,
  enabled: true,
  visibility: 'public',
  ownerUserId: 'admin',
  ownerName: '管理者',
  usable: true,
  canManage: false,
  launcher: null,
};

/** A global administrator's public ssh target, which everyone may use. */
export const publicSshOverview: ComputeTargetOverview = row;

/** Alice's private PC: Bob sees it exists, not how it is reached, and may not use it. */
export const privatePcOverview: ComputeTargetOverview = {
  ...row,
  id: 'pc',
  name: 'Alice PC',
  executor: 'site',
  submissionMode: 'manual',
  visibility: 'private',
  ownerUserId: 'alice',
  ownerName: 'Alice',
  usable: false,
};

/** A public automatic site whose launcher last asked at a known time. */
export const automaticSiteOverview: ComputeTargetOverview = {
  ...row,
  id: 'site',
  name: 'Supercomputer',
  executor: 'site',
  cpuArch: 'arm64',
  supportsArray: true,
  launcher: { name: 'main', lastSeenAt: '2026-10-10T00:00:00Z', revoked: false },
};

/** Bob's own private site: he uses and manages it. */
export const ownSiteOverview: ComputeTargetOverview = {
  ...row,
  id: 'bob-site',
  name: 'Bob GPU',
  executor: 'site',
  visibility: 'private',
  ownerUserId: 'bob',
  ownerName: 'Bob',
  canManage: true,
  launcher: null,
};
