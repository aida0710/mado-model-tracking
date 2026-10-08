import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { CODE_SAMPLES } from './codeSamples';

describe('コード編集のPythonサンプル', () => {
  for (const sample of CODE_SAMPLES) {
    it(`${sample.id}のtestコマンドはAPI接続なしで成功する`, () => {
      const directory = mkdtempSync(join(tmpdir(), 'mmt-code-sample-'));
      try {
        Object.entries(sample.files).forEach(([path, content]) => writeFileSync(join(directory, path), content));
        const execution = spawnSync('python3', sample.testEntrypoint.slice(1), { cwd: directory, encoding: 'utf8' });
        expect(execution.status, execution.stderr).toBe(0);
        expect(execution.stderr).toContain('OK');
        if (sample.id === 'smoke') {
          const run = spawnSync('python3', sample.entrypoint.slice(1), { cwd: directory, encoding: 'utf8' });
          expect(run.status, run.stderr).toBe(0);
          expect(run.stdout.trim()).toBe('7.0');
        }
      } finally { rmSync(directory, { recursive: true, force: true }); }
    });
  }
});
