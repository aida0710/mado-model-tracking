import { describe, expect, it } from 'vitest';
import { parseRunKinds, readRunListConditions, runListParamsForView, savedViewUrl } from './runListUrl';

describe('Run一覧のURL', () => {
  it('共有用のURLはビューのIDだけを持つ', () => {
    expect(savedViewUrl('http://127.0.0.1:5182', 'p 1', 'v&1')).toBe(
      'http://127.0.0.1:5182/projects/p%201/experiments?view=v%261',
    );
  });

  it('ビューを開いたURLには条件を書き、既定値は省き、図があれば図を開く', () => {
    const params = runListParamsForView('v1', {
      experimentId: 'e1',
      searchText: 'bert',
      status: '',
      kinds: [],
      sort: 'newest',
      columns: [],
      chartPanels: { version: 1, columns: 12, panels: [] },
    });
    expect(params.toString()).toBe('view=v1&experiment=e1&q=bert&charts=1');
    expect(readRunListConditions(params)).toEqual({
      experimentId: 'e1',
      searchText: 'bert',
      status: '',
      kinds: [],
      sort: 'newest',
    });
  });

  it('保存ビューの実行種別をURLに書き、読み戻すと同じ種別で検索できる', () => {
    const params = runListParamsForView('v1', {
      experimentId: '',
      searchText: '',
      status: 'finished',
      kinds: ['training', 'finetuning'],
      sort: 'newest',
      columns: [],
      chartPanels: null,
    });
    expect(params.get('kinds')).toBe('training,finetuning');
    expect(readRunListConditions(params).kinds).toEqual(['training', 'finetuning']);
  });

  it('書き換えられたURLの知らない種別と重複は捨てる', () => {
    expect(parseRunKinds('training,unknown,training,')).toEqual(['training']);
    expect(parseRunKinds(null)).toEqual([]);
  });
});
