import { useId, useMemo } from 'react';
import { CODE_LANGUAGES, highlightCode, type CodeLanguage } from '@mado/design-tokens/code';
import { useCodeLanguage, type CodeLanguageChoice } from '../../hooks/useCodeLanguage';
import { text, textTemplates } from '../../i18n/catalog';

function formatName(language: CodeLanguage) {
  if (language === 'plaintext') return text.codeFormatText;
  if (language === 'log') return text.codeFormatLog;
  return CODE_LANGUAGES.find((item) => item.id === language)?.name ?? language;
}

/**
 * A text preview colored by its format (@mado/design-tokens/code). The format is detected from the
 * file name, media type and content; the select above the text overrides it for files with the
 * same extension.
 */
export function CodeView({
  content,
  fileName,
  mimeType,
}: {
  content: string;
  fileName?: string | null;
  mimeType?: string | null;
}) {
  const selectId = useId();
  const code = useCodeLanguage({ fileName, mimeType, text: content });
  const html = useMemo(() => highlightCode(content, code.language), [content, code.language]);
  return (
    <div className="code-preview">
      <div className="code-preview-toolbar">
        <label className="code-format" htmlFor={selectId}>
          {text.codeFormat}
          <select
            id={selectId}
            value={code.choice}
            onChange={(event) => code.setChoice(event.target.value as CodeLanguageChoice)}
          >
            <option value="auto">{textTemplates.codeFormatAuto(formatName(code.detected))}</option>
            {CODE_LANGUAGES.map((language) => (
              <option key={language.id} value={language.id}>
                {formatName(language.id)}
              </option>
            ))}
          </select>
        </label>
      </div>
      {/* highlightCode escapes the text; the only markup it adds is the spans for the colors. */}
      <pre className="code-view">
        <code dangerouslySetInnerHTML={{ __html: html }} />
      </pre>
    </div>
  );
}
