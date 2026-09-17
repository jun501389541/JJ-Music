# LX Music (洛雪音乐) 音源 Ecosystem — Research Report

**Compiled:** from primary sources fetched during this session. Every non-obvious claim carries an inline citation.

**Evidence labels used throughout:**
- **[VERIFIED]** — read directly from a fetched page/file/API response in this session.
- **[COMMUNITY]** — widely reported in community sources; corroborated but not from a primary/official source.
- **[INFERENCE]** — my own reasoning from verified facts; labelled as such.
- **[UNVERIFIED]** — could not confirm; explicitly flagged.

**Fetch-environment note.** `raw.githubusercontent.com`, `github.com`, `api.github.com`, `cdn.jsdelivr.net`, `unpkg.com` are not resolvable from this environment. Working substitutes used:
- `https://gh-proxy.com/https://raw.githubusercontent.com/...` and `https://gh-proxy.com/https://api.github.com/...` — **worked for everything**, including the GitHub REST API.
- `https://fastly.jsdelivr.net/gh/<owner>/<repo>@<ref>/<path>` — **worked** (the `fastly.` subdomain is reachable even though `cdn.jsdelivr.net` is not).
- `https://data.jsdelivr.com/v1/packages/gh/<owner>/<repo>@master?structure=flat` — full file listing, **worked**.
- `https://raw.giteeusercontent.com/mirrors/lx-music-desktop/raw/master/<path>` — Gitee mirror of **lx-music-desktop only**, **worked**.
- The task brief's suggested Gitee mirror `mirrors/lx-music-mobile` **does not exist** (HTTP 404 `{"message":"Not Found Project"}`). Gitee's `mirrors/lx-music-desktop` **does** exist and is current for source files, but its `CHANGELOG.md` lags upstream (tops out at 2.12.2 vs. upstream 2.12.5).
- `PowerShell` has **no outbound network** in this sandbox (`Invoke-WebRequest` fails with a TLS/connection error), so all fetching went through `web_fetch`.
- The official docs site `lyswhut.github.io/lx-music-doc` now **cross-origin redirects to `https://lxmusic.toside.cn`**; fetch that host directly.

---

## 1. lx-music-mobile — tech stack, version, license, relationship to desktop

### 1.1 Repository facts [VERIFIED]

From `https://gh-proxy.com/https://api.github.com/repos/lyswhut/lx-music-mobile`:

| Field | Value |
|---|---|
| Description | `一个基于 React native 开发的音乐软件` |
| Created | 2021-05-15 |
| License (GitHub) | `Apache-2.0` (`spdx_id: "Apache-2.0"`) |
| Stars / forks | 18,286 / 2,099 |
| Open issues | 769 |
| Primary language | TypeScript |
| Default branch | `master` |
| Last push | 2026-09-12 |

### 1.2 Version and license field [VERIFIED]

From `package.json` at `https://fastly.jsdelivr.net/gh/lyswhut/lx-music-mobile@master/package.json`:

```json
{
  "name": "lx-music-mobile",
  "version": "1.9.0",
  "versionCode": 77,
  "private": true,
  "author": { "name": "lyswhut", "email": "lyswhut@qq.com" },
  "license": "Apache-2.0",
  ...
}
```

- **Version: `1.9.0` / `versionCode` 77.** Cross-checked against the changelog, which dates `1.9.0` to **2026-09-12**.
- **`license` field: `"Apache-2.0"`** — confirmed as requested.
- The third-party mirror `raw.gitcode.com/gh_mirrors/lx/lx-music-mobile` is **stale**: it still serves `version: "1.8.4"`, `versionCode: 76`. Use jsdelivr/gh-proxy for current state.

The `LICENSE` file itself is the standard Apache 2.0 text (11,357 bytes, same blob hash `xx0jnfkXJvxRnG63LTGOxlggYnIysveWIZ6H3PNdCrQ=` as the desktop repo) — visible in the jsdelivr flat file listing.

### 1.3 Tech stack — React Native, **not** Expo [VERIFIED]

From `package.json` and the README:

- **React Native `0.73.11`**, **React `18.2.0`**. The README states the stack as **"React Native" + "Redux"**.
- **Not Expo.** There is no `expo` dependency anywhere; the scripts are bare React Native CLI (`"dev": "react-native run-android --active-arch-only"`, `"start": "react-native start"`, `metro.config.js`, `babel.config.js`, `react-native.config`-style native modules). Navigation is `react-native-navigation@7.39.2` (Wix), not `expo-router` or `react-navigation`.
- Notable native deps: `react-native-track-player` (a **lyswhut fork**, pinned to commit `bfe3393`), `react-native-quick-md5`, `react-native-quick-base64`, `@craftzdog/react-native-buffer`, `pako`, `iconv-lite`, `message2call`, `lrc-file-parser`, `react-native-file-system` / `react-native-local-media-metadata` / `react-native-background-timer` (all lyswhut forks).
- `"engines": { "node": ">= 18", "npm": ">= 8.5.2" }`.
- Playback engine: **Media3** (migrated from ExoPlayer in v1.2.0 — `核心播放器从 ExoPlayer 迁移到 media3 v1.2.1`).
- **Android 5+ only.** Official docs: *"已支持的平台：Android 5 及以上"* and *"注：目前没有计划支持 iOS 和 HarmonyOS NEXT。"* — an `ios/` Xcode project directory does exist in the tree, but it is not a supported target.

### 1.4 The custom-source engine is QuickJS, not the RN JS runtime [VERIFIED]

This is the single most architecturally interesting fact and it explains every mobile/desktop difference in the docs. From the jsdelivr flat file listing, the Android native side contains:

```
/android/app/src/main/assets/script/user-api-preload.js          (21,341 bytes)
/android/app/src/main/java/cn/toside/music/mobile/userApi/QuickJS.java          (8,021 bytes)
/android/app/src/main/java/cn/toside/music/mobile/userApi/JavaScriptThread.java (2,231 bytes)
/android/app/src/main/java/cn/toside/music/mobile/userApi/JsHandler.java        (2,087 bytes)
/android/app/src/main/java/cn/toside/music/mobile/userApi/UserApiModule.java    (3,087 bytes)
/android/app/src/main/java/cn/toside/music/mobile/userApi/Console.java          (940 bytes)
/android/app/src/main/java/cn/toside/music/mobile/crypto/{AES,RSA,CryptoModule}.java
```

A `QuickJS.java` native module is exactly what the official docs mean by *"移动端内部使用的是一个轻量级 JavaScript 引擎，**浏览器、Node.js 等常见宿主环境 API 不可用**"* — the source script is executed by a bundled QuickJS interpreter, **not** by the React Native (Hermes/JSC) runtime and not by a WebView.

**The author confirms this directly.** In issue #1643, replying to a user, `lyswhut` writes [VERIFIED — GitHub API comment `1793619498`, 2023-11-05]:

> @ruoleng 现在移动端的自定义源使用的就是基于 QuickJS 包装的依赖

So QuickJS is not inference — it is the author's own statement. This single fact explains every mobile/desktop divergence in §2.7.

Desktop, by contrast, runs the script in a **separate Electron `BrowserWindow`** with `contextBridge.exposeInMainWorld('lx', ...)` and `webFrame.executeJavaScript(userApi.script)` — see `src/main/modules/userApi/renderer/preload.js` and `src/main/modules/userApi/renderer/user-api.html` [VERIFIED].

### 1.5 `src/` top-level structure [VERIFIED]

Extracted from the jsdelivr flat listing for `lyswhut/lx-music-mobile@master`:

```
src/components/     src/config/     src/core/      src/event/
src/lang/           src/navigation/ src/plugins/   src/resources/
src/screens/        src/store/      src/theme/      src/types/
src/utils/
```

Selected detail worth noting:
- `src/utils/musicSdk/` contains the **metadata-only** platform SDKs: `bd/`, `kg/`, `kw/`, `mg/`, `tx/`, `wy/`, plus `api-source.js`, `api-source-info.ts`, `options.js`, `utils.js`. Each platform has `musicSearch.js`, `songList.js`, `leaderboard.js`, `lyric.js`, `pic.js`, `comment.js`, `hotSearch.js`, `tipSearch.js` — i.e. **search/playlist/lyric/cover/comment only**. There is **no `musicUrl.js`** anywhere in `musicSdk/` — the audio-URL step is delegated entirely to the custom source. This is the structural proof of the "shell vs. source" split.
- `src/store/userApi/` (`action.ts`, `event.ts`, `hook.ts`, `state.ts`) manages source lifecycle.
- `src/utils/musicSdk/kg/vendors/infSign.min.js` (11,778 bytes) — the KuGou request-signing vendor blob, a concrete example of the signature/encryption churn that breaks sources (see §3).
- `src/theme/themes/` holds ~2 MB of wallpaper assets plus a 243 KB generated `themes.ts`.

### 1.6 Desktop sibling, for contrast [VERIFIED]

From `https://fastly.jsdelivr.net/gh/lyswhut/lx-music-desktop@master/package.json` and the GitHub API:

| Field | Value |
|---|---|
| Version | **2.12.5** |
| License | `Apache-2.0` |
| Stack | Electron (`electron@42.11.3` dev-dep; README says "Electron 30+") + **Vue 3** (`vue@~3.3.13`) + webpack |
| Stars / forks | 53,662 / 7,010 |
| `browserslist` | `["Electron 22.3.0"]` |
| Latest release | `v2.12.5`, published **2026-09-13** |
| Storage | `better-sqlite3` |
| Renderer SDK dir | `src/renderer/utils/musicSdk/` |

Note `src/renderer/utils/musicSdk/` on desktop has extra `api-test.js` / `api-temp.js` files per platform (the legacy "测试接口 / 临时接口" fallbacks still present in `zh-cn.json` as `setting__basic_source_test` / `setting__basic_source_temp`) [VERIFIED].

### 1.7 Relationship between the two apps [VERIFIED + INFERENCE]

**Verified facts:**
- They are **separate repositories with separate codebases** — no shared package, no monorepo. Desktop is Electron+Vue+TypeScript; mobile is React Native+Redux+TypeScript.
- The mobile README explicitly cross-links the desktop repo, and both READMEs point at the shared docs site and the shared `lx-music-sync-server` project.
- The official docs have a dedicated section **"桌面版自定义源与移动版自定义源的区别"** — implying one conceptual format with documented divergences.
- Mobile `src/store/*` (list, sync, dislikeList, theme, setting, userApi) mirrors desktop `src/common/types/*` (`list_sync.d.ts`, `dislike_list_sync.d.ts`, `user_api.d.ts`, `theme.d.ts`) — the file naming is near-identical, and the v1.0.0 changelog says *"重写配置管理、列表管理功能，使其与PC端同步，更容易复用PC端的代码"*.

**Answer to "does it share the custom-source script format?" — Yes, with documented differences.** The docs' mobile page opens with *"与桌面版自定义源调用机制互通"* ("the custom-source invocation mechanism is interoperable with the desktop version"). Both runtimes expose the identical `globalThis.lx` surface with `version: '2.0.0'`, the same `EVENT_NAMES` (`request`/`inited`/`updateAlert`), the same source keys, the same quality list, and the same action set. Differences are enumerated in §2.7.

---

## 2. The custom-source ("自定义源" / 音源) script format

### 2.1 Official documentation [VERIFIED]

The canonical docs are at **`https://lxmusic.toside.cn/desktop/custom-source`** and **`https://lxmusic.toside.cn/mobile/custom-source`**. The URL in the task brief (`lyswhut.github.io/lx-music-doc/desktop/custom-source`) 301s there. The docs site footer credits **lyswhut & Contributors**, is MIT-licensed, and the page was last edited by **3gf8jv4dv** — the same contributor who did the bulk of the LX i18n/docs overhaul per the changelogs.

### 2.2 File header contract [VERIFIED — quoted from the official docs]

> 文件请使用 UTF-8 编码格式编写，脚本所用编程语言为 JavaScript，可以使用 ES6+ 语法。

> 文件的开头必须包含以下注释：
> ```
> /**
>  * @name 测试脚本
>  * @description 我只是一个测试脚本
>  * @version 1.0.0
>  * @author xxx
>  * @homepage http://xxx
>  */
> ```
> - `@name`：源的名字，建议不要过长，24 个字符以内。
> - `@description`：源的描述，建议不要过长，36 个字符以内，可不填，不填时可以删除它。
> - `@version`：源的版本号，可不填，不填时可以删除它。
> - `@author`：源的作者名字，可不填，不填时可以删除它。
> - `@homepage`：源的主页，可不填，不填时可以删除它。

**Enforcement [VERIFIED from source].** `src/main/modules/userApi/utils.ts` requires the header or the import fails outright:

```js
const parseScriptInfo = (script) => {
  const result = /^\/\*[\S|\s]+?\*\//.exec(script)
  if (!result) throw new Error('无效的自定义源文件')
  ...
}
```

and truncates each field to the documented limits via an `INFO_NAMES` map (`name: 24, description: 36, author: 56, homepage: 1024, version: 36`). Note `@author` is actually allowed 56 chars, not the 24/36 pattern. If `@name` is missing the source is named `user_api_<locale datetime string>`.

The parser is `^\s?\*\s?@(\w+)\s(.+)$` applied line-by-line to the leading comment block — so `@homepage www.sixyin.com` (no scheme, as in the real 六音 script) parses fine.

### 2.3 The `globalThis.lx` global object [VERIFIED]

> ### `globalThis.lx`
> 应用为脚本暴露的 API 对象。

| Member | Docs text |
|---|---|
| `lx.version` | 自定义源 API 版本，API 变更时此版本号将会更改。 |
| `lx.env` | 自定义源运行环境，桌面版将固定为 `desktop`。 / 移动端将固定为 `mobile`。 |
| `lx.currentScriptInfo` | 当前自定义源脚本信息（导入时在头部解析到的）— `.name`, `.description`, `.version`, `.author`, `.homepage`, `.rawScript`（源的原始代码） |
| `lx.EVENT_NAMES` | 常量事件名称对象 |
| `lx.on(event_name, handler)` | 事件注册方法，应用主动与脚本通信时使用 |
| `lx.send(event_name, datas)` | 事件发送方法，脚本主动与应用通信时使用 |
| `lx.request(url, options, callback)` | HTTP 请求方法 … **此 HTTP 请求方法不受跨域规则限制** |
| `lx.utils` | 应用提供给脚本的工具方法 |

**The literal value of `lx.version` is `'2.0.0'`** — read directly from both runtimes' preload source (`version: '2.0.0'` in desktop `renderer/preload.js` and mobile `user-api-preload.js`) [VERIFIED]. This is not stated as a literal in the docs, only as "API 变更时此版本号将会更改".

### 2.4 `lx.EVENT_NAMES` — the three handler events [VERIFIED — quoted from the official docs]

> | 事件名 | 描述 |
> | --- | --- |
> | `inited` | 脚本初始化完成后发送给应用的事件名，发送该事件时需要传入以下信息：`{ sources, openDevTools }` … |
> | `request` | 应用 API 请求事件名，回调入参：`handler({ source, action, info})`，回调必须返回 `Promise` 对象 … |
> | `updateAlert` | 显示源更新弹窗，发送该事件时的参数：`{log, updateUrl}` … 此事件每次运行脚本只能调用一次 |

**`inited` payload, verbatim from the docs:**

> `sources`：支持的源信息对象
> `sources[kw/kg/tx/wy/mg/local].name`：源的名字（目前非必须）
> `sources[kw/kg/tx/wy/mg/local].type`：源类型，目前固定值需为 `music`
> `sources[kw/kg/tx/wy/mg/local].actions`：支持的 actions 数组，`local` 源可用值为 `musicUrl`、`lyric`、`pic`，其他源只支持 `musicUrl`
> `sources[kw/kg/tx/wy/mg/local].qualitys`：该源支持的音质列表，有效的值为 `['128k', '320k', 'flac', 'flac24bit']`，该字段用于控制应用可用的音质类型，当 `source` 为 `local` 时，传入 `[]` 即可

**`updateAlert` payload, verbatim:**

> `log`：更新日志，必传，字符串类型，内容可以使用 `\n` 换行，最大长度 1024，超过此长度后将丢弃超出的部分
> `updateUrl`：更新地址，用于引导用户去该地址更新源，选传，需为 HTTP 协议的 URL 地址，最大长度 1024
> 此事件每次运行脚本只能调用一次
> 例子：`lx.send(lx.EVENT_NAMES.updateAlert, { log: 'hello world', updateUrl: 'https://xxx.com' })`

**Critical init rule, verbatim:**

> **注意：初始化事件被发送前，执行脚本的过程中出现任何错误将视为脚本初始化失败。**

**Also, verbatim on `lx.on`:**

> **注意**：注册的回调在被调用时必须返回 `Promise` 对象。

### 2.5 The `request` / `musicUrl` contract [VERIFIED — quoted from the official docs]

> `source`：音乐源，可能的值取决于初始化时传入的 `sources` 对象的源 key 值
> `info`：请求附加信息，内容根据 `action` 变化
> `action`：请求操作类型，取决于发送 `inited` 事件时传入的 `actions` 数组中的值
>
> 当为 `musicUrl` 时表示获取音乐URL链接，`info` 的结构：`{type, musicInfo}`
> `info.type`：音乐质量，可能的值有 `128k` / `320k` / `flac` / `flac24bit`（取决于初始化时对应源传入的 `qualitys` 值中的一个，`source` 为 `local` 时该值为 `null`）
> `info.musicInfo`：音乐信息对象，里面有音乐 ID、名字等信息，**该操作需要在 Promise 返回 HTTP 形式的歌曲 URL**
>
> 当为 `lyric` 时，表示获取音乐歌词，`info` 的结构：`{musicInfo}`，该操作需要在 Promise 返回歌曲的歌词信息（结构为 `{lryic,tlryic,rlyric,lxlyric}`，例如：`{lyric:'..',tlryic:...}`）
>
> 当为 `pic` 时，表示获取音乐封面图片，`info` 的结构：`{musicInfo}`，该操作需要在 Promise 返回 HTTP 形式的歌曲封面图片 URL

So: **`musicUrl` must resolve to a plain HTTP(S) URL string** — the source does not return audio bytes, it returns a link the shell then plays. This is the architectural core of the app's legal position (§4).

**Return-value validation, [VERIFIED from `preload.js` source] — this is stricter than the docs and is the single most common cause of a source "working in dev but rejected":**

```js
case 'musicUrl':
  if (typeof response != 'string' || response.length > 2048 || !/^https?:/.test(response)) throw new Error('failed')
  sendData.result = { source, action, data: { type: data.info.type, url: response } }
  break
case 'lyric':
  sendData.result = { ..., data: verifyLyricInfo(response) }
  break
case 'pic':
  if (typeof response != 'string' || response.length > 2048 || !/^https?:/.test(response)) throw new Error('failed')
```

and

```js
const verifyLyricInfo = (info) => {
  if (typeof info != 'object' || typeof info.lyric != 'string') throw new Error('failed')
  if (info.lyric.length > 51200) throw new Error('failed')
  return {
    lyric: info.lyric,
    tlyric: (typeof info.tlyric == 'string' && info.tlyric.length < 5120) ? info.tlyric : null,
    rlyric: (typeof info.rlyric == 'string' && info.rlyric.length < 5120) ? info.rlyric : null,
    lxlyric: (typeof info.lxlyric == 'string' && info.lxlyric.length < 8192) ? info.lxlyric : null,
  }
}
```

Hard limits: URL ≤ 2048 chars and must match `^https?:`; `lyric` ≤ 51200 chars (hard fail); `tlyric`/`rlyric` ≤ 5120 and `lxlyric` ≤ 8192 (silently nulled, not an error).

**`lxlyric` (逐字歌词) format, verbatim from the docs' example:**

> `lxlyric`：lx 逐字歌词，没有可为 null，歌词格式为 `[分钟:秒.毫秒]<开始时间（基于该句）,持续时间>歌词文字`
> 例如：`[00:00.000]<0,36>测<36,36>试<50,60>歌<80,75>词`

### 2.6 `lx.request` and `lx.utils` [VERIFIED]

**`lx.request`, verbatim:**

> `@param url 请求的URL`
> `@param options 请求选项，可用选项有 method / headers / body / form / formData / timeout`
> `@param callback 请求结果的回调 入参：err, resp, body`
> `@return 返回一个方法，调用此方法可以终止HTTP请求`
> `const cancelHttp = globalThis.lx.request(url, options, callback)`

Implementation detail [VERIFIED from `preload.js`]: desktop uses `needle` (a lyswhut fork, commit-pinned in `package.json`), applies the app's proxy via the `tunnel` package (`httpsOverHttp`/`httpOverHttp`), and caps `timeout` at `Math.min(timeout, 60_000)` with a 60 s default. The callback receives `{statusCode, statusMessage, headers, bytes, raw, body}` where `body` is JSON-parsed if parseable. Mobile returns only `{statusCode, statusMessage, headers, body}` plus an optional `binary: true` option; the desktop-only `raw`/`bytes` are commented out in the mobile preload.

**`lx.utils`, verbatim (desktop doc):**

> - `globalThis.lx.utils.buffer.from`：对应 Node.js 的 `Buffer.from`。
> - `globalThis.lx.utils.buffer.bufToString`：Buffer 转字符串 `bufToString(buffer, format)`，`format` 对应 Node.js `Buffer.toString` 的参数。
> - `globalThis.lx.utils.crypto.aesEncrypt`：AES 加密 `aesEncrypt(buffer, mode, key, iv)`。
> - `globalThis.lx.utils.crypto.md5`：MD5 加密 `md5(str)`。
> - `globalThis.lx.utils.crypto.randomBytes`：生成随机字符串 `randomBytes(size)`。
> - `globalThis.lx.utils.crypto.rsaEncrypt`：RSA 加密 `rsaEncrypt(buffer, key)`。
> - `globalThis.lx.utils.zlib.inflate`：解压 `inflate(buffer: Buffer) => Promise<Buffer>`。
> - `globalThis.lx.utils.zlib.deflate`：压缩 `deflate(buffer: Buffer) => Promise<Buffer>`。

**Implementation reality [VERIFIED from `preload.js` source] — the docs undersell this:**

- `crypto.rsaEncrypt` left-pads the buffer with zeros to 128 bytes and uses **`RSA_NO_PADDING`**:
  ```js
  rsaEncrypt(buffer, key) {
    buffer = Buffer.concat([Buffer.alloc(128 - buffer.length), buffer])
    return publicEncrypt({ key, padding: constants.RSA_NO_PADDING }, buffer)
  }
  ```
  This is a raw-RSA primitive shaped for reproducing Chinese music-platform "weapi/eapi"-style handshakes, not a general-purpose encryption helper. On mobile the same function maps to Java `RSA/ECB/NoPadding`.
- `crypto.aesEncrypt(buffer, mode, key, iv)` passes `mode` **straight into Node's `createCipheriv`**, so on desktop any OpenSSL cipher name works; on mobile it is a hard `switch` limited to `aes-128-cbc` (→ `AES/CBC/PKCS7Padding`) and `aes-128-ecb` (→ `AES`), throwing `Binary encoding is not supported for input strings` for anything else.
- `crypto.md5(str)` returns a **hex string** (`createHash('md5').update(str).digest('hex')`). On mobile it goes through Java but is computed over `encodeURIComponent(str)`.
- `buffer.from` is a thin pass-through to Node `Buffer.from` on desktop; mobile is a hand-rolled partial (`base64`/`hex`/`utf8` only, `binary` explicitly throws).
- `zlib.inflate`/`deflate` are promisified Node `zlib` on desktop and **commented out entirely on mobile** — the mobile docs strike them through: *"~~`globalThis.lx.utils.zlib.inflate`~~ *移动版环境目前未实现*"*.

### 2.7 Desktop vs. mobile differences [VERIFIED — the docs have a dedicated section, quoted]

> - 移动版 `inited` 事件无 `openDevTools` 选项。
> - 移动版 `lx.utils` 的某些方法不可用，对于不可用或部分可用的方法，背后会有括号说明。
> - 移动版只有极少部分宿主环境 API 可用，详情看「可用宿主环境 API」说明。
> - 移动版由于预加载脚本与自定义脚本运行在同一个环境下，出于对预加载脚本的安全性考虑，除了 `Function.prototype.toString`、`Function.prototype.toLocaleString`、`Object.prototype.toString` 外的其他 JavaScript 内置属性都会被冻结，所以类似 `Array.prototype.push = ...` 的代码都将无效，但扩展内置对象的行为是允许的，例如：`Array.prototype.myPush = ...`。

And the mobile-only host API section:

> ## 可用宿主环境 API
> - `setTimeout` / `clearTimeout`

That is the **complete** list. No `console`-beyond-a-shim, no `fetch`, no `URL`, no `TextEncoder`, no `atob`/`btoa`, no `Buffer`.

**The freezing is enforced in code [VERIFIED from `user-api-preload.js`]:**

```js
const freezeObjectProperty = (obj, freezedObj = new Set()) => {
  ...
  for (const [name, { ...config }] of Object.entries(Object.getOwnPropertyDescriptors(obj))) {
    if (!excludes.includes(config.value)) {
      if (config.writable) config.writable = false
      if (config.configurable) config.configurable = false
      Object.defineProperty(obj, name, config)
    }
    freezeObjectProperty(config.value, freezedObj)
  }
}
freezeObjectProperty(globalThis)
```

Mobile **also disables dynamic code execution**, which matters for obfuscated sources:

```js
globalThis.eval = function() { throw new Error('eval is not available') }
const proxyFunctionConstructor = new Proxy(Function.prototype.constructor, {
  apply() { throw new Error('Dynamic code execution is not allowed.') },
  construct() { throw new Error('Dynamic code execution is not allowed.') },
})
Object.defineProperty(Function.prototype, 'constructor', { value: proxyFunctionConstructor, writable: false, configurable: false, enumerable: false })
globalThis.Function = proxyFunctionConstructor
```

[INFERENCE] This is almost certainly why the mobile docs mention obfuscation-sensitive behaviour at all, and why some heavily-obfuscated desktop sources that rely on `Function(...)`-based string decoders can fail or behave differently on mobile. Note the common `javascript-obfuscator` "self-defending"/"debug-protection" presets use exactly `Function.prototype.constructor` and `eval`.

The mobile preload also **deletes its own bootstrap globals** (`delete globalThis.lx_setup`, `delete globalThis.__lx_native_call__`, and each `__lx_native_call__*`) so a malicious source cannot re-invoke the native bridge.

### 2.8 Source keys and qualitys — what they actually mean [VERIFIED]

From `supportQualitys` / `supportActions` / `allSources` in **both** preload files:

```js
const allSources = ['kw', 'kg', 'tx', 'wy', 'mg', 'local']
const supportQualitys = {
  kw: ['128k', '320k', 'flac', 'flac24bit'],
  kg: ['128k', '320k', 'flac', 'flac24bit'],
  tx: ['128k', '320k', 'flac', 'flac24bit'],
  wy: ['128k', '320k', 'flac', 'flac24bit'],
  mg: ['128k', '320k', 'flac', 'flac24bit'],
  local: [],
}
const supportActions = {
  kw: ['musicUrl'], kg: ['musicUrl'], tx: ['musicUrl'],
  wy: ['musicUrl'], mg: ['musicUrl'], xm: ['musicUrl'],
  local: ['musicUrl', 'lyric', 'pic'],
}
```

- **`kw` = 酷我, `kg` = 酷狗, `tx` = 企鹅/QQ, `wy` = 网易云, `mg` = 咪咕, `local` = 本地音乐.**
- **`xm` (虾米) appears in `supportActions` but not in `allSources`, so it is dead code** — the `for (const source of allSources)` loop never reaches it. **I traced the origin of this leftover:** the desktop **v1.8.0** release notes (2021-03-07) state *"移除虾米源。注：虽然已移除该源，但仍可尝试去播放之前添加的歌曲，虽然不一定会成功"* [VERIFIED via the releases API]. So `xm` has been orphaned in `supportActions` since the day the custom-source feature shipped — Xiami was removed in the *same release* that introduced custom sources.
- `bd` (百度) exists in the app's i18n (`source_bd: "百度音乐"`, alias `source_alias_bd: "小杜音乐"`) and has a full `musicSdk/bd/` directory, but is **not** in `allSources` either — so a custom source **cannot** register a `bd` key on current builds.
- **`qualitys` semantics, restated precisely:** `qualitys` is *not* a promise about what the source can technically deliver — it is the **filter that populates the app's quality dropdown for that source**. The docs say *"该字段用于控制应用可用的音质类型"*. The runtime intersects it with the platform whitelist: `qualitys: qualitys.filter(q => userSource.qualitys.includes(q))`. So declaring `flac24bit` on `wy` is accepted (wy is whitelisted for it) but declaring `192k` or `ape` is silently dropped. [VERIFIED from code; the `192k` removal is also historical — desktop changelog v0.6.1: *"移除 `192k` 音质"*.]
- **`type` must be exactly `'music'`** or the source is skipped: `if (!userSource || userSource.type !== 'music') continue`.
- **`actions` is intersected, not validated:** `actions: actions.filter(a => userSource.actions.includes(a))`. So a non-`local` source that declares `['musicUrl','lyric']` silently gets only `['musicUrl']`.
- The `sources` object's `name` is **optional** in the runtime (`sourceInfo.sources[source] = { type, actions, qualitys }` — `name` is not copied), matching the docs' *"源的名字（目前非必须）"*.
- **`local` source** is the only one with `lyric` and `pic`, and the only one where `info.type` is `null`. It exists so a source can supply audio/lyrics/covers for *local files* (the docs' example is a "本地音乐" source).
- The platform **alias names** in the app are deliberately obfuscated: `小蜗音乐` (kw), `小枸音乐` (kg), `小秋音乐` (tx), `小芸音乐` (wy), `小蜜音乐` (mg), `小霞音乐` (xm), `小杜音乐` (bd), and the aggregate is `聚合大会`. The license agreement explains why: *"本项目内的官方音乐平台别名为本项目内对官方音乐平台的一个称呼，不包含恶意。"* [VERIFIED from `src/lang/zh-cn.json`]

### 2.9 Import mechanics [VERIFIED]

Two import paths, both confirmed in `zh-cn.json` (`user_api__btn_import: "本地导入"`, `user_api__btn_import_online: "在线导入"`, `user_api_import_online__title: "在线导入自定义源"`, `user_api_import_online__input_tip: "请输入 HTTP 链接"`):

- **本地导入** — pick a `.js` file.
- **在线导入** — paste an HTTP(S) URL. Added in **desktop v2.7.0 (2024-04-14)**: *"新增在线自定义源导入功能，允许通过http/https链接导入自定义源"*, and **mobile v1.3.0 (2024-04-14)**: same wording. [VERIFIED from both CHANGELOGs]

Storage [VERIFIED from `src/main/modules/userApi/utils.ts`]: the script is **deflate-compressed and base64-encoded with a `gz_` prefix** and persisted in an electron-store named `STORE_NAMES.USER_API`; duplicates are rejected by comparing the compressed form (`导入失败，脚本内容与已有的源「{api.name}」相同`). ID format: `user_api_${Math.random().toString().substring(2, 5)}_${Date.now()}`.

Limits [VERIFIED from `zh-cn.json` and source]:
- **Max 20 sources:** `user_api__max_tip: "最多只能同时存在 20 个源哦🤪\n想要继续导入的话，请先移除一些旧的源腾出位置吧"`
- Desktop request timeout **20 s** (`setTimeout(() => cancelRequest(requestKey), 20000)` in `rendererEvent/rendererEvent.ts`).
- Desktop v2.8.0 fixed a file-size ceiling that blocked large sources: *"增大在线导入自定义源文件的大小限制，解决某些音源无法导入的问题（#1857）"*. This matters because real 六音 scripts are ~333 KB (§3.4).
- The UI carries an explicit malware warning: `user_api__note: "提示：虽然我们已经尽可能地隔离了脚本的运行环境，但导入包含恶意行为的脚本仍可能会影响你的系统，请谨慎导入。"` [VERIFIED]

---

## 3. How users share sources, and what breaks them

### 3.1 The official explanation for why sources are needed at all [VERIFIED — quoted verbatim from the docs FAQ]

From `https://lxmusic.toside.cn/desktop/faq/cannot-play-and-download`:

> ### 所有歌曲都提示 `换源失败，请尝试手动...`
> 由于收到腾讯投诉，要求停止内置其平台的在线播放及下载服务，所以从 2023-10-18 起，LX Music 本身不再提供上述服务——桌面版 v2.6.0 移除了所有内置自定义源，且旧版本内置的源也已失效。你需要编写或寻找别人分享的自定义源导入，才可正常使用。
> _提示：可以去 [GitHub Issues](https://github.com/lyswhut/lx-music-desktop/issues?q=is%3Aissue+) 找找。_

The mobile FAQ page (`/mobile/faq/cannot-play-and-download`) is identical except it says **移动版 v1.2.0** instead of 桌面版 v2.6.0.

### 3.2 The 2023-10-18 removal — verified from four independent primary sources

**(a) The author's own issue #1643** — see §4.2 for the full quoted statement. This is the authoritative account: *"LX于2023年10月18日收到了腾讯的警告信"*.

**(b) Desktop CHANGELOG, v2.6.0 (released 2024-02-01), `其他` section [VERIFIED]:**

> - 移除所有内置源，由于收到腾讯投诉要求停止提供软件内置的连接到他们平台的在线播放及下载服务，所以从即日（2023年10月18日）起LX本身不再提供上述服务

Note the discrepancy worth flagging: **the complaint is dated 2023-10-18 but the release that removed the sources shipped 2024-02-01.** The v2.6.0 release notes open with a warning that the removal was accompanied by a breaking API change:

> 更新前需要注意：
> 由于自定义源的调用方式变更，可能会导致某些第三方源停止工作，如果出现这种情况，你需要将LX回退到 v2.5.0

**(c) Mobile CHANGELOG, v1.2.0 (2024-02-01), `其他` section [VERIFIED]** — same text, and mobile v1.2.0 is also where custom sources were *introduced* at all:

> - 新增自定义源（实验性功能），调用方式与PC端一致，但需要注意的是，移动端自定义源的环境与PC端不同，某些环境API不可用，详情看自定义说明文档
> - 移除所有内置源，由于收到腾讯投诉要求停止提供软件内置的连接到他们平台的在线播放及下载服务，所以从即日（2023年10月18日）起LX本身不再提供上述服务

**(d) The complaint letter itself.** GitHub issue **#1641** `[Bug]: 致：洛雪音乐助手` (opened 2023-10-21 by user `Douboya`, still open, 4 comments) pastes what is presented as the **Tencent Music Entertainment Group** letter. The body reads, in part [VERIFIED — retrieved via the GitHub API, quoted as it appears]:

> 主题：关于立即停止犯罪行为的要求
> 我司腾讯音乐娱乐集团系QQ音乐、酷我音乐、酷狗音乐网站（下称"腾讯音乐平台"）的运营方，长期以来致力于推进音乐产业的正版化，耗费巨大成本获得了国内外多家知名版权公司的授权，吸引了大量尊重正版的忠实用户
> 但腾讯音乐日前发现，贵方开发运营的"洛雪音乐助手"软件在未经我司允许的情况下，擅自链接腾讯音乐平台，向用户免费提供腾讯音乐平台全部音乐内容的在线播放及下载服务。贵方前述行为直接窃取我司耗费巨大成本获取的版权内容，导致我司运营的腾讯音乐平台用户流失，严重损害了我司的合法权益。
> 綜上，根据《中华人民共和国刑法》、《中华人民共和国著作权法》，《信息网络传播权保护条例》等法律法规的规定，贵方行为严重侵害了腾讯音乐的合法权益，存在强烈的主观恶意，不仅是对我司的直接侵权行为，更是我国刑法所禁止的犯罪行为！现郑重致函贵方，在收到本函之日立即停止链接QQ音乐、酷我音乐、酷狗音乐的行为，关停非法软件并停止所有软件版本传播。否则我司将向公安机关报告以维护我司合法权益。
> 腾讯音乐娱乐集团
> 2023年10月18日

**[UNVERIFIED]** I could not independently authenticate this document — it is a user-pasted reproduction in a GitHub issue, not a scanned notice on a third-party service. Its date, addressees, and named platforms are however fully consistent with the official CHANGELOG and FAQ statements, which is strong circumstantial corroboration. Treat the *fact* of a Tencent complaint as verified; treat the *verbatim letter text* as community-published.

A companion issue **#1639** (2023-10-21, `alya0408`, still open, 10 comments) is titled `[Bug]: 目前最新版歌曲所有源都无法播放，腾讯投诉，但是网易的源为什么也不行。` and reports the user was on v2.5.0 with v1.22.3 as last-good [VERIFIED] — i.e. the immediate user-visible symptom was total playback failure, and users were confused that the removal was broader than the Tencent-named platforms.

### 3.3 The API v2.0.0 breaking change — the real "version bump broke sources" story

**[VERIFIED — quoted verbatim from the desktop CHANGELOG, v2.6.0, section `自定义源的不兼容变更与新增内容（源开发者需要看）`]:**

> 自定义源的调用方式已改变：
> - 为了与移动端的调用方式统一，不再推荐使用 `window.lx` 对象（移动端无`window`对象），改用 `globalThis.lx`
> - `inited` 事件不再需要传递 `status` 属性，脚本运行过程中，在成功调用 `inited` 事件之前的任何首次未捕获的错误都将视为初始化失败，所以现在若想人为让脚本初始化失败，直接抛出一个错误即可
> - 新增 `globalThis.lx.env` 属性，桌面端环境固定为 `desktop`，移动端环境固定为 `mobile`
> - 新增 `globalThis.lx.currentScriptInfo` 对象，可以从这里获取解析后的脚本头部注释信息及脚本原始内容，具体可用属性看文档说明
> - `globalThis.lx.version` 属性更新到 `2.0.0`
> - 自定义源不再使用`script`标签的形式执行，若要获取脚本原始代码字符串需从 `globalThis.lx.currentScriptInfo.rawScript` 属性获取
> - 自定义源新增支持`local`源的`musicUrl`、`pic`、`lyric` 的获取操作详情看自定义源文档说明

**This is the actual, documented, load-bearing incompatibility in the ecosystem** — a `window.lx` → `globalThis.lx` migration plus a `lx.version` bump to `2.0.0`, shipped in the same release that removed the built-in sources. Any source written before v2.6.0 that referenced `window.lx` would need updating, and the changelog's own mitigation advice was *"你需要将LX回退到 v2.5.0"*.

**`lx.version` has moved more than once, and each move is a potential break.** The desktop release notes record the increments: **v1.3.0** at desktop **v2.2.1** (when `lx.utils.zlib.inflate`/`deflate` were added) and **v2.0.0** at desktop **v2.6.0** [VERIFIED via the releases API]. The current runtime value is **`2.0.0`** in both apps' preload source (§2.3).

This is precisely why the better-written community sources now ship **defensive version gates**. `juhe/latest.js` fetches `/init.conf` at startup and raises an update alert if the server's advertised version is newer than the running one:

```js
h(A+'/init.conf').then(r=>{
  if(r.body.code!==200) x("脚本初始化失败");
  let U=r.body.data;
  if(U.update.version>v) y(n.updateAlert,U.update);   // v === lx.version
  y(n.inited,U.init);
})
```

and `grass`/`flower` do the same with `parseInt(j['lv']) > parseInt(U['version'])` before calling `send(EVENT_NAMES.updateAlert, ...)` [VERIFIED]. **[INFERENCE]** Source authors have had to build their *own* compatibility-negotiation layer on top of a contract that offers no version-negotiation primitive beyond "compare a string" — which is a direct consequence of the API having broken once already.

**Contrast with an AI-generated claim I was able to refute — and whose *kernel* I was then able to trace.** A GitCode blog post, [`解决洛雪音乐播放异常的完整指南`](https://blog.gitcode.com/908857c6fd991692b55645d511fc1299.html), asserts:

> 洛雪音乐1.6.0版本更新后 … 是API接口版本从v1升级到了v2，带来了三方面的变化：请求头格式新增了`X-API-Version`字段 … 响应数据结构将原来的`data`字段嵌套改为平铺格式；身份验证方式从简单Token变更为JWT（JSON Web Token）认证。这些变化使得传统的六音音源无法与新版客户端正常通信

**This is fabricated.** Evidence:
1. The page is explicitly machine-generated — its own footer reads *"版权声明：本文由 AtomGit 博客平台 AIGC 生成并经审核发布"*.
2. There is **no `X-API-Version` header and no JWT anywhere** in the custom-source contract. The actual auth-ish surface is a plain `headers` object the *script author* chooses; the app supplies no auth.
3. **"洛雪音乐 1.6.0" is a mobile version, not a desktop one.** Mobile v1.6.0 shipped **2024-08-24** and its actual changelog entries are *"新增 我的列表-歌曲右击菜单-歌曲换源 功能"* and *"新增 Scheme URL 调用支持"* — nothing about API versioning. Desktop never had a 1.6.0 in the modern 2.x line relevant here.
4. The article also cites a file `sixyin-music-source-v1.0.7.js` and a repo `New_lxmusic_source`; the real 六音 script is at **v1.2.1** (§3.4).
5. It invents a version-compatibility table ("1.6.0 - 1.6.5 → v1.0.7", "1.7.0+ → v1.1.0+") that corresponds to nothing.

**Conclusion: discard that article's technical content entirely.** It is a good specimen of the AI-written Chinese "教程" slop that dominates search results for this topic.

**But the article's kernel is real, and it is worth extracting because it reveals the *actual* documented breakage.** The article cites a repo `New_lxmusic_source` and a file `sixyin-music-source-v1.0.7.js`. **That repo is real** — [`laosunmaker/New_lxmusic_source`](https://github.com/laosunmaker/New_lxmusic_source), description `六音音源修复版`, **Apache-2.0**, 333 stars, created **2024-02-01**, last push 2025-04-14 [VERIFIED via GitHub API]. Its README says, in full:

> # New_lxmusic_source
> 六音音源修复版
> ## 概述
> 洛雪音乐1.6.0之后，六音音源失效，好在有大佬修复此音源，但这也并不是长久之计，因此我准备重新设计新的音源，在此之前，欢迎大家使用仓库里由 @huio 修复过的六音音源。
>
> 4月14日后记：
> 六音还在正常提供音源，现在也没有这么高需求了，所以在新音源消失之前，此仓库将不再更新

So the chain is: **a real community author wrote "洛雪音乐1.6.0之后，六音音源失效"** → **an AIGC blog laundered that one sentence into an invented `X-API-Version`/JWT/data-reshaping mechanism** → **search engines now surface the fabricated version as the top explainer.** That is a precise illustration of the AI-slop problem in this research area.

**And the real "1.6.0" is almost certainly mobile, not desktop.** Desktop v1.6.0 is **2021-01-10** — five years before the custom-source feature could break in this way, and indeed the feature did not exist: **自定义源 was introduced in desktop v1.8.0, released 2021-03-07**, whose release notes list *"新增自定义源功能，源编写规则可以去常见问题查看"* [VERIFIED via the releases API — and independently corroborated by issue #409 `增加自定义源音乐来源`, opened 2021-01-06 and closed 2021-03-07, i.e. resolved by that very release]. Mobile **v1.6.0 shipped 2024-08-24**, squarely inside the post-removal era when the whole community was juggling third-party sources, and its changelog shows nothing about sources. **[INFERENCE]** The mobile reading is the only chronologically coherent one, but note the fix-repo author never states which build he meant, and **I could not verify a version-to-breakage mapping** — the README's own addendum undercuts the premise anyway: *"六音还在正常提供音源，现在也没有这么高需求了"* ("sixyin is still providing sources normally; there isn't such high demand now"), i.e. **the author of the "fix" repo says the breakage resolved and froze his repo.**

### 3.4 How sources are actually shared in the wild [VERIFIED]

**The dominant pattern is a single GitHub repo of `latest.js` URLs imported via 在线导入.** The most-starred aggregator is [`pdone/lx-music-source`](https://github.com/pdone/lx-music-source) — **8,844 stars, 738 forks, created 2024-11-15, `language: JavaScript`**. Its README is nothing but a list of import URLs, offered in two flavours — **原始链接** (raw GitHub) and **加速链接** (ghproxy mirrors):

```
原始链接
### SixYin
https://raw.githubusercontent.com/pdone/lx-music-source/main/sixyin/latest.js
### Huibq
https://raw.githubusercontent.com/pdone/lx-music-source/main/huibq/latest.js
### Flower
https://raw.githubusercontent.com/pdone/lx-music-source/main/flower/latest.js
### LX
https://raw.githubusercontent.com/pdone/lx-music-source/main/lx/latest.js
### ChangQing
https://raw.githubusercontent.com/pdone/lx-music-source/main/changqing/latest.js
### HuanYin
https://raw.githubusercontent.com/pdone/lx-music-source/main/huanyin/latest.js
### ikun
https://raw.githubusercontent.com/pdone/lx-music-source/main/ikun/latest.js
### Grass
https://raw.githubusercontent.com/pdone/lx-music-source/main/grass/latest.js
### JuheApi
https://raw.githubusercontent.com/pdone/lx-music-source/main/juhe/latest.js
### QDY
https://raw.githubusercontent.com/pdone/lx-music-source/main/qdy/latest.js
```

with the mirror list:

> 当以上链接无法访问时，可将连接开头的 `https://ghproxy.net/` 替换为下边任一地址，然后重试。
> - https://gh.llkk.cc/
> - https://github.moeyy.xyz/
> - https://ghproxy.cn/
> - https://gh.api.99988866.xyz/
> - https://ghp.ci/
> - https://gh-proxy.org/
>
> 加速链接仅推荐访问GitHub受限的用户使用，如果你的网络可以流畅访问GitHub，建议直接使用原始链接。

**[INFERENCE]** This README is itself a precise map of the ecosystem's fragility: the primary distribution channel (GitHub raw) is unreliable from mainland China, so users are told to route through one of six third-party GitHub proxies — each of which is an independent single point of failure that can rate-limit, block, or disappear. When a user says "音源失效," a meaningful fraction of the time the source is fine and *the proxy URL is dead*.

The **declared upstreams** in that README (`## 数据来源`) are:

> - [SixYin](https://www.sixyin.com/)
> - [Huibq/keep-alive](https://github.com/Huibq/keep-alive/)
> - [LX](https://www.lxmusic.cc/)
> - [ikun](https://github.com/MeoProject/lx-music-api-server)
> - ChangQing（长青SVIP音源 by 元力菌）
> - HuanYin（幻音音源 by 竹佀）

A separate, more "editorial" aggregator is [`Macrohard0001/lx-ikun-music-sources`](https://github.com/Macrohard0001/lx-ikun-music-sources) — **2,438 stars, 288 forks**, `license: "Other"/NOASSERTION`, self-described as *"LX_music & IKUN_music 音源收集"*.

**A mainstream-media import tutorial** confirms the exact end-user flow, in [`洛雪音乐音源导入教程`](https://m.ali213.net/news/gl2609/1807353.html) (ali213, dated 2026-09-09):

> 1、点击左上角三条杠选择进入设置界面。
> 2、下滑屏幕找到自定义源选项，点击自定义源管理。
> 3、点击导入，在下拉栏中选择在线导入。
> 4、复制以下音乐源地址链接粘进入，点击导入等待显示导入成功 …
> 5、导入完成后需要在自定义源处勾选上导入的音乐源，完成以上操作后就可以正常播放音乐了。

and hands the reader `https://raw.githubusercontent.com/pdone/lx-music-source/main/huibq/latest.js`, with the caveat *"如多次尝试此链接无法导入请在下方评论留言等待管理员处理"* — i.e. even a mainstream tutorial treats link rot as expected.

A **52pojie help thread** ([`洛雪音乐答疑`](https://www.52pojie.cn/forum.php?mod=viewthread&tid=2094273), opened 2026-03-03) is a good snapshot of user-level reality: the OP reports *"已经下载了洛雪音乐的最新版本，也导入了音源，但是所有歌曲都播放不了，总是显示换源失败"*; the first reply is *"2.12.1 版本没问题"*; another suggests three specific source filenames (`lx-dujia.js`, `lx-huibq.js`, `lx-juhe.js`); a later post shares a **different** gh-proxy-wrapped raw URL and gets *"感谢朋友分享，可以用了"*. [VERIFIED]

### 3.5 Concrete, source-code-level evidence of *why* sources break

Rather than repeating generic community claims, here is what the actual source files do — each of these is a distinct failure mode.

**Failure mode A — the script is a thin client for a third-party relay server, so it dies with the server.** This is not a hypothesis: **I measured it, and relay death is the dominant cause of 音源失效.** The scripts' relay hostnames were extracted from the actual downloaded files and probed directly. **Independently reproduced twice** (once by a parallel research pass, once by me re-running the probe); results below are from my re-run.

**Root-host probe:**

| Host | Used by | Result |
|---|---|---|
| `api.huibq.com` | qdy | **connection failure** |
| `api.ikunshare.com` | ikun | **connection failure** |
| `api.lingchuan.com` | qdy | **connection failure** |
| `music-dl.sayqz.com` | huanyin, qdy | **connection failure** |
| `proxy.qishui.vsaa.cn` | qdy | **connection failure** |
| `175.27.166.236` | qdy | **connection failure** |
| `music-api.gdstudio.xyz` | qdy | **timeout (11 s)** |
| `lxmusicapi.onrender.com` | huibq | **HTTP 503** |
| `music.haitangw.cc` | qdy | **HTTP 403** |
| `musicapi.haitangw.net` | qdy | **HTTP 403** |
| `yinyue.haitangw.net` | changqing | **HTTP 403** |
| `api.vsaa.cn` | qdy | HTTP 200 |
| `api.xcvts.cn` | huanyin, qdy | HTTP 200 |
| `oiapi.net` | qdy | HTTP 200 |
| `music.nxinxz.com` | qdy | HTTP 200 |
| `13413.kstore.vip` | changqing | HTTP 404 (root; endpoint works — see below) |

**Targeted probe of the actual API endpoints** (more meaningful than root paths) — this is the decisive result:

| Endpoint | Result |
|---|---|
| `lxmusicapi.onrender.com/url/kw/…` (**huibq's real playback call**) | **HTTP 503** |
| `api.ikunshare.com` | **`ENOTFOUND`** (DNS does not resolve) |
| `music-dl.sayqz.com/api/?source=qq&…` (**huanyin's real playback call**) | **`ENOTFOUND`** |
| `api.xcvts.cn/api/music/migu?…` (**huanyin's 咪咕 path**) | **TimeoutError after 15 s** |
| `api.music.lerd.dpdns.org/init.conf` (**juhe init**) | **HTTP 200** — returns a full `{"code":200,"data":{"init":{"status":true,…}}}` |
| `88.lxmusic.xn--fiqs8s` (**lx / 独家音源**) | **HTTP 200** — `{"code":0,"msg":"success","data":null}` |
| `13413.kstore.vip/lxmusic/changqing.json` (**changqing update**) | **HTTP 200** — returns `{"version":"1.3.0","updateUrl":"https://www.yuque.com/kejichangqing/…","description":"长青svip音源更新，请尽快更新…"}` |

**[VERIFIED — probed from this sandbox on 2026-09-16.]** Summary: **7 hosts hard-down (including 2 DNS failures), 3 return 403, 1 returns 503.** Of the seven sources whose *primary* playback relay I could exercise end-to-end, **four are dead right now**: `huibq` (503), `ikun` (ENOTFOUND), `huanyin`'s primary path (ENOTFOUND) and its 咪咕 fallback (timeout). Only `juhe`, `lx`, and `changqing` responded.

**Caveat, stated plainly:** some failures could reflect sandbox network policy rather than genuine global death, and a root-path 403/404 does not prove the API path is dead (the `changqing` case shows exactly that). But `ENOTFOUND` for `api.ikunshare.com` — a **paid** service's API host — and `ENOTFOUND` for huanyin's primary relay are hard evidence, and the aggregate pattern is unambiguous.

**This reframes the whole question.** [INFERENCE] The community's mental model of 音源失效 is usually "the platform changed its API and broke the source." The measurement says the **more common cause is that the volunteer-run relay the source depends on has simply stopped**, which is why the ecosystem's characteristic rhythm is not "patch and recover" but **"source dies → wait for the author → or switch to a different source entirely."** It also explains why the architecture is *many sources rather than one maintained source*, and why aggregators grade sources by *how many platforms and qualities they still serve* rather than by code quality.

The concrete anatomy of one such source, [`huibq/latest.js`](https://raw.githubusercontent.com/pdone/lx-music-source/main/huibq/latest.js), which is **plain, unminified, readable JavaScript** and ~60 lines:

```js
/*!
 * @name Huibq_lxmusic源
 * @description Github搜索"洛雪音乐音源"，禁止批量下载！
 * @version v1.2.0
 * @author Huibq
 */
const DEV_ENABLE = false
const API_URL = 'https://lxmusicapi.onrender.com'
const API_KEY = 'share-v3'
const MUSIC_QUALITY = { kw: ['128k','320k'], kg: [...], tx: [...], wy: [...], mg: [...] }
...
const request = await httpFetch(`${API_URL}/url/${source}/${songId}/${quality}`, {
  method: 'GET',
  headers: {
    'Content-Type': 'application/json',
    'User-Agent': `${env ? `lx-music-${env}/${version}` : `lx-usic-request/${version}`}`,
    'X-Request-Key': API_KEY,
  },
})
...
switch (body.code) {
  case 0: return body.url
  case 1: throw new Error('block ip')
  case 2: throw new Error('get music url failed')
  case 4: throw new Error('internal server error')
  case 5: throw new Error('too many requests')
  case 6: throw new Error('param error')
  default: throw new Error(body.msg ?? 'unknow error')
}
```

Every failure mode is *named in the protocol*: `block ip`, `too many requests`, `internal server error`. The `onrender.com` host is Render's free tier, which cold-starts after inactivity — and which **returned HTTP 503 when probed**, meaning this source is currently dead. Note also `MUSIC_QUALITY` caps every platform at `320k`: no lossless at all. `API_KEY = 'share-v3'` is a *shared* key, not a per-user secret — the paid variants (§3.5-C) put the user's key in the URL instead.

**[INFERENCE]** The `onrender.com` choice is itself the failure: a free-tier host with cold starts and quotas, running a relay that must fetch from five platforms, shared by thousands of anonymous users, is a guaranteed-to-die design. And the source openly depends on user restraint to survive — the `block ip` / `too many requests` codes plus the header's `禁止批量下载！` mean the operator is fighting abuse with rate limits, and LX's own settings warning (`setting__download_max_num_tip`, §3.5-G) tells users their bulk-downloading can get the shared relay to ban them.

**Failure mode B — the script is a thin client for a *keyed/signed* relay, i.e. a commercial-ish service.** [`lx/latest.js`](https://raw.githubusercontent.com/pdone/lx-music-source/main/lx/latest.js) is the file the README calls "LX", but its header reveals it is **not** an official source:

```js
/*!
 * @name 独家音源
 * @description 后续更新，请关注微信公众号: 洛雪科技
 * @version 6
 * @author w
 */

// ===== 服务端下发配置(自动生成, 请勿修改) =====
globalThis['SERVER_SCRIPT_CONFIG'] = {"apiUrl":"https:\/\/88.lxmusic.xn--fiqs8s","apiKey":"lxmusic","signSalt":"LxSrv@2026#Sig","fingerprint":"ffdaccdf66796c1cbe96df07bf682118"};
// ===== 服务端下发配置结束 =====
```

The `apiUrl` host `88.lxmusic.xn--fiqs8s` is **punycode for `88.lxmusic.中国`** — a Chinese-IDN domain. The script body is protected by an extremely aggressive obfuscator using **Unicode identifier homoglyphs** (`ﹰﱟ`, `ﱡ‌`, `ءﹺ`, and characters in the Arabic Presentation Forms and Private Use Area) plus an RC4-style string decoder. It carries `apiKey` and `signSalt` values. **[INFERENCE]** This is a server-side-relay source with a signing scheme, distributed under a WeChat-public-account brand ("洛雪科技") that is *not* the upstream author — a textbook impersonation pattern, and precisely the kind of source that "stops working" when the operator rotates keys, goes dark, or the domain lapses.

**And it did stop — for a reason that is worth recording, because it is a failure mode all of its own.** Its relay still answers (`HTTP 200 {"code":0,"msg":"success"}` when I probed it, §3.5-A), so this was not technical death. A 52pojie thread ([`洛雪音乐答疑`](https://www.52pojie.cn/forum.php?mod=viewthread&tid=2094273)) quotes the error dialog a user received:

> 自定义源「[独家音源]」发现新版本: 由于阅读量不达标，暂时停用后续更新，请关注公众号: 洛雪科技

i.e. **"because read-count targets were not met, further updates are suspended — please follow the WeChat public account."** The aggregator's own filename corroborates it: `guoyue2010/lxmusic-` ships a file literally named **`洛雪科技[独家音源] v4-会停用.js`** ("…will be discontinued"). [VERIFIED — both the quoted dialog from the fetched forum page and the filename from the aggregator's file listing.]

**[INFERENCE]** This is an **attention-economy failure mode**: the source was deliberately withheld as leverage to drive public-account follows, and users lost playback overnight for a reason that had nothing to do with music platforms, APIs, or code. It is also the sharpest possible confirmation of §4.4 — the upstream author states there is *no* official WeChat account and that any app requiring a 公众号 follow to work is a third-party modification; here is a "洛雪"-branded source doing exactly that.

**Failure mode C — the script is a thin client for a *paid, card-key-gated* service.** This is now a real market. From the [`lx-ikun-music-sources` README](https://github.com/Macrohard0001/lx-ikun-music-sources) [VERIFIED]:

> ### 🎵 聆澜音源 (by 时迁酱 & guoyue2010)
> **价格方案**：
> - 🏆 永  久：15元
> - 📅 年  卡：4元
> - 📅 月  卡：2元
> - 📅 周  卡: 1.5元
> - 📅 天  卡: 0.6元
>
> **导入链接**：
> - `https://source.shiqianjiang.cn/api/script/lx?key=你的卡密`
> - `https://lc.guoyue2010.top/script/lx?key=你的卡密`
> - `https://lx.xiagua.top/script/lx?key=你的卡密`
>
> ### ⭐ IKUN 音源
> **价格方案**：🏆 永久：15元 / 📅 年卡：10元 / 📅 月卡：5元
> **官方购买**：https://shop.ikunshare.com/

The same README carries the disclaimer *"以下均为第三方提供的付费音源服务，非本项目开发维护。请谨慎购买，产生的任何后果与本项目无关"* and *"所有付费音源禁止二次转发卡密，加价倒卖"*. **[INFERENCE]** The card-key-in-the-URL pattern (`?key=你的卡密`) means the LX "source" is a *credentialed HTTP endpoint*, and "音源失效" for these users literally means "my subscription lapsed" or "the operator's server is down" — an entirely different failure class from a technical API change. It also means the key is visible in the LX source list and in any backup export.

**Failure mode D — the script is a server round-trip with an anti-tamper handshake, so it breaks on any protocol tweak.** [`grass/latest.js`](https://raw.githubusercontent.com/pdone/lx-music-source/main/grass/latest.js) (`@name 野草🌾`, `@version 1`) and [`flower/latest.js`](https://raw.githubusercontent.com/pdone/lx-music-source/main/flower/latest.js) (`@name 野花🌷`, `@version 1`) are near-identical obfuscated twins. Deobfuscating the string table reveals the protocol:

```js
const headers = {
  'User-Agent': `lx-music-${env}`,      // "lx-music/desktop"
  'ver': version,                        // lx.version -> "2.0.0"
  'source-ver': currentScriptInfo['version'],
}
// request path: /grass-source-info/latest  and  /url/<source>/<songid>/<quality>
// a `vkey` header is computed as:
//   utils.buffer.bufToString(utils.crypto.md5(JSON.stringify(key.replace(/(?:\d\w)+/g, ''))), 'hex')
// response: { code, data: { url } }  and a server-pushed `sources` config string
```

Both scripts **fetch their own `sources` manifest from the server at init time**, then call `send(EVENT_NAMES.inited, { sources })`, and both implement `updateAlert` with a version comparison against `lx.version`. **[INFERENCE]** Because the `sources` manifest — which platforms and which qualities are advertised — is *server-controlled*, the operator can enable/disable platforms or qualities remotely without the user re-importing anything; conversely, if the server's manifest schema changes, the script's own parsing (`split('&')`, `split('|')`) breaks. Both scripts contain the literal string `服务器异常` ("server error") and throw `FAILED` on non-200. Both also carry an `md5`-of-a-stripped-key `vkey`, i.e. a weak anti-tamper/attribution token — **[INFERENCE]** the kind of thing a platform or a competing source operator could trivially defeat, and the kind of thing that changes between versions, breaking older script copies.

**Failure mode E — the script is a *pure* relay with a redirect-proxy escape hatch.** [`juhe/latest.js`](https://raw.githubusercontent.com/pdone/lx-music-source/main/juhe/latest.js) (`@name 聚合API接口 (CF)`, `@version 3`, `@author lerd`) is short and readable:

```js
let A='https://api.music.lerd.dpdns.org';
h(A+'/init.conf').then(r=>{
  if(r.body.code!==200) x("脚本初始化失败");
  let U=r.body.data;
  if(U.update.version>v) y(n.updateAlert,U.update);
  y(n.inited,U.init);
}).catch(e=>x(e));
on(n.request, async({action,source,info})=>{
  let r=await h(`${A}/${source}`,{method:'POST',body:t(info),headers:{'Content-Type':'application/json'}});
  let B=r.body;
  if(B.code===200) return B.data.url;
  else if(B.code===303){
    let S=a(t(B.data)); let D=S.request; let F=S.response;
    try{
      let z=await h(encodeURI(D.url),D.options);
      if(F.check.key.reduce((a,c)=>a&&a[c],z)==F.check.value){
        let u=F.url.reduce((a,c)=>a&&a[c],z);
        if(u.startsWith("http")) return u;
      }
    }catch(e){x(e)}
  } else x(B.msg);
});
```

Two things stand out: the **entire `sources`/`inited` payload is downloaded from `/init.conf`** (so the source advertises whatever the server currently supports), and the **HTTP 303 branch is a client-side proxy** — the server tells the client "fetch this URL yourself with these options, then extract the URL by walking these property paths, and verify these fields equal these values." **[INFERENCE]** That 303 mechanism is a deliberate workaround for the server being IP-blocked or rate-limited by a platform: the request is offloaded to the *user's* IP. It is also the most brittle possible design — the extraction paths are data-driven, so any change in the target platform's response shape silently breaks it, and the `check.key`/`check.value` gate is an anti-tamper assertion that fails closed.

**Failure mode F — platform-side signing/encryption churn, visible in the app's own source tree.** The desktop and mobile repos both vendor `src/utils/musicSdk/kg/vendors/infSign.min.js` (~11.8 KB) — a minified KuGou request-signing implementation [VERIFIED, present in both file listings]. **[INFERENCE]** The fact that the *app itself* must ship a minified, commit-churned signature blob just to search KuGou is direct evidence of the platform-side hardening that community sources must independently re-reverse-engineer every time it rotates. This is the mechanism behind the recurring, generically-worded community complaints that "kg 音源失效了".

**Failure mode G — the app's own client-side anti-abuse limits can look like source failure.** `zh-cn.json` warns: `setting__download_max_num_tip: "过大的同时下载数量可能会导致你的 IP 被自定义源封禁，是否确认修改？"` [VERIFIED]. And the huibq script's explicit `case 5: throw new Error('too many requests')` and `case 1: throw new Error('block ip')` show the source side enforcing the same. So a user who bulk-downloads can get themselves banned from a shared source — and will experience it as "音源失效".

**Failure mode H — the script targets an API that does not exist, so declared capabilities are silently dropped.** [`huanyin/latest.js`](https://raw.githubusercontent.com/pdone/lx-music-source/main/huanyin/latest.js) (`@name 幻音音源`, `@version v3`, `@author 竹佀`) is **plain, well-commented, readable JavaScript** — and it declares capabilities the platform cannot honour:

```js
on(EVENT_NAMES.request, ({ source, action, info }) => {
  if (action === 'musicUrl') { return getMusicUrl(source, info) }
  if (action === 'search' && source === 'mg') { return searchMiguMusic(info) }
  return Promise.reject(new Error('不支持'))
})
...
send(EVENT_NAMES.inited, {
  openDevTools: false,
  sources: {
    ...
    mg: {
      name: '咪咕音乐',
      type: 'music',
      actions: ['musicUrl', 'search'],
      qualitys: ['128k', '320k'],
      supportSearchSuggestions: false
    }
  }
})
```

**`'search'` is not a valid action.** The runtime's `supportActions` map allows only `musicUrl` for non-`local` sources (`local` additionally allows `lyric`/`pic`), and `inited` handling does `actions.filter(a => userSource.actions.includes(a))` [VERIFIED from `preload.js`]. So `'search'` is silently stripped and **the entire `searchMiguMusic`/`searchMigu` code path — roughly 70 lines of the file — is dead code that can never execute.** Likewise `supportSearchSuggestions` is not a recognised key and is discarded.

**[INFERENCE]** This is a distinct and instructive failure mode: the author of this source appears to have believed LX exposes a search hook, built a substantial feature against it, and shipped it. Nothing errors — the source initialises successfully and works for `musicUrl`. It only breaks *silently and partially*, which is far harder for a user to diagnose than an outright init failure. It also means the source advertises 咪咕 at only `['128k','320k']` while the other three platforms get `['128k','320k','flac','flac24bit']` — an asymmetry the user sees in the quality dropdown with no explanation.

The file also illustrates the relay fragility of §3.5-A concretely: `getMusicUrl` returns a **bare third-party URL** rather than fetching anything —

```js
return `https://music-dl.sayqz.com/api/?source=${platform}&id=${songId}&type=url&br=${br}`
```

— and the 咪咕 path chains through a *different* third-party API, `https://api.xcvts.cn/api/music/migu?gm=...`, with a **3-second timeout** and a **3-attempt keyword-matching fallback** (name+album → name+singer → name only), caching results in a `Map` [VERIFIED]. So a single playback request for 咪咕 can depend on two unrelated volunteer-run hosts, and the source's own comments (`'服务器异常'`, `'超时'`, `'网络问题'`) enumerate the ways it fails. Note also that the third-party host is handed the **song ID and platform**, and returns a URL that LX then plays directly — the user's IP and the song identity both leave the machine to a host neither the LX author nor the user controls.

**Failure mode I — obfuscation makes community repair impossible.** [`sixyin/latest.js`](https://raw.githubusercontent.com/pdone/lx-music-source/main/sixyin/latest.js) is **333,015 bytes** (`1.2.1.js`, sha `aa1345bdc9863e397012ff6ff70e406aff617eb3`; the earlier `1.2.0.js` was 372,394 bytes) of `javascript-obfuscator`-style output: a rotating string-array decoder (`_0x234f`, `_0x1fb3`) with hex-escaped string literals, control-flow flattening, dead-branch injection, and **BigInt literals (`0x1fn`, `-0x8000000000000000n`)**. Its header is the only readable part:

```js
/*!
 * @name 六音音源
 * @description v1.2.1 如失效请前往 www.sixyin.com 下载最新版本
 * @version v1.2.1
 * @author 六音
 * @homepage www.sixyin.com
 * @netease MUSIC_U=;
 * @tencent ts_last=y.qq.com/n/ryqq/album;
 * @preserve
 */
```

Note `@netease MUSIC_U=;` and `@tencent ts_last=y.qq.com/n/ryqq/album;` — **custom header fields the author added**, which LX's `INFO_NAMES` whitelist simply ignores (only name/description/author/homepage/version are recognised). They appear to be cookie/header hints for the relay. Also note the author's own instruction embedded in `@description`: *"如失效请前往 www.sixyin.com 下载最新版本"* — i.e. the author explicitly anticipates breakage and points users off-GitHub.

**[INFERENCE]** Because 六音 is obfuscated, when it breaks, nobody in the community can patch it — the only remedy is to wait for the author to publish a new obfuscated blob. This is the structural reason the ecosystem has *many* sources rather than *one maintained* source: obfuscation trades repairability for protection of the operator's relay, and the community compensates by keeping a stable of alternatives.

**Obfuscation is a spectrum, and it is anti-correlated with readability rather than with popularity.** Measured across the ten scripts [VERIFIED — from the downloaded files]:

| Script | bytes | lines | `_0x` idents | style |
|---|---|---|---|---|
| sixyin | 332,677 | **12** | **16,316** | javascript-obfuscator: string-array + control-flow flattening |
| lx (独家音源) | 58,760 | 14 | 0 | custom homoglyph (Arabic/PUA) identifiers + `SERVER_SCRIPT_CONFIG` |
| changqing | 27,553 | 10 | 0 | custom inline numeric-XOR string decoders |
| flower / grass | ~10k | **6** | 0 | obfuscator.io-style (`\x` escapes, hex arithmetic) |
| qdy | 28,834 | 831 | 0 | **readable source, with comments** |
| huanyin / huibq / ikun / juhe | 1–7k | 90–310 | 0 | **fully readable source** |

**六音 is simultaneously the most-copied source in the ecosystem** (present in `pdone`, `xzh767`, `skxingyu`, and `guoyue2010`) **and the most heavily obfuscated** — 332 KB collapsed into 12 lines. **[INFERENCE]** Popularity does not drive obfuscation; *the presence of a relay worth protecting* does. The readable sources (huibq, juhe, huanyin, ikun) are readable precisely because their intelligence lives on a server they control — obfuscating the client would protect nothing. Conversely the readable ones are trivially patchable, which is why they die and revive constantly.

**De-obfuscation is itself an explicit, credited community activity.** `xzh767/lxmusic-source-all` ships both obfuscated and `(decrypt)` variants side by side (e.g. `聚合API接口(decrypt).js` vs `聚合API接口2.0.js`) and its README states *"2025.3.1解密了一些音源"* [VERIFIED]. And `qdy/latest.js` credits its own supply chain in its header — `@author 全豆要 and Gemini优化 Toskysun去混淆 TZB679兼容性处理`, `@contribution DeepSeek优化` [VERIFIED]. **[INFERENCE]** So obfuscation is a *speed bump protecting a monetisation window*, not a secret: it reliably delays community repair just long enough to matter, while being defeated by volunteers anyway. It is the worst of both worlds — enough friction to break the ecosystem's self-repair property, not enough to actually protect anything.

### 3.5b Consolidated inventory of source names found in the wild [VERIFIED]

Every row below was read from the actual file (header block and/or body) at the stated URL. **Naming note:** the community name and the aggregator folder name often differ, and several are near-homophones — worth pinning down:

| Community name | Literal | Aggregator folder | `@name` in the file | `@version` | `@author` | Form | Fronts |
|---|---|---|---|---|---|---|---|
| **六音** | "six tones" | `sixyin/` | `六音音源` | `v1.2.1` | `六音` | **Obfuscated**, 333,015 B | Relay at `www.sixyin.com` |
| **野草** | "wild grass" | `grass/` | `野草🌾` | `1` | — | **Obfuscated** | Relay, `sources` pushed from server |
| **野花** | "wildflower" | `flower/` | `野花🌷` | `1` | — | **Obfuscated** | Relay, `sources` pushed from server |
| **Huibq / 汇比奇** | — | `huibq/` | `Huibq_lxmusic源` | `v1.2.0` | `Huibq` | **Plain JS**, ~60 lines | `https://lxmusicapi.onrender.com` |
| **聚合 / 聚合API** | "aggregate" | `juhe/` | `聚合API接口 (CF)` | `3` | `lerd` | **Plain JS**, ~20 lines | `https://api.music.lerd.dpdns.org` (Cloudflare) |
| **独家音源** (labelled "LX"/"洛雪官方源" by the aggregator) | "exclusive" | `lx/` | `独家音源` | `6` | `w` | **Extreme obfuscation**, homoglyph identifiers | `88.lxmusic.中国` + `signSalt`, WeChat brand "洛雪科技" |
| **ikun** | — | `ikun/` | `ikun音源` | `v22` | `ikunshare` | **Plain JS** | `https://api.ikunshare.com` — **key-gated** |
| **长青 / ChangQing** | "evergreen" | `changqing/` | `长青SVIP音源` | `1.3.0` | `SVIP` | **Obfuscated** (inline arithmetic decoders) | `http://yinyue.haitangw.net/…` — **plain HTTP** |
| **幻音 / HuanYin** | "phantom sound" | `huanyin/` | — | — | 竹佀 | — | Relay (not inspected) |
| **QDY** | — | `qdy/` | — | — | — | — | Relay (not inspected) |
| **聆澜音源** | — | *(not in pdone)* | — | — | 时迁酱 & guoyue2010 | **Card-key gated** | `source.shiqianjiang.cn`, `lc.guoyue2010.top`, `lx.xiagua.top` |
| **IKUN 音源** (paid) | — | — | — | — | ikunshare | **Card-key gated** | `shop.ikunshare.com`, `publish.ikun0014.top` |

**Two findings from these files that are worth calling out specifically:**

**(i) `ikun` declares quality tiers that LX silently discards, and has a source-key typo.** Its quality map is:

```js
const API_KEY = ""
const SCRIPT_MD5 = "74a88a1d1ae53cf3cb2889e70aed3d6e";
const MUSIC_QUALITY = JSON.parse('{"kw":["128k","320k","flac","flac24bit","hires"],"wy":["128k","320k","flac","flac24bit","hires","atmos","master"],"git":["128k","320k","flac"]}');
```

Three separate problems, all of which LX handles by *silent filtering* rather than erroring (§2.8):
- `hires`, `atmos`, and `master` are **not** in LX's whitelist (`['128k','320k','flac','flac24bit']`), so `qualitys.filter(...)` drops them. The source advertises hi-res/Atmos/master audio that the app can never request.
- **`"git"` is a typo for `"kg"`** — `git` is not in `allSources`, so that entire entry is skipped and the source offers no KuGou at all.
- `API_KEY = ""` in the public copy; the paid build injects the user's key. The error handling proves the gating: `case 403: throw new Error("Key失效/鉴权失败")` ("key expired / auth failed") and `case 429: throw new Error("请求过速")` [VERIFIED].

It also self-updates by sending its own MD5 to the vendor: `GET /script/lxmusic?key=${API_KEY}&checkUpdate=${SCRIPT_MD5}`, then raising `updateAlert` if the server reports a newer version [VERIFIED]. **[INFERENCE]** This is a clean, real example of the "key-gated source" failure class from §3.5-C — and of how a source can be simultaneously *broken* (no kg) and *advertising more than it can deliver* (hires/atmos/master) without the user seeing an error.

**(ii) `changqing` serves audio over plain HTTP.** Its entire URL layer is hardcoded to unencrypted endpoints:

```js
kg: { musicUrl(r, e) { return `http://yinyue.haitangw.net/kg/kg_song_kw.php?type=mp3&id=${n}&level=${e}` } },
tx: { musicUrl(r, e) { return `http://yinyue.haitangw.net/qq/qq_kw.php?type=mp3&id=${n}&level=${e}` } },
wy: { musicUrl(r, e) { return `http://yinyue.haitangw.net/wy/wy.php?type=mp3&id=${n}&level=${e}` } },
kw: { musicUrl(r, e) { return `http://yinyue.haitangw.net/kw/kw.php?type=mp3&id=${n}&level=${e}` } },
mg: { musicUrl(r, e) { return `http://yinyue.haitangw.net/mg/migu.php?type=mp3&id=${n}&level=${e}` } },
```

LX's validation is `!/^https?:/.test(response)` — which **`http:` passes** [VERIFIED from `preload.js`]. So a source can hand the player a plaintext, unauthenticated, third-party-hosted audio URL and the app will accept and play it. Its header also carries `@mail`/`@homepage` both set to a WeChat public account (`微信公众号: 元力菌`) and an `@update_url` of `https://13413.kstore.vip/lxmusic/changqing.json` [VERIFIED] — another WeChat-branded distribution channel, reinforcing §4.4's point that the author has no official WeChat presence. **[INFERENCE]** This is the most concrete security argument for why the app's own `user_api__note` malware warning exists: the source contract permits arbitrary plaintext HTTP endpoints and arbitrary remote update URLs, and the client cannot distinguish a legitimate relay from a hostile one.

**On the transliteration in the task brief:** "六音 (liuyin)" is slightly off — 六 is *liù* ("six"), so it is **sixyin**, which is also the author's own domain (`sixyin.com`) and the aggregator's folder name. There is no "liuyin" source; if a search turns one up it is likely confusion with 六音 or with an unrelated project.

**On "花 (flower/pdone)":** the file is named **野花🌷** ("wildflower"), not 花. The aggregator folder is `flower/`. pdone is the *aggregator repo owner*, not the source author — the flower/grass scripts carry no `@author`. This is worth stating because "pdone's flower source" is a common conflation.

**On 聚合音源 ("aggregated source"):** this is a genuine and distinct *category*, not one named product — it means a source that advertises **multiple platform keys at once** (kw/kg/tx/wy/mg) behind one relay, so the user imports once and gets all platforms. `juhe/` is the canonical example, and `huibq`/`sixyin` are also aggregated in that sense (huibq declares all five keys; sixyin declares per-platform quality maps). **[INFERENCE]** The category exists because it is strictly more convenient than five separate sources, and because a single operator can amortize one relay's infrastructure across all platforms.

**On the official-source question:** see §3.6 — the folder named `lx/` is **not** official despite the aggregator's `AGENTS.md` calling it "洛雪官方源".

### 3.6 The "official source" question — resolving a naming trap

Three different things get called "官方源" in the wild, and they are not the same:

1. **The built-in sources that were removed.** These are what the FAQ refers to. They are *gone* — the config file is now literally empty:
   ```ts
   // src/main/modules/userApi/config/index.ts
   export const userApis: LX.UserApi.UserApiInfoFull[] = []
   ```
   [VERIFIED — this is the entire file.] This is the cleanest possible proof that desktop v2.6.0 removed every bundled source, and it is a nice artifact: the file, the type, and the default-import plumbing all still exist, holding an empty array.

2. **`lyswhut/lx-music-source` — a genuinely official, MIT-licensed source repo.** The upstream author *does* maintain a source implementation at [`github.com/lyswhut/lx-music-source`](https://github.com/lyswhut/lx-music-source) (400 stars, 71 forks, `license: MIT`, `package.json` `"version": "1.1.2"`, `"author": "lyswhut"`, last push 2024-06-12). Its README is two lines:
   > # lx-music-source
   > A lx-music source
   > based on `https://github.com/listen1/listen1_chrome_extension/tree/master/js/provider`
   > ## LICENSE
   > MIT

   The `LICENSE` file is `MIT License / Copyright (c) 2018 lyswhut`. It is a **webpack build harness** (`src/`, `dist/lx-music-source.js` at 18,644 bytes, `webpack.config.js`) that wraps the Listen1 Chrome-extension providers. **[INFERENCE]** This is a *development template / proof-of-concept*, not a maintained consumer source — it has not been pushed since 2024-06 and predates the v2.6.0 API break in its provider glue. It is best understood as "the official example of how to build a source," which is also why the AI-slop blog post's invented "`source-example.js`" is a garbled echo of something real.

3. **The `lx/` folder in community aggregators, labelled "洛雪官方源" — which is NOT official.** The pdone repo's own `AGENTS.md` describes its layout as:
   > - `lx/` - 洛雪官方源

   but the file it serves is the `@name 独家音源` / WeChat-brand "洛雪科技" script quoted in §3.5-B, with a `signSalt` and a punycode `.中国` API host. **[VERIFIED — I fetched both the AGENTS.md description and the script itself.]** So a community aggregator is labelling a third-party, server-gated, obfuscated, WeChat-branded source as "官方". **[INFERENCE]** This is almost certainly brand piggybacking on 洛雪's name — the same pattern the mobile changelog warns about for APKs (§4.4). **Do not trust the folder name `lx/` as evidence of official provenance.**

### 3.7 The 2024 project-pivot announcement — issue #1912

**[VERIFIED]** I retrieved the full issue body via the GitHub API. `lyswhut/lx-music-desktop` issue **#1912**, titled **`LX Music 项目发展调整与新项目计划`**, authored by **`lyswhut`** (`author_association: "OWNER"`), **created 2024-05-26T07:13:18Z**, **state: `open`**, **88 comments**, **887 reactions** (`+1: 550, heart: 170, hooray: 76, rocket: 60, eyes: 30`), last updated 2026-06-16. The body, verbatim in the load-bearing parts:

> 由于最初 LX 的开发线路是抱着对技术的学习与研究的目的，集成国内常用音乐平台以解决音乐查找与播放问题，但随着大家对音乐版权的重视，以及来自官方音乐平台的压力，这条路已难以走下去。
> 为了在不违反相关法律法规的情况下能随时愉快的听歌，我决定发起一个全新的项目，用于提供一套面向个人用户的个人私有云音乐解决方案。
> 之前用于维护 LX 的业余时间现在大部分已投入到该项目的设计与开发上，**LX 也将逐渐进入维护模式，没有特殊情况下预计不会有重大的改变。**

The four planned milestones are **桌面端 → 同步服务 → 移动端 → 歌曲管理服务**, and milestone 1's spec is the pivot's substance:

> - 软件本身只是一个可以播放本地歌曲的播放器，**没有第三方在线资源功能**
> - 全新的扩展功能，预计提供一组包括扩展数据存储、通知、上下文菜单扩展等的API（参考 vs code 扩展API，只是预计，还在规划中）
> - 提供web端，web端与桌面端将共用一套UI层 …
>
> 注：扩展功能将允许扩展为软件提供接入在线资源的能力，之所以不内置在线服务功能而采用这种设计：
> > 希望在解耦各个服务的同时，允许对接多个 _自建_ 的或如 WebDAV 等 _其他来源_ 的歌曲存储服务。

**Key structural point [INFERENCE]:** the new project does **not** abolish the pluggable-source idea — it *re-affirms* it, but re-points it from "third-party streaming platforms" to "your own storage (WebDAV / self-hosted)." The author is keeping the architecture and changing the data source. Milestone 4 ("歌曲管理服务 … 提供类似常用音乐平台的歌曲搜索、排行榜、歌单、歌曲链接等API服务[理想]") is where online capability would eventually live — **self-hosted**, which is the legally-defensible version of what community sources do.

The issue was **updated 2025-05-11** with:

> 新的项目已发布： https://github.com/any-listen/any-listen
> 初版只对某些人有用，不适合现在的LX用户，但会继续完善。
> 目前计划优先开发自建服务的能力 … 简单来说，现在的LX去掉所有在线功能，只有我的列表及播放器功能

**[VERIFIED]** `any-listen/any-listen` exists: created 2025-01-26, `A cross-platform private music playback service`, TypeScript, 3,707 stars, 164 forks, `license: "Other"/NOASSERTION`, actively pushed (2026-09-16).

**[VERIFIED — how the pivot propagated into releases]** Both changelogs cite #1912 directly, and the release notes now push users to migrate:

- Desktop v2.8.0 (2024-06-01) opens with *"我们发布了关于 LX Music 项目发展调整与新项目计划的说明，详情看： https://github.com/lyswhut/lx-music-desktop/issues/1912"*.
- Mobile v1.4.0, v1.4.1, v1.4.2 (all 2024-06-01) and v1.5.0 (2024-08-03) carry the identical banner.
- Desktop v2.10.0 (2025-01-27) announces Any Listen's first web preview.
- The **current** desktop README carries a `[!NOTE]` block: *"目前新项目 [Any Listen] 的桌面版、Web 版已实现 LX Music 的大部分功能 … 我们以后的开发精力将主要集中在新项目上"*.
- The **v2.12.5 release body** (2026-09-13) states: *"以后的开发精力将主要集中在新项目上 … 对于日常使用 LX Music 的人可以试试迁移到 Any Listen"*.

**[INFERENCE]** So the accurate framing is: **LX Music is in maintenance mode but not dead.** It still receives compatibility patches (v2.12.5 fixed a tx search regression, an MP3 tag-embed bug, and a theme-editor bug), but the author's intent is for it to become a local-files-only player over time, with online capability moving to Any Listen's extension API. There is even an official bridge: [`any-listen/any-listen-extension-lx-api-source-loader`](https://github.com/any-listen/any-listen-extension-lx-api-source-loader) — *"Music source loader"*, Apache-2.0, created 2026-05-15 [VERIFIED] — i.e. an Any Listen extension that loads **LX-format sources**, which is strong evidence the LX source format is intended to survive the migration.

---

## 4. Legal / takedown context

### 4.1 The official license — Apache-2.0 plus a supplementary agreement [VERIFIED]

Both projects ship **Apache License 2.0** *plus* an explicit supplementary agreement that overrides it on conflict. From `https://lxmusic.toside.cn/desktop/license` (and the identical `/mobile/license`, and the READMEs):

> 本项目基于 Apache License 2.0 许可证发行，以下协议是对于 Apache License 2.0 的补充，如有冲突，以以下协议为准。

The clauses that matter, quoted verbatim:

> **1.2** 本项目本身没有获取某个音频数据的能力，本项目使用的在线音频数据来源来自软件设置内"音乐来源"设置所选择的"源"返回的在线链接。例如播放某首歌，本项目所做的只是将希望播放的歌曲名字、歌手名字等信息传递给"源"，若"源"返回了一个链接，则本项目将认为这就是该歌曲的音频数据而进行使用，至于这是不是正确的音频数据本项目无法校验其准确性 …

> **2.1** 使用本项目的过程中可能会产生版权数据。对于这些版权数据，本项目不拥有它们的所有权。为了避免侵权，使用者务必在 **24 小时内** 清除使用本项目的过程中所产生的版权数据。

> **3.1** 本项目内的官方音乐平台别名为本项目内对官方音乐平台的一个称呼，不包含恶意。如果官方音乐平台觉得不妥，可联系本项目更改或移除。

> **6.1** 本项目完全免费，且开源发布于 GitHub 面向全世界人用作对技术的学习交流。本项目不对项目内的技术可能存在违反当地法律法规的行为作保证。

> **6.2 禁止在违反当地法律法规的情况下使用本项目。** 对于使用者在明知或不知当地法律法规不允许的情况下使用本项目所造成的任何违法违规行为由使用者承担 …

> **7.1** 音乐平台不易，请尊重版权，支持正版。

> **8.1** 本项目仅用于对技术可行性的探索及研究，**不接受任何商业（包括但不限于广告等）合作及捐赠。**

> **9.1** 若你使用了本项目，即代表你接受本协议。

**On the "no donations / no commercial use" question — 8.1 is the answer, and it is explicit and unusually strong.** It refuses **both** commercial cooperation **and** donations. Note this is the *opposite* of the community norm: the aggregator `lx-ikun-music-sources` openly solicits donations and runs a "广告位招租" (advertising space for rent) section, and multiple paid source services operate around the ecosystem (§3.5-C) [VERIFIED]. So there is a clean, verifiable divergence between the upstream author's stance and the surrounding commercial ecosystem.

Clause **1.2** is the architectural-legal keystone and it is *accurate to the code*: §2.5 confirmed from source that `musicUrl` must return a URL string and the app never proxies bytes. Clause **2.1**'s 24-hour rule is mirrored almost verbatim by downstream projects — `MeoProject/lx-music-api-server`'s supplementary agreement says *"使用者务必在**24 小时**内清除使用本项目的过程中所产生的版权数据"* and copies clauses 6.1/6.2 and 8.1 nearly word-for-word [VERIFIED]. **[INFERENCE]** This license text has become a de-facto community boilerplate for the whole 音源 ecosystem.

The license also carries a contact line: *"若对此有疑问请 mail to: lyswhut+qq.com (请将 `+` 替换为 `@`)"*.

### 4.2 The takedown that definitely happened: the Tencent warning letter

**This is the single most important legal artifact in the whole ecosystem, and it is the author's own words.** GitHub issue **#1643**, titled **`LX 以后的发展方向`**, opened by **`lyswhut`** himself (`author_association: "OWNER"`) on **2023-10-22**, **state: open**, **222 comments**, **775 reactions** (`+1: 530, heart: 187, confused: 20, rocket: 22, eyes: 16`). Retrieved via the GitHub API. Body, verbatim:

> 虽然我们之前做了一些努力（如锁定音质为128k、非推荐的默认设置等），但这一天终究还是到来，
> **LX于2023年10月18日收到了腾讯的警告信，要求停止提供软件内置的连接到他们平台的在线播放及下载服务，所以我们决定关停内置的"临时接口"与"测试接口"。**
>
> 目前LX没有计划停更，但现有版本将只修复bug，暂停开发新功能。
> 目前仍然在考虑以后的发展方向，为了使LX成为一个符合中国法律法规的项目，**已经确定的是以后不会有原来那种自带开箱即用的聚合各平台的功能。**
>
> ~~以下是初步想法（仅针对PC端，移动端仍然是"能用就行"的态度）：~~
> - ~~项目的本体将只是一个本地播放器~~
> - ~~继续完善同步服务端，客户端可以从服务端加载音乐播放~~
> - ~~由于项目的发展方向已经改变，整个软件的UI将重新设计，代码将重构（可能会考虑提供web版的部署，适合在临时使用的电脑上使用）~~
> - ~~其他源的扩展能力，可能类似 [youtube-dl](https://github.com/ytdl-org/youtube-dl)~~
>
> **更新：** 发展方向看：https://github.com/lyswhut/lx-music-desktop/issues/1912
> 移动端 v1.2.0 起新增了自定义源的功能（实验性）
> 最后，谢谢大家对LX的支持与陪伴 :)

Several things here are load-bearing and **verified**:

1. **"警告信" (warning letter), not a lawsuit and not a DMCA notice.** The author's own characterization is a warning letter demanding cessation.
2. **The letter is dated 2023-10-18** — matching the FAQ and both CHANGELOGs exactly.
3. **The immediate action was shutting down the built-in "临时接口" and "测试接口"** (the legacy fallback interfaces still present in `zh-lang` keys `setting__basic_source_temp` / `setting__basic_source_test`), with the full source removal landing in v2.6.0/v1.2.0.
4. **The author's word is 警告信 (warning letter).** The official CHANGELOG and FAQ instead say **腾讯投诉 (complaint)**. A 蓝点网 (landiannews) headline reportedly described it as **律师函 (lawyer's letter)**, but **I could not fetch that article** — both `landiannews.com` and a 360doc mirror failed to resolve from this environment — so **[UNVERIFIED]** whether a lawyer's letter was actually received, or whether that headline loosely paraphrased the warning letter. The three terms are legally distinct (a platform complaint, an internal warning letter, and a lawyer's letter carry different weight), so this is worth flagging rather than eliding.
4. **"为了使LX成为一个符合中国法律法规的项目"** — the stated motivation is *legal compliance*, which frames the entire subsequent architecture (pluggable sources + empty built-in config) as a compliance measure, not a feature.
5. **The author had already been pre-emptively degrading the experience**: *"锁定音质为128k、非推荐的默认设置"* — i.e. quality was deliberately capped at 128k and defaults made unfriendly *before* the letter, as risk mitigation. This is why `zh-cn.json` contains `setting__basic_source_temp: "临时接口（软件的某些功能不可用，建议测试接口不可用再使用本接口）"` and why the desktop README says *"为了提高使用门槛，本软件内的默认设置、UI 操作不以新手友好为目标"* [VERIFIED].
6. **The custom-source feature was the author's direct response to the letter.** The comment `1793619498` (2023-11-05) announces: *"花了几天时间研究了一下，移动端 v1.2.0-beta 新增了自定义源的功能（实验性），低版本系统兼容性未测试 … **注意，这个功能目前仍然处于测试阶段，请勿到处宣传！**"* [VERIFIED]. And in the same comment he answers a feature request with the strategic logic: *"如果移除所有内置源，由用户自行添加的话，那将不再仅限于现在固定的几个源"* [VERIFIED].

**[INFERENCE]** Read together, #1643 and the empty `config/index.ts` tell a coherent story: the pluggable-source architecture is a **liability firewall**. The app ships with zero sources, the user supplies the script, and the license agreement (clause 1.2) states the app merely forwards a name to "the source" and plays whatever URL comes back. The author's own comment about removing built-in sources broadening what's possible ("不再仅限于现在固定的几个源") shows he understood the architectural consequence at the time.

**Community reaction in the thread** [VERIFIED — sampled from the 222 comments]: overwhelmingly supportive and resigned, with a recurring theme of *"感谢作者多年的陪伴"*. Notable substantive comments:
- A user predicting the design that actually shipped: *"感觉洛雪以后的发展发向很像 阅读 这个开源软件，本体都是本地客户端，需要的 网络源 都有第三方开发，也许这样能规避一些法律政策吧。"* — the 阅读 (Legado) analogy is the right one.
- Another proposing the TVBox model: *"推荐tvbox的模式，将音源开放为配置，让用户自己添加。"*
- A security-minded comment that reads as prescient given §3.5: *"README页尾看到作者使用的是QQ邮箱`lyswhut@qq.com`就知道作者会被腾讯开盒 … 开发这种软件就得**保持匿名** … 不要开捐赠渠道"* (15 upvotes).
- A monetization proposal (*"得付一定的费用才能使用"*) drew the sharp reply *"谢谢你啊，直接升级为非法牟利罪"* ("congratulations, you've just upgraded this to the crime of illegal profit-making") — which is the community's own articulation of why clause 8.1's no-donations rule exists. [INFERENCE] Charging money would convert a civil copyright dispute into potential criminal liability under Chinese law; the author's refusal of donations is a legal shield, not just modesty.

Covered in full in §3.2. Summary of what is **verified**: the official FAQ, both CHANGELOGs, **and the author's own pinned-style issue #1643** state that a **腾讯警告信 (Tencent warning letter)** dated **2023-10-18** forced the shutdown of built-in sources in desktop **v2.6.0** and mobile **v1.2.0** (both released 2024-02-01). A user-published reproduction of a complaint letter exists in issue **#1641**; its text is **[UNVERIFIED]** as a document but consistent with the official statements.

### 4.3 DMCA claims — what I could and could not verify

**[UNVERIFIED — and I believe likely false.]** A cnblogs article, [`开源音乐播放器洛雪（lx-music）架构分析：壳与音源的插件化设计`](https://www.cnblogs.com/pcdoctor/p/21484842), asserts:

> 2023 年经历过 DMCA 下架风波，但项目目前仍在活跃维护。
> 这也是为什么 2023 年 GitHub DMCA 下架后项目能恢复：下架理由是「facilitating copyright infringement」，但洛雪本身不含侵权代码，作者申诉后仓库恢复。

**I could not find any primary evidence of a DMCA takedown of either repository.** Specifically:
- Both repos are **live, public, and not disabled** (`"disabled": false`, `"archived": false` in the GitHub API) [VERIFIED].
- There is **no DMCA notice, no takedown note, and no "repository was reinstated" message** in either README, either CHANGELOG, the FAQ, or issues #1643 / #1912 [VERIFIED].
- **A GitHub issue search across the whole repo for `DMCA` returns exactly one result — issue #1643 — and the string appears only in its comment thread, not in the author's statement.** The author's own word for what he received is **警告信 (warning letter)** from Tencent, never "DMCA" [VERIFIED via `search/issues?q=repo:lyswhut/lx-music-desktop+is:issue+DMCA`]. A second search scoped to comments (`"DMCA" in:comments`) returns the same single issue.
- The claim appears in an article that is **explicitly machine-generated** — it carries a visible AIGC badge (`AIGC标识`, `本文内容由AI生成`) and shills a download link (`lxmusic.ijinshan.com`).
- The same article **fabricates the entire source API contract**, inventing a CommonJS module interface that does not exist:
  > 音源实际上是一个符合特定接口约定的 CommonJS 模块。从源码来看，主程序通过 `require()` 动态加载音源文件 …
  > ```js
  > module.exports = {
  >   getSourceInfo() {...},
  >   async search(query, page, type) {...},
  >   async getMusicInfo(songmid) {...},
  >   async getLyric(songmid) {...},
  >   async getPlaylistInfo(listid) {...},
  >   async getHotSearch() {...},
  > };
  > ```

  **Every line of this is wrong.** There is no `require()`, no `module.exports`, no `search()`/`getMusicInfo()`/`getPlaylistInfo()`/`getHotSearch()` — the real contract is the event-based `globalThis.lx.on('request', ...)` shown in §2. It also invents a file path `src/renderer/store/modules/sourceList.js` (the real path is `src/main/modules/userApi/`) and invents a `source-example.js` file in the repo. Its claim that the desktop app uses `better-sqlite3` *is* correct, and its "壳与音源分离" thesis is directionally right — so it is a plausible-sounding document built on a fabricated core, which is the most dangerous kind of slop.
- **Given that this article demonstrably fabricates the API, the repo path, and a source file, its DMCA claim should not be trusted without independent corroboration. I found none.**

**Caveat / honest limit:** absence of evidence in the *current* README/CHANGELOG is not proof no takedown ever occurred — a reinstated repo would look normal afterwards, and I did not enumerate every one of the 222 comments in #1643 or the repo's full issue history. What I can state is: **the specific claim as written ("下架理由是 facilitating copyright infringement", "作者申诉后仓库恢复") is unsourced, appears only in AI-generated content, is not corroborated by any primary artifact I could fetch, and uses a term (DMCA) that the author himself never uses.** The *pressure* it gestures at is real and abundantly documented — but the documented pressure is a **Tencent 警告信**, not a DMCA notice. **[INFERENCE]** A DMCA notice is a US-law mechanism; a Chinese platform pressuring a Chinese developer would far more plausibly send a Chinese-law warning letter, which is exactly what the evidence shows.

### 4.4 Community understanding, and the fake-app problem [VERIFIED]

The mobile CHANGELOG for **v1.1.0 (2023-09-09)** contains the most explicit legal/trust statement in either repo:

> 目前本项目的原始发布地址只有 **GitHub** 及 **蓝奏网盘**（在设置-关于有说明），其他渠道均为第三方转载发布，可信度请自行鉴别。
> 本项目无微信公众号之类的官方账号，也未在小米、华为、vivo等应用商店发布应用，**商店内的"LX Music"、"洛雪音乐"相关的应用全部属于假冒应用，谨防被骗。**
> 本软件完全无广告且无引流（如需要加群、关注公众号之类才能使用或者升级）的行为，若你使用过程中遇到广告或者引流的信息，则表明你当前运行的软件是第三方修改版。
> 若在升级新版本时提示签名不一致，则表明你手机上的旧版本或者将要安装的新版本中有一方是第三方修改版。

This directly corroborates the §3.5-B concern about a "洛雪科技" WeChat brand: the author states there is **no official WeChat account**, and that any app requiring a group-join or public-account follow to work is a third-party modification.

Both READMEs repeat: *"目前本项目的原始发布地址只有 GitHub，其他渠道均为第三方转载发布，与本项目无关！"*

**On antivirus / supply chain** — the FAQ (`/desktop/faq/antivirus-software`) says, verbatim:

> 本人（lyswhut）只能保证我写的代码不包含任何恶意代码、收集用户信息的行为，并且软件代码已开源，请自行查阅。软件安装包由 GitHub Action 拉取源代码构建，构建日志详见：GitHub Actions。

and the older in-repo `FAQ.md` (still present in the desktop tree, now pointing at the docs site) expands:

> 尽管如此，但这不意味着软件是100%安全的，由于软件使用了第三方依赖，当这些依赖存在恶意行为时（供应链攻击），软件也将会受到牵连 …
> 从`v0.17.0`起，由于加入了音频输出设备切换功能，该功能调用了 `MediaDevices.enumerateDevices()`，可能导致安全软件提示洛雪要访问摄像头（目前发现卡巴斯基会提示），但实际上没有用到摄像头 …

**[INFERENCE]** This matters for the 音源 ecosystem specifically: the app's own malware warning (`user_api__note`, §2.9) plus the antivirus caveat mean a user importing an arbitrary community source is running unreviewed, usually obfuscated, third-party code inside a process that has network access and (on desktop) an Electron renderer. The 20-source limit and the `freezeObjectProperty` hardening on mobile are the author's mitigations; they are isolation, not sandboxing.

### 4.5 The legal posture of the community [COMMUNITY + INFERENCE]

- Aggregators universally paste the same disclaimer. `lx-ikun-music-sources`: *"本项目 … 仅供个人学习、研究及技术交流使用"*, *"尊重版权：本项目鼓励支持正版音乐。所有资源均标注来源，如有侵权，请联系删除"*, *"风险自担：本项目不提供任何稳定性或安全性担保，不对使用后果负责"* [VERIFIED].
- The paid-source section repeats *"音源仅限测试，请各位在24H内删除有关缓存"* — an echo of license clause 2.1 [VERIFIED].
- 52pojie's own footer (a mainstream Chinese reverse-engineering forum) carries a blanket *"仅限用于学习和研究目的；不得将上述内容用于商业或者非法用途 … 您必须在下载后的24个小时之内，从您的电脑中彻底删除上述内容"* [VERIFIED].
- `MeoProject/lx-music-api-server` (MIT, 843 stars) reproduces the LX supplementary agreement almost verbatim, including *"本项目仅用于对技术可行性的探索及研究，不接受任何商业（包括但不限于广告等）合作及捐赠"* and *"音乐平台不易，请尊重版权，支持正版"* [VERIFIED]. It also adds its own carve-out: *"使用此项目导致的**封号**等情况**与本项目无关**"* and *"本项目不接受私人定制"* [VERIFIED].

**[INFERENCE]** The community's shared understanding is unambiguous and consistently stated: **sources are legally gray, the risk sits with the user, and the software is a neutral tool.** The 24-hour clause and the "support genuine copies" line are near-universal ritual text. Nobody in this ecosystem claims the sources are lawful; they claim the *tool* is, and they push the liability to the person who imports the script and presses play. The paid-source market (§3.5-C) is the clearest evidence that a segment of the ecosystem has decided the gray area is monetizable — and the clearest point of friction with the upstream author's stated non-commercial position.

---

## 5. Source script licensing — the typical state

### 5.1 The spectrum, with verified examples

| Project | License | Evidence |
|---|---|---|
| `lyswhut/lx-music-source` (**official**) | **MIT** | `LICENSE` file: `MIT License / Copyright (c) 2018 lyswhut`; `package.json` `"license": "MIT"` [VERIFIED] |
| `pdone/lx-music-source` (**the big aggregator, 8,844★**) | **NONE** | GitHub API `"license": null`; `LICENSE` fetch returns **HTTP 404** [VERIFIED] |
| `Huibq/keep-alive` (7,414★ — the upstream behind the `huibq` source) | **NONE** | GitHub API `"license": null` [VERIFIED] |
| `Macrohard0001/lx-ikun-music-sources` (2,438★) | **"Other"/NOASSERTION** — a bespoke 《巨硬简易许可证》 | GitHub API `"license": {"key":"other","spdx_id":"NOASSERTION"}`; README describes non-commercial/no-resale terms but **links to a `LICENSE.md` that returns HTTP 404** [VERIFIED] |
| `guoyue2010/lxmusic-` (5,765★, the tiered aggregator) | **Apache-2.0** | GitHub API `"license": {"spdx_id":"Apache-2.0"}` [VERIFIED] |
| `xzh767/lxmusic-source-all` (440★, ships `(decrypt)` variants) | **MIT** | [VERIFIED] |
| `laosunmaker/New_lxmusic_source` (333★, 六音音源修复版) | **Apache-2.0** | GitHub API `"license": {"spdx_id":"Apache-2.0"}` [VERIFIED] |
| `skxingyu/lx_music-` (95★, zip bundles) | **NONE** | GitHub API `"license": null` [VERIFIED] |
| `LuoXiaohei-2025/LX-music-collection` | **NONE** | GitHub API `"license": null`; repo is `"archived": true` [VERIFIED] |
| `MeoProject/lx-music-api-server` (843★) | **MIT** + supplementary agreement | GitHub API `"license": {"spdx_id":"MIT"}`; README states MIT plus the LX-derived clauses [VERIFIED] |
| `ZxwyWebSite/lx-source` (700★) | **MIT** | GitHub API `"license": {"spdx_id":"MIT"}`; repo is **`"archived": true`**, last push 2024-06-22 [VERIFIED] |
| The **individual scripts** (sixyin, huibq, flower, grass, juhe, lx, changqing, huanyin, ikun, qdy) | **no license of any kind** | The only header is the LX-mandated `@name/@description/@version/@author/@homepage` block. I inspected the actual file contents of all ten — none carries a license identifier, SPDX tag, or license text [VERIFIED] |

**[INFERENCE] The licensing pattern is best described as: *the container is licensed, the payload is not.*** `pdone` and `guoyue2010` publish permissively-licensed (or unlicensed) *repositories* whose contents are other people's obfuscated scripts carrying no grant from their original authors. `guoyue2010`'s Apache-2.0 nominally covers 317 files it did not write. Meanwhile the most-copied individual source, 六音, has no license at all — so the ecosystem's de-facto most-important artifact is the one with the weakest legal footing.

The **《巨硬简易许可证》** is the notable exception: a bespoke licence written specifically *for* a source-sharing repo rather than borrowed from a software template. Its terms:

> 本项目受 **《巨硬简易许可证》** 约束，**严禁**在未获得作者明确授权的情况下进行任何形式的**商业使用**或**盗搬**，包括但不限于：
> - ❌ **未经授权转载**、发布至可能获得收益的平台（如网赚网盘）。
> - ❌ **任何形式的售卖、集成至商业产品、或用于提供收费服务**。
> - ✅ 个人学习、非商业交流时，请**务必注明出处**。

[VERIFIED] Note the internal tension: this same repo **sells** card-key sources (§3.5-C) while forbidding others from doing so. **[INFERENCE]** Apache-2.0 on a source aggregator is arguably incoherent for the same reason — it grants commercial rights while the repo's own README forbids resale of the card-keys inside.

### 5.2 What the aggregator itself says about its contents [VERIFIED]

The `AGENTS.md` in `pdone/lx-music-source` — a file written to instruct AI coding agents working on the repo — is unusually candid:

> ## 注意事项
> - JS 文件通常是混淆或压缩后的代码，无需手动编辑
> - 如需更新源，请从上游项目获取最新版本
> - 保持各源目录结构一致

and

> - 文件头部必须包含注释块，包含：
>   - `@name` - 音源名称
>   - `@description` - 描述和版本信息
>   - `@version` - 版本号
>   - `@author` - 作者
>   - `@homepage` - 主页（可选）
>   - `@repository` - 仓库地址（可选）
>   - `@netease` / `@tencent` - 平台标识（可选）
>
> - `@preserve` 标记表示保留注释，防止被压缩工具移除

Note it documents `@repository`, `@netease`, `@tencent` as optional header fields — **none of which LX recognises** (LX's `INFO_NAMES` whitelist is name/description/author/homepage/version only, §2.2). They are purely author-side metadata for the aggregator and for minifier comment preservation. [VERIFIED against `utils.ts`]

### 5.3 The typical state, summarized

**[INFERENCE, from the verified table above]**

1. **The overwhelming majority of source *scripts* carry no license at all.** They carry only the LX-required header block. Legally, no license means all rights reserved by default — the scripts are *not* open source in any meaningful sense, even when their bytes are publicly readable on GitHub.
2. **Obfuscation is the norm, not the exception, for the sources that actually work.** Of the ten scripts in the main aggregator, the ones that front a real relay (sixyin, flower, grass, lx, and by size/pattern the rest) are minified/obfuscated; only the trivial ones (huibq, juhe) are readable — and those are readable precisely *because* they contain no secret, since the intelligence lives on the operator's server.
3. **The "open" part of the ecosystem is the *harness*, not the *source*.** Repos like `pdone/lx-music-source` are open *distribution* (a list of URLs, a `CreateLatest.py` that copies versioned files to `latest.js`, an `AGENTS.md`), while the payloads they distribute are closed blobs. So a repo can be fully public and still contain nothing anyone can audit or fork meaningfully.
4. **Where licenses *do* exist, they are on infrastructure and templates, not on working consumer sources** — the official MIT template (`lyswhut/lx-music-source`), the MIT server implementation (`MeoProject/lx-music-api-server`), the MIT (now archived) Go source (`ZxwyWebSite/lx-source`).
5. **Licensing is being replaced by commercial terms.** The newest, most actively-promoted sources are card-key-gated paid services with explicit anti-redistribution rules (*"所有付费音源禁止二次转发卡密，加价倒卖"*) rather than open licenses. [VERIFIED from the ikun README]
6. **A dead `LICENSE.md` link is itself a data point:** `lx-ikun-music-sources` tells users *"详细条款请务必阅读：LICENSE.md"* and that file 404s, while GitHub classifies the repo's license as "Other". [VERIFIED] This is emblematic — even when a source project *intends* to state terms, the artifact is frequently missing or unmaintained.

---

## 6. Explicitly unverified / open items

1. **The verbatim complaint letter** in issue #1641 is a user-pasted reproduction. The *existence and effect* of a Tencent warning letter is verified from the author's own statement in issue #1643 plus the official FAQ and both CHANGELOGs; the *#1641 letter text* is not independently authenticated, and note the author's own term is 警告信 (warning letter) while the CHANGELOG/FAQ say 投诉 (complaint) and a 蓝点网 headline reportedly said 律师函 (lawyer's letter).
2. **No DMCA takedown of either repository could be verified.** A repo-wide GitHub issue search for `DMCA` returns only issue #1643, where it appears in user comments rather than in any official statement. The only *claim* of a DMCA takedown traces to an AI-generated article that demonstrably fabricates the source API contract, a source file, and a repo path (§4.3). I could not prove a negative — I did not read all 222 comments of #1643 nor the full issue history — but I found zero primary corroboration.
3. **The exact meaning of "洛雪音乐 1.6.0"** in the 六音-fix README. I refuted the AIGC blog's *mechanism* and established that desktop v1.6.0 (2021-01-10) predates the custom-source feature (desktop v1.8.0, 2021-03-07), so mobile v1.6.0 (2024-08-24) is the only chronologically coherent reading — but **no primary source states a version-to-breakage mapping**, and the fix-repo author's own addendum says the breakage resolved.
4. **Any specific 酷狗 `infSign` or 网易云 `weapi`/`eapi` change** causing a named source outage. I found no primary source asserting this. The *general* failure class is well evidenced by CHANGELOG entries about 接口失效 and 域名到期, and by the app's own vendored `infSign.min.js`, but the specific cryptographic claims circulating in community posts are **unverified**. This is the single largest gap between what the community believes and what I could evidence.
5. **The 20-source import cap** — I verified it from the app's own i18n (`user_api__max_tip`, §2.9), so this one is actually **confirmed**, not merely a forum claim.
6. **Whether 野草/野花 are alive right now.** Their relays could not be de-obfuscated to a probeable endpoint within budget, and I found no dated liveness report. Both are graded `较差` ("poor") by the `guoyue2010` tiering, which is indirect evidence of weakness, not proof of death.
7. **Whether `sixyin.com` is globally dead** — it failed to resolve from this sandbox, but that may be sandbox policy; pdone's mirrored payload is alive and the file itself is intact.
8. **The exact upstream provenance of the obfuscated relay sources is opaque.** I verified what `sixyin`, `flower`, `grass`, `juhe`, `lx`, and `changqing` *do*, but their relay servers are third-party and unaudited; I did not (and should not) execute them.
9. **`www.sixyin.com`, `www.lxmusic.cc`, `shop.guoyue2010.top`, `shop.ikunshare.com`, `landiannews.com` were not fetched** — the paid-source pricing, the 六音 homepage, and the 律师函 headline are reported as they appear in aggregator READMEs and search snippets, not independently confirmed from the vendors or the outlet.
10. **The `ikunshare/ikun-music-desktop` / `ikun-music-mobile` forks** are referenced by the aggregator README as third-party modified LX clients ("项目已复活") but were not inspected. Given the upstream author's explicit warning about third-party modified builds (§4.4), these warrant separate scrutiny before any use.
11. **`lx-music-mobile` has no working Gitee mirror.** The task brief's `mirrors/lx-music-mobile` returns 404; `mirrors/lx-music-desktop` exists but its CHANGELOG lags upstream. All mobile facts here come from GitHub API / jsdelivr / gh-proxy.
12. **`liuyunss/LX-source` and `guandaxia/lx-source`** appeared in search results but their READMEs returned HTTP 404 on the branches I tried; not inspected.
13. **Documentation drift worth noting:** the license *docs page* and the license *README* have diverged since the removal. `https://lxmusic.toside.cn/desktop/license` clause 1.2 still reads `软件设置内"音乐来源"设置所选择的"源"`, while the desktop README reads `软件设置内"自定义源"设置所选择的"源"` [VERIFIED — both fetched]. The README was updated post-removal; the docs page was not. [INFERENCE] Minor, but it means the *published licence text* still describes a "音乐来源" setting that no longer exists in the app — a small real inconsistency in a document whose clause 1.2 is the project's core legal argument.
