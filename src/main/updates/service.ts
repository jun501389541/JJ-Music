import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat } from 'node:fs/promises'
import { basename } from 'node:path'
import type { UpdateStatus } from '../../shared/update-types'
import { checkLatestMetadata, parseAndVerifyManifest, type VerifiedManifest } from './manifest'

export interface ReleasePayload {
  bytes: Buffer
  signature: string
  latest: string
  tag: string
  assetName: string
  assetSize: number
  notes: string
}

interface UpdaterAdapter {
  checkForUpdates(): Promise<{ version: string; files: Array<{ url: string; sha512: string }> } | null>
  downloadUpdate(token: { cancel(): void }): Promise<string[]>
  quitAndInstall(): void
  onProgress(listener: (percent: number) => void): void
  onDownloaded(listener: (path: string) => void): void
}

interface Dependencies {
  currentVersion: string
  publicKey: string
  available: boolean
  source: { load(): Promise<ReleasePayload> }
  updater: UpdaterAdapter
  token(): { cancel(): void }
}

async function verifyFile(path: string, manifest: VerifiedManifest): Promise<void> {
  const before = await lstat(path)
  if (basename(path) !== manifest.setup.name || !before.isFile() || before.isSymbolicLink() ||
      before.size !== manifest.setup.size) {
    throw new Error('安装包名称或大小与签名清单不符')
  }
  const sha256 = createHash('sha256')
  const sha512 = createHash('sha512')
  for await (const chunk of createReadStream(path)) {
    sha256.update(chunk)
    sha512.update(chunk)
  }
  const after = await lstat(path)
  if (!after.isFile() || after.isSymbolicLink() || after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
    throw new Error('安装包在校验期间发生变化')
  }
  if (sha256.digest('hex') !== manifest.setup.sha256 || sha512.digest('base64') !== manifest.setup.sha512) {
    throw new Error('安装包摘要与签名清单不符')
  }
}

export class UpdateService {
  private state: UpdateStatus
  private manifest: VerifiedManifest | null = null
  private downloadedFile: string | null = null
  private downloadedEventFile: string | null = null
  private activeToken: { cancel(): void } | null = null
  private listeners = new Set<(state: UpdateStatus) => void>()

  constructor(private readonly deps: Dependencies) {
    this.state = { phase: deps.available ? 'idle' : 'unavailable', currentVersion: deps.currentVersion,
      message: deps.available ? undefined : '此版本尚未通过安装版升级验收，在线更新暂不可用' }
    deps.updater.onProgress(percent => {
      if (this.state.phase === 'downloading' && Number.isFinite(percent)) {
        this.set({ ...this.state, progress: Math.min(100, Math.max(0, percent)) })
      }
    })
    deps.updater.onDownloaded(path => { this.downloadedEventFile = path })
  }

  getState(): UpdateStatus { return { ...this.state } }
  onState(listener: (state: UpdateStatus) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  private set(state: UpdateStatus): UpdateStatus {
    this.state = state
    for (const listener of this.listeners) listener(this.getState())
    return this.getState()
  }
  private requireAvailable(): void {
    if (!this.deps.available) throw new Error('在线更新尚未通过安装版升级验收')
  }
  private fail(error: unknown): never {
    // Updater/network exceptions can contain cache paths or redirected URLs.
    // A fixed message is the only error text allowed across the IPC boundary.
    const message = '更新检查或校验失败，请重试或前往官方 Release 手动下载'
    this.set({ ...this.state, phase: 'error', progress: undefined, message })
    throw new Error(message, { cause: error })
  }

  async check(): Promise<UpdateStatus> {
    this.requireAvailable()
    if (this.state.phase === 'checking' || this.state.phase === 'downloading') throw new Error('更新任务正在进行')
    this.manifest = null
    this.downloadedFile = null
    this.set({ phase: 'checking', currentVersion: this.deps.currentVersion })
    try {
      const release = await this.deps.source.load()
      const manifest = parseAndVerifyManifest(release.bytes, release.signature, this.deps.publicKey, this.deps.currentVersion, true)
      if (release.tag !== manifest.tag || release.assetName !== manifest.setup.name || release.assetSize !== manifest.setup.size) {
        throw new Error('Release 与签名清单不一致')
      }
      checkLatestMetadata(release.latest, manifest)
      if (manifest.version === this.deps.currentVersion) {
        return this.set({ phase: 'current', currentVersion: this.deps.currentVersion, message: '已是最新版本' })
      }
      const metadata = await this.deps.updater.checkForUpdates()
      if (metadata?.version !== manifest.version || metadata.files.length !== 1 ||
          metadata.files[0]?.url !== manifest.setup.name || metadata.files[0]?.sha512 !== manifest.setup.sha512) {
        throw new Error('下载元数据与签名清单不一致')
      }
      this.manifest = manifest
      return this.set({ phase: 'available', currentVersion: this.deps.currentVersion, version: manifest.version,
        notes: release.notes, size: manifest.setup.size,
        releaseUrl: `https://github.com/jun501389541/JJ-Music/releases/tag/${manifest.tag}` })
    } catch (error) { return this.fail(error) }
  }

  async download(): Promise<UpdateStatus> {
    this.requireAvailable()
    if (this.state.phase !== 'available' || !this.manifest) throw new Error('请先检查更新')
    const manifest = this.manifest
    this.downloadedEventFile = null
    const token = this.deps.token()
    this.activeToken = token
    this.set({ ...this.state, phase: 'downloading', progress: 0 })
    try {
      const paths = await this.deps.updater.downloadUpdate(token)
      if (this.activeToken !== token) throw new Error('下载已取消')
      const path = this.downloadedEventFile ?? paths[0]
      if (!path || (this.downloadedEventFile && paths.length && !paths.includes(path))) throw new Error('无法确认下载文件')
      await verifyFile(path, manifest)
      this.downloadedFile = path
      return this.set({ ...this.state, phase: 'ready', progress: 100 })
    } catch (error) {
      if (this.activeToken !== token) return this.getState()
      return this.fail(error)
    } finally { if (this.activeToken === token) this.activeToken = null }
  }

  cancel(): UpdateStatus {
    if (this.state.phase !== 'downloading' || !this.activeToken) return this.getState()
    this.activeToken.cancel()
    this.activeToken = null
    return this.set({ ...this.state, phase: 'available', progress: undefined, message: '下载已取消' })
  }

  async install(): Promise<void> {
    this.requireAvailable()
    if (this.state.phase !== 'ready' || !this.manifest || !this.downloadedFile) throw new Error('安装包尚未就绪')
    try {
      await verifyFile(this.downloadedFile, this.manifest)
      this.deps.updater.quitAndInstall()
    } catch (error) { this.fail(error) }
  }
}
