/** A format a previewed text can be shown as. */
export type CodeLanguage =
  | 'plaintext'
  | 'json'
  | 'yaml'
  | 'toml'
  | 'ini'
  | 'properties'
  | 'xml'
  | 'markdown'
  | 'python'
  | 'bash'
  | 'sql'
  | 'dockerfile'
  | 'csv'
  | 'tsv'
  | 'log';

export interface CodeLanguageInfo {
  id: CodeLanguage;
  /** The format's own name. Apps translate 'Text' and 'Log' for their select. */
  name: string;
}

/** The formats a preview can be shown as, in the order of the select. */
export declare const CODE_LANGUAGES: readonly CodeLanguageInfo[];

/** Coloring stops here; the rest of a longer text is shown as it is. */
export declare const HIGHLIGHT_MAX_CHARS: number;

export declare function isCodeLanguage(value: unknown): value is CodeLanguage;

/** The format the file name tells, or null when it says nothing (no or unknown extension, .txt). */
export declare function languageFromName(fileName: string | null | undefined): CodeLanguage | null;

/** The format the media type tells, or null for text/plain, octet-stream and the like. */
export declare function languageFromMimeType(mimeType: string | null | undefined): CodeLanguage | null;

/** The format the content looks like, from its first lines; plain text when nothing fits. */
export declare function guessLanguage(text: string): CodeLanguage;

/** The file name decides first, then the media type, then the content. */
export declare function detectLanguage(input: {
  fileName?: string | null;
  mimeType?: string | null;
  text: string;
}): CodeLanguage;

export declare function escapeHtml(text: string): string;

/**
 * The text as HTML for <code> inside .code-view: escaped, with spans for the colors. Only the
 * first HIGHLIGHT_MAX_CHARS are colored, so a large preview stays responsive.
 */
export declare function highlightCode(text: string, language: CodeLanguage): string;
