import { useMemo, useState } from 'react';
import { detectLanguage, isCodeLanguage, type CodeLanguage } from '@mado/design-tokens/code';

/** 'auto' follows the detected format; any other value is the format the user picked. */
export type CodeLanguageChoice = CodeLanguage | 'auto';

// The user's pick per file extension, so the next file of the same kind opens the same way.
// This key belongs to this standalone app rather than Mado's preferences.
const STORAGE_KEY = 'mmt.codeLanguage';

// .txt holds anything, so a pick for one .txt file says nothing about the next.
const UNREMEMBERED_EXTENSIONS = new Set(['txt', 'text']);

/**
 * The key a pick is remembered under: the extension, '.env' for .env files and 'dockerfile' for
 * Dockerfiles. Other names without an extension and .txt get '' and their pick is not remembered.
 */
export function codeLanguageKey(fileName: string | null | undefined): string {
  const name = String(fileName ?? '').split('/').pop()?.toLowerCase() ?? '';
  if (name === '.env' || name.startsWith('.env.')) return '.env';
  if (name === 'dockerfile' || name.startsWith('dockerfile.')) return 'dockerfile';
  const dot = name.lastIndexOf('.');
  const extension = dot > 0 ? name.slice(dot + 1) : '';
  return UNREMEMBERED_EXTENSIONS.has(extension) ? '' : extension;
}

function readChoices(): Record<string, CodeLanguage> {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
    if (!stored || typeof stored !== 'object') return {};
    return Object.fromEntries(Object.entries(stored).filter(([, value]) => isCodeLanguage(value)));
  } catch {
    return {};
  }
}

function storedChoice(key: string): CodeLanguageChoice {
  if (!key) return 'auto';
  const choices = readChoices();
  // Own keys only, so a file named "notes.constructor" does not read Object's members.
  return Object.hasOwn(choices, key) ? choices[key]! : 'auto';
}

function writeChoice(key: string, choice: CodeLanguageChoice) {
  const choices: Record<string, CodeLanguage> = readChoices();
  if (choice === 'auto') delete choices[key];
  else choices[key] = choice;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(choices));
  } catch {
    /* The pick still applies to the open preview if storage is unavailable. */
  }
}

/**
 * The format a previewed text is colored as: detected from the file name, media type and content,
 * unless the user picked one for files with this extension.
 */
export function useCodeLanguage({
  fileName,
  mimeType,
  text,
}: {
  fileName?: string | null;
  mimeType?: string | null;
  text: string;
}) {
  const detected = useMemo(() => detectLanguage({ fileName, mimeType, text }), [fileName, mimeType, text]);
  const key = codeLanguageKey(fileName);
  // A pick made in this preview; another file (another key) reads its own pick from storage.
  const [picked, setPicked] = useState<{ key: string; choice: CodeLanguageChoice } | null>(null);
  const choice = picked?.key === key ? picked.choice : storedChoice(key);
  return {
    detected,
    choice,
    language: choice === 'auto' ? detected : choice,
    setChoice: (next: CodeLanguageChoice) => {
      setPicked({ key, choice: next });
      if (key) writeChoice(key, next);
    },
  };
}
