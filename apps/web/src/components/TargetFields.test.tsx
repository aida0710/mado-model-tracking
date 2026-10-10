import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ComputeTargetDetails, Launcher, Project } from '@mmt/contracts';
import { TargetFields } from './TargetFields';
import { newTargetFormValues, targetFormValues } from '../lib/targetInput';
import type { FormValues } from '../types/form';
import { computeTargetDetails } from '../../tests/fixtures/execution';
import { globalSiteDetails, launcher, ownedSiteDetails } from '../../tests/fixtures/siteComputers';

const projects: Project[] = [
  {
    id: 'project',
    name: 'Speech',
    description: '',
    artifactBackend: 'filesystem',
    role: 'editor',
    createdAt: '2026-10-10T00:00:00Z',
  },
  {
    id: 'viewed',
    name: 'Vision',
    description: '',
    artifactBackend: 'filesystem',
    role: 'viewer',
    createdAt: '2026-10-10T00:00:00Z',
  },
];

function renderFields({
  values,
  target,
  canAddGlobal,
  launchers = [launcher],
}: {
  values: FormValues;
  target?: ComputeTargetDetails;
  canAddGlobal: boolean;
  launchers?: Launcher[];
}) {
  return renderToStaticMarkup(
    <TargetFields
      values={values}
      onChange={() => undefined}
      target={target}
      canAddGlobal={canAddGlobal}
      allowLocal={false}
      launchers={launchers}
      projects={projects}
    />,
  );
}

describe('計算機の追加・編集の項目', () => {
  it('研究者の追加はsiteだけで、Executorも使える範囲も選ばず、雛形とjob shellとEditor以上の共有先を出す', () => {
    const html = renderFields({ values: newTargetFormValues('personal'), canAddGlobal: false });
    expect(html).toContain('自分の計算機として追加します');
    expect(html).not.toContain('>Executor<');
    expect(html).not.toContain('使える範囲');
    expect(html).toContain('job shellの雛形');
    expect(html).toContain('PBS Professional（ABCI 3.0の例）');
    expect(html).toContain('共有するProject');
    expect(html).toContain('>Speech</option>');
    expect(html).not.toContain('>Vision</option>');
    expect(html).toContain('job-shell-editor');
    expect(html).toContain('siteの接続先・アカウント・job shellは、ここで設定して');
    expect(html).not.toContain('site.yaml');
  });

  it('全体管理者のsiteの追加では、全体か自分の計算機かを選べる', () => {
    const html = renderFields({
      values: { ...newTargetFormValues('global'), executor: 'site' },
      canAddGlobal: true,
    });
    expect(html).toContain('>Executor<');
    expect(html).toContain('使える範囲');
    expect(html).toContain('全体の計算機（どのProjectからも使えます）');
    // A global computer serves every Project, so there is nothing to share it with.
    expect(html).not.toContain('共有するProject');
  });

  it('全体管理者のssh targetの追加には、siteの設定を出さない', () => {
    const html = renderFields({ values: newTargetFormValues('global'), canAddGlobal: true });
    expect(html).toContain('SSH鍵のパス');
    expect(html).not.toContain('投入と接続');
    expect(html).not.toContain('job shellの雛形');
  });

  it('自動投入では、launcher・接続先・known_hosts・アカウントを入れ、launcherが無ければ案内する', () => {
    const values = targetFormValues(globalSiteDetails);
    const html = renderFields({ values, target: globalSiteDetails, canAddGlobal: true });
    expect(html).toContain('投入と接続');
    expect(html).toContain('>main</option>');
    expect(html).toContain('known_hosts（接続先と経由するホストの行）');
    expect(html).toContain('ログインするアカウント');
    expect(html).not.toContain('launcherはまだ登録されていません');
    expect(
      renderFields({ values, target: globalSiteDetails, canAddGlobal: true, launchers: [] }),
    ).toContain('launcherはまだ登録されていません');
  });

  it('手動投入では、launcher・接続先・アカウントを出さない', () => {
    const values = targetFormValues(ownedSiteDetails);
    const html = renderFields({ values, target: ownedSiteDetails, canAddGlobal: false });
    expect(html).not.toContain('投入と接続');
    expect(html).not.toContain('接続先のhost');
    expect(html).toContain('siteでの実行');
  });

  it('自分の計算機の編集はsiteのままで、job shellは詳細で版として保存するので出さない', () => {
    const values = targetFormValues(ownedSiteDetails);
    for (const canAddGlobal of [true, false]) {
      const html = renderFields({ values, target: ownedSiteDetails, canAddGlobal });
      expect(html).not.toContain('>Executor<');
      expect(html).not.toContain('job shellの雛形');
      expect(html).not.toContain('job-shell-editor');
      expect(html).toContain('共有するProject');
    }
  });

  it('全体の計算機の編集では、全体管理者がExecutorを選べる', () => {
    const html = renderFields({
      values: targetFormValues(computeTargetDetails),
      target: computeTargetDetails,
      canAddGlobal: true,
    });
    expect(html).toContain('>Executor<');
  });
});
