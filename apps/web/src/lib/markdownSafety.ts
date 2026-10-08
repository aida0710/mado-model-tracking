// Decides which URLs written in Markdown (Run descriptions, comments, reports) may become live
// links or images. The Markdown comes from any project member and from MLflow clients, so a URL
// is shown as plain text unless it is known to be harmless.

// Schemes that cannot run script in the page or embed content. Anything else (javascript:,
// data:, vbscript:, file:, ...) is refused rather than listed, so new schemes stay refused.
const ALLOWED_LINK_SCHEMES = new Set(['http', 'https', 'mailto']);
const URL_SCHEME_PATTERN = /^([a-z][a-z0-9+.-]*):/i;
// Browsers drop ASCII whitespace and control characters inside a scheme ("java\tscript:"),
// so the scheme is read with them removed.
const IGNORED_URL_CHARACTERS = /[\u0000- \u007f]/g;
// The API path that streams one Artifact's bytes (api/tracking.ts artifactContentPath).
const ARTIFACT_CONTENT_PATH_PATTERN = /^\/api\/projects\/[^/]+\/artifacts\/[^/]+\/content$/;

/** Returns the href to link to, or null when the URL must stay plain text. */
export function getSafeLinkHref(url: string): string | null {
  const href = url.trim();
  if (!href) return null;
  const scheme = URL_SCHEME_PATTERN.exec(href.replace(IGNORED_URL_CHARACTERS, ''))?.[1];
  // No scheme means a relative path, a query or a fragment within this application.
  if (scheme === undefined) return href;
  return ALLOWED_LINK_SCHEMES.has(scheme.toLowerCase()) ? href : null;
}

/**
 * The Markdown parser percent-encodes URLs ("%22" for a quote). A refused URL is shown as text,
 * so it is decoded back to what the author wrote when that is possible.
 */
export function formatUrlForDisplay(url: string): string {
  try {
    return decodeURI(url);
  } catch {
    return url;
  }
}

/** True when the link leaves this application, so it opens in a new tab without a referrer. */
export function isExternalLink(href: string, origin: string): boolean {
  if (href.toLowerCase().startsWith('mailto:')) return false;
  try {
    return new URL(href, origin).origin !== origin;
  } catch {
    return true;
  }
}

export type MarkdownImageDisplay =
  | { kind: 'image'; src: string }
  | { kind: 'link'; href: string }
  | { kind: 'text' };

/**
 * Only Artifact content served by this origin is drawn as an image. Loading any other image
 * would tell its host who read the page and when, so it becomes a link the reader may follow.
 */
export function getMarkdownImageDisplay(src: string, origin: string): MarkdownImageDisplay {
  const href = getSafeLinkHref(src);
  if (href === null) return { kind: 'text' };
  let resolved: URL;
  try {
    resolved = new URL(href, origin);
  } catch {
    return { kind: 'text' };
  }
  if (resolved.origin === origin && ARTIFACT_CONTENT_PATH_PATTERN.test(resolved.pathname))
    return { kind: 'image', src: `${resolved.pathname}${resolved.search}` };
  return { kind: 'link', href };
}
