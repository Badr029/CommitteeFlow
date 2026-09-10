/**
 * Upload limits and formatting, shared by the dropzone and its messages.
 *
 * Kept out of the component file so React Fast Refresh keeps working — the same
 * reason `components/ui/classes.ts` exists.
 *
 * These mirror the server's limits deliberately. The client copy exists to fail
 * fast with a useful message; the server's copy is the one that is enforced, and
 * it re-checks the extension, the MIME type and the file's own bytes (§7).
 */

export const ACCEPTED_EXTENSIONS = ['.xlsx', '.xls', '.csv'] as const;

export const ACCEPT_ATTRIBUTE = [
  '.xlsx',
  '.xls',
  '.csv',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'text/csv',
].join(',');

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot).toLowerCase();
}
