import { describe, expect, it } from 'vitest';
import { computeTarget, dockerCodeVersion } from '../../tests/fixtures/execution';
import {
  isTargetCompatible,
  parseRuntimeKinds,
  validateContainerWorkingDirectory,
  validateDockerImage,
  validateTargetGpuIds,
} from './runtimeValidation';

describe('Runtime入力と実行先の互換性', () => {
  it('registryのポートとtagを含むdigest固定imageを受け付ける', () => {
    expect(() =>
      validateDockerImage(`localhost:5000/team/image:v1@sha256:${'a'.repeat(64)}`),
    ).not.toThrow();
  });
  it.each([
    'image:latest',
    'image@sha256:abc',
    `https://host/image@sha256:${'a'.repeat(64)}`,
    `Bad/Image@sha256:${'a'.repeat(64)}`,
  ])('固定されていないかreference形式が不正なimage %s を拒否する', (image) =>
    expect(() => validateDockerImage(image)).toThrow(),
  );
  it.each(['app', '/app/../other', '/app/./other', '/app\\other', '/app\u0000'])(
    '相対パスやtraversalを含むcwd %s を拒否する',
    (directory) => expect(() => validateContainerWorkingDirectory(directory)).toThrow(),
  );
  it('任意cwdは空またはコンテナ内の絶対パスを受け付ける', () => {
    expect(() => validateContainerWorkingDirectory('')).not.toThrow();
    expect(() => validateContainerWorkingDirectory('/app/source')).not.toThrow();
  });
  it('PythonのみのTargetと無効なTargetはDockerを起動できない', () => {
    expect(isTargetCompatible(computeTarget, dockerCodeVersion)).toBe(true);
    expect(
      isTargetCompatible({ ...computeTarget, runtimeKinds: ['python'] }, dockerCodeVersion),
    ).toBe(false);
    expect(isTargetCompatible({ ...computeTarget, enabled: false }, dockerCodeVersion)).toBe(false);
  });
  it('対応Runtimeが空または不明だと登録できない', () => {
    expect(() => parseRuntimeKinds([])).toThrow();
    expect(() => parseRuntimeKinds(['unknown'])).toThrow();
    expect(parseRuntimeKinds(['docker', 'python'])).toEqual(['docker', 'python']);
  });
  it('選択先に存在しないGPUを拒否しCPUのみを許可する', () => {
    expect(() => validateTargetGpuIds(computeTarget, ['2'])).toThrow();
    expect(() => validateTargetGpuIds(computeTarget, [])).not.toThrow();
  });
});
