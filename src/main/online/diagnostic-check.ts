import { normalizeOnlineError, onlineContext } from './reliability-policy'
import { rasterMime } from './image-content'

export function validDiagnosticCover(value: { data?: Uint8Array; mimeType?: string } | null): boolean {
  return !!value?.data && value.data.byteLength > 0 && value.data.byteLength <= 8 * 1024 * 1024 && rasterMime(value.data) === value.mimeType
}

export const DIAGNOSTIC_LEVELS = ['synthetic', 'catalog', 'resolution', 'media', 'listening'] as const
const PLATFORMS = ['wy', 'tx'] as const
const CATALOG_CAPABILITIES = ['search', 'lyric', 'cover', 'artistDetail', 'albumDetail', 'playlist'] as const
const CAPABILITIES = [...CATALOG_CAPABILITIES, 'initialize', 'musicUrl', 'audioHead'] as const
type Level = typeof DIAGNOSTIC_LEVELS[number]
type Platform = typeof PLATFORMS[number]
type Capability = typeof CAPABILITIES[number]
type Status = 'passed' | 'failed' | 'cancelled' | 'timeout' | 'notRun'
type Mode = 'synthetic' | 'live'
interface CheckRecord { platform?: Platform; capability?: Capability; status: Status; elapsedMs?: number; code?: string; adapterRevision?: string; providerVersion?: string; httpStatus?: number; bytes?: number; format?: string }
export interface DiagnosticReport { schema: 1; mode: Mode; levels: Record<Level, CheckRecord[]> }
export interface DiagnosticArgs {
  mode: Mode; platforms: Platform[]; capabilities: Capability[]
  config?: string; source?: string; report?: string; help?: boolean; media?: boolean
}

/** Validate the whole invocation before the caller reads any config or script. */
export function parseDiagnosticArgs(args: string[], kind: 'source' | 'catalog'): DiagnosticArgs {
  const fields = new Map<string, string | true>()
  for (let i = 0; i < args.length; i++) {
    const key = args[i]!
    if (!['--live', '--help', '--config', '--source', '--platform', '--capability', '--report', '--media'].includes(key) || fields.has(key)) throw new Error('诊断参数无效或重复')
    if (key === '--live' || key === '--help' || key === '--media') fields.set(key, true)
    else {
      const value = args[++i]
      if (!value || value.startsWith('--') || value.length > 4096) throw new Error('诊断参数缺少值')
      fields.set(key, value)
    }
  }
  if (fields.has('--help')) {
    if (fields.size !== 1) throw new Error('帮助参数不能与检查参数混用')
    return { mode: 'synthetic', platforms: [], capabilities: [], help: true }
  }
  const live = fields.has('--live')
  if (fields.has('--media') && (!live || kind !== 'source')) throw new Error('音频首字节检查需要显式live源诊断')
  if (!live && ['--config', '--source', '--platform', '--capability'].some(key => fields.has(key))) throw new Error('实际资料参数必须显式使用 --live')
  if (live && (!fields.has('--config') || !fields.has('--platform') || (kind === 'source' && !fields.has('--source')))) throw new Error('真实检查需要 --config、--platform，源检查另需 --source')
  if (kind === 'catalog' && fields.has('--source')) throw new Error('资料探针不运行音源脚本')
  if (kind === 'source' && fields.has('--capability')) throw new Error('源诊断只检查初始化及单次地址解析')
  const platforms = live ? String(fields.get('--platform')).split(',') : [...PLATFORMS]
  if (!platforms.length || new Set(platforms).size !== platforms.length || platforms.some(p => !PLATFORMS.includes(p as Platform))) throw new Error('仅支持明确选择 wy、tx')
  const capabilities = kind === 'source' ? ['musicUrl'] : String(fields.get('--capability') ?? 'search').split(',')
  if (!capabilities.length || new Set(capabilities).size !== capabilities.length || (kind === 'catalog' && capabilities.some(c => !CATALOG_CAPABILITIES.includes(c as typeof CATALOG_CAPABILITIES[number])))) throw new Error('检查能力无效或重复')
  return {
    mode: live ? 'live' : 'synthetic', platforms: platforms as Platform[], capabilities: capabilities as Capability[],
    ...(fields.has('--media') ? { media: true } : {}),
    ...(fields.has('--config') ? { config: String(fields.get('--config')) } : {}),
    ...(fields.has('--source') ? { source: String(fields.get('--source')) } : {}),
    ...(fields.has('--report') ? { report: String(fields.get('--report')) } : {})
  }
}

/** Reconstruct at export; arbitrary error, result and script fields never survive. */
export function serializeDiagnosticReport(input: DiagnosticReport): DiagnosticReport {
  const levels = Object.fromEntries(DIAGNOSTIC_LEVELS.map(level => [level, (input.levels?.[level] ?? []).map(record => {
    const out: CheckRecord = { status: ['passed', 'failed', 'cancelled', 'timeout', 'notRun'].includes(record.status) ? record.status : 'failed' }
    if (PLATFORMS.includes(record.platform!)) out.platform = record.platform
    if (CAPABILITIES.includes(record.capability!)) out.capability = record.capability
    if (typeof record.adapterRevision === 'string' && /^(wy|tx)-\d{1,8}$/.test(record.adapterRevision)) out.adapterRevision = record.adapterRevision
    if (typeof record.providerVersion === 'string' && /^[a-f0-9]{64}$/.test(record.providerVersion)) out.providerVersion = record.providerVersion
    if (Number.isInteger(record.httpStatus) && record.httpStatus! >= 100 && record.httpStatus! <= 599) out.httpStatus = record.httpStatus
    if (level === 'media') {
      if (Number.isInteger(record.bytes) && record.bytes! >= 0 && record.bytes! <= 1024) out.bytes = record.bytes
      if (['mpeg', 'flac', 'ogg', 'wav', 'mp4'].includes(record.format!)) out.format = record.format
    }
    if (typeof record.elapsedMs === 'number' && Number.isFinite(record.elapsedMs) && record.elapsedMs >= 0) out.elapsedMs = Math.min(record.elapsedMs, 60_000)
    if (['cancelled', 'timeout', 'network', 'rateLimited', 'cooling', 'authRequired', 'forbidden', 'notFound', 'qualityUnavailable', 'unsupported', 'schemaChanged', 'providerUnavailable', 'urlExpired', 'cacheIO', 'unknown'].includes(record.code!)) out.code = record.code
    return out
  })])) as DiagnosticReport['levels']
  return { schema: 1, mode: input.mode === 'live' ? 'live' : 'synthetic', levels }
}

export interface DiagnosticCheck {
  platform: Platform; capability: Capability; level: Level
  adapterRevision?: string; providerVersion?: string
  run: (signal: AbortSignal) => Promise<unknown>
}

/** One serial sample per platform/capability. Budget belongs to this whole run. */
export async function runDiagnosticChecks(options: {
  mode: Mode; checks: DiagnosticCheck[]; signal?: AbortSignal; budgetMs?: number
}): Promise<DiagnosticReport> {
  const keys = new Set<string>()
  for (const check of options.checks) {
    const key = `${check.platform}:${check.capability}`
    if (keys.has(key) || !PLATFORMS.includes(check.platform) || !CAPABILITIES.includes(check.capability) || !DIAGNOSTIC_LEVELS.includes(check.level)) throw new Error('诊断样本重复或无效')
    keys.add(key)
  }
  const levels = Object.fromEntries(DIAGNOSTIC_LEVELS.map(level => [level, []])) as unknown as DiagnosticReport['levels']
  const control = new AbortController()
  let timedOut = false
  const cancel = () => control.abort()
  options.signal?.addEventListener('abort', cancel, { once: true })
  if (options.signal?.aborted) cancel()
  const budget = Number.isFinite(options.budgetMs) ? Math.max(1, Math.min(60_000, options.budgetMs!)) : 60_000
  const timer = setTimeout(() => { timedOut = true; cancel() }, budget)
  try {
    for (const check of options.checks) {
      const started = performance.now()
      const record: CheckRecord = { platform: check.platform, capability: check.capability, status: 'passed', adapterRevision: check.adapterRevision, providerVersion: check.providerVersion }
      let onAbort: (() => void) | undefined
      try {
        if (control.signal.aborted) throw new Error('aborted')
        const aborted = new Promise<never>((_resolve, reject) => {
          onAbort = () => reject(new Error('aborted'))
          control.signal.addEventListener('abort', onAbort, { once: true })
        })
        const value = await Promise.race([aborted, Promise.resolve().then(() => check.run(control.signal))])
        if (control.signal.aborted) throw new Error('aborted')
        if (check.level === 'media' && value && typeof value === 'object') {
          const evidence = value as Partial<CheckRecord>
          record.httpStatus = evidence.httpStatus; record.bytes = evidence.bytes; record.format = evidence.format
        }
      } catch (error) {
        record.status = control.signal.aborted ? timedOut ? 'timeout' : 'cancelled' : 'failed'
        const failure = normalizeOnlineError(error, onlineContext(check.platform, check.capability))
        record.code = control.signal.aborted ? record.status : failure.code
        record.httpStatus = failure.httpStatus
      } finally {
        if (onAbort) control.signal.removeEventListener('abort', onAbort)
      }
      record.elapsedMs = Math.round(performance.now() - started)
      levels[check.level].push(record)
    }
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', cancel)
  }
  for (const level of DIAGNOSTIC_LEVELS) if (!levels[level].length) levels[level].push({ status: 'notRun' })
  return serializeDiagnosticReport({ schema: 1, mode: options.mode, levels })
}
