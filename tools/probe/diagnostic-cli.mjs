/** Shared native-Node diagnostic entry. No implicit profile discovery. */
import { open, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const load = path => import(pathToFileURL(join(root, 'out/test', path)).href)

async function readText(path, maxBytes) {
  const handle = await open(path, 'r')
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size > maxBytes) throw Error('测试文件过大或不是普通文件')
    const data = Buffer.alloc(maxBytes + 1)
    let bytesRead = 0
    while (bytesRead < data.length) {
      const chunk = await handle.read(data, bytesRead, data.length - bytesRead, bytesRead)
      if (!chunk.bytesRead) break
      bytesRead += chunk.bytesRead
    }
    if (bytesRead > maxBytes) throw Error('测试文件过大')
    return data.subarray(0, bytesRead).toString('utf8')
  } finally { await handle.close() }
}

function validateConfig(value, options) {
  if (value?.schema !== 1 || !value.samples || typeof value.samples !== 'object') throw Error('测试配置格式无效')
  const result = {}
  const text = value => typeof value === 'string' && value.trim() && value.length <= 2048
  for (const platform of options.platforms) {
    const sample = value.samples[platform]
    if (!sample || typeof sample !== 'object') throw Error('测试配置缺少所选平台样本')
    for (const capability of options.capabilities) {
      if (capability === 'search' && !text(sample.keyword)) throw Error('搜索需要明确样本关键词')
      if (['musicUrl', 'lyric'].includes(capability)) {
        const track = sample.track
        if (!track || track.source !== platform || !text(track.id) || !text(track.name) || typeof track.singer !== 'string' || !track.meta || typeof track.meta !== 'object' || Array.isArray(track.meta) || JSON.stringify(track).length > 65536) throw Error('检查需要明确平台歌曲样本')
      }
      const field = { cover: 'coverUrl', artistDetail: 'artistId', albumDetail: 'albumId', playlist: 'playlistId' }[capability]
      if (field && !text(sample[field])) throw Error('检查能力缺少明确样本')
    }
    result[platform] = sample
  }
  return result
}

export async function executeDiagnostic(kind, args, dependencies = {}) {
  const { parseDiagnosticArgs, runDiagnosticChecks } = await load('online/diagnostic-check.js')
  const options = parseDiagnosticArgs(args, kind)
  if (options.help) return { help: true }
  const read = dependencies.readText ?? readText
  if (options.mode === 'live') {
    let config
    try { config = JSON.parse(await read(options.config, 1024 * 1024)) } catch { throw Error('无法读取有效测试配置') }
    options.samples = validateConfig(config, options)
    if (kind === 'source') options.sourceText = await read(options.source, 4 * 1024 * 1024)
  }
  let session
  try {
    session = options.mode === 'synthetic'
      ? await (dependencies.synthetic ?? syntheticSession)(options, kind)
      : await (dependencies.live ?? liveSession)(options, kind, kind === 'source' ? dependencies.sourceAdapters : dependencies.catalogAdapters)
    const checks = Array.isArray(session) ? session : session.checks
    if (!checks?.length) throw Error('未提供诊断检查')
    return await runDiagnosticChecks({ mode: options.mode, checks, signal: dependencies.signal, budgetMs: dependencies.budgetMs })
  } finally { await session?.cleanup?.() }
}

const generatedSource = `/*!\n * @name OR7 synthetic engine\n * @version 1\n */
const {on,send,EVENT_NAMES}=globalThis.lx;
on(EVENT_NAMES.request,()=>Promise.resolve('https://example.invalid/synthetic.mp3'));
send(EVENT_NAMES.inited,{status:true,sources:{wy:{type:'music',actions:['musicUrl'],qualitys:['128k']},tx:{type:'music',actions:['musicUrl'],qualitys:['128k']}}});`

async function sourceSession(options, adapters = {}) {
  const {OnlineRequestError,onlineContext} = await load('online/reliability-policy.js')
  const [{SourceStore},{SourceEngine}] = await Promise.all([load('sources/source-store.js'),load('sources/source-engine.js')])
  const dir = await mkdtemp(join(tmpdir(), 'jj-diag-or7-'))
  let engine
  let initialization
  const cleanup = async () => {
    await engine?.stopAll()
    // An init handshake may still be pending on user cancellation. Its engine
    // generation is revoked above; wait for its bounded launch to reap itself.
    await initialization?.catch(() => undefined)
    if (!resolve(dir).startsWith(resolve(tmpdir()) + sep) || !dir.split(sep).at(-1).startsWith('jj-diag-or7-')) throw Error('临时目录边界无效')
    await rm(dir, {recursive:true,force:true})
  }
  try {
    const store = new SourceStore(dir)
    const text = options.mode === 'live' ? options.sourceText : generatedSource
    const providerVersion = createHash('sha256').update(text).digest('hex')
    const imported = store.import(text, 'Diagnostic fixture')
    store.setEnabled(imported.id, true)
    engine = new SourceEngine(store, join(root, 'out/test/source-host.cjs'))
    const level = options.mode === 'synthetic' ? 'synthetic' : 'resolution'
    const urls = new Map()
    const assertSource = platform => {
      if (!engine.isInitialized(imported.id)) throw new OnlineRequestError({...onlineContext(platform,'musicUrl'),code:'providerUnavailable'})
      if (!engine.getSources().some(source=>source.id===platform&&source.actions.includes('musicUrl'))) throw new OnlineRequestError({...onlineContext(platform,'musicUrl'),code:'unsupported'})
    }
    const checks = [{platform:options.platforms[0],capability:'initialize',level,providerVersion,run:async signal=>{
      if (signal.aborted) throw Error('cancelled')
      initialization = engine.startAll(signal)
      await initialization
      if (!engine.isInitialized(imported.id)) throw new OnlineRequestError({...onlineContext(options.platforms[0],'initialize'),code:'providerUnavailable'})
    }}]
    for (const platform of options.platforms) {
      checks.push({platform,capability:'musicUrl',level,providerVersion,run:async signal=>{
      assertSource(platform)
      const track = options.mode === 'live' ? options.samples[platform].track : {id:`${platform}_fixture`,source:platform,name:'Synthetic',singer:'Fixture',meta:{songmid:'1'}}
      const result = await engine.getMusicUrl(platform, {...track,providerId:imported.stableId}, '128k', true, signal)
      if (options.mode === 'synthetic' && result.url !== 'https://example.invalid/synthetic.mp3') throw Error('synthetic protocol mismatch')
      urls.set(platform,result.url)
    }})
      if (options.media) checks.push({platform,capability:'audioHead',level:'media',providerVersion,run:async signal=>{
        assertSource(platform)
        const url=urls.get(platform)
        if (!url) throw new OnlineRequestError({...onlineContext(platform,'audioHead'),code:'providerUnavailable'})
        const {probeDiagnosticAudio}=await load('online/diagnostic-media.js')
        return probeDiagnosticAudio(url,onlineContext(platform,'audioHead'),{signal,fetchResponse:adapters.fetchResponse})
      }})
    }
    return {checks,cleanup}
  } catch (error) { await cleanup(); throw error }
}

async function syntheticSession(options, kind) {
  if (kind === 'source') return sourceSession(options)
  const {CatalogReliability,ADAPTER_REVISIONS} = await load('online/catalog-reliability.js')
  const catalog = new CatalogReliability()
  return {checks:options.platforms.map(platform=>({platform,capability:'search',level:'synthetic',adapterRevision:ADAPTER_REVISIONS[platform],run:async signal=>{
    const standard = await catalog.search(platform,'fixture-standard',1,async()=>({list:[{id:`${platform}_fixture`,source:platform,name:'Fixture',singer:'Fixture'}],total:1,allPage:1}),signal)
    const empty = await catalog.search(platform,'fixture-empty',1,async()=>({list:[],total:0,allPage:0}),signal)
    const malformed = await catalog.search(platform,'fixture-malformed',1,async()=>({list:'bad'}),signal)
    const rejected = !malformed.data && malformed.error?.code === 'schemaChanged'
    if (!standard.data?.list?.length || empty.data?.list?.length !== 0 || !rejected) throw Error('synthetic contract mismatch')
  }})),cleanup:()=>catalog.flush()}
}

async function liveSession(options, kind, adapters = {}) {
  if (kind === 'source') return sourceSession(options, adapters)
  // Network adapters load only after explicit live scope admission.
  const [search,lyrics,cover,{OnlineEntityDetails},playlist,{OnlineRequestError,onlineContext}] = await Promise.all([
    load('online/search.js'),load('online/lyrics.js'),load('online/cover-fetch.js'),load('online/entity-details.js'),load('online/playlist-import.js'),load('online/reliability-policy.js')
  ])
  const searchOnline = adapters.searchOnline ?? search.searchOnline
  const fetchOnlineLyric = adapters.fetchOnlineLyric ?? lyrics.fetchOnlineLyric
  const fetchCoverUrl = adapters.fetchCoverUrl ?? cover.fetchCoverUrl
  const importPlaylist = adapters.importPlaylist ?? playlist.importPlaylist
  const {ADAPTER_REVISIONS,CatalogReliability} = await load('online/catalog-reliability.js')
  const {validDiagnosticCover} = await load('online/diagnostic-check.js')
  const details = new OnlineEntityDetails({allows:()=>true,searchTracks:searchOnline,fetchText:adapters.fetchText,reliability:new CatalogReliability()})
  return {checks:options.platforms.flatMap(platform=>options.capabilities.map(capability=>({platform,capability,level:'catalog',adapterRevision:ADAPTER_REVISIONS[platform],run:async signal=>{
    const sample=options.samples[platform]
    let value
    if(capability==='search'){
      value=await searchOnline(platform,sample.keyword,1,signal)
      if(!Array.isArray(value.list))throw new OnlineRequestError({...onlineContext(platform,capability),code:'schemaChanged'})
    }else if(capability==='lyric'){
      value=await fetchOnlineLyric(sample.track,signal)
      if(!value?.lyric?.trim())throw new OnlineRequestError({...onlineContext(platform,capability),code:'unknown'})
    }else if(capability==='cover'){
      value=await fetchCoverUrl(platform,sample.coverUrl,undefined,signal)
      if(!validDiagnosticCover(value))throw new OnlineRequestError({...onlineContext(platform,capability),code:'schemaChanged'})
    }else if(capability==='playlist'){
      value=await importPlaylist(platform,sample.playlistId,undefined,undefined,{signal,budgetMs:60_000})
      if(!value.complete)throw new OnlineRequestError({...onlineContext(platform,capability),code:'schemaChanged'})
    }else{
      value=capability==='artistDetail'?await details.artistPage(platform,sample.artistId,1,signal):await details.albumPage(platform,sample.albumId,1,signal)
      if(value.status!=='available'||value.truncated)throw new OnlineRequestError({...onlineContext(platform,capability),code:value.reliability?.error?.code ?? (platform==='tx'?'unsupported':'schemaChanged')})
    }
  }})))}
}

export async function mainDiagnostic(kind, args = process.argv.slice(2)) {
  const control = new AbortController(), cancel=()=>control.abort()
  process.once('SIGINT',cancel);process.once('SIGTERM',cancel)
  try {
    const {parseDiagnosticArgs} = await load('online/diagnostic-check.js')
    const options = parseDiagnosticArgs(args,kind)
    if(options.help){console.log(`默认：纯合成检查，无实际资料或联网。\n真实：--live --config <test.json> --platform wy,tx${kind==='source'?' --source <test.js> [--media]':' [--capability search,lyric,cover,artistDetail,albumDetail,playlist]'}\n--media只检查最多1024字节的格式头，不代表全曲播放或听感。\n可选：--report <new-report.json>。整体60秒；Ctrl+C取消。`);return}
    const report = await executeDiagnostic(kind,args,{signal:control.signal})
    const text=JSON.stringify(report,null,2)
    if(options.report)await writeFile(options.report,text+'\n',{flag:'wx'})
    console.log(text)
    if(Object.values(report.levels).flat().some(x=>['failed','timeout','cancelled'].includes(x.status)))process.exitCode=1
  }catch{
    console.error('诊断未完成：请检查显式参数、测试配置和构建产物。未导出原始错误。')
    process.exitCode=1
  }finally{process.removeListener('SIGINT',cancel);process.removeListener('SIGTERM',cancel)}
}
