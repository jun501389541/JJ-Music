# jj-source 权限与 URL 安全设计评审：E0

日期：2026-09-28　状态：Research 完成，结论冻结为 E2/E4/E6 的硬约束　上游：[Requirement Document](source-bound-online-capabilities.md) §9.4、[实施 Plan](source-bound-online-capabilities-plan.md) §1

本文档是 **E0**，在 Plan 中列为 **E2 的硬前置门槛**：`source-bound-online-capabilities-plan.md:10` 明确「E2 的硬前置门槛」，`source-bound-online-capabilities.md:181` 要求「E2 实现前必须逐条引用 E0 结论，不得从代码反推边界」。E2/E4/E6 的实现者必须直接引用本文 §6「决策条款」，不得重新推导。

**范围**：只定网络权限边界与 URL/响应校验边界，不改任何代码。E1 定协议与数据迁移，与本文无重叠（`source-bound-online-capabilities-plan.md:22`）。

**取证方式**：每一条非显然结论都标注 `路径:行号`，全部来自对本仓库当前代码的实际读取，未使用推测。

---

## 0. 结论速览

| # | 问题 | 决策 |
| --- | --- | --- |
| 1 | 网络能力来源 | **不新增域名白名单**；沿用子进程既有网络能力，脚本可自由 `fetch`。改为**「能力声明 + 导入时审查 + 运行时用户可见」**三段式 |
| 2 | URL / 重定向边界 | 宿主对脚本返回的每一个 URL 强制 `assertPublicHttpUrl`；**当前守卫是字符串级、不是 DNS 感知的**，必须在 E4 补齐解析后校验 |
| 3 | 响应体量上限 | 复用宿主已有数字（歌词 512 KiB、封面 8 MiB、歌单页 50×100、歌单总 5000 首）+ 新增脚本响应 JSON 上限 8 MiB |
| 4 | 凭据边界 | `jj-source` v1 **无 auth 能力**；脚本不得携带宿主凭据；声明 `auth` 不拒绝启动但不授予任何东西 |
| 5 | 失败语义归属 | 音源侧失败一律**音源归因 + 用户可见 + 绝不静默回退内置平台请求** |

---

## 1. 网络能力来源

### 1.1 现状证据

子进程的网络能力**已经是开放的，而且是被刻意保留的**。这不是一个待决策的空位，而是一个已经做出、且有实测依据的选择：

| 证据 | 位置 | 内容 |
| --- | --- | --- |
| 全局策略常量 | `src/main/sources/browser-shims.ts:301` | `export const NETWORK_GLOBALS_POLICY = 'available' as const` |
| 决策理由 | `src/main/sources/browser-shims.ts:280-300` | 早期版本移除过 `fetch`/`XMLHttpRequest`/`WebSocket`/`EventSource`，实测结果是本机真实聚合音源的子音源**全部以 `fetch is not a function` 失败**，比保留更差 |
| 保留的代价（已明示） | `src/main/sources/browser-shims.ts:294-299` | 「a script can now bypass `lx.request`, which means it also bypasses this host's timeout clamping, proxy handling and response-shape normalisation」 |
| 头部注释仍写着相反的话 | `src/main/sources/browser-shims.ts:23-25` | 「Deliberately NOT shimmed: `fetch`, `XMLHttpRequest`, `WebSocket`, `Image`」——**与实现矛盾**，见 §7 缺口 G1 |
| 脚本执行方式 | `src/main/sources/source-host.ts:786-787` | `const run = new Function(init.script)` + `run.call(globalThis)`，**在子进程真实全局上下文求值**，不是 `vm` 新上下文（理由见 `source-host.ts:780-784`） |
| 脚本可见 `process` | `src/main/sources/browser-shims.ts:14-15` | 实测脚本引用 `process` 7 次，shim 层刻意保留 |
| 子进程内存上限 | `src/main/sources/source-engine.ts:70` | `SOURCE_MEMORY_LIMIT_MB = 512`，通过 `execArgv: ['--max-old-space-size=512']` 生效（`source-engine.ts:306`） |

关键推论：因为脚本在**真实全局上下文**里用 `new Function` 求值（`source-host.ts:786`），任何"从全局删除 `fetch`"的做法都只在**求值之前**有效，而脚本可以用 `globalThis.constructor.constructor('return fetch')()` 之类的等价路径取回；同时移除 `fetch` 已被实测证明会打死真实音源。**因此"收回 `fetch`"在架构上不是一个可用选项**。

### 1.2 两种候选方案对比

| 维度 | 方案 A：沿用现状（脚本自由 `fetch`） | 方案 B：域名白名单（脚本头部声明 + 导入时批准） |
| --- | --- | --- |
| 与 `browser-shims.ts:301` 的兼容 | 完全一致 | 需要推翻已实测的结论，且只能拦住 `lx.request` 一路 |
| 能否真正拦住脚本 | 不适用 | **拦不住**：`new Function` + `globalThis`（`source-host.ts:786-787`）下，移除 `fetch` 已被证明会打死真实音源 |
| 白名单声明位置 | 不适用 | 只能放脚本头部（`script-header.ts:21-29` 的 `ScriptHeader`）——但头部是**脚本自己写的**，恶意脚本不会声明自己的真实域名 |
| 用户审查成本 | 无新增 | 每个音源弹一次数百域名的批准框，用户必然全点"同意" |
| 对真实生态的影响 | 无 | 本机 21 个音源（`source-engine.ts:123-127` 记录 `wy` 被 14 个音源声明）里，CDN 域名随平台改版变化，白名单会持续误伤 |
| 是否降低真实风险 | — | 很低：攻击者只需声明真域名、用假域名请求，或直接走 `fetch` |

**方案 B 的核心缺陷**：白名单只能约束"诚实的脚本"。它增加的是用户的操作负担和音源的维护负担，减少的不是攻击者的能力。这是典型的**安全剧场**。

### 1.3 决策 D1

> **D1：`jj-source` 运行时不引入域名白名单。脚本沿用子进程既有的完整网络能力（`NETWORK_GLOBALS_POLICY = 'available'`，`browser-shims.ts:301`）。**

理由按优先级：

1. **技术上拦不住**：脚本在真实全局上下文求值（`source-host.ts:786-787`），移除网络全局已实测失败（`browser-shims.ts:286-292`）。一个能被绕过的白名单比没有白名单更危险，因为它给用户**虚假的安全感**。
2. **架构上已决策**：`browser-shims.ts:280-300` 是一份有实测数据支撑的决策记录，推翻它需要同等强度的反证，而目前没有。
3. **风险模型匹配**：按 Plan 固化约束 1（`source-bound-online-capabilities-plan.md:26`），音源首版只允许「用户主动导入 + 显式启用」。**威胁模型是"用户主动运行的第三方代码"，不是"网页里的 XSS"**。对前者，正确的控制手段是隔离（子进程，已有）、可见性（审查 + 日志）、和归因（失败属于音源），而不是把网络能力当成可以被静态声明的属性。

因此 E2 采用**三段式替代控制**，而不是白名单：

| 段 | 控制点 | 当前实现位置 | E2 要做的事 |
| --- | --- | --- | --- |
| 导入前 | 静态风险评级，**不执行脚本** | `source-validator.ts:18-19`「Never executes the script」、`script-header.ts:117` `assessScriptRisk` | 无（已具备） |
| 导入时 | 风险等级 + 逐条理由展示给用户确认 | `source-store.ts:252` `...riskFor(api.script)`、`script-header.ts:95-99` `ScriptRiskReport.notes` | 无（已具备） |
| 默认态 | 新导入脚本**默认不启用** | `source-store.ts:148` `enabled: existing?.enabled ?? false`，理由见 `source-store.ts:142-147` | 无（已具备） |
| 运行中 | 能力声明诚实地反映脚本意图 + 失败归因到具体音源 | `source-engine.ts:1088` 错误串含 `scriptName` | **E2 新增：能力声明校验（§1.4）** |

### 1.4 E2 需新增的部分：能力声明（不是权限）

脚本在 `lx.send(inited, { sources })` 里通过 `actions` 声明自己实现哪些能力（`src/shared/types.ts:210`、`source-engine.ts:1213`）。

现状：`normaliseSources` **无条件接受**脚本声称的任何 `actions`（`source-engine.ts:1213`）：

```ts
actions: (Array.isArray(info.actions) ? info.actions : ['musicUrl']) as SourceAction[],
```

> **D1-a（E2 实现）**：`actions` 是**路由声明**，不是权限授予。E2 必须按 §6.1 的映射表校验每个 `jj-source` 能力名；未知或未实现的能力名**从 `actions` 中剔除并记入 `runtime.logs`**，不得因为脚本声明了它就把请求路由过去。

这一点很重要，因为路由是按能力做的：`getLyric` 直接 `if (!this.supports(source, 'lyric')) return { lyric: '' }`（`source-engine.ts:1103-1105`），`getPic` 同理（`source-engine.ts:1129`）。若 `actions` 被无条件采信，脚本声明 `leaderboard` 就会让宿主的榜单 UI 出现一个永远失败的入口。

---

## 2. URL / 重定向边界

### 2.1 现状证据：守卫是**字符串级**的，不是 DNS 感知的

这是本节最重要的事实，必须明确：

| 检查项 | 现状 | 位置 |
| --- | --- | --- |
| 协议必须是 http/https | ✅ 已实现 | `url-guard.ts:32-34` |
| URL 不得携带凭据 | ✅ 已实现 | `url-guard.ts:35` |
| 主机名黑名单（`localhost`/`.local`/`.internal`/`metadata.google.internal`） | ✅ 已实现 | `url-guard.ts:39-43` |
| IPv4 字面量黑名单（0/10/127/≥224、169.254、172.16-31、192.168、100.64-127） | ✅ 已实现 | `url-guard.ts:206-213` |
| IPv6 字面量黑名单（`::`/`::1`、fe80-feb、fc/fd、ff、`::ffff:`） | ✅ 已实现 | `url-guard.ts:215-220` |
| 尾点规范化（`localhost.` 绕过） | ✅ 已实现，且是**循环**剥点 | `url-guard.ts:88-90`，理由见 `url-guard.ts:72-87` |
| 白名单后缀点边界（`evil-migu.cn` 不能匹配 `migu.cn`） | ✅ 已实现 | `url-guard.ts:57-64` |
| 重定向逐跳复核 | ✅ 已实现，手工循环 | `url-guard.ts:143-157`、`resolveRedirect` `url-guard.ts:103-111` |
| 重定向上限 3 跳 | ✅ 已实现 | `url-guard.ts:113` `MAX_REDIRECTS = 3` |
| 重定向状态码集合 | ✅ 已实现 | `url-guard.ts:114` `{301,302,303,307,308}` |
| **DNS 解析后校验（防 DNS rebinding）** | ❌ **未实现** | 见下 |

**明确结论：`src/main/online/url-guard.ts` 的 `assertPublicHttpUrl` 是纯字符串级校验，它不解析 DNS，因此不是 DNS 感知的（DNS-aware）。**

代码自己的注释已经承认了这一点，`url-guard.ts:19-22`：

> 「What is still not covered: the hostname is resolved by the fetch itself, so a DNS name that points at a private address (rebinding) gets through. Closing that means pinning the resolved address, which is not expressible through `fetch`.」

`assertPublicHttpUrl` 的全部判断只作用于 `url.hostname` 字符串与 `isIP(host)` 的字面量分支（`url-guard.ts:45-46`）。**若脚本返回 `http://evil.example.com/`，而该域名 A 记录指向 `127.0.0.1` 或 `169.254.169.254`，当前守卫会放行**，随后 `fetch`（`url-guard.ts:144`）自行解析并连到内网地址。

### 2.2 当前守卫的调用点（哪些路径已受保护）

| 调用点 | 位置 | 说明 |
| --- | --- | --- |
| `isValidMusicUrl` → `assertPublicHttpUrl` | `source-engine.ts:1263-1275`，调用 `source-engine.ts:1270` | **播放地址已有校验**，且带 2048 字符上限（`source-engine.ts:1264`）与 `/^https?:/` 前缀检查（`source-engine.ts:1265`） |
| `getMusicUrl` 使用 | `source-engine.ts:1079` | `if (isValidMusicUrl(url))` |
| `getPic` 使用 | `source-engine.ts:1135` | `return isValidMusicUrl(url) ? url : ''` |
| `safeFetchResponse` 入口 | `url-guard.ts:141` | `let url = assertPublicHttpUrl(raw, allowedHosts)` |
| 逐跳重定向 | `url-guard.ts:152` | `url = resolveRedirect(location, url, allowedHosts)` |

**关键不对称**：`musicUrl` 和 `pic` 的返回值**经过了 `assertPublicHttpUrl`**（`source-engine.ts:1079`、`1135`），但只做了**字符串级**检查；而 `search`/`lyric`/`leaderboard`/`songList` 等**结构化响应**里的 URL 字段（例如 `OnlineMusicInfo.picUrl`，`src/shared/types.ts:163`）**当前没有任何脚本侧校验**——因为 `jj-source` 的搜索/榜单能力在 E2 之前还不存在。

### 2.3 decision D2

> **D2：宿主对脚本返回的每一个 URL 都必须在"使用前"与"重定向的每一跳"上通过同一套校验；校验必须是 DNS 感知的。**

> **D2-a（E4 实现，E2 预留接口）**：`assertPublicHttpUrl` 的字符串检查必须保留，但**不足以关闭 rebinding**。E4 必须在真正发起请求前补一步**解析后地址校验**（resolve → 校验所有返回的 A/AAAA 记录 → 用已验证地址连接或至少在解析后复核）。

E2 本身不实现网络抓取（那是 E4），但 E2 必须**不产生**任何绕过该管道的 URL 消费路径：即 `jj-source` 新增的 `search`/`leaderboard`/`songList` 响应中凡含 URL 的字段，宿主一律只**存储**，实际抓取时必须走 E4 的统一入口。

### 2.4 验收检查清单（E2/E4 必须逐条实现）

| # | 输入 | 规则 | 拒绝 |
| --- | --- | --- | --- |
| U1 | 任何脚本返回值中的 URL 字段 | 必须能被 `new URL()` 解析 | 拒绝 |
| U2 | 协议 | 仅 `http:` / `https:`；`file:`、`data:`、`blob:`、`javascript:`、`ftp:` 等一律拒绝 | 拒绝 |
| U3 | 凭据 | `url.username` / `url.password` 非空即拒绝 | 拒绝 |
| U4 | 主机名规范化 | 小写 + 去 IPv6 方括号 + **循环剥离所有尾点**（`url-guard.ts:88-90`） | 规范化后再判 |
| U5 | 内部名称 | `localhost`、`*.localhost`、`*.local`、`*.internal`、`metadata.google.internal` 拒绝（`url-guard.ts:39-43`） | 拒绝 |
| U6 | 内部 IP 字面量 | IPv4 走 `blockedIPv4`（`url-guard.ts:206-213`）；IPv6 走 `blockedIPv6`（`url-guard.ts:215-220`） | 拒绝 |
| U7 | 重定向 | 每次 301/302/303/307/308（`url-guard.ts:114`）的 `Location` 都相对当前 URL 解析（`url-guard.ts:103-111`）后**重新走 U1–U6** | 任一跳失败即整链失败 |
| U8 | 重定向次数 | > 3 跳（`url-guard.ts:113`）拒绝 | 拒绝 |
| U9 | **DNS 解析后** | 解析出的**每一个** A/AAAA 地址都必须通过 U6；任一为内部地址即拒绝 | 拒绝（**E4 新增**） |
| U10 | 播放地址形状 | 长度 ≤ 2048 且匹配 `/^https?:/`（`source-engine.ts:1264-1265`）后再走 U1–U9 | 视为"未返回有效播放地址" |

> **U9 是当前代码的缺口**。在 E4 补齐前，脚本返回一个指向攻击者控制域名的播放地址，而该域名解析到 `127.0.0.1`，宿主会连上本机服务。风险等级：**中高**（需要攻击者控制 DNS，但脚本本身已是第三方代码）。标注为 **现状缺口 G2**。

---

## 3. 响应体量上限

### 3.1 宿主已经强制的数字（必须复用，不新造）

| 对象 | 上限 | 位置 | 备注 |
| --- | --- | --- | --- |
| `safeFetch` 默认响应体 | `4 * 1024 * 1024` = **4 MiB** | `url-guard.ts:116` `DEFAULT_MAX_BYTES` | `safeFetchBytes` / `safeFetchText` 的默认值（`url-guard.ts:167`、`177`） |
| `safeFetch` 默认超时 | **12 000 ms** | `url-guard.ts:115` `DEFAULT_TIMEOUT_MS` | |
| 歌词响应体 | `512 * 1024` = **512 KiB** | `lyrics.ts:30` `LYRIC_MAX_BYTES`，用于 `lyrics.ts:45` 与 `lyrics.ts:171` | |
| 封面图片 | `8 * 1024 * 1024` = **8 MiB** | `cover-fetch.ts:69` `MAX_BYTES`，注释明说「not a fourth number」，用于 `cover-fetch.ts:92` | |
| 封面抓取超时 | **10 000 ms** | `cover-fetch.ts:70` `TIMEOUT_MS` | |
| 歌单导入单次响应体 | `20 * 1024 * 1024` = **20 MiB** | `playlist-import.ts:71` `readBounded(res, 20*1024*1024)` | |
| 咪咕歌单分页 | 每页 **50** 首 × 最多 **100** 页 | `playlist-import.ts:11` `MG_PAGE_SIZE = 50, MG_MAX_PAGE = 100`；循环 `playlist-import.ts:108` | 上限 5000 首 |
| 歌单总曲目 | **5000** 首 | `playlist-import.ts:85` `.slice(0,Math.max(0,5000-rows.length))`；`playlist-import.ts:148` `rows.slice(0,5000)` | |
| 网易云详情补全批量 | 每次 **100** 首 | `playlist-import.ts:88` `missing.slice(i,i+100)` | |
| 脚本单次请求超时 | **20 000 ms** | `source-engine.ts:68` `REQUEST_TIMEOUT_MS`，理由「LX cancels a request handler after 20 000 ms」；生效于 `source-engine.ts:921-923` | |
| 脚本初始化超时 | **15 000 ms** | `source-engine.ts:63` `INIT_TIMEOUT_MS` | |
| 心跳静默上限 | **20 000 ms** | `source-engine.ts:557` `HEARTBEAT_SILENCE_LIMIT_MS` | |
| 子进程内存 | **512 MB** | `source-engine.ts:70` / `306` | |
| 歌词字段截断 | `lyric` **51 200** / `tlyric` **5 120** / `rlyric` **5 120** / `lxlyric` **8 192**（字符） | `source-engine.ts:1120-1123`、`clampString` `source-engine.ts:1278-1281` | 镜像 LX 的静默截断 |
| 日志保留 | **200** 条 | `source-engine.ts:676` | |
| 启动并发 | **4** | `source-engine.ts:79` | |

### 3.2 新引入的数字（仅一个）

`lx.request` 的响应在子进程侧**完全无上限**：`source-host.ts:352` 直接 `Buffer.from(await response.arrayBuffer())`，之后把 `raw: buffer` 和解析结果一起通过 IPC 送回。这是当前唯一的无界点。

另一个独立的无界点：**IPC 响应本身**。`requestFrom`（`source-engine.ts:898-949`）对脚本通过 `lx.send` 返回的 `data` 没有任何尺寸检查，`handleMessage` 的 `response` 分支（`source-engine.ts:678-685`）直接 `pending.resolve(message.data)`。

> **D3：新增「脚本响应负载上限」= 8 MiB（`JJ_SOURCE_MAX_PAYLOAD_BYTES = 8 * 1024 * 1024`）。**

选 8 MiB 的理由：

1. 与 `cover-fetch.ts:69` 的封面上限**同值**，不引入第三个数字（该文件注释 `cover-fetch.ts:68` 已经确立了"不要造第四个数字"的纪律）。
2. 真实上限场景是**歌单/榜单页**。歌单总曲目被限制为 5000 首（`playlist-import.ts:85`、`148`），一首曲目的 JSON 记录约 200–400 字节，5000 首约 1–2 MB，8 MiB 有 4–8 倍余量。
3. 它是 `safeFetch` 默认 4 MiB（`url-guard.ts:116`）的 2 倍，因此**不会**误伤经过 `lx.request` 正常取回的合法响应。
4. 超限后是**可归因的失败**而不是内存事故：子进程已有 512 MB 上限（`source-engine.ts:70`），但超限应在此之前就给出明确错误。

### 3.3 完整上限表（E2 实现用）

| # | 对象 | 上限 | 来源 | 新增？ |
| --- | --- | --- | --- | --- |
| L1 | 单次 `jj-source` 响应负载（IPC / 请求文件） | **8 MiB** | 复用 `cover-fetch.ts:69` 同值 | ✅ 新声明 |
| L2 | 单次脚本请求时长 | **20 000 ms** | `source-engine.ts:68` / `921-923` | 否 |
| L3 | 脚本初始化 | **15 000 ms** | `source-engine.ts:63` | 否 |
| L4 | 歌单页数 | **100** | `playlist-import.ts:11` `MG_MAX_PAGE` | 否 |
| L5 | 每页曲目 | **50** | `playlist-import.ts:11` `MG_PAGE_SIZE` | 否 |
| L6 | 歌单总曲目 | **5000** | `playlist-import.ts:85`、`148` | 否 |
| L7 | 榜单页曲目 | **5000**（与歌单同值） | 沿用 L6，避免新数字 | ⚠️ 借 L6 |
| L8 | 歌词字段 | `lyric` 51 200 / `tlyric` 5 120 / `rlyric` 5 120 / `lxlyric` 8 192 字符 | `source-engine.ts:1120-1123` | 否 |
| L9 | 歌词 HTTP 响应体 | **512 KiB** | `lyrics.ts:30` | 否 |
| L10 | 图片响应体 | **8 MiB** | `cover-fetch.ts:69` | 否 |
| L11 | 图片抓取超时 | **10 000 ms** | `cover-fetch.ts:70` | 否 |
| L12 | 播放入口 URL 长度 | **2048** 字符 | `source-engine.ts:1264` | 否 |

**L7 说明**：榜单没有既有数字。借 L6 的 5000 而不是新造一个，遵循 `cover-fetch.ts:68` 已确立的纪律。若后续证明榜单页需要不同上限，必须在 E3 单独论证，不得在 E2 私自引入。

---

## 4. 凭据边界

### 4.1 现状证据

| 事实 | 位置 |
| --- | --- |
| `SourceAction` 联合类型包含 `'auth'` | `src/shared/types.ts:196`（完整定义 `types.ts:187-196`） |
| 全仓库**没有任何代码消费 `'auth'`** | grep `'auth'` 在 `src/**/*.ts` 只命中 `src/shared/types.ts:196` 这一处声明 |
| `normaliseSources` 原样保留脚本声明的 `actions` | `source-engine.ts:1213` |
| `getLyric` / `getPic` 按能力短路 | `source-engine.ts:1103-1105`、`source-engine.ts:1129` |
| `supports()` 只查 `actions` 数组 | `source-engine.ts:887-890` |
| `lx.request` 会给脚本注入 `User-Agent` | `source-host.ts:336`：`headers['User-Agent'] ??= \`lx-music-${init!.env}/${init!.version}\`` |
| `lx.request` 不注入任何宿主凭据 | `source-host.ts:303-336` 全程只操作脚本自带的 `options.headers` |

**结论**：`auth` 目前在类型上存在、在行为上不存在。它是从 LX 协议面继承来的历史字段，本实现从未赋予它任何语义。

### 4.2 决策 D4

> **D4：`jj-source` v1 不提供任何认证能力（no auth capability）。**

具体条款：

1. **脚本不得以宿主身份发请求**。宿主不持有任何平台账号凭据用于音源调用；`lx.request` 只注入一个标识性的 `User-Agent`（`source-host.ts:336`），那不是凭据。宿主既有的 `assertPublicHttpUrl` 也明确拒绝 URL 内嵌凭据（`url-guard.ts:35`）。
2. **脚本声明的 `auth` 能力不授予任何东西**。`normaliseSources`（`source-engine.ts:1191-1218`）**不因为**脚本声明 `auth` 而拒绝启动，也不因为声明 `auth` 而提供任何接口——它只是被记入 `SourceInfo.actions`（`source-engine.ts:1213`）。
3. **E2 必须把 `auth` 从脚本可见的能力集合中剔除**（与 §1.4 的 D1-a 一致）：脚本可以声明它（不报错，保持与 LX 生态的兼容），但宿主**不得**出现任何依赖它的路由分支。理由：`supports()`（`source-engine.ts:887-890`）是全仓库唯一的能力判定入口，一旦 `auth` 进入 `actions` 且未来有人按 `supports(source, 'auth')` 分支，就会凭空产生一个"认证"概念，而 v1 没有任何凭据存储设施。
4. **用户凭据只能由用户在宿主 UI 内提供**。若未来某个平台确实需要登录，方案必须是宿主持有凭据并通过受控接口供音源使用，而**不是**让音源脚本自己存账号密码。此事**不在 v1 范围**，列为 §8 未决项。

> **风险提示**：脚本完全可以无视上述约定，自己在脚本里硬编码账号或用 `fetch` 自行登录。这是 §1.3 威胁模型的直接推论——**宿主无法阻止脚本做任何网络请求，能做的是不让宿主自己的凭据外泄**。D4 保护的是宿主凭据，不是平台账号。

---

## 5. 失败语义归属

### 5.1 总原则

> **D5：音源侧失败一律「音源归因 + 用户可见 + 绝不静默回退到内置平台请求」。**

这条直接对应需求文档 §6 的 "no silent fallback" 约束（`source-bound-online-capabilities.md:181` 引用 Plan 固化约束，以及 Plan 风险 2：`source-bound-online-capabilities-plan.md:130`「AC3 是破坏性行为变更：禁用所有完整音源后内置平台请求不得再发出」）。

**归属规则的实质**：失败要么是音源的错，要么是用户的配置状态，**从来不是"平台暂时不可用所以宿主偷偷用内置接口"**。

### 5.2 逐类失败语义

| # | 失败类 | 触发证据（位置） | 归因 | 用户可见 | 用户可见行为 / 空状态 |
| --- | --- | --- | --- | --- | --- |
| F1 | **请求超时** | `source-engine.ts:921-923` → `音源请求超时（20s）` | 音源 | ✅ 是 | 该曲目播放失败提示，文案含音源名与"超时"；不自动重试，不回退内置 |
| F2 | **初始化超时** | `source-engine.ts:63` `INIT_TIMEOUT_MS = 15_000` | 音源 | ✅ 是 | 音源卡片显示未启用 + 错误原因；`store.setEnabled(false)` |
| F3 | **子进程崩溃 / 退出** | `handleChildExit` `source-engine.ts:598-649`；信号或退出码 > 128 判定 `aborted`（`source-engine.ts:616-617`） | 音源 | ✅ 是 | 文案「音源进程被脚本强制终止…该脚本可能带有反调试/自我保护逻辑。已隔离，不影响其他音源。」（`source-engine.ts:619-621`）；`setError` + `setEnabled(false)`（`source-engine.ts:642-643`） |
| F4 | **心跳丢失（假死）** | `source-engine.ts:557` `HEARTBEAT_SILENCE_LIMIT_MS = 20_000`；文案 `source-engine.ts:569-571` | 音源 | ✅ 是 | 「音源进程已停止响应（心跳丢失 Ns）…已隔离」；`store.quarantine`（`source-engine.ts:576`） |
| F5 | **退出码 1（自毁）** | `source-engine.ts:622-625` | 音源 | ✅ 是 | 「脚本在初始化时结束了自己的进程…常见原因是环境自检失败…」 |
| F6 | **响应格式错误 / 字段缺失** | `isValidMusicUrl` 返回 false → `source-engine.ts:1082` `未返回有效播放地址`；歌词缺失被规范化为空串 `source-engine.ts:1120` | 音源 | ✅ 是（播放）／⚠️ 静默（歌词） | 播放：失败提示且列出每个品质的失败原因（`source-engine.ts:1082`、`1088`）。歌词：**当前静默降级为无歌词**，见缺口 G3 |
| F7 | **响应超限** | 新增 L1（§3.3）；`readBounded` 的 `响应超过大小限制`（`read-bounded.ts:3`、`8`） | 音源 | ✅ 是 | 明确提示"音源返回数据过大"，属音源归因，不是下载失败 |
| F8 | **URL 被拒绝** | `source-engine.ts:1270` `assertPublicHttpUrl` 抛错 → `isValidMusicUrl` false → `source-engine.ts:1082` | 音源（安全拦截） | ✅ 是 | 播放失败提示；**日志需明确写"返回地址被安全策略拒绝"**，与"无地址"区分，否则用户会误判为音源失效 |
| F9 | **无具备该能力的音源** | `source-engine.ts:1050-1052` `音源「X」已停止或没有可用的音源支持该平台`；`source-engine.ts:1092` `没有音源支持「X」的播放地址解析` | 用户配置 | ✅ 是 | 明确空状态："未安装支持 X 的音源"，**引导到设置页**；**绝不**回退内置平台请求（AC3） |
| F10 | **音源已禁用** | `source-engine.ts:1045-1048` 过滤 `runtime.dead`；禁用脚本不启动即无 runtime | 用户配置 | ✅ 是 | 同 F9，但文案区分"已禁用"与"未安装"；同样不回退 |
| F11 | **脚本已隔离（quarantined）** | `source-store.ts:186-190`；隔离态拒绝重新启用 `source-store.ts:173` | 音源 | ✅ 是 | 卡片显示隔离原因，工具栏提供"解除隔离"（`source-store.ts:195-199` 的 `unquarantine` 语义） |

### 5.3 归属判定的两条硬规则

> **D5-a**：**任何**失败都不得触发内置平台请求。实现上这意味着 E3/E4 在迁移收口（`source-bound-online-capabilities-plan.md:120-125` 的 E7）后，`src/main/online/*` 的平台直连函数不得再被在线能力路径调用。验证方式按 Plan 要求做平台请求拦截检查。

> **D5-b**：失败信息必须携带**音源名**。现状已经做到：`getMusicUrl` 的错误串包含 `scriptName`（`source-engine.ts:1069` `runtime?.api.meta.name ?? apiId`，拼装于 `source-engine.ts:1088`）与逐品质原因（`source-engine.ts:1082`）。E2 新增能力（搜索/榜单/歌单）必须沿用同一格式，不得退化为裸 `Error`。

---

## 6. 决策条款（E2 直接实现）

本节是 E2 的契约。以下每条都是**可编码的**，不需要再做判断。

### 6.1 网络权限

- `NETWORK_GLOBALS_POLICY = 'available'`（`browser-shims.ts:301`）保持不变；**不新增域名白名单**。
- 不修改 `browser-shims.ts` 的全局暴露集合。若必须改动，唯一的允许方向是**修正 `browser-shims.ts:23-25` 那段与实现矛盾的注释**，不得改动行为。
- 脚本通过 `lx.send(inited, { sources })` 声明的 `actions` 是**路由声明**，必须按 §6.2 校验。

### 6.2 能力名校验

| 能力名 | v1 是否路由 | E2 行为 |
| --- | --- | --- |
| `musicUrl` / `lyric` / `pic` | ✅（沿用现状，`source-engine.ts:1079`/`1103`/`1129`） | 保留 |
| `search` / `hotSearch` / `tipSearch` | ✅（E2 新增） | 实现 |
| `songList` / `leaderboard` | ✅（E2 新增，只读，按 Plan 约束 3 `source-bound-online-capabilities-plan.md:28`） | 实现 |
| `auth` | ❌ | **不路由**；不报错；记入日志；不提供任何凭据设施（§4.2 D4-3） |
| 未知字符串 | ❌ | 从 `actions` 剔除，记入 `runtime.logs` |

### 6.3 URL 校验

- 所有 URL 校验必须**复用** `src/main/online/url-guard.ts` 的导出，**不得**新建第二套校验（`isHostAllowed` 的点边界语义在 `url-guard.ts:57-64` 有明确的踩坑注释，复制必然出错）。
- 播放地址必须同时满足 U10（`source-engine.ts:1264-1265`）与 U1–U9（§2.4）。
- E2 **不得**引入任何绕过 `safeFetchResponse`（`url-guard.ts:135`）的直接 `fetch` 调用；若 E2 阶段确需抓取，用 `safeFetchBytes`/`safeFetchText`。
- DNS 感知校验（U9）由 E4 实现；E2 必须在代码注释中显式指向 U9 缺口，避免 E4 遗漏。

### 6.4 体量上限

- 按 §3.3 表逐条实现；L1 为新增常量，命名建议 `JJ_SOURCE_MAX_PAYLOAD_BYTES = 8 * 1024 * 1024`。常量必须**引用来源注释**（`cover-fetch.ts:69`），不得凭空出现。
- 超限必须抛出可归因错误（F7），**不得**静默截断。注意这里与既有的歌词截断（`source-engine.ts:1120-1123`）不同：歌词截断是**已知的、镜像 LX 的**行为；新上限是防事故的硬边界。

### 6.5 凭据

- 实现 §4.2 D4 全部四条。
- `auth` 不得进入任何 `supports()` 分支（`source-engine.ts:887-890`）。

### 6.6 失败语义

- 实现 §5.2 表格的全部行为。
- 必须满足 D5-a（无静默回退）与 D5-b（错误携带音源名）。

---

## 7. 现状缺口（标注为「现状缺口」）

| # | 缺口 | 证据 | 风险 | 归属 |
| --- | --- | --- | --- | --- |
| G1 | `browser-shims.ts` 文件头注释宣称不提供 `fetch`/`XHR`/`WebSocket`，而实现与 `NETWORK_GLOBALS_POLICY` 明确保留 | 注释 `browser-shims.ts:23-25` vs 实现 `browser-shims.ts:280-301` | **文档与实现相反**，后续维护者可能按注释"修复"代码，重新打死真实音源（`browser-shims.ts:286-292` 记录过这次事故） | 建议 E2 顺手修正注释（仅注释） |
| G2 | **守卫不是 DNS 感知的**，DNS rebinding 可绕过 | `url-guard.ts:19-22`（自述）；`url-guard.ts:45-46` 仅判字面量 | 脚本返回指向内网/metadata 的域名即可通过校验；**这是 §2 的核心缺口** | **E4 必须修**（U9） |
| G3 | 歌词缺失被静默规范化为空串 | `source-engine.ts:1120` `clampString(...) ?? ''` | 用户看到"无歌词"，无法区分"平台确实没有"与"音源坏了" | E2/E3 评估是否需要在 UI 区分 |
| G4 | IPC 响应负载无尺寸检查 | `source-engine.ts:678-685` `pending.resolve(message.data)` | 脚本返回超大对象时，主进程承受内存压力；子进程的 512 MB 上限（`source-engine.ts:70`）**保护不了主进程** | **E2 用 L1 修** |
| G5 | `lx.request` 响应无上限 | `source-host.ts:352` `Buffer.from(await response.arrayBuffer())` | 同上，且发生在子进程内 | **E2 用 L1 修** |
| G6 | `normaliseSources` 无条件采信脚本 `actions` | `source-engine.ts:1213` | 脚本可声明未实现的能力，制造永远失败的 UI 入口 | **E2 用 §6.2 修** |
| G7 | `'auth'` 在类型中存在但全仓库无消费者 | 声明 `types.ts:196`；grep 仅此一处 | 未来有人按 `supports(source,'auth')` 分支就会凭空造出无凭据设施的"认证" | **E2 用 §6.2 明确剔除** |
| G8 | `getPic` 捕获所有异常并返回 `''` | `source-engine.ts:1136-1139` | 封面失败完全静默；与 D5-b 的"携音源名"原则不完全一致 | 可接受（与 `cover-fetch.ts:96-98` 的"never throws"一致），但需在 E4 复核 |

---

## 8. 未决 / 需人工确认

1. **第三方脚本的准入**——**已由 Plan 决策，不在本文重开**：按 `source-bound-online-capabilities-plan.md:26`（固化约束 1）与 `source-bound-online-capabilities.md:178`，首版只允许"用户主动导入 + 显式启用"，**不建官方目录，不引入可信发布者机制**。本文的 §1.3 决策 D1 与之一致。
2. **是否允许脚本自建平台登录**——D4 只保护宿主凭据。脚本自行硬编码账号或自行 `fetch` 登录，宿主既不阻止也不代管。若产品上需要"音源登录某平台"，需**单独立项**：涉及宿主凭据存储、UI 交互、以及撤销机制，**不在 v1**。
3. **U9（DNS 感知校验）的具体实现路径**——`url-guard.ts:19-22` 已指出难点：「pinning the resolved address ... is not expressible through `fetch`」。可选路径包括自定义 `undici` Agent 的 `lookup` 钩子、或在解析后校验并接受 TOCTOU 窗口。**需要 E4 做一次技术选型**，本文只冻结"必须做"，不冻结"怎么做"。
4. **L7（榜单页曲目上限）**——本文借用了 L6 的 5000（`playlist-import.ts:85`）。若真实榜单页规模显著不同，需 E3 用实测数据单独论证。
5. **`plugin`/`singer` 等新增能力的引入与否**——`SourceAction`（`types.ts:187-196`）当前不含艺人图片相关能力，而需求文档把"艺人图片"列为迁移目标。其能力名与响应形状需 E1 定协议时确定，本文不预设。

---

## 9. 输入 → 校验点 → 拒绝后的用户可见行为

覆盖脚本可返回的每一类输入。校验点列出的 `路径:行号` 为**现状**；标 ⚠️ 的为 **E2/E4 新增**。

| # | 输入类别 | 具体输入 | 校验点（现状 → 新增） | 拒绝/失败后的用户可见行为 |
| --- | --- | --- | --- | --- |
| 1 | 播放地址 | `musicUrl` 返回的字符串 | `isValidMusicUrl` `source-engine.ts:1263-1275`（长度 2048、`/^https?:/`、`assertPublicHttpUrl`）→ ⚠️ **U9 DNS 解析后校验（E4）** | 逐品质失败原因汇总，「无法获取播放地址（音源名 → 320k: 未返回有效播放地址；…）」（`source-engine.ts:1082`、`1094`）；**不回退内置** |
| 2 | 播放地址 | 空串 / 非字符串 / > 2048 字符 | `source-engine.ts:1264` | 同上：视为"该品质不可用"，继续走品质阶梯（`source-engine.ts:1072`） |
| 3 | 播放地址 | `file:` / `data:` / 其他非 http(s) | `url-guard.ts:32-34` | 同上；日志标明"地址被安全策略拒绝"（F8） |
| 4 | 播放地址 | localhost / 内网 IP 字面量 | `url-guard.ts:39-46`、`206-220` | 同上 |
| 5 | 播放地址 | URL 内嵌凭据 | `url-guard.ts:35` | 同上 |
| 6 | 播放地址 | 解析到内网地址的公网域名（rebinding） | ⚠️ **U9（E4 新增）**；现状**放行**（缺口 G2） | ⚠️ 补齐后：播放失败 + 安全拒绝提示 |
| 7 | 封面地址 | `pic` 返回的 URL | `source-engine.ts:1135` + `isValidMusicUrl` → ⚠️ U9 | 封面为空，**静默**（`source-engine.ts:1136-1139`、缺口 G8）；播放不受影响 |
| 8 | 封面图片字节 | 宿主抓取到的图片体 | `cover-fetch.ts:92` `maxBytes: 8 MiB`；MIME 白名单 `cover-fetch.ts:93`；空体拒绝 `cover-fetch.ts:94` | `fetchCoverBytes` 返回 `null`（`cover-fetch.ts:96-98` "never throws"），封面不更新 |
| 9 | 封面跨域重定向 | 302 → 其他域 | `url-guard.ts:143-157` 逐跳复核；host 白名单 `cover-fetch.ts:60-66` `COVER_HOSTS` | 该跳被拒 → 整链失败 → 封面不更新 |
| 10 | 艺人图片 | 返回的图片 URL | ⚠️ **E2 新增字段校验**；抓取走 `safeFetchBytes` | 艺人图片占位图；不阻断其他结果 |
| 11 | 歌词文本 | `lyric`/`tlyric`/`rlyric`/`lxlyric` | `clampString` `source-engine.ts:1278-1281`，上限 `1120-1123` | 超长**静默截断**（镜像 LX）；缺失 → 空串（缺口 G3） |
| 12 | 歌词源 URL | 歌词响应中的来源地址 | ⚠️ **E2 新增**：按 U1–U9 校验后再由宿主抓取 | 歌词不可用；提示"歌词来源不可用" |
| 13 | 搜索响应 | `search` 返回的曲目数组 | ⚠️ **E2 新增**：数组形状、逐条 `OnlineMusicInfo` 字段、响应 ≤ L1 | 该音源搜索结果丢弃 + 音源名提示；**其他音源结果照常展示** |
| 14 | 搜索结果中的封面 URL | 结果项 `picUrl` | ⚠️ **E2 新增**：存储前校验（U1–U6）；抓取时 U9 | 该条封面为空，列表仍展示 |
| 15 | 热词 | `hotSearch` 返回的字符串数组 | ⚠️ **E2 新增**：元素为字符串、条数上限、总长上限 | 热词区空状态："该音源未提供热词" |
| 16 | 歌单响应 | `songList` 返回的曲目数组与元数据 | ⚠️ **E2 新增**：页数 ≤ L4(100)、每页 ≤ L5(50)、总计 ≤ L6(5000)、响应 ≤ L1 | 导入中止并提示实际超限项；**不写入部分数据**（对齐 `playlist-import.ts:115-118` 的"不静默半结果"原则） |
| 17 | 榜单响应 | `leaderboard` 返回的曲目数组 | ⚠️ **E2 新增**：总计 ≤ L7(5000)、响应 ≤ L1 | 榜单页空状态 + 音源名 |
| 18 | 响应负载 | 任意 `lx.send` 回传的 `data` | ⚠️ **E2 新增 L1 = 8 MiB**（缺口 G4） | 明确提示"音源返回数据过大"，音源归因（F7） |
| 19 | `lx.request` 响应 | 脚本内部 HTTP 响应 | ⚠️ **E2 新增 L1**（缺口 G5，`source-host.ts:352`） | 该请求失败并抛出，脚本自行处理 |
| 20 | 能力声明 | `lx.send(inited, { sources })` 的 `actions` | `normaliseSources` `source-engine.ts:1191-1218` → ⚠️ **E2 §6.2 白名单**（缺口 G6/G7） | 未识别能力被剔除并记日志；UI 不出现对应入口 |
| 21 | 平台 id 声明 | `sources` 的键 | `source-engine.ts:1195`（拒绝 `local`）、`1198`（拒绝非 `music`） | 该平台不出现在路由表中（`source-engine.ts:1184-1189`） |
| 22 | 初始化 | 15 s 内未 `lx.send(inited, …)` | `source-engine.ts:63` / `source-host.ts:791-795` | 音源卡片显示未启用 + 「脚本执行完毕但没有调用 lx.send(inited, ...)」 |
| 23 | 进程行为 | 脚本自杀 / 崩溃 / 假死 | `source-engine.ts:598-649`、`557-582` | 隔离提示（含"已隔离，不影响其他音源"）+ 自动 `setEnabled(false)` |
| 24 | 脚本代码 | 导入时的静态特征 | `assessScriptRisk` `script-header.ts:117-189`；`validateSourceBeforeStart` `source-validator.ts` | 导入确认框展示 `risk` + `notes`；`block` 级发现拒绝启动（`source-validator.ts:265`） |
| 25 | 无可用音源 | 未安装 / 已禁用 / 无该能力 | `source-engine.ts:1050-1052`、`1092`；`supports` `887-890` | 明确空状态 + 引导设置页；文案区分"未安装"与"已禁用"；**绝不回退内置**（D5-a / AC3） |

---

## 10. 与下游任务的约束关系

| 任务 | 被本文约束的条款 |
| --- | --- |
| **E2**（运行时/能力路由） | §6 全部；必须逐条引用，不得从代码反推（`source-bound-online-capabilities.md:181`）。特别：L1（G4/G5）、§6.2（G6/G7）、§5.2 全部失败语义 |
| **E4**（宿主 URL/图片抓取校验） | §2.4 U9（G2，DNS 感知校验）；§3.3 L9–L11（复用 `lyrics.ts:30`、`cover-fetch.ts:69-70`）；§8 未决项 3 的技术选型 |
| **E6**（更新来源信任边界） | §1.3 D1 的信任模型；`source-store.ts:139-148` 的"重新导入保留用户启用选择"语义；`source-store.ts:186-199` 的隔离与解除隔离 |
| **E7**（迁移收口） | D5-a：平台请求拦截检查必须证明禁用全部音源后**没有任何**内置平台请求发出 |

---

**文档结束**。本文不修改任何代码或其它文档。
