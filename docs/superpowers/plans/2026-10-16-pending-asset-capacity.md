# 待写入资源容量保护 Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 达到容量或写盘失败时，保留既有待写入选择，禁止以淘汰旧条目的方式接受新内容。

**Architecture:** 保持 PendingAssetStore 和现有容量数值，先检查替换后的条目数及总歌词字符数，超额抛出可读中文错误。所有变更在串行队列中基于已提交状态生成副本，原子写盘成功后才发布内存状态；失败不污染后续操作。

**Tech Stack:** TypeScript、现有 writeJsonAtomic、生产打包模块与 Node 测试。

**Spec:** docs/superpowers/specs/2026-10-15-online-reliability-design.md，OR-10、6.4、6.7、RR08/RR16。

## Constraints

- 保留容量：500 条、总歌词 2,000,000 字符、每条 200,000 字符。
- 不访问日常资料，不执行真实音源，不提交推送或发布。
- 容量错误使用现有 IPC 异常反馈，不把未保存的结果标为待写入。
- 不修改播放或歌词优先级；不改变已有同曲同类型替换语义。

## Steps

- [x] 新增 src/test/pending-asset-capacity.test.mts：条目数、字符数、替换、写盘失败、并发入队和加载。
- [x] 通过 tools/build-test.mjs 打包生产 PendingAssetStore，运行新套件确认失败原因。
- [x] 修改 src/main/library/pending-assets.ts：取消淘汰，入队前校验，合并首次加载，串行写盘后发布状态。
- [x] 检查现有主进程调用在 add 成功后才设置 pending；新套件8/8通过，asset-export、local-lyric-cache纳入完整门禁。
- [x] 运行 npm run verify，记录真实证据及未验收边界，增量索引 GraphFlow。最终86/86套件、5/5门禁通过，容量/持久化/排空回归9/9。

## Review focus

已有超限历史文件不得在下次入队时被截断；同键替换须扣除旧文本容量；写盘失败不得污染后续快照；首次并发加载必须等待同一次读取；普通队列操作之间不得因写盘顺序丢失已完成变更。损坏文件恢复策略、跨多个实例写同一目录、批量写标签期间的新选择一致性另列边界，不能据本轮回归宣称全部解决。

## Execution ruling

Ruling: 增加 PendingAssetStore.flush 并接入 src/main/index.ts 的退出和迁移门禁 — 独立复核已复现仅flushJsonWrites会漏掉尚未到写盘器的排队变更；这是新串行队列必须补齐的生命周期衔接。新增第9项排空回归，先确认缺少flush失败，再实现并运行最终门禁。若遗漏，正常退出或迁移仍可能丢失排队选择。
