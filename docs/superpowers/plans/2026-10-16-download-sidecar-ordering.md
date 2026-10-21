# 下载歌词与手动入库时序修复

基线提交：`f5c77d2`；保留先前尚未提交的媒体生命周期和原生取消桥接。采用 systematic-debugging、TDD 和 executing-plans 顺序执行，末尾一次独立只读复核。

目标：处理上轮完整检查暴露的 LRC 读取时序，并验证发布音频、写歌词、手动入库、删除与退出的交互。不改变 completed 表示音频已发布的既有语义。

## 契约与决策

- DownloadManager 先发布音频并标记 completed，再写 LRC，最后自动入库。这是已有注释明确的提交点，不能通过延后 completed 来修测试。
- 原 downloads-import 首个用例在 completed 后固定等待 30ms 就读取 LRC，不满足该契约；应等待已存在的 lyricRecorded 状态条件。
- 手动 retryImport 也能在 completed 后立刻进入扫描，需要等待该任务收尾，再复用自动入库结果。等待后重新检查退出、移除及记录身份，避免失效操作启动新扫描。
- 删除与退出已有等待屏障，新增受控用例验证，未重写它们。
- 只在独立临时目录和内存 HTTP 响应中测试。LRC 的真实原子 rename 用门闩阻塞，所有 finally 都先释放门闩，再等待退出、恢复 mock 和删除已验证位于临时目录中的夹具。

## 执行

- [x] 根因核对：确认 completed/LRC 顺序、删除与退出屏障、手动入库入口。
- [x] 受控 RED：不含修复时 5 项中 3 失败，分别为提前 importing、移除期间提前读取 LRC、退出期间提前读取 LRC；删除和退出屏障本身通过。
- [x] 最小修复 retryImport 等待及等待后重检；原验收用例等待 lyricRecorded；生产源码打包后下载三套回归 43/43。
- [x] 一次只读复核、完整离线检查、差异保护、交接与索引。

结果：下载三套43/43，完整verify退出0，84/84套件及5项准入检查通过；独立复核无阻断问题。GraphFlow增量索引已更新，HEAD与暂存区未变。未重新运行原生媒体探针：本轮没有改媒体协议或渲染入口，完整离线检查已包含此前媒体回归。

后续 OR8 两平台短时解码记录：`../../development/2026-10-15-online-reliability/OR8-short-decode.md`。

Ruling：没有新增 renderer 状态、公开等待 API 或下载状态枚举；直接复用 per-task settled 与 importCompleted 的去重。等待只发生在已发布音频的手动入库路径，保持失败后只重试入库、不重下音频的行为。无自动提交推送。
