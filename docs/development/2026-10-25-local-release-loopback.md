# v0.5.0 本机 Release 回环核对

日期：2026-10-25。测试对象为已公开的官方 v0.5.0 Release，而非本地重新打包的候选。

## 核对与复验

| 项目 | 运行位置 | 本次结论 |
| --- | --- | --- |
| 正式六资产长度、摘要、Ed25519 清单及 latest.yml | 本机 | 通过；匿名确认 Release ID 423103675 为最新稳定版 |
| 官方 0.4.2 → 0.5.0 便携资料升级 | 本机隔离临时目录 | 22 项通过，运行 31bdb99b-18fd-4f91-9c83-e097e27eb8df |
| 官方 0.4.6 → 0.5.0 便携资料升级 | 本机隔离临时目录 | 22 项通过，运行 0aaa462b-a522-40fd-ba17-2389b65fb422 |
| NSIS 全新安装、卸载保留资料、同路径升级 | GitHub 临时 Windows runner | 原发布 CI 的 13 阶段通过；尚未取得本机执行结果 |
| 官方安装版检查、下载、安装并重启至 0.5.0 | GitHub 临时 Windows runner | 原验收 CI 的 16 项通过；尚未取得本机执行结果 |

本机两条便携路径合计 44 项检查。每条均实际启动旧版和新版，检查设置、待写入歌词与已建歌单保留、旧资料副本和合成音频哨兵不变，并确认自有临时根已清理。没有使用个人音乐或第三方音源。两份报告均明确记录 `nsisInstallationTested: false` 和 `onlineUpdaterTested: false`，不能解释为安装版更新已在本机通过。

三个官方 ZIP（0.4.2、0.4.6、0.5.0）均重新比对当前官方 Release API 的文件长度与 SHA-256；新包另行通过完整签名和资产集合检查。

## 本机安装版测试的环境准备

- 本机为 Windows 11 专业版，Hyper-V 服务运行中；管理员只读检查未发现现成虚拟机。
- 初始 Windows Sandbox 功能为 Disabled。
- 用户已明确批准启用 Windows Sandbox，并要求先不自动重启。
- 管理员调用 `Enable-WindowsOptionalFeature -Online -FeatureName Containers-DisposableClientVM -All -NoRestart` 成功，功能状态变为 Enabled；系统返回 `RestartNeeded: true`。
- 没有执行系统重启，也没有在宿主机安装、升级或卸载 JJ Music。现有 CI-only 验收保护保持原状。

## 用户本机确认与后续范围

用户随后明确反馈“我这边测了升级没问题”，并要求进行其他测试。此结果记录为用户本机实测升级通过；未提供起始版本、升级途径及逐项报告，不回填为本机13阶段NSIS或16项自动更新脚本通过。既有云端自动化结果保持各自来源。

不再继续原Sandbox安装版回环计划，转做正式包启动、合成音源与核心功能隔离回归。Windows Sandbox的启用/需重启结果保留为当时的环境准备记录，不据此声称用户已经或尚未重启。[其他测试结果](2026-10-25-post-release-tests.md)已另记；人工听感仍待验。

## 本机证据

原始证据保存在忽略的 `.cache/release-0.5.0/local-loopback/`：`portable-042-report.json`、`portable-046-report.json`、`asset-provenance.json`、`isolation-admin-report.json`、`sandbox-enable-report.json` 和 `summary.json`。正式发布与云端验收见[发布记录](2026-10-25-v0.5.0-release.md)。
