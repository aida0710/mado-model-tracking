import { describe, expect, it } from 'vitest';
import { MAX_JOB_SHELL_BYTES } from '@mmt/contracts';
import { parseJobShellContent } from './jobShellContent';

describe('job shellの内容', () => {
  it('書いたとおりに保存し、前後の空白も変えない', () => {
    const content = '#!/bin/sh\n  set -eu\n\n';
    expect(parseJobShellContent(content)).toBe(content);
  });

  it('空白だけの内容を拒否する', () => {
    expect(() => parseJobShellContent(' \n\t')).toThrow('job shell');
  });

  it('UTF-8で1 MiBを超える内容を拒否する（文字数ではなくbyte数で数える）', () => {
    const threeByteCharacters = 'あ'.repeat(Math.floor(MAX_JOB_SHELL_BYTES / 3) + 1);
    expect(threeByteCharacters.length).toBeLessThan(MAX_JOB_SHELL_BYTES);
    expect(() => parseJobShellContent(threeByteCharacters)).toThrow('1 MiB');
    expect(parseJobShellContent('a'.repeat(MAX_JOB_SHELL_BYTES))).toHaveLength(MAX_JOB_SHELL_BYTES);
  });
});
