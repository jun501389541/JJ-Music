# OR5 能力健康与播放恢复实施计划

> For agentic workers: 使用 superpowers:executing-plans 在当前已授权工作区顺序实施，最后一次独立只读复核。保留 OR0–OR4 与其他未提交工作，不提交推送。

**Goal:** 故障只冷却对应能力，限制重复请求和恢复探测，播放地址遵守期限与一次意图预算。
**Architecture:** 新 CapabilityHealth 在实际上游请求外层计数，缓存命中不经过计数。现有音质/候选解析流程保持不变，URL 缓存使用受控期限，媒体错误区分取消/网络/解码/未知，并按证据决定一次恢复。
**Tech Stack:** Electron、TypeScript、Vue/Pinia、既有请求预算/IPC取消与生产打包测试。
**Spec:** ../specs/2026-10-15-online-reliability-design.md，OR5、OR-01/03/04/05/06/09/12，RR04/05/09/10/11/19/20。

## Global Constraints

- 健康键包含平台、能力、目录修订；脚本另含稳定 ID 与内容版本。仅内存有界，不后台探测。
- 5 分钟窗口内连续 3 次服务失败冷却 60 秒；半开失败 120 秒，然后最多 300 秒；真实成功重置。取消/本地/未知/资源/档位错误不增加计数。
- 半开仅一次有效请求取得令牌；手动越过普通冷却每键至少间隔 30 秒，不能越过 429 等待、停用及在途探测。
- 播放保留 60 秒共享预算和源请求 20 秒上限，不新增整链重试；源已有 429 重试由源层负责。
- URL 至多缓存 5 分钟；可信明确到期时间提前 30 秒。不解析未知 URL 参数推测过期；过期值不能容错复用，降档值不能跳过下次目标档。
- 原歌曲、录音版本、源绑定、本地/在线和成功播放后收集边界保持。失败不自动跳过条目。
- 关闭可靠性策略后仍保留基础播放。只做离线、合成验证；真实脚本/网络/听感单独验收。

## Review Focus

- 同能力并发旧成功不能解锁新冷却，取消半开不能永久卡锁或证明恢复。
- 脚本旧版本在停用/更新后返回不能证明新版本健康或写入新 URL 缓存。
- 429 等待不能被页面 force/重复播放绕过；相同逻辑请求不能重试相乘。
- 未知 403/404/解码失败不能冒充 URL 过期或平台故障。
- 自动恢复使用原条目和原截止时间，不能误播重排后的其他行或无限降档。

## Task 1 — 能力健康

Files: 新 main/online/capability-health.ts、test/online-capability-health.test.mts；catalog-reliability.ts、hot-words.ts、online-asset-cache.ts、library-router.ts、source-engine.ts、source-runtime-host.ts、main/index.ts；测试构建入口。

- [x] 先写受控时钟/并发 RED：失败窗口、分域、半开唯一、取消释放、手动限频、429等待、真实成功、清理代次/有界。
- [x] 实现 acquire/run 与安全 cooling 状态；在缓存 loader 与源实际请求边界接入，避免脚本资产双计数。
- [x] 生产打包局部 GREEN，源绑定/音质优先/源版本与关闭策略回归。

## Task 2 — 地址与恢复

Files: shared 新播放错误/URL期限工具；renderer/utils/online-resolver.ts、stores/player.ts、audio/web-audio-engine.ts；preload/index.ts、main/index.ts；player-regression.test.mts及媒体/解析回归。

- [x] RED 证明缓存到期、回拨、可信到期与未知参数；媒体取消/解码/403不做过期重试，已过期地址一次恢复，原预算/原条目与严格目标档不变。
- [x] 接入可序列化解析时间/到期字段及类型化媒体失败；保留基础网络恢复，但不以其声称已证实地址过期。
- [x] 局部 GREEN，覆盖旧队列重排并发与源失效测试。

## Task 3 — 集成与交接

- [x] 最后一次独立只读复核，修正 Important 及以上并回归。
- [x] 完整 npm run verify 与独立合成 Electron UI（无真实源/外网）；差异保护核对。
- [x] 写 OR5.md 与账本，更新复选框，GraphFlow 增量索引。

Ruling: 当前前四阶段与并发修复均在本工作区未提交，继续原地实施并保存差异/哈希基线；另建干净 worktree 会缺少依赖工作，不能替代当前集成验证。
Ruling: LX 标准只返回 URL 字符串，没有可信源站到期字段；不从签名参数猜时间，普通结果使用解析时间+5分钟上限。可选明确 expiresAt 契约仅由受控宿主产生；未来适配器有证据再填源站到期。
