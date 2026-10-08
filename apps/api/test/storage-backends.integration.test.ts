import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  Artifact,
  Project,
  StorageBackend,
  StorageBackendChoices,
  StorageTestResult,
} from '@mmt/contracts';
import { createApplication } from '../src/app.js';
import { parseSecretKey } from '../src/security/secretEncryption.js';
import { createHarness, entity, login, request, testDatabaseUrl, type Harness } from './harness.js';

// Only identifies this test's ciphertext and log checks; it authenticates to nothing real.
const SECRET_ACCESS_KEY = `test-secret-${randomBytes(12).toString('hex')}`;
// Nothing listens on this loopback port, so the connection test must fail at its first step.
const UNREACHABLE_ENDPOINT = 'http://127.0.0.1:47119';
const s3Endpoint = process.env.MMT_TEST_S3_ENDPOINT;

describe.skipIf(!testDatabaseUrl)('Artifact保存先の全体設定（独立PostgreSQL）', () => {
  let harness: Harness;
  let app: ReturnType<typeof createApplication>;
  let storageRoot: string;
  let admin: { cookie: string; userId: string };
  let member: { cookie: string; userId: string };
  const logged: string[] = [];

  beforeAll(async () => {
    harness = await createHarness();
    storageRoot = await mkdtemp(path.join(tmpdir(), 'mmt-storage-backends-'));
    app = createApplication({
      config: {
        ...harness.config,
        storageSecretKey: parseSecretKey(randomBytes(32).toString('base64')),
      },
      database: harness.database,
      stores: harness.stores,
    });
  });
  beforeEach(async () => {
    await harness.reset();
    // reset() truncates storage_backends through the users foreign key.
    await app.services.artifactStores.reload();
    admin = await login(harness);
    member = await login(harness, 'member@localhost');
    for (const method of ['log', 'error', 'warn', 'info'] as const)
      vi.spyOn(console, method).mockImplementation((...values: unknown[]) => {
        logged.push(values.map(String).join(' '));
      });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    await harness?.close();
    if (storageRoot) await rm(storageRoot, { recursive: true, force: true });
  });

  function call(endpoint: string, options: Parameters<typeof request>[2] = {}): Promise<Response> {
    return request(app.app, endpoint, { cookie: admin.cookie, ...options });
  }
  async function createFilesystemBackend(
    name: string,
  ): Promise<{ backend: StorageBackend; root: string }> {
    const root = path.join(storageRoot, `${name}-${randomUUID()}`);
    const backend = await entity<StorageBackend>(
      await call('/api/admin/storage-backends', {
        method: 'POST',
        body: { name, kind: 'filesystem', rootPath: root },
      }),
    );
    return { backend, root };
  }
  async function createProject(artifactBackend?: string): Promise<Project> {
    return entity<Project>(
      await call('/api/projects', {
        method: 'POST',
        body: { name: `Project ${randomUUID()}`, ...(artifactBackend ? { artifactBackend } : {}) },
      }),
    );
  }
  async function uploadArtifact(project: Project, content: string): Promise<Response> {
    return call(`/api/projects/${project.id}/artifacts?path=data/${randomUUID()}.bin`, {
      method: 'PUT',
      binary: content,
      headers: { 'Content-Type': 'application/octet-stream' },
    });
  }
  async function readArtifact(project: Project, artifact: Artifact): Promise<string> {
    const response = await call(`/api/projects/${project.id}/artifacts/${artifact.id}/content`);
    expect(response.status).toBe(200);
    return response.text();
  }
  async function setDefaultBackend(defaultBackend: string): Promise<Response> {
    return call('/api/admin/storage-settings', { method: 'PUT', body: { defaultBackend } });
  }

  it('全体管理者でない利用者とProject限定tokenは保存先を見ることも変えることもできない', async () => {
    const project = await createProject();
    const scopedToken = await entity<{ token: string }>(
      await call('/api/tokens', {
        method: 'POST',
        body: { name: 'scoped admin', kind: 'personal', projectId: project.id, scopes: ['admin'] },
      }),
    );
    for (const credential of [{ cookie: member.cookie }, { token: scopedToken.token }]) {
      const asOther = { cookie: undefined, ...credential };
      expect((await call('/api/admin/storage-backends', asOther)).status).toBe(403);
      expect(
        (
          await call('/api/admin/storage-backends', {
            ...asOther,
            method: 'POST',
            body: { name: 'denied', kind: 'filesystem', rootPath: path.join(storageRoot, 'x') },
          })
        ).status,
      ).toBe(403);
      expect((await call('/api/admin/storage-settings', asOther)).status).toBe(403);
      expect(
        (
          await call('/api/admin/storage-settings', {
            ...asOther,
            method: 'PUT',
            body: { defaultBackend: 'filesystem' },
          })
        ).status,
      ).toBe(403);
    }
    const denied = await harness.database.query(
      "SELECT count(*)::int AS count FROM audit_events WHERE action='storage.backend.create' AND outcome='denied'",
    );
    expect(denied.rows[0].count).toBe(2);
  });

  it('S3 backendのsecretは暗号化して保存し、応答・ログ・監査に出さない', async () => {
    const created = await entity<StorageBackend>(
      await call('/api/admin/storage-backends', {
        method: 'POST',
        body: {
          name: 'remote',
          kind: 's3',
          endpoint: UNREACHABLE_ENDPOINT,
          bucket: 'mmt-remote',
          prefix: '/team/artifacts/',
          pathStyle: true,
          accessKeyId: 'remote-access-key',
          secretAccessKey: SECRET_ACCESS_KEY,
        },
      }),
    );
    expect(created).toMatchObject({
      name: 'remote',
      kind: 's3',
      source: 'database',
      prefix: 'team/artifacts',
      signatureVersion: 'v4',
      checksumMode: 'when_required',
      tlsVerify: true,
      accessKeyId: 'remote-access-key',
      secretConfigured: true,
      caBundleConfigured: false,
      enabled: true,
    });
    const listing = await call('/api/admin/storage-backends');
    const listingText = await listing.text();
    expect(listingText).not.toContain(SECRET_ACCESS_KEY);
    const items = (JSON.parse(listingText) as { items: StorageBackend[] }).items;
    expect(items.map((item) => [item.name, item.source])).toEqual([
      ['filesystem', 'environment'],
      ['remote', 'database'],
    ]);
    // Updating other fields without the secret keeps the stored one.
    const updated = await entity<StorageBackend>(
      await call('/api/admin/storage-backends/remote', {
        method: 'PATCH',
        body: { region: 'ap-northeast-1' },
      }),
      200,
    );
    expect(updated).toMatchObject({ region: 'ap-northeast-1', secretConfigured: true });
    const tested = await entity<StorageTestResult>(
      await call('/api/admin/storage-backends/remote/test', { method: 'POST' }),
      200,
    );
    expect(tested.steps.map((step) => [step.name, step.ok])).toEqual([
      ['put', false],
      ['get', false],
      ['range', false],
      ['delete', false],
    ]);
    expect(JSON.stringify(tested)).not.toContain(SECRET_ACCESS_KEY);
    expect(JSON.stringify(tested)).not.toContain('remote-access-key');

    const stored = await harness.database.query(
      "SELECT secret_encrypted, secret_key_id FROM storage_backends WHERE name='remote'",
    );
    const ciphertext = stored.rows[0].secret_encrypted as Buffer;
    expect(ciphertext.includes(Buffer.from(SECRET_ACCESS_KEY))).toBe(false);
    expect(stored.rows[0].secret_key_id).toMatch(/^[0-9a-f]{16}$/);
    const audit = await harness.database.query(
      "SELECT action, details::text AS details FROM audit_events WHERE action LIKE 'storage.%' ORDER BY occurred_at",
    );
    expect(audit.rows.map((row) => row.action)).toEqual([
      'storage.backend.create',
      'storage.backend.update',
      'storage.backend.test',
    ]);
    for (const row of audit.rows) {
      expect(row.details).not.toContain(SECRET_ACCESS_KEY);
      expect(row.details).not.toContain('remote-access-key');
    }
    expect(logged.join('\n')).not.toContain(SECRET_ACCESS_KEY);
  });

  it('鍵が未設定のサーバーではsecret付きbackendを作れない', async () => {
    const keyless = createApplication({
      config: harness.config,
      database: harness.database,
      stores: harness.stores,
    });
    const response = await request(keyless.app, '/api/admin/storage-backends', {
      method: 'POST',
      cookie: admin.cookie,
      body: {
        name: 'keyless',
        kind: 's3',
        bucket: 'mmt-keyless',
        accessKeyId: 'keyless-access-key',
        secretAccessKey: SECRET_ACCESS_KEY,
      },
    });
    expect(response.status).toBe(422);
    expect(((await response.json()) as { code: string }).code).toBe('storage_secret_key_missing');
  });

  it('filesystem backendの接続テストは書き込み・読み出し・Range・削除の段階ごとに成功を返す', async () => {
    const { root } = await createFilesystemBackend('local-archive');
    const tested = await entity<StorageTestResult>(
      await call('/api/admin/storage-backends/local-archive/test', { method: 'POST' }),
      200,
    );
    expect(tested.steps).toEqual([
      { name: 'put', ok: true },
      { name: 'get', ok: true },
      { name: 'range', ok: true },
      { name: 'delete', ok: true },
    ]);
    await expect(stat(path.join(root, 'mmt-connection-test'))).resolves.toBeDefined();
  });

  it('既定の保存先を切り替えると新しいProjectは新backendへ保存し、既存Artifactは元のbackendから読める', async () => {
    const oldProject = await createProject();
    const oldArtifact = await entity<Artifact>(await uploadArtifact(oldProject, 'before switch'));
    expect(oldArtifact.backend).toBe('filesystem');

    const { root } = await createFilesystemBackend('archive');
    expect((await setDefaultBackend('archive')).status).toBe(200);
    expect(await entity(await call('/api/admin/storage-settings'), 200)).toEqual({
      defaultBackend: 'archive',
    });
    const choices = await entity<StorageBackendChoices>(
      await request(app.app, '/api/storage/backends', { cookie: member.cookie }),
      200,
    );
    expect(choices).toEqual({ items: ['filesystem', 'archive'], defaultBackend: 'archive' });

    // The Web form preselects defaultBackend; the API stores what the form sends.
    const newProject = await createProject(choices.defaultBackend);
    const newArtifact = await entity<Artifact>(await uploadArtifact(newProject, 'after switch'));
    expect(newArtifact.backend).toBe('archive');
    await expect(stat(path.join(root, newArtifact.storageKey))).resolves.toBeDefined();
    expect(await readArtifact(newProject, newArtifact)).toBe('after switch');

    // Moving the old Project to the new backend affects new Artifacts only.
    await entity(
      await call(`/api/projects/${oldProject.id}`, {
        method: 'PATCH',
        body: { artifactBackend: 'archive' },
      }),
      200,
    );
    expect(await readArtifact(oldProject, oldArtifact)).toBe('before switch');
    const settingsAudit = await harness.database.query(
      "SELECT details FROM audit_events WHERE action='storage.settings.update' AND outcome='success'",
    );
    expect(settingsAudit.rows[0].details).toMatchObject({
      defaultBackend: 'archive',
      previousDefaultBackend: 'filesystem',
    });
  });

  it('Artifactが参照するbackendは保存場所を変えられず、参照のないbackendは変えられる', async () => {
    const { root } = await createFilesystemBackend('referenced');
    const project = await createProject('referenced');
    await entity<Artifact>(await uploadArtifact(project, 'kept'));
    const moved = await call('/api/admin/storage-backends/referenced', {
      method: 'PATCH',
      body: { rootPath: `${root}-moved` },
    });
    expect(moved.status).toBe(409);
    expect(((await moved.json()) as { code: string }).code).toBe('storage_backend_in_use');
    expect(
      (
        await call('/api/admin/storage-backends/referenced', {
          method: 'PATCH',
          body: { kind: 's3', bucket: 'mmt-other' },
        })
      ).status,
    ).toBe(409);

    await entity<StorageBackend>(
      await call('/api/admin/storage-backends', {
        method: 'POST',
        body: { name: 'unused', kind: 's3', bucket: 'mmt-unused' },
      }),
    );
    expect(
      await entity<StorageBackend>(
        await call('/api/admin/storage-backends/unused', {
          method: 'PATCH',
          body: { bucket: 'mmt-renamed' },
        }),
        200,
      ),
    ).toMatchObject({ bucket: 'mmt-renamed' });
  });

  it('無効にしたbackendは既存Artifactを読めるが、新しいArtifactを書けず選択肢からも消える', async () => {
    await createFilesystemBackend('retiring');
    const project = await createProject('retiring');
    const artifact = await entity<Artifact>(await uploadArtifact(project, 'written before'));

    expect((await setDefaultBackend('retiring')).status).toBe(200);
    const refused = await call('/api/admin/storage-backends/retiring', {
      method: 'PATCH',
      body: { enabled: false },
    });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { code: string }).code).toBe('storage_backend_is_default');
    expect((await setDefaultBackend('filesystem')).status).toBe(200);
    expect(
      await entity<StorageBackend>(
        await call('/api/admin/storage-backends/retiring', {
          method: 'PATCH',
          body: { enabled: false },
        }),
        200,
      ),
    ).toMatchObject({ enabled: false });

    expect(await readArtifact(project, artifact)).toBe('written before');
    const write = await uploadArtifact(project, 'written after');
    expect(write.status).toBe(409);
    expect(((await write.json()) as { code: string }).code).toBe('storage_backend_disabled');
    const upload = await call(`/api/projects/${project.id}/artifact-uploads`, {
      method: 'POST',
      body: { path: 'data/large.bin', expectedSize: 10 * 1024 * 1024, partSize: 5 * 1024 * 1024 },
    });
    expect(upload.status).toBe(409);
    const choices = await entity<StorageBackendChoices>(await call('/api/storage/backends'), 200);
    expect(choices.items).not.toContain('retiring');
    expect((await createProjectResponse('retiring')).status).toBe(422);
    expect((await setDefaultBackend('retiring')).status).toBe(422);
  });

  async function createProjectResponse(artifactBackend: string): Promise<Response> {
    return call('/api/projects', {
      method: 'POST',
      body: { name: `Project ${randomUUID()}`, artifactBackend },
    });
  }

  it('環境変数由来のbackendは変更できず、同じ名前でも作れない', async () => {
    const patched = await call('/api/admin/storage-backends/filesystem', {
      method: 'PATCH',
      body: { enabled: false },
    });
    expect(patched.status).toBe(409);
    expect(((await patched.json()) as { code: string }).code).toBe('storage_backend_read_only');
    for (const name of ['filesystem', 's3']) {
      const created = await call('/api/admin/storage-backends', {
        method: 'POST',
        body: { name, kind: 'filesystem', rootPath: path.join(storageRoot, name) },
      });
      expect(created.status).toBe(409);
      expect(((await created.json()) as { code: string }).code).toBe('storage_backend_exists');
    }
    const tested = await entity<StorageTestResult>(
      await call('/api/admin/storage-backends/filesystem/test', { method: 'POST' }),
      200,
    );
    expect(tested.steps.every((step) => step.ok)).toBe(true);
  });

  it('署名v2・不正な名前・不正な設定は422で拒否する', async () => {
    const cases: [Record<string, unknown>, string][] = [
      [
        { name: 'legacy', kind: 's3', bucket: 'mmt-legacy', signatureVersion: 'v2' },
        'storage_signature_unsupported',
      ],
      [
        { name: 'Bad_Name', kind: 'filesystem', rootPath: '/srv/mmt' },
        'invalid_storage_backend_name',
      ],
      [
        { name: 'relative', kind: 'filesystem', rootPath: 'var/artifacts' },
        'invalid_storage_backend_config',
      ],
      [
        { name: 'small-parts', kind: 's3', bucket: 'mmt-small', multipartPartSizeBytes: 1024 },
        'invalid_storage_backend_config',
      ],
      [
        { name: 'half-key', kind: 's3', bucket: 'mmt-half', accessKeyId: 'only-id' },
        'storage_credentials_incomplete',
      ],
    ];
    for (const [body, code] of cases) {
      const response = await call('/api/admin/storage-backends', { method: 'POST', body });
      expect(response.status, code).toBe(422);
      expect(((await response.json()) as { code: string }).code).toBe(code);
    }
    expect(
      (
        await call('/api/admin/storage-backends', {
          method: 'POST',
          body: { name: 'unknown-field', kind: 'filesystem', rootPath: '/srv/x', secret: 'x' },
        })
      ).status,
    ).toBe(422);
  });

  describe.skipIf(!s3Endpoint)('S3 emulator', () => {
    const bucket = `mmt-registry-${randomUUID()}`;
    beforeAll(async () => {
      const client = new S3Client({
        endpoint: s3Endpoint,
        region: 'us-east-1',
        forcePathStyle: true,
        // These values authenticate only to the isolated emulator, never to real storage.
        credentials: { accessKeyId: 'testing', secretAccessKey: 'testing' },
      });
      await client.send(new CreateBucketCommand({ Bucket: bucket }));
      client.destroy();
    });

    it('S3 backendを作って接続テストが通り、既定にすると新しいArtifactがS3へ保存される', async () => {
      const oldProject = await createProject();
      const oldArtifact = await entity<Artifact>(await uploadArtifact(oldProject, 'on filesystem'));
      await entity<StorageBackend>(
        await call('/api/admin/storage-backends', {
          method: 'POST',
          body: {
            name: 'moto',
            kind: 's3',
            endpoint: s3Endpoint,
            bucket,
            prefix: 'mmt',
            pathStyle: true,
            accessKeyId: 'testing',
            secretAccessKey: SECRET_ACCESS_KEY,
          },
        }),
      );
      const tested = await entity<StorageTestResult>(
        await call('/api/admin/storage-backends/moto/test', { method: 'POST' }),
        200,
      );
      expect(tested.steps).toEqual([
        { name: 'put', ok: true },
        { name: 'get', ok: true },
        { name: 'range', ok: true },
        { name: 'delete', ok: true },
      ]);
      expect((await setDefaultBackend('moto')).status).toBe(200);
      const { defaultBackend } = await entity<StorageBackendChoices>(
        await call('/api/storage/backends'),
        200,
      );
      const project = await createProject(defaultBackend);
      const artifact = await entity<Artifact>(await uploadArtifact(project, 'on s3'));
      expect(artifact.backend).toBe('moto');
      expect(await readArtifact(project, artifact)).toBe('on s3');
      expect(await readArtifact(oldProject, oldArtifact)).toBe('on filesystem');

      const moved = await call('/api/admin/storage-backends/moto', {
        method: 'PATCH',
        body: { bucket: `${bucket}-other` },
      });
      expect(moved.status).toBe(409);
      // Non-location settings may change; the replaced store keeps reading the same objects.
      await entity(
        await call('/api/admin/storage-backends/moto', {
          method: 'PATCH',
          body: { checksumMode: 'when_supported', multipartPartSizeBytes: 16 * 1024 * 1024 },
        }),
        200,
      );
      expect(await readArtifact(project, artifact)).toBe('on s3');
      expect(logged.join('\n')).not.toContain(SECRET_ACCESS_KEY);
    });
  });
});
