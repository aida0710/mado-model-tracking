// Revoking right after click() can cancel the download in some browsers, so it waits a moment.
const OBJECT_URL_REVOKE_DELAY_MS = 10_000;

/** Hands a fetched file to the browser's download, as a link with `download` would. */
export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), OBJECT_URL_REVOKE_DELAY_MS);
}
