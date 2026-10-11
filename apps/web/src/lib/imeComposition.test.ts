import { describe, expect, it } from 'vitest';
import { isComposingKey } from './imeComposition';

const keyEvent = ({ keyCode, isComposing }: { keyCode: number; isComposing: boolean }) => ({
  keyCode,
  nativeEvent: { isComposing },
});

describe('isComposingKey', () => {
  it('変換中のキー（isComposing）は変換の操作とみなす', () => {
    expect(isComposingKey(keyEvent({ keyCode: 13, isComposing: true }))).toBe(true);
  });

  it('keyCode 229 のキーは、isComposing が false でも変換の確定とみなす（Safari の確定の Enter）', () => {
    expect(isComposingKey(keyEvent({ keyCode: 229, isComposing: false }))).toBe(true);
  });

  it('変換していない Enter や矢印は通常のキー操作として扱う', () => {
    expect(isComposingKey(keyEvent({ keyCode: 13, isComposing: false }))).toBe(false);
    expect(isComposingKey(keyEvent({ keyCode: 40, isComposing: false }))).toBe(false);
  });
});
