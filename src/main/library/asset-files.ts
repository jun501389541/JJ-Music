/**
 * File naming for the assets that live *beside* an audio file.
 *
 * ## Why this is its own module
 *
 * A sidecar is the one asset kind three different code paths need to agree on:
 * the scanner (does this track have one?), the resolver (read it) and the
 * exporter (create it). If each spells the path out on the spot, the exporter
 * can write a file the scanner then refuses to find — which is worse than not
 * writing it, because the user sees a success message and a missing cover.
 *
 * ## The conventions, and why they are these ones
 *
 * Both are the de-facto rules rather than inventions, taken from what players
 * already read:
 *
 *   - **Lyrics**: `<same basename>.lrc`. Every player that supports sidecar
 *     lyrics reads this. Fuzzy variants (`Song [Official Video].lrc`, a `lyrics/`
 *     subfolder, `.lrc.txt`) are matched by *some* players and by no two of them
 *     in the same order, so this app does not guess: one name, checked for real.
 *   - **Covers**: the track's own `<same basename>.jpg`/`.png`/`.webp` first,
 *     then the folder conventions (`cover`, `folder`, `front`, `albumcover`,
 *     `album`), which is what Plex, Jellyfin and Navidrome all look for. The
 *     per-track name is *not* copied from them — those servers index albums, so
 *     they have no need for it and no documented rule for it. This app writes
 *     that name because it indexes single files: a folder can hold several
 *     recordings whose artwork differs, and creating `cover.jpg` for one of them
 *     would both mislabel the others and overwrite a file the user put there.
 *
 * Windows treats these lookups as case-insensitive (NTFS), so `Cover.JPG` is
 * found by `cover.jpg` without a scan of the directory.
 */
import { existsSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'

/** Image extensions recognised for a sidecar cover, in preference order. */
export const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp'] as const

/** Folder-level cover names, best first. */
export const COVER_FILE_NAMES = ['cover', 'folder', 'front', 'albumcover', 'album'] as const

const MIME_BY_EXTENSION: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp'
}

const EXTENSION_BY_MIME: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp'
}

/** `image/png` → `.png`; anything unknown keeps `.jpg`, the safe default. */
export function imageExtensionForMime(mimeType: string | undefined): string {
  if (!mimeType) return '.jpg'
  return EXTENSION_BY_MIME[mimeType.toLowerCase().split(';')[0].trim()] ?? '.jpg'
}

/** Extension (or bare name) → mime type, or `undefined` when not an image we handle. */
export function imageMimeFor(extension: string): string | undefined {
  const ext = extension.startsWith('.') ? extension.toLowerCase() : `.${extension.toLowerCase()}`
  return MIME_BY_EXTENSION[ext]
}

/** True for a path this app can treat as a sidecar cover. */
export function isSidecarCover(filePath: string): boolean {
  return imageMimeFor(extname(filePath)) !== undefined
}

/** Sidecar `.lrc` for an audio file: same directory, same base name. */
export function sidecarPathFor(audioPath: string): string {
  return join(dirname(audioPath), `${basename(audioPath, extname(audioPath))}.lrc`)
}

/** Where a sidecar cover for this track belongs, using its own name. */
export function coverSidecarPathFor(audioPath: string, mimeType?: string): string {
  const stem = basename(audioPath, extname(audioPath))
  return join(dirname(audioPath), `${stem}${imageExtensionForMime(mimeType)}`)
}

/**
 * Every sidecar cover this track could use, best match first.
 *
 * The audio-name variants come first (see the module header), then the folder
 * conventions. Those names have no agreed order between the servers that use
 * them — Plex lists `album, cover, default, folder`, Jellyfin
 * `poster, folder, cover, default` — so this order is ours and only has to be
 * stable; inside one name `.jpg` comes before `.png` before `.webp`.
 */
export function coverSidecarCandidates(audioPath: string): string[] {
  const stem = basename(audioPath, extname(audioPath))
  const names = [stem, ...COVER_FILE_NAMES]
  const out: string[] = []
  for (const name of names) {
    for (const ext of IMAGE_EXTENSIONS) out.push(join(dirname(audioPath), `${name}${ext}`))
  }
  return out
}

/** The sidecar cover that actually exists for this track, if any. */
export function findCoverSidecar(
  audioPath: string
): { path: string; mimeType: string } | null {
  for (const candidate of coverSidecarCandidates(audioPath)) {
    if (!existsSync(candidate)) continue
    const mimeType = imageMimeFor(extname(candidate))
    if (mimeType) return { path: candidate, mimeType }
  }
  return null
}
