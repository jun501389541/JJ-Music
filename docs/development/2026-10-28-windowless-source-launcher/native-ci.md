# 原生合成回归接入 CI

日期：2026-10-28。继续既有 WL3 的 CI 接入，不改变产品行为、令牌权限或发行资产。

`.github/workflows/ci.yml` 的 Windows verify job 在已有 `npm run verify` 后增加五个独立步骤：

1. `./tools/test-source-launcher-argv.ps1` 构建参数/控制台/Job等测试夹具。
2. `./tools/build-source-launcher.ps1 -TestBarrier` 构建独立创建竞争测试 helper。
3. `node tools/probe/windowless-source-launch.mjs --startup-race` 检查原生启动、回收及暂停创建竞争。
4. `node tools/probe/windowless-nested-job.mjs` 检查兼容外层Job、正常停止/owner退出和进程上限拒绝。
5. `node tools/probe/windowless-paths.mjs` 检查短路径原值传递、长路径明确拒绝及畸形PE安全错误。

生产 helper 由前置 verify 构建；原生探针使用当前 Node、合成宿主及生成文件，不需要 verify job 下载 Electron。每条命令单独成 step，不设置 continue-on-error，后续成功不会掩盖前项失败。原 packaged-sources job 继续依赖 verify；workflow token保持 contents:read，未增加secret、权限或远端触发方式。

## 本地验证

使用已安装 `yaml` 解析workflow，检查唯一键、只读权限、五个命令及 packaged-sources 的依赖，解析通过。在本机按相同顺序运行两个构建和三个探针：

- MSVC夹具和TestBarrier构建通过。
- 原生启动/控制台/Unicode/权限/回收/创建竞争六组通过。
- 嵌套Job三个场景通过，关闭前活跃进程归零。
- 路径探针通过其“支持或明确拒绝”契约；长路径仍记录为不支持，不因exit0解释为长路径支持。

日志 `.cache/native-ci-fixture-build.log`、`native-ci-race-build.log`、`native-ci-startup.log`、`native-ci-nested.log`、`native-ci-paths.log`。本次嵌套报告 `.cache/windowless-nested/e98fc545-12f0-46c1-ae9d-111dbca9f437/result.json`，路径报告 `.cache/windowless-paths/6c6a4b7b-7429-4121-82d6-f30d06aec177/result.json`。

这只是workflow语法和本机等效命令验证，未推送、未触发GitHub Actions，不能报告远端CI已通过。配置变更没有修改产品代码，不重跑无关的完整verify或重建ZIP，最近产品验证及最新候选身份保持原记录。

独立只读复核未发现Important/Critical问题，确认前置构建、Node/Electron依赖边界、失败传播及只读权限保持；`git diff --check`通过。

GraphFlow增量索引两次均返回Transport closed，本轮索引待连接恢复；未更改全局MCP配置。

未接入依赖交互桌面的完整窗口观察、默认终端矩阵或真实音源验收。未执行安装器，也未改变原NSIS CI-only guard和已停止的Sandbox计划。
