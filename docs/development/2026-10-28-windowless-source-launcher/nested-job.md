# WT11 嵌套 Job 合成验收

日期：2026-10-28。继续既有设计的 WT11，产品运行时代码未变。

新增仅测试的 `native/source-launcher/job-test.cpp`，通过 `tools/test-source-launcher-argv.ps1` 编译（MSVC x64、C++17、`/W4 /WX /MT`）。夹具创建无 breakaway 的 kill-on-close 外层 Job，以原子 Job 属性启动 Node supervisor，使用 `IsProcessInJob` 确认它属于该 Job 后恢复执行。

`tools/probe/windowless-nested-job.mjs` 在外层 Job 内构造 supervisor → owner → 生产 helper → 合成宿主 → 合成后代。外层 Job 句柄不继承，夹具持有它并等待 supervisor 返回；只有 supervisor 观察到 helper、宿主、后代均死亡后才打印 PASS，因此成功路径不能被关闭外层 Job 时的清理掩盖。

| 场景 | 结果 |
| --- | --- |
| owner 通过 stdin 发送 S | helper 退出码 0，宿主和后代被内层私有 Job 回收 |
| owner 退出 | helper、宿主和后代均退出，外层 supervisor 仍存活 |
| `--inject-no-stop` 负控制 | 故意不发送停止请求，因 `timeout: graceful helper exit` 返回非零，未产生成功报告 |

首轮正常停止场景的断言误要求 `childExit`。检查产品代码后确认：该状态只在宿主自行退出时发送，显式停止以 helper 正常退出确认 drain。修正探针断言，不修改产品协议；修正后两个场景均通过。

实际执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools/test-source-launcher-argv.ps1
node tools/probe/windowless-nested-job.mjs
node tools/probe/windowless-nested-job.mjs --inject-no-stop # 预期非零
node tools/probe/windowless-source-launch.mjs --startup-race
```

构建通过，两个嵌套场景通过，负控制按预期失败；既有原生探针六组检查全部通过，包括参数/权限/控制台、正常宿主退出、owner/helper 退出及暂停创建竞争回收。日志 `.cache/nested-job-build.log`、`nested-job-probe.log`、`nested-job-negative.log`、`nested-job-native-regression.log`。两场景报告 `.cache/windowless-nested/bb8caa2c-ff3b-4410-85c3-6d1c75008c44/result.json`。

独立只读复核未发现 Important/Critical 问题。JavaScript 语法和差异空白检查通过。本轮只增加测试夹具和探针，未改 TypeScript/产品资源，未重跑上轮已通过的 128 套离线测试。

GraphFlow 连接恢复，已完成增量索引（indexedFiles=3），补齐上轮因 Transport closed 留下的索引项。

本记录只覆盖当前 Windows 会话、兼容且无 UI 限制的外层 Job。任意第三方 Job 的限制组合、令牌/API/句柄失败注入、真实 Electron 或第三方音源不在此证据内，不能据此将 WT11 全矩阵标为完成。原窗口归属、终端矩阵、人工观察、真实安装与播放仍待验。未更改系统终端设置，未提交推送或运行安装器。

## 后续补充：真实进程数量限制导致创建失败

同日继续 WT11，扩展原夹具 `--limit-three`：设置并读回 `JOB_OBJECT_LIMIT_ACTIVE_PROCESS=3`。supervisor、owner、helper 占满三个位置后，生产 helper 创建第四个宿主进程，由 Windows 实际拒绝；没有注入产品 API 返回值，也未修改产品代码。

探针新增 `job-limit` 场景，确认 helper 退出码 1，仅一条 schema 1 的 `launchError`，launchId 保持，stage 为 `createProcess`，本次实际 Win32 错误码 **1816**；没有 `spawned`，合成宿主报告文件不存在，错误未包含夹具路径。

夹具现对全部场景在 supervisor 结束后、外层 Job 句柄关闭前查询 `ActiveProcesses`，必须在 5 秒内归零才输出 `OUTER_JOB_EMPTY`。它能覆盖尚未执行脚本的暂停进程，避免只看报告文件遗漏残留。原 stop、owner-exit 两场景继续通过。

新增断言先在旧夹具上因缺少 `OUTER_JOB_EMPTY` 失败；实现限制和计数后通过。`--inject-no-limit` 不设置上限，宿主正常创建，因 `limited Job must not report spawned` 按预期非零退出。负控制首轮曾等待 helper 退出超时，随后将意外 spawned 断言移到等待之前，最终以目标断言即时失败。

本轮命令：重新执行 `tools/test-source-launcher-argv.ps1`，然后运行 `node tools/probe/windowless-nested-job.mjs` 和预期失败的 `node tools/probe/windowless-nested-job.mjs --inject-no-limit`。构建 `/W4 /WX` 通过，最终三场景通过；报告 `.cache/windowless-nested/af7f71eb-089e-437d-82e7-43eb7f237f60/result.json`，实际错误在同根 `job-limit/failure.json`。日志 `.cache/nested-job-limit-build.log`、`nested-job-limit-probe.log`、`nested-job-limit-negative.log`，初始失败日志 `nested-job-limit-red.log`。

此证据增加一种真实 Job 限制失败，不证明任意第三方 Job 限制组合，也不覆盖其他令牌/API/句柄失败。未改生产资源，不重跑未受影响的离线 TypeScript 套件。

本次独立只读审查未发现 Important/Critical 问题，确认关闭前 Job 计数检查不会被最终清理掩盖。JavaScript 语法和 `git diff --check` 通过；GraphFlow 已增量索引。
