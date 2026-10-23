import { randomUUID } from 'node:crypto'
import { readFile, rm, stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { parseFile } from 'music-metadata'
import { parseJsonLoose, writeJsonAtomic } from '../store/json-file'
import { hashPath } from './music-library'
import { relinkSettings, relinkTrack, sameLocalPath, type LocalRelinkChange, type LocalRelinkPreview } from '@shared/local-file-relink'
import type { AppSettings, LocalMusicInfo, PlayableTrack } from '@shared/types'
export { relinkSettings, relinkTrack } from '@shared/local-file-relink'

type Json = Record<string, unknown>
async function readStrict(path: string): Promise<Json | undefined> {
  let bytes: string
  try { bytes = await readFile(path, 'utf8') }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
  const value = parseJsonLoose<unknown>(bytes)
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('重新定位资料损坏，请保留文件并恢复备份')
  return value as Json
}
function validateChange(change: LocalRelinkChange): void {
  for (const track of [change?.old, change?.next]) {
    if (!track || typeof track.path !== 'string' || !isAbsolute(track.path) || track.path.includes('\0') || track.id !== hashPath(track.path) || typeof track.name !== 'string' || typeof track.singer !== 'string') throw Error('重新定位记录损坏')
  }
  if (sameLocalPath(change.old.path, change.next.path) || change.old.id === change.next.id) throw Error('请选择不同的新文件')
}
async function files(dataDir: string): Promise<Array<[string, Json]>> {
  const indexPath = join(dataDir, 'library/index.json'), listPath = join(dataDir, 'playlists.json'), settingsPath = join(dataDir, 'settings.json')
  const index = await readStrict(indexPath) ?? { version: 5, folders: [], tracks: [] }
  const lists = await readStrict(listPath) ?? { version: 1, playlists: [], items: {} }
  const settings = await readStrict(settingsPath) ?? {}
  if (!Array.isArray(index.tracks) || !Array.isArray(index.folders) || !lists.items || typeof lists.items !== 'object' || Array.isArray(lists.items) || !Array.isArray(lists.playlists)) throw Error('重新定位资料损坏')
  if (Object.values(lists.items).some(rows => !Array.isArray(rows))) throw Error('重新定位歌单资料损坏')
  const rowsValid = (rows: unknown): boolean => Array.isArray(rows) && rows.every(t => t && typeof t === 'object' && typeof t.id === 'string' && (!('path' in t) || typeof t.path === 'string'))
  if (!rowsValid(index.tracks) || Object.values(lists.items).some(rows => !rowsValid(rows)) ||
      (settings.recentPlayed !== undefined && !rowsValid(settings.recentPlayed)) ||
      (settings.queueHistory !== undefined && (!Array.isArray(settings.queueHistory) || settings.queueHistory.some(q => !q || typeof q !== 'object' || !rowsValid(q.queue)))) ||
      (settings.lastSession != null && (typeof settings.lastSession !== 'object' || !rowsValid([(settings.lastSession as Json).track]) || !rowsValid((settings.lastSession as Json).queue)))) throw Error('重新定位引用资料损坏')
  return [[indexPath, index], [listPath, lists], [settingsPath, settings]]
}
type Options = { write?: typeof writeJsonAtomic }
/** A completed disk commit is unsafe to unlock until every in-memory store agrees. */
export class RelinkCommitGuard {
  blocked = false
  async run<C, T>(prepare: () => Promise<C>, commit: (change: C) => Promise<void>, reload: (change: C) => Promise<T>, pending: () => boolean): Promise<T> {
    if (this.blocked) throw Error('重新定位尚待恢复，请重启应用')
    this.blocked = true
    let committed = false, finished = false
    try {
      const change = await prepare()
      await commit(change); committed = true
      const result = await reload(change); finished = true
      return result
    } finally {
      if (finished || (!committed && !pending())) this.blocked = false
    }
  }
}
async function apply(dataDir: string, change: LocalRelinkChange, options: Options): Promise<void> {
  const [indexEntry, listEntry, settingsEntry] = await files(dataDir)
  const [indexPath, index] = indexEntry, [listPath, lists] = listEntry, [settingsPath, settings] = settingsEntry
  const write = options.write ?? writeJsonAtomic
  const tracks = (index.tracks as LocalMusicInfo[]).filter(t => !(t.id === change.old.id && sameLocalPath(t.path, change.old.path)) && t.id !== change.next.id)
  await write(indexPath, { ...index, tracks: [...tracks, change.next] })
  await write(listPath, { ...lists, items: Object.fromEntries(Object.entries(lists.items as Record<string, PlayableTrack[]>).map(([id, rows]) => [id, rows.map(t => relinkTrack(t, change))])) })
  await write(settingsPath, relinkSettings(settings as Partial<AppSettings>, change))
}
export async function recoverLocalRelink(dataDir: string, options: Options = {}): Promise<boolean> {
  const path = join(dataDir, 'local-relink.pending.json'), journal = await readStrict(path)
  if (!journal) return false
  if (journal.version !== 1 || !journal.change) throw Error('重新定位恢复记录损坏')
  const change = journal.change as LocalRelinkChange
  validateChange(change)
  await apply(dataDir, change, options)
  await rm(path)
  return true
}
export async function commitLocalRelink(dataDir: string, change: LocalRelinkChange, options: Options = {}): Promise<void> {
  validateChange(change)
  if (await readStrict(join(dataDir, 'local-relink.pending.json'))) throw Error('上次重新定位尚待恢复，请重启应用')
  await files(dataDir) // Fail closed before creating a transaction for damaged stores.
  await (options.write ?? writeJsonAtomic)(join(dataDir, 'local-relink.pending.json'), { version: 1, change })
  await recoverLocalRelink(dataDir, options)
}

async function assertMissing(path: string): Promise<void> {
  try { await stat(path) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw Error('旧文件读取失败，请检查权限或磁盘连接') }
  throw Error('原文件仍可访问，无需重新定位')
}
async function fingerprint(path: string): Promise<string> {
  const info = await stat(path)
  if (!info.isFile()) throw Error('请选择有效音频文件')
  return JSON.stringify([info.size, info.mtimeMs, info.dev, info.ino])
}
export class RelinkCandidates {
  private candidates = new Map<string, { preview: LocalRelinkPreview; fingerprint: string; expires: number }>()
  constructor(private readonly deps: {
    findOld: (id: string, path: string) => Promise<LocalMusicInfo | undefined>
    findTarget: (id: string) => Promise<LocalMusicInfo | undefined>
    readTrack: (path: string) => Promise<LocalMusicInfo>
    now?: () => number
  }) {}
  async source(id: string, path: string): Promise<LocalMusicInfo> {
    const old = await this.deps.findOld(id, path)
    if (!old || old.id !== id || !sameLocalPath(old.path, path)) throw Error('原歌曲记录已变化或不存在')
    await assertMissing(path)
    return old
  }
  async preview(id: string, path: string, chosen: string): Promise<LocalRelinkPreview> {
    const old = await this.source(id, path)
    if (await this.deps.findTarget(hashPath(chosen))) throw Error('所选文件已在曲库中，不能自动合并')
    const before = await fingerprint(chosen)
    try {
      const metadata = await parseFile(chosen)
      if (!metadata.format.sampleRate || !metadata.format.duration) throw Error('no audio')
    } catch { throw Error('所选文件不是可读取的音频') }
    const next = await this.deps.readTrack(chosen)
    const preview = { token: randomUUID(), old: structuredClone(old), next }
    validateChange(preview)
    if (before !== await fingerprint(chosen)) throw Error('所选文件已变化，请重新选择')
    this.candidates.clear()
    this.candidates.set(preview.token, { preview: structuredClone(preview), fingerprint: before, expires: (this.deps.now?.() ?? Date.now()) + 5 * 60_000 })
    return preview
  }
  discard(token: string): void { this.candidates.delete(token) }
  async confirm(token: string): Promise<LocalRelinkChange> {
    const candidate = this.candidates.get(token)
    if (!candidate || candidate.expires <= (this.deps.now?.() ?? Date.now())) { this.discard(token); throw Error('重新定位预览已失效，请重新选择') }
    const { old, next } = candidate.preview
    const current = await this.deps.findOld(old.id, old.path)
    if (JSON.stringify(current) !== JSON.stringify(old)) throw Error('原歌曲记录已变化，请重新选择')
    await assertMissing(old.path)
    if (await this.deps.findTarget(next.id)) throw Error('所选文件已在曲库中，不能自动合并')
    if (await fingerprint(next.path) !== candidate.fingerprint) throw Error('所选文件已变化，请重新选择')
    return { old: structuredClone(old), next: structuredClone(next) }
  }
}
