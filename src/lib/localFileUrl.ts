/**
 * abs FS path → local-file:/// URL.
 * win: drive letter goes into pathname → local-file:///C:/... (3 slashes);
 * mac/linux: path already absolute → local-file:///Users/...
 * Spaces ("Application Support") are percent-encoded — the protocol handler
 * decodes them back via decodeURIComponent before pathToFileURL.
 */
export function toLocalFileUrl(absPath: string): string {
  let p = absPath.replace(/\\/g, '/')
  // ensure form /C:/... on windows, keep /Users/... on posix
  if (/^[A-Za-z]:/.test(p)) p = '/' + p
  if (!p.startsWith('/')) p = '/' + p
  return 'local-file://' + encodeURI(p)
}
