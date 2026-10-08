import { describe, expect, it } from 'vitest';
import { summarizeAuditDetails } from './auditEventSummary';

describe('監査ログのdetails要約', () => {
  it('配列は読点区切り、nullは—で1行にまとめる', () => {
    expect(
      summarizeAuditDetails({ scopes: ['read', 'runs:write'], previousRole: null, role: 'editor' }),
    ).toBe('scopes: read, runs:write / previousRole: — / role: editor');
  });
  it('長いdetailsは上限の長さで省略記号を付けて切る', () => {
    const summary = summarizeAuditDetails({ name: 'x'.repeat(300) });
    expect(summary).toHaveLength(120);
    expect(summary.endsWith('…')).toBe(true);
  });
});
