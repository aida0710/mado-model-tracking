import { Navigate, useLocation } from 'react-router-dom';
import { settingsPathForLegacyPath } from './legacySettingsPaths';

/**
 * Sends a URL from before 全体設定 (/account, /admin/<section>) to where it lives now, replacing
 * the old entry so Back does not bounce through it. The query and hash come along.
 */
export function LegacySettingsRedirect() {
  const { pathname, search, hash } = useLocation();
  const settingsPath = settingsPathForLegacyPath(pathname);
  return <Navigate replace to={settingsPath ? `${settingsPath}${search}${hash}` : '/'} />;
}
