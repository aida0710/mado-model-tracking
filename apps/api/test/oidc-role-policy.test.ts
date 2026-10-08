import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { TEST_SESSION_ENCRYPTION_KEY } from './mockOidcProvider.js';
import { removesLastGlobalAdmin } from '../src/domain/globalAdminInvariant.js';
import {
  createOidcRolePolicy,
  resolveOidcAccess,
  type OidcRolePolicy,
} from '../src/domain/oidcRolePolicy.js';

const policy: OidcRolePolicy = {
  allowedGroups: ['mmt-users', 'mmt-admins'],
  roleMapping: { 'mmt-admins': 'admin', 'mmt-users': 'user' },
  defaultRole: 'user',
};

describe('resolveOidcAccess', () => {
  it('許可groupに1つも入っていなければ拒否する', () => {
    expect(resolveOidcAccess(policy, ['other'])).toEqual({ allowed: false, groups: ['other'] });
    expect(resolveOidcAccess(policy, []).allowed).toBe(false);
  });

  it('複数groupに該当すると強い方のroleになり、groupは重複を除いて並べ替える', () => {
    expect(resolveOidcAccess(policy, ['mmt-users', 'mmt-admins', 'mmt-users'])).toEqual({
      allowed: true,
      globalRole: 'admin',
      isAdmin: true,
      groups: ['mmt-admins', 'mmt-users'],
    });
  });

  it('対応表に無い許可ユーザーはOIDC_DEFAULT_ROLEになる', () => {
    const withoutUserMapping = { ...policy, roleMapping: { 'mmt-admins': 'admin' as const } };
    expect(resolveOidcAccess(withoutUserMapping, ['mmt-users'])).toMatchObject({
      globalRole: 'user',
      isAdmin: false,
    });
    expect(
      resolveOidcAccess({ ...withoutUserMapping, defaultRole: 'admin' }, ['mmt-users']),
    ).toMatchObject({ globalRole: 'admin', isAdmin: true });
  });

  it('文字列でない・空・長すぎるgroupは判定にも保存にも使わない', () => {
    expect(resolveOidcAccess(policy, ['mmt-users', 1, '', 'x'.repeat(257), null])).toMatchObject({
      allowed: true,
      groups: ['mmt-users'],
    });
  });
});

describe('createOidcRolePolicy', () => {
  const base = {
    allowedGroups: 'mmt-users, mmt-admins',
    roleMappingJson: undefined,
    defaultRole: undefined,
    adminGroup: undefined,
  };

  it('OIDC_ALLOWED_GROUPSが空なら作れない', () => {
    expect(() => createOidcRolePolicy({ ...base, allowedGroups: undefined })).toThrow(
      /OIDC_ALLOWED_GROUPS/,
    );
    expect(() => createOidcRolePolicy({ ...base, allowedGroups: ' , ' })).toThrow(
      /OIDC_ALLOWED_GROUPS/,
    );
  });

  it('対応表もOIDC_ADMIN_GROUPも無ければ従来どおりmmt-adminsが全体管理者になる', () => {
    expect(createOidcRolePolicy(base)).toEqual({
      allowedGroups: ['mmt-admins', 'mmt-users'],
      roleMapping: { 'mmt-admins': 'admin' },
      defaultRole: 'user',
    });
  });

  it('OIDC_ADMIN_GROUPだけでも対応表と同じ判定になる', () => {
    const shorthand = createOidcRolePolicy({ ...base, adminGroup: 'ops' });
    const mapping = createOidcRolePolicy({ ...base, roleMappingJson: '{"ops":"admin"}' });
    expect(shorthand).toEqual(mapping);
    expect(resolveOidcAccess(shorthand, ['mmt-users', 'ops'])).toMatchObject({ isAdmin: true });
  });

  it('対応表とOIDC_ADMIN_GROUPのadmin groupが一致すれば併用でき、食い違えば作れない', () => {
    expect(
      createOidcRolePolicy({
        ...base,
        adminGroup: 'mmt-admins',
        roleMappingJson: '{"mmt-admins":"admin","mmt-users":"user"}',
      }).roleMapping,
    ).toEqual({ 'mmt-admins': 'admin', 'mmt-users': 'user' });
    for (const roleMappingJson of [
      '{"ops":"admin"}',
      '{"mmt-admins":"user"}',
      '{"mmt-admins":"admin","ops":"admin"}',
    ])
      expect(() =>
        createOidcRolePolicy({ ...base, adminGroup: 'mmt-admins', roleMappingJson }),
      ).toThrow(/OIDC_ADMIN_GROUP disagrees/);
  });

  it('未知のroleや壊れたJSONは作れない', () => {
    expect(() => createOidcRolePolicy({ ...base, roleMappingJson: '{"ops":"owner"}' })).toThrow(
      /OIDC_ROLE_MAPPING_JSON roles/,
    );
    for (const roleMappingJson of ['not json', '[]', '"admin"', 'null'])
      expect(() => createOidcRolePolicy({ ...base, roleMappingJson })).toThrow(
        /OIDC_ROLE_MAPPING_JSON/,
      );
    expect(() => createOidcRolePolicy({ ...base, defaultRole: 'viewer' })).toThrow(
      /OIDC_DEFAULT_ROLE/,
    );
  });
});

describe('removesLastGlobalAdmin', () => {
  it('ほかに有効な全体管理者がいなくなる変更だけを検出する', () => {
    expect(removesLastGlobalAdmin(['a'], { userId: 'a', isAdmin: false })).toBe(true);
    expect(removesLastGlobalAdmin(['a'], { userId: 'a', status: 'disabled' })).toBe(true);
    expect(removesLastGlobalAdmin(['a', 'b'], { userId: 'a', isAdmin: false })).toBe(false);
    expect(removesLastGlobalAdmin(['a'], { userId: 'a', isAdmin: true })).toBe(false);
    expect(removesLastGlobalAdmin(['b'], { userId: 'a', isAdmin: false })).toBe(false);
    expect(removesLastGlobalAdmin([], { userId: 'a', isAdmin: false })).toBe(false);
  });
});

describe('OIDCの起動設定', () => {
  const oidcEnvironment = {
    MMT_DATABASE_URL: 'postgresql://mmt@127.0.0.1:1/mmt_test',
    AUTH_MODE: 'oidc',
    OIDC_ISSUER_URL: 'https://sso.example.test/application/o/mmt/',
    OIDC_CLIENT_ID: 'mmt',
    OIDC_ALLOWED_GROUPS: 'mmt-users,mmt-admins',
    MMT_SESSION_ENCRYPTION_KEY: TEST_SESSION_ENCRYPTION_KEY,
  };

  it('oidcとhybridはOIDC_ALLOWED_GROUPSが無いと起動しない。localは読まない', () => {
    for (const AUTH_MODE of ['oidc', 'hybrid'])
      expect(() => loadConfig({ ...oidcEnvironment, AUTH_MODE, OIDC_ALLOWED_GROUPS: '' })).toThrow(
        /OIDC_ALLOWED_GROUPS/,
      );
    expect(
      loadConfig({ ...oidcEnvironment, AUTH_MODE: 'local', OIDC_ALLOWED_GROUPS: '' }).oidc,
    ).toBeNull();
  });

  it('対応表とOIDC_ADMIN_GROUPが食い違うと起動しない', () => {
    expect(() =>
      loadConfig({
        ...oidcEnvironment,
        OIDC_ADMIN_GROUP: 'mmt-admins',
        OIDC_ROLE_MAPPING_JSON: '{"ops":"admin"}',
      }),
    ).toThrow(/OIDC_ADMIN_GROUP disagrees/);
  });

  it('自動連携は既定で無効、scopeは既定でopenid profile email、openidの無いscopeは拒否する', () => {
    const config = loadConfig(oidcEnvironment);
    expect(config.oidc).toMatchObject({
      autoLinkVerifiedEmail: false,
      scopes: 'openid profile email',
      rolePolicy: { roleMapping: { 'mmt-admins': 'admin' }, defaultRole: 'user' },
    });
    expect(() => loadConfig({ ...oidcEnvironment, OIDC_SCOPES: 'profile email' })).toThrow(
      /OIDC_SCOPES/,
    );
  });
});
