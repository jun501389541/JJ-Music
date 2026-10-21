# 资源写入串行保护 Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 同一文件目标的资源写入按调用顺序完成，noClobber不发生并发覆盖，标签补丁不因共用临时文件丢失；不同目标仍可并行。

**Architecture:** 新增进程内PathTaskQueue，一次预留全部目标路径并等待先前任务，失败释放且flush等待尚未开始的任务。exportAssets的覆盖检查、标签读改写和侧车发布在同一次排队操作内。主进程同曲提交用独立外层队列保护写入与索引更新，执行时读取最新曲目状态；快照在排队前捕获，保留后来的用户选择。两个队列分层，不递归获取同一把锁。

**Spec:** docs/superpowers/specs/2026-10-15-online-reliability-design.md OR-10、RR08/RR16。

- [x] 用生产exportAssets复现同文件/同stem侧车noClobber双写和同FLAC补丁冲突。
- [x] 实现PathTaskQueue，测试共享目标排序、独立目标并发、失败释放、路径规范化、排空。
- [x] 接入exportAssets全部文件目标，主进程提交与退出/迁移排空；生产测试打包新增模块。
- [x] 运行局部回归、独立复核、完整verify并记录证据。局部7/7、全量89/89套件、5/5门禁通过，独立复核指出的生产者排空问题已修复并复核。

边界：单进程规范化路径锁，不声称跨进程、符号链接/硬链接别名和外部编辑器互斥；不修改日常歌曲，不执行真实源，不提交发布。

Ruling: 添加TaskGroup跟踪批处理与匹配应用的完整异步准备阶段 — 代码复核指出仅等待当前文件队列会在下一首准备间隙提前排空。歌词导入在用户确认后登记，避免把未完成的文件选择对话框变为退出等待条件。新增第7项闸门回归，修补后独立复核无阻断。
