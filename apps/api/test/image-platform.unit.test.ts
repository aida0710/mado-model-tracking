import { describe, expect, it } from 'vitest';
import { DomainError } from '../src/domain/errors.js';
import {
  parseImageReference,
  RegistryImagePlatformChecker,
} from '../src/services/imagePlatformChecker.js';

const DIGEST = `sha256:${'b'.repeat(64)}`;
const CONFIG_DIGEST = `sha256:${'c'.repeat(64)}`;

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
}

async function errorCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error instanceof DomainError ? error.code : 'unexpected';
  }
}

describe('imageのCPU照合', () => {
  it('registryのない名前はDocker Hubのlibraryとして読む', () => {
    expect(parseImageReference(`ubuntu@${DIGEST}`)).toEqual({
      registry: 'registry-1.docker.io',
      repository: 'library/ubuntu',
      digest: DIGEST,
    });
    expect(parseImageReference(`git.lab.example:3000/team/infer:v1@${DIGEST}`)).toEqual({
      registry: 'git.lab.example:3000',
      repository: 'team/infer',
      digest: DIGEST,
    });
  });

  it('複数CPUのindexからplatformを読み、tokenを求めるregistryにはtokenを取りに行く', async () => {
    const requested: string[] = [];
    const fetcher = (async (url: string | URL, init?: RequestInit) => {
      const target = url.toString();
      requested.push(target);
      if (target.startsWith('https://auth.example/token')) return json({ token: 'issued' });
      const authorization = (init?.headers as Record<string, string>).Authorization;
      if (authorization !== 'Bearer issued')
        return new Response('', {
          status: 401,
          headers: { 'WWW-Authenticate': 'Bearer realm="https://auth.example/token",service="registry"' },
        });
      return json({
        mediaType: 'application/vnd.oci.image.index.v1+json',
        manifests: [
          { platform: { os: 'linux', architecture: 'amd64' } },
          { platform: { os: 'linux', architecture: 'arm64' } },
        ],
      });
    }) as typeof fetch;
    const checker = new RegistryImagePlatformChecker({ credentials: null, fetcher });
    const runtime = { kind: 'docker' as const, image: `registry.example/team/infer@${DIGEST}` };
    await checker.assertRunsOn(runtime, { cpuArch: 'arm64' });
    expect(requested.some((url) => url.includes('scope=repository%3Ateam%2Finfer%3Apull'))).toBe(true);
    // A pinned image is looked up once.
    const before = requested.length;
    await checker.assertRunsOn(runtime, { cpuArch: 'amd64' });
    expect(requested).toHaveLength(before);
  });

  it('1つのmanifestはconfigのarchitectureで照合し、合わなければ422にする', async () => {
    const fetcher = (async (url: string | URL) =>
      url.toString().includes('/blobs/')
        ? json({ os: 'linux', architecture: 'amd64' })
        : json({
            mediaType: 'application/vnd.oci.image.manifest.v1+json',
            config: { digest: CONFIG_DIGEST },
          })) as typeof fetch;
    const checker = new RegistryImagePlatformChecker({ credentials: null, fetcher });
    const runtime = { kind: 'docker' as const, image: `registry.example/team/infer@${DIGEST}` };
    expect(await errorCode(checker.assertRunsOn(runtime, { cpuArch: 'arm64' }))).toBe(
      'image_platform_mismatch',
    );
  });

  it('registryに届かなければ503 image_registry_unavailable', async () => {
    const fetcher = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    const checker = new RegistryImagePlatformChecker({ credentials: null, fetcher });
    const runtime = { kind: 'docker' as const, image: `registry.example/team/infer@${DIGEST}` };
    expect(await errorCode(checker.assertRunsOn(runtime, { cpuArch: 'amd64' }))).toBe(
      'image_registry_unavailable',
    );
  });
});
