import { describe, expect, it } from 'vitest';
import { createPluginClient } from './pluginClient.js';

describe('plugin HTTP contract', () => {
  it('authenticates its requests and retains the configured service path', async () => {
    let requestedUrl = '';
    let authorization = '';
    const fetcher: typeof fetch = async (input, init) => {
      requestedUrl = String(input);
      authorization = (init?.headers as Record<string, string>).Authorization ?? '';
      return Response.json({
        id: 'mado',
        name: 'Mado',
        version: '0.1.0',
        protocolVersion: '1.0',
        capabilities: ['datasets:search'],
      });
    };
    const plugin = createPluginClient({
      baseUrl: 'http://localhost:4190/plugin',
      token: 'unit-test-token',
      fetcher,
    });
    expect((await plugin.manifest()).id).toBe('mado');
    expect(requestedUrl).toBe('http://localhost:4190/plugin/manifest');
    expect(authorization).toBe('Bearer unit-test-token');
  });
  it('refuses an incompatible manifest or a dataset without a pinned version', async () => {
    const plugin = createPluginClient({
      baseUrl: 'http://localhost:4190',
      token: '',
      fetcher: async () => Response.json({ id: 'mado', protocolVersion: '2.0' }),
    });
    await expect(plugin.manifest()).rejects.toThrow('unsupported');
    const datasets = createPluginClient({
      baseUrl: 'http://localhost:4190',
      token: '',
      fetcher: async () => Response.json({ items: [{ name: 'unversioned' }] }),
    });
    await expect(datasets.searchDatasets('')).rejects.toThrow('incomplete');
  });
  it('reports an integration failure without exposing its credential', async () => {
    const plugin = createPluginClient({
      baseUrl: 'http://localhost:4190',
      token: 'must-not-appear',
      fetcher: async () => {
        throw new Error('must-not-appear');
      },
    });
    await expect(plugin.manifest()).rejects.toThrow('Plugin service is unavailable');
  });
});
