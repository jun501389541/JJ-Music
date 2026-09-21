import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { artistNameMatches, resolveArtistImage } from './online/artist-image.js'
import { ArtistImageStore } from './library/artist-images.js'

/** 每个假端点返回一份该平台真实响应的最小有意义切片（字段名照抄线上抓到的）。 */
function fake(routes) {
  const seen = []
  const http = async (url) => {
    seen.push(String(url))
    for (const [match, body] of routes) if (String(url).includes(match)) return new Response(typeof body === 'string' ? body : JSON.stringify(body))
    return new Response('{}')
  }
  return { http, seen }
}

test('艺术家名字匹配：拼写差异要认，两个字的同名近似不能认', () => {
  assert.equal(artistNameMatches('周杰伦', '周杰伦'), true)
  assert.equal(artistNameMatches('周杰伦', 'Jay Chou 周杰伦'), true)
  assert.equal(artistNameMatches('Adele', 'adele'), true)
  // 「阿杜」只有两个字，任何包含它的名字都不该被认成同一个人——认错脸的代价比没头像大。
  assert.equal(artistNameMatches('阿杜', '阿杜的咖啡店'), false)
  assert.equal(artistNameMatches('阿杜', '阿杜'), true)
  assert.equal(artistNameMatches('', '任何人'), false)
})

test('咪咕一次就够；它没命中才轮到 QQ 的歌手 mid', async () => {
  const direct = fake([['migu.cn', [{ singerList: [{ name: '周杰伦', img: 'https://d.musicapp.migu.cn/p.webp' }] }]]])
  const first = await resolveArtistImage('周杰伦', direct.http)
  assert.equal(first.source, 'mg')
  assert.equal(first.url, 'https://d.musicapp.migu.cn/p.webp')
  assert.equal(direct.seen.length, 1)

  const { http, seen } = fake([
    ['migu.cn', [{ singerList: [{ name: '别人', img: '/p.webp' }] }]],
    ['client_search_cp', { data: { song: { list: [{ singer: [{ mid: '0025NhlN2yWrP4', name: '周杰伦' }] }] } } }]
  ])
  const found = await resolveArtistImage('周杰伦', http)
  assert.equal(found.source, 'tx')
  assert.equal(found.url, 'https://y.gtimg.cn/music/photo_new/T001R300x300M0000025NhlN2yWrP4.jpg')
  assert.deepEqual(seen.map(u => new URL(u).host), ['app.u.nf.migu.cn', 'c.y.qq.com'])
})

test('咪咕的裸路径要补成完整地址，斜杠不能丢', async () => {
  const { http } = fake([['migu.cn', [{ singerList: [{ name: '周杰伦', img: '/data/oss/resource/00/5l/4k/x.webp' }] }]]])
  const found = await resolveArtistImage('周杰伦', http)
  assert.equal(found.url, 'https://d.musicapp.migu.cn/data/oss/resource/00/5l/4k/x.webp')
})

test('一家平台直接抛错（本机实测 QQ 会连接超时）不能连累后面的平台', async () => {
  const attempted = []
  const http = async (url) => {
    attempted.push(String(url))
    if (String(url).includes('migu.cn')) throw new Error('connect timeout')
    return new Response(JSON.stringify({ data: { song: { list: [{ singer: [{ mid: 'm9', name: '周杰伦' }] }] } } }))
  }
  const found = await resolveArtistImage('周杰伦', http)
  assert.equal(found.source, 'tx')
  assert.equal(found.url, 'https://y.gtimg.cn/music/photo_new/T001R300x300M000m9.jpg')
  // 抛错的那家确实被问过（不是"根本没发请求"的假绿），并且只问一次就换下一家。
  assert.deepEqual(attempted.map(u => new URL(u).host), ['app.u.nf.migu.cn', 'c.y.qq.com'])
})

test('网易云要二段请求，并且必须带缩放参数', async () => {
  const { http, seen } = fake([
    ['client_search_cp', { data: { song: { list: [] } } }],
    ['migu.cn', []],
    ['search/get/web', { result: { songs: [{ artists: [{ id: 6452, name: '周杰伦' }] }] } }],
    ['api/artist/6452', { artist: { picUrl: 'https://p1.music.126.net/abc/1099.jpg' } }]
  ])
  const found = await resolveArtistImage('周杰伦', http)
  assert.equal(found.source, 'wy')
  // 不带 `?param=` 时那是 1.4MB 的原图，网格一次拉几十张就是几分钟的白屏。
  assert.equal(found.url, 'https://p1.music.126.net/abc/1099.jpg?param=320y320')
  assert.equal(seen.filter(u => u.includes('api/artist/')).length, 1)
})

test('酷狗的头像模板要填尺寸；平台都没有结果时返回空而不是乱挑一张', async () => {
  const ok = fake([
    ['client_search_cp', { data: { song: { list: [] } } }],
    ['migu.cn', []],
    ['search/get/web', { result: { songs: [] } }],
    ['song_search_v2', { data: { lists: [{ SingerId: [3520], SingerName: '周杰伦' }] } }],
    ['singer/info', { data: { imgurl: 'http://singerimg.kugou.com/uploadpic/softhead/{size}/x.jpg' } }]
  ])
  const found = await resolveArtistImage('周杰伦', ok.http)
  assert.equal(found.source, 'kg')
  assert.equal(found.url, 'http://singerimg.kugou.com/uploadpic/softhead/320/x.jpg')

  const none = fake([['client_search_cp', { data: { song: { list: [{ singer: [{ mid: 'x', name: '路人' }] }] } } }]])
  assert.equal(await resolveArtistImage('周杰伦', none.http), null)
  assert.ok(none.seen.length >= 1, '未命中也要真的问过平台')

  // 空白与超长名字不发任何请求：前者没意义，后者是给平台喂垃圾。
  const quiet = fake([])
  assert.equal(await resolveArtistImage('   ', quiet.http), null)
  assert.equal(await resolveArtistImage('周'.repeat(80), quiet.http), null)
  assert.equal(quiet.seen.length, 0)
})

async function setup(deps) {
  const dir = await mkdtemp(join(tmpdir(), 'jj-artist-'))
  const saved = []
  const store = new ArtistImageStore(dir, {
    saveCover: async (data, format) => { saved.push({ bytes: data.length, format }); await mkdir(join(dir, 'covers'), { recursive: true }); const file = join(dir, 'covers', 'abc.jpg'); await writeFile(file, 'jpegdata'); return file },
    ...deps
  })
  return { dir, store, saved }
}

test('头像按名字落盘、记住命中也记住没命中，刷新才会再问一次', async () => {
  let hits = 0
  const { dir, store, saved } = await setup({
    fetch: async () => { hits++; return new Response(JSON.stringify({ data: { song: { list: [{ singer: [{ mid: 'm1', name: '周杰伦' }] }] } } })) },
    getBytes: async (url) => { assert.equal(url, 'https://y.gtimg.cn/music/photo_new/T001R300x300M000m1.jpg'); return { body: Buffer.from('jpegdata'), contentType: 'image/jpeg' } }
  })
  const path = await store.image('周杰伦')
  assert.equal(path, join(dir, 'covers', 'abc.jpg'))
  assert.ok(hits > 0, '第一次至少要问过平台')
  assert.deepEqual(saved, [{ bytes: 8, format: 'image/jpeg' }])
  // 第二次不能再发请求：这一页有几百个名字。
  const asked = hits
  assert.equal(await store.image('周杰伦'), path)
  assert.equal(hits, asked, '命中过的不该再问一遍')
  assert.equal(await store.peek('周杰伦'), path)
  assert.equal(await store.image('周杰伦', true), path)
  assert.ok(hits > asked, '刷新必须真的重查一次')

  // 没找到的也要记住，否则每次进这页都会替平台重跑一遍搜索。
  const miss = fake([])
  const missed = await setup({ fetch: async () => { miss.seen.push('x'); return new Response(JSON.stringify({ data: { song: { list: [] } } })) }, getBytes: async () => ({ body: Buffer.from(''), contentType: '' }) })
  assert.equal(await missed.store.image('查无此人'), null)
  const afterFirst = miss.seen.length
  assert.equal(await missed.store.image('查无此人'), null)
  assert.equal(miss.seen.length, afterFirst, '未命中不该重查')

  // 命中与未命中都要活过一次重启
  const reloaded = new ArtistImageStore(dir, { saveCover: async () => undefined })
  await reloaded.load()
  assert.equal(reloaded.peek('周杰伦'), path)
  const reloadedMiss = new ArtistImageStore(missed.dir, { saveCover: async () => undefined })
  await reloadedMiss.load()
  assert.equal(reloadedMiss.peek('查无此人'), null, '没头像这件事也要记住')
  assert.equal(await reloadedMiss.image('查无此人'), null)
  assert.equal(miss.seen.length, afterFirst, '重启后也不该重查')
  await rm(dir, { recursive: true, force: true })
  await rm(missed.dir, { recursive: true, force: true })
})

test('指向已被删除文件的头像记录作废，而不是继续返回死路径', async () => {
  const { dir, store } = await setup({ fetch: async () => new Response(JSON.stringify({ data: { song: { list: [] } } })), getBytes: async () => ({ body: Buffer.from(''), contentType: '' }) })
  const gone = join(dir, 'covers', 'deleted.jpg')
  await store.image('周杰伦')
  writeFileSync(join(dir, 'artist-images.json'), JSON.stringify({ '周杰伦': { path: gone, source: 'tx', at: 1 } }))
  const reloaded = new ArtistImageStore(dir, { saveCover: async () => undefined })
  await reloaded.load()
  assert.equal(reloaded.peek('周杰伦'), undefined, '这条记录等于没查过')
  assert.equal(await reloaded.image('周杰伦'), null, '重新解析而不是把死路径交出去')
  await rm(dir, { recursive: true, force: true })
})

test('同名并发只查一次，写盘的文件能被重新读回', async () => {
  const stub = () => {
    const counter = { fetches: 0 }
    const deps = {
      fetch: async () => {
        counter.fetches++
        await new Promise((r) => setTimeout(r, 20))
        return new Response(JSON.stringify({ data: { song: { list: [{ singer: [{ mid: 'm2', name: '周杰伦' }] }] } } }))
      },
      getBytes: async () => ({ body: Buffer.from('x'), contentType: 'image/jpeg' })
    }
    return { counter, deps }
  }
  // 一次解析要问几家平台是顺序的事，这里只关心"两次并发有没有变成两倍请求"。
  const single = stub()
  const one = await setup(single.deps)
  await one.store.image('周杰伦')
  const perLookup = single.counter.fetches
  assert.ok(perLookup > 0, '对照组：单独查一次确实发了请求')

  const pair = stub()
  const two = await setup(pair.deps)
  const both = await Promise.all([two.store.image('周杰伦'), two.store.image('周杰伦')])
  assert.equal(both[0], both[1])
  assert.equal(pair.counter.fetches, perLookup, '两张卡同时进入视口不该各查一次')
  const text = JSON.parse(await readFile(join(two.dir, 'artist-images.json'), 'utf8'))
  assert.equal(text['周杰伦'].path, both[0])
  assert.equal(text['周杰伦'].source, 'tx')
  await rm(one.dir, { recursive: true, force: true })
  await rm(two.dir, { recursive: true, force: true })
})
