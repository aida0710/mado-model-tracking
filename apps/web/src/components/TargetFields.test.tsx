import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ComputeTargetDetails, Launcher } from '@mmt/contracts';
import { TargetFields } from './TargetFields';
import { newTargetFormValues, targetFormValues } from '../lib/targetInput';
import type { FormValues } from '../types/form';
import { computeTargetDetails } from '../../tests/fixtures/execution';
import { globalSiteDetails, launcher, ownedSiteDetails } from '../../tests/fixtures/siteComputers';

const researcher = { canAddSshOrLocal: false };
const administrator = { canAddSshOrLocal: true };

function renderFields({
  values,
  target,
  canAddSshOrLocal,
  launchers = [launcher],
}: {
  values: FormValues;
  target?: ComputeTargetDetails;
  canAddSshOrLocal: boolean;
  launchers?: Launcher[];
}) {
  return renderToStaticMarkup(
    <TargetFields
      values={values}
      onChange={() => undefined}
      target={target}
      canAddSshOrLocal={canAddSshOrLocal}
      allowLocal={false}
      launchers={launchers}
    />,
  );
}

const checkedVisibility = (html: string) =>
  html.match(/<input type="radio" name="target-visibility" checked="" value="(\w+)"/)?.[1];

describe('コンピュータの追加・編集の項目', () => {
  it('研究者の追加はsiteだけで、Executorは選ばず、公開範囲（既定Private）・雛形・job shellを出す', () => {
    const html = renderFields({ values: newTargetFormValues(researcher), ...researcher });
    expect(html).toContain('追加した人が所有者になります');
    expect(html).not.toContain('>Executor<');
    expect(html).toContain('公開範囲');
    expect(checkedVisibility(html)).toBe('private');
    expect(html).toContain('所有者と、所有者が作ったService AccountのJobだけが動きます');
    expect(html).not.toContain('共有するProject');
    expect(html).toContain('job shellの雛形');
    expect(html).toContain('PBS Professional（ABCI 3.0の例）');
    expect(html).toContain('job-shell-editor');
    expect(html).toContain('siteの接続先・アカウント・job shellは、ここで設定して');
    expect(html).not.toContain('site.yaml');
  });

  it('全体管理者の追加はExecutorを選べ、sshでも公開範囲を選び、siteの設定は出さない', () => {
    const html = renderFields({ values: newTargetFormValues(administrator), ...administrator });
    expect(html).toContain('>Executor<');
    expect(html).toContain('SSH鍵のパス');
    expect(checkedVisibility(html)).toBe('private');
    expect(html).not.toContain('投入と接続');
    expect(html).not.toContain('job shellの雛形');
  });

  it('自動投入では、launcher・接続先・known_hosts・アカウントを入れ、launcherが無ければ案内する', () => {
    const values = targetFormValues(globalSiteDetails);
    const html = renderFields({ values, target: globalSiteDetails, ...administrator });
    expect(html).toContain('投入と接続');
    expect(html).toContain('>main</option>');
    expect(html).toContain('known_hosts（接続先と経由するホストの行）');
    expect(html).toContain('ログインするアカウント');
    expect(html).not.toContain('ランチャーはまだ登録されていません');
    expect(
      renderFields({ values, target: globalSiteDetails, ...administrator, launchers: [] }),
    ).toContain('ランチャーはまだ登録されていません');
  });

  it('手動投入では、launcher・接続先・アカウントを出さない', () => {
    const values = targetFormValues(ownedSiteDetails);
    const html = renderFields({ values, target: ownedSiteDetails, ...researcher });
    expect(html).not.toContain('投入と接続');
    expect(html).not.toContain('接続先のhost');
    expect(html).toContain('siteでの実行');
  });

  it('編集では今の公開範囲を選んだ状態で出し、job shellは詳細でバージョンとして保存するので出さない', () => {
    const values = targetFormValues(ownedSiteDetails);
    const html = renderFields({ values, target: ownedSiteDetails, ...researcher });
    expect(html).not.toContain('>Executor<');
    expect(checkedVisibility(html)).toBe('public');
    expect(html).not.toContain('job shellの雛形');
    expect(html).not.toContain('job-shell-editor');
  });

  it('全体管理者はコンピュータの編集でExecutorを選べる', () => {
    const html = renderFields({
      values: targetFormValues(computeTargetDetails),
      target: computeTargetDetails,
      ...administrator,
    });
    expect(html).toContain('>Executor<');
  });

  it('所有者のいないコンピュータはPrivateにできないので、公開範囲を選ばせず理由を出す', () => {
    const ownerless = { ...computeTargetDetails, ownerUserId: null, ownerName: null };
    const html = renderFields({ values: targetFormValues(ownerless), target: ownerless, ...administrator });
    expect(html).not.toContain('name="target-visibility"');
    expect(html).toContain('所有者がいないので、Publicのままです');
  });
});
