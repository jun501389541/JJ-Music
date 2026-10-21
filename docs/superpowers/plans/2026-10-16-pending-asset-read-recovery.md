# 待写入资料读取保护 Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 文件损坏或暂时不可读时，原字节保留、后续写入被拒绝；修复后可原实例重试，附属队列失败不阻止应用启动。

**Architecture:** PendingAssetStore只把ENOENT当首次空资料。读取/语法/根结构错误抛出可理解消息，首次加载Promise失败后允许重新读取，完整验证后一次发布状态。启动通过受控loadForStartup隔离队列错误；后续队列读写仍报告错误，不允许覆盖原文件。

**Spec:** docs/superpowers/specs/2026-10-15-online-reliability-design.md OR-10/RR08/RR16。

- [x] 添加pending-asset-read-recovery.test.mts：损坏字节、根结构、读取错误、并发失败和恢复、缺失文件、BOM/旧数组兼容。
- [x] 打包生产模块，确认缺陷回归先失败。
- [x] 修改pending-assets.ts及main/index.ts启动衔接，不自动移动或删除资料。
- [x] 运行局部回归、独立代码复核和完整verify，记录边界与GraphFlow索引。局部33/33、全量88/88套件及5/5门禁通过，独立复核无阻断问题。

保留现有逐条过滤无效记录的兼容策略，不宣称可恢复任意损坏内容或处理多实例写同一目录；不提交推送，不操作日常文件或真实源。
