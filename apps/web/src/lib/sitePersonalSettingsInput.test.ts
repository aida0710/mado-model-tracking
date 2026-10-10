import { describe, expect, it } from 'vitest';
import {
  globalSiteDetails,
  ownedSiteDetails,
  personalSettings,
  sharedSiteForMember,
} from '../../tests/fixtures/siteComputers';
import {
  buildPersonalSettingsInput,
  personalSettingsFormValues,
  personalSettingsScope,
} from './sitePersonalSettingsInput';

const values = (overrides: Record<string, string> = {}) => ({
  ...personalSettingsFormValues(null),
  ...overrides,
});

describe('自分の設定', () => {
  it('自動・本人のアカウントのsiteはアカウント名から、手動のsiteは作業ディレクトリと変数だけ、共用アカウントには無い', () => {
    expect(personalSettingsScope(globalSiteDetails)).toBe('withAccount');
    expect(personalSettingsScope({ ...globalSiteDetails, siteAccountMode: 'shared' })).toBe('none');
    expect(personalSettingsScope(ownedSiteDetails)).toBe('withoutAccount');
    // Everyone who may use a site knows its account mode, even without its settings.
    expect(personalSettingsScope({ ...sharedSiteForMember, submissionMode: 'automatic' })).toBe(
      'withAccount',
    );
  });

  it('本人のアカウントのsiteではアカウント名を必須にして送る', () => {
    expect(() => buildPersonalSettingsInput(values(), 'withAccount')).toThrow('アカウント名');
    expect(() => buildPersonalSettingsInput(values({ accountName: 'al ice' }), 'withAccount')).toThrow(
      'アカウント名',
    );
    expect(buildPersonalSettingsInput(values({ accountName: ' alice ' }), 'withAccount')).toEqual({
      accountName: 'alice',
      workDirectory: null,
      variables: {},
    });
  });

  it('手動のsiteではアカウント名を送らない（submitを実行した人のアカウントで動く）', () => {
    expect(
      buildPersonalSettingsInput(values({ accountName: 'alice' }), 'withoutAccount'),
    ).not.toHaveProperty('accountName');
  });

  it('作業ディレクトリは空なら計算機の設定に戻し（null）、絶対パスでなければ拒否する', () => {
    const build = (personalWorkDirectory: string) =>
      buildPersonalSettingsInput(values({ personalWorkDirectory }), 'withoutAccount');
    expect(build('').workDirectory).toBeNull();
    expect(build('/work/alice').workDirectory).toBe('/work/alice');
    expect(() => build('work')).toThrow('絶対パス');
  });

  it('保存済みの設定を入力に戻し、変数は1行に1つ並べる', () => {
    expect(personalSettingsFormValues(personalSettings)).toEqual({
      accountName: 'alice',
      personalWorkDirectory: '',
      personalVariables: 'GROUP=gaa50000',
    });
    expect(buildPersonalSettingsInput(personalSettingsFormValues(personalSettings), 'withAccount')).toEqual({
      accountName: 'alice',
      workDirectory: null,
      variables: { GROUP: 'gaa50000' },
    });
  });
});
