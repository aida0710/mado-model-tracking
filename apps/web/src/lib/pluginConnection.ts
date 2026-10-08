import type { PluginConnection } from '@mmt/contracts';

// A new endpoint or secret reference needs fresh manifest, metrics and search state.
export function getPluginConnectionKey(
  plugin: Pick<PluginConnection, 'id' | 'projectId' | 'baseUrl' | 'tokenEnv'>,
): string {
  return JSON.stringify([plugin.projectId, plugin.id, plugin.baseUrl, plugin.tokenEnv]);
}
