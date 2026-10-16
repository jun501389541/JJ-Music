# 在线资源可靠性 OR3 实施计划

> For agentic workers: use superpowers:executing-plans. 当前会话顺序实施并独立复核；不提交推送。

**Goal:** 在本地和用户资源优先的前提下，为在线歌词/封面增加有界、版本隔离的可再生缓存。
**Architecture:** 新 OnlineAssetCache 复用 ResourceCache 处理歌词及封面索引；CoverByteStore 只管理 library/covers/online-cache-v1 的内容寻址字节。用户保存通过现有 saveCover 复制到原目录，回收不触碰这些副本。目录版本与脚本候选集版本分开建键。
**Tech Stack:** TypeScript / Node / 原子 JSON / 现有有界网络服务。
**Spec:** ../specs/2026-10-15-online-reliability-design.md（OR3，RR08/RR10/RR16/RR17/RR20）。

## Global Constraints

- 30天新鲜、180天最长展示；歌词16 MiB、封面192 MiB，单封面8 MiB；缓存不存音频。
- 一次请求10秒预算、单次5秒；音源重试由现有引擎负责，上层不重复重试。
- 本地侧车/内嵌优先，手工与待写入资源不回收、不自动改标签/侧车。
- 同键合并与独立取消、源/文件/清理代次失效；旧结果不能写回。
- 保留OR0–OR2及既有修复。仅离线合成、临时目录与纯合成Electron探针。

## Review Focus

- 用户保存的同内容字节与自动封面分离，达到容量/清理只删除独占缓存文件。
- 音源更新或本地标签变化时，进行中的旧结果不重新入缓存或遮蔽本地资料。
- 伪图片、HTML歌词、空/过大内容、损坏缓存不能落成有效资源。
- 部分消费者取消、全体取消与清理交错，底层中止和写回保护均有效。
- 显式离线/诊断开关不意外联网，过期展示和远程错误可区分。

## Task 1 — 自动资源缓存

Files: 新 src/main/online/online-asset-cache.ts、cover-byte-store.ts、image-content.ts；扩展 resource-cache.ts；新 src/test/online-asset-cache.test.mts、cover-byte-store.test.mts；tools/build-test.mjs。

Interfaces: OnlineAssetCache.lyric(identity,loader,options): Promise<ResourceEnvelope<LyricResult>>；cover 同形返回 CoverBytes；load/clear/flush；CoverByteStore.read/put/clear/flush。

- [x] 写时间、版本、结构/魔数、容量、取消、清理、损坏/写失败与用户文件隔离回归，编译运行确认RED。
- [x] 实现歌词规范化和独立二进制存储；封面索引只存hash/mime/size，绝不把图片塞进JSON。
- [x] 运行相同回归确认GREEN。

## Task 2 — 接入业务

Files: src/main/index.ts；lyric-service.ts；entity-details.ts；shared类型；既有 local-lyric-cache 与资源测试。

Interfaces: 生产在线歌词在每个来源入口读取缓存；本地 resolver 的在线结果带到期信息，但本地/待写入用户选择不自动过期；封面消费者得到bytes或dataURL，不能持久引用自动缓存文件路径。

- [x] 添加本地文件变动/在线缓存过期/在线禁用回归，确认RED。
- [x] 接入平台和脚本歌词、详情/标签匹配/在线封面；源版本集变化拒绝旧在途写入；保留本地优先。
- [x] 接入现有资料缓存清理/开关及退出flush，不额外建立UI流程。
- [x] 局部测试通过，完整verify通过。

## Task 3 — 复核和交接

- [x] 使用requesting-code-review安排只读独立复核，修正Important及以上并回归。
- [x] 运行纯合成Electron UI探针；不运行旧真实profile E2E/diagnose。
- [x] 记录 OR3.md、ledger、RR边界，增量GraphFlow索引。

后续仍按OR4→OR5→OR6→OR7→OR8执行；真实脚本、联网及听感验证另行显式触发。
