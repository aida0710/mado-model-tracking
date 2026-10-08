import { describe, expect, it } from 'vitest';
import { dialogClassName } from './Dialog';

describe('dialogClassName', () => {
  it('既定では狭い幅で全画面になる', () => {
    expect(dialogClassName({ wide: false, fullScreenOnNarrow: true, className: '' })).toBe(
      'dialog fullscreen-on-narrow',
    );
  });

  it('fullScreenOnNarrow を外すと狭い幅で下からのシートになり、wide と追加の class を保つ', () => {
    expect(
      dialogClassName({ wide: true, fullScreenOnNarrow: false, className: 'workspace-dialog' }),
    ).toBe('dialog wide sheet-on-narrow workspace-dialog');
  });
});
