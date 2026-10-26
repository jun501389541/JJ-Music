import {assertDeriveSelection,DERIVE_MAX_LISTS,DERIVE_MAX_TRACKS,DERIVE_MAX_BYTES,type DerivedPlaylist} from '@shared/playlist-derive'
import {prepareQueuePlaylist} from '../library/queue-playlist'
import type {QueuePlaylistResult} from '@shared/queue-playlist'
import {assertPlaylistBulkRenameName,assertPlaylistBulkRenameSelection,PLAYLIST_BULK_RENAME_MAX_BYTES,PLAYLIST_BULK_RENAME_MAX_LISTS} from '@shared/playlist-bulk-rename'
import { playlistEntryKey } from '@shared/playlist-refresh'
import { UI_DEFAULTS } from '@shared/preferences'
import { PLAYLIST_BACKUP_MAX_LISTS, PLAYLIST_BACKUP_MAX_TRACKS, type PlaylistBackupSnapshot } from '@shared/playlist-backup'
/**
 * Application settings and playlist persistence.
 *
 * Stored as plain JSON in the app's data directory. Playlists use a schema
 * deliberately close to LX Music's `my_list` / `my_list_music_info` tables so
 * that an imported LX library maps cleanly onto ours.
 */
import { existsSync } from 'node:fs'
import { randomUUID, createHash } from 'node:crypto'
import { join } from 'node:path'
import type { AppSettings, PlayableTrack, Playlist } from '@shared/types'
import { isLocalTrack } from '@shared/types'
import { readJsonFile, writeJsonAtomic } from './json-file'
import type { SavedPlaylistSnapshot } from '@shared/playlist-refresh'

export const DEFAULT_SETTINGS: AppSettings = {
  ...UI_DEFAULTS,
  recentPlayed: [],
  queueHistory: [],
  searchHistory: [],
  playQuality: 'flac24bit',
  libraryFolders: [],
  scanExtensions: [],
  accent: 'auto',
  theme: 'dark',
  volume: 0.8,
  playMode: 'list',
  shortAudioTransitions: true,
  crossfadeDurationMs: 0,
  manualCrossfadeDurationMs: 0,
  preferLocal: true,
  onlineLyricSource: 'script',
  onlineLyricFallback: true,
  allowBuiltinOnlineSearch: false,
  downloadFolder: '',
  downloadLyric: true,
  downloadEmbedLyric: true,
  downloadTranslation: true,
  downloadRomanization: true,
  downloadEmbedCover: true,
  assetWriteTarget: 'embedded',
  tagWritableFormats: ['.mp3', '.flac'],
  minimizeToTray: false,
  outputDeviceId: '',
  desktopLyric: false,
  desktopLyricLocked: false,
  desktopLyricFontSize: 28,
  desktopLyricPosition: null,
  playlistOrder: []
}

function sanitizeCrossfadeDuration(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) &&
    value >= 0 && value <= 12_000 && value % 1_000 === 0
    ? value
    : 0
}

export class SettingsStore {
  async reload(): Promise<AppSettings> { this.loaded = false; return this.load() }
  private readonly filePath: string
  private settings: AppSettings = { ...DEFAULT_SETTINGS }
  private loaded = false

  constructor(dataDir: string) {
    this.filePath = join(dataDir, 'settings.json')
  }

  async load(): Promise<AppSettings> {
    if (this.loaded) return this.settings
    this.loaded = true
    const parsed = await readJsonFile<Partial<AppSettings>>(this.filePath)
    if (parsed) {
      // Merge so new settings added in later versions get their defaults.
      const current = { ...parsed } as Partial<AppSettings> & Record<string, unknown>
      delete current.onlineCatalogConsent
      delete current.onlineCatalogConsentPrompted
      this.settings = {
        ...DEFAULT_SETTINGS,
        ...current,
        crossfadeDurationMs: sanitizeCrossfadeDuration(current.crossfadeDurationMs),
        manualCrossfadeDurationMs: sanitizeCrossfadeDuration(current.manualCrossfadeDurationMs)
      }
    }
    return this.settings
  }

  get(): AppSettings {
    return { ...this.settings }
  }

  async update(patch: Partial<AppSettings>): Promise<AppSettings> {
    await this.load()
    const current = { ...patch } as Partial<AppSettings> & Record<string, unknown>
    delete current.onlineCatalogConsent
    delete current.onlineCatalogConsentPrompted
    if ('crossfadeDurationMs' in current) {
      current.crossfadeDurationMs = sanitizeCrossfadeDuration(current.crossfadeDurationMs)
    }
    if ('manualCrossfadeDurationMs' in current) {
      current.manualCrossfadeDurationMs = sanitizeCrossfadeDuration(current.manualCrossfadeDurationMs)
    }
    this.settings = { ...this.settings, ...current }
    await this.persist()
    return this.get()
  }

  private async persist(): Promise<void> {
    await writeJsonAtomic(this.filePath, this.settings)
  }
}

interface PlaylistFile {
  version: number
  playlists: Playlist[]
  /** listId -> tracks, in order. */
  items: Record<string, PlayableTrack[]>
}

/**
 * Playlist store: user-created lists plus a built-in "default" list that the
 * player appends to, mirroring LX Music's `default` list id.
 */
export class PlaylistStore {
  async reload(): Promise<void> {
    await this.flush()
    this.loaded = false; this.loading = undefined; this.playlists = []; this.items.clear()
    await this.load()
  }
  private readonly filePath: string
  private playlists: Playlist[] = []
  private items = new Map<string, PlayableTrack[]>()
  private loaded = false
  private loading?: Promise<void>
  private changes: Promise<unknown> = Promise.resolve()

  constructor(dataDir: string, private readonly options: { write?: (path: string, value: unknown) => Promise<void> } = {}) {
    this.filePath = join(dataDir, 'playlists.json')
  }

  load(): Promise<void> {
    this.loading ??= this.loadOnce()
    return this.loading
  }

  private async loadOnce(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    const raw = await readJsonFile<Partial<PlaylistFile>>(this.filePath)
    if (raw) {
      this.playlists = Array.isArray(raw.playlists) ? raw.playlists : []
      // A cover folder that was cleared leaves a reference to a file that no
      // longer exists; the card would show a broken image instead of falling
      // back to the note glyph.
      for (const list of this.playlists) {
        if (list.coverPath && !existsSync(list.coverPath)) delete list.coverPath
      }
      for (const [id, tracks] of Object.entries(raw.items ?? {})) {
        this.items.set(id, tracks)
      }
    }
    if (!this.playlists.some((list) => list.id === 'default')) {
      this.playlists.unshift({
        id: 'default',
        name: '默认列表',
        source: 'local',
        position: 0
      })
    }
    if (!this.playlists.some((list) => list.id === 'favorites')) {
      this.playlists.push({ id: 'favorites', name: '我喜欢的', source: 'local', position: 1 })
    }
  }

  private async persist(): Promise<void> {
    const payload: PlaylistFile = {
      version: 1,
      playlists: this.playlists,
      items: Object.fromEntries(this.items)
    }
    await (this.options.write ?? writeJsonAtomic)(this.filePath, structuredClone(payload))
  }

  /** Serialize whole-list mutations; failed persistence restores the last committed state. */
  private async mutate<T>(change: () => T): Promise<T> {
    await this.load()
    const operation = this.changes.then(async () => {
      const beforeLists=structuredClone(this.playlists),beforeItems=structuredClone(this.items)
      try { const result=change(); await this.persist(); return result }
      catch(error) { this.playlists=beforeLists; this.items=beforeItems; throw error }
    })
    this.changes=operation.catch(()=>undefined)
    return operation
  }
  private state(id: string): SavedPlaylistSnapshot {
    const playlist=this.playlists.find(p=>p.id===id)
    if(!playlist)throw new Error('歌单不存在')
    const tracks=this.items.get(id)??[]
    return {playlist:structuredClone(playlist),tracks:structuredClone(tracks),revision:createHash('sha256').update(JSON.stringify([playlist,tracks])).digest('hex')}
  }
  /** One durable transaction; restoring never overwrites saved/system playlist identities. */
  async restoreBackup(snapshots:readonly PlaylistBackupSnapshot[]):Promise<import('@shared/playlist-backup').PlaylistRestoreResult>{
    const copied=structuredClone(snapshots)
    if(!copied.length||copied.length>PLAYLIST_BACKUP_MAX_LISTS||copied.reduce((n,s)=>n+s.tracks.length,0)>PLAYLIST_BACKUP_MAX_TRACKS)throw Error('恢复内容过多或为空')
    return this.mutate(()=>{
      let position=this.playlists.reduce((max,p)=>Math.max(max,p.position),-1)+1
      if(!Number.isSafeInteger(position)||position<0||position+copied.length>Number.MAX_SAFE_INTEGER)throw Error('现有歌单顺序无效')
      const ids:string[]=[]
      for(const snapshot of copied){
        let id:string
        do{id='list_'+randomUUID()}while(this.items.has(id)||this.playlists.some(p=>p.id===id))
        const playlist:Playlist={id,name:snapshot.playlist.name.length<=4092?snapshot.playlist.name+'（恢复）':snapshot.playlist.name,source:snapshot.playlist.source,position:position++,...(snapshot.playlist.sourceListId?{sourceListId:snapshot.playlist.sourceListId}:{})}
        this.playlists.push(playlist);this.items.set(id,snapshot.tracks);ids.push(id)
      }
      return{playlists:copied.length,tracks:copied.reduce((n,s)=>n+s.tracks.length,0),ids}
    })
  }
  /** Snapshot selected ordinary lists in one queue turn, bounding raw data before cloning. */
  async deriveSnapshot(ids:readonly string[]):Promise<SavedPlaylistSnapshot[]>{
    assertDeriveSelection(ids);const copied=ids.slice();await this.load()
    const operation=this.changes.then(()=>{
      let count=0,bytes=2
      for(const id of copied){
        const playlist=this.playlists.find(p=>p.id===id),tracks=this.items.get(id)??[]
        if(!playlist)throw Error('歌单已变更，请重新选择')
        if(typeof playlist.source!=='string'||!playlist.source||typeof playlist.name!=='string'||playlist.name.length>4096||!playlist.name.trim()||!Array.isArray(tracks))throw Error('来源歌单资料无效：'+id)
        count+=tracks.length;if(count>DERIVE_MAX_TRACKS)throw Error('输入曲目超过50000上限，请分批选择')
        bytes+=Buffer.byteLength(JSON.stringify(playlist),'utf8')+256 // snapshot envelope and revision overhead, bounded before cloning
        for(const track of tracks){
          if(!track||typeof track.id!=='string'||!track.id||track.id.length>256||track.id.includes('\0')||typeof track.name!=='string'||typeof track.singer!=='string'||(isLocalTrack(track)?!track.path||track.path.includes('\0'):typeof track.source!=='string'||!track.source||track.source==='local'))throw Error('来源歌单曲目身份无效：'+playlist.name)
          bytes+=Buffer.byteLength(JSON.stringify(track),'utf8')+1
          if(bytes>DERIVE_MAX_BYTES)throw Error('输入资料超过20MiB上限，请分批选择')
        }
        if(bytes>DERIVE_MAX_BYTES)throw Error('输入资料超过20MiB上限，请分批选择')
      }
      return copied.map(id=>this.state(id))
    })
    this.changes=operation.catch(()=>undefined);return operation
  }
  /** One durable creation with a CAS on every selected source; no whole-file snapshot replay. */
  async createDerived(sources:readonly {id:string;revision:string}[],outputs:readonly DerivedPlaylist[],assertReady:()=>void=()=>undefined):Promise<{ids:string[];playlists:number;tracks:number}>{
    assertDeriveSelection(sources.map(s=>s.id))
    if(!outputs.length||outputs.length>DERIVE_MAX_LISTS||outputs.reduce((n,s)=>n+s.tracks.length,0)>DERIVE_MAX_TRACKS||Buffer.byteLength(JSON.stringify(outputs),'utf8')>DERIVE_MAX_BYTES)throw Error('候选资料超过上限')
    const expected=sources.map(s=>({...s})),copied=structuredClone(outputs)
    return this.mutate(()=>{
      assertReady()
      for(const source of expected)if(!this.playlists.some(p=>p.id===source.id)||this.state(source.id).revision!==source.revision)throw Error('来源歌单已变更，请重新预览')
      let position=this.playlists.reduce((max,p)=>Math.max(max,p.position),-1)+1
      if(!Number.isSafeInteger(position)||position<0||!Number.isSafeInteger(position+copied.length))throw Error('现有歌单顺序无效')
      const ids:string[]=[]
      for(const candidate of copied){
        let id:string
        do{id='list_'+randomUUID()}while(this.items.has(id)||this.playlists.some(p=>p.id===id))
        this.playlists.push({id,name:candidate.name,source:candidate.source,position:position++,...(candidate.sourceListId?{sourceListId:candidate.sourceListId}:{}),...(candidate.coverPath?{coverPath:candidate.coverPath}:{})})
        this.items.set(id,candidate.tracks);ids.push(id)
      }
      return{ids,playlists:copied.length,tracks:copied.reduce((n,s)=>n+s.tracks.length,0)}
    })
  }
  async backupSnapshot(id?:string):Promise<PlaylistBackupSnapshot[]>{
    await this.load()
    const operation=this.changes.then(()=>{
      const lists=id?this.playlists.filter(p=>p.id===id):this.playlists.slice().sort((a,b)=>a.position-b.position)
      if(id&&!lists.length)throw Error('歌单不存在')
      if(lists.length>PLAYLIST_BACKUP_MAX_LISTS||lists.reduce((n,p)=>n+(this.items.get(p.id)?.length??0),0)>PLAYLIST_BACKUP_MAX_TRACKS)throw Error('备份内容过多，请分别导出歌单')
      return lists.map(playlist=>({playlist:structuredClone(playlist),tracks:structuredClone(this.items.get(playlist.id)??[])}))
    })
    this.changes=operation.catch(()=>undefined)
    return operation
  }
  async snapshot(id: string): Promise<SavedPlaylistSnapshot> { await this.load(); await this.changes; return this.state(id) }
  async flush(): Promise<void> { await this.load(); await this.changes }
  async applySnapshot(id: string, revision: string, tracks: PlayableTrack[]): Promise<Playlist> {
    const copied=structuredClone(tracks)
    return this.mutate(()=>{
      const current=this.state(id)
      if(current.revision!==revision)throw new Error('歌单已变更，请重新预览远程更改')
      if(id==='default'||id==='favorites'||current.playlist.source==='local'||!current.playlist.sourceListId)throw new Error('该歌单没有可刷新的远程来源')
      this.items.set(id,copied)
      return {...current.playlist,trackCount:copied.length}
    })
  }

  async list(): Promise<Playlist[]> {
    await this.load()
    await this.changes
    return this.playlists
      .slice()
      .sort((a, b) => a.position - b.position)
      .map((list) => ({ ...list, trackCount: this.items.get(list.id)?.length ?? 0 }))
  }

  async createFromQueue(name:string,tracks:PlayableTrack[]):Promise<QueuePlaylistResult>{
    const snapshot=prepareQueuePlaylist(name,tracks)
    return this.mutate(()=>{
      const position=this.playlists.reduce((max,p)=>Math.max(max,p.position),-1)+1
      if(!Number.isSafeInteger(position)||position<0)throw Error('现有歌单顺序无效')
      let id:string
      do{id='list_'+randomUUID()}while(this.items.has(id)||this.playlists.some(p=>p.id===id))
      const playlist:Playlist={id,name:snapshot.name,source:'local',position}
      this.playlists.push(playlist);this.items.set(id,snapshot.tracks)
      return{playlist:{...playlist},inputTracks:snapshot.inputTracks,tracks:snapshot.tracks.length,duplicates:snapshot.inputTracks-snapshot.tracks.length}
    })
  }

  async create(name: string, origin?: Pick<Playlist, 'source' | 'sourceListId'>): Promise<Playlist> {
    return this.mutate(()=>{
    const playlist: Playlist = {
      id: `list_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      name,
      source: origin?.source || 'local',
      ...(origin?.sourceListId ? { sourceListId: origin.sourceListId } : {}),
      position: this.playlists.length
    }
    this.playlists.push(playlist)
    this.items.set(playlist.id, [])
    return {...playlist}
    })
  }

  /** Minimal committed references, bounded without cloning artwork or opaque track data. */
  async localReferences():Promise<import('@shared/missing-files').LocalReferenceSnapshot>{
    await this.load()
    const operation=this.changes.then(()=>{
      const references:import('@shared/missing-files').LocalReferenceInput[]=[];let limited=false
      outer:for(const list of this.playlists){
        for(const track of this.items.get(list.id)??[]){
          if(!track||!isLocalTrack(track))continue
          if(references.length>=50000){limited=true;break outer}
          references.push({track:{id:track.id,path:track.path,name:track.name,singer:track.singer,...(track.albumName?{albumName:track.albumName}:{})},origin:{id:'playlist:'+list.id,name:list.name}})
        }
      }
      return{references,limited}
    })
    this.changes=operation.catch(()=>undefined)
    return operation
  }
  async removeMany(ids:readonly string[]):Promise<number>{
    if(!Array.isArray(ids)||!ids.length||ids.length>1000||ids.some(id=>typeof id!=='string'||!id.length||id.length>256)||new Set(ids).size!==ids.length)throw Error('批量删除参数无效')
    const copied=ids.slice()
    return this.mutate(()=>{
      if(copied.some(id=>id==='default'||id==='favorites'))throw Error('内置歌单不能批量删除')
      if(copied.some(id=>!this.playlists.some(p=>p.id===id)))throw Error('歌单已变更，请重新选择')
      const drop=new Set(copied)
      this.playlists=this.playlists.filter(p=>!drop.has(p.id))
      for(const id of copied)this.items.delete(id)
      return copied.length
    })
  }
  /** A consistent, bounded snapshot containing names only; never clones playlist tracks. */
  async renameSnapshot(ids:readonly string[]):Promise<Array<{id:string;name:string}>>{
    assertPlaylistBulkRenameSelection(ids);const copied=ids.slice();await this.load()
    const operation=this.changes.then(()=>{
      let bytes=2
      const rows:Array<{id:string;name:string}>=[]
      for(const id of copied){
        const playlist=this.playlists.find(item=>item.id===id)
        if(!playlist)throw Error('歌单已变更，请重新选择')
        if(id==='default'||id==='favorites')throw Error('内置歌单不能批量改名')
        assertPlaylistBulkRenameName(playlist.name)
        const row={id:playlist.id,name:playlist.name}
        bytes+=Buffer.byteLength(JSON.stringify(row),'utf8')+1
        if(bytes>PLAYLIST_BULK_RENAME_MAX_BYTES)throw Error('名称资料超过20MiB上限，请分批选择')
        rows.push(row)
      }
      return rows
    })
    this.changes=operation.catch(()=>undefined);return operation
  }
  /** Compare selected source names and update only names in one atomic mutation. */
  async renameMany(expected:readonly {id:string;name:string}[],changes:readonly {id:string;name:string}[],assertReady:()=>void=()=>undefined):Promise<number>{
    if(!Array.isArray(expected)||expected.length<1||expected.length>PLAYLIST_BULK_RENAME_MAX_LISTS)throw Error('改名来源数量无效')
    assertPlaylistBulkRenameSelection(expected.map(row=>row?.id))
    const expectedRows=expected.map(row=>{
      if(!row||typeof row!=='object')throw Error('改名来源资料无效')
      assertPlaylistBulkRenameName(row.name)
      return{id:row.id,name:row.name}
    })
    if(!Array.isArray(changes)||changes.length<1||changes.length>expectedRows.length)throw Error('没有可变更的歌单名称')
    const original=new Map(expectedRows.map(row=>[row.id,row.name]))
    const changedIds:string[]=[]
    const nextRows=changes.map(row=>{
      if(!row||typeof row!=='object'||typeof row.id!=='string'||!original.has(row.id))throw Error('改名目标不在预览范围内')
      assertPlaylistBulkRenameName(row.name)
      if(original.get(row.id)===row.name)throw Error('改名候选没有变化')
      changedIds.push(row.id)
      return{id:row.id,name:row.name}
    })
    if(new Set(changedIds).size!==changedIds.length)throw Error('改名目标重复')
    return this.mutate(()=>{
      assertReady()
      for(const source of expectedRows){
        const current=this.playlists.find(item=>item.id===source.id)
        if(!current||current.id==='default'||current.id==='favorites'||current.name!==source.name)throw Error('来源歌单已变更，请重新预览')
      }
      for(const change of nextRows){
        const current=this.playlists.find(item=>item.id===change.id)
        if(!current)throw Error('来源歌单已变更，请重新预览')
        current.name=change.name
      }
      return nextRows.length
    })
  }
  async remove(id: string): Promise<void> {
    return this.mutate(()=>{
    if (id === 'default' || id === 'favorites') throw new Error('内置歌单不能删除')
    this.playlists = this.playlists.filter((list) => list.id !== id)
    this.items.delete(id)
    })
  }

  async rename(id: string, name: string): Promise<void> {
    return this.mutate(()=>{
    const playlist = this.playlists.find((list) => list.id === id)
    if (!playlist) throw new Error('歌单不存在')
    playlist.name = name
    })
  }

  /** Attach cover art by path, or clear it with null. */
  async setCover(id: string, coverPath: string | null): Promise<void> {
    return this.mutate(()=>{
    const playlist = this.playlists.find((list) => list.id === id)
    if (!playlist) throw new Error('歌单不存在')
    if (coverPath === null) delete playlist.coverPath
    else playlist.coverPath = coverPath
    })
  }

  async getItems(id: string): Promise<PlayableTrack[]> {
    await this.load()
    await this.changes
    return structuredClone(this.items.get(id) ?? [])
  }

  /** Add tracks, skipping ones already present (matched by track id). */
  async addTracks(id: string, tracks: PlayableTrack[]): Promise<number> {
    const copied=structuredClone(tracks)
    return this.mutate(()=>{
    if(!this.playlists.some(p=>p.id===id))throw new Error('歌单不存在')
    const existing = this.items.get(id) ?? []
    const seen = new Set(existing.map(playlistEntryKey))
    let added = 0
    for (const track of copied) {
      if (seen.has(playlistEntryKey(track))) continue
      seen.add(playlistEntryKey(track))
      existing.push(track)
      added += 1
    }
    this.items.set(id, existing)
    return added
    })
  }

  /**
   * Fill in `meta.qualitys` for tracks already in a list, without touching anything
   * else about them.
   *
   * `addTracks` skips ids it already has, so a list imported before we learned to
   * read quality availability has no way to gain it — this is that missing write.
   *
   * Two things it deliberately cannot do: replace `meta` (every platform's resolver
   * needs `songmid` / `hash` / `albumId` / `copyrightId`, so the merge is per-key),
   * and reorder (the list is rebuilt with `map`, never filter+push, because a
   * playlist's order is user data — see the persistence regression suite).
   */
  async patchQualitys(
    id: string,
    qualitys: Array<{ id: string; qualitys: Array<{ type: string; size?: string }> }>
  ): Promise<number> {
    const copied=structuredClone(qualitys)
    return this.mutate(()=>{
    const existing = this.items.get(id) ?? []
    if (!existing.length || !qualitys.length) return 0
    const byId = new Map(copied.map((entry) => [entry.id, entry.qualitys]))
    let touched = 0
    const next = existing.map((track) => {
      const tiers = byId.get(track.id)
      if (!tiers || isLocalTrack(track)) return track
      if (JSON.stringify(tiers) === JSON.stringify(track.meta?.qualitys ?? [])) return track
      touched += 1
      return { ...track, meta: { ...track.meta, qualitys: tiers } }
    })
    if (!touched) return 0
    this.items.set(id, next)
    return touched
    })
  }

  /** Drop entries by track id. Returns how many actually left the list. */
  async removeTracks(id: string, trackIds: string[], byEntryKey = false): Promise<number> {
    return this.mutate(()=>{
    if(!this.playlists.some(p=>p.id===id))throw new Error('歌单不存在')
    const existing = this.items.get(id) ?? []
    const drop = new Set(trackIds)
    if(!byEntryKey){const selected=existing.filter(t=>drop.has(t.id));if(new Set(selected.map(t=>t.id)).size!==selected.length)throw Error('曲目身份不唯一，请重新打开歌单后操作')}
    const kept = existing.filter((track) => !drop.has(byEntryKey?playlistEntryKey(track):track.id))
    this.items.set(id, kept)
    const removed = existing.length - kept.length
    return removed
    })
  }

  /** Replace the whole ordering, used by drag-and-drop reordering. */
  async reorder(id: string, trackIds: string[], byEntryKey = false): Promise<void> {
    return this.mutate(()=>{
    if(!this.playlists.some(p=>p.id===id))throw new Error('歌单不存在')
    const existing = this.items.get(id) ?? []
    if(!byEntryKey&&new Set(existing.map(t=>t.id)).size!==existing.length)throw Error('曲目身份不唯一，请重新打开歌单后操作')
    const byId = new Map(existing.map((track) => [byEntryKey?playlistEntryKey(track):track.id, track]))
    const reordered: PlayableTrack[] = []
    for (const trackId of trackIds) {
      const track = byId.get(trackId)
      if (track) {
        reordered.push(track)
        byId.delete(trackId)
      }
    }
    // Anything the caller omitted keeps its relative order at the end.
    reordered.push(...byId.values())
    this.items.set(id, reordered)
    })
  }
}
