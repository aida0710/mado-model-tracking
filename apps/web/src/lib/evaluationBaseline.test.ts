import { describe, expect, it } from 'vitest';
import {
  baselineVersionIdOf,
  decodeBaselineChoice,
  defaultBaselineChoice,
  encodeBaselineChoice,
} from './evaluationBaseline';

const versions = [
  { id: 'v1', createdAt: '2026-10-08T13:00:00.000Z' },
  { id: 'v2', createdAt: '2026-10-08T13:46:00.000Z' },
];

describe('defaultBaselineChoice', () => {
  it('productionが別の版を指していれば、productionを基準にする', () => {
    expect(
      defaultBaselineChoice({ aliases: { production: 'v1' }, candidateVersionId: 'v2', versions }),
    ).toEqual({ kind: 'alias', alias: 'production' });
  });

  it('自動昇格でproductionがこの版を指すと、自分自身ではなく直前の版を基準にする', () => {
    expect(
      defaultBaselineChoice({ aliases: { production: 'v2' }, candidateVersionId: 'v2', versions }),
    ).toEqual({ kind: 'version', versionId: 'v1' });
  });

  it('前の版がなければproductionのまま（比べる相手がいない）', () => {
    expect(
      defaultBaselineChoice({ aliases: { production: 'v1' }, candidateVersionId: 'v1', versions }),
    ).toEqual({ kind: 'alias', alias: 'production' });
  });
});

describe('基準の選択値', () => {
  it('aliasと版を1つのselectの値として行き来できる', () => {
    for (const choice of [
      { kind: 'alias', alias: 'production' },
      { kind: 'version', versionId: 'v1' },
    ] as const)
      expect(decodeBaselineChoice(encodeBaselineChoice(choice))).toEqual(choice);
  });

  it('aliasの選択は、そのaliasが指す版を基準版にする', () => {
    expect(baselineVersionIdOf({ kind: 'alias', alias: 'production' }, { production: 'v1' })).toBe('v1');
    expect(baselineVersionIdOf({ kind: 'version', versionId: 'v1' }, {})).toBe('v1');
  });
});
