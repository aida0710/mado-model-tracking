import type {
  ComputeTargetDetails,
  Launcher,
  SiteConnectionCheck,
  SiteJobShell,
  SiteJobShellSummary,
  SiteKey,
  SitePersonalSettings,
  SiteSettings,
} from '@mmt/contracts';
import { siteTarget } from './execution';

const createdAt = '2026-10-10T00:00:00Z';

const currentJobShellSummary: SiteJobShellSummary = {
  id: 'shell-2',
  targetId: 'site',
  version: 2,
  sha256: 'c'.repeat(64),
  sizeBytes: 40,
  createdBy: 'admin',
  createdByName: '管理者',
  createdAt,
};
export const currentJobShell: SiteJobShell = {
  ...currentJobShellSummary,
  content: '#!/bin/sh\nqsub "$MMT_SPEC_DIR/batch.sh"\n',
};

// An automatic PBS-like site whose Jobs run as each requester's own account.
export const automaticSiteSettings: SiteSettings = {
  launcherId: 'launcher',
  connection: {
    host: 'login.example.invalid',
    port: 2222,
    jumpHosts: ['gateway.example.invalid'],
    knownHosts: 'login.example.invalid ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIexample\n',
  },
  accountMode: 'personal',
  sharedAccount: '',
  workDirectory: '/groups/example/mmt',
  runnerPython: '/groups/example/mmt/python/bin/python3',
  runnerApiUrl: 'https://runner.example.invalid',
  cancelCommand: 'qdel "$MMT_SCHEDULER_JOB_ID"',
  gpuAssignment: 'scheduler',
  leaseGpuIds: [],
  variables: { QUEUE: 'gpu' },
  cancelGraceSeconds: 10,
  maxOutputFiles: 10_000,
  maxActiveSubmissions: 20,
  jobShell: currentJobShellSummary,
};

// A global automatic site as a global administrator sees it.
export const globalSiteDetails: ComputeTargetDetails = {
  ...siteTarget,
  submissionMode: 'automatic',
  ownerName: null,
  projectIds: [],
  site: automaticSiteSettings,
  siteAccountMode: 'personal',
};

// A researcher's PC: manual, shared with one Project, as its owner sees it.
export const ownedSiteDetails: ComputeTargetDetails = {
  ...siteTarget,
  id: 'pc',
  name: 'Alice PC',
  submissionMode: 'manual',
  supportsArray: false,
  queueTimeoutSeconds: null,
  runtimeKinds: ['docker'],
  ownerUserId: 'alice',
  ownerName: 'Alice',
  projectIds: ['project'],
  // Manual sites always run as whoever submits.
  siteAccountMode: 'personal',
  site: {
    ...automaticSiteSettings,
    launcherId: null,
    connection: null,
    accountMode: 'personal',
    workDirectory: '/home/alice/mmt',
    runnerPython: 'python3',
    runnerApiUrl: null,
    cancelCommand: null,
    gpuAssignment: 'lease',
    leaseGpuIds: ['0'],
    variables: {},
    maxActiveSubmissions: 4,
    jobShell: null,
  },
};

// The same PC as a member of the shared Project sees it: what it is, not how it is reached.
export const sharedSiteForMember: ComputeTargetDetails = {
  ...ownedSiteDetails,
  projectIds: [],
  site: null,
};

export const readyKey: SiteKey = {
  id: 'key',
  targetId: 'site',
  userId: null,
  launcherId: 'launcher',
  status: 'ready',
  publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIkey mmt-launcher:main:key',
  fingerprint: 'SHA256:examplefingerprint',
  requestedAt: createdAt,
  readyAt: createdAt,
};

export const personalSettings: SitePersonalSettings = {
  targetId: 'site',
  userId: 'alice',
  userName: 'Alice',
  accountName: 'alice',
  workDirectory: null,
  variables: { GROUP: 'gaa50000' },
  key: { ...readyKey, id: 'alice-key', userId: 'alice' },
  updatedAt: createdAt,
};

export const failedCheck: SiteConnectionCheck = {
  id: 'check',
  targetId: 'site',
  userId: null,
  requestedBy: 'admin',
  status: 'failed',
  message: 'Permission denied (publickey).',
  createdAt,
  finishedAt: createdAt,
};

export const launcher: Launcher = {
  id: 'launcher',
  name: 'main',
  createdBy: 'admin',
  createdAt,
  lastSeenAt: createdAt,
  revokedAt: null,
  tokenPrefix: 'mmt_abcdefgh',
};
