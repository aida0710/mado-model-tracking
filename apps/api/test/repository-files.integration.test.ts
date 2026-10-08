import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApplication } from '../src/app.js';
import { createHarness, entity, request, testDatabaseUrl, type Harness } from './harness.js';
import { projectFixture } from './fixtures.js';

const repository = { url: 'https://example.test/repo.git', commit: 'a'.repeat(40) };

describe.skipIf(!testDatabaseUrl)('repository-filesの認可（独立PostgreSQL）', () => {
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

  it('editorのregistry:writeだけでpreviewでき、viewer/outsider/readだけのtokenは取得前に拒否する', async () => {
    const fixture = await projectFixture(harness);
    const reader = vi.fn(async () => ({
      commit: repository.commit,
      files: { 'main.py': 'pass' },
      omittedPaths: ['binary.bin'],
    }));
    const { app } = createApplication({
      config: harness.config,
      database: harness.database,
      stores: harness.stores,
      repositoryReader: reader,
    });
    const endpoint = `${fixture.basePath}/repository-files`;
    for (const cookie of [fixture.viewer.cookie, fixture.outsider.cookie])
      expect(
        (await request(app, endpoint, { method: 'POST', cookie, body: repository })).status,
      ).toBe(403);
    for (const scopes of [['read'], ['registry:write']]) {
      const token = await entity<{ token: string }>(
        await request(app, '/api/tokens', {
          method: 'POST',
          cookie: fixture.administrator.cookie,
          body: { name: scopes[0], kind: 'service', projectId: fixture.project.id, scopes },
        }),
      );
      expect(
        (await request(app, endpoint, { method: 'POST', token: token.token, body: repository }))
          .status,
      ).toBe(scopes[0] === 'read' ? 403 : 200);
    }
    const viewed = await entity(
      await request(app, endpoint, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: repository,
      }),
      200,
    );
    expect(viewed).toEqual({
      commit: repository.commit,
      files: { 'main.py': 'pass' },
      omittedPaths: ['binary.bin'],
    });
    expect(reader).toHaveBeenCalledTimes(2);
    const invalid = await request(app, endpoint, {
      method: 'POST',
      cookie: fixture.editor.cookie,
      body: { ...repository, url: 'https://fixture:never-expose@example.test/' },
    });
    expect(invalid.status).toBe(422);
    expect(await invalid.text()).not.toContain('never-expose');
    expect(reader).toHaveBeenCalledTimes(2);
  });
});
