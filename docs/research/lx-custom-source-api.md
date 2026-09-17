# LX Music 自定义源 (Custom Source) Plugin API — Complete Technical Reference

**Target software:** [`lyswhut/lx-music-desktop`](https://github.com/lyswhut/lx-music-desktop) (LX Music 桌面版) and [`lyswhut/lx-music-mobile`](https://github.com/lyswhut/lx-music-mobile)
**Versions examined:** `lx-music-desktop` **2.12.5** (master), `lx-music-mobile` master
**Custom-source API version (`lx.version`):** `2.0.0` (both platforms)
**Purpose:** enable building a third-party player that can import and execute the same `.js` source scripts.

> **Verification basis.** Every signature below was read from the actual upstream source, not inferred.
> Key files: `src/main/modules/userApi/renderer/preload.js`, `src/main/modules/userApi/main.ts`,
> `src/main/modules/userApi/utils.ts`, `src/main/modules/userApi/rendererEvent/rendererEvent.ts`,
> `src/common/types/user_api.d.ts`, `src/common/types/music.d.ts`, `src/common/types/common.d.ts`,
> `src/common/utils/tools.ts`, `src/renderer/core/useApp/useInitUserApi.ts`, `src/renderer/core/music/utils.ts`,
> `src/renderer/utils/musicSdk/*`, and the mobile QuickJS preload
> `android/app/src/main/assets/script/user-api-preload.js`.
> Items I could not verify from source are explicitly marked **[UNCERTAIN]**.
>
> **Note on fetching:** `github.com` / `raw.githubusercontent.com` were DNS-blocked in the research
> environment; files were retrieved through the `ghproxy.net` raw mirror and `fastly.jsdelivr.net`.
> Content is byte-identical to upstream raw files.

---

## 0. Executive summary for implementers

1. A custom source is **a single `.js` file** with a mandatory `/** ... */` metadata comment **at byte 0**.
2. It is executed in a **sandboxed host**, and talks to the app over a **3-event message bus**:
   `inited` (script → app), `request` (app → script), `updateAlert` (script → app).
3. The script's only network capability is **`lx.request`** — a Node `needle` wrapper on desktop and a
   native HTTP client on mobile. `fetch`/`XMLHttpRequest` are unusable.
4. There are exactly **three actions**: `musicUrl`, `lyric`, `pic`.
   `lyric` and `pic` are **only** available for the pseudo-source **`local`**.
   There is **no** `search`, `songList`, `leaderboard`, `hotSearch`, `tipSearch`, or `auth` action.
5. The script can only claim the source keys **`kw`, `kg`, `tx`, `wy`, `mg`, `local`**.
6. The script can only claim qualities **`128k`, `320k`, `flac`, `flac24bit`**.
7. `inited` **must** be sent, and the **first uncaught error before `inited` is a fatal init failure**.
8. A player implementing this API must impose the same **20 s per-request budget** the real app does.

---

## 1. The `lx` global object surface

The API object is exposed as `window.lx` on desktop (via `contextBridge.exposeInMainWorld`) and as
`globalThis.lx` on mobile. Scripts should use **`globalThis.lx`** — the docs explicitly deprecate `window.lx`
because mobile has no `window`.

Complete surface (desktop, verbatim structure from `preload.js`):

```js
globalThis.lx = {
  EVENT_NAMES: { request: 'request', inited: 'inited', updateAlert: 'updateAlert' },
  version: '2.0.0',
  env: 'desktop',                       // 'desktop' | 'mobile'
  currentScriptInfo: {
    name, description, version, author, homepage,   // parsed from the header comment
    rawScript,                                       // the original, uncompressed script text
  },
  request(url, options, callback),      // → cancel function
  send(eventName, data),                // → Promise<void>
  on(eventName, handler),               // → Promise<void>
  utils: {
    crypto: { aesEncrypt, rsaEncrypt, randomBytes, md5 },
    buffer: { from, bufToString },
    zlib:   { inflate, deflate },       // desktop only
  },
}
```

### 1.1 `lx.version`

```ts
lx.version: string   // currently '2.0.0'
```

Custom-source API version. Changed when the API changes. Source: `preload.js` → `version: '2.0.0'`.

Historical note from `CHANGELOG.md`: `version` was added around v1.14.0; `utils.zlib.*` bumped it to
`v1.3.0`; the `globalThis.lx` / no-`status` rework bumped it to `2.0.0` in v2.6.0.

### 1.2 `lx.env`

```ts
lx.env: 'desktop' | 'mobile'
```

`'desktop'` for lx-music-desktop, `'mobile'` for lx-music-mobile. Real-world scripts branch on it to
pick a `User-Agent` and to avoid `console.group` on mobile.

### 1.3 `lx.currentScriptInfo`

```ts
lx.currentScriptInfo: {
  name: string          // @name
  description: string   // @description
  version: string       // @version
  author: string        // @author
  homepage: string      // @homepage
  rawScript: string     // the full original script source
}
```

`rawScript` is the **decompressed original text** (`getScript()` inflates the `gz_…` store value before
passing it to the renderer). Note that `@repository` and any other non-listed tag are **not** surfaced.

### 1.4 `lx.EVENT_NAMES`

```ts
lx.EVENT_NAMES = { request: 'request', inited: 'inited', updateAlert: 'updateAlert' }
```

`Object.values(EVENT_NAMES)` is the whitelist used by both `on` and `send`. On desktop the object arrives
through `contextBridge` and is effectively read-only in the main world; on mobile it is explicitly
deep-frozen.

### 1.5 `lx.on(eventName, handler)`

```ts
lx.on(eventName: string, handler: (payload) => Promise<any>): Promise<void>
```

* Returns a **Promise** (not a chainable emitter).
* **Only `'request'` can be registered.** Any other name — including `'inited'` and `'updateAlert'` —
  rejects with `Error('The event is not supported: ' + eventName)`.
* Registering twice simply overwrites: `events.request = handler`. There is no `off`/`removeEvent`
  (those methods are commented out in the source).

```js
lx.on(lx.EVENT_NAMES.request, ({ source, action, info }) => {
  return Promise.resolve(/* ... */)   // MUST return a Promise
})
```

The handler is invoked with `this === lx`:
desktop `events.request.call(context, …)` where `context` is the `lx` object;
mobile `events.request.call(globalThis.lx, …)`.

**The returned value is `.then()`-ed unconditionally** — returning a non-Promise (e.g. a bare string)
throws `TypeError: ….then is not a function` inside the host, which surfaces as a request failure.

### 1.6 `lx.send(eventName, data)`

```ts
lx.send(eventName: string, data: any): Promise<void>
```

Only two names are accepted:

| name | behaviour |
| --- | --- |
| `'inited'` | rejects `Error('Script is inited')` if already sent; otherwise marks inited, runs `handleInit`, resolves |
| `'updateAlert'` | rejects `Error('The update alert can only be called once.')` if already sent; otherwise forwards the alert |
| anything else | rejects `Error('The event is not supported: ' + eventName)` |

### 1.7 `lx.request(url, options, callback)`

```ts
lx.request(
  url: string,
  options: {
    method?: string          // default 'get'  (needle lowercases it)
    headers?: Record<string, string>
    body?: any               // raw body
    form?: any               // → sets needle json=false
    formData?: any           // → sets needle json=false
    timeout?: number         // ms; clamped to 60000 max
    binary?: boolean         // MOBILE ONLY (undocumented; ignored on desktop)
    // any other key (e.g. follow_max) is SILENTLY IGNORED on desktop
  },
  callback: (err, resp, body) => void
): () => void                 // cancel function
```

Desktop implementation (`preload.js`):

```js
request(url, { method = 'get', timeout, headers, body, form, formData }, callback) {
  let options = { headers, agent: getRequestAgent(url) }
  let data
  if (body) data = body
  else if (form) { data = form; options.json = false }
  else if (formData) { data = formData; options.json = false }
  options.response_timeout =
    typeof timeout == 'number' && timeout > 0 ? Math.min(timeout, 60_000) : 60_000

  let request = needle.request(method, url, data, options, (err, resp, body) => {
    try {
      if (err) { callback.call(this, err, null, null) }
      else {
        body = resp.body = resp.raw.toString()
        try { resp.body = JSON.parse(resp.body) } catch (_) {}
        body = resp.body
        callback.call(this, err, {
          statusCode: resp.statusCode,
          statusMessage: resp.statusMessage,
          headers: resp.headers,
          bytes: resp.bytes,
          raw: resp.raw,          // Buffer
          body,                   // parsed object, or raw string
        }, body)
      }
    } catch (err) { onError(err.message) }
  }).request

  return () => { if (!request.aborted) request.abort(); request = null }
}
```

**Critical, non-obvious behaviours derived from this + needle's source:**

* **`follow_max` is dropped on desktop.** The destructuring only picks `method, timeout, headers, body,
  form, formData`. Real-world scripts that pass `follow_max: 5` get **0 redirects** on desktop.
  On mobile, `{ method, body, form, formData, ...options }` *is* forwarded, so `follow_max` may reach the
  native layer there. **[UNCERTAIN]** whether the mobile native client honours `follow_max`.
* **Default timeouts:** `open_timeout` stays at needle's default **10 000 ms** (connect);
  `response_timeout` is **always set** (default **60 000 ms**); `read_timeout` is left at 0 (disabled).
* **Object bodies are form-encoded unless the content type says JSON.** needle computes
  `json = options.json || (options.json !== false && headers['content-type'] == 'application/json')`.
  Passing `body: {...}` **without** `'Content-Type': 'application/json'` produces
  `application/x-www-form-urlencoded` querystring encoding, not JSON.
* **`method: 'get'` with a non-JSON object body is turned into a query string** and the body is discarded
  (needle: `else if (method == 'get' && !json) uri = uri.replace(/\?.*|$/, '?' + stringify(data))`).
* **`form` / `formData` do not set multipart.** They only set `json = false`; `multipart: true` is never
  passed, so this is form-urlencoded, not multipart. The documented "formData" name is misleading.
* **The callback's third argument (`body`) is a convenience alias** for `resp.body`.
* `callback.call(this, …)` — `this` inside the callback is the `lx` object (or whatever `request` was
  called on).
* **Response `raw` is a Node `Buffer`** and `bytes` is a number — desktop only.
* Errors inside the callback are funnelled to `onError`, which only has an effect **before** `inited`.

Mobile implementation differences:

```js
request(url, { method = 'get', timeout, headers, body, form, formData, binary }, callback) {
  let options = { headers, binary: binary === true }
  if (timeout && typeof timeout == 'number' && timeout > 0) options.timeout = Math.min(timeout, 60_000)
  let request = sendNativeRequest(url, { method, body, form, formData, ...options }, (err, resp) => {
    if (err) callback(err, null, null)
    else callback(err, {
      statusCode: resp.statusCode,
      statusMessage: resp.statusMessage,
      headers: resp.headers,
      body: resp.body,        // no `raw`, no `bytes`
    }, resp.body)
  })
  return () => { if (!request.aborted) request.abort(); request = null }
}
```

* **No `raw`, no `bytes`** on mobile — scripts must not rely on them.
* **No default timeout is applied by the preload** if the script omits `timeout`; the native client's own
  default applies. **[UNCERTAIN]** what that default is.
* `binary: true` is a mobile-only, undocumented option.

Cancellation: the returned function aborts the request. Aborting does **not** invoke the callback again.

### 1.8 `lx.utils`

#### Desktop (full Node implementations)

```js
crypto: {
  aesEncrypt(buffer, mode, key, iv) {
    const cipher = createCipheriv(mode, key, iv)
    return Buffer.concat([cipher.update(buffer), cipher.final()])   // → Buffer
  },
  rsaEncrypt(buffer, key) {
    buffer = Buffer.concat([Buffer.alloc(128 - buffer.length), buffer])   // left-pad to 128 bytes
    return publicEncrypt({ key, padding: constants.RSA_NO_PADDING }, buffer)  // → Buffer
  },
  randomBytes(size) { return randomBytes(size) },      // → Buffer of `size` random bytes
  md5(str) { return createHash('md5').update(str).digest('hex') },   // lowercase hex
},
buffer: {
  from(...args) { return Buffer.from(...args) },       // full Node Buffer.from signature
  bufToString(buf, format) { return Buffer.from(buf, 'binary').toString(format) },
},
zlib: {
  inflate(buf)  { return new Promise(/* zlib.inflate  */) },   // → Promise<Buffer>
  deflate(data) { return new Promise(/* zlib.deflate  */) },   // → Promise<Buffer>
}
```

Precise signatures:

| method | signature | returns |
| --- | --- | --- |
| `utils.buffer.from` | `from(value, encodingOrOffset?, length?)` — exactly Node `Buffer.from` | `Buffer` |
| `utils.buffer.bufToString` | `bufToString(buffer, format)` | `string` |
| `utils.crypto.aesEncrypt` | `aesEncrypt(buffer, mode, key, iv)` | `Buffer` |
| `utils.crypto.rsaEncrypt` | `rsaEncrypt(buffer, key)` | `Buffer` |
| `utils.crypto.randomBytes` | `randomBytes(size)` | `Buffer` |
| `utils.crypto.md5` | `md5(str)` | `string` (lowercase hex) |
| `utils.zlib.inflate` | `inflate(buffer)` | `Promise<Buffer>` |
| `utils.zlib.deflate` | `deflate(data)` | `Promise<Buffer>` |

Gotchas:

* **`randomBytes` returns a Buffer, not a string.** The official docs say "生成随机字符串" (generate a
  random *string*); the implementation returns a Node `Buffer`. Treat the docs as wrong here.
* **`rsaEncrypt` is raw RSA-1024 with NO padding.** It left-pads the input to exactly 128 bytes, so inputs
  longer than 128 bytes corrupt silently and the key must be a 1024-bit public key. The `key` argument is
  passed straight to Node's `publicEncrypt` — PEM string **or** KeyObject.
* **`aesEncrypt` passes `mode`/`key`/`iv` straight to `createCipheriv`.** Any Node-supported mode works
  (desktop), the key/iv must be `Buffer`s of the correct length, and padding is Node's default (PKCS#7).
* **`bufToString` re-wraps with `Buffer.from(buf, 'binary')`** before `.toString(format)`. If you pass an
  actual `Buffer` this is a harmless reinterpretation; if you pass a `Uint8Array` it also works. But
  `Buffer.from(buf, 'binary')` on a **string** would reinterpret it as latin-1 — don't pass strings.
* **No `str2b64` / `b642str` methods exist.** Base64 is done with
  `utils.buffer.bufToString(buf, 'base64')` and `utils.buffer.from(str, 'base64')`.
* **No `lx.storage` / `lx.localStorage` / `lx.sessionStorage` exists.** Scripts have no persistent storage
  in the host. (Real scripts that need persistence call their own remote API.)

#### Mobile (partial implementations)

| method | mobile behaviour |
| --- | --- |
| `buffer.from(str, 'utf8'\|'hex'\|'base64')` | → `Uint8Array`. `'binary'` encoding **throws**. Arrays also accepted. |
| `buffer.from(array)` | → `Uint8Array` |
| `buffer.bufToString(buf, 'utf8'\|'hex'\|'base64'\|'binary')` | `'binary'` returns the array itself; `'utf8'`/default decodes UTF-8; `'hex'` lowercase hex; `'base64'` base64 |
| `crypto.aesEncrypt(buffer, mode, key, iv)` | only `'aes-128-cbc'` (PKCS7) and `'aes-128-ecb'` (**NoPadding**) — other modes **throw** |
| `crypto.rsaEncrypt(buffer, key)` | PEM header/footer lines stripped, then `RSA/ECB/NoPadding`. Non-string key throws. |
| `crypto.randomBytes(size)` | → **`Uint8Array`** (not a Buffer), filled with `Math.random()` — **not cryptographically secure** |
| `crypto.md5(str)` | `encodeURIComponent` → native `URLDecoder.decode` → MD5 of UTF-8 bytes → lowercase hex (equivalent to desktop for normal strings) |
| `zlib.inflate` / `zlib.deflate` | **NOT IMPLEMENTED** on mobile (commented out) |

> **AES-ECB padding differs between platforms.** Desktop uses Node's default PKCS#7 for `aes-128-ecb`;
> mobile explicitly uses `AES`/NoPadding. A script relying on ECB padding will produce different output on
> the two platforms. **[UNCERTAIN]** whether this is intentional or an upstream bug — but it is what the
> code does.

---

## 2. The event contract

### 2.1 Event name summary

| event | direction | who calls | payload |
| --- | --- | --- | --- |
| `inited` | script → app | `lx.send` | `{ sources, openDevTools }` (desktop) / `{ sources }` (mobile) |
| `request` | app → script | `lx.on` | `{ source, action, info }` |
| `updateAlert` | script → app | `lx.send` | `{ log, updateUrl? }` |

There are no other events. Anything else rejects.

### 2.2 `inited` — script initialisation

```js
lx.send(lx.EVENT_NAMES.inited, {
  openDevTools: false,     // desktop only; ignored on mobile
  sources: {
    kw: {
      name: '酷我音乐',      // OPTIONAL, and IGNORED by current versions (see below)
      type: 'music',        // REQUIRED, must be exactly 'music'
      actions: ['musicUrl'],// REQUIRED array
      qualitys: ['128k','320k','flac','flac24bit'],  // REQUIRED array
    },
    local: {
      name: '本地音乐',
      type: 'music',
      actions: ['musicUrl','lyric','pic'],
      qualitys: [],
    },
  },
})
```

**Host-side filtering (verbatim logic, identical on desktop and mobile):**

```js
const allSources = ['kw', 'kg', 'tx', 'wy', 'mg', 'local']
const supportQualitys = {
  kw: ['128k','320k','flac','flac24bit'], kg: ['128k','320k','flac','flac24bit'],
  tx: ['128k','320k','flac','flac24bit'], wy: ['128k','320k','flac','flac24bit'],
  mg: ['128k','320k','flac','flac24bit'], local: [],
}
const supportActions = {
  kw: ['musicUrl'], kg: ['musicUrl'], tx: ['musicUrl'], wy: ['musicUrl'],
  mg: ['musicUrl'], xm: ['musicUrl'], local: ['musicUrl','lyric','pic'],
}

for (const source of allSources) {
  const userSource = info.sources[source]
  if (!userSource || userSource.type !== 'music') continue
  sourceInfo.sources[source] = {
    type: 'music',
    actions:  supportActions[source].filter(a => userSource.actions.includes(a)),
    qualitys: supportQualitys[source].filter(q => userSource.qualitys.includes(q)),
  }
}
```

Consequences a compatible player must reproduce:

1. **Only `kw`, `kg`, `tx`, `wy`, `mg`, `local` can be claimed.** A key such as `git`, `bd`, or `xm` in
   `sources` is **silently dropped**. (`xm` appears in `supportActions` but is *not* in `allSources`, so it
   can never be surfaced — an upstream inconsistency.)
2. **`type` must be exactly `'music'`** or the source is skipped.
3. **`sources[x].name` is parsed but discarded** — `sourceInfo.sources[source]` contains only
   `{ type, actions, qualitys }`. The app displays its own localised name. Sending a `name` is harmless
   but has no effect in v2.x.
4. **Qualities are intersected** with the per-source whitelist. `'hires'`, `'atmos'`, `'master'`, `'192k'`,
   `'ape'`, `'wav'` are all dropped. Real-world scripts commonly declare `hires`/`atmos`/`master`; those
   entries silently vanish.
5. **Actions are intersected.** `local` gets `musicUrl`/`lyric`/`pic`; every other source can only ever
   have `musicUrl`.
6. **`info.sources` must exist and `actions`/`qualitys` must be arrays**, or `.includes` throws inside the
   `try`, which is caught and reported as an init failure.
7. **`status` is obsolete.** Scripts written for LX ≤ 2.5.0 still send `status: true`; current hosts ignore
   the field entirely. Init success/failure is now determined by *whether `inited` was sent* and *whether
   an uncaught error occurred first*.
8. **`openDevTools: true`** sends an IPC that opens DevTools on the hidden source window (desktop only).
9. After `handleInit` succeeds, the host starts listening for `request` — **the request channel does not
   exist before `inited`**.

### 2.3 `request` — the app calling the script

Handler payload:

```ts
{
  source: 'kw' | 'kg' | 'tx' | 'wy' | 'mg' | 'local'   // one of the sources you declared
  action: 'musicUrl' | 'lyric' | 'pic'                 // one of the actions you declared
  info: {
    type: string | null      // quality, see §6.  `null` when source === 'local'
    musicInfo: object        // see §5
  }
}
```

The handler **must return a Promise**. The host calls `.then()` on the returned value directly; a
synchronous `throw` inside the handler is caught by the host's `try/catch` and reported as a failure, and a
rejected Promise is reported with the rejection's `.message`.

**Return values by action:**

| action | must resolve with | validation applied by the host |
| --- | --- | --- |
| `musicUrl` | `string` — an HTTP(S) URL | `typeof === 'string'` **and** `length <= 2048` **and** `/^https?:/.test(url)`; otherwise `Error('failed')` |
| `pic` | `string` — an HTTP(S) URL | identical to `musicUrl` |
| `lyric` | `object` | must be an object with a **string** `lyric`; `lyric.length > 51200` → `Error('failed')`; see below |

`lyric` verification, verbatim:

```js
const verifyLyricInfo = (info) => {
  if (typeof info != 'object' || typeof info.lyric != 'string') throw new Error('failed')
  if (info.lyric.length > 51200) throw new Error('failed')
  return {
    lyric:  info.lyric,
    tlyric: (typeof info.tlyric == 'string' && info.tlyric.length < 5120) ? info.tlyric : null,
    rlyric: (typeof info.rlyric == 'string' && info.rlyric.length < 5120) ? info.rlyric : null,
    lxlyric:(typeof info.lxlyric == 'string' && info.lxlyric.length < 8192) ? info.lxlyric : null,
  }
}
```

* The `tlyric`/`rlyric`/`lxlyric` bounds are **strictly less than** (5120 / 5120 / 8192). Oversized or
  non-string values are **silently replaced with `null`**, not rejected.
* Missing `tlyric`/`rlyric`/`lxlyric` are normalised to `null`.
* A non-object return, a missing/non-string `lyric`, or an over-long `lyric` **fails the whole request**.

**`lxlyric` (逐字 / karaoke) format.** Documented as:

```
[分钟:秒.毫秒]<开始时间（基于该句）,持续时间>歌词文字
```

Example from the official docs: `[00:00.000]<0,36>测<36,36>试<50,60>歌<80,75>词`

The app only uses `lxlyric` when the user enables karaoke lyrics; it is optional.

**Response envelope the host builds** (this is what a compatible player must accept internally):

```js
// musicUrl
{ source, action: 'musicUrl', data: { type: <info.type>, url: <returned string> } }
// lyric
{ source, action: 'lyric',    data: { lyric, tlyric, rlyric, lxlyric } }
// pic
{ source, action: 'pic',      data: <returned string> }
```

The renderer then consumes:
`getMusicUrl` → `{ type, url }`; `getLyric` → `res.data`; `getPic` → `res.data` (the raw string).

> **Quirk: `info.type` is present for `lyric` and `pic` too, and it equals `'music'`.**
> In `useInitUserApi.ts` the per-source loop destructures
> `for (const [source, { actions, type, qualitys }] of Object.entries(apiInfo.sources))`, and the
> `lyric`/`pic` closures capture that outer `type` — which is the *source type*, i.e. `'music'`.
> Only the `musicUrl` closure shadows it with the real quality parameter. The official docs describe
> `info` for `lyric`/`pic` as `{musicInfo}` and omit `type`; in practice `info.type === 'music'`.
> Robust scripts should ignore `info.type` for `lyric`/`pic`.

### 2.4 `updateAlert` — script notifying the user of an update

```js
lx.send(lx.EVENT_NAMES.updateAlert, {
  log: 'v2 更新内容…',            // REQUIRED, string, '\n' allowed
  updateUrl: 'https://example.com/update',   // optional
})
```

Host-side handling, verbatim:

```js
const handleShowUpdateAlert = (data, resolve, reject) => {
  if (!data || typeof data != 'object') return reject(new Error('parameter format error.'))
  if (!data.log || typeof data.log != 'string') return reject(new Error('log is required.'))
  if (data.updateUrl && !/^https?:\/\/[^\s$.?#].[^\s]*$/.test(data.updateUrl) && data.updateUrl.length > 1024)
    delete data.updateUrl
  if (data.log.length > 1024) data.log = data.log.substring(0, 1024) + '...'
  sendMessage(USER_API_RENDERER_EVENT_NAME.showUpdateAlert, { log: data.log, updateUrl: data.updateUrl })
  resolve()
}
```

* Callable **once per script run**.
* `log` is required and is **truncated** (not rejected) at 1024 chars, with `'...'` appended.
* The `updateUrl` guard is `A && B && C` — the URL is only dropped when it is **both** malformed **and**
  longer than 1024 chars. A malformed but short URL is **kept** and later passed to `openUrl`.
  (Upstream bug; replicate or tighten as you prefer, but note the divergence.)
* **Main process gate:** `if (!userApi.allowShowUpdateAlert) return`. The alert only appears if the user
  enabled "allow this source to show update alerts" for that source. Default is `true` on import
  (`allowShowUpdateAlert: true` in `importApi`), but pre-existing entries without the field are forced to
  `false` by `getUserApis()`.
* The dialog shows `源更新提示：{name}\n{log}` with an "open update page" button when `updateUrl` exists.

---

## 3. How a source script is structured

### 3.1 File format

* **UTF-8**, plain **`.js`**, ES6+ syntax allowed. No bundler, no modules — the file is evaluated as a
  **script** (not a module), so top-level `import`/`export` are **not** available.
* A real-world 740 KB installed script exists, so size is not practically constrained for local import.
* **Online import limit: 9 000 000 characters** (`if (script.length > 9_000_000) → 'Too large script'`),
  fetched with `follow_max: 3` and requiring an `http(s)://` URL.
* The **maximum number of imported sources is 20** — the UI blocks import when
  `userApi.list.length > 20` (so 21 entries can exist in practice; the check is `>`, not `>=`).

### 3.2 The mandatory metadata header

The file **must begin with a block comment at byte 0**. The parser:

```js
const parseScriptInfo = (script) => {
  const result = /^\/\*[\S|\s]+?\*\//.exec(script)     // NOTE: ^ with no /m flag → start of file
  if (!result) throw new Error('无效的自定义源文件')
  let scriptInfo = matchInfo(result[0])
  scriptInfo.name ||= `user_api_${new Date().toLocaleString()}`
  return scriptInfo
}

const INFO_NAMES = { name: 24, description: 36, author: 56, homepage: 1024, version: 36 }
const matchInfo = (scriptInfo) => {
  const infoArr = scriptInfo.split(/\r?\n/)
  const rxp = /^\s?\*\s?@(\w+)\s(.+)$/
  // … collects key/value, ignores keys not in INFO_NAMES
  // … truncates over-length values to `len` chars + '...'
}
```

Rules:

* **No leading whitespace, BOM, or code before `/**`.** A BOM or a blank line first →
  `无效的自定义源文件` ("invalid custom source file").
* Line format inside the comment: optional single space, `*`, optional single space, `@key`, **exactly one
  whitespace**, then the value. ` * @name Foo` works; deeply-indented variants may not.
* Recognised keys and truncation limits: `@name` 24, `@description` 36, `@author` 56, `@homepage` 1024,
  `@version` 36. **Over-length values are truncated with `'...'`, never rejected.**
* Unrecognised tags (`@repository`, `@license`, …) are ignored.
* `@name` is the only one that matters functionally; if absent, a timestamped fallback name is generated.
* All keys are optional in principle, but `@name` is strongly expected.

Canonical header (from the official docs):

```js
/**
 * @name 测试脚本
 * @description 我只是一个测试脚本
 * @version 1.0.0
 * @author xxx
 * @homepage http://xxx
 */
```

### 3.3 Import & storage (desktop)

`importApi(script)`:

* parses the header (throws on a bad header),
* **deflates** the raw script and base64-encodes it with a `gz_` prefix,
* rejects duplicates: identical compressed script → `导入失败，脚本内容与已有的源「X」相同`,
* assigns `id = 'user_api_' + <3 random digits> + '_' + Date.now()`,
* stores `{ id, name, description, version, author, homepage, allowShowUpdateAlert, script: 'gz_…' }`
  in the electron-store namespace **`user_api`**, key **`userApis`**.
* `getUserApis()` returns entries **without** `script`; `getScript(id)` inflates on demand.
* On startup, entries lacking a `version` field are re-parsed from the stored script; entries that fail to
  parse are **dropped**.

### 3.4 Execution model — desktop

The script is **not** run in a Node `vm`, a Web Worker, or a Node sandbox. It runs as a
**renderer main-world script inside a dedicated hidden `BrowserWindow`**:

```js
browserWindow = new BrowserWindow({
  resizable: false, minimizable: false, maximizable: false,
  fullscreenable: false, roundedCorners: false, hasShadow: false, show: false,
  webPreferences: {
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    sandbox: false,
    spellcheck: false,
    autoplayPolicy: 'document-user-activation-required',
    enableWebSQL: false,
    disableDialogs: true,
    webgl: false,
    images: false,
    preload: <user-api-preload.js>,
  },
})
```

Additionally:

* `will-navigate`, `will-redirect`, `will-attach-webview`, `will-prevent-unload`,
  `media-started-playing` are all `preventDefault()`-ed.
* `setPermissionRequestHandler` **denies every permission** for that window.
* `setWindowOpenHandler` → `{ action: 'deny' }`.
* The page is `user-api.html`, loaded via `loadURL('data:text/html;charset=UTF-8,' + encodeURIComponent(html))`,
  and its only security-relevant content is:
  `<meta http-equiv="Content-Security-Policy" content="default-src 'none'">`.
* The script itself is injected with `webFrame.executeJavaScript(userApi.script)` — i.e. into the **main
  world** of that blank page, *after* the preload has exposed `lx`.

Therefore, on **desktop**, a script *does* see:

* ✅ `window`, `document` (a blank page), `console`, `setTimeout`/`clearTimeout`, `Promise`, all standard
  JS built-ins, `JSON`, `Math`, `TextEncoder`/`TextDecoder`, etc.
* ✅ `globalThis.lx`
* ❌ `require`, `process`, `module`, `Buffer` (as a global), `fs`, `path` — `contextIsolation: true` +
  `nodeIntegration: false`. The only `Buffer` is `lx.utils.buffer`.
* ❌ `fetch`, `XMLHttpRequest`, `WebSocket`, `<img>`, `<script src>`, `importScripts` — **blocked by
  `default-src 'none'`** (connect-src/script-src/img-src all fall back to it). Network must go through
  `lx.request`.
* ❌ `alert`/`confirm`/`prompt` — `disableDialogs: true`.
* ❌ `localStorage`/`indexedDB` are cleared on every source switch
  (`clearStorageData()` in `closeWindow()`), so they are effectively useless for persistence.
* ❌ `eval` is *not* blocked on desktop (only mobile blocks it).

### 3.5 Execution model — mobile

* Engine: **QuickJS** via `com.whl.quickjs.android`, on a dedicated `JavaScriptThread`.
* The preload `android/app/src/main/assets/script/user-api-preload.js` is evaluated first and defines
  `globalThis.lx_setup(key, id, name, description, version, author, homepage, rawScript)`.
* `lx_setup` builds `globalThis.lx`, deletes its own native hooks, installs `setTimeout`/`clearTimeout`,
  then the host evaluates the **user script**.
* **No DOM, no `window`, no Node, no `fetch`/`XHR`, no `Buffer` global.**
* Host APIs available: **only `setTimeout` and `clearTimeout`** (per the docs; the source confirms these
  are the only globals installed).
* **`eval` throws `'eval is not available'`.**
* **The `Function` constructor is replaced with a Proxy that throws
  `'Dynamic code execution is not allowed.'`** on both `apply` and `construct`. This means template-based
  code generation, `new Function(...)`, and libraries that use it (some crypto/parser libs) will fail.
* **Built-in prototype properties are frozen** (made non-writable, non-configurable) except
  `Function.prototype.toString`, `Function.prototype.toLocaleString`, and `Object.prototype.toString`.
  Monkey-patching built-ins (`Array.prototype.push = …`) silently does nothing; **adding** new properties
  (`Array.prototype.myPush = …`) is allowed.
* `Function.prototype.toString` is overridden to return `[native code]` for non-configurable functions.
* `console.*` is bridged to the RN logger via `Console.java`.
* An uncaught JS exception surfaces as an init failure if it happens before `inited`.

### 3.6 A note on writing cross-platform scripts

Use `globalThis.lx`, never `window.lx`. Guard on `lx.env`. Avoid `eval`/`Function`. Avoid relying on
`Buffer` semantics (`instanceof Buffer`, `Buffer.concat`) — on mobile these are `Uint8Array`s. Avoid
`lx.utils.zlib` unless you also provide a pure-JS fallback. Wrap the whole file in an IIFE to avoid
top-level `const`/`let` collisions (real-world scripts do exactly this).

---

## 4. Complete action reference

### 4.1 The three actions

| action | available for | request payload | must resolve with |
| --- | --- | --- | --- |
| `musicUrl` | `kw`, `kg`, `tx`, `wy`, `mg`, `local` | `{ type: Quality \| null, musicInfo }` | HTTP(S) URL string (≤ 2048) |
| `lyric` | **`local` only** | `{ type: 'music', musicInfo }` (see §2.3 quirk) | `{ lyric, tlyric?, rlyric?, lxlyric? }` |
| `pic` | **`local` only** | `{ type: 'music', musicInfo }` | HTTP(S) URL string (≤ 2048) |

### 4.2 Actions that do **not** exist

The task brief asked about `hotSearch`, `search`, `songList`, `leaderboard`, `tipSearch`, `auth`, etc.
**None of these are custom-source actions.** They are internal `musicSdk[source]` methods
(`musicSearch`, `songList`, `leaderboard`, `hotSearch`, `tipSearch`, `comment`, `album`, `singer`) that the
app implements itself against each platform's HTTP API. A custom source can **never** influence search,
song lists, leaderboards, hot searches, or comments — it only supplies a playable URL (plus, for `local`,
lyrics and cover art).

`auth` in particular: **no evidence of an `auth` action exists in any v2.x source or in the documentation
history.** Treat any claim that it exists as incorrect.

> Note for completeness: `supportActions` does contain an `xm` entry (`['musicUrl']`), but `xm` is absent
> from `allSources`, so it is unreachable. Likewise the `bd` (百度音乐) source module still exists in
> `musicSdk` but is commented out of the source list.

### 4.3 Response envelope (internal, for a compatible implementation)

```
script  ──resolve──▶  host validates  ──▶  { source, action, data }  ──▶  app
```

* `musicUrl` → `data = { type: info.type, url: <string> }`
* `lyric`    → `data = { lyric, tlyric, rlyric, lxlyric }`
* `pic`      → `data = <string>` (not wrapped)

The app then caches the URL per `(musicInfo, quality)` and hands it to the audio player.

---

## 5. `info.musicInfo` — the music object delivered to scripts

The app stores a **new-style** `MusicInfo` internally and converts it to the **legacy "old" shape**
before sending it to a source script, via `toOldMusicInfo()` in `src/common/utils/tools.ts`.

### 5.1 Common fields (all sources)

```js
{
  name:      string,          // 歌曲名
  singer:    string,          // 艺术家，多个用 '、' 连接
  source:    'kw'|'kg'|'tx'|'wy'|'mg'|'local',
  songmid:   string|number,   // = meta.songId — THE primary id (see §5.3)
  interval:  string|null,     // 格式化时长, e.g. '03:55'
  albumName: string,
  img:       string,          // 封面 URL, '' if unknown
  typeUrl:   {},              // always {} (legacy, unused)
  albumId:   string|number|undefined,
  types:     Array<{ type: Quality, size: string|null, hash?: string }>,
  _types:    Record<Quality, { size: string|null, hash?: string }>,
}
```

* `types` is the array form; `_types` is the map form. Both describe **the qualities this particular track
  has on its own platform**, not what your source supports.
* `types[i].hash` is present **only for `kg`**.
* `interval` may be `null`.
* `songmid` is always set (it is `meta.songId`), but see the per-source notes — for `kg` the useful
  identifier is `hash`, not `songmid`.

### 5.2 Per-source extra fields

| source | extra fields on `musicInfo` |
| --- | --- |
| `kw` | *(none)* |
| `kg` | `hash: string` (FileHash), `albumAudioId: string` (MixSongID, used for precise lyric lookup) |
| `tx` | `strMediaMid: string`, `albumMid: string`, **`songId: number`** (the numeric QQ song id) |
| `wy` | *(none)* |
| `mg` | `copyrightId: string`, `lrcUrl?: string`, `mrcUrl?: string`, `trcUrl?: string` |
| `local` | `filePath: string`, `ext: string` (without dot), `albumId: ''`, `types: []`, `_types: {}` |

### 5.3 What identifier should a script use?

| source | recommended id | rationale |
| --- | --- | --- |
| `kw` | `musicInfo.songmid` | Kuwo `MUSICRID` numeric id (e.g. `62355680`) |
| `kg` | **`musicInfo.hash`** | Kugou FileHash; `songmid` is `Audioid`, which is *not* sufficient to resolve audio |
| `tx` | `musicInfo.songmid` (song mid) or `musicInfo.songId` (numeric) or `musicInfo.strMediaMid` | `songmid` = `item.mid`, `songId` = `item.id`, `strMediaMid` = `file.media_mid` (required by some endpoints) |
| `wy` | `musicInfo.songmid` | NetEase numeric song id |
| `mg` | `musicInfo.copyrightId` (or `songmid` = `songId`) | Migu's audio endpoints key off `copyrightId` |
| `local` | `musicInfo.filePath` (or `songmid`, which equals the path) | local file path |

The widely-copied real-world idiom is exactly this:

```js
const songId = musicInfo.hash ?? musicInfo.songmid   // kg → hash, everything else → songmid
```

**Caution:** several public scripts also read `musicInfo.id`. **`id` is not part of the old shape** —
`toOldMusicInfo` never emits it. `musicInfo.id` is `undefined` in a source script. (For `tx` the numeric id
is `songId`, camelCase.) This is a common bug in third-party sources.

### 5.4 Internal (new-style) shape, for reference

If you are building a player, this is the shape LX stores and what `toOldMusicInfo` reads from:

```ts
interface MusicInfoMetaBase { songId: string|number; albumName: string; picUrl?: string|null }
interface MusicInfoMeta_online extends MusicInfoMetaBase {
  qualitys: MusicQualityType[]            // [{ type, size }]
  _qualitys: Partial<Record<Quality, { size: string|null }>>
  albumId?: string|number
}
interface MusicInfoMeta_kg extends MusicInfoMeta_online {
  qualitys: MusicQualityTypeKg[]          // [{ type, size, hash }]
  _qualitys: Partial<Record<Quality, { size, hash }>>
  hash: string
  albumAudioId?: string
}
interface MusicInfoMeta_tx extends MusicInfoMeta_online {
  strMediaMid: string; id?: number; albumMid?: string
}
interface MusicInfoMeta_mg extends MusicInfoMeta_online {
  copyrightId: string; lrcUrl?: string; mrcUrl?: string; trcUrl?: string
}
interface MusicInfoMeta_local extends MusicInfoMetaBase { filePath: string; ext: string }

interface MusicInfoBase<S> { id: string; name: string; singer: string; source: S; interval: string|null; meta: ... }
```

`MusicInfo.id` is a composite string: `` `${source}_${songmid}` `` generally, but
`` `${songmid}_${hash}` `` for **kg**, and the **file path** for **local**.

---

## 6. Quality (音质) handling

### 6.1 The quality vocabulary

```ts
type Quality = '128k' | '320k' | 'flac' | 'flac24bit' | '192k' | 'ape' | 'wav'
```

`QUALITYS = ['flac24bit', 'flac', 'wav', 'ape', '320k', '192k', '128k']` (descending order constant).

**Custom sources may only use the first four:** `128k`, `320k`, `flac`, `flac24bit`.
`192k`, `ape`, `wav` are legacy/type-only; anything outside the four is filtered out of `inited`.

Legacy alias: internal data may contain **`flac32bit`**, which is normalised to `flac24bit`
(`toNewMusicInfo` / `fixNewMusicInfoQuality` rename the key and rewrite `qualitys[].type`).

**There is no `hires` quality in LX.** Where a platform exposes "Hi-Res" (e.g. QQ Music's `size_hires`,
NetEase's `maxBrLevel == 'hires'`), LX maps it onto **`flac24bit`**.

### 6.2 The quality key mapping the script must implement

The script receives the LX key in `info.type` and must translate it to its backend's own vocabulary. The
official sample shows this pattern explicitly:

```js
const qualitys = {
  kw: { '128k': '128', '320k': '320', flac: 'flac', flac24bit: 'flac24bit' },
  local: {},   // local passes null
}
// …
apis[source].musicUrl(info.musicInfo, qualitys[source][info.type])
```

Platform-native quality codes, as used by LX's own built-in SDKs (useful for a compatible backend):

| LX key | kw | kg | tx | wy | mg |
| --- | --- | --- | --- | --- | --- |
| `128k` | bitrate `128` | `FileHash` / `FileSize` | `size_128mp3` / `l` | `l` / `maxbr 128000` | formatType `PQ` |
| `320k` | bitrate `320` | `HQFileHash` / `HQFileSize` | `size_320mp3` / `h` | `h` / `maxbr 320000` | formatType `HQ` |
| `flac` | bitrate `2000` | `SQFileHash` / `SQFileSize` | `size_flac` / `sq` | `sq` / `maxbr 999000` | formatType `SQ` |
| `flac24bit` | bitrate `4000` | `ResFileHash` / `ResFileSize` | `size_hires` / `hr` | `hr` (`maxBrLevel == 'hires'`) | formatType `ZQ24` (older: `ZQ`) |

*(kw bitrates come from `N_MINFO` `level:…,bitrate:…,format:…,size:…`; the built-in kw SDK maps
`4000→flac24bit`, `2000→flac`, `320→320k`, `128→128k`.)*

### 6.3 How the app chooses the quality it asks for

```js
export const TRY_QUALITYS_LIST = ['flac24bit', 'flac', '320k']

export const getPlayQuality = (highQuality, musicInfo) => {
  let type = '128k'
  if (TRY_QUALITYS_LIST.includes(highQuality)) {
    const list = qualityList.value[musicInfo.source]     // what the custom source declared in `inited`
    const t = TRY_QUALITYS_LIST
      .slice(TRY_QUALITYS_LIST.indexOf(highQuality))
      .find(q => musicInfo.meta._qualitys[q] && list?.includes(q))
    if (t) type = t
  }
  return type
}
```

So the requested quality is the user's `player.playQuality` setting **downgraded** to the best quality that
is present in **both** the track's own `_qualitys` **and** the source's declared `qualitys`. If the user
picks `128k`, or the user's pick isn't one of the top three, `128k` is used directly.

If a request for a quality fails, the app may retry other qualities / other sources:
`getOnlineOtherSourceMusicUrl` walks candidate `musicInfos`, skipping ones without the target quality.

For the **`local`** pseudo-source, quality is forced: `getOnlineOtherSourceMusicUrlByLocal` uses
`quality = '128k'` for caching but calls
`apis('local').getMusicUrl(toOldMusicInfo(musicInfo), null)` — hence **`info.type === null`**.

### 6.4 What a source script should declare

Declare only the qualities you can genuinely serve. Because the host intersects your list with
`['128k','320k','flac','flac24bit']`, you may safely include extra keys in your own lookup table — they
just will not be requested. A script that declares `['320k']` will only ever be asked for `320k`.

---

## 7. Which sources LX ships

### 7.1 The source registry

`src/renderer/utils/musicSdk/index.js`:

```js
const sources = {
  sources: [
    { name: '酷我音乐', id: 'kw' },
    { name: '酷狗音乐', id: 'kg' },
    { name: 'QQ音乐',   id: 'tx' },
    { name: '网易音乐', id: 'wy' },
    { name: '咪咕音乐', id: 'mg' },
    { name: '虾米音乐', id: 'xm' },
    // { name: '百度音乐', id: 'bd' },   // commented out
  ],
  kw, kg, tx, wy, mg, bd, xm,
}
```

* `bd` (Baidu) module still exists and is exported, but is **not** in the visible source list.
* `xm` (Xiami) **is** in the list, but every `getMusicUrl`/`getLyric`/`getPic` returns
  `Promise.reject(new Error('fail'))` — it is a dead source kept for comment support only.
* `xm` is additionally excluded from cross-source search (`excludeSource = ['xm']`).
* These five/six ids are exactly the *search / song-list / leaderboard / lyric / comment* providers.

### 7.2 There are no built-in playable API sources

`src/renderer/utils/musicSdk/api-source-info.ts` ships an **empty array** — every entry (including
`test` and `temp`) is commented out:

```ts
const sources: Array<{ id, name, disabled, supportQualitys }> = [
  // { id: 'test', name: '测试接口', … },
  // { id: 'temp', name: '临时接口', … },
]
export default sources
```

Since `api-source.js` builds `apiList`/`supportQuality` **from `apiSourceInfo`**, and
`apis(source)` throws `new Error('Api is not found')` when nothing matches, **no built-in source can
resolve a playback URL.** `musicSdk.supportQuality` is `{}`.

`CHANGELOG.md` v2.6.0 (2023-10-18):

> 移除所有内置源，由于收到腾讯投诉要求停止提供软件内置的连接到他们平台的在线播放及下载服务，
> 所以从即日（2023年10月18日）起LX本身不再提供上述服务

**Consequence for a compatible player:** the app is a *finder* (search/playlists/lyrics/comments) plus a
*player shell*. Playback only works once the user imports a custom source. If you want to ship built-in
playback, you must implement the `apiList[`${apiId}_api_${source}`]` provider mechanism yourself —
`apiSourceInfo` entries are `{ id, name, disabled, supportQualitys: Partial<Record<OnlineSource, Quality[]>> }`
and each provider must expose at minimum
`getMusicUrl(songInfo, quality) → { promise, cancelHttp }`.

### 7.3 The `songmid` / id scheme per source

| source | `songmid` is | additional identity fields | `MusicInfo.id` |
| --- | --- | --- | --- |
| `kw` | Kuwo numeric music id (`MUSICRID` with `MUSIC_` stripped), e.g. `62355680` | `albumId` | `kw_<songmid>` |
| `kg` | Kugou `Audioid` | `hash` (`FileHash`), `albumAudioId` (`MixSongID`), `albumId` | `<songmid>_<hash>` |
| `tx` | QQ song **mid** (`item.mid`, alphanumeric) | `songId` (`item.id`, numeric), `strMediaMid` (`file.media_mid`), `albumMid`, `albumId` | `tx_<songmid>` |
| `wy` | NetEase numeric song id | `albumId` | `wy_<songmid>` |
| `mg` | Migu `songId` | `copyrightId`, `lrcUrl`, `mrcUrl`, `trcUrl`, `albumId` | `mg_<songmid>` |
| `local` | the file path | `filePath`, `ext` | the file path |

Built-in detail pages (for reference):
`kw` → `http://www.kuwo.cn/play_detail/${songmid}`,
`kg` → `https://www.kugou.com/song/#hash=${hash}&album_id=${albumId}`,
`tx` → `https://y.qq.com/n/yqq/song/${songmid}.html`,
`wy` → `https://music.163.com/#/song?id=${songmid}`,
`mg` → `http://music.migu.cn/v3/music/song/${copyrightId}`.

### 7.4 How the source list is represented in the UI

`SettingBasic.vue` builds the radio list from:

```js
[
  ...apiSourceInfo.map(api => ({ id, name, label: api.name, disabled: api.disabled })),   // empty today
  ...userApi.list.map(api => ({
    id: api.id,
    name: api.name,
    label: `${api.name}${api.id == appSetting['common.apiSource'] ? `[${statusLabel}]` : ''}`,
    desc: [/^\d/.test(api.version) ? `v${api.version}` : api.version].filter(Boolean).join(', '),
    statusLabel: api.id == appSetting['common.apiSource'] ? `[${statusLabel}]` : '',
    disabled: false,
  })),
]
```

The active source id is persisted in `appSetting['common.apiSource']`. Custom-source ids match
`/^user_api/`; `api-source.js` dispatches on that prefix:

```js
const apis = source => {
  if (/^user_api/.test(apiSource.value)) return userApi.apis[source]
  const api = getAPI(source)
  if (api) return api
  throw new Error('Api is not found')
}
```

`userApi.apis` is populated from the `inited` payload as `{ [source]: { getMusicUrl, getLyric?, getPic? } }`.

---

## 8. Script lifecycle & error handling

### 8.1 Full lifecycle (desktop)

```
user selects source  →  setUserApi(apiId)                      [renderer/core/apiSource.ts]
  ├─ qualityList = {}; userApi.status = false; message = 'initing'
  └─ IPC set_user_api(apiId)
       → main: setApi(id)
            ├─ closeWindow()          (destroys any previous source window, clears its storage/cache/auth)
            └─ loadApi(id)
                 ├─ getUserApis().find(api => api.id == id)   → throw 'api not found'
                 └─ createWindow(userApi)
                      ├─ loadURL('data:text/html;charset=UTF-8,' + user-api.html)
                      └─ on('ready-to-show'):
                           sendEvent(initEnv, { ...userApi, script: await getScript(id), proxy })
                            → preload initEnv()
                                 ├─ contextBridge.exposeInMainWorld('lx', {…})
                                 ├─ exposeInMainWorld('__lx_init_error_handler__', { sendError })
                                 ├─ webFrame.executeJavaScript(<error+unhandledrejection listeners>)
                                 └─ webFrame.executeJavaScript(userApi.script)
  script runs …
  script calls lx.send('inited', {...})
    → preload handleInit → IPC userApi_init { status, message, data }
      → rendererEvent.handleInit
         → apiStatus = { status: true, apiInfo: { ...userApi, sources } }
         → sendStatusChange → renderer builds userApi.apis + qualityList
         → ipcRenderer.on('userApi_request', …)  ← request channel opens ONLY here
  app calls request  →  IPC request_user_api  →  rendererEvent.request()
    → 20 s timeout armed  →  sendEvent('userApi_request', { requestKey, data })
      → preload handleRequest → events.request.call(lx, { source, action, info })
        → validates + IPC userApi_response
          → rendererEvent.handleResponse → resolves/rejects the pending promise
```

### 8.2 `inited` semantics, precisely

* `inited` may be sent **once**. A second call rejects `Error('Script is inited')`.
* **Any uncaught error or unhandled promise rejection before `inited` is a fatal init failure.**
  The listeners are installed *before* the script runs:

  ```js
  window.addEventListener('error', (event) => {
    if (event.isTrusted) globalThis.__lx_init_error_handler__.sendError(
      event.message.replace(/^Uncaught\sError:\s/, ''))
  })
  window.addEventListener('unhandledrejection', (event) => {
    if (!event.isTrusted) return
    const message = typeof event.reason === 'string' ? event.reason
                  : event.reason?.message ?? String(event.reason)
    globalThis.__lx_init_error_handler__.sendError(message.replace(/^Error:\s/, ''))
  })
  ```

* `onError(message)` **only acts once** (`if (isInitedApi) return`) and then sets `isInitedApi = true`.
  So the first pre-`inited` error permanently marks the script as inited/failed and **suppresses all
  later init errors** — including a subsequent legitimate `inited`.
  Messages are truncated to 1024 chars + `'...'`.
* To **deliberately** fail initialisation (e.g. a required remote config fetch failed), simply `throw`.
  This replaced the old `status: false` mechanism in v2.6.0.
* Errors thrown **after** `inited` are **not** reported as init failures. They surface only as the
  rejection of the individual `request` promise (and to `console`).
* On success, `apiStatus = { status: true, apiInfo: { ...userApi, sources } }`.
  On failure, `apiStatus = { status: false, apiInfo: userApi, message }` and the renderer shows a dialog:
  `user_api__init_failed_alert` with the source name and the message.

### 8.3 Request timeout and cancellation

Desktop (`rendererEvent.ts`):

```js
export const request = async({ requestKey, data }) => await new Promise((resolve, reject) => {
  if (!userApi) reject(new Error('user api is not load'))
  // clear any previous timer for this key, then cancel that request
  timeouts.set(requestKey, setTimeout(() => { cancelRequest(requestKey) }, 20000))
  requestQueue.set(requestKey, [resolve, reject, data])
  sendRequest({ requestKey, data })
})

export const cancelRequest = (requestKey) => {
  if (!requestQueue.has(requestKey)) return
  const request = requestQueue.get(requestKey)
  request[1](new Error('Cancel request'))
  requestQueue.delete(requestKey)
  clearRequestTimeout(requestKey)
}
```

* **20 000 ms budget for the entire `request` handler promise** — including every nested `lx.request` the
  handler makes. Exceeding it rejects with `Error('Cancel request')`.
* `handleResponse` clears the timer and resolves/rejects with `Error(message)` from the script's rejection.
* Mobile uses the same 20 000 ms budget but rejects with `Error('request timeout')`.

Renderer side, additionally: `sendUserApiRequest` rejects with `Error('source changed')` if the user
switches the active source while a request is in flight (a watcher on `appSetting['common.apiSource']`).

### 8.4 Error propagation summary

| failure | where | surfaces as |
| --- | --- | --- |
| bad/absent header comment at import | `parseScriptInfo` | import error `无效的自定义源文件` |
| duplicate script at import | `importApi` | `导入失败，脚本内容与已有的源「X」相同` |
| `info.sources` missing / `actions`/`qualitys` not arrays | `handleInit` try/catch | init failure with the JS error message |
| `info.sources` has no valid source | `handleInit` | **init "succeeds"** with `sources: {}` — the source is simply unusable |
| first uncaught error before `inited` | `onError` | init failure, message truncated to 1024 |
| `inited` sent twice | `send` | rejected promise `Script is inited` |
| no `request` handler registered | `handleRequest` | response `status: false`, message `Request event is not defined` |
| handler returns non-Promise | host `.then` | request failure |
| handler rejects | host `.catch` | response `status: false`, `err.message` |
| `musicUrl`/`pic` result not a ≤2048-char http(s) string | host validation | `Error('failed')` |
| `lyric` result invalid | `verifyLyricInfo` | `Error('failed')` |
| handler exceeds 20 s | `rendererEvent.request` | `Error('Cancel request')` (desktop) / `Error('request timeout')` (mobile) |
| user switches source mid-request | renderer watcher | `Error('source changed')` |
| `updateAlert` twice | `send` | rejected `The update alert can only be called once.` |
| `updateAlert` without `log` | `handleShowUpdateAlert` | rejected `log is required.` |

---

## 9. Documented and source-verified limits

### 9.1 Network

* **All network access must go through `lx.request`.** On desktop, `default-src 'none'` CSP blocks
  `fetch`, `XMLHttpRequest`, `WebSocket`, `<script src>`, `<img>`, etc. On mobile those APIs do not exist.
* `lx.request` is **not subject to CORS** — it is a native/Node HTTP client, not a browser request.
* It **does** honour the app's proxy settings: `network.proxy.enable` / `host` / `port`, or the
  `-proxy-server="host:port"` command-line parameter. The proxy is read live and pushed to the source
  window on config change (`userApi_proxyUpdate`). On desktop it uses the `tunnel` package
  (`httpsOverHttp` / `httpOverHttp`).
* Desktop timeouts: connect (`open_timeout`) 10 s default, response headers (`response_timeout`) 60 s
  default / max, no read timeout.
* Mobile: no `raw`/`bytes` on responses.

### 9.2 Sandbox restrictions

| restriction | desktop | mobile |
| --- | --- | --- |
| `require` / `process` / Node globals | ❌ (`contextIsolation: true`, `nodeIntegration: false`) | ❌ |
| `Buffer` global | ❌ (only `lx.utils.buffer`) | ❌ |
| `fetch` / `XHR` / `WebSocket` | ❌ (CSP) | ❌ (absent) |
| DOM / `document` / `window` | ✅ present but a blank, CSP-locked page | ❌ absent |
| `eval` | ✅ allowed | ❌ throws `'eval is not available'` |
| `new Function()` | ✅ allowed | ❌ throws `'Dynamic code execution is not allowed.'` |
| monkey-patching built-ins | ✅ | ❌ frozen (adding *new* props is allowed) |
| `localStorage` / `indexedDB` | cleared on every source switch | ❌ |
| `alert` / `confirm` / `prompt` | ❌ (`disableDialogs: true`) | ❌ |
| `setTimeout` / `clearTimeout` | ✅ (native) | ✅ (injected) |
| permissions (camera, clipboard, …) | ❌ all denied | ❌ |
| popups / navigation | ❌ denied / prevented | ❌ |

### 9.3 Numeric limits

| limit | value | enforced where |
| --- | --- | --- |
| `musicUrl` / `pic` URL | ≤ 2048 chars, must match `/^https?:/` | `preload.js` |
| `lyric` | ≤ 51200 chars (strictly `> 51200` fails) | `verifyLyricInfo` |
| `tlyric` | `< 5120`, else silently `null` | `verifyLyricInfo` |
| `rlyric` | `< 5120`, else silently `null` | `verifyLyricInfo` |
| `lxlyric` | `< 8192`, else silently `null` | `verifyLyricInfo` |
| `updateAlert.log` | truncated at 1024 (+ `'...'`) | `handleShowUpdateAlert` |
| `updateAlert.updateUrl` | 1024 (see the quirky guard in §2.4) | `handleShowUpdateAlert` |
| init error message | truncated at 1024 (+ `'...'`) | `onError` |
| `lx.request` timeout option | clamped to ≤ 60000 ms | `preload.js` |
| app→script request budget | 20 000 ms | `rendererEvent.ts` / mobile `index.ts` |
| header `@name` | 24 (truncated) | `matchInfo` |
| header `@description` | 36 (truncated) | `matchInfo` |
| header `@author` | 56 (truncated) | `matchInfo` |
| header `@version` | 36 (truncated) | `matchInfo` |
| header `@homepage` | 1024 (truncated) | `matchInfo` |
| imported sources | UI blocks import when count `> 20` | `UserApiModal.vue` |
| online-import script size | 9 000 000 chars | `UserApiOnlineImportModal.vue` |
| online-import redirects | `follow_max: 3` | `UserApiOnlineImportModal.vue` |
| mobile native arg length | 1 048 576 chars per arg; 2 097 152 per JSON payload | mobile preload `checkLength` |

### 9.4 Things that do **not** exist (frequently asked about)

* `lx.storage`, `lx.localStorage`, `lx.sessionStorage` — **no such API**.
* `lx.utils.crypto.str2b64` / `b642str` / `sha1` / `hmac` / `base64` — **no such API**.
  Use `utils.buffer.from` / `utils.buffer.bufToString` with `'base64'`.
* `lx.utils.zlib` on mobile.
* `lx.off` / `lx.removeEvent` / `lx.removeAllEvents` — commented out upstream.
* Any action other than `musicUrl`, `lyric`, `pic`.
* Any source key other than `kw`, `kg`, `tx`, `wy`, `mg`, `local`.
* Any quality other than `128k`, `320k`, `flac`, `flac24bit`.
* Async/streaming responses, file downloads, or access to the local filesystem.

---

## 10. Desktop vs mobile — compatibility matrix

| aspect | desktop | mobile |
| --- | --- | --- |
| engine | Chromium renderer (main world of a hidden `BrowserWindow`) | QuickJS |
| API object | `window.lx` (== `globalThis.lx`) | `globalThis.lx` |
| `lx.env` | `'desktop'` | `'mobile'` |
| `lx.version` | `'2.0.0'` | `'2.0.0'` |
| `inited.openDevTools` | honoured | ignored (documented) |
| host APIs | full browser page globals (minus network) | only `setTimeout` / `clearTimeout` |
| `lx.utils.zlib` | ✅ | ❌ not implemented |
| `lx.utils.buffer.*` | full Node `Buffer` | `Uint8Array`, only `utf8`/`hex`/`base64` |
| `lx.utils.crypto.randomBytes` | `Buffer`, CSPRNG | `Uint8Array`, `Math.random()` |
| `lx.utils.crypto.aesEncrypt` | any Node mode, PKCS#7 default | only `aes-128-cbc` (PKCS7) / `aes-128-ecb` (**NoPadding**) |
| `lx.utils.crypto.rsaEncrypt` | raw RSA-1024 NoPadding, 128-byte left pad | raw RSA NoPadding, PEM headers stripped |
| `lx.request` response | `{ statusCode, statusMessage, headers, bytes, raw, body }` | `{ statusCode, statusMessage, headers, body }` |
| `lx.request` extra option | — | `binary: true` |
| `eval` / `Function` | allowed | blocked |
| built-in prototype mutation | allowed | frozen |
| request-timeout error text | `'Cancel request'` | `'request timeout'` |

---

## 11. Minimal working source scripts

### 11.1 The absolute minimum (single source, `musicUrl` only)

```js
/**
 * @name My Source
 * @description Minimal LX custom source
 * @version 1.0.0
 * @author you
 * @homepage https://example.com
 */

const { EVENT_NAMES, request, on, send } = globalThis.lx

// Map LX quality keys to whatever your backend expects.
const QUALITY_MAP = {
  '128k': '128',
  '320k': '320',
  flac: 'flac',
  flac24bit: 'flac24bit',
}

const httpRequest = (url, options = {}) =>
  new Promise((resolve, reject) => {
    request(url, options, (err, resp) => {
      if (err) return reject(err)
      resolve(resp.body)          // already JSON-parsed when the body is valid JSON
    })
  })

on(EVENT_NAMES.request, ({ source, action, info }) => {
  if (source !== 'kw') return Promise.reject(new Error('unsupported source'))
  if (action !== 'musicUrl') return Promise.reject(new Error('unsupported action'))

  const { musicInfo, type } = info
  const quality = QUALITY_MAP[type]
  if (!quality) return Promise.reject(new Error('unsupported quality'))

  // kw's stable identifier is songmid
  return httpRequest(
    `https://my-api.example.com/url?source=${source}&id=${musicInfo.songmid}&quality=${quality}`,
    { method: 'GET', headers: { 'Content-Type': 'application/json' } }
  ).then((body) => {
    if (!body || !body.url) throw new Error(body && body.msg ? body.msg : 'get url failed')
    return body.url            // MUST be an http(s) URL string, <= 2048 chars
  })
})

send(EVENT_NAMES.inited, {
  openDevTools: false,
  sources: {
    kw: {
      name: 'My Source',
      type: 'music',
      actions: ['musicUrl'],
      qualitys: ['128k', '320k', 'flac', 'flac24bit'],
    },
  },
})
```

### 11.2 Multi-source + `local` (musicUrl / lyric / pic)

```js
/**
 * @name Demo Source
 * @description Demonstrates musicUrl + local lyric/pic
 * @version 1.0.0
 * @author you
 * @homepage https://example.com
 */

;(() => {
  const { EVENT_NAMES, request, on, send, env, version } = globalThis.lx

  const API = 'https://my-api.example.com'
  const UA = env ? `lx-music-${env}/${version}` : `lx-music-request/${version}`

  const get = (url) =>
    new Promise((resolve, reject) => {
      request(url, { method: 'GET', headers: { 'User-Agent': UA } }, (err, resp) => {
        if (err) return reject(err)
        resolve(resp.body)
      })
    })

  // kg needs `hash`; everything else uses `songmid`.
  const idOf = (source, musicInfo) =>
    source === 'kg' ? (musicInfo.hash ?? musicInfo.songmid)
    : source === 'mg' ? (musicInfo.copyrightId ?? musicInfo.songmid)
    : musicInfo.songmid

  const SOURCES = {
    kw: { name: '酷我音乐', qualitys: ['128k', '320k', 'flac', 'flac24bit'] },
    kg: { name: '酷狗音乐', qualitys: ['128k', '320k', 'flac', 'flac24bit'] },
    tx: { name: 'QQ音乐',   qualitys: ['128k', '320k', 'flac'] },
    wy: { name: '网易音乐', qualitys: ['128k', '320k', 'flac'] },
    mg: { name: '咪咕音乐', qualitys: ['128k', '320k'] },
  }

  const apis = {
    // ── online sources: musicUrl only ──────────────────────────────────────
    musicUrl(source, musicInfo, quality) {
      const id = idOf(source, musicInfo)
      if (!id) return Promise.reject(new Error('missing song id'))
      return get(`${API}/url?source=${source}&id=${encodeURIComponent(id)}&quality=${quality}`)
        .then((body) => {
          if (!body || !body.url) throw new Error(body?.msg ?? 'no url')
          return body.url
        })
    },

    // ── local source: musicUrl + lyric + pic ──────────────────────────────
    local: {
      musicUrl(musicInfo) {
        // info.type is null for local; identify by filePath
        return get(`${API}/match?path=${encodeURIComponent(musicInfo.filePath)}`)
          .then((body) => body.url)
      },
      pic(musicInfo) {
        return get(`${API}/match?path=${encodeURIComponent(musicInfo.filePath)}`)
          .then((body) => body.pic)          // http(s) URL string
      },
      lyric(musicInfo) {
        return get(`${API}/lyric?path=${encodeURIComponent(musicInfo.filePath)}`)
          .then((body) => ({
            lyric: body.lyric,                 // REQUIRED string, <= 51200 chars
            tlyric: body.tlyric ?? null,       // < 5120 chars or null
            rlyric: body.rlyric ?? null,       // < 5120 chars or null
            // karaoke: [mm:ss.mmm]<startOffset,duration>text
            lxlyric: body.lxlyric ?? null,     // < 8192 chars or null
          }))
      },
    },
  }

  on(EVENT_NAMES.request, ({ source, action, info }) => {
    try {
      if (source === 'local') return apis.local[action](info.musicInfo)
      if (action !== 'musicUrl') return Promise.reject(new Error('action not support'))
      return apis.musicUrl(source, info.musicInfo, info.type)
    } catch (err) {
      return Promise.reject(err)
    }
  })

  const sources = {}
  for (const [id, cfg] of Object.entries(SOURCES)) {
    sources[id] = { name: cfg.name, type: 'music', actions: ['musicUrl'], qualitys: cfg.qualitys }
  }
  sources.local = {
    name: '本地音乐',
    type: 'music',
    actions: ['musicUrl', 'lyric', 'pic'],
    qualitys: [],
  }

  send(EVENT_NAMES.inited, { openDevTools: false, sources })
})()
```

### 11.3 Optional update notification

```js
lx.send(lx.EVENT_NAMES.updateAlert, {
  log: 'v1.1.0\n- 修复了 xxx\n- 新增了 yyy',
  updateUrl: 'https://example.com/my-source',
})
```

---

## 12. Real-world script examples

### 12.1 `pdone/lx-music-source` — `ikun/latest.js` (widely mirrored)

Retrieved from `https://ghproxy.net/raw.githubusercontent.com/pdone/lx-music-source/main/ikun/latest.js`.

```js
/*!
 * @name ikun音源
 * @description
 * @version v22
 * @author ikunshare
 */

const DEV_ENABLE = false
const UPDATE_ENABLE = true
const API_URL = "https://api.ikunshare.com"
const API_KEY = ""
const SCRIPT_MD5 = "74a88a1d1ae53cf3cb2889e70aed3d6e";
const MUSIC_QUALITY = JSON.parse('{"kw":["128k","320k","flac","flac24bit","hires"],"wy":["128k","320k","flac","flac24bit","hires","atmos","master"],"git":["128k","320k","flac"]}');

const MUSIC_SOURCE = Object.keys(MUSIC_QUALITY);
const {EVENT_NAMES, request, on, send, utils, env, version} = globalThis.lx;

const httpFetch = (url, options = {method: "GET"}) => {
    return new Promise((resolve, reject) => {
        console.log("--- start --- " + url);
        request(url, options, (err, resp) => {
            console.log("API Request: ", options)
            if (err) return reject(err);
            console.log("API Response: ", resp);
            resolve(resp);
        });
    });
};

const handleGetMusicUrl = async (source, musicInfo, quality) => {
    const songId = musicInfo.hash ?? musicInfo.songmid;
    const request = await httpFetch(
        `${API_URL}/url?source=${source}&songId=${songId}&quality=${quality}`,
        {
            method: "GET",
            headers: {
                "Content-Type": "application/json",
                "User-Agent": `${
                    env ? `lx-music-${env}/${version}` : `lx-music-request/${version}`
                }`,
                "X-Request-Key": API_KEY,
            },
            follow_max: 5,
        }
    );
    const {body} = request;
    if (!body || isNaN(Number(body.code))) throw new Error("unknow error");
    if (env != "mobile") console.groupEnd();
    switch (body.code) {
        case 200:
            return body.url;
        case 403:
            throw new Error("Key失效/鉴权失败");
        case 500:
            throw new Error(`获取URL失败, ${body.message ?? "未知错误"}`);
        case 429:
            throw new Error("请求过速");
        default:
            throw new Error(body.message ?? "未知错误");
    }
};

const checkUpdate = async () => {
    const request = await httpFetch(
        `${API_URL}/script/lxmusic?key=${API_KEY}&checkUpdate=${SCRIPT_MD5}`,
        { method: "GET", headers: { "Content-Type": "application/json", "User-Agent": `…` } }
    );
    const {body} = request;
    if (!body || body.code !== 200) console.log("checkUpdate failed");
    else if (body.data != null) {
        globalThis.lx.send(lx.EVENT_NAMES.updateAlert, {
            log: body.data.updateMsg,
            updateUrl: body.data.updateUrl,
        });
    }
};

const musicSources = {};
MUSIC_SOURCE.forEach((item) => {
    musicSources[item] = {
        name: item,
        type: "music",
        actions: ["musicUrl"],
        qualitys: MUSIC_QUALITY[item],
    };
});

on(EVENT_NAMES.request, ({action, source, info}) => {
    switch (action) {
        case "musicUrl":
            return handleGetMusicUrl(source, info.musicInfo, info.type)
                .then((data) => Promise.resolve(data))
                .catch((err) => Promise.reject(err));
        default:
            console.error(`action(${action}) not support`);
            return Promise.reject("action not support");
    }
});

if (UPDATE_ENABLE) checkUpdate();

send(EVENT_NAMES.inited, {
    status: true,
    openDevTools: DEV_ENABLE,
    sources: musicSources,
});
```

**What this example demonstrates in practice:**

* `globalThis.lx` destructuring of `EVENT_NAMES, request, on, send, utils, env, version`.
* `musicInfo.hash ?? musicInfo.songmid` — the canonical cross-source id idiom.
* `resp.body` being a parsed object (the script never calls `JSON.parse`).
* `env`/`version` used to build a `User-Agent`.
* `console.group`/`console.groupEnd` guarded by `env != "mobile"`.
* The legacy `status: true` field (ignored by current hosts).
* `follow_max: 5` passed — **silently ignored on desktop** (see §1.7).
* `hires`, `atmos`, `master` declared — **all filtered out** by the host.
* A `git` source key — **filtered out** (not in `allSources`).
* Returning `Promise.reject("action not support")` (a *string*, not an Error) — works, but the host's
  `err.message` will be `undefined`, so the user sees a blank failure message.

### 12.2 `tfappstore/lx-music-source` — `yiyin/latest.js` (a minimal, single-endpoint source)

Retrieved from `https://ghproxy.net/raw.githubusercontent.com/tfappstore/lx-music-source/main/yiyin/latest.js`.

```js
/*!
 * @name 忆音音源
 * @description 支持Q音网易320k
 * @version v1
 * @author 竹佀＆玥然OvO
 */
const { EVENT_NAMES, on, send } = globalThis.lx

const getAudioUrl = (source, musicInfo) => {
    const platform = source === 'tx' ? 'tencent' : 'netease'
    const songId = musicInfo.songmid || musicInfo.id

    if (!songId) {
        throw new Error('找不到歌曲ID')
    }

    return `https://music.3e0.cn/?server=${platform}&type=url&id=${songId}`
}

on(EVENT_NAMES.request, ({ source, action, info }) => {
    if (action !== 'musicUrl') {
        return Promise.reject(new Error('仅支持musicUrl操作'))
    }

    try {
        const url = getAudioUrl(source, info.musicInfo)

        console.log(`[DreamMeting] 返回链接: ${url}`)
        console.log(`[DreamMeting] 音质: 320k`)

        return Promise.resolve(url)

    } catch (error) {
        console.error(`[DreamMeting] 错误: ${error.message}`)
        return Promise.reject(new Error(`[DreamMeting] ${error.message}`))
    }
})

send(EVENT_NAMES.inited, {
    openDevTools: false,
    sources: {
        tx: {
            name: 'QQ音乐 - DreamMeting',
            type: 'music',
            actions: ['musicUrl'],
            qualitys: ['320k']
        },
        wy: {
            name: '网易云音乐 - DreamMeting',
            type: 'music',
            actions: ['musicUrl'],
            qualitys: ['320k']
        }
    }
})

console.log('音源初始化完成')
```

**Notes:** no `lx.request` at all — it just synthesises a URL for a third-party proxy endpoint. It also
reads `musicInfo.id`, which **does not exist** in the delivered object (harmless here because `songmid` is
always set first). `name` fields are decorative only.

### 12.3 A real installed 740 KB script (local sample)

The workspace contains a decompressed real source at
`docs/research/samples/user_api_0.decoded.js`. It is an aggregator ("codex多音源轮换") that bundles several
upstream scripts and adds failover. Notable confirmations from it:

* It wraps everything in an IIFE specifically to avoid `const`/`let` collisions:
  `// 重要：整个脚本包在 IIFE 内，避免与宿主或其他脚本的 const/let 重名。`
* It destructures `const { EVENT_NAMES, request, on, send, utils, env, version } = lx`.
* Its id-extraction helper tries, in order: `['hash', 'songmid', 'copyrightId', 'id']`, uppercasing `hash`:
  ```js
  const songKey = ({ source, info }) => {
    const music = info?.musicInfo || {}
    for (const field of ['hash', 'songmid', 'copyrightId', 'id']) {
      const value = music[field]
      if ((typeof value === 'string' || typeof value === 'number') && String(value).trim()) {
        const id = field === 'hash' ? String(value).toUpperCase() : String(value)
        return JSON.stringify([source, field, id])
      }
    }
    return null
  }
  ```
* It de-duplicates in-flight requests keyed by `JSON.stringify([songKey, info.type])` — a direct
  consequence of the 20 s budget being per-request.
* Its handler is `async` and `throw`s for unsupported actions:
  ```js
  on(EVENT_NAMES.request, async requestInfo => {
    if (requestInfo.action !== 'musicUrl') throw new Error('action not support')
    if (!SOURCES[requestInfo.source]) throw new Error('source not support')
    …
  })
  ```
* It still sends the legacy `status: true` alongside `openDevTools: false`.
* Its header uses `@repository` instead of `@homepage` — meaning `lx.currentScriptInfo.homepage` is empty
  for it, and the repository link is invisible to the app.

---

## 13. Gotchas and common mistakes

1. **`musicInfo.id` does not exist.** Use `songmid` / `hash` / `copyrightId` / `songId`.
2. **`follow_max` is dropped on desktop.** Redirects are not followed. Resolve final URLs yourself or use
   an endpoint that does not redirect.
3. **Object bodies are form-encoded unless you set `Content-Type: application/json`.** A `body: {...}`
   without that header becomes `a=1&b=2`, and on a GET it becomes a query string instead.
4. **`randomBytes` returns bytes, not a string.** Convert explicitly
   (`utils.buffer.bufToString(utils.crypto.randomBytes(16), 'hex')`).
5. **`rsaEncrypt` is raw RSA-1024, no padding, 128-byte input.** It is not PKCS#1 v1.5.
6. **AES-ECB padding differs between desktop and mobile.**
7. **`lx.utils.zlib` does not exist on mobile.** Ship a pure-JS fallback or avoid it.
8. **`hires` / `atmos` / `master` are not valid LX qualities** and are filtered out. Use `flac24bit`.
9. **Custom source keys are limited to `kw/kg/tx/wy/mg/local`.** `git`, `bd`, `xm`, or your own name are
   silently dropped.
10. **`sources[x].name` is ignored** by v2.x hosts.
11. **`status` in `inited` is obsolete** — don't rely on `status: false` to signal failure; `throw`.
12. **Any uncaught error before `inited` is fatal** and permanently suppresses further init reporting.
13. **The whole handler promise must settle within 20 s** — including all nested `lx.request` calls.
14. **`lyric`/`pic` only work for `local`.** Declaring them for `kw` gets them filtered out of `actions`.
15. **A lyric object without a `lyric` string fails entirely**; over-long `tlyric`/`rlyric`/`lxlyric` are
    silently nulled instead.
16. **`updateAlert` is once per run**, and only shows if the user enabled alerts for that source.
17. **Reject with an `Error`, not a string** — the host reads `err.message`, which is `undefined` for a
    string rejection.
18. **Return a Promise** from the `request` handler; the host calls `.then` on it unconditionally.
19. **Don't rely on `localStorage`** — it is wiped on every source switch.
20. **The file must start with `/**`** — a BOM or leading newline causes `无效的自定义源文件`.
21. **`@name` is truncated at 24 chars**; long names get `...` appended.
22. **Importing the same script twice fails** (content-hash duplicate detection), which surprises users who
    try to "update" by re-importing the same bytes.

---

## 14. Implementation checklist for a compatible player

**Import pipeline**

- [ ] Require the header comment anchored at position 0 (`/^\/\*[\s\S]+?\*\//`).
- [ ] Parse `* @key value` lines; truncate `name` 24 / `description` 36 / `author` 56 / `version` 36 /
      `homepage` 1024 with a `'...'` suffix; default the name when `@name` is absent.
- [ ] Store the raw script (LX deflates + `gz_`-base64s it; you may store it verbatim).
- [ ] Reject byte-identical duplicates; assign ids matching `/^user_api/`.
- [ ] Cap the list at 20 entries; cap online imports at 9 000 000 chars with ≤ 3 redirects.

**Sandbox**

- [ ] Evaluate the script with `globalThis.lx` present, before which `lx` must be fully built.
- [ ] No `require`/`process`; provide `Buffer`-like helpers only through `lx.utils.buffer`.
- [ ] Block `fetch`/`XHR`/`WebSocket` (or simply don't provide them).
- [ ] Install `error` + `unhandledrejection` listeners **before** running the script.
- [ ] Provide `setTimeout`/`clearTimeout` on every platform.

**Protocol**

- [ ] `on('request')` only; `on(<other>)` must reject.
- [ ] `send('inited')` once; `send('updateAlert')` once; unknown names reject.
- [ ] `inited`: filter sources against the six keys, require `type === 'music'`, intersect
      `actions` and `qualitys` with the per-source whitelists.
- [ ] Open the request channel only after a successful `inited`.
- [ ] `request` handler: pass `{ source, action, info }`, `.then()` the result, apply the exact
      validators (URL ≤ 2048 + `/^https?:/`; lyric object + 51200 / 5120 / 5120 / 8192).
- [ ] Build the `{ source, action, data }` envelope exactly as in §4.3.
- [ ] Enforce a 20 000 ms per-request budget; cancel the in-flight handler on source switch.
- [ ] Gate `updateAlert` behind a per-source `allowShowUpdateAlert` flag (default `true` on import).
- [ ] Truncate the `updateAlert` log at 1024 + `'...'`.

**`lx.request`**

- [ ] Bypass CORS; support `method` (default `get`), `headers`, `body`, `form`, `formData`, `timeout`.
- [ ] Default JSON encoding when `Content-Type: application/json` is set; form-encode otherwise.
- [ ] Convert GET+object bodies into a query string.
- [ ] Default 60 s response timeout (cap the script-supplied `timeout` at 60 000 ms).
- [ ] Return `{ statusCode, statusMessage, headers, bytes, raw, body }` and a cancel function.
- [ ] Route through the app's proxy configuration.

**`lx.utils`**

- [ ] `buffer.from`, `buffer.bufToString`, `crypto.aesEncrypt`, `crypto.rsaEncrypt` (raw RSA-1024,
      128-byte left pad), `crypto.randomBytes` (bytes), `crypto.md5` (lowercase hex), `zlib.inflate`,
      `zlib.deflate`.
- [ ] Set `version = '2.0.0'` and `env` appropriately.
- [ ] Populate `currentScriptInfo` including `rawScript`.

---

## 15. Uncertainty register

Everything below is either unverified or a known upstream inconsistency. Nothing here is invented; each
item states exactly what is and is not known.

| item | status |
| --- | --- |
| Mobile `lx.request` default timeout when the script omits `timeout` | **[UNCERTAIN]** — the preload sets none; the native client's default is not visible in the JS/Java files examined. |
| Whether mobile honours `follow_max` / redirect following | **[UNCERTAIN]** — the option is forwarded to the native layer; the native HTTP implementation was not inspected. |
| Exact mobile response `body` typing | **[UNCERTAIN]** — declared `any`; desktop always yields a parsed object for valid JSON, otherwise a string. Assume the same but don't depend on it. |
| AES-ECB padding divergence (desktop PKCS#7 vs mobile NoPadding) | **Verified in code**, but whether it is intentional is **[UNCERTAIN]**. |
| `randomBytes` documented as returning a "random string" | **Docs contradict the code** — desktop returns a `Buffer`, mobile a `Uint8Array`. Treat the docs as wrong. |
| `info.type === 'music'` for `lyric`/`pic` | **Verified in code** (both platforms), but contradicts the docs and looks unintentional. |
| The `updateUrl` validation guard in `handleShowUpdateAlert` | **Verified** as `A && B && C`; almost certainly an upstream logic bug (a malformed short URL survives). |
| `xm` present in `supportActions` but absent from `allSources` | **Verified** inconsistency; `xm` can never be surfaced by a custom source. |
| `bd` module exported but commented out of the source list | **Verified**. |
| Any action beyond `musicUrl`/`lyric`/`pic` | **No evidence in any v2.x source or doc revision.** Specifically, `auth` does not exist. |
| `lx.storage` / `lx.localStorage` | **Do not exist** in either implementation. |
| `lx.utils.crypto.str2b64` / `b642str` | **Do not exist** as public API. Mobile has internal native helpers named `utils_str2b64` / `utils_b642buf`, but they are deleted from `globalThis` during setup and are only reachable through `utils.buffer.*`. |
| DeepWiki page `5.4-custom-sources` | Fetched but rendered client-side; no readable body was returned. All findings here come from primary source instead. |
| Behaviour of LX versions < 2.6.0 | Out of scope; the API changed incompatibly in v2.6.0 (`window.lx` → `globalThis.lx`, `status` removed, `local` actions added, `script` tag → `executeJavaScript`). Scripts written for the new API are not backward compatible with ≤ 2.5.0. |

---

## 16. Sources

**Official documentation**

* [自定义源脚本编写说明 (desktop)](https://lxmusic.toside.cn/desktop/custom-source) — primary spec
* [自定义源脚本编写说明 (mobile)](https://lxmusic.toside.cn/mobile/custom-source) — mobile deltas
* [lx-music-doc `docs/desktop/custom-source.mdx`](https://ghproxy.net/https://raw.githubusercontent.com/lyswhut/lx-music-doc/master/docs/desktop/custom-source.mdx) — doc source of truth

**lx-music-desktop source (v2.12.5)**

* [`src/main/modules/userApi/renderer/preload.js`](https://ghproxy.net/https://raw.githubusercontent.com/lyswhut/lx-music-desktop/master/src/main/modules/userApi/renderer/preload.js) — **the `lx` object, all validators**
* [`src/main/modules/userApi/rendererEvent/rendererEvent.ts`](https://ghproxy.net/https://raw.githubusercontent.com/lyswhut/lx-music-desktop/master/src/main/modules/userApi/rendererEvent/rendererEvent.ts) — 20 s request budget, init/response/updateAlert handling
* [`src/main/modules/userApi/main.ts`](https://ghproxy.net/https://raw.githubusercontent.com/lyswhut/lx-music-desktop/master/src/main/modules/userApi/main.ts) — hidden `BrowserWindow` sandbox config
* [`src/main/modules/userApi/utils.ts`](https://ghproxy.net/https://raw.githubusercontent.com/lyswhut/lx-music-desktop/master/src/main/modules/userApi/utils.ts) — header parsing, import, deflate storage
* [`src/main/modules/userApi/index.ts`](https://ghproxy.net/https://raw.githubusercontent.com/lyswhut/lx-music-desktop/master/src/main/modules/userApi/index.ts)
* [`src/main/modules/userApi/rendererEvent/name.js`](https://ghproxy.net/https://raw.githubusercontent.com/lyswhut/lx-music-desktop/master/src/main/modules/userApi/rendererEvent/name.js) — IPC channel names
* [`src/main/modules/userApi/renderer/user-api.html`](https://ghproxy.net/https://raw.githubusercontent.com/lyswhut/lx-music-desktop/master/src/main/modules/userApi/renderer/user-api.html) — `default-src 'none'` CSP
* [`src/main/modules/winMain/rendererEvent/userApi.ts`](https://ghproxy.net/https://raw.githubusercontent.com/lyswhut/lx-music-desktop/master/src/main/modules/winMain/rendererEvent/userApi.ts)
* [`src/common/types/user_api.d.ts`](https://ghproxy.net/https://raw.githubusercontent.com/lyswhut/lx-music-desktop/master/src/common/types/user_api.d.ts)
* [`src/common/types/music.d.ts`](https://ghproxy.net/https://raw.githubusercontent.com/lyswhut/lx-music-desktop/master/src/common/types/music.d.ts) — `MusicInfo` shapes
* [`src/common/types/common.d.ts`](https://ghproxy.net/https://raw.githubusercontent.com/lyswhut/lx-music-desktop/master/src/common/types/common.d.ts) — `Source`, `Quality`
* [`src/common/types/app_setting.d.ts`](https://ghproxy.net/https://raw.githubusercontent.com/lyswhut/lx-music-desktop/master/src/common/types/app_setting.d.ts) — `common.apiSource`, `player.playQuality`, proxy
* [`src/common/utils/tools.ts`](https://ghproxy.net/https://raw.githubusercontent.com/lyswhut/lx-music-desktop/master/src/common/utils/tools.ts) — `toOldMusicInfo` / `toNewMusicInfo`
* [`src/common/constants.ts`](https://ghproxy.net/https://raw.githubusercontent.com/lyswhut/lx-music-desktop/master/src/common/constants.ts) — `QUALITYS`, store names
* [`src/renderer/core/useApp/useInitUserApi.ts`](https://ghproxy.net/https://raw.githubusercontent.com/lyswhut/lx-music-desktop/master/src/renderer/core/useApp/useInitUserApi.ts) — action wiring, `apis` construction
* [`src/renderer/core/music/utils.ts`](https://ghproxy.net/https://raw.githubusercontent.com/lyswhut/lx-music-desktop/master/src/renderer/core/music/utils.ts) — `getPlayQuality`, source toggling
* [`src/renderer/core/apiSource.ts`](https://ghproxy.net/https://raw.githubusercontent.com/lyswhut/lx-music-desktop/master/src/renderer/core/apiSource.ts)
* [`src/renderer/utils/musicSdk/api-source.js`](https://ghproxy.net/https://raw.githubusercontent.com/lyswhut/lx-music-desktop/master/src/renderer/utils/musicSdk/api-source.js)
* [`src/renderer/utils/musicSdk/api-source-info.ts`](https://ghproxy.net/https://raw.githubusercontent.com/lyswhut/lx-music-desktop/master/src/renderer/utils/musicSdk/api-source-info.ts) — **empty: no built-in playable sources**
* [`src/renderer/utils/musicSdk/index.js`](https://ghproxy.net/https://raw.githubusercontent.com/lyswhut/lx-music-desktop/master/src/renderer/utils/musicSdk/index.js) — source registry
* [`src/renderer/utils/musicSdk/options.js`](https://ghproxy.net/https://raw.githubusercontent.com/lyswhut/lx-music-desktop/master/src/renderer/utils/musicSdk/options.js)
* [`src/renderer/utils/request.js`](https://ghproxy.net/https://raw.githubusercontent.com/lyswhut/lx-music-desktop/master/src/renderer/utils/request.js) — built-in HTTP layer
* `src/renderer/utils/musicSdk/{kw,kg,tx,wy,mg}/{index,musicSearch}.js` — per-source id schemes and quality codes
* [`src/renderer/views/Setting/components/UserApiModal.vue`](https://ghproxy.net/https://raw.githubusercontent.com/lyswhut/lx-music-desktop/master/src/renderer/views/Setting/components/UserApiModal.vue) — 20-source cap, import UI
* [`src/renderer/views/Setting/components/UserApiOnlineImportModal.vue`](https://ghproxy.net/https://raw.githubusercontent.com/lyswhut/lx-music-desktop/master/src/renderer/views/Setting/components/UserApiOnlineImportModal.vue) — 9 MB / 3-redirect limits
* [`CHANGELOG.md`](https://ghproxy.net/https://raw.githubusercontent.com/lyswhut/lx-music-desktop/master/CHANGELOG.md) — v2.6.0 API break, v2.2.x `zlib`, v1.15.0 `version`, built-in source removal
* [`FAQ.md`](https://ghproxy.net/https://raw.githubusercontent.com/lyswhut/lx-music-desktop/master/FAQ.md) — contains the pre-2.6.0 (`window.lx`, `status`) documentation for historical reference
* [`package.json`](https://fastly.jsdelivr.net/gh/lyswhut/lx-music-desktop@master/package.json) — version 2.12.5, `needle` fork, `crypto-js`, `tunnel`

**lx-music-mobile source**

* [`android/app/src/main/assets/script/user-api-preload.js`](https://ghproxy.net/https://raw.githubusercontent.com/lyswhut/lx-music-mobile/master/android/app/src/main/assets/script/user-api-preload.js) — **mobile `lx`, QuickJS sandboxing**
* [`android/app/src/main/java/cn/toside/music/mobile/userApi/QuickJS.java`](https://ghproxy.net/https://raw.githubusercontent.com/lyswhut/lx-music-mobile/master/android/app/src/main/java/cn/toside/music/mobile/userApi/QuickJS.java)
* [`android/app/src/main/java/cn/toside/music/mobile/userApi/UserApiModule.java`](https://ghproxy.net/https://raw.githubusercontent.com/lyswhut/lx-music-mobile/master/android/app/src/main/java/cn/toside/music/mobile/userApi/UserApiModule.java)
* [`src/core/init/userApi/index.ts`](https://ghproxy.net/https://raw.githubusercontent.com/lyswhut/lx-music-mobile/master/src/core/init/userApi/index.ts) — 20 s budget, action wiring
* [`src/core/userApi.ts`](https://ghproxy.net/https://raw.githubusercontent.com/lyswhut/lx-music-mobile/master/src/core/userApi.ts)
* [`src/utils/nativeModules/userApi.ts`](https://ghproxy.net/https://raw.githubusercontent.com/lyswhut/lx-music-mobile/master/src/utils/nativeModules/userApi.ts) — response interface

**Third-party / auxiliary**

* [needle `lib/needle.js`](https://ghproxy.net/https://raw.githubusercontent.com/tomas/needle/master/lib/needle.js) and [needle README](https://fastly.jsdelivr.net/npm/needle@3.3.1/README.md) — request/response semantics that `lx.request` inherits
* [`pdone/lx-music-source` — `ikun/latest.js`](https://ghproxy.net/raw.githubusercontent.com/pdone/lx-music-source/main/ikun/latest.js)
* [`tfappstore/lx-music-source` — `yiyin/latest.js`](https://ghproxy.net/raw.githubusercontent.com/tfappstore/lx-music-source/main/yiyin/latest.js)
* Local workspace sample: `docs/research/samples/user_api_0.decoded.js` (a real installed 740 KB aggregator source) and `docs/research/samples/user_api_report.txt`
* [DeepWiki: Custom Sources](https://deepwiki.com/lyswhut/lx-music-desktop/5.4-custom-sources) — *listed for completeness; the page is client-rendered and returned no readable content, so nothing here is sourced from it*
