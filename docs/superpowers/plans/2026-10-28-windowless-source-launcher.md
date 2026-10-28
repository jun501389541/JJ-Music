# Windows 无窗口音源启动器 Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement task-by-task. 用户于2026-10-28明确授权提交并推送；交付分支为 `codex/windowless-source-launcher`。此前记录中的未提交状态保留为历史事实。

**Goal:** 用受限令牌和私有 Job 启动音源，去掉控制台中转。
**Architecture:** C++ GUI helper 管理宿主树，JSON 状态和既有文件 IPC 分工。先通过原生门槛，再替换生产路径。
**Tech Stack:** MSVC x64、Win32、Node/Electron、TypeScript。
**Spec:** ../specs/2026-10-28-windowless-source-launcher-design.md

## Global Constraints

保留 SAFER NORMALUSER；关机特权必须不存在；不静默回退。保留 512 MiB 和 15 秒初始化契约。不读取真实音源，不更改系统终端设置。构建输出忽略。

## Review Focus

参数含空格/中文/末尾反斜线；owner 退出；helper 异常终止；宿主退出而后代存活；参数失败不得启动宿主。均由原生合成探针覆盖。

### Task 1: WL0 / 原生参数基线

- [x] 检查未提交改动及 MSVC；运行 `tools/test-source-launcher-argv.ps1`。
- [x] 旧 SAFER 与新 helper 当前会话合成权限对比，证据见 WL1。
- [ ] 窗口归属基线；证据不足不得声明原弹窗已复现。

### Task 2: WL1 原生启动器

Files: `native/source-launcher/main.cpp`, `tools/build-source-launcher.ps1`, `tools/probe/windowless-source-launch.mjs`, `native/source-launcher/README.md`。
Interface: 设计 §5 的八个命名参数；stdout schema=1，launchId/type/pid 或 stage/win32Code/message；宿主不继承状态句柄。

- [x] 编写合成 probe 并确认 helper 缺失时失败。
- [x] 实现 GUI / SAFER / 暂停创建 / 原子 Job / owner 监视 / 有界状态。
- [x] 构建并验证参数、退出、权限和树回收；记录实际边界，见 WL1 开发记录。当前会话探针通过，不代表 WL0 或完整 WL1 验收矩阵关闭。

### Task 3: WL2 宿主接入

Files: `src/main/sources/restricted-launch.ts`, `source-runtime-host.ts`, `src/test/windowless-launcher.test.mts`, `tools/build-test.mjs`。
- [x] 为状态乱序、取消、断管、失败写回归，先 RED 后 GREEN。
- [x] 按可信资源路径启动 helper；ready 与 spawned 双重确认；回收不再信任心跳 PID。
- [x] 经生产 bundle 和 runner 运行离线套件。126/126 加 5/5 门禁；审查修复及实际命令见 WL2 记录。

### Task 4: WL3 / WL4

Files: `tools/package.mjs`, `electron-builder.yml`, CI、包验证和开发记录。
- [x] 将原生构建接入 dev/test/package，包校验检查外置 helper 架构、协议清单和实际摘要。
- [x] 验证最终目录包及仓库外独立目录的空白资料合成音源启动、受控地址解析和本地请求；未通过项 0。
- [x] 构建实际 NSIS 和便携 ZIP，摘要均匹配；ZIP 实际解压后仓库外合成验收通过，NSIS 静态载荷强制 native 检查通过。
- [x] 为候选全新安装和同路径升级接入强制 native 安装目录检查；保留 CI-only guard。
- [ ] 在一次性 CI/专门隔离环境实际执行 NSIS 安装、保留数据卸载和旧版升级矩阵；本机不运行 CI-only 安装器。
- [x] 增加窗口 CREATE/SHOW/foreground 观察、非激活正控制和两类负控制；未知归属不许通过。当前会话串行合成观察通过，证据见 WL4。
- [x] 审查修复后完整生产 bundle 离线 runner 126/126；前轮 verify 和 5/5 门禁证据见 WL2。
- [ ] 原窗口归属、两类默认终端矩阵、人工无闪窗及真实音源验收，单列待验。

### Task 5: 旧正式便携包到无窗口候选的升级回环

复用 `tools/probe/or8-delivery-package.mjs`。保留旧记录中停止原 Sandbox 计划的边界，不重开本机安装测试。

- [x] 重新核对公开 0.4.2、0.5.0 ZIP 的长度和 SHA-256，拒绝损坏资产。
- [x] 为 `--require-native-launcher` 增加候选资源强制校验、升级后合成音源启用/停用/独立 reload、应用重启、持久化稳定 ID 与本地 marker 请求及受控 URL 检查。
- [x] 保持旧资料副本和合成音频哨兵不变；真实跨版本运行两条路径各 51 项，报告 NSIS/在线更新均为 false。合成源在升级后导入，不代表旧源迁移。
- [x] 独立审查及 reload 覆盖修复，完整离线 runner 127/127；详情见 `docs/development/2026-10-28-windowless-source-launcher/portable-upgrade.md`。

### Task 6: 旧版已启用音源迁移

- [x] 显式迁移模式只允许 native 校验；旧版导入启用后关闭复制资料。
- [x] 候选首次 toggle/import 前确认自动恢复及新 marker 请求，保留 ID/stableId；两条基线各 60 项通过。
- [x] 合成资料避开旧版授权模态；失败进程清理限定自有临时根和精确 EXE 路径，独立审查无重要问题。
- [x] 完整生产 bundle 离线 runner 127/127，语法和差异空白检查通过，增量索引完成。
- 证据及验收边界见 `docs/development/2026-10-28-windowless-source-launcher/existing-source-migration.md`。

### Task 7: 失败探针进程清理实测

- [x] 抽取探针专用清理模块，保留精确 EXE 路径和临时根校验。
- [x] 验证两个自有 detached 进程终止、目录外同名进程存活及清理幂等。
- [x] 独立审查后为测试最终清理补 PID 条件和有界等待。
- [x] 完整生产 bundle 离线 runner 128/128，通过语法和差异空白检查。
- [x] 本轮 GraphFlow 索引曾连续返回 Transport closed；Task 8 时连接恢复，已增量补做。
- 详情见 `docs/development/2026-10-28-windowless-source-launcher/failed-process-cleanup.md`。

### Task 8: WT11 兼容外层 Job

- [x] 构建仅测试的外层 Job 夹具，在 supervisor 检查完成前保持外层句柄。
- [x] 验证嵌套正常停止与 owner 退出；不停止的负控制按预期失败。
- [x] 既有原生探针六组回归通过，独立复核无重要问题。
- [ ] 任意第三方 Job 限制及令牌/API/句柄失败注入仍未覆盖，不关闭 WT11 全矩阵。
- 详情见 `docs/development/2026-10-28-windowless-source-launcher/nested-job.md`。

### Task 9: WT11 外层 Job 进程数量限制

- [x] 施加并读回三进程上限，验证生产 helper 真实创建宿主失败。
- [x] 检查仅 launchError、无 spawned/脚本执行及 helper 退出码 1；全部场景关闭外层 Job 前活跃进程归零。
- [x] 移除上限的负控制按预期失败，原兼容场景继续通过。
- [x] 独立复核无重要问题，语法及差异检查通过，GraphFlow 增量索引。
- 详情见嵌套 Job 记录的后续补充；其他令牌/API/句柄失败及任意 Job 限制组合仍待验。

### Task 10: 累计工程检查与验收对照

- [x] 完整 verify：类型检查、生产构建、128/128 离线套件和 5/5 门禁通过。
- [x] 自有 APPDATA 和合成源的隔离 E2E 16/16，通过后恢复生产构建并动态确认测试钩子不可达；无曲目相关项目明确跳过。
- [x] 对照 WT01–WT12 汇总证据和待验边界，见 `docs/development/2026-10-28-windowless-source-launcher/acceptance-status.md`。
- [x] 本轮文档增量索引：Task 11 时连接恢复，已补做。

### Task 11: WT03 长路径边界

- [x] 自有短路径夹具核对尾反斜线、特殊字符、工作目录及512MiB参数。
- [x] 记录普通/扩展格式超长路径明确拒绝，标记 supported:false，不宣称支持长路径。
- [x] 畸形 PE 文件返回安全 createProcess 错误，无产品修改。
- [x] 独立审查发现并修复探针 stderr 检查盲点；注入路径的负控制先错误接受，修复后按预期拒绝。
- 详情见 `docs/development/2026-10-28-windowless-source-launcher/path-boundary.md`。用户已明确暂不运行真实音源。

### Task 12: 累计产品最终复核

- [x] 独立累计复核发现两项 Important：pending start 停止不回收，ready 后零码退出不落盘停用。
- [x] 原生真实宿主 RED/GREEN 覆盖停止、stopAll、重启重叠和 ready 后零码退出；实现内部取消器与回收等待，移除零码意外退出例外。
- [x] 调整旧受控测试调度以验证 stop 等待契约，引擎 154 项定向检查通过。
- [x] 最终完整 verify 128/128 与5/5门禁；新目录候选强制 native 校验及仓库外空白资料合成检查未通过项0。
- 详情见 `docs/development/2026-10-28-windowless-source-launcher/final-review.md`；此前 ZIP 不含本次产品修复。

### Task 13: 最终修复 ZIP 与已有源迁移

- [x] 校验新目录 asar 身份，生成独立便携 ZIP 与 SHA256SUMS，不覆盖旧候选。
- [x] 最新 ZIP 的0.4.2/0.5.0已有启用合成源迁移各60项通过，ID/stableId保留，临时根正常清理。
- [x] 核对最终报告候选摘要及安装/在线更新 false 边界，更新记录并索引。
- 证据见最终复核记录的后续补充；本轮未改产品代码，未运行真实音源或安装器。

### Task 14: WT09 原生更新与回退

- [x] 真实 native helper 验证启用源 v1→v2→v1，稳定身份、路由版本及运行代次正确，被替换宿主正常回收。
- [x] 真实坏候选启动失败后恢复 v1，不提交坏内容，不污染启用/错误状态。
- [x] 失败候选自身进程和scratch回收确认，正式离线runner128/128，通过差异检查。
- [x] 本轮GraphFlow增量索引曾返回Transport closed，Task16恢复后已补做。
- 记录见 `docs/development/2026-10-28-windowless-source-launcher/native-source-update.md`。

### Task 15: 回收未确认不得误报成功

- [x] 实际原生宿主注入回收异常，复现初始化停止吞错、ready后失败丢失所有权。
- [x] 结构化传播回收失败，保留失败启动和停止中的runtime；stop/reload不能越过未确认的旧树。
- [x] 独立复核发现并发窗口，gated RED复现后补齐所有权屏障，相关34项检查通过。
- [x] 最终verify128/128与5/5通过，新目录候选native资源及仓库外合成源检查未通过项0。
- [x] GraphFlow曾返回Transport closed，Task16恢复后已补做增量索引。
- 记录见 `docs/development/2026-10-28-windowless-source-launcher/cleanup-confirmation.md`；旧ZIP不含本次产品修复。

### Task 16: 回收确认修复的便携成品闭环

- [x] 核对cleanup目录asar身份，生成独立便携ZIP及SHA256SUMS，不覆盖旧候选。
- [x] 两条正式基线到最新ZIP的已有合成源迁移各60项通过，身份保留且临时根正常清理。
- [x] 复核最终报告的候选摘要、native标志及安装/在线更新false边界，保留汇总。
- 证据见回收确认记录的后续补充；未运行真实音源或安装器。

### Task 17: 原生合成 CI 门禁

- [x] Windows verify接入独立fixture/TestBarrier构建和启动竞争、嵌套Job、路径探针，不吞失败。
- [x] YAML解析、权限和依赖检查通过，本机等效命令通过。
- [x] 独立复核无重要问题，差异检查通过。
- [ ] GraphFlow连接关闭，本轮增量索引待补。
- [ ] 尚未推送或触发远端CI，远端运行待明确交付授权后验证。
- 记录见 `docs/development/2026-10-28-windowless-source-launcher/native-ci.md`。
