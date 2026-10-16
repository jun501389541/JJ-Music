# OR3 实施账本

- 范围：用户继续执行，按顺序实施 OR3；沿用已确认 wy/tx，资源接口兼容其他既有平台，不移除其功能。
- 基线：OR3 前完整 tracked diff 和 untracked SHA-256 已保存；未复写既有无关修改。
- 实施：新 OnlineAssetCache / CoverByteStore / rasterMime；歌词和封面索引复用 ResourceCache；独立图片字节目录，用户资源不共享可回收路径。
- 本地优先：自动缓存到期、侧车/标签变化后的迟到网络结果、用户待写入选择保留。
- Final review：requesting-code-review 独立只读 agent；3 Important，0 Critical；无 minor。
- Final fixed：持久化实际字节配额和重启命中 — near-quota 回归 RED→GREEN。
- Final fixed：显式重搜/来源选择穿透缓存 — 真实 Electron IPC + 本机合成 Response 探针 RED→GREEN，无外连。
- Final fixed：拒绝链接目录后永久降内存 — junction/symlink put/read/clear 回归 RED→GREEN。
- 额外入口核对：在线播放平台封面也接入自动字节缓存，保留手工/待写入优先；纯合成探针 RED→GREEN。
- 验证失败归因：既有 downloads-import 的测试替身 Promise 拒绝早于迭代，提前标记 handled；未改产品下载实现，未弱化断言。
- 验证隔离：只运行默认离线 runner 与新纯合成 Electron 探针；没有运行旧真实 profile E2E/diagnose。
- 最终验收：verify-complete.log 退出 0，68/68 套件、5/5 门禁，类型和生产构建通过；纯合成 fixture-ui-complete.log 退出 0。
- 差异保护：20 份无关 tracked diff 与17个无关 untracked文件原样保留；未提交推送。
- 后续：OR4 歌单快照差异确认 → OR5 健康/地址恢复 → OR6 更新版本衔接 → OR7 安全诊断与显式真实探针 → OR8 人工验收。
