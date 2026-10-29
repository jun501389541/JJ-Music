# 便携跨版本升级补充验收

日期：2026-10-28。本轮继续现有无窗口启动器计划，复用 `or8-delivery-package.mjs`；未提交、推送、发布、安装或重新开启原 Sandbox 回环计划。

## 输入身份

本轮通过 GitHub 连接重新读取 [0.4.2 Release API](https://api.github.com/repos/jun501389541/JJ-Music/releases/tags/v0.4.2) 和 [0.5.0 Release API](https://api.github.com/repos/jun501389541/JJ-Music/releases/tags/v0.5.0)，与本地 ZIP 的实际长度和 SHA-256 重新比对，均一致：

| 基线 | 长度 | SHA-256 |
| --- | --- | --- |
| 0.4.2 | 145847983 | `0009b29e1bbedce4870244bc943b00dba512eab78f260f6dd8d70d1aae89a24a` |
| 0.5.0 | 145929280 | `0fcae9d46349b2d7d8399a83f85085eabc345d30f686f90fa62273a6f1374556` |

候选为本地未发布的 0.6.0 无窗口构建 `.cache/wl3-release/JJ-Music-0.6.0-Portable-x64.zip`，摘要 `8cfa68f48664663bdfe5c22e197cdb0a646431f3bf01979753f3828835ac222c`。它不是已发布 0.6.0 的复验，也不是已签名发行验收。身份记录 `.cache/wl5-baseline-provenance.json`。

## 探针改动

新增显式 `--require-native-launcher`：

- 校验两份 ZIP 摘要，检查条目目标均在独有解压目录内。候选 asar 版本须等于工作区 package 版本，并通过强制 native 集成/外置 helper 架构、协议及摘要检查；所有检查位于任何旧/新程序启动之前。
- 在开发依赖祖先目录之外真实启动旧程序，读取合成设置/待写入歌词并创建歌单，正常关闭后复制其资料副本。新程序分别使用空白资料和该旧资料副本启动。
- 检查新程序保留主题/音量、待写入歌词和歌单，再导入唯一合成源，启用、停用、重新启用、调用独立 `sources.reload()`，最后正常关闭并重新启动应用。
- 每个可用阶段使用不同曲目 ID，请求 320k；检查渲染层获得不含上游地址的 jjstream token，并确认原生宿主实际访问本轮 loopback marker。重启后检查同一 ID、stableId 和 enabled 状态恢复。
- 最后验证原旧资料副本、合成音频哨兵完全不变；正常退出并移除自有临时根。没有扫描、复制或使用用户实际资料和音源。

## 测试及独立审查

新增 `portable-upgrade-guard.test.mts`，用不可执行的合成 ZIP 证明不完整候选必须在启动任一程序前拒绝。原探针没有强制模式时，该测试先因尝试旧程序启动而失败；实现后明确在 native 资源检查失败处拒绝，通过回归。

独立只读审查确认预启动校验、进程重启、身份恢复和资料保护，指出“停用后启用”不能代替独立 reload 入口。先对首轮 46 项报告断言 reload marker，实际失败；补独立 reload 及新曲目 marker/质量检查后，两条真实路径重跑均通过。无 Critical 或延期 minor。

## 最终结果

| 路径 | 检查 | 本地 marker 请求 | 最终报告 runId |
| --- | --- | --- | --- |
| 0.4.2 → 候选 0.6.0 | 51 通过 | 4 | `55847259-483e-4b79-a981-9f9ad6d25967` |
| 0.5.0 → 候选 0.6.0 | 51 通过 | 4 | `4e1441eb-2499-478f-84f9-0c268b51aae5` |

两条路径合计 102 项检查；`nativeLauncherChecked=true`、`nativeSourceLifecycleTested=true`、`ownedRootRemoved=true`，均未触发强杀清理。原始报告使用 `.cache/or8-delivery/<runId>-portable-report.json`，汇总 `.cache/wl5-upgrade-summary.json`。通用 `portable-report.json` 也会被负向测试覆盖，不用于识别本次通过记录。

实际命令：

```powershell
node tools/probe/or8-delivery-package.mjs --old-zip=.cache/or8-delivery/official-0.4.2/JJ-Music-0.4.2-Portable-x64.zip --new-zip=.cache/wl3-release/JJ-Music-0.6.0-Portable-x64.zip --require-native-launcher
node tools/probe/or8-delivery-package.mjs --old-zip=.cache/release-0.5.0/remote-release/JJ-Music-0.5.0-Portable-x64.zip --new-zip=.cache/wl3-release/JJ-Music-0.6.0-Portable-x64.zip --require-native-launcher
npm test
```

生产 bundle 离线 runner **127/127 suites passed**；JavaScript 语法和 `git diff --check` 通过。日志 `.cache/wl5-upgrade-042-final.log`、`wl5-upgrade-050-final.log`、`wl5-offline-tests.log`。未改产品代码，不重复构建已校验的发行 ZIP。

## 明确边界

此次是“旧便携程序及资料副本 → 当前候选”的真实跨版本启动验证，合成源在升级后的候选中新导入；本轮未证明旧版已有启用音源的跨版本迁移，后续补充见 [已有音源迁移记录](existing-source-migration.md)。公开媒体地址从未实际取流；marker 仅为本机 HTTP 请求，不代表真实源兼容、播放听感或人工无闪窗。

报告保持 `nsisInstallationTested=false` 与 `onlineUpdaterTested=false`。真实 NSIS 安装/保留数据卸载/旧版升级、应用内下载更新、Terminal/Console Host 矩阵及人工/真实音源验收仍各自待验。遵循旧回环记录中用户停止原 Sandbox 计划的边界，不通过伪造 CI 环境执行安装器。
