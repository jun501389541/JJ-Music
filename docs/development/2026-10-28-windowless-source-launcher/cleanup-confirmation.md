# 回收未确认的失败传播与重启屏障

日期：2026-10-28。本轮延续用户继续开发授权，修复已经复现的回收失败路径；用户已明确暂不运行真实音源。

## 问题与行为

初始化取消时，宿主层虽报告“回收未确认”，引擎却因 signal 已取消而直接返回；stop/stopAll 等待的 done 只有完成信息，没有失败信息，因此可能误报停止成功。已注册的 runtime 也会在 teardown 前被删除，导致停止失败后或停止尚未完成时，重启看不到旧运行记录并可执行新宿主。

修复后：

- 宿主启动阶段的回收失败使用 `SourceCleanupError` 和固定 `SOURCE_CLEANUP_UNCONFIRMED` 标识；引擎按结构化标识识别，不依赖中文文案或跨 bundle 的构造器身份。
- pending 启动保留完成 promise 和回收失败；普通取消仍正常结束，未确认回收则向 stop/reload 传播失败，并保留小型失败记录。stopAll 也枚举这些记录。
- 已注册 runtime 在整个 teardown 等待期间保留所有权；只在清理确认后删除。代次已同步失效，不会继续路由请求；并发重启等待同一清理结果，失败后不能绕过它启动。
- 未确认错误提示保留临时目录并建议重启应用。失败记录不写入音源脚本内容或隔离标记，当前引擎实例保持阻断；正常取消不被记录为脚本故障。

此策略优先避免未知旧树与新树重叠；回收失败时不能承诺立即重试启用，需按错误提示重启应用。未降低令牌/Job 权限或增加普通进程回退。

## RED/GREEN 与复核

两个实际 native 宿主夹具分别在初始化中、ready 后进行停止。夹具先通过真实 teardown 回收进程，再注入“无法确认”的错误，避免测试自身留下活进程。原实现分别表现为 stop 未拒绝、后续 reload 未拒绝，日志 `.cache/cleanup-failure-red.log`。

修复后，两场景检查停止拒绝、后续 reload 拒绝、没有额外 host.start、stopAll 同样拒绝，且真实夹具 PID 已退出、scratch 已移除；原生生命周期定向19项通过。

独立只读复核指出停止等待期间仍可能并发启动：此前只在失败后恢复记录，但等待前已经删除。新增 gated teardown 回归，在旧清理阻塞时发起 reload，原实现实际出现额外启动（`starts=1`），RED 记录 `.cache/cleanup-concurrent-red.log`。首版修正遗漏内部 teardown 的删除点，同一回归仍失败，未当作修复完成；最终移除两个提前删除点，34项定向检查通过，日志 `.cache/cleanup-failure-final-focused.log`。

相应更新 `source-revision.test.mts` 的受控隔离/新版本替换调度：替代启动必须等待旧 teardown，释放 gate 后仍证明旧隔离判定不会污染新内容。未放松版本、启用状态或路由断言。此次只分派一次最终复核，未重复分派修复后的审查。

## 验证及边界

定向检查由 `tools/build-test.mjs` 构建生产模块，再通过 Node test runner 执行。回收异常是测试注入，不能据此声称在真实内核拒绝/卡死下已观察到同样行为；真实原生启动和回收先执行，错误传播和并发阻断由受控故障验证。

本轮产品代码已经变化，之前 `.cache/windowless-review-release` ZIP 与其两条各60项迁移报告保持历史身份，不包含本次回收确认修复。未运行真实音源、安装器、媒体播放或听感验收，未提交推送。

最终 `npm run verify` 退出码0，类型检查、生产构建、**128/128套件**与 **5/5门禁**通过，日志 `.cache/cleanup-failure-verify-final.log`。原生生命周期文件现含20项检查，包括三个未确认清理/并发阻断回归；`git diff --check` 通过。

另执行 `tools/package.mjs --dir --output=.cache/windowless-cleanup-release --electron-dist=node_modules/electron/dist`，生成本地未发布的0.6.0目录候选，不覆盖原目录或ZIP。`resources/app.asar` SHA-256 为 `e3f99cffc9ab6ffc2bf25f3df62bc373e8165a3e2ad6899a5403c7f91fc2ffbc`。强制 native 包资源校验通过，仓库外空白资料/唯一合成源检查平台、320k受控URL及本地请求，未通过项0。日志 `.cache/cleanup-failure-pack.log`、`cleanup-failure-package-check.log`、`cleanup-failure-packaged-source.log`。本轮未生成新的ZIP或重跑跨版本矩阵。

GraphFlow增量索引两次均返回 `Transport closed`，本轮及前轮未补索引项继续待连接恢复；未修改MCP全局配置。

## 后续补充：包含回收确认修复的便携 ZIP

同日核对上述目录的 app.asar 摘要未变后，用 .NET ZipFile/Optimal、不含外层目录生成独立 ZIP，并写入同目录 SHA256SUMS。目标已存在则拒绝覆盖；历史 review/wl3 资产均保留。

最新候选 `.cache/windowless-cleanup-release/JJ-Music-0.6.0-Portable-x64.zip` 长度 **155768795字节**，SHA-256：`66f274154786961429ae2aa37465d09be5eb8e6089cff867e18f37db6707f0c7`。这是本地未发布0.6.0构建，不是已发布版本复验。

使用既有 `or8-delivery-package.mjs --require-native-launcher --migrate-existing-source`，串行对两条正式基线运行：

| 基线 → 最新 ZIP | 检查 | 本地marker | 报告runId |
| --- | --- | --- | --- |
| 0.4.2 → 本地0.6.0 | 60通过 | 5 | `87fe732f-7af2-4f31-acdf-840292cba8e9` |
| 0.5.0 → 本地0.6.0 | 60通过 | 5 | `a6e01ff4-6b9b-475d-b63b-00e8f51c15c6` |

两份最终报告的候选摘要均匹配本节ZIP；native资源和已有源迁移标志为true，原ID/stableId保留，自有临时根正常清理且无失败强制清理。旧版启用源在新程序首次toggle/import前自动恢复，后续启停、独立reload、应用重启和新marker请求通过。报告 `.cache/or8-delivery/<runId>-portable-report.json`，日志 `.cache/cleanup-migration-042.log`、`cleanup-migration-050.log`，摘要 `.cache/windowless-cleanup-release/migration-summary.json`。

本补充完成最新修复ZIP的便携合成升级证据，前节“未生成ZIP/未重跑矩阵”保留为当轮历史状态。两报告仍明确NSIS安装及在线updater为false；未运行真实音源、媒体或人工验收。本轮未改产品代码，不重复前轮已通过的完整verify，未提交推送或发布。

本轮GraphFlow连接恢复，已完成增量索引，补齐前两轮待补项；差异空白检查通过。
