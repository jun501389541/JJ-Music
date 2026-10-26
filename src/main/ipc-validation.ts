import {assertDeriveArgs} from '@shared/playlist-derive'
import {assertQueuePlaylistArgs} from './library/queue-playlist'
import {assertPlaylistBulkRenameSelection,parsePlaylistBulkRenameTransform} from '@shared/playlist-bulk-rename'
import { assertPlaylistSearch } from '@shared/playlist-search'
import { IPC } from '@shared/ipc'
import { assertChartArgs } from '@shared/chart-types'
import {
  LX_QUALITIES,
  ONLINE_ALBUM_MAX_PAGES,
  ONLINE_ARTIST_MAX_PAGES
} from '@shared/types'

/** Renderer cancellation IDs are opaque handles shared by searchable and detail IPCs. */
export function isCancellableRequestId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 64 && /^[a-z][a-z0-9-]{0,31}-\d{13}-\d{1,12}$/.test(value)
}

/** Reject malformed renderer values before any handler reads paths, URLs or arrays. */
export function assertIpcArgs(channel: string, args: unknown[]): void {
  const bad = (): never => { throw new Error(`IPC 参数无效：${channel}`) }
  const str = (value: unknown, max: number): value is string =>
    typeof value === 'string' && value.length > 0 && value.length <= max && !value.includes('\0')
  const path = (value: unknown): boolean => str(value, 32767)
  const ids = (value: unknown, max = 50000): boolean =>
    Array.isArray(value) && value.length <= max && value.every((item) => str(item, 256))
  const uuid = (value: unknown): boolean => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)
  const source = (value: unknown): boolean => str(value, 64)
  const page = (value: unknown, max = 100): boolean =>
    Number.isInteger(value) && (value as number) >= 1 && (value as number) <= max
  const request = (value: unknown): boolean => value === undefined || isCancellableRequestId(value)
  const entityId = (value: unknown): boolean => typeof value === 'string' && /^\d{1,20}$/.test(value)
  const url = (value: unknown): boolean => {
    if (!str(value, 2048)) return false
    try { return ['http:', 'https:'].includes(new URL(value).protocol) }
    catch { return false }
  }
  const quality = (value: unknown): boolean => LX_QUALITIES.includes(value as (typeof LX_QUALITIES)[number])

  switch (channel) {
    case IPC.playlistCreateFromQueue:
      if(args.length!==2)bad()
      assertQueuePlaylistArgs(args[0],args[1])
      break
    case IPC.playlistRemoveMany:
      if(args.length!==1||!Array.isArray(args[0])||!ids(args[0],1000)||!args[0].length||new Set(args[0]).size!==args[0].length||args[0].includes('default')||args[0].includes('favorites'))bad()
      break
    case IPC.libraryMissingFiles:
      if(args.length>1||!request(args[0]))bad()
      break
    case IPC.playlistRestorePreview:
      if(args.length!==0)bad()
      break
    case IPC.playlistRestoreApply:
    case IPC.playlistRestoreDiscard:
      if(args.length!==1||!uuid(args[0]))bad()
      break
    case IPC.playlistExportJson:
      if(args.length>1||(args[0]!==undefined&&(!str(args[0],256)||/[/\\:]/.test(args[0] as string))))bad()
      break
    case IPC.playlistSearchProviders:
      if(args.length!==0)bad()
      break
    case IPC.playlistSearch:
      if(args.length<3||args.length>5||!request(args[3])||(args[4]!==undefined&&typeof args[4]!=='boolean'))bad()
      assertPlaylistSearch(args[0],args[1],args[2])
      break
    case IPC.chartsArtwork:
      if(args.length > 3 || args.length < 2 || !request(args[2])) bad()
      assertChartArgs(args[0], args[1])
      break
    case IPC.chartsList:
      if(args.length > 3 || !request(args[1]) || (args[2] !== undefined && typeof args[2] !== 'boolean')) bad()
      assertChartArgs(args[0])
      break
    case IPC.chartsTracks:
      if(args.length > 6 || args.length < 3 || !request(args[4]) || (args[5] !== undefined && typeof args[5] !== 'boolean')) bad()
      assertChartArgs(args[0], args[1], args[2] as number, args[3] as string | undefined)
      break
    case IPC.libraryRelinkBatchScan:
      if(args.length<1||args.length>2||!request(args[1])||!Array.isArray(args[0])||!args[0].length||args[0].length>50||args[0].some(r=>!r||typeof r!=='object'||Object.keys(r).sort().join(',')!=='id,path'||!str(r.id,256)||!path(r.path)))bad()
      break
    case IPC.libraryRelinkBatchPreview:
      if(args.length<2||args.length>3||!request(args[2])||!uuid(args[0])||!Array.isArray(args[1])||!args[1].length||args[1].length>50||args[1].some(c=>!c||typeof c!=='object'||Object.keys(c).sort().join(',')!=='fileId,id'||!str(c.id,256)||!uuid(c.fileId)))bad()
      break
    case IPC.libraryRelinkBatchDiscard:
      if(args.length!==1||typeof args[0]!=='string'||!/^[a-f0-9-]{36}$/i.test(args[0]))bad()
      break
    case IPC.libraryRelinkPreview:
      if(args.length !== 2 || !str(args[0], 256) || !path(args[1])) bad()
      break
    case IPC.libraryRelinkApply:
    case IPC.libraryRelinkDiscard:
      if(args.length !== 1 || typeof args[0] !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(args[0])) bad()
      break
    case IPC.sourcesUpdateApply:
      if(args.length>3||!str(args[0],256)||!str(args[1],4*1024*1024)||
        (args[2]!==undefined&&(typeof args[2]!=='string'||!/^[a-f0-9]{64}$/i.test(args[2]))))bad()
      break
    case IPC.playlistDerivePreview:
      if(args.length<3||args.length>4||!request(args[3]))bad()
      assertDeriveArgs(args[0],args[1],args[2])
      break
    case IPC.playlistDeriveApply:
    case IPC.playlistDeriveDiscard:
      if(args.length!==1||!uuid(args[0]))bad()
      break
    case IPC.playlistBulkRenamePreview:
      if(args.length<2||args.length>3||!request(args[2]))bad()
      assertPlaylistBulkRenameSelection(args[0])
      parsePlaylistBulkRenameTransform(args[1])
      break
    case IPC.playlistBulkRenameApply:
    case IPC.playlistBulkRenameDiscard:
      if(args.length!==1||!uuid(args[0]))bad()
      break
    case IPC.playlistRefreshPreview:
      if(args.length>2||!str(args[0],256)||!request(args[1]))bad()
      break
    case IPC.playlistRefreshApply:
    case IPC.playlistImportDiscard:
    case IPC.playlistRefreshDiscard:
      if(args.length!==1||typeof args[0]!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(args[0]))bad()
      break
    case IPC.playlistImportPreview:
      if(args.length>3||!source(args[0])||!str(args[1],4096)||!request(args[2]))bad()
      break
    case IPC.musicHotWords:
      if (args.length > 2 || !source(args[0]) || !request(args[1])) bad()
      break
    case IPC.onlineDiagnosticsExport:
    case IPC.onlineDiagnosticsClear:
    case IPC.onlineCacheClear:
      if (args.length !== 0) bad()
      break
    case IPC.updateStatus:
    case IPC.updateCheck:
    case IPC.updateDownload:
    case IPC.updateCancel:
    case IPC.updateInstall:
      if (args.length !== 0) bad()
      break
    case IPC.musicSearch:
      if (args.length > 4 || !source(args[0]) || !str(args[1], 200) ||
        !page(args[2]) || !request(args[3])) bad()
      break
    case IPC.musicSearchAll:
      if (args.length > 3 || !str(args[0], 200) || !page(args[1]) || !request(args[2])) bad()
      break
    case IPC.onlineArtistPage:
      if (args.length > 4 || !source(args[0]) || !entityId(args[1]) || !page(args[2], ONLINE_ARTIST_MAX_PAGES) || !request(args[3])) bad()
      break
    case IPC.onlineAlbumPage:
      if (args.length > 4 || !source(args[0]) || !entityId(args[1]) || !page(args[2], ONLINE_ALBUM_MAX_PAGES) || !request(args[3])) bad()
      break
    case IPC.onlineArtistCandidates:
    case IPC.onlineAlbumCandidates:
      if (args.length > 3 || !source(args[0]) || !str(args[1], 120) || !request(args[2])) bad()
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
      if(args.length<2||args.length>3||!str(args[0],256)||(args[2]!==undefined&&typeof args[2]!=='boolean')||!Array.isArray(args[1])||args[1].length>50000||!args[1].every(value=>str(value,args[2]===true?512:256)))bad()
      break
    case IPC.downloadsAdd:
      if (args.length !== 2 || !Array.isArray(args[0]) || args[0].length > 500 ||
        !quality(args[1])) bad()
      break
    case IPC.musicUrl:
      if (args.length>6 || !source(args[0]) || !quality(args[2]) || !request(args[4]) || (args[5]!==undefined&&typeof args[5]!=='boolean')) bad()
      break
    case IPC.musicMediaFailure:
      if(args.length!==1||typeof args[0]!=='string'||!/^jjstream:\/\/audio\/[A-Za-z0-9_-]{1,128}$/.test(args[0]))bad()
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
