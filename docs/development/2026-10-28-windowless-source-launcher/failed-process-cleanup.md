# 失败探针自有进程清理回归

后续补充：Task 8 时 GraphFlow 已恢复并完成增量索引；下文保留当轮连接失败记录。

日期：2026-10-28。补齐已有源迁移记录中未自动验证的 detached host 清理行为。

从 `or8-delivery-package.mjs` 原样抽取 `stopOwnedExecutables` 到 `tools/probe/owned-process-cleanup.mjs`，原探针改为导入；产品运行时代码不变。

新增 `portable-cleanup.test.mts`，先观察缺失模块导致失败，再完成抽取。测试仅复制当前 Node 可执行文件为三个自有临时 `JJ Music.exe`，并以 detached 模式运行：

- 拒绝临时目录本身及前缀不符的临时根。
- 清理 `old-app` 和 `next-app` 精确路径下的两个进程。
- 保留 `unrelated-app` 下的同名进程，并验证它仍存活。
- 再次清理返回零；测试最终使用其持有的 ChildProcess 回收剩余自有进程，验证路径后删除临时目录。

通过 `tools/build-test.mjs` 后，`node --test out/test/portable-cleanup.test.mjs out/test/portable-upgrade-guard.test.mjs` 为 4/4，通过真实进程清理及升级失败前置校验。日志 `.cache/portable-cleanup-build.log`、`.cache/portable-cleanup-tests.log`。

独立复核指出测试自身在 spawn 失败且无 PID 时可能等待不存在的 exit 事件，已增加 PID 前置条件及清理等待的 5 秒可取消期限。清理模块的路径约束和原探针集成未发现重要问题。

修正后执行完整 `node tools/run-tests.mjs`，**128/128 suites passed**，退出码 0；日志 `.cache/portable-cleanup-offline.log`。JavaScript 语法及 `git diff --check` 通过。GraphFlow 增量索引连续两次返回 `Transport closed`，本轮索引未完成，未重启或修改 MCP 全局配置。

这证明当前 Windows 会话中的自有 Node 副本进程清理，不证明受限令牌/跨用户进程、权限拒绝或新进程持续生成时的清理。未运行安装器、第三方脚本或真实用户资料，未更改系统设置，未提交推送。
