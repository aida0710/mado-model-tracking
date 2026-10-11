import { useEffect, useRef, useState } from 'react';
import type { FieldSuggestions, SuggestFieldValues } from '../types/form';

// Waits for typing to pause so each keystroke does not start its own lookup.
export const FIELD_SUGGESTION_DELAY_MS = 200;

const NO_SUGGESTIONS: FieldSuggestions = { items: [] };

/**
 * The candidates `suggest` offers for `value`, looked up once typing pauses. A newer value aborts
 * the lookup still running for an older one, so a late answer never replaces a newer one. Until
 * the new answer arrives the previous candidates stay, without their note.
 */
export function useFieldSuggestions(
  value: string,
  suggest: SuggestFieldValues | undefined,
): FieldSuggestions {
  // The field definitions are rebuilt on every render; only the value decides when to look up.
  const suggestRef = useRef(suggest);
  suggestRef.current = suggest;
  const hasSuggest = suggest !== undefined;
  const [answer, setAnswer] = useState<{ value: string; suggestions: FieldSuggestions } | null>(
    null,
  );
  useEffect(() => {
    const lookUp = suggestRef.current;
    if (!lookUp || !value) {
      setAnswer(null);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      lookUp(value, controller.signal).then(
        (suggestions) => {
          if (!controller.signal.aborted) setAnswer({ value, suggestions });
        },
        () => {
          // Candidates only help typing; a failed lookup leaves the field usable without them.
          if (!controller.signal.aborted) setAnswer({ value, suggestions: NO_SUGGESTIONS });
        },
      );
    }, FIELD_SUGGESTION_DELAY_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [value, hasSuggest]);
  if (!answer || !value) return NO_SUGGESTIONS;
  return answer.value === value ? answer.suggestions : { items: answer.suggestions.items };
}
