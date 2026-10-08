import { describe, expect, it } from 'vitest';
import { readRunListConditions, runListParamsForView, savedViewUrl } from './runListUrl';

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
      sort: 'newest',
      columns: [],
      chartPanels: { version: 1, columns: 12, panels: [] },
    });
    expect(params.toString()).toBe('view=v1&experiment=e1&q=bert&charts=1');
    expect(readRunListConditions(params)).toEqual({
      experimentId: 'e1',
      searchText: 'bert',
      status: '',
      sort: 'newest',
    });
  });
});
