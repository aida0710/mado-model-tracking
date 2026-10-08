import { describe, expect, it } from 'vitest';
import { scopesAllowedForRole } from './tokenScopes';

describe('Roleで選べるtokenのscope', () => {
  it('viewerは読み取りだけ、editorは書き込みまで、adminは全部を選べる', () => {
    expect(scopesAllowedForRole('viewer')).toEqual(['read']);
    expect(scopesAllowedForRole('editor')).toEqual([
      'read',
      'runs:write',
      'registry:write',
      'artifacts:write',
      'jobs:write',
    ]);
    expect(scopesAllowedForRole('admin')).toContain('worker:execute');
    expect(scopesAllowedForRole('admin')).toContain('admin');
  });
});
