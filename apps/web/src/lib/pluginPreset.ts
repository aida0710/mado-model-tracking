import { text } from '../i18n/catalog';

// Match the local bridge URL and API secret reference documented in docs/plugins.md.
export const MADO_PLUGIN_PRESET = {
  name: text.madoPluginName,
  baseUrl: 'http://127.0.0.1:4190',
  tokenEnv: 'MMT_MADO_PLUGIN_TOKEN',
};
