# 日期统计与趋势 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL superpowers:executing-plans，沿用inline；最后独立审查。

**Goal:** 本机自然日时长/计次、日期排行和趋势，不伪造旧累计的日期历史。
**Architecture:** 保留PlaybackMeter；DailyPlaybackMeter分配其整数增量；同文件V2 baseline+daily+records原子提交；同token逐桶高水位，重放返回权威完整行；响应式日期视图与单SVG。
**Tech Stack:** TypeScript/Vue/Pinia/Electron，生产bundle测试、CDP DOM与原生生成媒体。
**Spec:** [批准设计](../specs/2026-10-27-statistics-daily-design.md)

## Global Constraints
- 本机观察日期固定，正常午夜拆分，时钟跳变/偏移变化归结束日；每次访问至多1次，原计量口径不变。
- 报告全日期sum=累计，批次16/访问64日；冻结不重建访问，5秒/立即/退避规则保持。
- V1<=16MiB读不写，baseline保留旧累计；V2<=32MiB、身份50000、日期3650、day-key250000，原子一致。
- provisional coverage首次成功V2才持久；重放返权威行，不回空变化集。
- 今天7/30/custom<=366首尾包含；未知非0；超过60天按自然月范围内汇总；搜索不改总览/趋势。
- 原有137DOM/32native保留；不提交推送或替代人工/真实源验收。

## Review Focus
1. 午夜门槛、舍入总和和DST/时区/回拨，不能放大墙钟时长。
2. 完成应答丢失、closed早期重放，补丁必须补齐且不能改计次日。
3. V1首次写失败跨重启，覆盖起点不能假固定；V2总和/容量严格。
4. 旧revision/数据错坏、冻结访问仍保持播放，不泄漏队列访问。
5. URL非法范围与未来日期、分月部分未知、计次0ms行和不同身份去重。

### Task1 分日计量和日期投影
Files: 新shared/statistics-daily.ts、shared/statistics-period.ts、test/statistics-daily.test.mts；改shared/playback-statistics.ts和build-test。
Interfaces: VisitDay {day,totalMs,playCount,lastPlayedAt}; DailyValues；DailyMeta；DailyPlaybackMeter.sample/value/finish。日期有效性、localDay、rangeDays、聚合选择。
- [x] 午夜/计次/整数与跳变、日期闰年/未知/分月RED。
- [x] 用原meter整数差实现分配与冻结，报告完整校验，范围纯函数。
- [x] 定向生产bundle GREEN。

### Task2 V2原子存储
Files: main/store/playback-statistics-store.ts、新test/statistics-daily-store.test.mts，原store测试同步协议。
- [x] V1读不写/失败重试、V2不变量/坏文件、逐桶回退/计次搬日、lost-ack重放RED。
- [x] 串行候选写后提交水位；get full、submit权威相关行patch；coveragePersisted。
- [x] 定向GREEN和类型验证。

### Task3 采样/客户端/日期视图
Files: web-audio-engine、renderer统计store、StatisticsView、新StatisticsTrend组件；原client测试与native模拟后端。
- [x] 同次Date.now+offset采样；daily报告/合并/冻结提示，旧报告拒绝。
- [x] URL范围/指标、缓存范围投影、预设日期自动更新，SVG<=60柱/分月和等价表。
- [x] 生产DOM日期/图表/迁移坏文件和原137、native32协议实际总和。

### Task4 收尾
- [x] 完整verify/types/build、独立最终审查对本批baseline，复现问题修复。
- [x] docs/README/PRODUCT_RULES/spec/roadmap/ledger、清理ownedtemp、GraphFlow索引；不提交推送。
