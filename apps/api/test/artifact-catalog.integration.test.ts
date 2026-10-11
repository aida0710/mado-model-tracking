import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Artifact, Project } from '@mmt/contracts';
import { createHarness, entity, request, testDatabaseUrl, type Harness } from './harness.js';
import { projectFixture } from './fixtures.js';

async function uploadProjectArtifact(
  harness: Harness,
  upload: { basePath: string; cookie: string; path: string },
): Promise<Artifact> {
  return entity<Artifact>(
    await request(harness.app, `${upload.basePath}/artifacts?path=${encodeURIComponent(upload.path)}`, {
      method: 'PUT',
      cookie: upload.cookie,
      binary: 'verification fixture',
      headers: { 'Content-Type': 'application/octet-stream' },
    }),
  );
}

describe.skipIf(!testDatabaseUrl)('ProjectのArtifact一覧とmetadata（独立PostgreSQL）', () => {
  let harness: Harness;
  beforeAll(async () => {
    harness = await createHarness();
  });
  beforeEach(async () => {
    await harness.reset();
  });
  afterAll(async () => {
    await harness?.close();
  });

  it('Runなしの保存済みSIFを検索し、選択したArtifactのSHAとsizeを取得できる', async () => {
    const fixture = await projectFixture(harness);
    const sif = await uploadProjectArtifact(harness, {
      basePath: fixture.basePath,
      cookie: fixture.editor.cookie,
      path: 'containers/inference.sif',
    });
    await uploadProjectArtifact(harness, {
      basePath: fixture.basePath,
      cookie: fixture.editor.cookie,
      path: 'models/weights.bin',
    });
    const catalog = await entity<{ items: Artifact[] }>(
      await request(harness.app, `${fixture.basePath}/artifacts?query=.sif&limit=1`, {
        cookie: fixture.viewer.cookie,
      }),
      200,
    );
    expect(catalog.items).toEqual([sif]);
    expect(sif.runId).toBeNull();
    const metadata = await entity<Artifact>(
      await request(harness.app, `${fixture.basePath}/artifacts/${sif.id}`, {
        cookie: fixture.viewer.cookie,
      }),
      200,
    );
    expect(metadata.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(metadata.size).toBe(Buffer.byteLength('verification fixture'));
    expect(metadata.id).toBe(sif.id);
    expect(
      (await request(harness.app, `${fixture.basePath}/artifacts?limit=501`, {
        cookie: fixture.viewer.cookie,
      })).status,
    ).toBe(422);
  });

  it('権限のないProjectの一覧とmetadata、および別ProjectのArtifact IDを拒否する', async () => {
    const fixture = await projectFixture(harness);
    const other = await entity<Project>(
      await request(harness.app, '/api/projects', {
        method: 'POST',
        cookie: fixture.administrator.cookie,
        body: { name: 'Other Project', visibility: 'private' },
      }),
    );
    const otherArtifact = await uploadProjectArtifact(harness, {
      basePath: `/api/projects/${other.id}`,
      cookie: fixture.administrator.cookie,
      path: 'containers/private.sif',
    });
    expect(
      (await request(harness.app, `${fixture.basePath}/artifacts`, {
        cookie: fixture.outsider.cookie,
      })).status,
    ).toBe(403);
    expect(
      (await request(harness.app, `/api/projects/${other.id}/artifacts/${otherArtifact.id}`, {
        cookie: fixture.viewer.cookie,
      })).status,
    ).toBe(403);
    expect(
      (await request(harness.app, `${fixture.basePath}/artifacts/${otherArtifact.id}`, {
        cookie: fixture.viewer.cookie,
      })).status,
    ).toBe(404);
  });
});
