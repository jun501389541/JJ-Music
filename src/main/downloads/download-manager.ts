import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, readdir, rm, link, copyFile, rename, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join } from 'node:path'
import { parseFile } from 'music-metadata'
import type { AppSettings, DownloadTask, LyricResult, OnlineMusicInfo, Quality } from '@shared/types'
import { LX_QUALITIES } from '@shared/types'
import { canWriteTags } from '../library/tag-writer'
import { exportAssets } from '../library/asset-export'
import { readBounded } from '../online/read-bounded'
import { COVER_HOSTS } from '../online/cover-fetch'
import { parseJsonLoose, writeJsonAtomic } from '../store/json-file'

export function audioExtension(container: string, codec: string): string {
  container=container.toLowerCase();codec=codec.toLowerCase()
  if (container.includes('adts')) return '.aac'
  if (/m4a|mp4|mpeg-4/.test(container)) return '.m4a'
  if (container.includes('flac')) return '.flac'
  if (container.includes('adts') || codec.includes('aac')) return '.aac'
  if (container.includes('mpeg')) return '.mp3'
  if (container.includes('ogg')) return '.ogg'
  if (container.includes('wave')) return '.wav'
  return ''
}

/** Keep no-overwrite semantics on both NTFS and filesystems without hard links. */
export async function publishExclusive(source: string, target: string, fs = {link,copyFile}): Promise<void> {
  try { await fs.link(source,target) } catch(error) {
    if (!['ENOTSUP','EOPNOTSUPP','EPERM','EXDEV','EINVAL','ENOSYS'].includes((error as NodeJS.ErrnoException).code || '')) throw error
    await fs.copyFile(source,target,constants.COPYFILE_EXCL)
  }
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve,reject)=>{
    const abort=():void=>reject(signal.reason || new Error('操作已取消'))
    signal.addEventListener('abort',abort,{once:true})
    if(signal.aborted)abort()
    promise.then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort))
  })
}

export function safeName(value: string): string {
  const name = value.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').slice(0, 100).replace(/[. ]+$/g, '')
  return !name || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name) ? `_${name || '歌曲'}` : name
}

/** Preserve original/translation/romanization with identical timestamps in one LRC. */
export function mergeLyrics(lyrics: LyricResult, translation: boolean, romanization: boolean): string {
  const parts = [lyrics.lyric, translation ? lyrics.tlyric : '', romanization ? lyrics.rlyric : ''].filter(Boolean) as string[]
  const timed: Array<{ time: number; text: string; order: number }> = [], plain: string[] = []
  for (const [order, part] of parts.entries()) for (const line of part.split(/\r?\n/)) {
    const stamps = [...line.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)]
    if (!stamps.length) { if (line.trim() && !plain.includes(line)) plain.push(line); continue }
    const text = line.replace(/\[\d+:\d+(?:\.\d+)?\]/g, '')
    for (const stamp of stamps) timed.push({ time: Number(stamp[1]) * 60 + Number(stamp[2]), text: stamp[0] + text, order })
  }
  return [...plain, ...timed.sort((a,b) => a.time-b.time || a.order-b.order).map(item => item.text)].join('\n')
}

interface Dependencies {
  settings: () => AppSettings
  defaultFolder: string
  resolve: (track: OnlineMusicInfo, quality: Quality) => Promise<{ url: string; quality: Quality }>
  lyrics: (track: OnlineMusicInfo) => Promise<LyricResult>
  cover: (track: OnlineMusicInfo) => Promise<string>
  /**
   * The one HTTP seam, and `allowedHosts` rides on it.
   *
   * The audio URL and the cover URL need different guarantees, so the pin cannot
   * be baked into the injected function. An audio URL legitimately lives on
   * whatever relay the 音源 picked and the most that can be asked of it is
   * "public http(s)"; a cover comes from a small known host family per platform
   * (`COVER_HOSTS`). The caller that knows `track.source` is this file, so this
   * file decides the pin and the injection just forwards it to
   * `safeFetchResponse` — which is where it has to arrive, because the redirect
   * loop in there re-validates every hop against it.
   */
  fetch?: GuardedFetch
  /**
   * Send one path to the system recycle bin. Injected rather than imported:
   * `shell.trashItem` only exists in the main process, and this module is imported
   * by the unit tests, which must be able to watch what a removal asks for without
   * anything actually leaving the disk.
   */
  trash: (path: string) => Promise<void>
}

/**
 * `fetch`, plus the optional host pin.
 *
 * Structurally a superset of `fetch`, so a plain one-argument stub satisfies it —
 * which is what every existing test injects, and they keep testing the unpinned
 * shape they were written against.
 */
export type GuardedFetch = (
  url: string,
  init?: RequestInit & { allowedHosts?: string[] }
) => Promise<Response>
export class DownloadManager {
  private tasks: DownloadTask[] = []
  private controllers = new Map<string, AbortController>()
  /** Per-task settle promise, so a removal can wait for its own download to stop. */
  private settled = new Map<string, Promise<void>>()
  private active = 0
  private closing = false
  private running = new Set<Promise<void>>()
  private saving = Promise.resolve()
  private file: string
  constructor(dataDir: string, private deps: Dependencies) { this.file = join(dataDir, 'downloads.json') }
  async load(): Promise<void> {
    try {
      const saved = parseJsonLoose<DownloadTask[]>(await readFile(this.file, 'utf8'))
      if (Array.isArray(saved)) this.tasks = saved.filter(t => t?.id && t?.track?.meta && LX_QUALITIES.includes(t.quality)).slice(-1000).map(t => ({ ...t, warnings: Array.isArray(t.warnings) ? t.warnings : [], ...(!['completed','failed','cancelled'].includes(t.status) ? {status:'failed',error:'上次退出时下载中断，重试会从断点继续'} : {}) }))
    } catch { /* first launch */ }
  }
  list(): DownloadTask[] { return structuredClone(this.tasks) }
  private save(): void {
    const terminal=this.tasks.filter(t=>['completed','failed','cancelled'].includes(t.status))
    if(terminal.length>500){const retained=new Set(terminal.slice(-500).map(t=>t.id));this.tasks=this.tasks.filter(t=>!['completed','failed','cancelled'].includes(t.status)||retained.has(t.id))}
    const snapshot = this.list()
    this.saving = this.saving.catch(() => undefined).then(() => writeJsonAtomic(this.file, snapshot)).catch(error => console.error('下载记录保存失败', error))
  }
  add(tracks: OnlineMusicInfo[], quality: Quality): string[] {
    if (this.closing) throw Error('播放器正在退出')
    if (!Array.isArray(tracks) || !tracks.length || tracks.length > 500 || !LX_QUALITIES.includes(quality)) throw Error('下载参数无效（每批最多 500 首）')
    if (tracks.some(t => !t?.id || !t.name || !t.source || !t.meta || 'path' in t)) throw Error('只能下载在线歌曲')
    if (this.tasks.filter(t => !['completed','failed','cancelled'].includes(t.status)).length + tracks.length > 500) throw Error('下载队列最多 500 首')
    const ids: string[] = []
    for (const track of tracks) {
      const existing = this.tasks.find(t => t.track.id === track.id && t.quality === quality && !['completed','failed','cancelled'].includes(t.status))
      if (existing) { ids.push(existing.id); continue }
      const task: DownloadTask = {id:randomUUID(),track:structuredClone(track),quality,status:'queued',received:0,warnings:[],createdAt:Date.now()}
      this.tasks.push(task); ids.push(task.id)
    }
    this.save(); this.pump(); return ids
  }
  cancel(id: string): void {
    const task = this.tasks.find(t => t.id === id)
    if (!task || ['completed','failed','cancelled'].includes(task.status)) return
    this.controllers.get(id)?.abort(); task.status = 'cancelled'; this.save()
  }
  retry(id: string): void {
    if (this.closing) throw Error('播放器正在退出')
    const task = this.tasks.find(t => t.id === id)
    if (!task || !['failed','cancelled'].includes(task.status) || this.controllers.has(id)) throw Error('任务尚未停止或无需重试')
    task.status='queued'; task.received=0; task.total=undefined; task.path=undefined; task.lyricPath=undefined; task.error=undefined; task.warnings=[]
    this.save(); this.pump()
  }
  private pump(): void {
    while (!this.closing && this.active < 2) {
      const task = this.tasks.find(t => t.status === 'queued')
      if (!task) break
      task.status='resolving'; this.active++
      const running=this.run(task).finally(() => { this.active--; this.controllers.delete(task.id); this.settled.delete(task.id); this.running.delete(running); this.save(); this.pump() })
      this.running.add(running); this.settled.set(task.id, running)
    }
  }
  /**
   * 移除一条记录，必要时把它产出的文件送进回收站。
   *
   * 为什么是主进程里的一个动作而不是"渲染层先 cancel 再 remove"：两次 IPC 之间这个
   * 任务可能刚好跑完并发布了文件，于是记录没了、文件还在，成为一个没人指向它的孤儿。
   * 这里先 abort，再等它自己停下来（`settled`），此后 `run()` 已经不会再写任何文件，
   * 删除记录才是安全的。
   *
   * 路径只从本进程自己那份 task 记录里取。渲染层只给 `{id, deleteFile}`：一个字符串
   * 路径在那里只是"关于某个文件的声明"，不是证据（同 `allowedMediaPath` 的教训）。
   *
   * 删文件一律走回收站。回收站不支持这个路径（网络盘、某些可移动盘）时
   * `trash` 会 reject，这里原样抛出并且**不移除记录** —— 不静默失败，也不退化成永久删除。
   */
  async remove(id: string, deleteFile: boolean): Promise<void> {
    if (typeof id !== 'string' || !id) throw Error('下载记录无效')
    if (typeof deleteFile !== 'boolean') throw Error('删除参数无效')
    const index = this.tasks.findIndex(t => t.id === id)
    if (index < 0) throw Error('这条下载记录已经不存在了')
    const task = this.tasks[index]
    this.controllers.get(id)?.abort()
    // Give the download a moment to actually stop before its record goes: while it is
    // still running, `.jj-<id>.part` has an open file handle and the cleanup below
    // would fail on it. Bounded, because a stream that ignores its abort signal must
    // not be able to hang the button the user pressed — worst case the scratch file
    // outlives the record by one `finally`.
    await Promise.race([this.settled.get(id)?.catch(() => undefined), new Promise(r => setTimeout(r, 5000).unref?.())])
    if (deleteFile) {
      // 只删这一次下载产出的东西：音频本体，外加当时确实由我们写出去的那个 sidecar
      // `.lrc`。sidecar 是不覆盖语义，旁边完全可能放着用户自己写的同名文件。
      const targets = [task.path, this.ownSidecar(task)].filter((p): p is string => !!p)
      for (const target of targets) {
        if (!isAbsolute(target)) throw Error('下载记录里的文件路径无效，已停止移除')
        try { if (!(await stat(target)).isFile()) throw Error('那不是文件') }
        catch (error) {
          // 文件已经不在了不是失败：记录指向的东西早已被删，移除记录即可。
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
          throw Error(`无法移到回收站：${target}（${error instanceof Error ? error.message : '原因未知'}），记录未移除`)
        }
        try { await this.deps.trash(target) }
        catch (error) { throw Error(`移到回收站失败：${target}（${error instanceof Error ? error.message : '原因未知'}），记录未移除`) }
      }
    }
    const removed = this.tasks.splice(index, 1)[0]
    this.save()
    // 应用自己的临时件（`.jj-<id>.part` / 暂存 / `-tagged`）无论如何都清掉：
    // 记录已经不在了，没有人会再来续传或重试它，留着就是纯粹的残留。
    await this.cleanScratch(removed.id)
  }
  /** The sidecar `.lrc` this task wrote, but only if it is still shaped like one. */
  private ownSidecar(task: DownloadTask): string | undefined {
    if (!task.lyricPath || !task.path || !isAbsolute(task.lyricPath)) return undefined
    const audio = task.path
    const expected = join(dirname(audio), basename(audio, extname(audio)) + '.lrc')
    return task.lyricPath === expected ? task.lyricPath : undefined
  }
  /** Delete this task's own `.jj-<id>*` scratch files in the folder it downloads to. */
  private async cleanScratch(id: string): Promise<void> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return
    const folder = this.deps.settings().downloadFolder || this.deps.defaultFolder
    let names: string[] = []
    try { names = await readdir(folder) } catch { return }
    await Promise.all(names.filter(n => n.startsWith(`.jj-${id}`)).map(n => rm(join(folder, n), { force: true }).catch(() => undefined)))
  }
  async shutdown(): Promise<void> {
    this.closing=true
    for(const task of this.tasks) if(task.status==='queued') {task.status='failed';task.error='退出时下载未开始，请重试'}
    for(const controller of this.controllers.values()) controller.abort(new Error('退出时下载未完成，请重试'))
    await Promise.allSettled([...this.running])
    this.save();await this.saving
  }
  private async run(task: DownloadTask): Promise<void> {
    const controller = new AbortController(); this.controllers.set(task.id, controller)
    const signal = controller.signal, http = this.deps.fetch || fetch
    const timeout = setTimeout(() => controller.abort(new Error('下载超时，请重试')), 15 * 60_000)
    const settings = this.deps.settings()
    const folder = settings.downloadFolder || this.deps.defaultFolder
    let temp = '', stage = ''
    // Set once the partial file exists on disk: it is what makes a retry continue
    // instead of starting over, so the cleanup in `finally` must not eat it.
    let keepPart = false
    try {
      if (!isAbsolute(folder)) throw Error('请选择有效的下载目录')
      await mkdir(folder, {recursive:true})
      const resolved = await abortable(this.deps.resolve(task.track, task.quality),signal)
      signal.throwIfAborted()
      if (resolved.quality !== task.quality) throw Error('音源未返回所选音质')
      if (!/^https?:\/\//i.test(resolved.url)) throw Error('音频地址无效')
      temp=join(folder, `.jj-${task.id}.part`)
      // From here on the bytes already on disk are worth keeping. Setting this
      // only after the body was opened meant the common failures — no route, a
      // timeout, a 403 from the relay — ran the cleanup below and deleted the
      // very part this task had just resumed from, so 重试 started over at 0.
      keepPart = true
      const headers: Record<string, string> = {}
      // How much of *this* task is already on disk. The file is named after the
      // task id, so a leftover can only ever belong to this same song and quality.
      let offset = 0
      try { offset = Math.max(0, (await stat(temp)).size) } catch { offset = 0 }
      if (offset > 0) {
        headers.Range = `bytes=${offset}-`
        // `If-Range` is what makes resuming safe rather than lucky: if the server's
        // copy changed since the part was written it answers 200 with the whole
        // body, and we start over instead of gluing two recordings together.
        if (task.etag) headers['If-Range'] = task.etag
        else if (task.lastModified) headers['If-Range'] = task.lastModified
      }
      const response = await http(resolved.url, {signal, headers})
      if (!response.ok || !response.body) { await response.body?.cancel(); throw Error(`下载请求失败 HTTP ${response.status}`) }
      task.status='downloading'
      // A 206 is the only answer that means "here is the rest of the file". Anything
      // else — including a 200 that ignored the Range — is a full body from byte 0.
      let resuming = offset > 0 && response.status === 206
      if (resuming) {
        const range = /^bytes\s+(\d+)-(\d+)\/(\d+)\s*$/i.exec(response.headers.get('content-range') ?? '')
        // A 206 that does not say which segment it is gets no trust either.
        const start = range ? Number(range[1]) : Number.NaN
        const whole = range ? Number(range[3]) : Number.NaN
        const startsWhereAsked = start === offset
        // …and it has to be *our* file. With an `If-Range` the server checks the
        // validator itself and answers 200 when the copy changed. Without one
        // (some relays send no ETag), the length is the only signal left, so the
        // total in this response must be the one the first attempt reported.
        const stillTheSameFile = Number.isFinite(whole) && (task.etag || task.lastModified || !task.remoteSize
          ? true
          : whole === task.remoteSize)
        if (!startsWhereAsked || !stillTheSameFile) {
          // Appending a segment we did not ask for, or one from a different
          // version of the song, is what produces a file that plays but is wrong.
          await response.body?.cancel?.()
          await rm(temp, { force: true }).catch(() => undefined)
          keepPart = false
          temp = ''
          throw Error('服务器返回的分段与已下载内容对不上，重试会重新下载整份文件')
        }
      }
      if (offset > 0 && !resuming) offset = 0
      task.etag = response.headers.get('etag') ?? undefined
      task.lastModified = response.headers.get('last-modified') ?? undefined
      const fullLength = Number(/\/(\d+)\s*$/.exec(response.headers.get('content-range') ?? '')?.[1])
        || Number(response.headers.get('content-length')) || undefined
      task.received = offset
      // `content-length` on a 206 counts only what is still coming, so the total has
      // to come from `content-range`; on a 200 the two are the same number.
      task.total = resuming ? fullLength : (fullLength ? fullLength + offset : undefined)
      // Remembered for the next attempt's `stillTheSameFile` check, and not
      // cleared by `retry()` — it describes the remote object, not this attempt.
      if (fullLength) task.remoteSize = fullLength
      const file=await open(temp, resuming ? 'a' : 'w')
      try {
        for await (const chunk of response.body) {
          signal.throwIfAborted()
          task.received += chunk.length
          if (task.received > 1024 ** 3) throw Error('文件超过 1 GB 下载上限')
          await file.writeFile(chunk)
        }
      } finally { await file.close() }
      signal.throwIfAborted()
      if (!task.received) throw Error('下载文件为空')
      // A closed stream that never reached the declared length is a partial file,
      // not a finished one: keep it and say so, so 重试 picks up where this stopped.
      if (task.total && task.received < task.total) throw Error(`下载未完成（${task.received}/${task.total}），重试将从断点继续`)
      keepPart = false
      const metadata = await parseFile(temp)
      const container = (metadata.format.container || '').toLowerCase()
      const codec = (metadata.format.codec || '').toLowerCase()
      const ext = audioExtension(container,codec)
      if (!ext || !metadata.format.sampleRate) throw Error('下载内容不是受支持的音频文件')
      if (task.quality.startsWith('flac') && !metadata.format.lossless) throw Error('音源返回有损音频，与所选无损音质不符')
      if (task.quality === '320k' && !metadata.format.lossless && metadata.format.bitrate && metadata.format.bitrate < 288000) throw Error('音源返回音频的码率明显低于所选 320k 音质')
      if (task.quality === 'flac24bit' && (metadata.format.bitsPerSample || 0) < 24) throw Error('音源返回的音频不足 24 bit，与所选音质不符')
      stage=join(folder, `.jj-${task.id}${ext}`)
      await rename(temp,stage); temp=''
      task.status='tagging'
      let lyricText='', cover: {data:Uint8Array;mimeType:string} | undefined
      if (settings.downloadLyric || settings.downloadEmbedLyric) {
        try {
          lyricText=mergeLyrics(await abortable(this.deps.lyrics(task.track),signal), settings.downloadTranslation, settings.downloadRomanization)
          if (!lyricText.trim()) task.warnings.push('平台未提供歌词')
        } catch { task.warnings.push('歌词获取失败') }
      }
      signal.throwIfAborted()
      if (settings.downloadEmbedCover) {
        try {
          /*
           * The picture URL comes from the platform, and it ends up *inside the
           * user's audio file* — so it is pinned to that platform's image host
           * family before anything is fetched. Two things are why this is not
           * just a nicety:
           *
           * A source with no entry here gets no cover rather than an unpinned
           * fetch. The 音源脚本 platforms (`qs`, `qsvip`) return whichever host the
           * user's imported script names, which is exactly the set nobody can
           * vouch for, and refusing costs only the picture.
           *
           * The pin is passed *into* the request rather than checked around it,
           * because `safeFetchResponse` follows redirects by hand and
           * re-validates each hop against the same list. Checking only the first
           * URL would leave `302 Location: http://127.0.0.1:1887/` free to walk
           * straight through — the hole `url-guard.ts` documents at the top.
           */
          const allowedHosts = task.track.source ? COVER_HOSTS[task.track.source] : undefined
          if (!allowedHosts) throw Error('该平台没有可钉的封面域名')
          const url=await abortable(this.deps.cover(task.track),signal)
          if (!/^https?:\/\//i.test(url)) throw Error('无封面')
          const res=await http(url,{signal:AbortSignal.any([signal,AbortSignal.timeout(15000)]),allowedHosts})
          const data=await readBounded(res,10*1024*1024)
          const mimeType=data[0]===0xff && data[1]===0xd8 ? 'image/jpeg' : data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? 'image/png' : ''
          if (!mimeType) throw Error('封面格式不支持')
          cover={data,mimeType}
        } catch { task.warnings.push('封面获取失败或格式不支持') }
      }
      signal.throwIfAborted()
      if (ext === '.mp3' || ext === '.flac') {
        // Preserve the pristine staging file if a tag writer fails midway.
        const tagged=join(folder, `.jj-${task.id}-tagged${ext}`)
        try {
          await copyFile(stage,tagged)
          const result=await exportAssets({audioPath:tagged,stagingPath:tagged,patch:{title:task.track.name,artist:task.track.singer,album:task.track.albumName,lyrics:settings.downloadEmbedLyric ? lyricText : undefined,cover},to:['embedded'],writableFormats:settings.tagWritableFormats,skipBackup:true})
          if (!result.written) throw Error(result.note)
          await rm(stage); stage=tagged
        } catch(error) { task.warnings.push(`标签写入失败：${error instanceof Error ? error.message : error}`); await rm(tagged,{force:true}); await rm(tagged+'.jjtmp',{force:true}) }
      } else if (settings.downloadEmbedLyric || settings.downloadEmbedCover) task.warnings.push('此格式暂不支持嵌入标签，已保留原音频；歌词保存为 LRC')
      signal.throwIfAborted()
      const stem=safeName(`${task.track.singer} - ${task.track.name}`) + ` [${task.quality}]`
      let target=''
      for(let i=0;i<10000;i++) {
        target=join(folder,stem+(i?` (${i})`:'')+ext)
        signal.throwIfAborted()
        try { await publishExclusive(stage,target); break } catch(error) { if ((error as NodeJS.ErrnoException).code!=='EEXIST' || i===9999) throw error }
      }
      if(signal.aborted){await rm(target,{force:true});signal.throwIfAborted()}
      task.path=target
      // Publication is the commit point: cancellation must not label a saved file as cancelled.
      task.status='completed'
      if (lyricText && (settings.downloadLyric || (settings.downloadEmbedLyric && !canWriteTags(target, settings.tagWritableFormats)))) {
        // The same writer every other lyric uses, with 不覆盖 on: this pass is
        // automatic, so a `.lrc` the user wrote by hand is left alone.
        try {
          const saved = await exportAssets({ audioPath: target, patch: { lyrics: lyricText }, to: ['sidecar'], noClobber: true })
          // Record exactly the file this write produced, so 「删除文件」 can tell it
          // apart from a `.lrc` the user wrote themselves — `noClobber` means the
          // neighbour may not be ours at all.
          if (saved.written) task.lyricPath = saved.paths.find(p => p.toLowerCase().endsWith('.lrc'))
          else task.warnings.push(saved.notes.join('；') || 'LRC 保存失败')
        } catch { task.warnings.push('LRC 保存失败') }
      }
    } catch(error) {
      if (task.status !== 'cancelled') { task.status='failed'; task.error=error instanceof Error ? error.message : String(error) }
    } finally {
      clearTimeout(timeout)
      // The partial file survives exactly when it is still useful: a failed or
      // aborted download keeps its bytes so 重试 can continue. Once the body has
      // been renamed into the staging file (`temp` is cleared) there is nothing to
      // keep, and a completed task never gets here with `keepPart` set.
      if(temp && !keepPart)await rm(temp,{force:true}).catch(()=>undefined)
      if(stage)await rm(stage,{force:true}).catch(()=>undefined)
    }
  }
}
