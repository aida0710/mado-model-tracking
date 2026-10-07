import type { PluginDataset, PluginEvent, PluginManifest } from '@mmt/contracts';

// A failed integration must not hold an API request or the outbox worker indefinitely.
const PLUGIN_DEADLINE_MS = 5000;
const MAX_PLUGIN_RESPONSE_BYTES = 1024 * 1024;
export class PluginProtocolError extends Error {
  constructor(message = 'Plugin returned an invalid response') {
    super(message);
    this.name = 'PluginProtocolError';
  }
}
export interface PluginClient {
  manifest(): Promise<PluginManifest>;
  searchDatasets(query: string): Promise<{ items: PluginDataset[] }>;
  metrics(): Promise<{ prometheus: string }>;
  sendEvent(event: PluginEvent): Promise<void>;
}
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
export function parsePluginManifest(value: unknown): PluginManifest {
  if (
    !isObject(value) ||
    !isString(value.id) ||
    !isString(value.name) ||
    !isString(value.version) ||
    value.protocolVersion !== '1.0' ||
    !Array.isArray(value.capabilities) ||
    !value.capabilities.every(isString)
  )
    throw new PluginProtocolError('Plugin protocol version or manifest is unsupported');
  return value as unknown as PluginManifest;
}
function parseDatasets(value: unknown): { items: PluginDataset[] } {
  if (!isObject(value) || !Array.isArray(value.items) || value.items.length > 1000)
    throw new PluginProtocolError();
  for (const dataset of value.items) {
    if (
      !isObject(dataset) ||
      !['externalId', 'namespace', 'name', 'version', 'uri', 'digest'].every((key) =>
        isString(dataset[key]),
      ) ||
      !isObject(dataset.schema) ||
      !isObject(dataset.metadata)
    )
      throw new PluginProtocolError('Plugin dataset version is incomplete');
  }
  return value as unknown as { items: PluginDataset[] };
}
export function createPluginClient({
  baseUrl,
  token,
  fetcher = fetch,
}: {
  baseUrl: string;
  token: string;
  fetcher?: typeof fetch;
}): PluginClient {
  const base = new URL(baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
  if (
    !['http:', 'https:'].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.hash ||
    base.search
  )
    throw new PluginProtocolError('Invalid Plugin service URL');
  async function requestText(endpoint: string, payload?: unknown): Promise<string> {
    let response: Response;
    try {
      response = await fetcher(new URL(endpoint, base), {
        method: payload === undefined ? 'GET' : 'POST',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
          ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
        signal: AbortSignal.timeout(PLUGIN_DEADLINE_MS),
        redirect: 'error',
      });
    } catch {
      throw new PluginProtocolError('Plugin service is unavailable');
    }
    if (!response.ok)
      throw new PluginProtocolError(`Plugin service returned HTTP ${response.status}`);
    if (!response.body) throw new PluginProtocolError();
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > MAX_PLUGIN_RESPONSE_BYTES)
          throw new PluginProtocolError('Plugin response is too large');
        chunks.push(part.value);
      }
      return Buffer.concat(chunks).toString('utf8');
    } catch (error) {
      if (error instanceof PluginProtocolError) throw error;
      throw new PluginProtocolError();
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  }
  async function request(endpoint: string, payload?: unknown): Promise<unknown> {
    try {
      return JSON.parse(await requestText(endpoint, payload)) as unknown;
    } catch (error) {
      if (error instanceof PluginProtocolError) throw error;
      throw new PluginProtocolError();
    }
  }
  return {
    manifest: async () => parsePluginManifest(await request('manifest')),
    searchDatasets: async (query) => parseDatasets(await request('datasets/search', { query })),
    metrics: async () => ({ prometheus: await requestText('metrics') }),
    sendEvent: async (event) => {
      const acknowledgment = await request('events', event);
      if (!isObject(acknowledgment) || acknowledgment.accepted !== true)
        throw new PluginProtocolError('Plugin did not acknowledge the event');
    },
  };
}
