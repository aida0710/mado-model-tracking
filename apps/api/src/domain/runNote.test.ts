import { RUN_NOTE_MAX_LENGTH } from '@mmt/contracts';
import { describe, expect, it } from 'vitest';
import { runNoteUpdateSchema, storedRunNote } from './runNote.js';

describe('Runの説明文', () => {
  it('8000文字までは受け付け、8001文字は拒否する', () => {
    expect(
      runNoteUpdateSchema.safeParse({ content: 'a'.repeat(RUN_NOTE_MAX_LENGTH) }).success,
    ).toBe(true);
    expect(
      runNoteUpdateSchema.safeParse({ content: 'a'.repeat(RUN_NOTE_MAX_LENGTH + 1) }).success,
    ).toBe(false);
  });

  it('content以外のfieldは拒否する', () => {
    expect(runNoteUpdateSchema.safeParse({ content: 'x', note: 'y' }).success).toBe(false);
  });

  it('空文字はtagを消す指示になり、空白だけの説明文はそのまま残す', () => {
    expect(storedRunNote('')).toBeNull();
    expect(storedRunNote('  ')).toBe('  ');
    expect(storedRunNote('# 結果\n- loss 0.1')).toBe('# 結果\n- loss 0.1');
  });
});
