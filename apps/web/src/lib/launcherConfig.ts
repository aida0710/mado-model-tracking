import { text } from '../i18n/catalog';
import { launchersTextTemplates } from '../i18n/launchers';

// Example paths; the launcher's host decides the real ones.
const EXAMPLE_TOKEN_FILE = '/run/secrets/mado-tracking-launcher/launcher.token';
const EXAMPLE_STATE_DIRECTORY = '/var/lib/mado-tracking-launcher';
const EXAMPLE_REGISTRY_SECRET_FILE = '/run/secrets/mado-tracking-launcher/registry.json';
// How often the launcher reads its configuration and claims submissions, as in deploy/sites.
const EXAMPLE_POLL_SECONDS = 10;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g;
const UNICODE_ESCAPE_DIGITS = 4;
const HEXADECIMAL = 16;

/**
 * launcher.toml for a new launcher. It holds only what the launcher needs to start; its sites,
 * keys and job shells come from the Web. The token is not written here but into token_file.
 */
export function buildLauncherConfigExample({
  apiUrl,
  launcherName,
}: {
  apiUrl: string;
  launcherName: string;
}): string {
  const lines = [
    `# ${launchersTextTemplates.launcherConfigHeader(launcherName.replace(CONTROL_CHARACTERS, ' '))}`,
    `# ${text.launcherConfigApiUrlComment}`,
    `api_url = ${tomlString(apiUrl)}`,
    `# ${text.launcherConfigTokenFileComment}`,
    `token_file = ${tomlString(EXAMPLE_TOKEN_FILE)}`,
    `# ${text.launcherConfigStateComment}`,
    `state_directory = ${tomlString(EXAMPLE_STATE_DIRECTORY)}`,
    `# ${text.launcherConfigPollComment}`,
    `poll_seconds = ${EXAMPLE_POLL_SECONDS}`,
    `# ${text.launcherConfigRegistryComment}`,
    `# registry_secret_file = ${tomlString(EXAMPLE_REGISTRY_SECRET_FILE)}`,
  ];
  return `${lines.join('\n')}\n`;
}

// A TOML basic string: backslashes and quotes escaped, control characters as \uXXXX.
function tomlString(value: string): string {
  const escaped = value
    .replace(/[\\"]/g, (character) => `\\${character}`)
    .replace(
      CONTROL_CHARACTERS,
      (character) =>
        `\\u${character.charCodeAt(0).toString(HEXADECIMAL).padStart(UNICODE_ESCAPE_DIGITS, '0')}`,
    );
  return `"${escaped}"`;
}
