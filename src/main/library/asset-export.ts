/**
 * The one place that writes a cover or a lyric to disk.
 *
 * ## Why a single entry point
 *
 * Before this, four code paths each decided for themselves where an asset went:
 * the lyric editor wrote a `.lrc`, the candidate picker wrote a `.lrc`, 标签匹配
 * wrote tags through `writeTags`, and the downloader wrote both in whatever
 * order its own toggles happened to fall into. Four decisions is four chances to
 * disagree — and they did: a manually edited lyric could land as a sidecar while
 * a downloaded one of the same kind landed in the tag, so the same user action
 * produced a different provenance record depending on which menu item was used.
 *
 * This module makes the destination a parameter (with the user's setting behind
 * it) and the result a record of what actually happened, so the index, the
 * badge and the toast all read the same answer.
 *
 * ## The rules encoded here
 *
 *   - **Embedded is opt-in per format, not per wish.** A container this app has
 *     no tested writer for never gets modified; the asset goes to a sidecar
 *     instead and the note says why. The user's whitelist can only narrow the
 *     set further (see `WRITABLE_TAG_FORMATS`).
 *   - **Metadata text has nowhere else to go.** Title/artist/album only fit in
 *     the file's tags, so refusing an embedded write drops those fields and says
 *     so rather than silently doing nothing.
 *   - **A sidecar is named after the track, not the album.** See `asset-files.ts`
 *     for why the per-track name is the one this app creates.
 */
import { existsSync } from 'node:fs'
import { extname } from 'node:path'
import type {
  AssetExportInput,
  AssetExportResult,
  TagPatch
} from '@shared/library-types'
import type { AssetRef, AssetWriteTarget, TrackAssets } from '@shared/types'
import { canWriteTags, lyricHasTimestamps, writeTags } from './tag-writer'
import { readEmbeddedLyric } from './embedded-lyrics'
import { coverSidecarPathFor, sidecarPathFor } from './asset-files'
import { writeFileAtomic } from '../store/json-file'
import { releaseFileForWrite } from '../media/file-release'
import { saveSidecar } from './lyric-service'

const EMBEDDED_LABEL = '文件内嵌'
const SIDECAR_LABEL = '同目录文件'

/**
 * The most lyric text this module will write, in UTF-16 code units.
 *
 * The channels that reach here take the lyric from the renderer, and until this
 * existed the only check was "is it a non-empty string" — so a multi-hundred-
 * megabyte value became a `.lrc` of that size next to the user's music, and, on
 * the embedded path, an `USLT`/`LYRICS` frame of that size inside their file.
 * A `.lrc` is a text file someone reads; there is no legitimate value here that
 * is not far below this.
 *
 * It is *not* a tight bound, on purpose. A downloaded lyric arrives as three
 * separately-fetched pieces (main / 翻译 / 音译), each capped at 512 KiB of
 * bytes upstream (`LYRIC_MAX_BYTES` in `online/lyrics.ts`), and they are merged
 * into one string before they get here — so the ceiling has to sit above the sum
 * of three legitimate pieces, not above one. One mebibyte of characters is well
 * over that and still three orders of magnitude below the failure being closed.
 */
const MAX_LYRIC_CHARS = 1024 * 1024

/** Anything the caller leaves out is decided by these defaults. */
const DEFAULT_TARGETS: AssetWriteTarget[] = ['embedded']

/** Text fields that only fit in the file's own tags. */
const METADATA_KEYS = ['title', 'artist', 'album', 'albumArtist', 'year', 'trackNo', 'genre'] as const

function hasMetadataFields(patch: TagPatch): boolean {
  return METADATA_KEYS.some((key) => patch[key] !== undefined && patch[key] !== '')
}

/**
 * Write a cover and/or a lyric for one audio file, plus any metadata the caller
 * wants committed in the same pass.
 *
 * `input.audioPath` is where the sidecar goes and what the UI is told was
 * written; `stagingPath` redirects only the embedded half, for a download that
 * has not been published under its final name yet.
 */
export async function exportAssets(input: AssetExportInput): Promise<AssetExportResult> {
  const { audioPath, patch } = input
  const targets = input.to?.length ? input.to : DEFAULT_TARGETS
  const assets: TrackAssets = {}
  const result: AssetExportResult = { written: false, landed: [], paths: [], notes: [], note: '', embeddedWritten: false }

  // Refused here rather than at each caller, because this is the single place
  // that writes: a bound enforced at three of the four entry points is a bound
  // the fourth walks around. The oversized text is dropped from the patch as
  // well as from `lyric`, so it cannot reach `writeTags` and become a tag frame.
  const rawLyric = patch.lyrics?.trim() ?? ''
  const oversized = rawLyric.length > MAX_LYRIC_CHARS
  const lyric = oversized ? '' : rawLyric
  // Metadata still has to fit in the file's tags, so the patch is otherwise kept.
  const effective: TagPatch = oversized ? { ...patch, lyrics: undefined } : patch

  const hasAssetPayload = Boolean(lyric || patch.cover)
  const targetFile = input.stagingPath ?? audioPath
  const now = Date.now()

  // The ceiling is the writer set, intersected with the user's whitelist, so a
  // settings write cannot make the app touch a format it cannot handle.
  //
  // Title/artist/album have nowhere else to go, so a patch that carries any of
  // them always asks for the embedded write even when 写入位置 says 「同名文件」
  // only: otherwise 标签匹配 from that setting matches the candidate, writes
  // nothing, and does not even say it did nothing.
  const wantsEmbedded = targets.includes('embedded') || hasMetadataFields(effective)
  const embedded = wantsEmbedded && canWriteTags(targetFile, input.writableFormats)
  // `embedded` in the settings means "in the file, and beside it if the file
  // cannot be modified" — the alternative is a button that quietly does nothing
  // for a whole class of files. Except while the caller is writing a staging
  // file: a sidecar belongs next to the *published* track, not in a temp folder.
  const fallback = !embedded && wantsEmbedded && hasAssetPayload && !input.stagingPath
  const sidecar = (targets.includes('sidecar') || fallback) && !input.stagingPath

  if (input.stagingPath && targets.includes('sidecar')) {
    result.notes.push('下载文件尚未定名，同目录副本会在保存后写入')
  }

  if (oversized) {
    // Not `return`ed: a patch may carry metadata beside the rejected lyric, and
    // refusing the whole call would silently drop fields the user did ask for.
    result.notes.push(`${Math.round(rawLyric.length / 1024)} KiB 的歌词超过上限，未写入`)
  }

  if (!embedded && wantsEmbedded) {
    const ext = extname(targetFile).toUpperCase().replace(/^\./, '')
    if (fallback) {
      result.notes.push(`${ext} 不支持写入标签，已改为保存同目录文件`)
    } else if (hasMetadataFields(effective)) {
      result.notes.push(`${ext} 不支持写入标签，标题等文本字段未写入`)
    }
  }

  /* ---------------- embedded: the user's own file ---------------- */
  if (embedded) {
    // Put the file down before replacing it. The write ends in a rename over the
    // original, and a player still streaming that song keeps a handle open which
    // Windows reports as EPERM. A preview touches nothing, so it asks for nothing.
    if (input.dryRun !== true) releaseFileForWrite(targetFile)
    const written = await writeTags(targetFile, effective, {
      dryRun: input.dryRun === true,
      // Skipping the backup is only safe because the file is a staging copy that
      // nothing else has open — the download's `.jj-<id>` temp. Honouring the flag
      // for an in-place write would edit a user's real file with no way back.
      skipBackup: input.skipBackup === true && Boolean(input.stagingPath)
    })
    if (written.written) {
      result.written = true
      result.embeddedWritten = true
      result.landed.push(EMBEDDED_LABEL)
      // `paths` means "files that changed", so a preview reports none — the tense
      // in `note` is what tells the two apart.
      if (!input.dryRun) result.paths.push(targetFile)
      if (written.note) result.notes.push(written.note)
      if (written.backupPath) result.backupPath = written.backupPath
      // What landed is recorded from the caller's payload, not from a re-read:
      // `writeTags` reports success per file, not per field.
      if (lyric) pushAsset(assets, 'lyric', { origin: 'embedded', synced: lyricHasTimestamps(lyric), at: now })
      if (patch.cover) pushAsset(assets, 'cover', { origin: 'embedded', provider: patch.cover.mimeType, at: now })
      // An MP3 that already carries a *synchronised* lyric tag keeps it: the app
      // reads that frame in preference to the plain-text one it just rewrote,
      // and the frame cannot be removed with the tag writer available here (see
      // `writeMp3`). Saying so is the difference between a failed write and a
      // mystery — a sidecar beats both, so the note points there.
      if (lyric && !lyricHasTimestamps(lyric)) {
        const before = await readEmbeddedLyric(targetFile).catch(() => null)
        if (before?.synchronized && before.lyric.trim() !== lyric.trim()) {
          result.notes.push('文件内原有的带时间轴歌词仍会被优先显示，要让它让位请改用「同目录文件」')
        }
      }
    } else {
      // `writeTags` explains its own failures (an unreadable FLAC chain, and so
      // on); passing the note through is what keeps the toast from saying 成功.
      result.notes.push(written.note)
      if (written.backupPath) result.backupPath = written.backupPath
    }
  }

  /* ---------------- sidecar: a new file beside it ---------------- */
  if (sidecar) {
    if (lyric) {
      const skipped = Boolean(input.noClobber && existsSync(sidecarPathFor(audioPath)))
      if (skipped) {
        // An automatic pass must not eat a lyric file the user put there; an
        // explicit one (an edit, a chosen candidate) is them overwriting it on
        // purpose, which is why only the fetcher sets this flag.
        result.notes.push('同名 LRC 已存在，未覆盖')
      } else {
        if (!input.dryRun) result.paths.push(await saveSidecar(audioPath, lyric))
        result.landed.push(SIDECAR_LABEL)
        pushAsset(assets, 'lyric', { origin: 'sidecar', synced: lyricHasTimestamps(lyric), at: now })
        result.written = true
      }
    }

    if (patch.cover) {
      const file = coverSidecarPathFor(audioPath, patch.cover.mimeType)
      if (input.noClobber && existsSync(file)) {
        result.notes.push('同名封面已存在，未覆盖')
      } else {
        if (!input.dryRun) await writeFileAtomic(file, Buffer.from(patch.cover.data))
        if (!input.dryRun) result.paths.push(file)
        if (!result.landed.includes(SIDECAR_LABEL)) result.landed.push(SIDECAR_LABEL)
        pushAsset(assets, 'cover', { origin: 'sidecar', provider: patch.cover.mimeType, at: now })
        result.written = true
      }
    }
  }

  if (assets.cover || assets.lyrics) result.assets = assets
  // Past or future tense matters: the same call serves the preview dialog.
  result.note = result.landed.length
    ? `${input.dryRun ? '将写入' : '已写入'} ${result.landed.join(' + ')}`
    : result.notes[0] ?? '未写入任何内容'
  return result
}

/**
 * Record one landed asset, keeping the chain in resolution order.
 *
 * Sidecar first: that is the order the resolver walks (a file the user placed
 * beats a tag inside the audio), and the list *is* that order — see `TrackAssets`.
 */
function pushAsset(assets: TrackAssets, kind: 'cover' | 'lyric', ref: AssetRef): void {
  if (kind === 'cover') {
    assets.cover = mergeChain(assets.cover ?? [], [ref])
    return
  }
  assets.lyrics = { ...assets.lyrics, main: mergeChain(assets.lyrics?.main ?? [], [ref]) }
}

/**
 * Merge what just landed into a track's existing provenance.
 *
 * A sidecar write does not change the audio file, so the caller cannot afford a
 * re-read of it (that is a `music-metadata` pass over a file that did not
 * change). This folds the new source in and keeps the chain in resolution order.
 */
export function mergeAssets(existing: TrackAssets | undefined, landed: TrackAssets | undefined): TrackAssets | undefined {
  if (!landed) return existing
  const out: TrackAssets = { ...existing }
  if (landed.cover) out.cover = mergeChain(existing?.cover ?? [], landed.cover)
  if (landed.lyrics) {
    out.lyrics = {
      ...existing?.lyrics,
      main: landed.lyrics.main ? mergeChain(existing?.lyrics?.main ?? [], landed.lyrics.main) : existing?.lyrics?.main,
      translation: landed.lyrics.translation ?? existing?.lyrics?.translation,
      pronunciation: landed.lyrics.pronunciation ?? existing?.lyrics?.pronunciation
    }
  }
  return out
}

/** Insert or replace by origin, keeping `sidecar` ahead of `embedded`. */
function mergeChain(chain: AssetRef[], added: AssetRef[]): AssetRef[] {
  const origins = new Set(added.map((entry) => entry.origin))
  return [...chain.filter((entry) => !origins.has(entry.origin)), ...added].sort((a, b) => rank(a) - rank(b))
}

const RANK: Record<string, number> = { user: 0, sidecar: 1, embedded: 2, cache: 3, remote: 4 }
function rank(ref: AssetRef): number {
  return RANK[ref.origin] ?? 9
}
