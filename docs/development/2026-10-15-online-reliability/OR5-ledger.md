# OR5 变更边界账本

2026-10-16，当前已授权工作区顺序实施。基线 `.cache/online-reliability-or5/before.patch` 和 `untracked-before.json`；保护结果 `preservation.json`，无意外变动。

| 范围 | 文件 | 内容 |
| --- | --- | --- |
| 新健康状态 | `src/main/online/capability-health.ts` | 内存有界、分能力/版本键、失败窗口、冷却/半开、手动限频、即时429与尝试前许可。 |
| 目录/资产接入 | `catalog-reliability.ts`、`library-router.ts`、`playlist-import.ts`、`hot-words.ts`、`online-asset-cache.ts` | loader 内健康计数、重试观察/检查；脚本资产避免双计数；热词 writer flush。 |
| 源接入 | `source-engine.ts`、`source-runtime-host.ts`、`playback-router.ts` | 稳定版本健康键、超时分类、空档位保护、429一次重试、手动标志、teardown隔离。 |
| 播放与媒体 | 新 `src/shared/playback-reliability.ts`；`player.ts`、`online-resolver.ts`、`web-audio-engine.ts`、`source-media-proxy.ts` | URL 双时钟期限、可选可信到期、类型化媒体证据、一次恢复与原预算。 |
| IPC/设置 | `main/index.ts`、`ipc-validation.ts`、`preload/index.ts`、`shared/ipc.ts`、`online-reliability.ts`、`online-diagnostics.ts`、`settings-pages.ts` | 实际接线、安全媒体状态、手动意图、cooling契约与白名单、关闭保护与写入收尾。 |
| 验证 | 新健康/接入/期限3套件；扩展 `player-regression`、`source-media-proxy`、`catalog-reliability`、`hot-words`；测试构建与原合成 Electron 探针 | RED/GREEN、复核、全量离线与合成 UI。 |

Ruling: OR0–OR4 和已有播放器/曲库/下载并发修复未提交，继续原地按差异/哈希保护实施，不另建缺少依赖的干净工作树，不提交推送。

Ruling: 保留已存在的一次播放意图恢复与源429唯一重试责任；不额外包全链请求策略。普通网络恢复不被记录为已确认 URL 过期。源只给 URL 字符串时不猜源站到期字段。

Ruling: 目录逻辑请求的最终可计数服务失败计入窗口；内部429即时发布等待，并在每次尝试前校验。源层按实际候选请求计数，脚本资产外层不再重复计数。

Ruling: 旧热词测试的磁盘轮询两次触发Windows EPERM，新增实例flush后保持相同磁盘内容断言，并在退出等待写入；不以绕过失败或增大超时宣布完成。

复核3项P2已关闭，具体复现/修正/结果见 [OR5.md](OR5.md)。所有真实平台、实际脚本、媒体加载和听感等级分别保留未验证状态；OR6–OR8不计为完成。
