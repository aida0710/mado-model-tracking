/**
 * MLflow log_image(key=, step=) file names. The official SDK writes one full-resolution image and
 * one compressed .webp per call, with a layout that changed between releases:
 *   3.0.0:  images/<key>%step%<step>%timestamp%<ms>%<uuid>.png  and  ...%compressed.webp
 *           ('/' in the key becomes '#')
 *   3.17.0: images/<key>+step+<step>+timestamp+<ms>+<uuid>.png  and  ...+compressed.webp
 *           ('/' in the key becomes '~')
 */

export interface MlflowImagePath {
  key: string;
  step: number;
  /** Milliseconds the SDK put in the name. */
  timestamp: number;
  /** '%' for MLflow 3.0, '+' for later releases. */
  separator: '%' | '+';
  /** The uuid the SDK put in the name. */
  fileId: string;
  /** true for the compressed .webp that MLflow shows as the thumbnail. */
  compressed: boolean;
  /** The path of the full-resolution image of the same call (itself when not compressed). */
  imagePath: string;
  /** The path of the compressed image of the same call (itself when compressed). */
  compressedPath: string;
}

const IMAGE_DIRECTORY = 'images/';
const COMPRESSED_EXTENSION = '.webp';
const IMAGE_EXTENSION = '.png';
// The key's '/' replacement for each separator, as the SDK release that used it wrote it.
const KEY_SLASH_REPLACEMENT: Record<string, string> = { '%': '#', '+': '~' };
// The SDK accepts keys of [a-zA-Z0-9_\-./ ]; only the separator itself is excluded here.
const FILE_NAME_PATTERN =
  /^(?<key>[^/%+]+)(?<separator>[%+])step\k<separator>(?<step>0|[1-9]\d*)\k<separator>timestamp\k<separator>(?<timestamp>0|[1-9]\d*)\k<separator>(?<id>[0-9a-z-]+?)(?<compressed>\k<separator>compressed)?(?<extension>\.png|\.webp)$/;

// MLflow 3.0 starts the uuid with g-z so that a separator is never followed by two hex digits.
const PERCENT_FILE_ID_PATTERN = /^[g-z]/;

/** The parts of an MLflow log_image(key=, step=) path, or null for any other path. */
export function parseMlflowImagePath(path: string): MlflowImagePath | null {
  if (!path.startsWith(IMAGE_DIRECTORY)) return null;
  const match = FILE_NAME_PATTERN.exec(path.slice(IMAGE_DIRECTORY.length));
  if (!match?.groups) return null;
  const { separator, id, extension } = match.groups as Record<string, string>;
  const compressed = match.groups.compressed !== undefined;
  // The SDK writes the full image as .png and the compressed one as .webp, nothing else.
  if (extension !== (compressed ? COMPRESSED_EXTENSION : IMAGE_EXTENSION))
    return null;
  const step = Number(match.groups.step);
  const timestamp = Number(match.groups.timestamp);
  if (!Number.isSafeInteger(step) || !Number.isSafeInteger(timestamp)) return null;
  const key = match.groups.key!.split(KEY_SLASH_REPLACEMENT[separator!]!).join('/');
  const stem = `${IMAGE_DIRECTORY}${match.groups.key}${separator}step${separator}${match.groups.step}${separator}timestamp${separator}${match.groups.timestamp}${separator}${id}`;
  return {
    key,
    step,
    timestamp,
    separator: separator as '%' | '+',
    fileId: id!,
    compressed,
    imagePath: `${stem}${IMAGE_EXTENSION}`,
    compressedPath: `${stem}${separator}compressed${COMPRESSED_EXTENSION}`,
  };
}

/**
 * true for an MLflow 3.0 log_image file name. Its '%' separators are literal characters in the
 * decoded path, so the artifact path check lets exactly these names keep '%' before digits
 * (step and timestamp) instead of treating them as a second layer of percent-encoding.
 */
export function isMlflowPercentImagePath(path: string): boolean {
  const image = parseMlflowImagePath(path);
  return image?.separator === '%' && PERCENT_FILE_ID_PATTERN.test(image.fileId);
}

/**
 * The table paths MLflow log_table lists in the mlflow.loggedArtifacts tag
 * ([{"path": "tables/x.json", "type": "table"}, ...]). A malformed tag or entry is skipped, not an
 * error: the tag is written by clients and the files themselves stay listed as Artifacts.
 */
export function parseLoggedTablePaths(tagValue: string | undefined): string[] {
  if (!tagValue) return [];
  let entries: unknown;
  try {
    entries = JSON.parse(tagValue);
  } catch {
    return [];
  }
  if (!Array.isArray(entries)) return [];
  const paths = entries.flatMap((entry: unknown) => {
    if (typeof entry !== 'object' || entry === null) return [];
    const { path, type } = entry as { path?: unknown; type?: unknown };
    // Paths are only compared with stored Artifact paths, so an unsafe one simply matches nothing.
    return type === 'table' && typeof path === 'string' && path !== '' ? [path] : [];
  });
  return [...new Set(paths)];
}
