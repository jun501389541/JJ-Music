import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { OnlineAssetCache } from './online/online-asset-cache.js'
import { ResourceCache } from './online/resource-cache.js'
import { OnlineRequestError, onlineContext } from './online/reliability-policy.js'
const platform={platform:'wy',capability:'lyrics',identity:'one',adapterRevision:'wy-1'}
const script=providerId=>({...platform,adapterRevision:'lx-1',providerId,providerVersion:'same-content'})
const tick=()=>new Promise(r=>setImmediate(r))
test('scoped invalidation removes positive/negative cache and aborts matching flights without disturbing others',async()=>{
  const cache=new ResourceCache(),context=onlineContext('wy','lyrics'),policy={context,freshMs:10000,maxAgeMs:20000}
  await cache.get('a-positive',async()=>1,policy)
  await cache.get('b-positive',async()=>2,policy)
  await cache.get('a-negative',async()=>{throw new OnlineRequestError({...context,code:'notFound'})},policy)
  let release,signal
  const flight=cache.get('a-flight',async s=>{signal=s;return new Promise(r=>release=r)},policy)
  while(!release)await tick()
  cache.invalidateWhere(key=>key.startsWith('a-'))
  assert.equal(signal.aborted,true);release(3)
  assert.equal((await flight).data,undefined)
  assert.equal((await cache.get('a-positive',async()=>4,policy)).data,4)
  assert.equal((await cache.get('a-negative',async()=>5,policy)).data,5)
  assert.equal((await cache.get('b-positive',async()=>{throw Error('must hit')},policy)).data,2)
})
test('provider invalidation protects same-version ABA, unbound aggregates and disk persistence while retaining other sources and user files',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'jj-source-assets-')),cache=new OnlineAssetCache({dataDir:dir})
  await cache.load();await mkdir(join(dir,'library'),{recursive:true});const sentinel=join(dir,'library/manual.txt');await writeFile(sentinel,'user')
  const ids=[platform,script('stable-a'),script('stable-b'),script('lx-candidates')]
  for(const [i,id]of ids.entries())await cache.lyric(id,async()=>({lyric:`[00:01]seed${i}`}))
  let release,entered
  const old=cache.lyric(script('stable-a'),async s=>{entered=s;return new Promise(r=>release=r)},{force:true})
  while(!release)await tick()
  cache.invalidateProvider('stable-a',['api-a'])
  assert.equal(entered.aborted,true)
  release({lyric:'[00:01]late before same-content restore'});assert.equal((await old).data,undefined)
  assert.equal((await cache.lyric(script('stable-a'),async()=>({lyric:'[00:01]restored runtime'}))).data.lyric,'[00:01]restored runtime')
  assert.equal((await cache.lyric(script('lx-candidates'),async()=>({lyric:'[00:01]new aggregate'}))).data.lyric,'[00:01]new aggregate')
  for(const id of [platform,script('stable-b')])assert.ok((await cache.lyric(id,async()=>{throw Error('unrelated must stay')})).data.lyric.includes('seed'))
  await cache.flush();const restarted=new OnlineAssetCache({dataDir:dir});await restarted.load()
  assert.equal((await restarted.lyric(script('stable-a'),async()=>{throw Error('disk must match committed value')})).data.lyric,'[00:01]restored runtime')
  assert.equal(await readFile(sentinel,'utf8'),'user')
})
test('a cache hit already in progress cannot return a provider value invalidated before delivery',async()=>{
  const cache=new OnlineAssetCache(),id=script('stable-a')
  await cache.lyric(id,async()=>({lyric:'[00:01]old'}))
  const hit=cache.lyric(id,async()=>{throw Error('fresh hit')})
  cache.invalidateProvider('stable-a')
  assert.equal((await hit).data,undefined)
})
