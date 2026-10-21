# 待写入快照清理 Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 单次和批量资源写入、丢弃按原快照清理，不误删后来暂存的选择。

**Architecture:** PendingAssetStore.removeEntries仅删除当前对象仍等于该服务实例返回的快照对象的条目。add复制输入，保证每次暂存都是新的版本，即使文本和时间相同。共享写入生命周期在IO前捕获待写入快照；批量流程传入开始时已经选择的条目，不能在写入旧内容时重新捕获新选择。

**Tech Stack:** TypeScript、现有生产打包/Node测试、生成临时队列与受控Promise闸门。

**Spec:** docs/superpowers/specs/2026-10-15-online-reliability-design.md，OR-10、RR08/RR16。

- [x] 新增 src/test/pending-asset-snapshot.test.mts，确认旧清理误删新选择及同内容重选回归失败。
- [x] 修改 pending-assets.ts 条目删除为同实例快照比较；每次add复制记录及image。
- [x] 新增 library/pending-asset-write.ts，将IO前快照捕获和成功清理统一；加入tools/build-test.mjs生产入口。
- [x] main/index.ts commitAssetWrite包装生命周期，并由assetsWritePending和writeTrackAssets传递原快照；丢弃和收尾继续通过快照比较删除。
- [x] 验证后来的歌词、封面、同内容重选和重启保留，失败/试运行保留原选择；确认现有容量回归仍有效。14项新回归和9项容量回归23/23通过。
- [x] 独立复核，运行完整verify，更新OR8证据与GraphFlow索引。最终87/87套件、5/5门禁通过。

边界：快照只在一个PendingAssetStore实例内使用，跨IPC传入的对象不能当作服务端清理授权；renderer仍只传trackIds，由main取快照。多个并发写同一个歌曲文件的先后顺序、任意损坏文件恢复不由本轮解决。不提交推送，不执行真实音源，不操作日常歌曲。

Ruling: 丢弃需要同一事务内核对快照、删除、记录指纹，并返回实际删除项供清缓存 — 独立复核确认仅CAS删除后继续无条件记录指纹，会把同文本新选择标成已拒绝。补充discardEntries和三个原子丢弃回归，保持底层显式dismissEntries接口供既有独立调用使用。
