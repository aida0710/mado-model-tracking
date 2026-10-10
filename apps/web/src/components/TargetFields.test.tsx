import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ComputeTargetDetails, Launcher, Project, ShareableProject } from '@mmt/contracts';
import { TargetFields, TargetSharingFields } from './TargetFields';
import type { QueryState } from '../hooks/useQuery';
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
  it('研究者の追加はsiteだけで、Executorも使える範囲も選ばず、雛形とjob shellを出す', () => {
    const html = renderFields({ values: newTargetFormValues('personal'), canAddGlobal: false });
    expect(html).toContain('自分の計算機として追加します');
    expect(html).not.toContain('>Executor<');
    expect(html).not.toContain('使える範囲');
    expect(html).toContain('job shellの雛形');
    expect(html).toContain('PBS Professional（ABCI 3.0の例）');
    // The choices are the adder's Projects, which the API lists; until then none are offered.
    expect(html).toContain('読み込み中');
    expect(html).not.toContain('共有するProject');
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
      // The choices are the owner's Projects, which the API lists; until then none are offered.
      expect(html).toContain('読み込み中');
      expect(html).not.toContain('共有するProject');
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

describe('自分の計算機の共有先の選択肢', () => {
  const query = (
    state: Partial<QueryState<ShareableProject[]>>,
  ): QueryState<ShareableProject[]> => ({
    value: undefined,
    loading: false,
    error: null,
    reload: () => undefined,
    ...state,
  });
  // A global administrator edits it, with a Project of their own that the owner is not in.
  const editorProjects: Project[] = [
    ...projects,
    { ...projects[0]!, id: 'admin-lab', name: 'Admin Lab', role: 'admin' },
  ];
  /** An edit of the target, or an addition when it is null. */
  function renderSharing(
    shareable: QueryState<ShareableProject[]>,
    target: ComputeTargetDetails | null = ownedSiteDetails,
  ) {
    return renderToStaticMarkup(
      <TargetSharingFields
        values={target ? targetFormValues(target) : newTargetFormValues('personal')}
        onChange={() => undefined}
        target={target ?? undefined}
        projects={editorProjects}
        shareable={shareable}
      />,
    );
  }
  const optionValues = (html: string) =>
    [...html.matchAll(/<option value="([^"]*)"/g)].map((match) => match[1]);

  it('足すときは、足す人が共有できるProjectだけで、メンバーでない全体管理者のProjectは出さない', () => {
    const html = renderSharing(query({ value: [{ id: 'project', name: 'Speech' }] }), null);
    expect(optionValues(html)).toEqual(['project']);
    expect(html).not.toContain('Admin Lab');
    expect(html).not.toContain('selected');
    expect(html).toContain('選ばなければ自分だけが使います。Editor以上のProjectだけを選べます。');
    const none = renderSharing(query({ value: [] }), null);
    expect(none).not.toContain('共有するProject');
    expect(none).toContain('共有できるProject（自分がEditor以上のもの）はありません。');
  });

  it('編集では、所有者が共有できるProjectで、編集する人のProjectではない', () => {
    const html = renderSharing(
      query({ value: [{ id: 'owner-lab', name: 'Owner Lab' }, { id: 'project', name: 'Speech' }] }),
    );
    expect(optionValues(html)).toEqual(['owner-lab', 'project']);
    expect(html).not.toContain('Admin Lab');
    expect(html).toContain('<option value="project" selected="">Speech</option>');
    expect(html).toContain('選べるのは、所有者がEditor以上のProjectです。');
  });

  it('所有者が共有できるProjectが無ければ、そう案内して選択肢を出さない', () => {
    const html = renderSharing(query({ value: [] }), { ...ownedSiteDetails, projectIds: [] });
    expect(html).not.toContain('共有するProject');
    expect(html).toContain('共有できるProject（所有者がEditor以上のもの）はありません。');
  });

  it('読み込み中と読めなかったときは選択肢を出さず、読めなければ再試行できる', () => {
    const loading = renderSharing(query({ loading: true }));
    expect(loading).toContain('読み込み中');
    expect(loading).not.toContain('共有するProject');
    const failed = renderSharing(
      query({ error: 'この計算機の設定は所有者か全体管理者だけが変えられます' }),
    );
    expect(failed).toContain('この計算機の設定は所有者か全体管理者だけが変えられます');
    expect(failed).toContain('再試行');
    expect(failed).not.toContain('共有するProject');
  });
});
