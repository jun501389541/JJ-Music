# 累计产品最终复核与生命周期修复

日期：2026-10-28。复核基线 HEAD `0ae0e374c0bd50c373d58351a09f2241e6bb1870`，范围为累计未提交的原生 helper、参数、状态协议、受限启动、宿主/引擎生命周期、主进程资源路径和构建打包。独立只读审查发现两项 Important，无 Critical、无延期 Minor。用户已明确暂不运行真实音源；本轮只使用自有合成宿主。

## 修复一：初始化宿主必须能停止并避免重叠运行

原引擎只为 pending start 保存代次，公开 stop/stopAll 找不到尚未注册的 runtime 就返回。旧结果虽不能进入 provider 表，旧脚本仍可能执行至 ready 或超时，重新启用还会启动另一代。

每次启动现持有内部 AbortController 和完成 promise，外部取消转发至内部 signal。stop 先递增代次，再取消并等待旧启动/已注册运行时完成回收；替代启动同样先等待较旧代次。只取消更旧代次，防止旧任务误取消更新任务；完成时移除监听器并释放记录。用户取消不落盘为源故障。

Final: fixed pending initialization stop/restart — `engine stop/stopAll waits for a native initializing host to be reaped` 在原生产实现上失败（停止已返回而宿主仍活着），修复后通过。`native reload reaps an initializing generation before its replacement executes` 另以暂时移除新增启动取消步骤作 RED 控制，真实观察到 `previousAlive=true`；恢复修复后纳入全量回归。

## 修复二：ready 后意外零码退出也应停用

原引擎对非 intentional 的 code=0 提前返回，宿主已经死亡却仍持久化 enabled=true。移除此例外；保留 intentional、旧代次和候选版本分支，意外退出统一保存原因、停用并通知 sourcesChanged。

Final: fixed unexpected post-ready zero exit — `a native host exiting zero after ready disables the source and persists its error` 在原实现上失败，修复后检查实时可用平台消失、enabled=false、lastError、通知及重新加载存储后的状态均成立。夹具由父测试在 reload 完成后创建退出标记，确保实际覆盖 ready 之后。

## 验证过程

初始三个失败回归日志 `.cache/final-review-red.log`；重启重叠 RED 控制 `.cache/final-review-reload-red.log`。首轮定向真实宿主检查 14/14 通过，日志 `.cache/final-review-focused.log`；随后新增重启检查进入正式 runner。

首次完整 verify 为 127/128：`source-engine.test.mts` 两个受控 fake 忽略取消信号，仍按“await stop 后才释放 host.start”调度，形成未完成顶层 await。调整为发起 stop、先确认其未完成、释放受控宿主、再等待停止和启动；候选取消同样提前观察拒绝并调整释放顺序。未放松迟到发布/回收/持久化断言。引擎定向 **154 passed, 0 failed**，日志 `.cache/final-review-engine-focused.log`。

旧 `.cache/wl3-release` ZIP 和此前跨版本报告均早于本次产品修复，不能作为修复后的发行成品证据；保留历史资产和报告，不覆盖其身份。实际安装、人工无闪窗、真实音源与播放边界继续保留。未提交、推送或发布。

## 最终验证及新目录候选

完整 `npm run verify` 最终退出码 0：类型检查、生产构建、**128/128 套件**与 **5/5 门禁**通过，日志 `.cache/final-review-verify-final.log`。`windowless-runtime.test.mts` 的 15 项检查包含以上四项新增真实宿主回归。没有重复分派审查，重要发现均在当前修复及验证轮内处理。

执行 `node tools/package.mjs --dir --output=.cache/windowless-review-release --electron-dist=node_modules/electron/dist`，生成包含本次修复的本地目录候选 `.cache/windowless-review-release/win-unpacked`。这是未发布的 0.6.0 本地构建，未运行安装器，也未覆盖旧 ZIP。

新候选 `resources/app.asar` SHA-256：`231064a1a607dbb240cc9964e2a3f1385af32a83feda947b013f30f2f2aa6676`。`verify-package.mjs <asar> --artifact-version=0.6.0 --require-native-launcher` 通过，包含 helper x64 GUI/协议/摘要强制校验。随后 `clean-profile-sources.mjs --app=.cache/windowless-review-release/win-unpacked --synthetic` 将包复制到仓库外，使用空白资料导入并启用唯一自有源，5 平台可用、受控 URL、320k、宿主真实 loopback 请求通过，**未通过项 0**。日志 `.cache/final-review-pack.log`、`final-review-package-check.log`、`final-review-packaged-source.log`。

修复后的目录候选只补此空白资料合成成品检查；此前 ZIP 的两条跨版本 60 项报告仍保持历史身份，未在新候选上重跑。未读取真实音源，未验证真实音频播放或人工听感。`git diff --check` 通过，GraphFlow 增量索引已更新。

## 后续补充：修复后新 ZIP 的跨版本迁移

同日将上述新目录候选归档到 `.cache/windowless-review-release/JJ-Music-0.6.0-Portable-x64.zip`。归档前重新核对 app.asar 摘要与上节一致；使用 .NET ZipFile、Optimal 压缩、不带外层目录，拒绝覆盖已有 ZIP，并生成同目录 `SHA256SUMS.txt`。未覆盖 `.cache/wl3-release` 的历史资产。

新 ZIP 长度 **155768619 字节**，SHA-256：`b37054a912ee2fb7e6a0d25cf15ea2f05f72ecdf5c04c79e300ac3563a1bdaca`。它是未发布的本地候选，不是官方已发布 0.6.0 的复验。

串行重跑 `or8-delivery-package.mjs`，均使用 `--require-native-launcher --migrate-existing-source` 和这个新 ZIP：

| 基线 → 最新候选 | 检查 | loopback marker | 报告 runId |
| --- | --- | --- | --- |
| 0.4.2 → 本地 0.6.0 | 60 通过 | 5 | `2e398fad-f32d-45d7-a462-0c4c1e7e204c` |
| 0.5.0 → 本地 0.6.0 | 60 通过 | 5 | `9bad3407-784d-4be5-a04b-a7b0a1086dff` |

两份最终报告重新核对：候选摘要匹配，native 与 existingSourceMigration 标志为 true；旧版启用的自有源在新应用首次 toggle/import 前自动可用，并保留 ID/stableId。后续启停、独立 reload、应用重启及本地请求检查通过，旧资料/哨兵不变，`ownedRootRemoved=true`，未触发失败强制清理。报告位于 `.cache/or8-delivery/<runId>-portable-report.json`，日志 `.cache/latest-migration-042.log` 和 `latest-migration-050.log`。

以上补齐最新修复 ZIP 的合成便携跨版本证据，前节“未在新候选重跑”是当时的历史状态。两份报告仍保持 NSIS 安装和在线 updater 为 false；用户明确暂不运行真实音源，本轮未运行第三方脚本、实际媒体或人工听感验收。仅归档、运行既有验收工具并更新记录，无产品代码变化，不重复未受影响的完整离线检查。差异空白检查通过，已增量索引；未提交、推送、安装或发布。
