/**
 * abs FS path → local-file:/// URL.
 * win: drive letter goes into pathname → local-file:///C:/... (3 slashes);
 * mac/linux: path already absolute → local-file:///Users/...
 * Manually percent-encodes each path segment (spaces, #, ?, %, etc.),
 * then replaces file:// → local-file://.
 * Protocol handler (index.ts:311-344) decodes via decodeURIComponent.
 */
function encodePathSegments(p: string): string {
  // Split by '/', encode each segment, rejoin.
  // Segments matching a drive-letter pattern "X:" (e.g. "C:") are NOT encoded,
  // because Chromium cannot parse local-file:///C%3A/... — the colon must remain literal.
  // All other segments are encoded with encodeURIComponent as before.
  // Posix paths (/Users/A B/x.png) are unaffected because "Users" etc. don't match ^[A-Za-z]:$.
  return p.split('/').map(seg => {
    if (/^[A-Za-z]:$/.test(seg)) {
      return seg; // keep drive‑letter segment literal
    }
    return encodeURIComponent(seg);
  }).join('/')
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
