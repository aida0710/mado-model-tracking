import type { ComputeTarget, ExecutionRuntime } from '@mmt/contracts';
import { DomainError } from '../domain/errors.js';

// Docker Hub serves images named without a registry (ubuntu, pytorch/pytorch).
const DOCKER_HUB_REGISTRY = 'registry-1.docker.io';
const MANIFEST_MEDIA_TYPES = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
];
const INDEX_MEDIA_TYPES = new Set(MANIFEST_MEDIA_TYPES.slice(0, 2));
// A registry that does not answer within this time is reported as unavailable.
const REGISTRY_TIMEOUT_MS = 10_000;
// Images are pinned to a digest, so a result never changes; this bounds the memory it takes.
const CACHE_LIMIT = 1000;

export interface ImagePlatform {
  os: string;
  architecture: string;
}

export interface ImagePlatformChecker {
  /** Refuses a docker image that is not built for the target's CPU (no-op when the check is off). */
  assertRunsOn(runtime: ExecutionRuntime, target: Pick<ComputeTarget, 'cpuArch'>): Promise<void>;
}

/** MMT_IMAGE_PLATFORM_CHECK=off: images are not looked up. */
export const NO_IMAGE_PLATFORM_CHECK: ImagePlatformChecker = { assertRunsOn: async () => undefined };

interface ImageReference {
  registry: string;
  repository: string;
  digest: string;
}

export function parseImageReference(image: string): ImageReference {
  const [name, digest] = image.split('@') as [string, string];
  const withoutTag = name.replace(/:[^/:]+$/, '');
  const [first, ...rest] = withoutTag.split('/');
  const hasRegistry = rest.length > 0 && (first!.includes('.') || first!.includes(':') || first === 'localhost');
  if (hasRegistry) return { registry: first!, repository: rest.join('/'), digest };
  const repository = rest.length ? withoutTag : `library/${withoutTag}`;
  return { registry: DOCKER_HUB_REGISTRY, repository, digest };
}

function unavailable(): never {
  throw new DomainError(
    503,
    'imageのregistryに問い合わせられないため、CPUの対応を確認できません',
    'image_registry_unavailable',
  );
}

// `Bearer realm="https://auth.docker.io/token",service="registry.docker.io",scope="..."`.
function bearerChallenge(header: string | null): Record<string, string> | null {
  if (!header || !/^Bearer\s/i.test(header)) return null;
  const parameters: Record<string, string> = {};
  for (const [, key, value] of header.matchAll(/(\w+)="([^"]*)"/g)) parameters[key!] = value!;
  return parameters.realm ? parameters : null;
}

/**
 * Reads an image's platforms from its registry (Docker Registry HTTP API v2): the platforms of an
 * index, or the os and architecture of a single manifest's config. Registries that ask for a
 * token (Docker Hub, Forgejo, GHCR) get one, with MMT_REGISTRY_USERNAME/PASSWORD when set.
 */
export class RegistryImagePlatformChecker implements ImagePlatformChecker {
  private readonly cache = new Map<string, ImagePlatform[]>();
  private readonly fetcher: typeof fetch;
  private readonly credentials: { username: string; password: string } | null;
  constructor(options: {
    credentials: { username: string; password: string } | null;
    fetcher?: typeof fetch;
  }) {
    this.credentials = options.credentials;
    this.fetcher = options.fetcher ?? fetch;
  }

  async assertRunsOn(
    runtime: ExecutionRuntime,
    target: Pick<ComputeTarget, 'cpuArch'>,
  ): Promise<void> {
    if (runtime.kind !== 'docker') return;
    const platforms = await this.platformsOf(runtime.image);
    if (!platforms.some((platform) => platform.os === 'linux' && platform.architecture === target.cpuArch))
      throw new DomainError(
        422,
        `imageは${target.cpuArch}向けに作られていません（${platforms.map((platform) => `${platform.os}/${platform.architecture}`).join(', ') || '不明'}）`,
        'image_platform_mismatch',
      );
  }

  async platformsOf(image: string): Promise<ImagePlatform[]> {
    const cached = this.cache.get(image);
    if (cached) return cached;
    const reference = parseImageReference(image);
    const manifest = (await this.getJson(reference, `manifests/${reference.digest}`)) as {
      mediaType?: string;
      manifests?: { platform?: ImagePlatform }[];
      config?: { digest?: string };
    };
    let platforms: ImagePlatform[];
    if (manifest.manifests && (!manifest.mediaType || INDEX_MEDIA_TYPES.has(manifest.mediaType)))
      platforms = manifest.manifests.flatMap((entry) => (entry.platform ? [entry.platform] : []));
    else if (manifest.config?.digest) {
      const config = (await this.getJson(reference, `blobs/${manifest.config.digest}`)) as Partial<ImagePlatform>;
      platforms = config.os && config.architecture ? [{ os: config.os, architecture: config.architecture }] : [];
    } else platforms = [];
    if (this.cache.size >= CACHE_LIMIT) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(image, platforms);
    return platforms;
  }

  private async getJson(reference: ImageReference, path: string): Promise<unknown> {
    const url = `https://${reference.registry}/v2/${reference.repository}/${path}`;
    const headers: Record<string, string> = { Accept: MANIFEST_MEDIA_TYPES.join(', ') };
    let response = await this.request(url, headers);
    if (response.status === 401) {
      const authorization = await this.authorize(response, reference);
      if (authorization) response = await this.request(url, { ...headers, Authorization: authorization });
    }
    if (!response.ok) unavailable();
    try {
      return await response.json();
    } catch {
      unavailable();
    }
  }

  // Basic for registries that ask for it; otherwise the token service the challenge names.
  private async authorize(response: Response, reference: ImageReference): Promise<string | null> {
    const challenge = response.headers.get('www-authenticate');
    const basic = this.credentials
      ? `Basic ${Buffer.from(`${this.credentials.username}:${this.credentials.password}`).toString('base64')}`
      : null;
    if (challenge && /^Basic\s/i.test(challenge)) return basic;
    const bearer = bearerChallenge(challenge);
    if (!bearer) return null;
    const tokenUrl = new URL(bearer.realm!);
    if (bearer.service) tokenUrl.searchParams.set('service', bearer.service);
    tokenUrl.searchParams.set('scope', bearer.scope ?? `repository:${reference.repository}:pull`);
    const tokenResponse = await this.request(tokenUrl.toString(), basic ? { Authorization: basic } : {});
    if (!tokenResponse.ok) unavailable();
    const issued = (await tokenResponse.json().catch(() => ({}))) as {
      token?: string;
      access_token?: string;
    };
    const token = issued.token ?? issued.access_token;
    return token ? `Bearer ${token}` : null;
  }

  private async request(url: string, headers: Record<string, string>): Promise<Response> {
    try {
      return await this.fetcher(url, { headers, signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS) });
    } catch {
      unavailable();
    }
  }
}
