# 旧版已启用音源迁移验收

后续已补自有 detached 进程清理实测，见 [失败清理回归](failed-process-cleanup.md)；下文保留迁移当轮的验证边界。

生命周期最终修复后已生成新 ZIP，并重新完成两条各60项迁移，见 [最新候选迁移补充](final-review.md)；下文 runId 指向修复前历史候选，保持原身份。

日期：2026-10-28。继续便携升级回环，新增 `--migrate-existing-source`；它必须与 `--require-native-launcher` 一起使用，缺失时在创建资料前拒绝。未修改产品代码或重新构建候选。

旧版先导入并启用唯一自有合成源，确认可用和持久化 enabled 状态，正常退出后复制独有临时资料。候选在首次导入或 toggle 之前，必须自动恢复同一源，并通过新的 loopback marker 请求、320k 质量和受控 jjstream URL 检查。随后验证停用、重启用、独立 reload 和应用重启。旧资料及合成音频哨兵保持不变。

使用与 [前轮记录](portable-upgrade.md) 相同的两份正式基线 ZIP 和候选摘要；每次运行均重新校验 ZIP。候选仍为本地未发布的 0.6.0 构建。

| 路径 | 检查 | marker 请求 | 报告 runId |
| --- | --- | --- | --- |
| 0.4.2 → 候选 | 60 通过 | 5 | `f30c9c5a-4988-4fa4-9b97-53d0602f44e2` |
| 0.5.0 → 候选 | 60 通过 | 5 | `00a782f7-ddd7-41bf-a4ee-5d5622985e1f` |

两条路径均保留原 ID 和 stableId；`existingSourceMigrationTested=true`、`ownedRootRemoved=true`，成功路径正常退出，未触发失败进程清理。报告位于 `.cache/or8-delivery/<runId>-portable-report.json`。

实际命令在前轮两条 native 模式命令后追加 `--migrate-existing-source`。日志为 `.cache/existing-source-upgrade-042-final.log` 和 `.cache/existing-source-upgrade-050-final.log`。

早期两次 0.4.2 尝试超时：宿主已 ready，但旧版启用接口等待在线目录授权对话框。仅在合成资料预置拒绝且已询问后通过；没有更改用户设置或旧版二进制。两次残留的自有宿主已按各自临时 EXE 精确路径清理。探针现自动验证临时根及两个应用 EXE 路径，取得进程 SafeHandle 后清理失败运行；清理错误保持失败并保留诊断资料。guard 回归覆盖无进程的失败清理，未另行证明自动清理真实 detached host 的行为。

新增模式参数回归经历 RED/GREEN。独立静态审查未发现 Critical/Important 问题。`npm test` 通过生产 bundle 和离线 runner，**127/127 suites passed**；JavaScript 语法和 `git diff --check` 通过。日志 `.cache/existing-source-offline-tests.log`。GraphFlow 已增量索引。

此验收只证明自有合成源迁移和本机 HTTP 请求，不证明第三方音源兼容、真实音频或听感。两份报告均保持 `nsisInstallationTested=false`、`onlineUpdaterTested=false`；实际安装、终端矩阵、人工无闪窗仍待验。没有重开已停止的原 Sandbox 计划，没有提交、推送或发布。
