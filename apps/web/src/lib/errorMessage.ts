import { INVALID_RESPONSE_CODE, NETWORK_ERROR_CODE, RequestError } from '../api/http';
import { text } from '../i18n/catalog';

// Codes whose text the Web owns. Every other API code already carries a server message for people.
const requestErrorText: Record<string, string> = {
  [NETWORK_ERROR_CODE]: text.requestError,
  [INVALID_RESPONSE_CODE]: text.invalidResponse,
};

/** Turns any thrown value into the message shown on screen. */
export function formatErrorMessage(failure: unknown): string {
  if (failure instanceof RequestError) return formatRequestError(failure);
  if (failure instanceof Error) return failure.message;
  return String(failure);
}

function formatRequestError(failure: RequestError): string {
  const knownText = failure.code ? requestErrorText[failure.code] : undefined;
  if (knownText) return knownText;
  if (failure.serverMessage) return failure.serverMessage;
  return `${text.requestError} (${failure.status})`;
}
