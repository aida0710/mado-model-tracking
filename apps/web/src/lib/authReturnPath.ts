// Keep an SSO round trip in this tab from losing the bookmarked project/Run URL.
const AUTH_RETURN_PATH_KEY = 'mmt.auth-return-path';

export function rememberAuthReturnPath(path: string) {
  if (!path.startsWith('/projects/')) return;
  try {
    sessionStorage.setItem(AUTH_RETURN_PATH_KEY, path);
  } catch {
    /* Login also works without session storage. */
  }
}

export function takeAuthReturnPath(): string | null {
  try {
    const path = sessionStorage.getItem(AUTH_RETURN_PATH_KEY);
    sessionStorage.removeItem(AUTH_RETURN_PATH_KEY);
    return path?.startsWith('/projects/') ? path : null;
  } catch {
    return null;
  }
}
