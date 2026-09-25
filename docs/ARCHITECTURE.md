# 架构说明

这份文档记录**为什么**这样实现。功能清单见 `README.md`；LX 音源协议的逐条细节见
`docs/research/lx-custom-source-api.md`；Salt Player 的界面规格见
`docs/research/salt-player-ui-spec.md`。

---

## 1. 关键决策与理由

### 1.1 为什么是 Electron + Vue 3

音源生态是 **JavaScript**。要在不改动脚本的前提下运行它们，宿主必须能提供一个几乎完整的
JS + 浏览器环境。其他选项都要为此付出额外代价：

| 方案 | 问题 |
| --- | --- |
| Tauri + Rust | 需要内嵌 QuickJS 并自行补齐 `lx.utils`、`lx.request`、`window` 等，且要复刻 Node 的 Buffer 语义 |
| .NET + WinUI | 需要用 ClearScript/Jint 承载脚本，同样是二次实现，还多一层互操作 |
| Electron | 与 LX Music 同构：Node 的 `vm`、`worker_threads`、`crypto`、`zlib` 直接可用 |

选择 Electron 的直接收益：`lx.utils.crypto`（AES/RSA/MD5）、`lx.utils.zlib`、
`lx.request` 的 Buffer 语义都能一一对应实现，而不是近似模拟。

代价是安装体积。对本项目而言这个代价是可接受的。

### 1.2 音源崩溃隔离：独立子进程

**进程边界不等于权限沙箱**。脚本在 Node 全局上下文执行，仍可访问当前用户的文件和网络。Windows 启动时额外使用受限令牌，移除关机特权；这不限制普通文件和网络访问。
真实案例在 1.2.1。

最初音源跑在 `worker_threads` 里。**那不足以隔离**：worker 与宿主共享同一个进程，
任何**进程级**终止（`abort()`、OOM、原生栈溢出）都会连带干掉整个应用。

这不是假设。本机真实安装的一个音源（混淆脚本，带约 660 个零宽/异体字符标识符，
`javascript-obfuscator` 自我保护模式的签名）**每次启动都让应用消失**。
由于音源在启动时加载，应用从此再也打不开——没有报错，也没有办法从界面里禁用那个音源。

| | worker 线程（旧） | 独立进程（现在） |
| --- | --- | --- |
| 脚本 `abort()` | **整个应用死亡** | 只有该音源进程死亡 |
| 脚本 OOM | 拖垮应用 | 被自己的内存上限杀掉 |
| 死循环 | 阻塞（可 terminate） | 只阻塞该子进程 |
| 崩溃后可恢复 | 否（每次启动都崩） | 是（其他音源不受影响） |
| **脚本主动关机** | **整机断电** | **Windows 受限令牌移除关机特权**（见 1.2.1；其他平台未提供此保护） |

代价是启动稍重（约 30 ms）和需要通过**文件**而不是值传递脚本——相对于「应用打不开」
都可以接受。脚本实测可达 740 KB，远超 Windows 的约 32 KB 命令行上限和约 8 KB 环境变量上限。

#### 1.2.1 音源可以关掉整台电脑——以及我们怎么防

**2026-09-18 实测**：启用某个音源后，用户的电脑直接关机。证据不是推测，
是 Windows 自己的事件日志：

```
Event 1074
进程 C:\Windows\system32\shutdown.exe 发起了 关机
Reason Code: 0x800000ff
```

`0xff` 是「其他/未定义原因」——**程序化关机**的特征码（开始菜单关机是 `0x0`）。
日志时间与启用该音源在同一秒。该脚本带服务端授权校验（`SERVER_SCRIPT_CONFIG` 里有
`apiUrl` / `signSalt` / `fingerprint`），行为符合「检测到非授权宿主就惩罚」的反篡改设计。

**关键认知：没有任何应用层手段能让一个以用户权限运行的敌意脚本变得无害。**
那需要操作系统级沙箱（AppContainer、作业对象、低权限令牌），Electron 不提供。
所以这里的目标不是"绝对防住"，而是**把常见路径变成一次可捕获、可记录、可逆的失败**。

四层防御：

1. **Windows 受限令牌**（`restricted-launch.ts`）
   音源通过 `runas /trustlevel:0x20000` 启动，子进程没有 `SeShutdownPrivilege`。主子进程用临时文件交换请求和响应；启动、请求及崩溃状态有集成测试。这只限制关机等特权操作，不阻止普通文件或网络访问。
2. **能力剥夺**（`source-host.ts` 的 `lockDownProcess`）
   脚本仍能看到 `process`（很多脚本用它做特性检测），但 `process.exit/abort/kill/binding/dlopen`
   全部替换为抛错的桩；`require` 被包装，`child_process` / `worker_threads` / `cluster` / `vm`
   一律拒绝加载。静态扫描那个脚本的**外层**看不到 `process.exit` 或 `shutdown`——
   但它的字符串表是自定义加密的，只在运行时解密，所以"扫不到"不能证明"没有"。
   正因如此，防御不能是"找那个调用"，只能是**拿掉那个能力**。
3. **启动前拒绝**（`shutdown-guard.ts` 的 `containsShutdownAttempt`）
   匹配 `shutdown /s|/r`、`ExitWindowsEx`、`InitiateSystemShutdown`、`NtShutdownSystem` 等。
   正面命中就直接拒绝启动并**隔离**；反面命中不代表安全（同上）。
4. **隔离**（`SourceStore.quarantine`）
   与普通的 `setEnabled(false)` 不同：隔离是应用对脚本行为的**判定**。它会持久化，
   重启不会重新武装，`setEnabled(true)` 会**拒绝**，只有在界面上显式「解除隔离」才能恢复——
   解除后仍是停用状态，用户需要再单独启用一次。**重新启用一个危险脚本因此需要两次刻意操作。**
   另外，凡是"启动时静默自杀且无任何输出"的脚本（正是这一类的签名）也会被自动隔离。

还有一个副作用值得记下：**用户的机器重启后，应用里那个音源的开关必须记住"不能打开"**——
如果只是随手关掉，用户习惯性地点开全部启用，就会再次关机。

#### 1.2.2 启动前校验：把风险拦在"还没跑"的时候

受限令牌和运行时能力剥夺无法判断一个脚本是否值得启动；崩溃后的隔离也晚于首次执行。用户提出的
真实场景是「不小心误触开启音源」——开关是一次点击，所以还需要启动前静态校验。

**一个脚本只有在执行前才能被拦住。** 所以校验放在"用户意图"与 `fork()` 之间的那个点上，
实现在 `source-validator.ts`，特征是：

- **绝不执行被校验的脚本**。校验是纯静态文本分析——会运行被检查对象的校验器不是校验器。
- **每条结论都可解释**：拒绝时必须说清发现了什么，因为看不懂拦截原因的用户会去找绕过方法。
- **按严重度分级**（`block` / `warn` / `info`），界面可以直接渲染，不必从文案里反推。
- **允许"通过"但附带提示**：带服务端授权校验的脚本、不可读的混淆脚本会被标为 `warn`，
  让用户在知情的前提下决定，而不是一律拒绝。

检查项分两组：

| 组 | 检查项 | 处理 |
| --- | --- | --- |
| 系统级 | `shutdown /s|/r`、`ExitWindowsEx`、`InitiateSystemShutdown`、`NtShutdownSystem` | **阻断** |
| 系统级 | `exec`/`spawn`/`fork` 等外部程序执行 | **阻断** |
| 系统级 | `child_process` / `cluster` 模块加载 | **阻断** |
| 系统级 | `process.exit` / `abort` / `kill` | **阻断** |
| 系统级 | `process.binding` / `dlopen` 原生绑定 | **阻断** |
| 系统级 | `reboot` / `poweroff` / `SetSuspendState` 等电源 API | **阻断** |
| 风险级 | 服务端授权校验（`SERVER_SCRIPT_CONFIG` / `signSalt` / `fingerprint`） | 提示 |
| 风险级 | 自我保护型混淆（零宽/异体字符标识符） | 提示 |
| 风险级 | `eval` / `new Function` 动态执行 | 提示 |
| 风险级 | 无退出条件循环、超大内存分配 | 提示 |
| 说明 | 脚本被压缩成超长单行（静态检查失去意义） | 信息 |

**校验失败的处理**：直接拒绝启动 + 自动隔离，并在界面上以结构化面板列出每条结论
（标题 / 观察到的内容 / 建议做法）。面板**不会自动消失**——用户需要读完才能决定下一步，
三秒后消失的 toast 无法被处理。

**为什么不允许"强制绕过"**：答案是**不提供一键绕过**。理由是这台机器已经因为一次误触
关过机，而"强制启动"按钮恰恰会让误触再次生效。取而代之的是`解除隔离`——它需要用户
在确认框里读过原因，解除后**音源仍是停用状态，必须再单独启用一次**。
所以重新启用一个危险脚本是**两步刻意操作**，而不是一个可以习惯性点掉的开关。
这既保留了用户的最终决定权（我们不替用户永久封禁一个脚本），又让"手滑"不再致命。

**诚实的边界**：校验只读得到明文。混淆脚本的字符串表在运行时才解密，静态检查看不到它们，
因此报告里对不可读脚本显式声明「检查仅覆盖外层」。**"通过"的含义是"没看到问题"，
不是"确认安全"**——把这层意思讲清楚，比给用户一个虚假的安心更重要。

**环境补齐仍然必需**：真实脚本会引用 `window` / `document`。实测那个 740 KB 的聚合音源，
`window` 出现 13 次、`document` 5 次，并使用 `eval` / `new Function`。
`browser-shims.ts` 提供了惰性的浏览器环境：`window` 指向 `globalThis`（脚本用
`window.lx` 做特性检测），`document` 是结构完整但不做任何事的最小 DOM，外加
`atob`/`btoa`、`localStorage`、`navigator`、`performance`。

**`fetch` 是刻意保留的**：曾依据「LX 的 CSP 封死了 fetch」这一**未经证实的推断**移除它，
结果该音源的全部子源都变成 `fetch is not a function`，比修改之前更糟。
实测真实脚本直接使用 `fetch`，已恢复。这个取舍写在 `browser-shims.ts` 的注释里。

**CommonJS 全局同样必需（启动报错的头号原因）**：LX Music 的音源跑在隐藏窗口里，
preload 是 CommonJS，所以脚本能拿到 `require` / `__filename` / `__dirname` /
`module` / `exports`。我们的宿主是 ESM 打包（`"type": "module"`），
`new Function(script)` 在模块作用域里求值，这些**全部是 `undefined`**。

后果不是「少个字段」这么轻：带自我保护混淆的音源（`javascript-obfuscator` 的
self-defending 家族，多个流行聚合源在用）把「这些全局是否存在」当作环境自检的一部分，
自检失败时走**硬终止分支**——直接杀掉自己的进程，不抛异常、不打印任何东西。
父进程只看到退出码 1，于是界面显示「音源进程退出（退出码 1）」，
而同一个脚本在 LX Music 里完全正常。本机 21 个音源中恰有 1 个属于这一族。

`browser-shims.ts` 现在通过真实的 `createRequire` 补齐这组全局，
并给出稳定的 `__filename` / `__dirname`（部分脚本会对自己路径做指纹）。

**打包时必须把宿主脚本解包**：`child_process.fork()` 无法执行 asar 归档内的文件。
漏掉 `asarUnpack` 时应用照常启动，只是安静地显示「0 个在线平台」——
一个很容易误判的症状。`electron-builder.yml` 因此显式解包 `out/main/source-host.js`，
主进程也用 `unpackedPath()` 把路径重写到 `app.asar.unpacked`。

### 1.3 `musicInfo` 必须是「扁平遗留结构」

这是最容易搞错、也最致命的一点。LX 交给脚本的**不是**它内部的模型，而是一个扁平化的旧结构：

```js
{ name, singer, source, songmid, interval, albumName, img, albumId, types, _types, ... }
```

脚本直接读顶层字段：

```js
const songId = musicInfo.hash ?? musicInfo.songmid
```

如果按内部模型传 `{ ..., meta: { songmid } }`，所有第三方音源都会失效。

**关于 `id` 字段（已修正）**：LX 的扁平结构里确实没有 `id`，早先的实现刻意保持一致，
理由是「读 `musicInfo.id` 是那些音源的 bug，不该替它们掩盖」。

实测推翻了这条：本机 21 个音源中**有 11 个读 `musicInfo.id`**。多数把它当作
`hash ?? songmid ?? id` 的最后一档兜底，但 `溯音音源` 直接用
`typeof musicInfo.id === 'string' && !/^\d+$/.test(musicInfo.id)` 决定走哪种请求形态，
`统一音乐源` 更是把它当歌曲 id 回传。字段缺失时这些分支算出 `undefined` / `NaN`，
表现为「无法获取播放地址」，而同一个脚本在 LX Music 里能放。

现在**一律填充**该字段（取曲目自身的 id）。这不会破坏任何能正常工作的脚本：
所有观察到的用法都是 `??` / `||` 兜底或真值判断，一个原本是 `undefined` 的值变成真实字符串，
只可能**多**出一个成功分支。

各平台真正该用的 id：

| 平台 | 用哪个 |
| --- | --- |
| `kw` | `songmid` |
| `kg` | **`hash`**（`songmid` 是 Audioid，不足以取音频） |
| `tx` | `songmid` / `songId` / `strMediaMid` |
| `wy` | `songmid` |
| `mg` | `copyrightId` |

### 1.4 音质是「下限过滤」而不是「能力声明」

LX 会把脚本声明的 `qualitys` 与固定白名单求交集，`hires` / `atmos` / `master` / `192k`
**被静默丢弃**。所以 `qualitys` 实际上是「填充音质下拉框的过滤器」。

我们做同样的事，于是界面上只可能请求 `128k` / `320k` / `flac` / `flac24bit` 四种。

`buildQualityLadder()` 把用户偏好当作**上限**：选了 320k 的用户不应该因为该源只声明了
flac 而被塞一个 50 MB 的文件。因此只向下探测；若该源在偏好之下什么都没声明，才退而取它
最低的一档（能播总比不能播好），并如实回报实际音质。

### 1.5 `lx.request` 返回的是「取消函数」

LX 的 `lx.request(url, opts, cb)` 返回一个取消函数，**不是 Promise**。所有真实脚本都自己
包一层 `new Promise`。若我们返回 Promise，`const cancel = request(...); cancel()` 这类写法
会直接崩。

我们返回一个**既可调用又是 thenable** 的函数：

```ts
const cancel = () => controller.abort()
return Object.assign(cancel, promise)
```

这样两种写法都能工作，同时不偏离文档规定的返回类型。

### 1.6 本地文件走 `jjmedia://` 而不是 `file://`

两个原因：

1. **Web Audio 需要 CORS。** `MediaElementAudioSourceNode` 一旦遇到跨源媒体就输出**静音**
   ——不是报错，是静音。本地文件走自定义协议后，由我们附加
   `Access-Control-Allow-Origin: *`，均衡器和频谱才有数据。
2. **Range 请求。** Chromium 的媒体栈用 Range 请求实现跳转。自定义协议里正确处理
   `bytes=` 才能拖动进度条。

另外，在线音频同样面临 CORS 问题：音乐 CDN 基本不发 CORS 头。解决方案是在主进程用
`webRequest.onHeadersReceived` **只对媒体响应**注入 CORS 头，配合
`element.crossOrigin = 'anonymous'`。这比关掉 `webSecurity` 精确得多——后者会同时削弱渲染
进程的整个安全边界。

### 1.7 安全姿态

与 LX Music 的历史配置刻意不同：

| | LX Music | 本项目 |
| --- | --- | --- |
| `nodeIntegration` | `true` | `false` |
| `contextIsolation` | `false` | `true` |
| `webSecurity` | `false` | `true` |
| 渲染进程能力 | 直接 `require` | 仅 `window.jj` 上显式枚举的方法 |

渲染进程拿不到 `ipcRenderer`，也拿不到原始通道名，因此无法访问未暴露的 IPC。

**一个坑**：`sandbox: true` 时 preload **必须是 CommonJS**。包是 `"type": "module"`，
所以 preload 单独构建成 `.cjs`。否则报 `Cannot use import statement outside a module`，
且 `window.jj` 会是 `undefined`。

### 1.8 存储用 JSON 而非 SQLite

LX Music 用 better-sqlite3。我们选 JSON，考虑的是：

- **可用性优先。** 本项目要能导入 LX 的 `user_api.json`，用同构的 JSON 最直接。
- **规模足够。** 1112 首的索引是秒级读写；几万首也在可接受范围。
- **可检查、可手改。** 出问题用户能直接打开看。

写入一律走 `writeJsonAtomic()`（临时文件 + rename），崩溃不会截断数据。

**BOM 容错**：Windows 上 `Set-Content -Encoding UTF8` 会写入 BOM，而 `JSON.parse` 直接拒绝。
这个坑在开发过程中真实触发过一次（设置文件带 BOM 导致曲库看似为空），所以
`parseJsonLoose()` 统一剥掉 BOM。

### 1.9 多音源：按启用顺序 + 失败自动切换

导入多个音源时，**同一个平台往往被好几个脚本同时声明**——本机 21 个音源里有 14 个都声明了
`wy`。这些脚本的可用性差别很大，且会随时间漂移。

早先的实现给每个平台只留**第一个**声明者，其余作为「未来的优先级设置」丢弃。
结果是：只要那个脚本恰好挂了，整个平台就不可用，尽管用户导入了十几个能替代它的脚本。

现在的规则：

1. **顺序 = 用户在「音源管理」里看到的启用顺序**。这是用户唯一能控制的排序，
   「按启用顺序依次使用」也是他们的直觉预期。索引在 `rebuildOwners()` 里重建，
   所以停用、启用、加载完新脚本都会立刻重排。
2. 能真正解析播放地址（声明了 `musicUrl`）的脚本排在只是声明了该平台的脚本之前。
3. 已崩溃的脚本直接移出路由表（退出事件里重建索引），请求不会再发给它。
4. **容错是「按脚本」而不是「按音质」**：对每个候选脚本走完整条音质阶梯后才换下一个，
   因为一个对 FLAC 返回 404 的脚本，可能仍然能提供 320k。
5. 全部失败时，错误信息**逐个列出被尝试的脚本和各自的失败原因**——
   否则「无法获取播放地址」面对 21 个音源等于没有信息。

启动也一并收敛：`startAll()` 用**并发窗口**（4 个）而不是一次性 `fork` 全部。
21 个进程同时启动会拖垮机器，把本来正常的脚本顶过 15 秒初始化超时而误报为损坏；
并发窗口同时让启动顺序变得确定，而顺序决定了路由优先级。

---

## 2. 数据流

### 2.1 在线播放

```
渲染进程  用户双击一行
   │  window.jj.music.url(source, musicInfo, quality)
   ▼
主进程    ipcMain.handle('music:url')
   │  SourceEngine.getMusicUrl()
   │    ├─ 查该源声明的 qualitys，构造降级阶梯
   │    └─ 逐个音质尝试：
   │         worker.postMessage({ type:'request', payload:{ source, action:'musicUrl', info } })
   ▼
worker    lx.on('request') 注册的 handler
   │    ├─ lx.request() 发真实 HTTP（Buffer 语义、form 编码、60s 超时）
   │    └─ 返回 URL 字符串
   ▼
主进程    校验：字符串、≤2048、/^https?:/
   │  成功 → 返回 { url, quality }
   ▼
渲染进程  AudioEngine.load(url) → Web Audio 图 → 出声
```

### 2.2 本地播放

```
MusicLibrary.scan() → index.json → 渲染进程曲库
用户双击 → jjmedia://local/<encoded path>
        → 主进程 protocol.handle 读文件、处理 Range、加 CORS 头
        → Web Audio 图 → 出声
```

---

## 3. 目录职责

| 路径 | 职责 |
| --- | --- |
| `src/main/sources/lx-worker.ts` | `lx` 对象的唯一实现；跑在 worker 线程内 |
| `src/main/sources/source-engine.ts` | worker 生命周期、请求路由、音质降级、错误上报 |
| `src/main/sources/legacy-music-info.ts` | 内部模型 → 脚本可见的扁平结构 |
| `src/main/sources/browser-shims.ts` | 补齐脚本会用到的浏览器全局 |
| `src/main/library/music-library.ts` | 扫描与索引；**不关心播放** |
| `src/renderer/src/audio/web-audio-engine.ts` | 唯一接触 Web Audio 的地方 |
| `src/renderer/src/stores/player.ts` | 队列与传输控制；只依赖 `AudioEngine` 接口 |

`AudioEngine` 接口是后续替换原生引擎的关键边界：播放状态、队列、界面都不直接接触
Web Audio。

---

## 4. 测试策略

测试跑的是**编译后的引擎**（`tools/build-test.mjs` 用 esbuild 打包），不是另写一份实现，
所以测的是真正会发布出去的代码。

六个无头套件共 171 项，全部可在 CI 运行。其中涉及本机真实数据（LX Music 安装、音乐目录）
的会在数据不存在时**跳过而不是失败**。

关键被测行为：平台/音质过滤规则、音质降级顺序、URL 校验边界、`eval`/`Function`、
浏览器补齐、编码往返、写回文件仍可被 LX 读取、增量重扫、异常脚本不拖垮引擎、
LRC 解析（含逐字歌词）、`jjmedia://` 的 Range 语义。

### 4.1 端到端验证为什么必要

无头测试覆盖不到最容易出问题的一环：**声音有没有真的出来**。

`npm run test:e2e` 启动真实应用，通过 Chrome DevTools Protocol 驱动，最后一项断言是：

```
playing=true t=3.49s dur=257.3s
spectrum non-zero bins: 139/1024
```

- **`currentTime` 在推进** —— 证明 Chromium 确实在解码，而不是只设置了一个 URL。
- **频谱有非零数据** —— 证明采样真的流过了 Web Audio 图。

第二项尤其重要：`MediaElementAudioSourceNode` 遇到跨源媒体时**不报错，而是输出静音**。
如果 CORS 处理有问题，播放会「看起来正常」但完全没有声音，而频谱会全是零。这个断言就是
用来捕获那一类故障的。

### 4.2 测试钩子的处理

端到端验证需要触达真实的 store 而不是 mock（被测的正是「音频是否真的解码」）。因此
`App.vue` 里有一个仅在 `VITE_E2E=1` 时可用的钩子。

`tools/run-e2e.mjs` 负责保证它不会进入发布产物：

1. 带钩子构建 → 2. 跑验证 → 3. **无条件重建干净版本** → 4. 启动应用确认钩子在运行时不可达。

第 4 步用**运行时探测**而非文本搜索。这一点是实测踩出来的：Vite 会把
`import.meta.env['VITE_E2E'] === '1'` 编译成对内存中 env 对象的**运行时属性读取**，
因此被守卫的赋值会作为死分支留在产物里，`__jj_player` 这个标识符**在任何构建中都会出现**
——包括完全干净的。用文本搜索判断会得到假阳性。

### 4.3 环境相关的坑

在 Windows + 受限沙箱下调试时遇到并已修复的问题，记录以备后查：

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `import ... from 'electron'` 报缺少 `BrowserWindow` | 继承了 `ELECTRON_RUN_AS_NODE`，Electron 以纯 Node 启动 | 启动子进程时显式清空该变量 |
| `--remote-debugging-port` 报 `bad option` | Electron 会把它当成转发给应用的参数 | 改由主进程 `app.commandLine.appendSwitch` 设置 |
| 捕获子进程输出报 `spawn EPERM` | 沙箱禁止命名管道 | 用 `stdio: 'inherit'` |
| 下一次 e2e 报「找不到渲染目标」 | 上一轮的调试端口处于 TIME_WAIT | 每次动态选空闲端口 |
| 设置文件存在但曲库为空 | PowerShell 写的 JSON 带 BOM，`JSON.parse` 拒绝 | `parseJsonLoose()` 统一剥 BOM |
| **IPC 报 `An object could not be cloned.`** | **Vue 的响应式 `Proxy` 无法被结构化克隆** | **发 IPC 前用 `toIpcPayload()` 脱壳** |
| **新增字段在界面上永远为空** | **增量扫描跳过了 mtime 未变的文件** | **提升 `INDEX_VERSION`，旧索引标记 stale 后重读** |
| **打包后显示「0 个在线平台」** | **`fork()` 无法执行 asar 归档内的文件** | **`asarUnpack` + `unpackedPath()` 重写路径** |
| **音源在子进程里报「找不到模块」** | **`cwd` 指向临时目录，Node 从那里解析不到 `node_modules`** | **`cwd` 设为宿主脚本所在目录** |
| **曲库突然显示为空** | **`settings.json` 的文件夹列表被清空，索引也随之清空** | **启动时双向合并两边的文件夹列表；空扫描不覆盖非空索引** |

### 4.4 三个值得单独说明的坑

**`An object could not be cloned.` 极难定位。** 这个错误**不指明任何字段**，表现也很有误导性：
用裸对象直接调同一个 IPC 方法完全正常，只有把同一个 track 放进 store 再调用才失败——
因为 `queue.value` 里的对象被 Vue 包成了 `Proxy`，而 Electron 用结构化克隆序列化 IPC 载荷，
结构化克隆**拒绝 Proxy**。

定位方式是把它和引擎问题分开：先确认 `window.jj.lyric.resolve(rawTrack)` 在渲染进程里成功，
再从真实的 `playTrack` 路径触发——两者唯一的差别就是对象是否经过 store。修复是在每个跨 IPC
边界处调用 `toIpcPayload()`（`toRaw` 脱壳 + JSON 往返，保证嵌套值都是可克隆的普通类型）。

**增量扫描与新增字段天然冲突。** `scan()` 以「路径 + mtime + 体积」判断是否跳过文件，
所以任何**只能靠读文件填充**的新字段，对已索引的曲目永远是 `undefined`。加内嵌歌词标记时
真实踩到了：扫描逻辑完全正确，界面上却一个徽章都不显示，因为索引是旧版本构建写的。

修复分两步：`INDEX_VERSION` 从 1 提到 2；`load()` 遇到旧版本时**照常加载**（仅标记 stale），
而不是直接丢弃——丢弃会让用户的曲库在升级后显示为空，比缺几个字段糟糕得多。
启动时若发现 stale 就在后台自动重扫，扫完通知界面刷新。

**文件夹列表是单向同步的，这曾经让曲库消失。** `settings.json` 的 `libraryFolders`
是界面编辑的那份，但索引也存了一份文件夹列表，两者可能不一致（写入中断、恢复备份、
索引迁移，或者一次失败的工具调用）。原来的代码只做「settings → 索引」一个方向的补齐，
所以一旦 settings 里的列表空了，索引也变空、界面显示 0 首，而且**永远不会自愈**——
音频文件明明都还在磁盘上。

现在启动时会把两边的文件夹列表**取并集**，只在文件夹真实存在时采用，并把结果写回
settings，下一次启动就从一致状态开始。另外，`scan()` 在「一个文件都没找到但索引里还有
曲目」时**不再覆盖索引**——那几乎总是文件夹列表丢了，而不是用户删了音乐；
把可恢复的配置问题变成可见的数据丢失是不可接受的。

如果确实遇到曲库为空，用这个恢复（音频文件本身不会被改动）：

```bash
node tools/probe/restore-library.mjs "D:\Music\华语歌曲" --scan
```

---

## 5. 后续方向

按性价比排序：

1. **原生音频输出**（WASAPI 独占 + APE/DSD 解码）。这是与 Salt Player 差距最大的一块，
   也是 `AudioEngine` 接口预留的位置。
2. **CUE 分轨**与 ReplayGain —— 本地无损曲库的常见需求。
3. **文件夹监听**（`fs.watch` + 防抖）替代手动重扫。
4. **标签编辑**与下载管理。
5. ~~酷狗/咪咕搜索适配器（需要签名算法）~~ —— 两个都已实现，且**都不需要签名**：酷狗用
   `song_search_v2` 而非要求签名的 `complexsearch`；咪咕用 v5 网页端自己调用的
   `app.u.nf.migu.cn/pc/resource/song/item/search/v1.0`，实测无 cookie、无 appKey、
   无签名即可返回 20 条。原先"需要签名算法"的判断来自旧移动端接口，那条路现在
   301 到 H5 首页，已经废弃。咪咕还把每条结果的 `lrcUrl` 直接放在搜索响应里，
   所以它的歌词适配器不需要第二次查询。

   补这个适配器顺带修好了一条静默失效的路径：平台抽测靠宿主搜索取测试曲
   （`probePlatform` 的 `deps.search`），而 `ONLINE_SOURCE_IDS` 早就包含 `mg`，
   于是咪咕此前只能报"无法取得该平台的测试歌曲"。
