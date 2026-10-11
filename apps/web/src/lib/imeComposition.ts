/** The parts of a React keyboard event that tell whether an input method is composing text. */
export type CompositionAwareKeyEvent = {
  keyCode: number;
  nativeEvent: { isComposing: boolean };
};

// Chrome and Safari report keys handled by an input method with this keyCode ("Process"); Safari
// sends the Enter that confirms the conversion this way after compositionend, with isComposing false.
const IME_PROCESS_KEY_CODE = 229;

/**
 * Whether the key belongs to an input method converting text (Japanese input, for example): the
 * Enter that confirms the conversion or the ↑↓ that move through its candidates. Key handlers return
 * early on these, so confirming a word does not also choose an entry or submit a form.
 */
export function isComposingKey(event: CompositionAwareKeyEvent): boolean {
  return event.nativeEvent.isComposing || event.keyCode === IME_PROCESS_KEY_CODE;
}
