import { IPC } from '@shared/ipc'
import { LX_QUALITIES } from '@shared/types'

/** Reject malformed renderer values before any handler reads paths, URLs or arrays. */
export function assertIpcArgs(channel: string, args: unknown[]): void {
  const bad = (): never => { throw new Error(`IPC 参数无效：${channel}`) }
  const str = (value: unknown, max: number): value is string =>
    typeof value === 'string' && value.length > 0 && value.length <= max && !value.includes('\0')
  const path = (value: unknown): boolean => str(value, 32767)
  const ids = (value: unknown, max = 50000): boolean =>
    Array.isArray(value) && value.length <= max && value.every((item) => str(item, 256))
  const source = (value: unknown): boolean => str(value, 64)
  const page = (value: unknown): boolean => Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 100
  const request = (value: unknown): boolean => value === undefined ||
    (typeof value === 'string' && /^search-\d{13}-\d{1,12}$/.test(value))
  const url = (value: unknown): boolean => {
    if (!str(value, 2048)) return false
    try { return ['http:', 'https:'].includes(new URL(value).protocol) }
    catch { return false }
  }
  const quality = (value: unknown): boolean => LX_QUALITIES.includes(value as (typeof LX_QUALITIES)[number])

  switch (channel) {
    case IPC.musicSearch:
      if (args.length > 4 || !source(args[0]) || !str(args[1], 200) ||
        !page(args[2]) || !request(args[3])) bad()
      break
    case IPC.musicSearchAll:
      if (args.length > 3 || !str(args[0], 200) || !page(args[1]) || !request(args[2])) bad()
      break
    case IPC.sourcesImportUrl:
      if (args.length !== 1 || !url(args[0])) bad()
      break
    case IPC.sourcesImport:
      if (!str(args[0], 4 * 1024 * 1024) || (args[1] !== undefined && !str(args[1], 256))) bad()
      break
    case IPC.fileReveal:
      if (args.length !== 1 || !path(args[0])) bad()
      break
    case IPC.lyricReadFile:
    case IPC.libraryRemoveFolder:
      if (args.length !== 1 || !path(args[0])) bad()
      break
    case IPC.filesDropped:
      if (args.length !== 1 || !Array.isArray(args[0]) || args[0].length > 10000 ||
        !args[0].every(path)) bad()
      break
    case IPC.libraryRemoveTracks:
      if (args.length !== 1 || !ids(args[0])) bad()
      break
    case IPC.playlistRemoveTracks:
    case IPC.playlistReorder:
      if (!str(args[0], 256) || !ids(args[1])) bad()
      break
    case IPC.downloadsAdd:
      if (args.length !== 2 || !Array.isArray(args[0]) || args[0].length > 500 ||
        !quality(args[1])) bad()
      break
    case IPC.musicUrl:
      if (!source(args[0]) || !quality(args[2])) bad()
      break
    case IPC.musicEnrich:
      if (args.length > 3 || !args[0] || typeof args[0] !== 'object' ||
        (args[1] !== undefined && !['script', 'platform', 'search'].includes(args[1] as string)) ||
        !request(args[2])) bad()
      break
    case IPC.lyricSave:
    case IPC.lyricExportFile:
      if (!str(args[0], 256) || typeof args[1] !== 'string' || args[1].length > 1024 * 1024) bad()
      break
    default:
      // Other channels keep their existing handler-level checks. This boundary
      // is extended as each payload contract is moved to a shared schema.
      break
  }
}
