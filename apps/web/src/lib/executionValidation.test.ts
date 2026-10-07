import { describe, expect, it } from 'vitest';
import type { CodeVersion, ModelVersion } from '@mmt/contracts';
import { isCodeCompatible, validateCodeCompatibility } from './executionValidation';

const code = {
  taskTypes: ['inference', 'training'],
  supportedModelFamilies: ['Qwen3'],
} as CodeVersion;
describe('実行するコードの互換性', () => {
  it('モデル系列と実行種別の両方が一致すると選択できる', () => {
    expect(isCodeCompatible(code, 'training', { family: 'Qwen3' } as ModelVersion)).toBe(true);
  });
  it('異なるモデル系列と未対応のfine-tuningを拒否する', () => {
    expect(() =>
      validateCodeCompatibility(code, 'inference', { family: 'Qwen2' } as ModelVersion),
    ).toThrow();
    expect(isCodeCompatible(code, 'finetuning', { family: 'Qwen3' } as ModelVersion)).toBe(false);
  });
});
