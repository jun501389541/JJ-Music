/** Encode segments once; keep separators for Chromium's custom URL scheme. */
export function toMediaUrl(path: string): string {
  const encoded = path.replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/')
  return `jjmedia://local/${encoded}`
}
