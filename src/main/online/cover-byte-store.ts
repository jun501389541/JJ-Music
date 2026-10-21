import { createHash } from 'node:crypto'
import { mkdir, readdir, lstat, open, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic } from '../store/json-file'
import type { CoverBytes } from './cover-fetch'
import { rasterMime } from './image-content'
import { ONLINE_CACHE_BYTES } from './cache-budget'

export interface CoverRef { hash: string; size: number; mimeType: string }
export function validCoverRef(value: unknown): value is CoverRef {
  const r = value as CoverRef | undefined
  return !!r && typeof r.hash === 'string' && /^[a-f0-9]{64}$/.test(r.hash) &&
    Number.isSafeInteger(r.size) && r.size > 0 && r.size <= 8 * 1024 * 1024 && ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif'].includes(r.mimeType)
}
export interface CoverByteStoreOptions { dir?: string; maxBytes?: number; onEvict?: (hash: string) => void; onIOError?: () => void }
/** Owns ONLY hashed .bin files inside its dedicated directory. Never returns paths. */
export class CoverByteStore {
  private readonly files = new Map<string, { size: number; bytes?: Uint8Array }>()
  private pending: Promise<unknown> = Promise.resolve()
  private dir?: string
  constructor(private readonly options: CoverByteStoreOptions = {}) { this.dir = options.dir }
  private disableDisk(): void {
    this.dir = undefined
    for (const [hash, entry] of this.files) if (!entry.bytes) { this.files.delete(hash); this.options.onEvict?.(hash) }
    this.options.onIOError?.()
  }
  private async checkDirectory(): Promise<boolean> {
    if (!this.dir) return false
    try {
      const info = await lstat(this.dir)
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('缓存目录不能为链接')
      return true
    } catch { this.disableDisk(); return false }
  }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const operation = this.pending.then(work)
    this.pending = operation.catch(() => undefined)
    return operation
  }
  async load(): Promise<void> {
    await this.serial(async () => {
      if (!this.dir) return
      try { await mkdir(this.dir, { recursive: true }) }
      catch (error) { this.disableDisk(); throw error }
      if (!await this.checkDirectory()) throw new Error('缓存目录不可用')
      const files: Array<{ hash: string; size: number; at: number }> = []
      for (const name of await readdir(this.dir!)) {
        if (!/^[a-f0-9]{64}\.bin$/.test(name)) continue
        const info = await lstat(join(this.dir!, name))
        if (!info.isFile() || info.isSymbolicLink()) continue
        files.push({ hash: name.slice(0, -4), size: info.size, at: info.mtimeMs })
      }
      for (const file of files.sort((a, b) => a.at - b.at)) this.files.set(file.hash, { size: file.size })
      await this.trim(0)
    })
  }
  private async remove(hash: string): Promise<void> {
    if (!/^[a-f0-9]{64}$/.test(hash)) return
    if (await this.checkDirectory()) {
      try { await unlink(join(this.dir!, `${hash}.bin`)) }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
    }
    this.files.delete(hash); this.options.onEvict?.(hash)
  }
  private async trim(incoming: number): Promise<void> {
    const used = (): number => [...this.files.values()].reduce((n, v) => n + v.size, 0)
    while (this.files.size && used() + incoming > (this.options.maxBytes ?? ONLINE_CACHE_BYTES.coverBytes)) await this.remove(this.files.keys().next().value!)
    if (incoming > (this.options.maxBytes ?? ONLINE_CACHE_BYTES.coverBytes)) throw new Error('封面超过缓存容量')
  }
  async put(image: CoverBytes): Promise<CoverRef> {
    const bytes = new Uint8Array(image.data)
    if (!bytes.length || bytes.length > 8 * 1024 * 1024 || rasterMime(bytes) !== image.mimeType) throw new Error('封面内容格式无效')
    const hash = createHash('sha256').update(bytes).digest('hex'), ref = { hash, size: bytes.length, mimeType: image.mimeType }
    return this.serial(async () => {
      await this.checkDirectory()
      if (!this.files.has(hash)) await this.trim(bytes.length)
      let memoryOnly = !this.dir
      if (this.dir) {
        try { await writeFileAtomic(join(this.dir, `${hash}.bin`), bytes) }
        catch { memoryOnly = true; this.options.onIOError?.() }
      }
      this.files.delete(hash); this.files.set(hash, { size: bytes.length, ...(memoryOnly ? { bytes } : {}) })
      return ref
    })
  }
  async read(ref: CoverRef): Promise<CoverBytes | null> {
    if (!validCoverRef(ref)) return null
    return this.serial(async () => {
      let data: Uint8Array
      try {
        const memory = this.files.get(ref.hash)?.bytes
        if (memory) data = new Uint8Array(memory)
        else if (await this.checkDirectory()) {
          const path = join(this.dir!, `${ref.hash}.bin`)
          if ((await lstat(path)).isSymbolicLink()) return null
          const file = await open(path, 'r')
          try {
            if ((await file.stat()).size !== ref.size) return null
            data = new Uint8Array(await file.readFile())
          } finally { await file.close() }
        } else {
          const bytes = this.files.get(ref.hash)?.bytes
          if (!bytes) return null
          data = new Uint8Array(bytes)
        }
        if (data.length !== ref.size || createHash('sha256').update(data).digest('hex') !== ref.hash || rasterMime(data) !== ref.mimeType) return null
      } catch { return null }
      const entry = this.files.get(ref.hash)
      if (entry) { this.files.delete(ref.hash); this.files.set(ref.hash, entry) }
      return { data, mimeType: ref.mimeType }
    })
  }
  async clear(): Promise<void> { await this.serial(async () => { for (const hash of this.files.keys()) await this.remove(hash) }) }
  async flush(): Promise<void> { await this.pending }
}
