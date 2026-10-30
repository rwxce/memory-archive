/**
 * Hands a Blob to the browser as a download (no network involved). Call it from the continuation of
 * a click so the browser still counts it as the person's action. The object URL is revoked later,
 * after the browser has had time to start reading it.
 */
export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
