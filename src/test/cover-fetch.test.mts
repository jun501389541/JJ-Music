/**
 * 标签匹配写封面：什么时候该去下载，以及下载回来的什么算一张封面。
 *
 * ## Why these two functions get a suite at all
 *
 * Both decide something the user cannot take back. `shouldFetchCover` is the
 * difference between "previewed" and "spent an 8 MB request", and between
 * "kept the jacket I embedded myself" and "replaced it with the search
 * thumbnail" — the two switches the reference dialog now shows. `fetchCoverBytes`
 * is the last place those bytes pass through before they are written into the
 * user's original file, and the writer's own mime mapping
 * (`library/asset-files.ts`) resolves *anything* it does not recognise to
 * `.jpg`, so a `text/html` error page would otherwise land in the music folder
 * as a picture instead of being refused.
 *
 * `dryRun` is checked explicitly in both directions because the early returns
 * downstream (`commitAssetWrite`, `exportAssets`) contain the *write* and not
 * the request; that is the one guard here that a green file-diff test would
 * never notice.
 *
 * Run with:  node out/test/cover-fetch.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { fetchCoverBytes, shouldFetchCover } = await import('./online/cover-fetch.js')

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a])

/** A stand-in for `safeFetchBytes` that records what it was asked for. */
function stub(contentType, body = PNG, error) {
  const calls = []
  const fn = async (url, options) => {
    calls.push({ url, options })
    if (error) throw error
    return { body, contentType }
  }
  fn.calls = calls
  return fn
}

/* ------------------------------------------------ the decision to download */

test('没有 picUrl 就一个请求都不发', async () => {
  const get = stub('image/jpeg')
  assert.equal(await fetchCoverBytes({ picUrl: '', source: 'wy' }, get), null)
  assert.equal(await fetchCoverBytes(undefined, get), null)
  assert.equal(get.calls.length, 0, `应当一次都不请求，实际请求了 ${get.calls.length} 次`)
})

test('下载沿用候选预览已有的尺寸与超时上限（不引入第四个数字）', async () => {
  const get = stub('image/png')
  await fetchCoverBytes({ picUrl: 'https://p.example.com/a.png', source: 'wy' }, get)
  assert.equal(get.calls.length, 1)
  assert.deepEqual(get.calls[0].options, { maxBytes: 8 * 1024 * 1024, timeoutMs: 10_000, allowedHosts: ['126.net'] })
})

/* ------------------------------------------------------- what counts as art */

test('字节以 Uint8Array 交出，mimeType 用响应头声明的那种', async () => {
  const cover = await fetchCoverBytes({ picUrl: 'https://p.example.com/a.png', source: 'wy' }, stub('image/png'))
  assert.ok(cover, '一张 PNG 不该被判成没有封面')
  assert.equal(cover.mimeType, 'image/png')
  assert.equal(cover.data instanceof Uint8Array, true, '写标签那头要的是 Uint8Array')
  assert.deepEqual([...cover.data], [...PNG], '字节必须原样带过去，不能重新编码')
})

test('带参数的 content-type 还是同一张图', async () => {
  const cover = await fetchCoverBytes({ picUrl: 'https://p.example.com/a.jpg', source: 'wy' }, stub('image/jpeg; charset=binary'))
  assert.equal(cover?.mimeType, 'image/jpeg', `参数没被剥掉的话会得到「${cover?.mimeType}」`)
})

test('image/jpg 归一成 image/jpeg（有的 CDN 就这么写）', async () => {
  const cover = await fetchCoverBytes({ picUrl: 'https://p.example.com/a.jpg', source: 'wy' }, stub('image/jpg'))
  assert.equal(cover?.mimeType, 'image/jpeg')
})

test('没有 content-type 时退回 jpeg，与改动前一致', async () => {
  const cover = await fetchCoverBytes({ picUrl: 'https://p.example.com/a', source: 'wy' }, stub(null))
  assert.equal(cover?.mimeType, 'image/jpeg')
})

test('text/html 的响应体被拒，不会当作 JPEG 写进用户的音乐文件夹', async () => {
  // 落盘那侧 `imageExtensionForMime()` 对不认识的类型一律给 `.jpg`，
  // 所以这里放行 = 门户页/错误页变成 `Song.jpg`。
  const portal = Buffer.from('<html>登录到 WLAN</html>', 'utf8')
  const cover = await fetchCoverBytes({ picUrl: 'https://p.example.com/a.jpg', source: 'wy' }, stub('text/html', portal))
  assert.equal(cover, null, 'HTML 被当成封面收下了')
})

test('写入端不认识的图片类型同样拒掉（GIF 不在 sidecar 名单里）', async () => {
  const cover = await fetchCoverBytes({ picUrl: 'https://p.example.com/a.gif', source: 'wy' }, stub('image/gif'))
  assert.equal(cover, null, 'GIF 会在落盘时被改名成 .jpg，内容却还是 GIF')
})

test('空响应体不算一张封面', async () => {
  const cover = await fetchCoverBytes({ picUrl: 'https://p.example.com/a.png', source: 'wy' }, stub('image/png', Buffer.alloc(0)))
  assert.equal(cover, null)
})

test('网络失败返回 null，不把异常抛回正在写歌词的那次调用', async () => {
  const get = stub('image/png', PNG, new Error('SSRF guard refused this address'))
  assert.equal(await fetchCoverBytes({ picUrl: 'https://127.0.0.1/a.png', source: 'wy' }, get), null)
})

/* ---------------------------------- 主机白名单：这张图只能来自它自己那家 */

test('抓封面把该平台的 CDN 根域交给校验器（每一跳都按它判）', async () => {
  const cases = [
    ['wy', 'https://p2.music.126.net/x.jpg', ['126.net']],
    ['kw', 'https://img1.kuwo.cn/star/albumcover/x.jpg', ['kuwo.cn']],
    ['kg', 'https://imge.kugou.com/x.jpg', ['kugou.com']],
    ['mg', 'https://d.musicapp.migu.cn/x.jpg', ['migu.cn']],
    ['tx', 'https://y.gtimg.cn/music/photo_new/x.jpg', ['gtimg.cn']]
  ]
  for (const [source, picUrl, hosts] of cases) {
    const get = stub('image/jpeg')
    await fetchCoverBytes({ picUrl, source }, get)
    assert.deepEqual(get.calls[0].options.allowedHosts, hosts, `${source} 的允许主机不对`)
  }
})

test('音源脚本那类平台（qs / qsvip）与未知来源：一个请求都不发，直接没有封面', async () => {
  for (const source of ['qs', 'qsvip', 'nope']) {
    const get = stub('image/jpeg')
    assert.equal(await fetchCoverBytes({ picUrl: 'https://anywhere.example.com/a.jpg', source }, get), null,
      `${source} 不该被放行`)
    assert.equal(get.calls.length, 0, `${source} 发出了 ${get.calls.length} 个请求`)
  }
  const none = stub('image/jpeg')
  assert.equal(await fetchCoverBytes({ picUrl: 'https://p1.music.126.net/a.jpg' }, none), null, '没有 source 也放行 = 白名单形同虚设')
  assert.equal(none.calls.length, 0)
})

test('渲染层自己拼一个 coverFrom 也越不过去：白名单交给校验器，元数据地址被拒、自家 CDN 放行', async () => {
  // matchApply 的 coverFrom 是渲染层构造的对象。这一层能证明的是"把名单交下去了"，
  // 真正拒绝的是 url-guard —— 所以把交下去的名单原样喂给它，看它挡不挡。
  const { assertPublicHttpUrl } = await import('./online/url-guard.js')
  const get = stub('image/jpeg')
  await fetchCoverBytes({ picUrl: 'https://169.254.169.254/latest/meta-data', source: 'wy' }, get)
  const hosts = get.calls[0].options.allowedHosts
  assert.deepEqual(hosts, ['126.net'], '没把白名单交给 safeFetchBytes')
  assert.throws(() => assertPublicHttpUrl('https://169.254.169.254/latest/meta-data', hosts),
    '元数据地址在名单外却没被拒')
  // 反过来也要成立：名单写得太窄会把功能弄死，这条是"正常封面仍然拿得到"的对照。
  assert.equal(assertPublicHttpUrl('https://p2.music.126.net/x.jpg', hosts).host, 'p2.music.126.net')
})

/* ------------------------------------------- which switch decides what lands */

test('没勾「同时写入封面」就不会去下载，文件本来有没有封面都一样', () => {
  assert.equal(shouldFetchCover({ withCover: false, coverFrom: { picUrl: 'x' } }, false), false)
  assert.equal(shouldFetchCover({ withCover: false, coverFrom: { picUrl: 'x' } }, true), false)
})

test('没有候选对象时不下载（apply 与 cover 的入参是两回事）', () => {
  assert.equal(shouldFetchCover({ withCover: true }, false), false)
})

test('文件本来没有封面：不勾覆盖也照写，这一步没有东西可保护', () => {
  assert.equal(shouldFetchCover({ withCover: true, coverFrom: { picUrl: 'x' } }, false), true)
})

test('文件已有封面：默认不覆盖，勾了「覆盖已有封面」才换', () => {
  const base = { withCover: true, coverFrom: { picUrl: 'x' } }
  assert.equal(shouldFetchCover(base, true), false, '没勾覆盖时不该动用户自己的封面')
  assert.equal(shouldFetchCover({ ...base, overwriteCover: false }, true), false)
  assert.equal(shouldFetchCover({ ...base, overwriteCover: true }, true), true)
})

test('dryRun 任何形状都不发这个请求 —— 落盘的早退挡不住网络', () => {
  const shapes = [
    { withCover: true, coverFrom: { picUrl: 'x' }, dryRun: true },
    { withCover: true, coverFrom: { picUrl: 'x' }, overwriteCover: true, dryRun: true }
  ]
  for (const options of shapes) {
    for (const hasCover of [false, true]) {
      assert.equal(shouldFetchCover(options, hasCover), false, `dryRun 漏过去了：${JSON.stringify(options)} / 已有封面=${hasCover}`)
    }
  }
})
