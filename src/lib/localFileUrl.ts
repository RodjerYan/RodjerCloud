/**
 * abs FS path → local-file:/// URL.
 * win: drive letter goes into pathname → local-file:///C:/... (3 slashes);
 * mac/linux: path already absolute → local-file:///Users/...
 * Manually percent-encodes each path segment (spaces, #, ?, %, etc.),
 * then replaces file:// → local-file://.
 * Protocol handler (index.ts:311-344) decodes via decodeURIComponent.
 */
function encodePathSegments(p: string): string {
  // Split by '/', encode each segment, rejoin
  return p.split('/').map(seg => encodeURIComponent(seg)).join('/')
}

export function toLocalFileUrl(absPath: string): string {
  let p = absPath.replace(/\\/g, '/')
  // ensure form /C:/... on windows, keep /Users/... on posix
  if (/^[A-Za-z]:/.test(p)) p = '/' + p
  if (!p.startsWith('/')) p = '/' + p
  // Manually encode path segments (spaces → %20, # → %23, ? → %3F, % → %25, etc.)
  const encoded = encodePathSegments(p)
  // file:///... → local-file:///... (triple slash for absolute paths)
  return 'local-file://' + encoded
}
