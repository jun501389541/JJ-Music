# LX Music Desktop — Architecture, Tech Stack, Licensing, and a Reimplementation Blueprint

**Research date:** 2026-09-16
**Primary subject:** [`lyswhut/lx-music-desktop`](https://github.com/lyswhut/lx-music-desktop) (洛雪音乐助手 桌面版), `master` @ version **2.12.5**
**Related:** [`lyswhut/lx-music-mobile`](https://github.com/lyswhut/lx-music-mobile) @ **1.9.0**, [`lyswhut/lx-music-doc`](https://lxmusic.toside.cn/), [`any-listen/any-listen`](https://github.com/any-listen/any-listen) (successor project)

---

## 0. Executive summary

| Question | Answer |
| --- | --- |
| **License of lx-music-desktop** | **Apache-2.0**, *plus* a Chinese supplementary agreement (补充协议) in the README that the author declares overrides Apache-2.0 on conflict. **Not MIT.** |
| **Can we copy code?** | Technically yes under Apache-2.0 (with attribution/notice/change-marking duties). **Practically: no, if the product is commercial or the team wants legal comfort** — the supplementary agreement forbids commercial use and restricts the project to "technical exploration and research". Recommendation: **clean-room reimplementation against the documented public interfaces.** |
| **Electron version** | `electron@42.11.3` (devDependency at `master` = v2.12.5). README badge text still says "Electron 30+"; `browserslist` is pinned to `Electron 22.3.0`. At the Gitee-mirror snapshot (v2.12.2) it was `40.9.2`. |
| **Vue version** | `vue@~3.3.13`, `vue-router@~4.5.1`. |
| **State management** | **Not Pinia, not Vuex.** Hand-rolled `ref`/`reactive`/`shallowRef` stores in `src/renderer/store/`. |
| **UI component library** | **None.** All components hand-written (`src/renderer/components/{base,common,layout,material}`), templates in **Pug**, styles in **Less**. Only third-party UI dep is `@simonwep/pickr` (color picker). |
| **Build tooling** | **Webpack 5** (4 separate configs), **electron-builder 26** for packaging, `electron-updater` for auto-update. **Not Vite.** |
| **TypeScript?** | Mixed: `.ts` for most logic (migrated in v2.0.0), `.js` for legacy music-SDK modules, `.vue` with `<script setup>` + Pug + Less. |
| **Renderer/main split** | **Main window runs with `nodeIntegration: true`, `contextIsolation: false`, `webSecurity: false`.** The renderer is a full Node process. Custom-source scripts get the *opposite*: a locked-down hidden window with `contextIsolation: true`, `nodeIntegration: false`. |
| **IPC design** | Thin typed wrappers over `ipcMain.handle`/`ipcMain.on` (`src/common/mainIpc.ts`) with a central namespaced name table (`src/common/ipcNames.ts`). |
| **Database** | **SQLite via `better-sqlite3`** in WAL mode — **not LevelDB, not JSON** (JSON was pre-v2.0.0). Located at `<userData>/LxDatas/lx.data.db`. |
| **Playback** | **HTML5 `<audio>` element** routed through a **Web Audio API graph** (analyser → 10-band peaking EQ → optional convolver reverb → panner → gain), plus an **AudioWorklet phase-vocoder** pitch shifter. |
| **Local music support** | **Exists but is minimal and manual.** No folder library, no watching, no incremental scan. Files are added one-dialog-at-a-time via a right-click menu. |
| **Download** | Custom chunked/resumable HTTP downloader in a Web Worker; writes ID3v2 (MP3) / Vorbis comments + PICTURE (FLAC) tags and optional `.lrc` sidecars. |

---

## 1. How this research was performed (and its limits)

`raw.githubusercontent.com`, `github.com`, `api.github.com`, `cdn.jsdelivr.net`, `unpkg.com` and `sourcegraph.com` are **not resolvable** from this environment — `web_fetch` returns `URL hostname ... resolves to a non-public IP address`, and direct HTTPS from PowerShell fails the TLS handshake. The DeepWiki pages render client-side and returned only a loading shell.

Everything below was obtained from these reachable routes:

- **`gh-proxy.com` prefix** — works for **both** raw files *and* the GitHub REST API:
  `https://gh-proxy.com/https://raw.githubusercontent.com/<owner>/<repo>/<ref>/<path>`
  `https://gh-proxy.com/https://api.github.com/repos/<owner>/<repo>`
  This is the highest-fidelity route and was used to verify the v2.12.5 facts below.
- **`fastly.jsdelivr.net`** — `https://fastly.jsdelivr.net/gh/<owner>/<repo>@<ref>/<path>` (the `fastly.` subdomain resolves even though `cdn.jsdelivr.net` does not).
- **Gitee mirror of the desktop repo** — full recursive git tree and raw file contents:
  `https://gitee.com/api/v5/repos/mirrors/lx-music-desktop/git/trees/master?recursive=1`
  `https://raw.giteeusercontent.com/mirrors/lx-music-desktop/raw/master/<path>`
  ⚠️ **This mirror lags upstream** (2.12.2 vs 2.12.5) and **no mobile mirror exists** — `mirrors/lx-music-mobile` returns `404 Not Found Project`.
- **Official documentation site** — <https://lxmusic.toside.cn/> (the Docusaurus site that `lyswhut.github.io/lx-music-doc` 301-redirects to; fetch the `toside.cn` host directly).
- **npm registry** — `https://registry.npmjs.org/...`
- **`web_search`** for community/ecosystem context.

**Version note:** because the Gitee mirror is pinned at 2.12.2, most source quotations in this document are from that revision. Where the `gh-proxy` route revealed drift at 2.12.5, it is called out explicitly (Electron version, `postinstall` script, dependency bumps). No architectural change was found between 2.12.2 and 2.12.5.

**Confidence marking used throughout:**
`[VERIFIED]` = read directly from a fetched source file or official doc page. `[REPORTED]` = widely-repeated community claim. `[INFERRED]` = my inference, explicitly flagged.

**Known gaps** (could not verify; a reimplementation team should check these themselves):
- The exact `CHANGELOG.md` text for v2.6.0–v2.12.x (the changelog is 111 KB and the fetch truncated).
- Sub-licenses of bundled third-party assets: `src/common/utils/musicMeta/flac-metadata/`, `src/renderer/plugins/player/pitch-shifter/phase-vocoder.js` (looks like a port of [olvb/phaze](https://github.com/olvb/phaze)), `src/common/utils/lyric-font-player/`, the font files, and the prebuilt `.node` binaries in `build-config/lib/`.
- Whether a `NOTICE` file exists at repo root. The root listing shows `.editorconfig, .eslintrc*, .github, .gitignore, .ncurc.js, .vscode, CHANGELOG.md, FAQ.md, LICENSE, README.md, build-config, doc, jsconfig.json, licenses, package-lock.json, package.json, postcss.config.js, publish, resources, src, tsconfig.json` — **no `NOTICE` file is present** `[VERIFIED]`.

---

## 2. Licensing — the single most important section

### 2.1 The actual license is Apache-2.0

`[VERIFIED]` `package.json` on `master`:

```json
"license": "Apache-2.0",
```

`[VERIFIED]` The `LICENSE` file is the **verbatim, unmodified Apache License, Version 2.0** text (11,357 bytes, SHA `261eeb9e9f8b2b4b0d119366dda99c6fd7d35c64`) — no copyright line filled into the appendix, no modification.

`[VERIFIED]` Independently corroborated via the GitHub REST API:

```json
"license": { "key": "apache-2.0", "name": "Apache License 2.0",
             "spdx_id": "Apache-2.0",
             "url": "https://api.github.com/licenses/apache-2.0" }
```

Repo stats at time of research: **53,662 stars, 7,010 forks, 1,266 open issues**, primary language TypeScript, `default_branch: master`, `archived: false`, `disabled: false` — i.e. **live, not taken down**.

> ⚠️ **Correction to a widespread claim.** Several third-party blog posts and AI-generated articles state that LX Music is MIT-licensed. For example [blog.gitcode.com/386267044135fa86490f6a5079cb424e.html](https://blog.gitcode.com/386267044135fa86490f6a5079cb424e.html) says "这款开源解决方案采用MIT许可协议". **This is wrong.** The repo license is Apache-2.0. Do not rely on secondary sources for this.

### 2.2 There is a supplementary agreement on top of Apache-2.0

`[VERIFIED]` The README's `## 项目协议` section states:

> 本项目基于 [Apache License 2.0](...) 许可证发行，**以下协议是对于 Apache License 2.0 的补充，如有冲突，以以下协议为准。**

The same text ships in the repo at `licenses/license_zh.txt` (and `licenses/license_en.txt`, `licenses/license.rtf` for the installer), and is reproduced on the docs site at <https://lxmusic.toside.cn/desktop/license>. Full text of the operative clauses:

**一、数据来源**
- 1.1 The project pulls online data from official platform public servers; the project is not responsible for the legality or accuracy of that data.
- 1.2 **"本项目本身没有获取某个音频数据的能力"** — the project has no ability to obtain audio data itself. Audio URLs come from the "源" (source) selected in settings. The app merely passes song name/artist to the source; if the source returns a link, the app treats it as the audio data and cannot validate it.
- 1.3 Non-official-platform data (e.g. "我的列表") comes from the user's local system or a sync service; the project is not responsible for its legality.

**二、版权数据**
- 2.1 Using the project may generate copyright data. The project does not own it. **"为了避免侵权，使用者务必在 24 小时内清除使用本项目的过程中所产生的版权数据。"** (Users must delete generated copyright data within 24 hours.)

**三、音乐平台别名** — platform aliases are neutral labels; platforms may request removal.

**四、资源使用** — bundled fonts/images may come from the internet; rights holders may request removal.

**五、免责声明 (Disclaimer)**
- 5.1 **All direct, indirect, special, incidental or consequential damages arising from use of, or inability to use, the project are the user's responsibility.**

**六、使用限制**
- 6.1 The project is completely free, open-sourced on GitHub **"面向全世界人用作对技术的学习交流"** (for the whole world to use for technical learning and exchange). It does not warrant that its technology complies with local law.
- 6.2 **"禁止在违反当地法律法规的情况下使用本项目。"** Prohibited to use in violation of local laws. All resulting illegal conduct is the user's responsibility.

**七、版权保护** — 7.1 Respect copyright; support legitimate purchases.

**八、非商业性质**
- 8.1 **"本项目仅用于对技术可行性的探索及研究，不接受任何商业（包括但不限于广告等）合作及捐赠。"**
  *The project is solely for exploration of technical feasibility and research; it accepts no commercial cooperation (including but not limited to advertising) or donations.*

**九、接受协议** — 9.1 Using the project means you accept this agreement.

`[VERIFIED]` The app enforces acceptance in the UI: `src/renderer/components/layout/PactModal.vue` and the setting `common.isAgreePact` (default `false` in `src/common/defaultSetting.ts`).

### 2.3 What this means concretely for a derivative product

| Action | Apache-2.0 alone | With the supplementary agreement |
| --- | --- | --- |
| Read the source to learn the architecture | ✅ | ✅ |
| Copy code into an internal, non-distributed prototype | ✅ | ⚠️ Ambiguous — "使用" (use) arguably covers it |
| Copy code into a **distributed open-source** non-commercial player | ✅ with attribution | ⚠️ Possibly OK (learning/exchange), but 8.1 is broad |
| Copy code into a **commercial or ad-supported** product | ✅ legally permitted by Apache-2.0 §2/§4 | ❌ **Explicitly forbidden by 8.1** |
| Ship a product that plays copyrighted audio without a license | — | ❌ 6.2 + general copyright law |
| Use the name "LX Music" / "洛雪" | ❌ Apache-2.0 §6 grants **no trademark rights** | ❌ Same |

**Legal reality check (plainly stated):**

1. Apache-2.0 §2 grants a *perpetual, worldwide, non-exclusive, no-charge, royalty-free, irrevocable* copyright license, and §4 lets you "provide additional or different license terms and conditions for use, reproduction, or distribution of Your modifications". A licensor unilaterally bolting a no-commercial-use restriction onto Apache-2.0 is **in tension with the grant** — a court might well hold the Apache-2.0 grant prevails. But **you would be betting the product on winning that argument**, and the author's stated intent is unambiguous.
2. The **safe, unambiguous path is a clean-room reimplementation**: read the public documentation and the observable interfaces, write your own code, copy nothing.
3. **The supplementary agreement's restrictions attach to the LX Music codebase.** A genuinely independent implementation that shares no code is not bound by LX Music's license at all — it is bound by *your* license and by copyright law regarding the music platforms.
4. **The real legal risk is not the LX license — it is the music.** The entire architecture is built around proxying third-party platform APIs and playing audio the app has no rights to. The author himself was forced to remove all built-in sources in 2023 after a warning letter from Tencent (§12.1). Any commercial product built on this pattern inherits that exposure regardless of which license its code carries.

### 2.3b Why §8.1 refuses *donations* too — the important read

`[VERIFIED]` §8.1 is unusually emphatic: it refuses **"任何商业（包括但不限于广告等）合作** ***及捐赠***" — both commercial cooperation **and donations**. That is the *opposite* of the surrounding ecosystem: the largest community aggregator (2,438★) openly solicits donations, runs 广告位招租 (ad-slot leasing) and affiliate links, and simultaneously sells card-key sources.

`[REPORTED]` In issue #1643, a user proposing paid access received the reply *"谢谢你啊，直接升级为非法牟利罪"* ("thanks, that upgrades you straight to the crime of illegal profit-making").

`[INFERENCE]` **The no-donations rule is a legal shield, not modesty.** Under Chinese law, distributing a tool that circumvents platform controls is one exposure; *profiting* from it is a materially different and more serious one (非法牟利 / 侵犯著作权罪). By refusing money in any form — including donations and ads — the author keeps the project on the "technical research" side of that line and denies any prosecution the easiest element to prove: commercial intent. **This is the single most instructive legal lesson in the whole codebase, and it applies directly to any product we build.** The corollary is uncomfortable but unavoidable: *any* monetisation of a streaming-source-based player moves it into a categorically riskier legal posture, independent of the software licence.

### 2.3c A documentation inconsistency worth knowing

`[VERIFIED]` The licence's clause 1.2 on the **docs site** still reads *"'音乐来源'设置"* while the **README** reads *"'自定义源'设置"*. The README was updated after the built-ins were removed; the docs page was not. Minor in itself — but clause 1.2 is the project's core legal argument ("本项目本身没有获取某个音频数据的能力"), so when citing it, **cite the README**, which is current and which matches the code.

### 2.4 License of the documentation site

`[VERIFIED]` Every page footer on <https://lxmusic.toside.cn/> reads:

> Copyright © 2026 lyswhut & Contributors. Website content licensed under [MIT](https://github.com/lyswhut/lx-music-doc/blob/master/LICENSE). Built with Docusaurus.

**This is important and useful.** The *documentation* — including the complete custom-source script specification, the open-API spec, and the Scheme URL spec — is **MIT**. You may freely copy the interface specifications (with attribution) into your own project. The *application code* is Apache-2.0 + supplementary terms. Those are two different artifacts with two different licenses.

### 2.5 License of lx-music-mobile

`[VERIFIED]` The docs page <https://lxmusic.toside.cn/mobile/license> carries the **identical Apache-2.0 + supplementary agreement**, with "本项目" redefined as the mobile project.

`[VERIFIED]` Confirmed in `package.json` on `master` (v**1.9.0**, `versionCode` 77):

```json
"name": "lx-music-mobile", "version": "1.9.0", "versionCode": 77,
"private": true, "license": "Apache-2.0",
"keywords": ["music-player", "react-native-app"]
```

**Stack (correcting a common assumption):** React Native **0.73.11** + React **18.2.0** + Redux — **not Expo**. There is no `expo` dependency anywhere; the project uses the bare React Native CLI (`react-native run-android --active-arch-only`, `gradlew.bat assembleRelease`), `react-native-navigation@7.39.2`, and forks several native modules under the `lyswhut` GitHub org (`react-native-track-player`, `react-native-file-system`, `react-native-local-media-metadata`, `react-native-background-timer`). **Android 5+ only** — the docs state *"目前没有计划支持 iOS 和 HarmonyOS NEXT"*; an `ios/` directory exists but is unsupported.

**Key architectural finding — the mobile source engine is QuickJS, not the RN runtime.** The native layer contains `userApi/QuickJS.java`, `JavaScriptThread.java`, `JsHandler.java` plus `assets/script/user-api-preload.js` (~21 KB). The author confirms this directly in issue #1643. This single fact explains *every* mobile/desktop divergence catalogued in §9 and §12.4: no `zlib`, a hard-limited `aes-128-cbc`/`aes-128-ecb`, base64/hex/utf8-only buffers, only `setTimeout`/`clearTimeout` as host APIs, frozen built-in prototypes, and `eval` blocked by a `Function.prototype.constructor` proxy that throws `'Dynamic code execution is not allowed.'`

**Structural proof of the shell/source split:** `src/utils/musicSdk/{bd,kg,kw,mg,tx,wy}/` on mobile contains search, songList, leaderboard, lyric, pic, comment, hotSearch and tipSearch modules — but **no `musicUrl.js` anywhere**. The audio-URL step is delegated entirely to the custom source. The desktop app has the same shape (`api-source-info.ts` emptied), which is why the two share a source contract despite completely different runtimes.

**Version currency:** some mirrors are stale — `raw.gitcode.com/gh_mirrors/lx/lx-music-mobile` still serves `1.8.4`/`versionCode 76`. Prefer `gh-proxy` or `fastly.jsdelivr.net`.

### 2.6 License of the custom-source script ecosystem

`[VERIFIED — negative result]` There is **no shared `@lx-music/*` npm package family.** A registry search for `lx-music` and `@lx-music` returns only:

| Package | Version | License | What it actually is |
| --- | --- | --- | --- |
| `lx-music-desktop-version-info` | 2.12.5 | MIT | **Data-only.** A JSON blob of release notes used by the app's update checker. Not a library. |
| `lx-music-mobile-version-info` | 1.9.0 | MIT | Same, for mobile. |
| `lx-music-mobile` | 2.8.7 | MIT | **Unrelated / likely squatted.** Publisher is `natiisilva438@gmail.com`, not `lyswhut`. Repository field points at the real repo, but the real project does not publish to npm under this name. Do not use. |
| `inki-music-api` | 2.0.7 | MIT | Third-party community helper: "lx-music 自定义源 TypeScript + axios 封装". |
| `agent-lx-music` | 0.4.0 | MIT | Third-party terminal player using QuickJS source scripts. |
| `lx-music-for-dsh` | 1.0.1 | Apache-2.0 | Third-party DeepSeek Harness plugin with an embedded LX source-script engine. |

**There is no official, versioned, reusable "lx-music-source" package.** The custom-source contract exists only as (a) the MIT-licensed documentation and (b) the `preload.js` implementation inside the app.

### 2.6b There IS an official source-template repo — and it is MIT

`[VERIFIED]` [`lyswhut/lx-music-source`](https://github.com/lyswhut/lx-music-source) is a **genuinely official, MIT-licensed** repository by the same author:

```json
"name": "lx-music-source", "version": "1.1.2",
"description": "A lx-music source",
"author": "lyswhut",
"license": "MIT",
"scripts": { "dev": "… webpack --config webpack.config.js",
             "build": "… webpack --config webpack.config.js" }
```

It is a **webpack build harness** wrapping Listen1 providers into the LX source format — a *template for authoring* a source, not a maintained working source. This is useful and freely reusable under MIT.

> ⚠️ **Naming trap.** A folder literally labelled **"洛雪官方源" (LX official source)** circulates inside community aggregator repos. **It is not official.** It is a third-party script branded to a WeChat public account called 「洛雪科技」 — a name that trades on the project's reputation. The author has explicitly disclaimed this class of thing (mobile v1.1.0 changelog: *"本项目无微信公众号之类的官方账号…商店内的'LX Music'、'洛雪音乐'相关的应用全部属于假冒应用，谨防被骗"*). **Do not trust the folder name; check the `@author` field.**

### 2.6c Successor project: Any Listen

`[VERIFIED]` The author's announced successor is [`any-listen/any-listen`](https://github.com/any-listen/any-listen) — *"A cross-platform private music playback service"*, TypeScript, **3,707 stars, 164 forks, created 2025-01-26, actively pushed (last push 2026-09-16)**. License is `NOASSERTION` (a bespoke licence — **check it before reuse**; it is *not* Apache-2.0).

The architecture is deliberately preserved and the *data source* re-pointed from streaming platforms to self-hosted/WebDAV libraries. Critically for us: an official bridge exists — `any-listen/any-listen-extension-lx-api-source-loader` — an Any Listen extension that **loads LX-format source scripts**. So the `globalThis.lx` contract is intended to outlive LX Music itself, which strengthens the case for treating it as the interoperability standard to implement.

**Community source scripts themselves are overwhelmingly unlicensed.** `[REPORTED]` They are distributed as single `.js` files pasted into the app or fetched from a raw URL; I found no evidence of any community source script carrying an explicit license file. Several are obfuscated or minified. **Treat every community source script as "all rights reserved by default" and do not vendor one into your product.**

---

## 3. Tech stack (exact)

`[VERIFIED]` from `package.json` on `master`.

### 3.1 Runtime / platform

```jsonc
"name": "lx-music-desktop",
"version": "2.12.2",
"description": "一个免费的音乐查找助手",
"main": "./dist/main.js",
"engines": { "node": ">= 22", "npm": ">=8.5.2" },
"browserslist": [ "Electron 22.3.0" ]
```

### 3.2 `devDependencies` (build/release)

| Package | Version | Purpose |
| --- | --- | --- |
| `electron` | **40.9.2** | Runtime |
| `electron-builder` | ^26.9.0 | Packaging |
| `electron-updater` | 6.8.4 | Auto-update (installer builds only) |
| `webpack` / `webpack-cli` | ^5.106.2 / ^7.0.2 | Bundler |
| `webpack-dev-server` | 5.2.3 | Dev server (port 9080) |
| `webpack-hot-middleware` | `github:lyswhut/webpack-hot-middleware#329c437…` | Forked HMR |
| `ts-loader` / `typescript` | ^9.5.7 / **5.9.3** | TS compilation |
| `vue-loader` / `@vue/language-plugin-pug` | ^17.4.2 / ^3.2.7 | SFC compilation |
| `pug` / `pug-plain-loader` | ^3.0.4 / ^1.1.0 | **Templates are Pug, not HTML** |
| `less` / `less-loader` | ^4.6.4 / ^12.3.2 | **Styles are Less** |
| `postcss` / `postcss-loader` / `postcss-pxtorem` | ^8.5.12 / ^8.2.1 / ^6.1.0 | px→rem |
| `css-loader` / `mini-css-extract-plugin` / `css-minimizer-webpack-plugin` | | CSS pipeline |
| `terser` / `terser-webpack-plugin` | ^5.46.2 / ^5.5.0 | Minification |
| `eslint` + `eslint-config-standard-with-typescript` + `eslint-plugin-vue` + `eslint-plugin-vue-pug` | ^8.57.1 / ^43.0.1 / ^9.33.0 / ^0.6.2 | Lint |
| `svgo-loader` / `svg-sprite-loader` / `svg-transform-loader` | | SVG sprite icons |
| `node-loader` | ^2.1.0 | Native `.node` modules |
| `electron-devtools-installer` | `github:lyswhut/electron-devtools-installer#64596d6…` | Forked |
| `spinnies`, `chalk`, `del`, `rimraf`, `tree-kill`, `cross-env` | | Build-script UX |
| `@types/better-sqlite3`, `@types/needle`, `@types/node` (^20.19.39), `@types/tunnel`, `@types/ws` | | Types |

### 3.3 `dependencies` (shipped)

| Package | Version | Purpose |
| --- | --- | --- |
| `vue` | **~3.3.13** | Renderer framework |
| `vue-router` | ~4.5.1 | Routing |
| `better-sqlite3` | ^12.9.0 | **SQLite driver (native)** |
| `music-metadata` | ^11.12.3 | Audio tag/metadata reading |
| `node-id3` | ^0.2.9 | **ID3v2 writing for MP3** |
| `image-size` | ^1.1.0 | Cover dimensions for FLAC PICTURE block |
| `jschardet` | ^3.1.4 | Charset detection for `.lrc` files |
| `iconv-lite` | ^0.7.2 | Transcode `.lrc` / write GBK `.lrc` |
| `comlink` | ~4.3.1 | Web Worker RPC proxy |
| `message2call` | ^0.1.3 | Callback-style worker messaging |
| `needle` | `github:lyswhut/needle#93299ac…` | **Forked** HTTP client used by the source-script sandbox |
| `tunnel` | ^0.0.6 | HTTP CONNECT proxy for the sandbox |
| `undici` | ^7.25.0 | HTTP for main-process requests |
| `ws` + `bufferutil` + `utf-8-validate` | ^8.20.0 / ^4.1.0 / ^6.0.6 | WebSocket (sync server/client) |
| `crypto-js` | ^4.2.0 | Crypto helpers |
| `long` | ^5.3.2 | 64-bit ints (sync protocol) |
| `electron-log` | ^5.4.3 | Logging |
| `font-list` | ^2.0.2 | Enumerate system fonts |
| `@simonwep/pickr` | ^1.9.1 | **The only UI-library dependency** — color picker |
| `sortablejs` | ^1.15.7 | Drag-reorder lists |

### 3.4 Native binaries shipped prebuilt

`[VERIFIED]` `build-config/lib/` contains prebuilt `.node` binaries checked into git:

- `better_sqlite3_electron-v143-{linux-x64,linux-arm64,linux-arm}.node`
- `qrc_decode_electron-v143-{win32-x64,win32-ia32,win32-arm64,darwin-x64,darwin-arm64,linux-x64,linux-arm64,linux-arm}.node`
- plus legacy `qrc_decode_electron-v110-win32-*.node`

The `qrc_decode` module decrypts KuGou `.krc` lyrics. `[REPORTED]` Per the v2.1.0 changelog entry in `lx-music-desktop-version-info`: *"感谢某位不愿透露姓名的大佬提供的C++算法源码，但由于作者不希望公开，所以将会以预构建二进制文件的形式加入代码仓库中"* — the C++ source was donated anonymously and deliberately kept closed. **This is a provenance red flag: you cannot audit or independently license those binaries, and you must not ship them.**

### 3.5 Build scripts

`[VERIFIED]` `package.json` scripts, abbreviated:

```jsonc
"dev":   "cross-env NODE_OPTIONS=--max-http-header-size=200000 node build-config/runner-dev.js",
"build:main":            "webpack --config build-config/main/webpack.config.prod.js",
"build:renderer":        "webpack --config build-config/renderer/webpack.config.prod.js",
"build:renderer-lyric":  "webpack --config build-config/renderer-lyric/webpack.config.prod.js",
"build:renderer-scripts":"webpack --config build-config/renderer-scripts/webpack.config.prod.js",
"build:theme":           "node src/common/theme/createThemes.js",
"pack:win":  "… pack:win:setup:{x64,x86,arm64,x86_64} + pack:win:7z",
"pack:mac":  "… dmg x64 + arm64",
"pack:linux":"… deb {amd64,arm64,armv7l} + AppImage + rpm + pacman",
"pack:dir":  "node build-config/pack.js && node build-config/build-pack.js target=dir",
"postinstall": "electron-builder install-app-deps"
```

**There are four separate webpack bundles**, which maps directly onto the four processes:

| Bundle | Source | Output | Process |
| --- | --- | --- | --- |
| main | `src/main/` | `dist/main.js` | Electron main |
| renderer | `src/renderer/` | `dist/index.html` + assets | Main window (Vue app) |
| renderer-lyric | `src/renderer-lyric/` | `dist/lyric.html` | Desktop-lyric overlay window |
| renderer-scripts | `src/main/modules/userApi/renderer/preload.js` | `dist/user-api-preload.js` | **Custom-source sandbox preload** |

Note there is **no `build:user-api` script**; `user-api-preload.js` is produced by the `renderer-scripts` config.

---

## 4. Process & module architecture

### 4.1 Four processes

```
┌───────────────────────────────────────────────────────────────────────┐
│ MAIN PROCESS  (src/main/)                                             │
│  • app lifecycle, single-instance lock, lxmusic:// deep links         │
│  • userData path resolution (+ portable/ override)                    │
│  • settings/hotkey/userApi JSON stores                                │
│  • better-sqlite3 database worker (node worker_threads)               │
│  • tray, app menu, global hotkeys, taskbar thumbar buttons            │
│  • HTTP server for 开放 API (default 127.0.0.1:23330)                 │
│  • WS server/client for 数据同步 (default port 23332)                  │
│  • owns the custom-source sandbox BrowserWindow                       │
└───────────────────────────────────────────────────────────────────────┘
        ▲ ipcMain.handle / ipcMain.on            │ webContents.send
        │                                        ▼
┌───────────────────────────────────────────────────────────────────────┐
│ MAIN WINDOW  (src/renderer/)   nodeIntegration:TRUE, contextIsolation:FALSE │
│  • Vue 3 app; owns <audio> + Web Audio graph                          │
│  • musicSdk: built-in kw/kg/tx/wy/mg/bd/xm API adapters               │
│  • playback queue, playlists, download orchestration                  │
│  • download Web Worker (Downloader + tag writer)                      │
└───────────────────────────────────────────────────────────────────────┘
        ▲ ipcMain.handle / ipcMain.on            │ webContents.send
        ▼                                        ▼
┌───────────────────────────────────────┐  ┌────────────────────────────┐
│ LYRIC WINDOW (src/renderer-lyric/)    │  │ SOURCE SANDBOX (hidden)     │
│  • frameless transparent always-on-top│  │  contextIsolation: TRUE     │
│  • renders desktop lyrics             │  │  nodeIntegration: FALSE     │
│  • reads player status over IPC       │  │  sandbox: FALSE             │
└───────────────────────────────────────┘  │  loads data:text/html       │
                                           │  exposes globalThis.lx      │
                                           └────────────────────────────┘
```

### 4.2 Security posture — note this carefully

`[VERIFIED]` `src/main/modules/winMain/main.ts`, `createWindow()`:

```ts
webPreferences: {
  session: ses,
  nodeIntegrationInWorker: true,
  contextIsolation: false,   // ← renderer shares the main-world context
  webSecurity: false,        // ← CORS disabled
  nodeIntegration: true,     // ← full Node in the renderer
  sandbox: false,
  enableWebSQL: false,
  webgl: false,
  spellcheck: false,
},
```

And the window itself: `frame: false`, `transparent: !dt`, `resizable: false`, `maximizable: false`, `fullscreenable: true`, `roundedCorners: dt`.

This is a **deliberate, legacy architecture choice**. The renderer does filesystem I/O directly (`src/renderer/utils/music.ts` calls `checkPath`, `readFile`, `getFileStats` from `@common/utils/nodejs`), reads `.lrc`/`.krc` files, and imports `music-metadata` at runtime. It is also why the custom-source sandbox had to be built as a *separate, hardened window* rather than reusing the main one.

**A new implementation should not copy this.** Use `contextIsolation: true` + `sandbox: true` + a narrow `contextBridge` API + `webSecurity: true`.

### 4.3 IPC design

`[VERIFIED]` `src/common/mainIpc.ts` — thin, overloaded wrappers:

```ts
mainOn(name, listener)        // ipcMain.on
mainOnce(name, listener)      // ipcMain.once
mainOff / mainOffAll
mainHandle(name, listener)    // ipcMain.handle  → async/await
mainHandleOnce(name, listener)
mainHandleRemove(name)
mainSend(window, name, params) // window.webContents.send
```

`[VERIFIED]` `src/common/ipcNames.ts` — a single nested object that is flattened to prefixed names at module load:

```ts
const modules = {
  common:  { get_env_params, deeplink, system_theme_change, theme_change,
             get_system_fonts, get_app_setting, set_app_setting },
  player:  { invoke_play_music, invoke_play_next, invoke_play_prev, invoke_toggle_play,
             player_play, player_pause, player_stop, player_error,
             list_get, list_add, list_remove, list_update, list_update_position,
             list_music_get, list_music_add, list_music_move, list_music_remove,
             list_music_update, list_music_update_position, list_music_overwrite,
             list_music_clear, list_music_check_exist, list_music_get_list_ids },
  dislike: { get/add/overwrite/clear_dislike_music_infos },
  winMain: { focus, close, min, max, fullscreen, set_app_name, clear_cache,
             get_cache_size, inited, show_save_dialog, show_select_dialog, show_dialog,
             open_dir_in_explorer, open_dev_tools, set_power_save_blocker,
             player_status, change_tray, quit_update, update_check, update_download_update,
             update_available, update_error, update_progress, update_downloaded,
             update_not_available, set_ignore_mouse_events, set_window_size,
             handle_request, cancel_request, restart_window,
             handle_kw_decode_lyric, handle_tx_decode_lyric, get_lyric_info, set_lyric_info,
             set_config, set_hot_key_config, on_config_change, key_down, quit,
             min_toggle, hide_toggle,
             get_other_source, save_other_source, clear_other_source, get_other_source_count,
             get_data, save_data,
             get_sound_effect_eq_preset, save_sound_effect_eq_preset,
             get_sound_effect_convolution_preset, save_sound_effect_convolution_preset,
             get_hot_key,
             import_user_api, remove_user_api, set_user_api, get_user_api_list,
             request_user_api, request_user_api_cancel, get_user_api_status,
             user_api_status, user_api_show_update_alert, user_api_set_allow_update_alert,
             get_palyer_lyric, get_lyric_raw, save_lyric_raw, clear_lyric_raw,
             get_lyric_raw_count, get_lyric_edited, save_lyric_edited,
             remove_lyric_edited, clear_lyric_edited, get_lyric_edited_count,
             get_music_url, save_music_url, clear_music_url, get_music_url_count,
             open_api_action, sync_action, sync_get_server_devices,
             sync_remove_server_device, process_new_desktop_lyric_client,
             player_action_set_buttons, player_action_on_button_click,
             get_themes, save_theme, remove_theme,
             download_list_get, download_list_add, download_list_update,
             download_list_remove, download_list_clear },
  winLyric:{ close, set_config, get_config, on_config_change, main_window_inited,
             set_win_bounds, set_win_resizeable, key_down,
             request_main_window_channel, provide_main_window_channel, mouse_enter_leave },
  hotKey:  { enable, status, set_config },
}
// then every leaf is rewritten to `${moduleName}_${eventName}`
```

Renderer-side, `src/renderer/utils/ipc.ts` wraps these into named functions (`getSetting`, `saveLyric`, `downloadTasksCreate`, …). Main-side, each module registers its handlers, e.g. `src/main/modules/winMain/rendererEvent/download.ts`:

```ts
mainHandle(WIN_MAIN_RENDERER_EVENT_NAME.download_list_get, async () =>
  global.lx.worker.dbService.getDownloadList())
mainHandle(WIN_MAIN_RENDERER_EVENT_NAME.download_list_add, async ({ params: { list, addMusicLocationType } }) =>
  global.lx.worker.dbService.downloadInfoSave(list, addMusicLocationType))
```

**Design takeaway to mirror:** a *single* namespaced constant table shared by both sides, plus typed thin wrappers. It eliminates stringly-typed IPC drift. Mirror the pattern, not the code.

### 4.4 Main-process module registry

`[VERIFIED]` `src/main/modules/index.ts`:

```ts
registerUserApi()        // custom-source sandbox lifecycle
registerCommonRenderers()// common / list / dislike renderer bridges
registerWinMain()        // main window + all winMain IPC handlers
registerHotKey()         // local + global shortcuts
registerTray()           // system tray
registerAppMenu()        // application menu
registerWinLyric()       // desktop-lyric window
```

### 4.5 Startup sequence

`[VERIFIED]` `src/main/index.ts` + `src/main/app.ts`:

```
initGlobalData()            // parse argv, build global.lx (event emitters, worker, defaults)
initSingleInstanceHandle()  // requestSingleInstanceLock(); second-instance → deeplink or show
applyElectronEnvParams()    // -dha, -dhmkh, linux use-gl, wm-window-animations-disabled, --disable-gpu-sandbox, proxy switches
setUserDataPath()           // portable/ override; global.lxDataPath = <userData>/LxDatas
registerDeeplink(init)      // app.setAsDefaultProtocolClient('lxmusic')
listenerAppEvent(init)      // web-contents-created guards, navigation whitelist, spellcheck dict disabled
app.whenReady().then(init)  // linux: setTimeout(init, 300)

init():
  initAppSetting()
    ├ initHotKey()                       → hot_key.json
    ├ worker.dbService.init(lxDataPath)  → open/create lx.data.db, WAL, verifyDB()
    │    └ on verify failure: back up to lx.data.db.<ts>.bak and recreate
    ├ initSetting()                      → config_v2.json (falls back to legacy config.json)
    ├ migrateDBData()                    → import pre-v2.0.0 playList.json / lyrics_edited.json
    └ initTheme()
  registerModules()
  global.lx.event_app.app_inited()
```

Renderer startup `[VERIFIED]` `src/renderer/main.ts` → `src/renderer/core/useApp/index.ts`:

```
getSetting() → set language, createApp(App).use(router).use(i18nPlugin); mount('#root')
useApp():
  useEventListener(), usePlayer(), useDataInit(), useDeeplink(), useUpdate(), useSettingSync()
  getEnvParams()
    → getViewPrevState() → router.push(last route)
    → useDataInit(): initUserApi() → music.init() → registerAction() → getUserLists()
                     → initDislikeInfo() → initPrevPlayInfo()
    → useHandleEnvParams(), initSyncService(), initOpenAPI(), initStatusbarLyric()
    → sendInited()
    → handleListAutoUpdate(); if isProd && isAgreePact → checkUpdate()
```

---

## 5. Playback

### 5.1 It is HTML5 `<audio>` plus a Web Audio graph — no native module

`[VERIFIED]` `src/renderer/plugins/player/index.ts`:

```ts
let audio: HTMLAudioElementChrome | null = null   // HTMLAudioElement & { setSinkId }
export const createAudio = () => {
  audio = new window.Audio() as HTMLAudioElementChrome
  audio.controls = false
  audio.autoplay = true
  audio.preload = 'auto'
  audio.crossOrigin = 'anonymous'
  …
}
```

The signal chain, from the comment in `initAdvancedAudioFeatures()`:

```
source → analyser → biquadFilter(10-band) → pitchShifter → [(convolver & convolverSource) → convolverDynamicsCompressor] → panner → gain
```

```ts
mediaSource = audioContext.createMediaElementSource(audio)
mediaSource.connect(analyser)
analyser.connect(biquads.get('hz31'))
…chained…
lastBiquadFilter.connect(convolverSourceGainNode)   // dry
lastBiquadFilter.connect(convolver)                 // wet
convolverDynamicsCompressor.connect(panner)
panner.connect(gainNode)
gainNode.connect(audioContext.destination)
```

`audioContext = new window.AudioContext({ latencyHint: 'playback' })`.

**Public surface** (`src/renderer/plugins/player/index.ts`): `setResource(src)`, `setPlay()`, `setPause()`, `setStop()` (clears `src`), `setCurrentTime`, `getCurrentTime`, `getDuration`, `setVolume`, `setMute`, `setPlaybackRate`, `setPreservesPitch`, `setLoopPlay`, `setMediaDeviceId(id)` (→ `audio.setSinkId`), `getAnalyser`, `getBiquadFilter`, `setConvolver`, `setPanner*`, `setPitchShifter`, plus event subscriptions `onPlaying/onPause/onEnded/onError/onLoadeddata/onLoadstart/onCanplay/onEmptied/onTimeupdate/onWaiting/onVisibilityChange` and `getErrorCode()`.

**Only one native-ish extension:** `setMaxOutputChannelCount(true)` sets `audioContext.destination.channelCountMode='max'` and `channelCount = maxChannelCount` for multichannel output.

### 5.2 Equalizer and audio effects — yes, substantial

`[VERIFIED]` 10 fixed bands, `Q = 1.4`, type `peaking`:

```ts
export const freqs = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000] as const
filter.type = 'peaking'; filter.frequency.value = item; filter.Q.value = 1.4; filter.gain.value = 0
```

Nine built-in EQ presets `[VERIFIED]`: `pop, dance, rock, classical, vocal, slow, electronic, subwoofer, soft`.

**Convolution reverb** — 13 presets `[VERIFIED]`: `telephone, s2_r4_bd (教堂), bright_hall, cinema_diningroom, dining_living_true_stereo, living_bedroom_leveled, spreader50_65ms, s3_r1_bd, matrix_1, matrix_2, cardiod_35_10_spread, tim_omni_35_10_magnetic, feedback_spring`. Impulse responses are `.wav` files under `src/renderer/assets/medias/filters/`, loaded by XHR → `decodeAudioData` and cached in a `Map<string, AudioBuffer>`.

**3D rotating panner** `[VERIFIED]` — `startPanner()` runs a `setInterval` that advances a degree counter and sets `panner.positionX/Y/Z` from `sin`/`cos`, giving an orbiting-stereo effect. Configurable radius (`soundR`) and speed.

**Pitch shifter** `[VERIFIED]` — an `AudioWorkletNode` loaded from `./pitch-shifter/phase-vocoder.js` with a `pitchFactor` AudioParam; the code comments cite <https://github.com/olvb/phaze/issues/26#issuecomment-1574629971>. It is connected/disconnected dynamically and only loaded when the user first changes pitch (to avoid the CPU cost).

**Settings keys** `[VERIFIED]` `src/common/defaultSetting.ts`:
`player.soundEffect.biquadFilter.hz{31,62,125,250,500,1000,2000,4000,8000,16000}`, `player.soundEffect.convolution.{fileName,mainGain,sendGain}`, `player.soundEffect.panner.{enable,soundR,speed}`, `player.soundEffect.pitchShifter.playbackRate`, `player.playbackRate`, `player.preservesPitch`, `player.isMaxOutputChannelCount`, `player.mediaDeviceId`, `player.audioVisualization`.

### 5.3 How an online URL is obtained and played

`[VERIFIED]` `src/renderer/core/music/online.ts` and `utils.ts`.

```
getMusicUrl(musicInfo, quality, isRefresh, allowToggleSource, onToggleSource)
  ├ 1. quality = quality ?? getPlayQuality(appSetting['player.playQuality'], musicInfo)
  ├ 2. cachedUrl = await getStoreMusicUrl(musicInfo, targetQuality)   // SQLite music_url table
  │     if (cachedUrl && !isRefresh) return cachedUrl
  └ 3. handleGetOnlineMusicUrl(...)
        ├ musicSdk[source].getMusicUrl(toOldMusicInfo(musicInfo), targetQuality).promise
        │    → { url, type }
        └ on failure, if allowToggleSource:
             getOtherSource(musicInfo)  → musicSdk.findMusic(...)   // cross-source match
             → getOnlineOtherSourceMusicUrl([...otherSource], retryedSource=[failed])
                  walks candidates, skipping already-tried sources and unsupported ones,
                  re-picks quality via getPlayQuality, recurses on failure
  └ 4. saveMusicUrl(musicInfo, targetQuality, url)  // persist into SQLite
```

Quality selection `[VERIFIED]`:

```ts
export const TRY_QUALITYS_LIST = ['flac24bit', 'flac', '320k'] as const
export const getPlayQuality = (highQuality, musicInfo) => {
  let type = '128k'
  if (TRY_QUALITYS_LIST.includes(highQuality)) {
    const list = qualityList.value[musicInfo.source]
    const t = TRY_QUALITYS_LIST.slice(TRY_QUALITYS_LIST.indexOf(highQuality))
      .find(q => musicInfo.meta._qualitys[q] && list?.includes(q))
    if (t) type = t
  }
  return type
}
```

**Cross-source matching** `[VERIFIED]` `src/renderer/utils/musicSdk/index.js` — `findMusic({name, singer, albumName, interval, source})` searches every source except the current one (and except `xm`), then scores candidates through a cascade of nine increasingly loose predicates: exact name+singer → exact singer+name-substring → album+singer+name → … → album only → anything. Interval matching tolerates ±5 s. Singers are normalized by splitting on `、 & ; ； / , ， |`, sorting, and rejoining with `、`. Names/album/singer are filtered of whitespace and punctuation before comparison.

**Result:** the URL is a plain HTTP(S) string handed to `audio.src`. There is **no proxy, no decryption, no native demuxer** — the WebView's own media stack fetches and decodes it. Formats supported are therefore exactly what Chromium supports: MP3, AAC/M4A, FLAC, WAV, Ogg/Opus. **APE is not playable** (and `src/renderer/utils/music.ts` explicitly excludes `.ape` from "download file available" checks).

### 5.4 Playback state machine

`[VERIFIED]` `src/renderer/core/useApp/usePlayer/usePlayer.ts` — a `usePlayer()` composable that composes:

`usePlayProgress`, `useMediaSessionInfo`, `usePlayEvent`, `useLyric`, `useVolume`, `useMaxOutputChannelCount`, `useSoundEffect`, `usePlaybackRate`, `useWatchList`, `usePreloadNextMusic`.

Handles: `handleCanplay`, `handleEnded` (→ `playNext(true)`), seek ±5 s, `setPlayStatus`/`setPauseStatus`/`setStopStatus`, hotkey bindings (`HOTKEY_PLAYER.next/prev/toggle_play/music_love/music_unlove/music_dislike/seekbackward/seekforward`), and app events (`play`, `pause`, `error`, `stop`, `musicToggled`, `playerCanplay`, `playerPlaying`, `playerEmptied`, `playerEnded`). Power-save blocker is engaged on `playerPlaying` and released on pause/stop/emptied.

`[VERIFIED]` `usePreloadNextMusic.ts` exists — next-track URL prefetching.

Play modes `[VERIFIED]` from `defaultSetting.ts`: `player.togglePlayMethod` default `'listLoop'`; `player.autoSkipOnError: true`; `player.waitPlayEndStop` + `player.waitPlayEndStopTime` implement a sleep timer.

---

## 6. Local music support — honest assessment: **immature**

### 6.1 What actually exists

`[VERIFIED]` `src/renderer/utils/music.ts`, `src/renderer/core/music/local.ts`.

**Adding files:** `[VERIFIED]` docs <https://lxmusic.toside.cn/desktop/faq/play-local-music>:

> 1. 进入「我的列表」界面； 2. 鼠标右击任意列表名； 3. 从弹出菜单中选择「添加本地歌曲」，在弹出窗口中选择你需要添加的歌曲即可。

That is a **file picker only**. There is:
- ❌ no "add folder / scan library" action,
- ❌ no filesystem watcher,
- ❌ no incremental rescan,
- ❌ no deduplication against previously added files,
- ❌ no album-artist / album grouping,
- ❌ no library view distinct from a normal playlist.

The mobile app *does* have directory-based adding (v1.2.0: *"在我的收藏的列表菜单中选择歌曲目录，将添加所选目录下的所有歌曲，目前支持mp3/flac/ogg/wav等格式"*), but that feature was **never ported to desktop**. `[VERIFIED]`

**Metadata reading** `[VERIFIED]` `createLocalMusicInfo(path)`:

```ts
const { parseFile } = await import('music-metadata')
const metadata = await parseFile(path)
const ext    = extname(path)
const name   = (metadata.common.title || basename(path, ext)).trim()
const singer = metadata.common.artists?.length
  ? metadata.common.artists.map(a => a.trim()).join('、') : ''
const interval = metadata.format.duration ? formatPlayTime(metadata.format.duration) : ''
const albumName = metadata.common.album?.trim() ?? ''
return { id: path, name, singer, source: 'local', interval,
         meta: { albumName, filePath: path, songId: path, picUrl: '', ext: ext.replace(/^\./,'') } }
```

So: title/artist/album/duration from tags, filename fallback for title, **`id` is the absolute file path**. Note the documented failure modes: non-UTF-8 tags produce 乱码; missing tags fall back to the filename.

**Cover art** `[VERIFIED]` `getLocalMusicFilePic(path)`:
1. sibling `<same-name>.jpg` → return
2. sibling `<same-name>.png` → return
3. embedded picture via `selectCover(metadata.common.picture)`

Cached through a one-entry memo (`prevFileInfo`).

**Lyrics** `[VERIFIED]` `getLocalMusicFileLyric(path)` — a three-tier fallback:
1. sibling `<same-name>.lrc`, if `size < 10 MB`: read buffer → `jschardet.detect()` → if `confidence > 0.8` and `iconv.encodingExists(encoding)` → `iconv.decode`. (Logs `lrc file encoding <confidence> <encoding>`.)
2. sibling `<same-name>.krc` (KuGou encrypted), if `size < 10 MB` → `decodeKrc(lrcBuf)` from `@common/utils/lyricUtils/kg`
3. embedded lyrics: iterate `metadata.native` looking for `LYRICS` (Vorbis) or `USLT` (ID3) entries with `value.length > 10`

**Graceful degradation** `[VERIFIED]` `src/renderer/core/music/local.ts` — this is the genuinely clever bit:

- `getMusicUrl(local)`: if the file exists and `!isRefresh` → return `encodePath(path)` (play the local file). Otherwise try the source's `local` actions; then `getOtherSourceByLocal(...)` which **searches online for a substitute**, trying in order: `name` as-is → split `name` on `-` into name/singer (both orders) → the filename stem (also split on `-`) → filename as name with empty singer.
- `getPicUrl(local)`: local sibling/embedded → online source `pic` action → cross-source `getOtherSource` → and if found via a list context, **writes `musicInfo.meta.picUrl` back into the playlist row**.
- `getLyricInfo(local)`: cached edited lyric vs. file lyric compared; if they differ, the edited one wins with the file version kept as `rawlrcInfo` → then online `lyric` action → then cross-source.

Documented behaviour `[VERIFIED]`:

> 当已被添加到列表中的本地歌曲无法播放时（如文件损坏或被删除），LX Music 将尝试使用当前歌曲名、艺术家搜索在线歌曲播放。

**No tag *writing* for local files on desktop.** The mobile app added "歌曲标签编辑功能，允许编辑本地源且文件存在的歌曲标签信息" in v1.2.0; desktop has no such UI. Desktop *does* write tags, but only as part of the **download** flow (see §7).

### 6.2 Maturity verdict

| Capability | Status |
| --- | --- |
| Play local file | ✅ works |
| Read tags | ✅ via `music-metadata`, with filename fallback |
| Cover from sibling/embedded | ✅ |
| `.lrc` with charset detection | ✅ (jschardet + iconv-lite) |
| `.krc` | ✅ (via un-auditable prebuilt binary) |
| Embedded lyrics | ✅ |
| **Library folder scan** | ❌ **absent** |
| **Filesystem watching** | ❌ **absent** |
| **Incremental / cached index** | ❌ **absent** — every add re-parses; `id` is the path, so a moved file is a new entry |
| **Tag editing** | ❌ absent on desktop |
| **Duplicate detection** | ❌ absent |
| ReplayGain / gapless | ❌ absent |
| CUE sheets | ❌ absent |
| APE playback | ❌ unsupported |
| Multi-disc / album art caching | ❌ absent |

**This is the single largest opportunity for a new player.** LX Music treats local files as a fallback for its online catalogue; it is explicitly self-described as a 查歌器 (song finder) rather than a library manager — the docs say *"洛雪定位 '查歌器'，非完整播放器，可外接 foobar 使用"* `[REPORTED, cnblogs]`. A competitor that does real library management (scan, watch, index, tag-edit, dedupe, CUE, ReplayGain) would be differentiated on the axis LX deliberately abandoned.

---

## 7. Download

### 7.1 Where it runs

`[VERIFIED]` A **Web Worker inside the renderer**, not the main process:
`src/renderer/worker/index.ts`, `src/renderer/worker/download/{index,download,common,utils,lrcTool}.ts`, with `common.ts` re-exporting `writeMeta`/`saveLrc`.

Worker RPC uses `comlink` + a `message2call`-style proxy (`src/renderer/worker/utils`, `proxyCallback`).

Orchestration lives in `src/renderer/store/download/action.ts`. Defaults `[VERIFIED]` `defaultSetting.ts`:

```ts
'download.enable': false,               // feature is OFF by default
'download.savePath': path.join(os.homedir(), 'Desktop'),
'download.fileName': '歌名 - 歌手',
'download.maxDownloadNum': 3,
'download.skipExistFile': true,
'download.isSavePathGroupByListName': false,
'download.isDownloadLrc': false,
'download.isDownloadLxLrc': true,
'download.isDownloadTLrc': false,
'download.isDownloadRLrc': false,
'download.lrcFormat': 'utf8',           // or 'gbk'
'download.isEmbedPic': true,
'download.isEmbedLyric': false,
'download.isEmbedLyricLx': true,
'download.isEmbedLyricT': false,
'download.isEmbedLyricR': false,
'download.isUseOtherSource': false,     // whether to fall back to other sources
```

Status values `[VERIFIED]` `src/common/constants.ts`:
`DOWNLOAD_STATUS = { RUN:'run', WAITING:'waiting', PAUSE:'pause', ERROR:'error', COMPLETED:'completed' }`
`QUALITYS = ['flac24bit','flac','wav','ape','320k','192k','128k']`

### 7.2 The downloader

`[VERIFIED]` `src/common/utils/download/Downloader.ts` — a hand-written `Task extends EventEmitter`:

- `forceResume: true` default; `timeout: 20_000`.
- **Resume by 10-byte overlap verification**: reads the last 10 bytes of the partial file, re-requests `Range: bytes=<size-10>-`, and compares the returned first bytes hex-for-hex (`__handleDiffChunk`). On mismatch → delete the file and restart from 0.
- Handles `200`/`206`; `416` → delete + reset to byte 0; `301/302` → follow, `maxRedirectNum = 2`.
- `accept-ranges` check; if not resumable and `startByte != '0'` → error "The resource cannot be resumed download."
- Writes with a `WriteStream` (`flags: 'a'` when resuming), tracks `dataWriteQueueLength`, emits `progress` at most once per second with `{total, downloaded, progress, speed, writeQueue}`.
- `refreshUrl(url)` lets the caller swap in a fresh signed URL.

Retry policy `[VERIFIED]` `src/renderer/worker/download/download.ts`:
- `tryNum > 2` → give up with error.
- `err.code === 'EPERM'` → "歌曲保存位置被占用或没有写入权限…"
- `err.code === 'ENOTFOUND'` → emit `refreshUrl`
- `err.message.startsWith('Resume failed')` → delete file, retry
- `onFail` with status `401/403/410` → emit `refreshUrl` (expired signed URL), else retry after 1 s
- Before starting, if `downloaded == 0`: `skipExistFile` → if the target exists and `size > 100` bytes, fail with `download_status_error_check_path_exist`; otherwise delete the existing file.

### 7.3 File naming

`[VERIFIED]` `src/renderer/worker/download/utils.ts` + `src/common/utils/tools.ts` + `src/renderer/store/download/utils.ts`:

```ts
// ext from quality
getExt(type): 'ape'→ape | 'flac'|'flac24bit'→flac | 'wav'→wav | default→mp3

// task id
const key = `${musicInfo.id}_${type}_${ext}`

// filename
fileName: filterFileName(
  `${clipFileNameLength(formatMusicName(fileName /* user format */, musicInfo.name,
                                        clipNameLength(musicInfo.singer)))}.${ext}`
)

formatMusicName(format, name, singer) => format.replace('歌手', singer).replace('歌名', name)
clipNameLength(name)     // MAX_NAME_LENGTH = 80; joins multi-singer names with '、' until the cap
clipFileNameLength(name) // MAX_FILE_NAME_LENGTH = 150 → substring(0, 150)
```

**Directory** `[VERIFIED]` `buildSavePath(musicInfo)`:

```ts
let savePath = appSetting['download.savePath']
if (appSetting['download.isSavePathGroupByListName']) {
  // dirName = i18n name of 'default' / 'love' list, or the user list's name
  // savePath = joinPath(savePath, clipFileNameLength(filterFileName(dirName)))
}
```

So: flat into `download.savePath` by default; optionally one subfolder per source playlist. **No `%artist%/%album%` templating exists** — this is a notable gap versus foobar2000/MusicBee.

Quality downgrade `[VERIFIED]` `getMusicType(musicInfo, type, qualityList)`: if the source doesn't list the requested quality, use the source's lowest; then walk `QUALITYS` from that index upward and return the first quality the track actually has; fall back to `'128k'`.

### 7.4 Tag writing

`[VERIFIED]` `src/common/utils/musicMeta/index.js` dispatches on extension:

```js
exports.setMeta = (filePath, meta, proxy) => {
  switch (path.extname(filePath)) {
    case '.mp3':  mp3Meta(filePath, meta, proxy);  break
    case '.flac': flacMeta(filePath, meta, proxy); break
  }
}
```

**MP3** `[VERIFIED]` `mp3Meta.js` — `node-id3`:
```js
if (meta.lyrics) { meta.unsynchronisedLyrics = { language: 'zho', text: meta.lyrics }; delete meta.lyrics }
NodeID3.write(meta, filePath)
```
Cover: if `APIC` is an HTTP URL, download to a sibling `<name>.jpg|png` (NetEase URLs get `?param=500y500` appended), write, then `unlink` the temp image. If the download fails or the URL is invalid, drop `APIC` and write without art.

**FLAC** `[VERIFIED]` `flacMeta.js` — a **custom in-repo FLAC metadata processor** (`./flac-metadata/`, with `MetaDataBlock`, `MetaDataBlockPicture`, `MetaDataBlockStreamInfo`, `MetaDataBlockVorbisComment`):
```js
const comments = Object.keys(meta).map(key => `${key.toUpperCase()}=${meta[key] || ''}`)
const data = { vorbis: { vendor: 'reference libFLAC 1.2.1 20070917', comments } }
// + data.picture = { pictureType: 3, mimeType, width, height, bitsPerPixel, colors: 0, pictureData }
// streamed: createReadStream → FlacProcessor → createWriteStream(filePath + '.lxmtemp') → unlink original → rename
```
MIME sniffed from magic bytes (`FF D8 FF` → `image/jpeg`/24bpp, else `image/png`/32bpp).

**Fields written** `[VERIFIED]` `src/renderer/store/download/action.ts` `saveMeta()`:
```ts
{ filePath, isEmbedLyricLx, isEmbedLyricT, isEmbedLyricR,
  title:  musicInfo.name,
  artist: musicInfo.singer?.replaceAll('、', ';'),   // ← joined with ';' in tags
  album:  musicInfo.meta.albumName,
  APIC:   imgUrl }
```
plus `lyrics` (built by `buildLyrics(lyricInfo, isEmbedLyricLx, isEmbedLyricT, isEmbedLyricR)` from `lrcTool.ts`).

**Only MP3 and FLAC get tags.** `ape`, `wav`, `m4a` downloads are written as raw bytes with **no metadata at all** — and `saveMeta()` early-returns for `ape`.

**Sidecar `.lrc`** `[VERIFIED]` `saveLrc()` in `src/renderer/worker/download/utils.ts`:
```ts
const lrc = buildLyrics(lrcData, downloadLxlrc, downloadTlrc, downloadRlrc)
fs.writeFile(info.filePath, iconv.encode(lrc, format /* 'gbk' | 'utf8' */, { addBOM: true }), cb)
```
Path: `<filePath without extension>.lrc`. Note `addBOM: true` for both encodings.

A KuGou lyric-format repair exists: `fixKgLyric` rewrites `[00:MM:SS.xx]` → `[MM:SS.xx]`.

### 7.5 Download list persistence

`[VERIFIED]` SQLite table `download_list` (see §8.2) with columns `id, isComplate, status, statusText, progress_downloaded, progress_total, url, quality, ext, fileName, filePath, musicInfo, position`. Renderer keeps an in-memory `downloadList` and throttles DB writes to one flush per 100 ms (`throttleUpdateTask`). On app start, any `RUN`/`WAITING` task is coerced to `PAUSE`.

---

## 8. Data & storage layout

### 8.1 Paths

`[VERIFIED]` `src/main/app.ts` `setUserDataPath()`:

```ts
if (process.platform == 'win32') {
  const portablePath = path.join(path.dirname(app.getPath('exe')), '/portable')
  if (existsSync(portablePath)) {
    app.setPath('appData', portablePath)
    const appDataPath = path.join(portablePath, '/userData')
    if (!existsSync(appDataPath)) mkdirSync(appDataPath)
    app.setPath('userData', appDataPath)
  }
}
global.lxOldDataPath = app.getPath('userData')
global.lxDataPath = path.join(userDataPath, 'LxDatas')
```

Documented defaults `[VERIFIED]` <https://lxmusic.toside.cn/desktop/datapath>:

| OS | `userData` |
| --- | --- |
| Windows | `%APPDATA%\lx-music-desktop` |
| macOS | `~/Library/Application Support/lx-music-desktop` |
| Linux | `$XDG_CONFIG_HOME/lx-music-desktop` or `~/.config/lx-music-desktop` |

So on Windows everything of interest lives under:

```
%APPDATA%\lx-music-desktop\
├── (Chromium profile: Cache, GPUCache, Local Storage, Network, …)
└── LxDatas\                        ← global.lxDataPath
    ├── lx.data.db                  ← SQLite (WAL)
    ├── lx.data.db-wal
    ├── lx.data.db-shm
    ├── config_v2.json              ← app settings
    ├── data.json                   ← view state, playInfo, search history, list scroll/select
    ├── hot_key.json                ← local + global hotkeys
    ├── user_api.json               ← ★ imported custom source scripts
    ├── lyrics.json                 ← raw lyric cache
    ├── lyrics_edited.json          ← user-edited lyrics
    ├── sync.json                   ← sync config/state
    ├── theme.json                  ← user themes
    ├── sound_effect.json           ← EQ / convolution presets
    └── theme_images\               ← user theme background images
```

`[VERIFIED]` store names from `src/common/constants.ts`:
```ts
export const STORE_NAMES = {
  APP_SETTINGS: 'config_v2', DATA: 'data', SYNC: 'sync', HOTKEY: 'hot_key',
  USER_API: 'user_api', LRC_RAW: 'lyrics', LRC_EDITED: 'lyrics_edited',
  THEME: 'theme', SOUND_EFFECT: 'sound_effect',
} as const
```
Each maps to `<name>.json` inside `LxDatas` `[VERIFIED]` `src/main/utils/store.ts`:
```ts
const storePath = path.join(global.lxDataPath, name + '.json')
```

**The JSON store is a tiny hand-rolled class** `[VERIFIED]`:
- Reads whole file with `JSON.parse` on first access, caches in memory.
- `set(key, value)` / `override(obj)` → `writeFile()`.
- **Atomic write**: `JSON.stringify(store, null, '\t')` → `<path>.<random>.temp` → `fs.renameSync` onto the real path. `mkdirSync(dirPath, {recursive:true})` on `ENOENT`.
- Corruption handling: on parse failure it renames the file to `<path>.bak`, shows a native error dialog with the backup path, calls `shell.showItemInFolder`, and starts fresh.

**Legacy migration** `[VERIFIED]` `src/main/utils/migrate.ts` — pre-v2.0.0 data is imported once:
- `playList.json` → `listDataOverwrite()` into SQLite (`defaultList`, `loveList`, `tempList`, `userList`)
- `config.json` → legacy `config.setting` / `config.list`
- `lyrics_edited.json` → `editedLyricAdd()`
- `data.json` → new `data.json`
- `hotKey.json` → `hot_key.json` (renames `mainWindow`/`winLyric` types to `win_main`/`win_lyric`)
- `userApi.json` → copied to `user_api.json`

### 8.2 SQLite schema

`[VERIFIED]` `src/main/worker/dbService/tables.ts` and `db.ts`. Database: `<lxDataPath>/lx.data.db`, opened with `better-sqlite3` using an explicit `nativeBinding` path, `db.pragma('journal_mode = WAL')`, `PRAGMA optimize`, then a `verifyDB()` structure check. **`DB_VERSION = '2'`** recorded in `db_info`.

```sql
CREATE TABLE "db_info" (
  "id" INTEGER NOT NULL UNIQUE, "field_name" TEXT, "field_value" TEXT,
  PRIMARY KEY("id" AUTOINCREMENT));

CREATE TABLE "my_list" (
  "id" TEXT NOT NULL, "name" TEXT NOT NULL, "source" TEXT,
  "sourceListId" TEXT, "position" INTEGER NOT NULL, "locationUpdateTime" INTEGER,
  PRIMARY KEY("id"));

CREATE TABLE "my_list_music_info" (
  "id" TEXT NOT NULL, "listId" TEXT NOT NULL, "name" TEXT NOT NULL,
  "singer" TEXT NOT NULL, "source" TEXT NOT NULL, "interval" TEXT,
  "meta" TEXT NOT NULL,                        -- ← JSON blob of LX.Music.MusicInfoMeta
  UNIQUE("id","listId"));
CREATE INDEX "index_my_list_music_info" ON "my_list_music_info" ("id","listId");

CREATE TABLE "my_list_music_info_order" (
  "listId" TEXT NOT NULL, "musicInfoId" TEXT NOT NULL, "order" INTEGER NOT NULL);
CREATE INDEX "index_my_list_music_info_order"
  ON "my_list_music_info_order" ("listId","musicInfoId");

CREATE TABLE "music_info_other_source" (
  "source_id" TEXT NOT NULL, "id" TEXT NOT NULL, "source" TEXT NOT NULL,
  "name" TEXT NOT NULL, "singer" TEXT NOT NULL, "meta" TEXT NOT NULL,
  "order" INTEGER NOT NULL, UNIQUE("source_id","id"));
CREATE INDEX "index_music_info_other_source"
  ON "music_info_other_source" ("source_id","id");

CREATE TABLE "lyric" (
  "id" TEXT NOT NULL, "source" TEXT NOT NULL, "type" TEXT NOT NULL, "text" TEXT NOT NULL);

CREATE TABLE "music_url" ("id" TEXT NOT NULL, "url" TEXT NOT NULL);

CREATE TABLE "download_list" (
  "id" TEXT NOT NULL, "isComplate" INTEGER NOT NULL, "status" TEXT NOT NULL,
  "statusText" TEXT NOT NULL, "progress_downloaded" INTEGER NOT NULL,
  "progress_total" INTEGER NOT NULL, "url" TEXT, "quality" TEXT NOT NULL,
  "ext" TEXT NOT NULL, "fileName" TEXT NOT NULL, "filePath" TEXT NOT NULL,
  "musicInfo" TEXT NOT NULL, "position" INTEGER NOT NULL, PRIMARY KEY("id"));

CREATE TABLE "dislike_list" ("type" TEXT NOT NULL, "content" TEXT NOT NULL, "meta" TEXT);
```

**Schema design notes worth copying:**
- Playlist *metadata* and playlist *membership* are separate tables; ordering lives in `my_list_music_info_order` (`listId, musicInfoId, order`). This makes reordering O(1) row updates rather than rewriting a JSON array.
- Track identity is `(id, listId)` — the same song can be in many lists with per-list metadata.
- Track identity `id` is source-scoped: `toNewMusicInfo` builds `${source}_${songmid}`, with `kg` using `${songmid}_${hash}` and `local` using the **file path** `[VERIFIED]` `src/common/utils/tools.ts`.
- `music_url` is a **URL cache keyed by track id only** — *not* by quality, even though `saveMusicUrl(musicInfo, quality, url)` takes a quality. `[VERIFIED]` — this is arguably a latent bug: switching quality can serve a stale cached URL.
- `lyric` has a `type` column (`raw` / `edited`) distinguishing the raw fetched lyric from the user's edit.
- `dislike_list` has `type` (artist / song / artist+song), `content`, `meta`.

**Table registry:** `tables` is a `Map<Tables, string>` of DDL strings joined with `\n` and executed in one `db.exec()` on creation.

### 8.3 Where custom source scripts are stored

`[VERIFIED]` `src/main/modules/userApi/utils.ts` — **the most useful detail for anyone building a compatible player**:

```ts
const deflateScript = async (script: string) => new Promise<string>((resolve, reject) => {
  zlib.deflate(Buffer.from(script, 'utf8'), (err, buf) => {
    if (err) return reject(err)
    resolve('gz_' + buf.toString('base64'))
  })
})
const inflateScript = async (script: string) => new Promise<string>((resolve, reject) => {
  if (script.startsWith('gz_')) {
    zlib.inflate(Buffer.from(script.substring(3), 'base64'), (err, buf) => { … resolve(buf.toString('utf8')) })
  } else resolve(script)   // ← legacy plain-text scripts still load
})
```

So `LxDatas/user_api.json` holds:
```jsonc
{ "userApis": [ {
    "id": "user_api_<3 random digits>_<Date.now()>",
    "name": "...", "description": "...", "author": "...",
    "homepage": "...", "version": "...",
    "allowShowUpdateAlert": true,
    "script": "gz_<base64 of zlib-deflated UTF-8 script source>"
} ] }
```

**Header parsing on import** `[VERIFIED]` — the script **must** begin with a `/** ... */` block comment or import throws `无效的自定义源文件`:
```ts
const result = /^\/\*[\S|\s]+?\*\//.exec(script)
const matchInfo = (scriptInfo) => {
  const rxp = /^\s?\*\s?@(\w+)\s(.+)$/     // e.g. " * @name 测试音乐源"
  const INFO_NAMES = { name: 24, description: 36, author: 56, homepage: 1024, version: 36 }
  // values longer than the cap are truncated with '...'
}
scriptInfo.name ||= `user_api_${new Date().toLocaleString()}`
```

Duplicate import is rejected by comparing the *deflated* string against existing entries. Note there is **no "在线导入" IPC handler in the desktop app** — `[VERIFIED]` `ipcNames.ts` exposes only `import_user_api` (taking script text). The "在线导入" button is implemented in the renderer by fetching the URL and passing the text. (Mobile v1.3.0 explicitly added "在线自定义源导入功能，允许通过http/https链接导入自定义源".)

**No separate directory of `.js` files exists.** Everything is inside `user_api.json`.

---

## 9. The custom-source ("音源") subsystem — the crown jewel

This is the most valuable thing to understand and reimplement, because **it is the de facto interoperability standard for the whole Chinese third-party music-player ecosystem.**

### 9.1 Sandbox mechanics

`[VERIFIED]` `src/main/modules/userApi/main.ts` `createWindow(userApi)`:

```ts
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
    preload: preloadUrl,
  },
})
for (const eventName of ['will-navigate','will-redirect','will-attach-webview',
                         'will-prevent-unload','media-started-playing'])
  browserWindow.webContents.on(eventName, e => e.preventDefault())
browserWindow.webContents.session.setPermissionRequestHandler((wc, permission, resolve) =>
  resolve(wc === browserWindow?.webContents ? false : true))
browserWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
await browserWindow.loadURL('data:text/html;charset=UTF-8,' + encodeURIComponent(html))
browserWindow.on('ready-to-show', async () => {
  sendEvent(USER_API_RENDERER_EVENT_NAME.initEnv,
    { ...userApi, script: await getScript(userApi.id), proxy: getProxy() })
})
```

Key properties:
- Loaded from a **`data:` URL** — no origin, no file access.
- `contextIsolation: true` — the script cannot touch the preload's own scope; it only sees what `contextBridge` exposes.
- Navigation, redirects, webviews, window-open, permissions all **denied**.
- The window is hidden; `openDevTools: true` in the script's `inited` payload opens DevTools for debugging.
- On `closeWindow()` the session's auth cache, storage data, and HTTP cache are cleared, and the window is destroyed. **One source at a time** — `setApi(id)` closes the previous sandbox first.
- Proxy support: `network.proxy.*` settings or `--proxy-server` are injected, and `proxyUpdate` is pushed on config change.

The preload then executes the user script:
```ts
webFrame.executeJavaScript(userApi.script).catch(_ => _)
```
and installs global error hooks that report the *first* error as an init failure:
```ts
window.addEventListener('error', e => { if (e.isTrusted) globalThis.__lx_init_error_handler__.sendError(...) })
window.addEventListener('unhandledrejection', e => { … })
```

### 9.2 The `globalThis.lx` API surface

`[VERIFIED]` `src/main/modules/userApi/renderer/preload.js` + official docs <https://lxmusic.toside.cn/desktop/custom-source>.

```ts
contextBridge.exposeInMainWorld('lx', {
  EVENT_NAMES,                 // { request:'request', inited:'inited', updateAlert:'updateAlert' }
  request(url, { method='get', timeout, headers, body, form, formData }, callback) { … },
  send(eventName, data) { … },  // → Promise
  on(eventName, handler) { … }, // → Promise; only 'request' is accepted
  utils: {
    crypto: { aesEncrypt(buffer, mode, key, iv), rsaEncrypt(buffer, key),
              randomBytes(size), md5(str) },
    buffer: { from(...args), bufToString(buf, format) },
    zlib:   { inflate(buf), deflate(data) },
  },
  currentScriptInfo: { name, description, version, author, homepage, rawScript },
  version: '2.0.0',
  env: 'desktop',
})
```

**`lx.request`** wraps the forked `needle`, applies the proxy via `tunnel`'s `httpsOverHttp`/`httpOverHttp`, and **caps `response_timeout` at 60 000 ms** (`Math.min(timeout, 60_000)`, default 60 s). It returns an abort function. The response callback receives `(err, { statusCode, statusMessage, headers, bytes, raw, body }, body)`, with `body` JSON-parsed when possible.

**`lx.utils` implementation reality — the docs undersell what these actually are:**

- `crypto.rsaEncrypt(buffer, key)` left-pads the buffer to 128 bytes and encrypts with **`RSA_NO_PADDING`**. This is a **raw-RSA primitive shaped specifically for reproducing Chinese music-platform `weapi`/`eapi` handshakes**, not a general-purpose helper. (Mobile maps it to Java `RSA/ECB/NoPadding`.)
- `crypto.aesEncrypt(buffer, mode, key, iv)` passes `mode` **straight into Node's `createCipheriv`**, so on desktop *any* OpenSSL cipher name works; mobile hard-limits to `aes-128-cbc`/`aes-128-ecb`.
- `crypto.md5(str)` returns a **hex string**.
- `zlib.inflate`/`deflate` are **commented out entirely on mobile** (the docs strike them through).

**Mobile sandbox restrictions** `[VERIFIED]` (docs have a dedicated section, and the QuickJS engine explains them — see §2.5): no `openDevTools` option; `zlib` unimplemented; partial `buffer`/`crypto`; **the only host APIs available are `setTimeout`/`clearTimeout`**; all built-in prototypes are frozen except three `toString` methods; and **`eval` throws — `Function.prototype.constructor` is a Proxy that throws `'Dynamic code execution is not allowed.'`** That last one is why obfuscated sources relying on `Function(...)` string decoders can work on desktop but fail on mobile.

**`lx.send`** accepts only `inited` (once) and `updateAlert` (once). Anything else rejects with `The event is not supported: <name>`.

**`lx.on`** accepts only `request`. The registered handler **must return a Promise**.

### 9.3 The source contract

**Script header (mandatory, must be the first thing in the file):**

```js
/**
 * @name 测试脚本
 * @description 我只是一个测试脚本
 * @version 1.0.0
 * @author xxx
 * @homepage http://xxx
 */
```
Caps: `name` 24, `description` 36, `version` 36, `author` 56, `homepage` 1024 chars.

**Init handshake:**

```js
const { EVENT_NAMES, request, on, send } = globalThis.lx

on(EVENT_NAMES.request, ({ source, action, info }) => {
  switch (action) {
    case 'musicUrl': return apis[source].musicUrl(info.musicInfo, qualitys[source][info.type])
    case 'lyric':    return apis[source].lyric(info.musicInfo)
    case 'pic':      return apis[source].pic(info.musicInfo)
  }
})

send(EVENT_NAMES.inited, {
  openDevTools: false,
  sources: {
    kw: { name:'酷我音乐', type:'music', actions:['musicUrl'],
          qualitys:['128k','320k','flac','flac24bit'] },
    local: { name:'本地音乐', type:'music',
             actions:['musicUrl','lyric','pic'], qualitys: [] },
  },
})
```

**Hard-coded source keys and capabilities** `[VERIFIED]` from the preload — a reimplementation must match these exactly:

```js
const allSources = ['kw', 'kg', 'tx', 'wy', 'mg', 'local']
const supportQualitys = {
  kw: ['128k','320k','flac','flac24bit'],  kg: ['128k','320k','flac','flac24bit'],
  tx: ['128k','320k','flac','flac24bit'],  wy: ['128k','320k','flac','flac24bit'],
  mg: ['128k','320k','flac','flac24bit'],  local: [],
}
const supportActions = {
  kw: ['musicUrl'], kg: ['musicUrl'], tx: ['musicUrl'],
  wy: ['musicUrl'], mg: ['musicUrl'], xm: ['musicUrl'],
  local: ['musicUrl', 'lyric', 'pic'],
}
```

`init` intersects the script's declared `actions`/`qualitys` with these allow-lists, so **a script cannot grant itself capabilities the host doesn't permit**. Only `local` supports `lyric` and `pic`. Sources not in `allSources` are silently dropped.

> **⭐ The `qualitys` field is widely misunderstood — get this right.** It is **not** a promise about what quality the source can actually deliver. It is the **filter that populates the app's quality dropdown**, and the runtime intersects it against a fixed whitelist: `qualitys.filter(q => userSource.qualitys.includes(q))`. Consequently, values like `hires`, `atmos`, `master`, `192k` and `ape` are **silently discarded** — a script can declare them and they simply never appear. The same intersection applies to `actions`: declaring `['musicUrl','search']` yields `['musicUrl']`, and **`'search'` is not a valid action at all**. A reimplementation must reproduce this exact whitelist-and-intersect behaviour, including the silent discard, or scripts will behave differently against it.

> **Two dead source keys.** `xm` (虾米音乐) appears in `supportActions` but **not** in `allSources` — it has been orphaned since custom sources shipped (desktop v1.8.0 release notes: *"移除虾米源"*). `bd` (百度音乐) is likewise absent from `allSources`. Both are unusable and are vestigial code.

**Response validation** `[VERIFIED]` `handleRequest`:

| action | validation |
| --- | --- |
| `musicUrl` | must be a `string`, `length <= 2048`, and match `/^https?:/` |
| `pic` | must be a `string`, `length <= 2048`, and match `/^https?:/` |
| `lyric` | must be an object with a `string` `lyric`; `lyric.length <= 51200`; `tlyric`/`rlyric` strings `< 5120` else null; `lxlyric` string `< 8192` else null |

Returned shape for `musicUrl`:
```js
{ source, action: 'musicUrl', data: { type: info.type, url: response } }
```
The renderer wraps this as `{ type, url }` `[VERIFIED]` `useInitUserApi.ts`.

**`lxlyric` (逐字 / karaoke lyric) format** `[VERIFIED]` from the docs:
```
[mm:ss.mmm]<startOffset,duration>char<startOffset,duration>char...
例如： [00:00.000]<0,36>测<36,36>试<50,60>歌<80,75>词
```

**Update alerts:** `lx.send(lx.EVENT_NAMES.updateAlert, { log, updateUrl })` — once per run; `log` ≤1024 chars, `updateUrl` must be http(s) ≤1024. Surfaced to the user via `user_api_show_update_alert` unless the user disabled `allowShowUpdateAlert` for that source.

### 9.4 Request plumbing and timeouts

`[VERIFIED]` `src/main/modules/userApi/rendererEvent/rendererEvent.ts`:

```ts
export const request = async ({ requestKey, data }) => new Promise((resolve, reject) => {
  …
  timeouts.set(requestKey, setTimeout(() => cancelRequest(requestKey), 20000))  // 20 s host-side cap
  requestQueue.set(requestKey, [resolve, reject, data])
  sendRequest({ requestKey, data })
})
```

So a script has **20 seconds** to return a Promise resolution per request (host-side), and each internal `lx.request` gets up to **60 seconds**. The renderer additionally aborts a pending source request when `appSetting['common.apiSource']` changes (`useInitUserApi.ts`).

`requestKey` is generated as `` `request__${Math.random().toString().substring(2)}` ``.

### 9.5 How the app consumes sources

`[VERIFIED]` `src/renderer/core/useApp/useInitUserApi.ts` builds an adapter object mirroring the built-in SDK shape:

```ts
apis[source].getMusicUrl = (songInfo, type) => ({ canceleFn, promise })
apis[source].getLyric    = (songInfo)        => ({ canceleFn, promise })
apis[source].getPic      = (songInfo)        => ({ canceleFn, promise })
qualityList.value = qualitys                  // per-source quality list
userApi.apis = apis
```

This means **the built-in SDK adapters and custom-source adapters are interchangeable** behind one interface — `src/renderer/utils/musicSdk/api-source.js`:

```js
const apis = source => {
  if (/^user_api/.test(apiSource.value)) return userApi.apis[source]
  let api = getAPI(source)
  if (api) return api
  throw new Error('Api is not found')
}
```

And `[VERIFIED]` `api-source-info.ts` — **the list of built-in API sources is completely empty** (every entry commented out). Combined with the 2023 source removal, this confirms: **the shipping app has no working built-in source. It is a shell that only plays local files until the user imports a custom source.**

`assertApiSupport(source)` = `source === 'local' || qualityList.value[source] != null` `[VERIFIED]` `src/renderer/store/utils.ts`.

### 9.6 Built-in platform SDKs (still present in source)

`[VERIFIED]` `src/renderer/utils/musicSdk/`:

```
index.js                 — source registry + searchMusic() + findMusic() cross-source matcher
api-source.js            — dispatcher: built-in API vs user_api
api-source-info.ts       — EMPTY list of built-in API sources
options.js, utils.js, xm.js
kw/  kg/  tx/  wy/  mg/  bd/    — per-platform modules
```

`index.js` registers `kw (酷我音乐), kg (酷狗音乐), tx (QQ音乐), wy (网易音乐), mg (咪咕音乐), xm (虾米音乐)`, with `bd (百度音乐)` commented out, and **excludes `xm` from cross-source search**. Each platform module exposes `musicSearch`, `getMusicUrl`, `getLyric`, `getPic`, `getTopLists`, `getListDetail`, `getComment`, `init`, etc. These implement the platforms' public/undocumented web APIs (including signature/encryption schemes) — **they are the highest-legal-risk and highest-maintenance part of the codebase, and the part the author already had to abandon.**

---

## 10. Key module map

One line per entry. `[VERIFIED]` from the git tree unless noted.

### 10.1 Root

| Path | Purpose |
| --- | --- |
| `package.json` | Deps, scripts, `"license": "Apache-2.0"`, version 2.12.2 |
| `LICENSE` | Verbatim Apache License 2.0 |
| `licenses/license_zh.txt` / `license_en.txt` / `license.rtf` | The supplementary agreement (installer + in-app display) |
| `README.md` | Project description + 项目协议 (the supplementary terms) |
| `FAQ.md` | Stub — "本文档已迁移至 https://lyswhut.github.io/lx-music-doc/desktop/faq" |
| `CHANGELOG.md` | 111 KB release history |
| `build-config/` | Webpack configs (main/renderer/renderer-lyric/renderer-scripts), `pack.js`, `build-pack.js`, `runner-dev.js`, prebuilt `.node` libs |
| `publish/` | Release automation: `version.json` (110 KB version-info feed), COS upload, GitHub release |
| `resources/icons/` | App icons |
| `doc/images/` | README screenshots |
| `postcss.config.js`, `tsconfig.json`, `jsconfig.json`, `.eslintrc*` | Tooling |

### 10.2 `src/common/` — shared between processes

| Path | Purpose |
| --- | --- |
| `constants.ts` | `STORE_NAMES`, `LIST_IDS`, `DATA_KEYS`, `DOWNLOAD_STATUS`, `QUALITYS`, `URL_SCHEME_RXP` |
| `defaultSetting.ts` | **Every** app setting with its default (~150 keys) |
| `defaultHotKey.ts` | Default local/global hotkey maps |
| `ipcNames.ts` | Central namespaced IPC channel-name table |
| `mainIpc.ts` | Main-side IPC wrappers (`mainHandle`/`mainOn`/`mainSend`) |
| `rendererIpc.ts` | Renderer-side IPC wrappers |
| `config.ts` | `windowSizeList`, `navigationUrlWhiteList` |
| `hotKey.ts` | Hotkey action definitions |
| `error.ts` | Global error handlers |
| `constants_sync.ts` | Sync protocol constants |
| `types/*.d.ts` | The `LX` ambient namespace — `music.d.ts`, `list.d.ts`, `user_api.d.ts`, `app_setting.d.ts`, `download_list.d.ts`, `sound_effect.d.ts`, `player.d.ts`, `open_api.d.ts`, `sync.d.ts`, `theme.d.ts`, … |
| `utils/tools.ts` | `toNewMusicInfo` / `toOldMusicInfo` (old↔new track shape), `formatMusicName`, `clipNameLength`, `clipFileNameLength`, `filterMusicList` |
| `utils/common.ts` | `filterFileName`, `formatPlayTime`, `encodePath`, `isUrl`, `throttle` |
| `utils/nodejs.ts` | `checkPath`, `readFile`, `getFileStats`, `joinPath`, `extname`, `basename`, `checkAndCreateDir`, `removeFile` |
| `utils/electron.ts` | `openUrl`, `openDirInExplorer` |
| `utils/download/` | `Downloader.ts` (resumable HTTP), `request.ts`, `util.ts` (`STATUS`), `index.ts` |
| `utils/musicMeta/` | Tag writing: `index.js` dispatcher, `mp3Meta.js` (node-id3), `flacMeta.js`, `flac-metadata/` (custom FLAC block writer), `downloader.js` |
| `utils/lyricUtils/` | `kg.js` (`decodeKrc`), `util.ts` (`decodeName` HTML-entity decoder) |
| `utils/lyric-font-player/` | Karaoke-style per-character lyric rendering (`font-player.js`, `line-player.js`) |
| `utils/pinyin/` | `parser.js` + `pinyin.json` + `kMandarin_8105.txt` — Chinese sorting/search |
| `utils/migrateSetting.ts` | Setting-key renames across versions |
| `utils/effects/` | `cursor-effects/bubbleCursor.js`, `snow.min.js` (decorative) |
| `theme/` | `index.json` (built-in themes), `createThemes.js`, `colorUtils.js`, theme images |
| `lang/` | `zh-cn.json`, `zh-tw.json`, `en-us.json`, `i18n.ts`, `languages.json` |

### 10.3 `src/main/` — Electron main process

| Path | Purpose |
| --- | --- |
| `index.ts` | Entry: init order (`initGlobalData → singleInstance → envParams → userDataPath → deeplink → listeners → whenReady`) |
| `app.ts` | `global.lx` construction, portable-path handling, deep links, `web-contents-created` guards, theme, DB backup/verify, `initAppSetting` |
| `index-dev.ts` | Dev-mode entry |
| `modules/index.ts` | Module registration order |
| `modules/winMain/` | Main window: `main.ts` (BrowserWindow + session proxy), `index.ts`, `autoUpdate.ts` (electron-updater), `utils.ts` (thumbar buttons, window sizes) |
| `modules/winMain/rendererEvent/` | All `winMain_*` IPC handlers: `app.ts`, `data.ts`, `download.ts`, `hotKey.ts`, `music.ts` (lyric/url/otherSource CRUD), `openAPI.ts`, `process.ts`, `soundEffect.ts`, `sync.ts`, `userApi.ts`, `kw_decodeLyric.ts`, `tx_decodeLyric.ts` |
| `modules/winLyric/` | Desktop-lyric overlay window (frameless/transparent/always-on-top, mouse pass-through, config, bounds persistence) |
| `modules/userApi/` | **Custom-source subsystem**: `index.ts` (public API), `main.ts` (sandbox BrowserWindow), `utils.ts` (import/remove/deflate/header-parse), `renderer/preload.js` (**the `lx` API**), `renderer/user-api.html`, `rendererEvent/` (init/response/timeout queue) |
| `modules/openApi/index.ts` | Local HTTP server for third-party control (§11) |
| `modules/sync/` | Data sync: `client/` and `server/` (auth, list sync, dislike sync, snapshots), `listEvent.ts`, `dislikeEvent.ts`, `migrate.ts` |
| `modules/tray.ts` | System tray |
| `modules/appMenu.ts` | Application menu |
| `modules/hotKey/` | Local + global shortcut registration |
| `modules/commonRenderers/` | Shared `common` / `list` / `dislike` renderer bridges |
| `event/` | Main-side event emitters: `AppEvent.ts`, `ListEvent.ts`, `DislikeEvent.ts` |
| `utils/index.ts` | Setting merge/save, hotkey init, themes, power-save blocker, proxy resolution, `parseEnvParams` |
| `utils/store.ts` | The tiny atomic-write JSON store class |
| `utils/migrate.ts` | Pre-v2.0.0 data migration |
| `utils/request.ts` | Main-process HTTP (`undici`), proxy wiring |
| `utils/logInit.ts`, `utils/fontManage.ts` | `electron-log` setup; `font-list` |
| `worker/dbService/` | SQLite worker: `db.ts` (open/WAL/verify), `tables.ts` (DDL + `DB_VERSION`), `verifyDB.ts`, `migrate.ts`, `modules/{list,lyric,music_url,music_other_source,download,dislike_list}/` (each with `index.ts`, `dbHelper.ts`, `statements.ts`) |
| `types/*.d.ts` | Main-side ambient types incl. `db_service.d.ts` |

### 10.4 `src/renderer/` — main window (Vue app)

| Path | Purpose |
| --- | --- |
| `main.ts` | `createApp(App).use(router).use(i18nPlugin)`; language bootstrap |
| `App.vue` | Layout shell: `<layout-aside> <layout-toolbar> <layout-view> <layout-play-bar>` + modals |
| `router.ts` | Routes: `/search`, `/songList`, `/leaderboard`, `/list`, `/download`, `/setting` |
| `core/useApp/index.ts` | The app composable that wires everything |
| `core/useApp/useDataInit.ts` | Loads user lists, dislike list, restores last playback |
| `core/useApp/useInitUserApi.ts` | **Builds the `{getMusicUrl,getLyric,getPic}` adapters from a loaded source** |
| `core/useApp/usePlayer/` | 16 composables: `usePlayer`, `usePlayEvent`, `usePlayProgress`, `usePlayStatus`, `useLyric`, `useVolume`, `useSoundEffect`, `usePlaybackRate`, `useMediaDevice`, `useMediaSessionInfo`, `useMaxOutputChannelCount`, `usePreloadNextMusic`, `useWatchList`, … |
| `core/useApp/useSync.ts` / `useOpenAPI.ts` / `useStatusbarLyric.ts` / `useUpdate.ts` / `useSettingSync.ts` / `useDeeplink.ts` / `useHandleEnvParams.ts` / `useEventListener.ts` / `listAutoUpdate.ts` | Feature composables |
| `core/music/index.ts` | Facade re-exporting online/local/download music accessors |
| `core/music/online.ts` | Online URL/pic/lyric resolution with caching |
| `core/music/local.ts` | **Local file playback + online fallback chain** |
| `core/music/download.ts` | Download-list track URL/pic/lyric resolution |
| `core/music/utils.ts` | `getOtherSource`, `getPlayQuality`, `handleGetOnlineMusicUrl/PicUrl/LyricInfo`, cross-source retry |
| `core/player/` | `action.ts` (play/pause/next/prev/collect), `timeoutStop.ts` (sleep timer), `utils.ts` |
| `core/apiSource.ts` | Source switching + `apiInitPromise` gate |
| `core/lyric.ts` | Lyric state orchestration |
| `core/dislikeList.ts` | Dislike-rule matching |
| `core/globalData.ts` | `window.lxData` globals |
| `plugins/player/index.ts` | **The audio engine** (`<audio>` + Web Audio graph) |
| `plugins/player/pitch-shifter/phase-vocoder.js` | AudioWorklet pitch shifter |
| `plugins/{Dialog,Tips,SvgIcon,i18n}` | In-house UI plugins |
| `store/` | Hand-rolled stores: `index.ts`, `setting.ts`, `soundEffect.ts`, `hotSearch.ts`, `utils.ts`, `player/`, `list/` (+ `listManage/`), `download/`, `search/`, `songList/`, `leaderboard/`, `dislikeList/` |
| `store/list/listManage/` | `action.ts`, `state.ts`, `rendererListManage.ts`, `index.ts` — playlist CRUD |
| `utils/ipc.ts` | Typed wrappers over every renderer→main channel |
| `utils/music.ts` | `createLocalMusicInfo`, `getLocalMusicFilePic`, `getLocalMusicFileLyric`, file-availability checks |
| `utils/musicSdk/` | Built-in platform SDKs (`kw/ kg/ tx/ wy/ mg/ bd/ xm.js`) + `api-source.js` dispatcher + `findMusic` matcher |
| `utils/request.js` | Renderer HTTP |
| `utils/{data,keyBind,message,update,pickrTools,env}.ts` | Misc |
| `utils/simplify-chinese-main/` | Simplified↔Traditional conversion (for `player.isS2t`) |
| `worker/index.ts` + `worker/download/` | Web Worker: `download.ts` (task lifecycle/retry), `utils.ts` (filename/quality/lrc), `common.ts` (`writeMeta`), `lrcTool.ts` (`buildLyrics`) |
| `components/layout/` | `Aside/`, `Toolbar/`, `PlayBar/`, `PlayDetail/`, `View.vue`, `Icons.vue`, `PactModal.vue`, `ChangeLogModal.vue`, `UpdateModal.vue`, `SyncModeModal.vue`, `SyncAuthCodeModal.vue` |
| `components/material/` | `SongList.vue`, `ListButtons.vue`, `Modal.vue`, `Pagination.vue`, `PopupBtn.vue`, `SearchInput.vue`, `OnlineList/` |
| `components/base/`, `components/common/` | Primitive + shared components |
| `views/Search/`, `views/songList/`, `views/Leaderboard/`, `views/List/`, `views/Download/`, `views/Setting/` | Feature pages |

### 10.5 Other renderer processes

| Path | Purpose |
| --- | --- |
| `src/renderer-lyric/` | Desktop-lyric overlay app (separate webpack bundle) |
| `src/static/` | Static assets |

---

## 11. Integration surfaces a compatible player should offer

These are the public, documented contracts — and because the docs are **MIT**, you may reimplement them exactly.

### 11.1 开放 API (Open API) — `[VERIFIED]` <https://lxmusic.toside.cn/desktop/open-api>

Local HTTP server, default `127.0.0.1:23330` (`openAPI.port`), optional LAN bind (`openAPI.bindLan`, `0.0.0.0`). CORS `Access-Control-Allow-Origin: *`. Sockets have a 4 s timeout; unknown paths return `401 Forbidden`.

| Endpoint | Method | Notes |
| --- | --- | --- |
| `/status?filter=a,b,c` | GET | JSON player status |
| `/lyric` | GET | Current LRC as `text/plain` |
| `/lyric-all` | GET | `{lyric, tlyric, rlyric, lxlyric}` |
| `/subscribe-player-status?filter=…` | GET | **SSE** stream; emits `event: <key>\ndata: <json>\n\n` |
| `/play` `/pause` `/skip-next` `/skip-prev` | GET | Transport |
| `/seek?offset=<sec>` | GET | 400 if out of range |
| `/volume?volume=1..100` | GET | 400 if out of range |
| `/mute?mute=true\|false` | GET | |
| `/collect` `/uncollect` | GET | |

Status fields: `status` (`playing`/`paused`/`error`/`stoped`), `name`, `singer`, `albumName`, `duration`, `progress`, `playbackRate`, `picUrl` (HTTP or Data URL), `lyricLineText`, `lyricLineAllText`, `lyric`, `tlyric`, `rlyric`, `lxlyric`, `collect`, `volume`, `mute`.
Default filter: `status,name,singer,albumName,lyricLineText,duration,progress,playbackRate`.

### 11.2 Scheme URL — `[VERIFIED]` <https://lxmusic.toside.cn/desktop/scheme-url>

Protocol `lxmusic://`, registered via `app.setAsDefaultProtocolClient('lxmusic')`. Two parameter styles: `?data=<urlencoded JSON>` and path segments.

| Purpose | URL |
| --- | --- |
| Open playlist | `songlist/open` — `source`, `id`\|`url` |
| Play playlist | `songlist/play` — `source`, `id`\|`url`, `index` |
| Search | `music/search` — `keywords`, `source?` |
| Play a specific track | `music/play` — `name`, `singer`, `source`, `songmid`, `types[]`, + per-platform `hash`/`strMediaMid`/`albumMid`/`copyrightId`/`lrcUrl`/`trcUrl`/`mrcUrl` |
| Search & play | `music/searchPlay` — `name`, `singer?`, `albumName?`, `interval?`, `playLater?` |
| Player control | `player/play`, `player/pause`, `player/skipNext`, `player/skipPrev`, `player/togglePlay`, `player/collect`, `player/uncollect`, `player/dislike` |

Single-instance forwarding: a second launch with an `lxmusic://` argv routes the deeplink to the running instance `[VERIFIED]` `app.ts`.

### 11.3 Command-line parameters — `[VERIFIED]` <https://lxmusic.toside.cn/desktop/run-params> + `parseEnvParams` in `app.ts`

| Flag | Since | Effect |
| --- | --- | --- |
| `-search="突然的自我 - 伍佰"` | — | Search on startup |
| `-dha` | v1.6.0 | Disable hardware acceleration |
| `-dt` | v1.6.0 (renamed from `-nt`) | Non-transparent window mode (Win7 without Aero) |
| `-hidden` | v2.12.0 | Start minimised to tray (also force-enables the tray setting) |
| `-dhmkh` | v1.9.0 | Disable Chromium Hardware Media Key Handling |
| `-proxy-server="127.0.0.1:1081"` | v1.17.0 | Proxy **all** app traffic (no auth support) |
| `-proxy-bypass-list="<local>;*.x.com"` | v1.17.0 | Semicolon-separated bypass list; only valid with `-proxy-server` |
| `-play="type=songList&source=…"` | — | Play a list on startup. `source` ∈ `kw/kg/tx/wy/mg/myList`; `link` required for online sources (URL-encode it), `name` required for `myList`, `index` optional (0-based) |
| `-odt` | — | Open DevTools (undocked) on startup — `[VERIFIED]` in `winMain/main.ts`, not in the public docs |

Note the documented priority rule: **in-app 设置→网络设置→HTTP 代理 has higher priority than `-proxy-server`**, and `-proxy-bypass-list` does not apply to in-app API requests. In `app.ts`, `-proxy-server` is applied both as a Chromium command-line switch and (via `getProxy()`) to the source sandbox and downloader.

### 11.4 Data sync — `[VERIFIED]`

Two modes (`sync.mode`: `'server'` | `'client'`), default port `23332`, `sync.server.maxSsnapshotNum: 5`. Server mode runs an HTTP+WS server with an auth code and a list of authenticated devices; client mode connects to it. A standalone server project exists: [`lyswhut/lx-music-sync-server`](https://github.com/lyswhut/lx-music-sync-server). The docs warn: **"由于同步传输时的数据是明文的，请在受信任的网络下使用此功能！"** — plaintext transport.

---

## 12. The 音源 ecosystem (conceptual)

> This section is largely `[REPORTED]` community context rather than `[VERIFIED]` source fact. It is included because it explains *why* the architecture looks the way it does.

### 12.1 What happened, and when

`[VERIFIED]` — documented officially at <https://lxmusic.toside.cn/desktop/faq/cannot-play-and-download>:

> 由于收到腾讯投诉，要求停止内置其平台的在线播放及下载服务，所以从 **2023-10-18** 起，LX Music 本身不再提供上述服务——桌面版 **v2.6.0 移除了所有内置自定义源**，且旧版本内置的源也已失效。你需要编写或寻找别人分享的自定义源导入，才可正常使用。

`[VERIFIED]` The same change is recorded in the mobile changelog for v1.2.0: *"移除所有内置源，由于收到腾讯投诉要求停止提供软件内置的连接到他们平台的在线播放及下载服务，所以从即日（2023年10月18日）起LX本身不再提供上述服务"*.

`[VERIFIED]` **The author's own primary account** — issue [#1643 "LX 以后的发展方向"](https://github.com/lyswhut/lx-music-desktop/issues/1643), opened by `lyswhut` (`author_association: "OWNER"`) on 2023-10-22, **still open**, **222 comments, 775 reactions**, body verbatim:

> 虽然我们之前做了一些努力（如锁定音质为128k、非推荐的默认设置等），但这一天终究还是到来，
> **LX于2023年10月18日收到了腾讯的警告信**，要求停止提供软件内置的连接到他们平台的在线播放及下载服务，所以我们决定关停内置的"临时接口"与"测试接口"。
>
> 目前LX没有计划停更，但现有版本将只修复bug，暂停开发新功能。
> 目前仍然在考虑以后的发展方向，为了使LX成为一个符合中国法律法规的项目，**已经确定的是以后不会有原来那种自带开箱即用的聚合各平台的功能**。

Three things matter here: the mechanism is a **警告信 (warning letter)**, not a DMCA; the author had **already pre-emptively degraded the app** (locking quality to 128k, non-recommended defaults) as risk mitigation *before* the letter arrived; and the architectural consequence — no bundled aggregator — was declared **permanent** at that moment.

`[VERIFIED]` The `api-source-info.ts` array of built-in API sources is **entirely commented out** in the current `master`; `src/main/modules/userApi/config/index.ts` exports `userApis` as an **empty array**. The shipping app today has zero working built-in sources.

`[VERIFIED]` **Issue [#1912 "LX Music 项目发展调整与新项目计划"](https://github.com/lyswhut/lx-music-desktop/issues/1912)** (by `lyswhut`, created 2024-05-26, open, 88 comments, 887 reactions) is the project-direction statement referenced from the README and the mobile v1.4.x changelog: *"随着大家对音乐版权的重视，以及来自官方音乐平台的压力，这条路已难以走下去…LX 也将逐渐进入维护模式。"* The plan keeps the architecture and **re-points the data source** away from streaming platforms toward self-hosted/WebDAV libraries, adding a VS Code-style extension API. See §2.6c for the resulting project.

> **Terminology caution.** The CHANGELOG and FAQ say **投诉** (complaint); the author's issue says **警告信** (warning letter); some press reportedly said **律师函** (lawyer's letter). These are legally distinct instruments. Only **警告信** is primary-sourced, from the author himself.

> **On DMCA:** a repo-wide GitHub issue search for `DMCA` returns exactly one issue — #1643 — where the term appears only in *user comments*, never in any official statement. The sole claim of a DMCA takedown traces to an AIGC-labelled article that also fabricates the entire source API contract. Both repos are `archived: false, disabled: false`. **There is no evidence of a DMCA takedown.** `[INFERENCE]` This is also the expected result: a DMCA is a US mechanism, and a Chinese platform pressuring a Chinese developer would send a Chinese-law letter — exactly what the evidence shows.

### 12.2 How sources are distributed

See the distribution mechanics at the end of §12.4 (local vs. online import, the `gz_`-prefixed storage, the 20-source cap). The one-line summary: **a source is a single self-contained `.js` file**, imported by file or URL, hot-swappable, and never bundled with the app.

### 12.3 Known source categories

`[REPORTED / VERIFIED where noted]` Community sources are commonly named after their authors or their aggregation strategy:

- **聚合音源 (aggregator sources)** — one script that fans out across several platforms, trying each until it gets a playable URL. This mirrors what LX itself does internally via `findMusic` + `getOnlineOtherSourceMusicUrl`, just moved into the script. The largest aggregator repos have thousands of stars (`pdone/lx-music-source` ~8.8k, `Huibq/keep-alive` ~7.4k, `guoyue2010/lxmusic-` ~5.8k).
- **六音 / liuyin** — the most widely-circulated single source, and simultaneously the most obfuscated: `[VERIFIED]` 332,677 bytes across **12 lines** with **16,316 `_0x` identifiers**. No license, unauditable, and its header declares `MUSIC_U`/`ts_last` cookie fields. **Treat with the most caution of anything in this ecosystem.**
- **野草 / yecao** and **花 / flower** — other popular named sources (e.g. `yecao202412.js`, and `pdone/lx-music-source`'s `flower/` directory).
- **Paid / card-key sources** — `[VERIFIED]` a real market with published tiers, e.g. 聆澜音源 *永久15元/年卡4元/月卡2元/周卡1.5元/天卡0.6元*; IKUN *永久15/年10/月5*. Import URLs are of the form `…/script/lx?key=<卡密>`.
- **公众号-gated sources** — brand themselves with a WeChat public account and gate updates on follower counts (see failure mode B in §12.4).
- **Obfuscated / packed** sources — a measured spectrum from fully-readable to homoglyph-identifier and inline-XOR-decoder obfuscation.

**Source-repo licensing is the weak point.** `[VERIFIED]` Of the notable aggregator repos, the two largest (`pdone/lx-music-source` ~8.8k★, `Huibq/keep-alive` ~7.4k★) have **no license at all** (`license: null`, `LICENSE` → 404); others are Apache-2.0 or MIT; one (`Macrohard0001/lx-ikun-music-sources`) uses a bespoke 《巨硬简易许可证》 that forbids commercial use and resale — while the same repo **sells** card keys. Several are `archived`. **The individual scripts themselves carry no license of any kind** — only the LX-mandated header block. Note also the incoherence: an Apache-2.0 repo nominally covering hundreds of files it did not write, containing other authors' obfuscated scripts with no grant.

**The pattern: the container is licensed, the payload is not.**

### 12.4 Why sources break

> **Correction to the conventional wisdom.** The community explanation for source breakage is "the platforms changed their API / signature". That is **not** the dominant cause. Endpoints extracted from ten real circulating source scripts were probed directly, and **relay death dominates**: of the hosts that could be exercised, most were hard-down.

**Measured endpoint status** (hostnames extracted from the actual script bytes, probed twice for reproducibility):

| Endpoint | Result |
| --- | --- |
| `lxmusicapi.onrender.com/url/…` | **HTTP 503** |
| `api.ikunshare.com` (a **paid** card-key service) | **ENOTFOUND** |
| `music-dl.sayqz.com/api/…` | **ENOTFOUND** |
| `api.xcvts.cn/api/music/migu` | **Timeout (15 s)** |
| `api.music.lerd.dpdns.org/init.conf` | 200 — `{"code":200,"data":{"init":{…}}}` |
| `88.lxmusic.xn--fiqs8s` (punycode for `88.lxmusic.中国`) | 200 — `{"code":0,"msg":"success"}` |
| `13413.kstore.vip/lxmusic/changqing.json` | 200 — `{"version":"1.3.0",…}` |

Aggregate: **~7 hosts hard-down, 3 × HTTP 403, 1 × HTTP 503.** Of the sources whose primary relay could be exercised end-to-end, **four are dead right now**. `ENOTFOUND` on a *paid* service's API host is unambiguous.

**Why this reframes everything:** if relay death dominates, then the ecosystem's rhythm is **"source dies → switch sources"**, not "patch and recover". That is precisely *why* the architecture is many interchangeable sources rather than one well-maintained source — and why the sandbox/contract design (not the individual sources) is the durable asset. It also means a reimplementation should invest in **source health visibility** (§13.4) rather than assuming sources can be fixed.

**Failure taxonomy, evidenced from script bytes rather than hearsay:**

| Mode | Mechanism |
| --- | --- |
| **A — relay-dependent** | The script calls the author's own server; it dies with that server. One script's protocol even names its own failure modes: `case 1: 'block ip'`, `case 5: 'too many requests'`, `case 4: 'internal server error'` — running on Render's free tier. |
| **B — keyed / signed relay** | The script carries a server config with `apiUrl`/`apiKey`/`signSalt`. Death is sometimes *deliberate*: one widely-mirrored script brandishes a WeChat public account and was observed failing with *"由于阅读量不达标，暂时停用后续更新，请关注公众号: 洛雪科技"* — withheld as leverage to drive follows. The same aggregator even ships a file named `洛雪科技[独家音源] v4-会停用.js` ("will be discontinued"). **An attention-economy failure mode.** |
| **C — paid card-key** | A real market with published tiers (permanent / yearly / monthly / weekly / daily cards). Import URLs look like `…/script/lx?key=<卡密>`, so **a "source URL" is often also a secret** — a real supply-chain consideration: importing a stranger's URL can leak your key. |
| **D — server round-trip + anti-tamper** | Some sources fetch their own `sources` manifest from the server at init, so the operator can change advertised platforms/qualities remotely; they also compute a `vkey` from a stripped key. |
| **E — redirect-proxy escape hatch** | One returns `code 303` telling the *client* to fetch a URL and extract values via data-driven property paths — offloading the request to the user's IP to dodge platform blocking. Maximally brittle. |
| **F — platform signing churn** | Repos vendor a ~11.8 KB `infSign.min.js` just to *search* one platform. This is the mode the community over-weights; it is real but secondary. |
| **G — app-side anti-abuse** | The app warns that bulk downloading can get a user's IP banned *by the source*. |
| **H — the script targets an action that doesn't exist** | One script declares `actions: ['musicUrl','search']` and ships ~70 lines of search code. **`'search'` is not a valid action** — the runtime silently strips it, so that code is dead and never even errors. A silent-failure class worth defending against. |
| **I — obfuscation blocks repair** | Measured spectrum: one popular script is **332,677 bytes across 12 lines with 16,316 `_0x` identifiers**; another uses Arabic/PUA homoglyph identifiers; others use inline numeric-XOR decoders — versus several that are fully readable. Notably, **the most-copied source is also the most obfuscated**; popularity doesn't drive obfuscation, *having a relay worth protecting* does. De-obfuscation is itself a credited community activity. |
| **J — host-app API version bump** | `lx.version` changes incompatibly and old scripts break. **This is the one app-side breakage that is well-evidenced** — see the correction below. |

**The real app-side breakage is not what the internet says.** The genuine, documented breaking change is the **`window.lx` → `globalThis.lx` migration together with `lx.version` → `2.0.0`** in desktop **v2.6.0**, whose release note explicitly warns it *"可能会导致某些第三方源停止工作…你需要将LX回退到 v2.5.0"*. (`lx.version` had also bumped to `1.3.0` at v2.2.1 when `zlib.inflate`/`deflate` were added.)

A widely-circulated competing story — that "LX 1.6.0 broke 六音 via an `X-API-Version` header and JWT" — was **refuted**: it originates in an **AIGC-labelled** blog post, and there is no `X-API-Version` header and no JWT anywhere in the contract. Its kernel is a real community README saying *"洛雪音乐1.6.0之后，六音音源失效"* — but desktop v1.6.0 predates custom sources entirely, so the only coherent reading is **mobile v1.6.0**. The same README's own addendum undercuts the claim: *"六音还在正常提供音源…此仓库将不再更新"*. **Lesson for the team: treat any Chinese-language "tutorial" article as unverified unless it is AIGC-labelled *and* you have checked it — several fabricate API contracts outright.**

**How sources are distributed** `[REPORTED]`: 设置 → 自定义源管理 → 本地导入 (a file, since desktop v1.8.0) or **在线导入** (a URL, added desktop **v2.7.0** / mobile **v1.3.0** — note this landed ~3 years after local import and ~2 months *after* the built-ins were removed). The script is deflate+base64'd into `user_api.json` with a `gz_` prefix; duplicates are rejected by comparing compressed bytes. **There is a maximum of 20 sources.** The desktop request timeout is 20 s. Desktop v2.8.0 fixed a size ceiling twice — the official explanation for "某些音源无法导入".

**Consequence of this design:** sources are single self-contained JS files, hot-swappable, and never bundled with the app. The app carries **zero source code**, which is precisely the legal posture the author adopted after the 2023 warning letter: the client is a neutral container; the user supplies the "source".

### 12.5 Why the sandbox is locked down as hard as it is

`[INFERRED, strongly supported by the code]` The threat model is explicit: **the source script is untrusted third-party code.** Hence: `data:` URL origin, `contextIsolation: true`, `nodeIntegration: false`, `webgl: false`, `images: false`, dialogs disabled, all navigation/window-open/permission requests denied, session storage cleared on teardown, one sandbox at a time, a 20 s request timeout, response-size caps (URL ≤2048, lyric ≤51200), a strict `^https?:` URL check, and a whitelist intersection on declared capabilities. **Any compatible player must reproduce this threat model or it becomes a remote-code-execution delivery vehicle.**

---

## 13. Recommended architecture for a new Electron + Vue player

### 13.1 Design principles

1. **Clean-room.** Do not copy `src/` from lx-music-desktop. Read the MIT-licensed docs, reproduce the *interfaces*, write your own implementation. Keep a written record of sources consulted (this document is a start) to substantiate independent development.
2. **Do not reproduce the security posture.** `nodeIntegration: true` + `contextIsolation: false` + `webSecurity: false` is a 2018-era design. Use modern Electron defaults.
3. **Treat "source" as a first-class plugin type with a stable, versioned, documented contract.** This is the single most important compatibility decision: it is what makes the ecosystem portable, and it is why users can move between clients.
4. **Invest where LX didn't.** Local library management is LX's biggest gap (§6.2).
5. **Keep the app a neutral container.** No bundled platform sources. Same legal posture as LX post-2023.

### 13.2 Stack

| Layer | Choice | Why |
| --- | --- | --- |
| Shell | **Electron 3x** (latest stable), `electron-builder` + `electron-updater` | Same as LX; mature; native module support |
| Build | **electron-vite** or **Vite + vite-plugin-electron** | LX's 4 hand-maintained webpack configs are a maintenance tax; Vite is faster and simpler. If you must match LX's multi-bundle shape, Vite multi-entry handles it. |
| Renderer | **Vue 3.4+** (`<script setup>`, TS) | Matches LX; large Chinese-ecosystem familiarity |
| State | **Pinia** (+ `pinia-plugin-persistedstate` for view state only) | LX's hand-rolled stores work but Pinia gives devtools, SSR-safety, and testability |
| Router | **vue-router 4** | |
| UI kit | **Naive UI** or **Element Plus** | LX has none; you get accessibility, virtual lists, dark mode for free. Use **UnoCSS/Tailwind** for layout. |
| Virtual list | `vue-virtual-scroller` or Naive UI's `n-virtual-list` | Playlists of 10k+ tracks |
| i18n | `vue-i18n` | zh-CN / zh-TW / en-US |
| Main-process DB | **better-sqlite3** (WAL) | Matches LX; synchronous API is ideal in a worker thread |
| Main-process HTTP | **undici** | Modern, fast |
| Metadata read | **music-metadata** | Same library LX uses; best-in-class |
| Tag write | **node-taglib-sharp** or keep `node-id3` + a FLAC writer | See §13.6 — LX's tag writing is limited to MP3/FLAC |
| Audio | **HTML5 `<audio>` + Web Audio API** | Exactly LX's approach; gives you EQ/reverb/panner/analyser for free and needs no native module. Optionally swap in **`mpv`/`libmpv` via `node-mpv`** for APE/DSD/CUE — this is a genuine differentiator. |
| IPC | Typed wrappers + a single shared channel-name table | Mirror LX's `ipcNames.ts` pattern (the pattern, not the file) |
| Tests | Vitest (unit) + Playwright (`_electron`) for E2E | LX has essentially no test suite |

### 13.3 Process model (hardened)

```
MAIN (Node)
 ├ App lifecycle, single instance, custom protocol (yourapp://)
 ├ SQLite in a worker_thread  (better-sqlite3, WAL)
 ├ Settings store (atomic JSON or a settings table)
 ├ Source-host: one hardened BrowserWindow per active source
 ├ Open API HTTP server (loopback by default)
 └ Sync server/client (WS)
        ▲ contextBridge-exposed, validated IPC  ▼
PRELOAD (per window, narrow API)
        ▲                                    ▼
RENDERER  sandbox:true, contextIsolation:true, nodeIntegration:false, webSecurity:true
 ├ Vue app
 ├ Audio engine (Web Audio)
 └ Download worker (comlink)
```

`webPreferences` for the main window:

```ts
{
  preload: <path>,
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
  nodeIntegrationInWorker: false,
  webSecurity: true,
  spellcheck: false,
}
```

**Everything LX does directly in the renderer (fs, path, music-metadata, iconv) moves behind IPC.** This costs you some ergonomics and buys you a security story you can actually defend.

### 13.4 The source-host subsystem (the core reusable idea)

Reimplement it faithfully — this is the compatibility surface.

```ts
// 1. Storage: keep the same shape so users can migrate
//    <userData>/Datas/sources.json
type StoredSource = {
  id: string            // "src_<rand>_<ts>"
  name: string          // from @name
  description?: string; author?: string; homepage?: string; version?: string
  allowUpdateAlert: boolean
  script: string        // "gz_" + base64(deflate(utf8(source)))  ← same encoding, for import compat
}

// 2. Import: same header regex, same caps
const HEADER = /^\/\*[\S|\s]+?\*\//
const META   = /^\s?\*\s?@(\w+)\s(.+)$/
const CAPS   = { name: 24, description: 36, author: 56, homepage: 1024, version: 36 }

// 3. Host window: same hardening
new BrowserWindow({
  show: false,
  webPreferences: {
    preload: sourcePreloadPath,
    sandbox: true,               // ← stronger than LX's `false`; verify your API needs
    contextIsolation: true,
    nodeIntegration: false,
    webgl: false, images: false, spellcheck: false,
    disableDialogs: true, enableWebSQL: false,
  },
})
// deny: will-navigate, will-redirect, will-attach-webview, will-prevent-unload, window.open, all permissions
// load: data:text/html,<minimal html>
// run:  webFrame.executeJavaScript(script)  (inside preload)
```

**Preload must expose exactly this shape** so existing community scripts work unchanged:

```ts
contextBridge.exposeInMainWorld('lx', {
  EVENT_NAMES: { request: 'request', inited: 'inited', updateAlert: 'updateAlert' },
  version: '2.0.0',           // ← report the API version you implement
  env: 'desktop',
  currentScriptInfo: { name, description, version, author, homepage, rawScript },
  request(url, { method, timeout, headers, body, form, formData }, cb) { /* returns abort fn */ },
  send(eventName, data): Promise<void>,
  on(eventName, handler): Promise<void>,
  utils: {
    crypto: { aesEncrypt, rsaEncrypt, randomBytes, md5 },
    buffer: { from, bufToString },
    zlib:   { inflate, deflate },
  },
})
```

**Validation rules to enforce** (do not relax these):
- `musicUrl`/`pic`: string, ≤2048 chars, `^https?:`
- `lyric`: object with string `lyric` ≤51200; `tlyric`/`rlyric` <5120; `lxlyric` <8192
- Capability intersection against `{kw,kg,tx,wy,mg,local}` × `{musicUrl}` (plus `lyric`,`pic` for `local`)
- Per-request host timeout (LX: 20 s), per-HTTP timeout (LX: 60 s)
- One source active at a time; clear session storage/cache/auth on teardown

**Beyond LX — worth adding:**
- `sources[]` beyond the six hard-coded keys. LX's fixed key set (`kw/kg/tx/wy/mg/local`) is its biggest extensibility limitation. Support arbitrary string keys with a declared capability object, and keep the six as aliases for compatibility.
- A **signed source manifest** / allow-list option for enterprise deployments.
- **Structured logging + a DevTools toggle** in the source manager (LX only has `openDevTools: true` in the script payload).
- Per-source **health/telemetry panel**: last success, average latency, error rate. Makes "which source is dead" obvious.

### 13.5 Playback

```
<audio crossOrigin="anonymous">
  → MediaElementAudioSourceNode
  → AnalyserNode (fftSize 256)
  → 10 × BiquadFilterNode (peaking, Q 1.4, 31…16000 Hz)
  → [AudioWorkletNode phase-vocoder]      // only mounted when pitch ≠ 1
  → ConvolverNode + dry GainNode → DynamicsCompressorNode
  → PannerNode
  → GainNode → destination
```

Reuse LX's preset tables (the EQ presets and the 13 convolution presets are just numbers/filenames — but **the impulse-response `.wav` files are third-party assets; source your own or use an MIT/CC0 set**).

Add:
- `audio.setSinkId()` device switching (LX has it).
- `audio.preservesPitch` (LX has it).
- **Gapless playback** via two alternating `<audio>` elements + `AudioBufferSourceNode` scheduling — LX does not have this and it is a real quality win for album listening.
- **ReplayGain / EBU R128** normalisation.
- Optional **libmpv backend** for APE/DSD/CUE/24-192 that Chromium can't decode.
- Media Session API integration (`navigator.mediaSession`) — LX has `useMediaSessionInfo.ts`.

### 13.6 Local library (your differentiator)

Build what LX lacks:

- **Folder-based library**: add root folders, recursive scan, `chokidar` watcher, incremental index keyed by `(deviceId, inode|path, size, mtime)` so moves are detected rather than duplicated.
- **Store in SQLite**: `tracks`, `albums`, `artists`, `track_artists`, `folders`, `scan_state`, plus FTS5 for search. LX stores `id = file path` and re-parses on every add; that does not scale.
- **Cover art cache**: extract once, downscale, cache as WebP under `<userData>/Cache/covers/<hash>.webp`, with a `picture` table. LX reads sibling `.jpg`/embedded art on demand with a one-entry memo.
- **Tag editing**: read *and write* MP3/FLAC/M4A/OGG tags. LX only writes tags during download and only for MP3/FLAC.
- **CUE sheet** support, multi-disc albums, album artist vs. track artist, compilation flags.
- **Duplicates**: hash-based (chromaprint optional) detection and merge UI.
- **Watch folders + auto-import into playlists.**
- **Keep LX's fallback behaviour** — it is genuinely nice: if a local file is missing, search online by name/artist/filename-stem. Reproduce it, but make it explicit and user-controllable.

### 13.7 Data layout for the new app

Mirror the *ideas*, not the paths:

```
%APPDATA%\<YourApp>\
├── Datas\
│   ├── library.db          (SQLite, WAL: tracks, playlists, lyrics, urls, downloads, sources-index)
│   ├── settings.json       (atomic write: tmp + rename)
│   ├── sources.json        (imported source scripts, "gz_" + base64(deflate(...)))
│   ├── hotkeys.json
│   └── themes\
└── Cache\
    ├── covers\
    └── http\
```

Schema (adapting LX's good decisions, fixing the bad ones):

```sql
CREATE TABLE playlists (
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  kind TEXT NOT NULL,                 -- 'default' | 'love' | 'temp' | 'user' | 'imported'
  source TEXT, source_list_id TEXT,
  position INTEGER NOT NULL, location_update_time INTEGER);

CREATE TABLE tracks (                 -- one row per unique track identity
  id TEXT PRIMARY KEY,                -- '<source>_<platformId>' or 'local_<hash>'
  source TEXT NOT NULL, name TEXT NOT NULL, singer TEXT NOT NULL,
  album TEXT, interval INTEGER, meta TEXT NOT NULL);   -- meta = JSON

CREATE TABLE playlist_tracks (        -- membership + order, LX-style
  playlist_id TEXT NOT NULL, track_id TEXT NOT NULL,
  position INTEGER NOT NULL, added_at INTEGER,
  PRIMARY KEY (playlist_id, track_id));
CREATE INDEX idx_pt_playlist_pos ON playlist_tracks (playlist_id, position);

CREATE TABLE track_urls (             -- ★ FIX: key on (track_id, quality)
  track_id TEXT NOT NULL, quality TEXT NOT NULL, url TEXT NOT NULL,
  fetched_at INTEGER NOT NULL, PRIMARY KEY (track_id, quality));

CREATE TABLE lyrics (                 -- ★ FIX: 'raw' | 'edited' as LX does, plus timestamps
  track_id TEXT NOT NULL, kind TEXT NOT NULL, lyric TEXT, tlyric TEXT,
  rlyric TEXT, lxlyric TEXT, updated_at INTEGER,
  PRIMARY KEY (track_id, kind));

CREATE TABLE downloads (
  id TEXT PRIMARY KEY, track_id TEXT NOT NULL, quality TEXT NOT NULL, ext TEXT NOT NULL,
  status TEXT NOT NULL, status_text TEXT, downloaded INTEGER, total INTEGER,
  url TEXT, file_name TEXT, file_path TEXT, position INTEGER, updated_at INTEGER);

CREATE TABLE local_files (            -- ★ NEW: proper library index
  id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, folder_id INTEGER,
  size INTEGER, mtime INTEGER, content_hash TEXT,
  title TEXT, artist TEXT, album TEXT, album_artist TEXT, track_no INTEGER,
  disc_no INTEGER, year INTEGER, duration_ms INTEGER, bitrate INTEGER,
  sample_rate INTEGER, channels INTEGER, codec TEXT, lossless INTEGER,
  cover_id TEXT, added_at INTEGER, missing INTEGER DEFAULT 0);

CREATE VIRTUAL TABLE tracks_fts USING fts5(title, artist, album, path);
```

### 13.8 Interop checklist (do these to be "compatible")

- [ ] Implement the custom-source `globalThis.lx` API at `version: '2.0.0'` with identical `EVENT_NAMES`, capability keys, validation, and timeouts. **This is the compatibility contract.**
- [ ] Import `user_api.json`-style entries, including `gz_`-prefixed deflate+base64 scripts and plain-text legacy scripts.
- [ ] Parse the `/** @name @description @version @author @homepage */` header with the same regex and length caps.
- [ ] Support the `lxlyric` karaoke format `[mm:ss.mmm]<start,dur>char…`.
- [ ] Implement `lxmusic://` Scheme URL (so browser userscripts keep working) — or your own scheme plus an opt-in `lxmusic://` handler.
- [ ] Implement the Open API HTTP endpoints + SSE, on the same default port if possible (`23330`) so third-party dashboards work.
- [ ] Provide a data-import path for LX's SQLite (`lx.data.db`) and JSON stores so users can migrate.
- [ ] Support the same audio qualities: `128k / 192k / 320k / flac / flac24bit / wav / ape`.
- [ ] Reproduce the `qualitys`/`actions` **whitelist intersection including its silent-discard behaviour** (§9.3) — a script declaring `hires` or `search` must behave identically against us.
- [ ] Cap imported sources at 20 and enforce the 20 s request timeout, to match observable behaviour.
- [ ] Ship **no** built-in platform sources.
- [ ] **Add source health visibility** (§13.4) — since relay death is the dominant failure mode, telling the user *which* source is dead is worth more than any single source.

### 13.9 What to explicitly NOT copy

| Don't | Because |
| --- | --- |
| `nodeIntegration: true` / `contextIsolation: false` / `webSecurity: false` in the main window | Trivially exploitable; a malicious source or a compromised web view owns the machine |
| The prebuilt `qrc_decode_*.node` binaries | Closed, un-auditable provenance; unknown license |
| The bundled impulse-response `.wav` files, fonts, and images | Third-party assets of unverified license |
| The built-in `musicSdk/{kw,kg,tx,wy,mg,bd}` platform adapters | Highest legal risk, highest maintenance, and precisely what the author had to abandon |
| The project name, logo, or "LX Music" / "洛雪" branding | Apache-2.0 §6 grants no trademark rights |
| Copying any `src/` file | Keeps your derivative clean of the supplementary agreement entirely |

---

## 14. Open questions for the team

1. **Is the product commercial?** If yes, the clean-room decision is forced — LX's supplementary agreement §8.1 forbids commercial use regardless of how Apache-2.0 is read.
2. **Do you ship sources, or only the container?** Shipping sources means shipping platform-API circumvention. LX's post-2023 posture (container only) is the defensible one.
3. **Where does the music come from for a legitimate product?** If the answer is "licensed catalogue", the entire source-plugin subsystem becomes optional and the product is a normal music player. If the answer is "the plugin ecosystem", you inherit LX's legal exposure.
4. **Do you need APE / DSD / CUE?** If yes, plan for a libmpv backend from day one; retrofitting a second audio engine is painful.
5. **Do you need mobile?** LX mobile is React Native + Redux and shares the source contract but *not* the host environment. If you want one source ecosystem across desktop and mobile, design your `lx.utils` surface to the **mobile** subset (no zlib, `aes-128-cbc`/`aes-128-ecb` only, base64/hex/utf8 buffers, only `setTimeout`) and treat the desktop extras as optional.

---

## 15. Source index (everything consulted)

**Repository content (via the Gitee mirror `mirrors/lx-music-desktop`, `master`):**
`package.json` · `LICENSE` · `README.md` · `FAQ.md` · `licenses/license_zh.txt` · full recursive git tree ·
`src/common/{constants,defaultSetting,ipcNames,mainIpc}.ts` · `src/common/types/{list,music,user_api}.d.ts` ·
`src/common/utils/{tools.ts,musicMeta/index.js,musicMeta/mp3Meta.js,musicMeta/flacMeta.js,download/Downloader.ts,lyricUtils/util.ts}` ·
`src/main/{index,app}.ts` · `src/main/utils/{index,store,migrate}.ts` ·
`src/main/modules/index.ts` · `src/main/modules/winMain/{main.ts,rendererEvent/{music,download}.ts}` ·
`src/main/modules/userApi/{index,main,utils}.ts` · `src/main/modules/userApi/renderer/preload.js` ·
`src/main/modules/userApi/rendererEvent/{rendererEvent.ts,name.js}` · `src/main/modules/openApi/index.ts` ·
`src/main/worker/dbService/{db,tables}.ts` ·
`src/renderer/{main.ts,App.vue}` · `src/renderer/core/{apiSource.ts,useApp/index.ts,useApp/useDataInit.ts,useApp/useInitUserApi.ts,useApp/usePlayer/usePlayer.ts,useApp/usePlayer/useSoundEffect.ts}` ·
`src/renderer/core/music/{online,local,download,utils}.ts` · `src/renderer/plugins/player/index.ts` ·
`src/renderer/utils/{music.ts,musicSdk/index.js,musicSdk/api-source.js,musicSdk/api-source-info.ts}` ·
`src/renderer/store/{index.ts,utils.ts,list/action.ts,download/action.ts,download/utils.ts}` ·
`src/renderer/worker/download/{index,download,common,utils}.ts`

**Official documentation (MIT):** <https://lxmusic.toside.cn/desktop> · [/desktop/faq](https://lxmusic.toside.cn/desktop/faq) · [/desktop/faq/playlist](https://lxmusic.toside.cn/desktop/faq/playlist) · [/desktop/faq/play-local-music](https://lxmusic.toside.cn/desktop/faq/play-local-music) · [/desktop/faq/dislike-music](https://lxmusic.toside.cn/desktop/faq/dislike-music) · [/desktop/faq/cannot-play-and-download](https://lxmusic.toside.cn/desktop/faq/cannot-play-and-download) · [/desktop/custom-source](https://lxmusic.toside.cn/desktop/custom-source) · [/desktop/open-api](https://lxmusic.toside.cn/desktop/open-api) · [/desktop/scheme-url](https://lxmusic.toside.cn/desktop/scheme-url) · [/desktop/datapath](https://lxmusic.toside.cn/desktop/datapath) · [/desktop/license](https://lxmusic.toside.cn/desktop/license) · [/desktop/use-source-code](https://lxmusic.toside.cn/desktop/use-source-code) · [/download](https://lxmusic.toside.cn/download) · [/mobile](https://lxmusic.toside.cn/mobile) · [/mobile/custom-source](https://lxmusic.toside.cn/mobile/custom-source) · [/mobile/license](https://lxmusic.toside.cn/mobile/license)

**GitHub REST API (via `gh-proxy.com`):** `repos/lyswhut/lx-music-desktop` (license, stars, archived/disabled state) · `repos/any-listen/any-listen` · `repos/lyswhut/lx-music-desktop/issues/1643` (the author's primary account of the Tencent warning letter; 222 comments, 775 reactions) · `repos/lyswhut/lx-music-mobile` and `repos/lyswhut/lx-music-source` (license fields) · community source repos surveyed for licensing: `pdone/lx-music-source`, `Huibq/keep-alive`, `guoyue2010/lxmusic-`, `xzh767/lxmusic-source-all`, `laosunmaker/New_lxmusic_source`, `Macrohard0001/lx-ikun-music-sources`, `MeoProject/lx-music-api-server`, `ZxwyWebSite/lx-source`

**Raw files (via `gh-proxy.com`):** `lyswhut/lx-music-desktop@master/package.json` (v2.12.5) · `lyswhut/lx-music-mobile@master/package.json` (v1.9.0) · `lyswhut/lx-music-source@master/package.json` (MIT, v1.1.2)

**npm registry:** `https://registry.npmjs.org/lx-music-desktop-version-info` (release-note history used for the 2023 source-removal and audio-effect timeline) · `https://registry.npmjs.org/lx-music-mobile-version-info` · search for `lx-music` / `@lx-music`

**Third-party context (untrusted, used only for ecosystem colour):** [blog.gitcode.com — 告别平台限制](https://blog.gitcode.com/386267044135fa86490f6a5079cb424e.html) (⚠️ contains the incorrect MIT claim) · [cnblogs — 洛雪音乐下载安装和使用教程](https://www.cnblogs.com/ganhuo1/p/19486277) (⚠️ **AIGC-generated**; fabricates a DMCA claim and invents an entire CommonJS source API — `module.exports` with `search()`/`getMusicInfo()`/`getPlaylistInfo()`/`getHotSearch()` — none of which exist)

**Companion research in this workspace:** `lx-music-yinyuan-research.md` and `lx-music-yinyuan-community-legal-notes.md` (the ecosystem deep-dive that produced the endpoint liveness measurements in §12.4, the source-repo licence survey in §12.3, and the QuickJS finding in §2.5), with reproducible evidence under `_research/`.

**Not reachable / not read directly:** the full `CHANGELOG.md` text for v2.6.0–v2.12.x (111 KB, truncated on fetch); issue #1641's user-pasted letter text (unauthenticated); issue #1912's comment thread (referenced via the README and changelog, not read in full); `sixyin.com` and the vendor/shop pages (unresolvable from this environment); and any primary version-to-breakage mapping for the "六音失效" claim beyond the refutation in §12.4.

---

## 16. Bottom line

- **License:** Apache-2.0 **plus** a supplementary agreement that forbids commercial use *and donations* and restricts the project to research/learning. Reported as MIT elsewhere — **that is wrong**, and the GitHub API confirms `spdx_id: "Apache-2.0"`. The *documentation* is MIT and freely reusable, as is the official `lyswhut/lx-music-source` template repo.
- **Copy code?** Only if you are non-commercial and comfortable relying on Apache-2.0 prevailing over the supplement. For anything else: **clean-room**, reimplementing the documented interfaces.
- **Why §8.1 refuses donations:** `[INFERENCE]` it is a legal shield. Refusing all money — donations, ads, cooperation — denies any prosecution the easiest element to prove (commercial intent) and keeps the project on the "technical research" side of the 非法牟利 line. **Any monetisation of a streaming-source-based player moves it into a categorically riskier posture, independent of the software licence.** This is the most transferable lesson in the codebase.
- **The architecture is worth studying, not copying.** Its genuinely valuable idea is the **hardened custom-source sandbox with a tiny, versioned, documented `globalThis.lx` contract** — that single design is what let the author survive a platform warning letter and what lets a whole ecosystem of third-party sources exist independently of the app. Reproduce that idea, and the Open API / Scheme URL / data-sync surfaces around it. The format is intended to outlive LX itself (the successor project ships an LX-source loader).
- **The ecosystem is dying of relay death, not API churn.** Measured: most probed source relays are hard-down, including a *paid* service's API host (`ENOTFOUND`). Design for "source dies → switch sources", with health visibility, rather than assuming sources can be patched.
- **Its biggest weakness is local music.** No library scan, no watching, no tag editing, no dedupe, `id = file path`, and only MP3/FLAC tag writing. That is where a new player can be straightforwardly, unambiguously better.
- **Its biggest risk is not its license — it is the music.** Every design decision downstream of "where does the audio URL come from" carries legal exposure that no license choice can cure. The author's own trajectory — pre-emptive 128k lock, then removing all built-ins permanently, then moving to maintenance mode and re-pointing the architecture at self-hosted libraries — is the clearest available evidence of where this road leads.
