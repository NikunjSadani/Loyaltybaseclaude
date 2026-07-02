/**
 * downloadBlob — reliably trigger a browser "Save file" dialog for an in-memory blob.
 *
 * Two things MUST be right, and doing either wrong makes the download silently
 * do nothing (the button appears to work but no file is saved):
 *
 *   1. The <a> must be ATTACHED to the DOM before .click(). A detached anchor's
 *      download is ignored/cancelled by several browsers — especially when the
 *      click happens AFTER an `await` (e.g. fetch → res.blob()), i.e. outside the
 *      original user-gesture call stack.
 *   2. The object URL must NOT be revoked synchronously after .click() — that
 *      races the browser and can cancel the save before it starts. Defer it.
 *
 * Use this for every blob "save to disk" download. (Do NOT use it for opening a
 * blob in a new tab for viewing — that has different lifecycle needs.)
 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  // Defer cleanup so the download has time to start before the URL is freed.
  setTimeout(() => {
    a.remove();
    URL.revokeObjectURL(url);
  }, 1000);
}
