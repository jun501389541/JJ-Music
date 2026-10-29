# WT09 原生合成宿主更新与回退

日期：2026-10-28。用户明确暂不运行真实音源；本轮仅增加生产模块的实际原生集成回归，没有修改产品行为、下载更新文件或运行第三方脚本。

在 `windowless-runtime.test.mts` 增加两项 Windows 回归。通过真实 `SourceStore`、`SourceEngine`、`SourceRuntimeHost`、native helper、`applySourceUpdate` 和 `rollbackSourceUpdate` 执行，未替换生命周期实现。每项使用自有临时目录，固定 file 传输，实际音源宿主从生产源码 bundle 构建。

## 成功更新和回退

先启用自有 v1，检查 musicUrl 返回 v1 地址；更新到 v2，检查：

- v1 helper 正常退出码 0、旧 scratch 已移除。
- 持久化版本为 v2，stableId 不变、enabled 仍为 true，历史内容保存为 v1。
- providerVersion 与运行 generation 改变，真实文件协议请求得到 v2 地址。

再回退到 v1，确认 v2 helper 正常回收、scratch 移除，产生新运行代次，请求返回 v1 地址；重新加载存储后仍为 v1、相同 stableId、enabled=true。

## 坏候选恢复

候选 v2 在独立原生宿主内写出自身 PID/scratch 到本测试目录，然后抛出合成错误。更新接口必须拒绝并报告已恢复旧版本，检查旧运行时与失败候选均回收、失败候选 scratch 删除。原有 v1 内容及 stableId/启用状态保留，lastError 未被候选故障污染，无错误历史版本提交；恢复后的实际请求返回 v1 地址，重读存储状态一致。

返回地址均为 `https://native-fixture.invalid/...` 固定字符串，只验证宿主请求往返与版本路由，未实际取流，不是音频或网络下载验收。临时目录在 stopAll 完成后，核对其直接父目录及自有前缀再删除。非 Windows 显式跳过，不将跳过视为原生通过。

## 执行记录

`node tools/build-test.mjs` 后运行 Node test runner 的定向原生生命周期文件，首轮包含新增两项共 **17/17 通过**；日志 `.cache/native-update-build.log`、`.cache/native-update-focused.log`。随后补失败候选自身 PID/scratch 回收断言，纳入项目正式 `tools/run-tests.mjs`。

最终正式 runner **128/128 suites passed**，退出码 0；上述两项真实原生检查均通过（包括失败候选自身回收），日志 `.cache/native-update-offline.log`。`git diff --check` 通过。GraphFlow 增量索引连续两次返回 `Transport closed`，本轮索引待连接恢复后补做，未修改全局配置。

本轮测试补充不改变最新本地 ZIP 的产品代码；此前 ZIP 身份和两条各60项迁移证据保持有效。完整类型/构建/门禁的最近通过记录仍为最终复核中的 verify；无需把 test-only 改动解释为新的发行构建。

后续补充：Task16时GraphFlow恢复，本轮待补索引已完成；之后的产品修复及最新成品身份以回收确认记录为准。
