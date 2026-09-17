# LX Music 音源 Ecosystem — Supplementary Community & Legal Notes

**Status:** This is a *supplementary* research pass, produced by a parallel investigation and written to disk by the coordinating agent because the originating agent reported saving it but did not actually create the file. Its findings are **integrated into the main report** (`lx-music-yinyuan-research.md`) where they matter; this file preserves the raw detail, especially the endpoint-liveness measurements.

**Method note (reproducible):** `web_fetch` refuses `application/javascript`, and this sandbox's local TLS is broken. All ten source scripts were therefore downloaded with **Node 24 `fetch()`** into `_research/` and inspected locally. `gh-proxy.com` also proxies `api.github.com`, which unlocked primary-source repo/release/issue data. The liveness probe in §B2 was **independently re-run and reproduced** by the coordinating agent.

---

## (A) How users share and import sources

### A1. Two import paths

**本地导入 (local file import)** exists from the feature's introduction: desktop **v1.8.0 (2021-03-07)** — `- 新增自定义源功能，源编写规则可以去常见问题查看` ([CHANGELOG](https://gh-proxy.com/https://raw.githubusercontent.com/lyswhut/lx-music-desktop/master/CHANGELOG.md)). *(Coordinating agent independently confirmed v1.8.0 / 2021-03-07 via the GitHub releases API, and via issue #409 `增加自定义源音乐来源`, opened 2021-01-06, closed 2021-03-07.)*

**在线导入 (online import by URL)** was added much later, desktop **v2.7.0 (2024-04-14)**: `- 新增在线自定义源导入功能，允许通过http/https链接导入自定义源`; mobile **v1.3.0 (2024-04-14)**: `- 新增在线自定义源导入功能`. So online import is ~3 years younger than local import and arrived ~2 months *after* the built-in sources were removed. **(verified)**

**Size cap, and its own bug history** — desktop v2.8.0 (2024-06-01) fixed it twice in one release: `- 增大在线导入自定义源文件的大小限制问题（#1857）` and `- 增大在线导入自定义源文件的大小限制，解决某些音源无法导入的问题（#1857）`. This is the *official* explanation for a very common real-world failure: large obfuscated sources (六音 is 333 KB) exceeding the online-import limit. **(verified)**

### A2. Why links break — concrete, verified mechanisms

1. **Size limit on online import** (above). Fix: download the `.js` and use 本地导入. This is exactly what `skxingyu/lx_music-` tells users to do — its README now says `## ⭐ 推荐方式：使用最新音源包（本地导入）` … `在线音源未做测试，请自行尝试`. **(verified)**
2. **GitHub raw is unreachable/slow from mainland China.** pdone's README ships an entire "加速链接" section plus a mirror list: `gh.llkk.cc`, `github.moeyy.xyz`, `ghproxy.cn`, `gh.api.99988866.xyz`, `ghp.ci`, `gh-proxy.org` — and advises `加速链接仅推荐访问GitHub受限的用户使用`. **(verified)** Note this mirror list is itself a fragility: several of those domains are dead or intermittent, and `ghproxy.net` (used in the README's own examples) was unreachable from this sandbox.
3. **jsDelivr as an alternative CDN**, e.g. Huibq's own README publishes `https://fastly.jsdelivr.net/gh/Huibq/keep-alive/render_api.js`. Note it uses **fastly.jsdelivr.net**, not `cdn.jsdelivr.net` — consistent with the mainland-access problems.
4. **Repos going silent / being archived.** `LuoXiaohei-2025/LX-music-collection` (a version+source archive) is **`archived: true`** (pushed 2025-12-06). `ZxwyWebSite/lx-source` (700★, MIT) is **`archived: true`**, last push 2024-06-22. `timeshiftsauce/CeruMusic` (1,916★) is archived — and is referred to in a source repo's README as `（很不幸，归档了）`. **(verified via GitHub API)**
5. **Distributing outside git entirely.** Several communities now ship `.zip` bundles on netdisks instead of URLs — e.g. 52pojie answers link Quark/UC drive folders, and `skxingyu/lx_music-` commits `0912-update.zip` / `音源接口-2026-8更新.zip` into the repo. This is a direct response to URL rot. **(verified)**

### A3. Real shared URLs in the wild (verified, fetched successfully)

`pdone/lx-music-source` publishes 10 raw URLs, each with a `ghproxy.net` twin. Its full file list is **20 files**, with `latest.js` hard-linked (identical hash) to a versioned file — i.e. the repo maintains a stable alias so the shared URL never changes while the payload updates:

| Source | path | bytes |
|---|---|---|
| SixYin 六音 | `sixyin/latest.js` (= `1.2.1.js`) | 333,015 |
| Huibq 花 | `huibq/latest.js` (= `1.2.0.js`) | 2,727 |
| LX 独家音源 | `lx/latest.js` (= `4.js`) | 114,852 |
| Flower 野花 | `flower/latest.js` (= `1.js`) | 10,057 |
| Grass 野草 | `grass/latest.js` (= `1.js`) | 9,176 |
| ikun | `ikun/latest.js` (= `22.js`) | 4,991 |
| ChangQing 长青 | `changqing/latest.js` | 27,553 |
| HuanYin 幻音 | `huanyin/latest.js` | 6,992 |
| JuheApi | `juhe/latest.js` (= `3.js`) | 994 |
| QDY 全豆要 | `qdy/latest.js` | 28,834 |

`latest.js` == the versioned file in every case where both exist. Repo also contains `CreateLatest.py` (753 B) and `AGENTS.md` — automation that regenerates `latest.js`. **(verified)**

The URL `.../pdone/lx-music-source/main/huibq/latest.js` is confirmed real and is quoted verbatim in the 52pojie thread and in `skxingyu/lx_music-`'s README. **(verified)**

### A4. UI flow, as described by community walkthroughs

CSDN walkthrough: 设置 → 基本设置 → **自定义源管理** → 导入 → 选文件 → then **勾选/启用 the source** (users commonly forget this step). It also notes `软件默认关闭下载功能，需要到设置里手动打开` — i.e. download is a separate opt-in. **(community claim; corroborated by the official docs' 自定义源管理 dialog and by CHANGELOG v2.11.0 referencing 「自定义源管理」对话框.)**

A recurring friction point: a **20-source import cap**. MT论坛 thread title: `LX Music怎么去除导入音源的上限（20条）`. *(Coordinating agent upgraded this from "community claim" to **verified**: the app's own i18n contains `user_api__max_tip: "最多只能同时存在 20 个源哦🤪\n想要继续导入的话，请先移除一些旧的源腾出位置吧"`.)*

---

## (B) 音源失效 — why sources stop working

### B1. THE "1.6.0 / API v1→v2" CLAIM: refuted as stated, but with a real kernel

The AIGC article asserts: `是API接口版本从v1升级到了v2` with `请求头格式新增了 X-API-Version 字段` … `身份验证方式从简单Token变更为JWT（JSON Web Token）认证`. It is footered `版权声明：本文由 AtomGit 博客平台 AIGC 生成并经审核发布`. **All three of those mechanisms are fabricated.** The real API v2.0.0 change (desktop v2.6.0) is the `window.lx` → `globalThis.lx` migration. **(verified — matches the coordinating agent's independent finding.)**

The article also invents: a `sixyin-music-source-v1.0.7.js` at a `New_lxmusic_source` repo; an "音源管理" nav item; a "已安装音源" screen; a version-compatibility table (`1.6.0–1.6.5 → v1.0.7`, `1.7.0+ → v1.1.0+`). **The repo it cites is real** — `laosunmaker/New_lxmusic_source`, **Apache-2.0**, 333★, created 2024-02-01, containing exactly 3 files including `sixyin-music-source-v1.0.7.js` (1,398,468 B). So the *filename and repo are real* but the API story is invented. **(verified)**

**Where "1.6.0" actually comes from** — the real repo's README opens:

> 洛雪音乐1.6.0之后，六音音源失效，好在有大佬修复此音源

So a genuine community author did write "1.6.0", and the AIGC blog laundered that into a fake technical mechanism. **(verified)**

**Inference (labelled):** "1.6.0" is almost certainly **mobile v1.6.0 (2024-08-24)**, not desktop — desktop v1.6.0 is **2021-01-10**, five years before 自定义源 existed (introduced desktop **v1.8.0**, 2021-03-07). Mobile v1.6.0's changelog shows nothing about sources, which is itself informative: mobile 1.5.0/1.6.0 were released 2024-08-03/2024-08-24, deep in the post-removal era when everyone was juggling third-party sources. **I could not verify the exact version-to-breakage mapping and the author never explains it.** The same README's addendum undercuts the premise: `4月14日后记：六音还在正常提供音源，现在也没有这么高需求了，所以在新音源消失之前，此仓库将不再更新` — i.e. **the "fix repo" author himself says sixyin was fine again and the repo is frozen.** **(verified)**

### B2. Concrete, verifiable breakage causes

**(i) The app's own custom-source API version bumps — verified and well documented.** Desktop v2.6.0's release note leads with a blunt warning: `由于自定义源的调用方式变更，可能会导致某些第三方源停止工作，如果出现这种情况，你需要将LX回退到 v2.5.0`. The breaking list: `window.lx` → `globalThis.lx`; `inited` no longer takes `status`; new `lx.env`, `lx.currentScriptInfo`; **`globalThis.lx.version` bumped to `2.0.0`**; scripts no longer executed via a `<script>` tag; new `local`-source `musicUrl`/`pic`/`lyric`. **(verified via both CHANGELOG and release API.)**

The API version has moved repeatedly, each move a potential break: **v1.3.0** at desktop v2.2.1 (`utils` gained `zlib.inflate`/`zlib.deflate`), **v2.0.0** at desktop v2.6.0, plus a `version` field added at v1.15.0 and `utils.buffer.bufToString` added there. **(verified)**

This is why `juhe/latest.js` contains a defensive version gate — it fetches `/init.conf` and calls `send(EVENT_NAMES.updateAlert, ...)` if the server's `update.version` exceeds the running `version`. Source authors now have to ship compatibility shims. **(verified by reading the script.)**

**(ii) Server-side relay endpoints dying — verified, and this is the dominant cause today.** Hostnames were extracted from all 10 scripts and each probed. **Reproduced independently by the coordinating agent.**

| Endpoint | Script | Probe result |
|---|---|---|
| `lxmusicapi.onrender.com` | huibq | **HTTP 503** (Render cold-start/over-quota page) |
| `api.ikunshare.com` | ikun | **connection failure / ENOTFOUND** |
| `api.music.lerd.dpdns.org` | juhe | 200 — `/init.conf` returns `{"code":200,...}` |
| `88.lxmusic.xn--fiqs8s` | lx | 200 — `{"code":0,"msg":"success"}` |
| `13413.kstore.vip` | changqing | 200 — returns `{"version":"1.3.0","updateUrl":"https://www.yuque.com/..."}` |
| `api.huibq.com`, `api.lingchuan.com`, `music-dl.sayqz.com`, `proxy.qishui.vsaa.cn` | qdy/huanyin | **connection failure** |
| `music-api.gdstudio.xyz` | qdy | **timeout after 11 s** (yet `/api.php` returns an HTML landing page on retry — flaky) |
| `music.haitangw.cc`, `musicapi.haitangw.net`, `yinyue.haitangw.net` | qdy/changqing | **HTTP 403** |
| `api.vsaa.cn`, `api.xcvts.cn`, `oiapi.net`, `music.nxinxz.com` | qdy/huanyin | 200 |

**(verified by direct probe, 2026-09-16.)** Caveat: some failures may be sandbox network policy rather than genuine death. But the pattern is unambiguous — **6 of 19 relay hosts hard-down, 3 return 403, 1 returns 503.** A source is only as alive as its relay. **This is the single most important structural fact about 音源失效.**

**(iii) Obfuscation blocking repair — verified, and it is a spectrum, not a binary.** Measured across the 10 scripts:

| Script | bytes | lines | `_0x` idents | style |
|---|---|---|---|---|
| sixyin | 332,677 | **12** | **16,316** | javascript-obfuscator, string-array + control-flow |
| lx (独家音源) | 58,760 | 14 | 0 | custom Arabic/PUA-symbol identifier obfuscation + `SERVER_SCRIPT_CONFIG` |
| changqing | 27,553 | 10 | 0 | custom numeric-XOR string decoder |
| flower / grass | ~10k | **6** | 0 | obfuscator.io-style (`\x` escapes, hex arithmetic) |
| qdy | 28,834 | 831 | 0 | **readable source** with comments |
| huanyin / huibq / ikun / juhe | 1–7k | 90–310 | 0 | **fully readable source** |

**(verified by reading the files.)** Implication: a user *cannot* patch a sixyin-style source when a platform changes its signing, because there is nothing readable to patch. The only recourse is to wait for the author. Conversely the small readable sources are trivially patchable — which is why they die and revive constantly.

Note `qdy/latest.js`'s own header credits: `@version 9.3 93特供版 DeepSeek优化` / `@author 全豆要 and Gemini优化 Toskysun去混淆 TZB679兼容性处理` / `@contribution DeepSeek优化`. **去混淆 (de-obfuscation) is an explicit, credited community activity.** **(verified)**

**(iv) Key-gated / card-key sources that expire — verified.** See section (C3).

**(v) Platform API/signature changes.** **Could not verify** any specific 酷狗 `infSign` or 网易云 `weapi`/`eapi` change causing a named source outage — no primary source stated this. However the CHANGELOG independently proves the *class* of failure is real and recurring for the app's own built-in sources: mobile v0.14.3 `修复因音源的域名到期导致的音源失效的问题`; mobile v0.9.2 `修复因kw源歌词接口停用导致该源歌词获取失败的问题`; desktop v0.13.0 `因Q音接口失效，移除Q音源的试听与下载`; desktop v0.5.2 `因接口失效，移除网易云音源，酷狗音源仅支持播放128k音质`. **(verified)** Also note sixyin's header declares credential fields `@netease MUSIC_U=;` and `@tencent ts_last=y.qq.com/n/ryqq/album;` — i.e. it accepts user-supplied cookies, a design that exists precisely because logged-out endpoints are unreliable. **(verified)**

**(vi) IP banning by the relay operator — verified, and openly documented.** Huibq's README: `不支持数字专辑，反复请求可能会导致封禁IP！` … `仅供在线试听，禁止批量下载，批量下载会被封禁IP` … `尽量避免频繁切换歌曲，否则将导致封禁IP` … `由于邮件太多，来不及看，如果被封，数据流量情况下开启飞行模式切换IP`. Its script header repeats `禁止批量下载！` **(verified)**

---

## (C) Known sources in the wild

### C1. The catalogue (all headers verified by reading the fetched scripts)

| Name | `@name` / version | Author | Obfuscated? | Gating | Status (2026-09-16) |
|---|---|---|---|---|---|
| **六音 SixYin** | 六音音源 v1.2.1 | 六音, `www.sixyin.com` | **Yes — 332 KB, 16k `_0x`** | Free; cookie fields | Payload live; `sixyin.com` **unreachable from sandbox** |
| **Huibq / 花** | Huibq_lxmusic源 v1.2.0 | Huibq | No, 2.7 KB readable | `API_KEY='share-v3'` (shared, not paid) | Relay **503**; repo stale since 2026-01-21 |
| **野草 Grass** | 野草🌾 v1 | (none) | Yes, obfuscator.io | — | Aggregators classify as `较差-支持单平台320k或多平台128k` |
| **野花 Flower** | 野花🌷 v1 | (none) | Yes, obfuscator.io | — | Same tier as 野草 |
| **LX / 独家音源** | 独家音源 v6 | `w`, 公众号「洛雪科技」 | **Yes — PUA-symbol idents** | Server `apiKey`/`signSalt`/`fingerprint` | **Confirmed stopped** (see C4) |
| **长青 ChangQing** | 长青SVIP音源 v1.3.0 | `SVIP`, 公众号「元力菌」 | Yes, XOR decoder | **SVIP branding** | Relay live; `@update_url` → 语雀 doc |
| **幻音 HuanYin** | 幻音音源 v3 | 竹佀 | **No — readable, 310 lines** | Free | Depends on `music-dl.sayqz.com` (**down**) + `api.xcvts.cn` (up) |
| **ikun** | ikun音源 v22 | ikunshare | No, readable | `API_KEY=""`; errors `Key失效/鉴权失败` | **Paid** — see C3 |
| **聚合API JuheApi** | 聚合API接口 (CF) v3 | lerd | Minified, 994 B | Free | Relay **live** |
| **全豆要 QDY** | 全豆要[聚合音源] v9.3 | 全豆要 + many | **No — 831 readable lines** | One embedded key; one `your_key_here` placeholder | Multi-relay fallback; many relays down |
| **念心 / 星海 / 溯音 / 歌一刀 / 墨澜 / 玉宁熙 / fish-music / 惜缘 / 忆音 / KE-DES / Ciallo / 统一音乐源 / FreeListen / 春日影 / 梓澄 / 無名 / 肥猫不肥 / monster / 至尊 / 小熊猫 / 废材公社 / 野花 / 野草** | — | various | mixed | mixed | Catalogued in aggregator repos (see C2) |

**(all verified by reading scripts or repo trees.)**

### C2. The aggregator layer — where the real catalogue lives

The ecosystem has a distinct **meta-layer** of repos that collect, grade, and sometimes de-obfuscate other people's sources:

- **`guoyue2010/lxmusic-`** (5,765★, **Apache-2.0**, pushed 2026-09-12) — 317 files, organised into **quality tiers**: `优质-支持四平台FLAC` / `良好-支持至少两平台FLAC` / `一般-支持单平台FLAC或多平台320k` / `较差-支持单平台320k或多平台128k`. Contains a `测试报告.png` and `全豆要(聚合音源)/更新日志/`. **(verified)** Note the filename `洛雪科技[独家音源] v4-会停用.js` — **"会停用" (will be discontinued) is baked into the filename.** **(verified)**
- **`xzh767/lxmusic-source-all`** (440★, **MIT**) — README: `2025.3.1解密了一些音源`; ships both obfuscated and `(decrypt)` variants, e.g. `聚合API接口(decrypt).js` vs `聚合API接口2.0.js`. **(verified)**
- **`Macrohard0001/lx-ikun-music-sources`** (2,438★, license `NOASSERTION`) — joint-maintained with guoyue2010; carries the paid-source listings. **(verified)**
- **`pdone/lx-music-source`** (8,844★) — the best-known *mirror*; README explicitly credits upstreams and says `洛雪音乐源，内容源于网络`. **(verified)**
- **`skxingyu/lx_music-`** (95★, **no license**) — zip bundles only. **(verified)**
- **`LuoXiaohei-2025/LX-music-collection`** (61★, **archived**) — versions + sources archive. **(verified)**

### C3. Key-gating is real, priced, and openly advertised — VERIFIED

`Macrohard0001/lx-ikun-music-sources` README publishes a **付费音源服务** section with exact prices and card-key import URLs:

- **聆澜音源** (by 时迁酱 & guoyue2010): 永久 15元 / 年卡 4元 / 月卡 2元 / 周卡 1.5元 / **天卡 0.6元**. Import: `https://source.shiqianjiang.cn/api/script/lx?key=你的卡密`, plus `lc.guoyue2010.top` and `lx.xiagua.top` mirrors. Purchase via `shop.guoyue2010.top`, `shop.shiqianjiang.cn`.
- **IKUN 音源**: 永久 15元 / 年卡 10元 / 月卡 5元 (the same README's other section says 月卡 15元 — **internally inconsistent**). Purchase `shop.ikunshare.com`, publish page `publish.ikun0014.top`.
- Terms: `音源仅限测试，请各位在24H内删除有关缓存` / `所有付费音源禁止二次转发卡密，加价倒卖`.

**(verified)** `guoyue2010/lxmusic-`'s own README carries the same pricing. **(verified)**

Note the **`?key=` in the URL** — this is why the 在线导入 mechanism and card-key monetisation fit together so neatly, and why a "source URL" is frequently also a secret.

**Monetisation beyond cards:** the same README carries a `## 赞助广告` block with a 流量卡 affiliate link and a donation QR (`本项目为纯公益，但是如果你觉得好用，可以进行捐赠`). Meanwhile the upstream app forbids exactly this — see (E).

### C4. 「洛雪官方源」/ 独家音源 — the removal event

There is **no** official LX source distributed by lyswhut after 2023-10-18; the official position is that users must supply their own. What the community calls 洛雪官方源 / 洛雪科技音源 is a **third-party source trading on the name**, branded 公众号「洛雪科技」, published as `独家音源`.

**Verified facts:** the script's `@name` is `独家音源`, `@description` is `后续更新，请关注微信公众号: 洛雪科技`, `@author w` — i.e. **not lyswhut**. It embeds `globalThis['SERVER_SCRIPT_CONFIG'] = {"apiUrl":"https://88.lxmusic.xn--fiqs8s","apiKey":"lxmusic","signSalt":"LxSrv@2026#Sig","fingerprint":"..."}` and is obfuscated with Arabic/PUA-symbol identifiers. **(verified by reading `lx/latest.js`.)**

**Its death is documented by users, dated:** 52pojie thread 2111936 (2026-06-09) — the poster's error dialog read: `自定义源「[独家音源]」发现新版本: 由于阅读量不达标，暂时停用后续更新，请关注公众号: 洛雪科技`. **(verified quote from the fetched page.)** The aggregator filename `洛雪科技[独家音源] v4-会停用.js` corroborates. **(verified)**

**This is the clearest evidence of the "attention-economy" failure mode:** the source was withheld to drive 公众号 reads, and users were left with a dead client overnight. Note also that the official docs warn about impostors generally (mobile v1.1.0 CHANGELOG: `本项目无微信公众号之类的官方账号 … 商店内的"LX Music"、"洛雪音乐"相关的应用全部属于假冒应用`). **(verified)**

**Community liveness reports, same thread:** `Huibq 可用` (2026-06-11); a `2026.06.12实测可用音源` post linking netdisk bundles. **(verified quotes.)**

---

## (D) The 2023-10-18 removal

Corroborated from four independent primary sources, all fetched:

1. **Desktop CHANGELOG v2.6.0** (2024-02-01), under 其他: `- 移除所有内置源，由于收到腾讯投诉要求停止提供软件内置的连接到他们平台的在线播放及下载服务，所以从即日（2023年10月18日）起LX本身不再提供上述服务`. **(verified)**
2. **Mobile CHANGELOG v1.2.0** (2024-02-01), verbatim identical text, plus `- 新增自定义源（实验性功能），调用方式与PC端一致` under 新增. **(verified)**
3. **Official FAQ** [歌曲无法试听与下载](https://lxmusic.toside.cn/desktop/faq/cannot-play-and-download): `由于收到腾讯投诉，要求停止内置其平台的在线播放及下载服务，所以从 2023-10-18 起，LX Music 本身不再提供上述服务——桌面版 v2.6.0 移除了所有内置自定义源，且旧版本内置的源也已失效。你需要编写或寻找别人分享的自定义源导入，才可正常使用。` followed by `提示：可以去 GitHub Issues 找找。` **(verified)**
4. **Release notes** for desktop v2.6.0 and mobile v1.2.0, retrieved via the GitHub releases API. **(verified)**

**Timeline anomaly worth flagging:** the 腾讯投诉 is dated **2023-10-18**, but the releases carrying the removal shipped **2024-02-01** — a ~3.5 month gap. **(verified from the CHANGELOG/release dates.)**

**Issue #1912** — full body retrieved via `gh-proxy.com/https://api.github.com/...` **(verified)**. Created 2024-05-26 by `lyswhut` (author_association `OWNER`), open, **88 comments, 887 reactions** (👍550, ❤️170, 🎉76, 🚀60, 👀30). Key content:

> `由于最初 LX 的开发线路是抱着对技术的学习与研究的目的，集成国内常用音乐平台以解决音乐查找与播放问题，但随着大家对音乐版权的重视，以及来自官方音乐平台的压力，这条路已难以走下去。`
> `我决定发起一个全新的项目，用于提供一套面向个人用户的个人私有云音乐解决方案。`
> `之前用于维护 LX 的业余时间现在大部分已投入到该项目的设计与开发上，LX 也将逐渐进入维护模式，没有特殊情况下预计不会有重大的改变。`

Milestones: (1) desktop — new architecture, modern UI, independent playlists, multi-level favourites, play-behaviour stats, **`软件本身只是一个可以播放本地歌曲的播放器，没有第三方在线资源功能`**, a VS Code-style extension API, plus a web front-end; (2) sync service; (3) mobile (Android only — no iOS dev environment); (4) a song-management service.

Critically, on extensions vs built-in sources: `扩展功能将允许扩展为软件提供接入在线资源的能力，之所以不内置在线服务功能而采用这种设计：` > `希望在解耦各个服务的同时，允许对接多个 自建 的或如 WebDAV 等 其他来源 的歌曲存储服务。`

Added 2025-05-11: `新的项目已发布： https://github.com/any-listen/any-listen` … `简单来说，现在的LX去掉所有在线功能，只有我的列表及播放器功能`. Closing caveat: `亦或者会出现项目被终止的情况。` **(verified)**

**Outcome (verified):** the pivot completed. Desktop CHANGELOG v2.12.2 (2026-05-01) announces Any Listen's desktop release; v2.12.5 (2026-09-14) states `以后的开发精力将主要集中在新项目上`. The desktop README carries a matching `[!NOTE]`. Latest versions as of this research: **desktop 2.12.5, mobile 1.9.0**. **(verified)**

---

## (E) Legal / takedown context

**E1. The complaint mechanism was a 警告信, not (publicly) a DMCA.** Issue #1643 (2023-10-22) has `LX于2023年10月18日收到了腾讯的警告信` as the primary wording. Note the **official CHANGELOG and FAQ both say 腾讯投诉 (complaint)** while #1643 says **警告信 (warning letter)**. 蓝点网 (landiannews) headlined it as `开源播放器洛雪音乐助手收到律师函` — **律师函 (lawyer's letter)** — but **the article could not be fetched** (both `landiannews.com` and the 360doc mirror failed DNS/connection from this sandbox), so it is **unverified** whether that outlet independently confirms a 律师函 or is loosely paraphrasing. **(verified: the CHANGELOG/FAQ wording and the #1643 wording; unverified: 律师函.)**

**E2. No DMCA takedown of a source repo could be verified.** Consistent with the coordinating agent's finding. What *can* be verified is that takedowns are **not the binding constraint** — the binding constraints are relay death, obfuscation, and monetisation. Two adjacent data points: `LuoXiaohei-2025/LX-music-collection` and `ZxwyWebSite/lx-source` are `archived: true` (self-archived, not `disabled`), and `timeshiftsauce/CeruMusic` (1,916★) archived. GitHub API `disabled` is `false` for all repos checked — no platform-level suppression observed. **(verified)**

**E3. lyswhut's non-commercial stance — verified verbatim** from both [lxmusic.toside.cn/desktop/license](https://lxmusic.toside.cn/desktop/license) and the [desktop README](https://gh-proxy.com/https://raw.githubusercontent.com/lyswhut/lx-music-desktop/master/README.md):

- 八、非商业性质: `8.1 本项目仅用于对技术可行性的探索及研究，不接受任何商业（包括但不限于广告等）合作及捐赠。`
- 七、版权保护: `7.1 音乐平台不易，请尊重版权，支持正版。`
- 二、版权数据: `2.1 …使用者务必在 24 小时内 清除使用本项目的过程中所产生的版权数据。`
- 六、使用限制: `6.1 本项目完全免费…本项目不对项目内的技术可能存在违反当地法律法规的行为作保证。` / `6.2 禁止在违反当地法律法规的情况下使用本项目。`
- 一、数据来源 1.2 — **note the licensing page and the README have diverged**: the docs page still reads `软件设置内"音乐来源"设置所选择的"源"`, while the README reads `软件设置内"自定义源"设置所选择的"源"`. The README was updated post-removal; the docs page was not. **(verified — a small but real documentation drift.)**
- 三、音乐平台别名: `如果官方音乐平台觉得不妥，可联系本项目更改或移除。`

**E4. The community's legal self-understanding is that it is gray, and this is near-universally disclaimed.** Nearly every community artefact carries a 24-hour/正版 disclaimer, frequently copied *from LX's own licence text*:
- `MeoProject/lx-music-api-server` (843★, MIT) — its 补充协议 is a near-verbatim adaptation of LX's licence, ending `音乐平台不易，请尊重版权，支持正版。本项目仅用于对技术可行性的探索及研究，不接受任何商业（包括但不限于广告等）合作及捐赠。` It also warns `使用此项目导致的**封号**等情况**与本项目无关**` and `本项目不接受私人定制`. **(verified)**
- `guoyue2010/lxmusic-`: `1、音源仅限测试，请各位在24H内删除有关缓存 2、所有付费音源禁止二次转发卡密，加价倒卖`. **(verified)**
- `Macrohard0001/lx-ikun-music-sources`: `**尊重版权**：本项目鼓励支持正版音乐。所有资源均标注来源，如有侵权，请联系删除。` **(verified)**
- 52pojie auto-appends: `本站信息来自网络，版权争议与本站无关。您必须在下载后的24个小时之内…删除上述内容`. **(verified)**

**The tension is explicit and unresolved:** the upstream project forbids donations and commercial use, while the most-starred community aggregator runs affiliate ads and QR-code donations, and a tier of card-key resellers charges up to 15元 for permanent access. **(verified from the respective READMEs — synthesis.)**

**E5. Antivirus false positive — verified.** [Official FAQ](https://lxmusic.toside.cn/desktop/faq/antivirus-software): from **v0.17.0**, the 音频输出设备切换 feature calls `MediaDevices.enumerateDevices()`, which can make security software report camera access — `目前发现卡巴斯基、火绒会提示` — `但实际上并没有用到摄像头，并且摄像头的提示灯也不会亮。你可以选择阻止访问。` The CHANGELOG confirms v0.17.0 (2020-03-15) added 音频输出设置. The FAQ also adds a candid supply-chain caveat (`当这些依赖存在恶意行为时（供应链攻击），软件也将会受到牵连`) and closes `请自行判断选择是否继续使用本软件！` **(verified)** Related and relevant to source-sharing safety: **no equivalent assurance exists for third-party 音源 scripts**, which run with `lx.request` (no CORS restriction) and `lx.utils.crypto` — i.e. a source script is arbitrary trusted code. **(inference, grounded in the official custom-source docs.)**

---

## (F) Source script licensing

**The typical state is: no license at all, or a bespoke non-commercial notice.** Verified findings:

| Artefact | License | Evidence |
|---|---|---|
| `pdone/lx-music-source` (8,844★) | **NONE** | GitHub API `license: null`; `LICENSE` fetch → **HTTP 404** |
| `Huibq/keep-alive` (7,414★) | **NONE** | API `license: null`; tree has 15 files, **no LICENSE** |
| `skxingyu/lx_music-` (95★) | **NONE** | tree: 5 files, no LICENSE |
| `LuoXiaohei-2025/LX-music-collection` | **NONE** | API `license: null`; archived |
| `guoyue2010/lxmusic-` (5,765★) | Apache-2.0 | full Apache text, 11,357 B |
| `xzh767/lxmusic-source-all` (440★) | MIT | `Copyright (c) 2025 xzh767` |
| `Macrohard0001/lx-ikun-music-sources` (2,438★) | `NOASSERTION` | bespoke **《巨硬简易许可证》** |
| `MeoProject/lx-music-api-server` (843★) | MIT | + licence supplement |
| `7878gyc/gdstudio-lx-source` (41★) | MIT | |
| `ZxwyWebSite/lx-source` (700★) | MIT | archived |
| `laosunmaker/New_lxmusic_source` | Apache-2.0 | 3 files |
| **Individual `.js` source files** | **none observed** | no SPDX headers or licence text in any of the 10 scripts read |

**(all verified via GitHub API and/or fetched files.)**

**The 《巨硬简易许可证》 is the interesting case** — a fully bespoke licence written specifically for a source-sharing repo: `严禁在未获得作者明确授权的情况下进行任何形式的商业使用或盗搬`, explicitly prohibiting `未经授权转载、发布至可能获得收益的平台（如网赚网盘）` and `任何形式的售卖、集成至商业产品、或用于提供收费服务`, while permitting `个人学习、非商业交流时，请务必注明出处`. **(verified)**

**Apache-2.0 on source scripts is arguably incoherent** — Apache-2.0 grants patent and commercial rights, yet `guoyue2010/lxmusic-`'s own README says `所有付费音源禁止二次转发卡密，加价倒卖`. **(inference.)** A recurring pattern: the **repo** is licensed, the **payload scripts inside it are not** — `pdone` ships content with no license at all, and `guoyue2010`'s Apache-2.0 covers 317 files including other people's obfuscated scripts that carry no grant from their original authors. **(inference.)**

**Obfuscation, and what it implies.** 5 of 10 widely-mirrored sources are obfuscated (sixyin, lx, changqing, flower, grass), and obfuscation is *strongly* anti-correlated with readability rather than with popularity: sixyin is the single most-copied source (present in pdone, xzh767, skxingyu, guoyue2010) and is the most heavily obfuscated. **(verified.)** Three consequences: (a) **no auditability** — users cannot check whether a source exfiltrates credentials, and sixyin's header *does* declare `MUSIC_U` / `ts_last` cookie fields; (b) **no forking** — when a platform changes, only the original author can fix it, which is precisely the 失效 dynamic in (B); (c) **obfuscation is sometimes defeated anyway** — `Toskysun去混淆` is credited in a script header, and xzh767 ships `(decrypt)` variants, so obfuscation is a speed bump protecting a monetisation window, not a secret. **(verified for the facts; the "monetisation window" reading is inference.)**

---

## What could NOT be verified

1. **The 蓝点网 律师函 claim** — both `landiannews.com` and the 360doc mirror failed to resolve/connect. Cannot confirm whether a lawyer's letter (vs. a warning letter) was received.
2. **The exact meaning/date of "洛雪音乐1.6.0"** in the sixyin-fix README. The AIGC blog's *mechanism* was refuted, and desktop 1.6.0 (2021-01-10) demonstrably predates the feature, but **which build the author meant** could not be confirmed. No primary source states a version-to-breakage mapping.
3. **Any specific 酷狗 `infSign` / 网易云 `weapi`/`eapi` change** causing a named source outage. No primary source found; the general failure class is proven by CHANGELOG entries about 接口失效/域名到期, but the specific cryptographic claims are unverified.
4. **Whether 野草/野花 are alive right now.** No endpoint list survived de-obfuscation within budget, and no dated liveness report was found. Both are graded `较差` by the main aggregator — indirect evidence of weakness, not proof of death.
5. **Whether `sixyin.com` is globally dead** — it failed to resolve from this sandbox, but that may be sandbox policy; pdone's mirrored payload is alive.
6. **Any DMCA notice on any source repo** — corroborates the negative finding in the main report.
7. **`liuyunss/LX-source`, `ZxwyWebSite/lx-source` tree contents** — API returned 404 for the branches guessed (the repos themselves exist per search results).

**Artifacts:** `_research/fetch.mjs`, `_research/gh.mjs`, `_research/gh2.mjs`, `_research/gh3.mjs`, `_research/gh4.mjs`, `_research/alive.mjs`, `_research/probe.mjs`, and the 10 downloaded source scripts `_research/{sixyin,huibq,flower,grass,ikun,changqing,huanyin,qdy,lx,juhe}.js`.
