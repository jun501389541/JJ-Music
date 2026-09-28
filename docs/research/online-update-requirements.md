# JJ Music 安装版在线更新：研究与实施交接

状态：研究稿，2026-09-26。本文只定义需求与验证门槛，不代表已经实现或通过实机验证。

## 1. Goal、Scope、Constraints

**Goal**：用户安装一次带更新能力的 JJ Music 后，以后发布稳定版 GitHub Release 时，Windows 安装版可在应用内发现、下载并在用户确认后安装新版，且不丢失曲库、设置、歌单和音源资料。

**Scope**

- 本期：Windows x64 NSIS 安装版、稳定版渠道、启动时检查更新、用户确认后完整下载安装包、下载进度、验证后提示重启安装、设置页手动检查、失败后的重试与手动下载入口。
- 后期：NSIS 差分下载；便携 ZIP 仍由用户手动下载、解压替换。差分下载仅减少网络传输量，安装仍使用校验过的完整安装包。
- 不包含：便携版自替换、测试版渠道、强制更新、静默无提示安装、跨平台更新、自动回滚已启动但失败的 NSIS 安装。

**已确认的用户选择**（来自前次讨论）：先做安装版；启动时发现新版后先提示，确认才下载，完成后提示重启；先按无 Windows 代码签名证书、Ed25519 签名更新清单规划。

**约束**：当前发行目标为 NSIS 安装包和 ZIP；应用版本为 `0.2.0`；旧版没有更新器，必须手动安装一次带更新能力的版本。Windows 未经 Authenticode 签名的安装包仍可能触发系统信誉提示；Ed25519 清单验证不能代替 Windows 代码签名。

## 2. Current State 与证据

| 项目现状 | 证据与影响 |
| --- | --- |
| `package.json` 是 `0.2.0`，有 `electron-builder`，没有 `electron-updater` | [`package.json`](../../package.json)：需增加更新依赖与配置。 |
| NSIS 和 ZIP 共用 Windows x64 发行配置；安装器允许按用户或全机安装和自选路径 | [`electron-builder.yml`](../../electron-builder.yml)：不能仅靠路径或 `app.isPackaged` 判断是否安装版。参见 [NSIS 配置说明](https://www.electron.build/v26/docs/nsis/)。 |
| 构建脚本强制 `--publish never`，生成两份发行文件的 `SHA256SUMS.txt` | [`tools/package.mjs`](../../tools/package.mjs)：需独立发布流程；当前校验文件未签名，不能单独作为应用自动执行安装包的信任根。 |
| CI 仅验证和打包，没有上传 GitHub Release | [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml)：发布作业应独立，只有它取得最小写权限及签名密钥。 |
| 主进程统一处理 IPC、启动与退出；设置页已有“关于”和确认弹窗 | [`src/main/index.ts`](../../src/main/index.ts)、[`src/shared/ipc.ts`](../../src/shared/ipc.ts)、[`src/preload/index.ts`](../../src/preload/index.ts)、[`src/renderer/src/utils/settings-pages.ts`](../../src/renderer/src/utils/settings-pages.ts)：更新逻辑应由主进程拥有，仅向界面暴露状态和有限操作。 |
| **数据风险**：打包版只要程序目录可写，就把它当便携版并将数据放在 `exeDir/data`；数据位置指针也可能放在程序目录 | [`src/main/data-location.ts`](../../src/main/data-location.ts)。按用户安装的目录可以是可写的；本地 `electron-builder` 的 NSIS 卸载模板会递归清理整个安装目录 [`node_modules/app-builder-lib/templates/nsis/uninstaller.nsh`](../../node_modules/app-builder-lib/templates/nsis/uninstaller.nsh)。因此不能把 `deleteAppDataOnUninstall: false` 当作安装目录数据的保护。 |

最后一项是由代码和 NSIS 模板推导出的高风险场景，**尚需用旧版安装包在隔离 Windows 环境复现**。在证明已有安装目录内的资料能安全迁走前，不应发布自动更新。

## 3. 方案比较

| 方案 | 与现有架构的兼容性 | 代价与风险 | 结论 |
| --- | --- | --- | --- |
| A. 应用内仅提醒，跳转 GitHub Release 手动下载 | 改动最少，沿用现有安装包 | 不满足应用内下载和安装；用户仍需自行核对与操作 | 可作为失败后的兜底，不满足本期目标。 |
| B. `electron-updater` 管理 NSIS 下载与安装；独立 Ed25519 签名清单作为安装许可门槛 | 直接使用现有 NSIS、GitHub Release、主进程及 IPC 结构；后续可启用差分下载 | 需维护签名发布链和严格的双重校验；必须关闭更新器默认自动下载与退出时安装；先解决安装目录数据风险 | **推荐**。 |
| C. 自建下载、缓存、安装器启动与替换流程 | 可以完全控制签名验证 | 需重新实现更新器已提供的缓存、差分、进度和安装细节，维护面大 | 当前没有必要。 |

官方 [electron-builder v26 自动更新文档](https://www.electron.build/v26/docs/features/auto-update/)列出 NSIS、GitHub Provider、`latest.yml` 与更新事件。项目对应的 [v26 `NsisUpdater`](https://github.com/electron-userland/electron-builder/blob/v26.0.12/packages/electron-updater/src/NsisUpdater.ts)支持完整包及差分下载；[v26 `AppUpdater`](https://github.com/electron-userland/electron-builder/blob/v26.0.12/packages/electron-updater/src/AppUpdater.ts)默认 `autoDownload = true`、`autoInstallOnAppQuit = true`，实现本方案时必须显式关闭。

## 4. 推荐设计

### 4.1 第一门槛：安装类型与旧数据

为安装版建立可靠的安装身份标记，不以“目录可写”判定；ZIP 版不得启用安装器更新。验证 `0.2.0` 的按用户安装、全机安装和自选路径下，数据与数据位置指针实际在哪里。新安装器须在旧版卸载清理安装目录**之前**保护 `data/` 和 `data-location.json`，迁往安装目录外的安全位置，校验复制完整后才继续。已有自选数据目录不得被覆盖；失败应停止升级并明确提示。验证 `0.2.0 → 首个带更新能力版本` 的手动安装路径。这是发布前硬门槛。

NSIS 支持通过 `include` 自定义安装钩子，但旧版的卸载逻辑来自**旧版安装时写入磁盘的卸载器**，新版本的 `customUnInstall` 无法追溯修复旧版；应验证能否在新安装器的安装前阶段完成备份与迁移。[NSIS 自定义脚本说明](https://github.com/electron-userland/electron-builder/blob/master/website/docs/nsis.md)

### 4.2 可信更新链

1. Release 发布作业在 Windows 构建并验证 Setup EXE、ZIP、`SHA256SUMS.txt` 和 `latest.yml`。标签 `vX.Y.Z` 必须等于 `package.json` 版本；仅发布稳定版。
2. 对固定结构的清单原始字节做 Ed25519 签名。清单至少包含 schema 版本、Release tag、应用版本、渠道、Windows x64 Setup 文件名、长度、SHA-256 和 SHA-512。签名文件与清单、`latest.yml`、EXE、ZIP 一起上传至草稿 Release；全部核对后再公开发布。应用内置公钥。GitHub 建议先备齐资产再发布草稿 Release。[GitHub Release 文档](https://docs.github.com/en/repositories/releasing-projects-on-github/managing-releases-in-a-repository)
3. 主进程只从固定的官方仓库读取稳定版 Release，先验证清单签名、版本递增、架构、安装包名称与摘要；再调用 `electron-updater` 检查。`latest.yml` 是更新器的传输元数据，须与已签名清单中的版本、文件名及 SHA-512 匹配。发现不一致时拒绝下载或安装，稍后重试。下载地址只可指向该固定仓库与对应 Release 的预期资产，不接受清单中的任意 URL。
4. `autoDownload = false`，用户确认后才调用下载。首版关闭差分下载，只取完整 NSIS 包。下载完成后，主进程对 `downloadedFile` 再算 SHA-256 与签名清单对比；只有一致才展示“立即重启安装”。`autoInstallOnAppQuit = false`，普通退出或“稍后”不得安装。调用 `quitAndInstall` 前须确认当前下载仍对应已验证清单，并验证现有异步退出清理不会妨碍安装器。
5. 签名密钥不进仓库。推荐用受保护 GitHub Actions Environment 的 secret，仅发布作业可见；普通 PR/CI 保持只读。准备密钥轮换与紧急撤回流程。[GitHub Environment 与 secret 文档](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)

这一层签名能证明更新清单与安装包相匹配，但不能消除未签名 Windows 安装包的 SmartScreen 提示。未来获得代码签名证书后，可在不改变用户交互的前提下增加 Authenticode 校验。[electron-builder 代码签名说明](https://www.electron.build/docs/features/code-signing/code-signing-win/)

### 4.3 用户体验与失败处理

- 启动后非阻塞检查一次；网络失败不妨碍播放，不反复弹窗。设置 → 关于提供“检查更新”和当前版本。
- 有新版时展示版本、简短更新内容、安装包大小和“下载 / 稍后”；用户同意后显示进度及取消或重试。下载完提供“立即重启安装 / 稍后”。
- 验签失败、元数据不一致、文件校验失败、网络中断、磁盘空间不足时不执行安装，显示可理解的原因及 GitHub Release 手动入口。
- 校验或下载失败时保持现有安装不变。**NSIS 安装过程本身不承诺自动回滚**；如果安装失败，应提供手动重装与数据恢复说明，并在实机验证中覆盖。

## 5. Acceptance Criteria 与 Verification

| 验收条件 | 验证 |
| --- | --- |
| `0.2.0` 的真实安装版可手动升级到首个更新版，曲库、设置、歌单、音源及自选数据位置完整保留 | 隔离 Windows 环境分别测试按用户安装、全机安装、自选可写目录、已迁移目录；升级前后比对用户数据与应用内可见内容。 |
| ZIP 版从不自动执行 Setup；安装版启动后可检查且不阻塞播放 | 对两种发行物进行打包后端到端测试，检查安装身份和网络异常。 |
| 未经用户同意不下载；未明确要求安装时，普通退出不安装 | 监听下载与进程事件；覆盖关闭窗口、托盘模式、重启应用。 |
| 签名、版本、资产名称和下载文件摘要均有效才允许安装 | 单元测试无效签名、替换 EXE、元数据不一致、降级、预发布、错误架构；打包安装测试篡改资产及不完整 Release。 |
| 发布流程只公开完整一致的资产集；版本、标签、清单一致 | Windows CI 跑现有 `npm run verify` 与打包探针；检查 `latest.yml`、清单、签名、Setup 和 ZIP，再公开草稿 Release。 |
| 正常全量更新成功，失败可重试或手动安装 | 用两个连续版本的真实 NSIS 包，在干净虚拟机和已有资料的环境执行更新；记录下载、重启、安装、数据校验结果。 |

## 6. Implementation Tasks（给 Executor 的交接）

| ID | 任务与边界 | 交付物 | 依赖与验收 |
| --- | --- | --- | --- |
| U0 | **数据安全验证与迁移设计**：复现旧版安装目录行为，确定新安装器前置迁移钩子与安装身份标记；不触碰网络更新 | 隔离环境复现记录、迁移/失败处理方案、覆盖旧版资料的自动化或打包测试 | 先于全部任务。完成第 5 节第一条后才能继续发布。 |
| U1 | **发布与签名链**：增加仅标签触发的 Release 作业、版本检查、元数据与签名清单生成、草稿上传及完整性检查 | 可复现发行资产、签名/验证工具、密钥操作说明 | 依赖 U0 确认发行包形态；不得把私钥或令牌写入仓库。 |
| U2 | **主进程更新服务**：固定源与稳定渠道、安装版识别、签名与双重摘要校验、下载状态、显式安装、失败收敛 | 隔离的更新服务和针对信任边界的测试 | 依赖 U0、U1 的清单格式；必须在真实打包版验证退出流程。 |
| U3 | **受限 IPC 与界面**：只暴露检查、下载、取消、安装及状态事件；设置 → 关于和启动提示复用现有对话框/提示体系 | 可访问、可取消、能显示进度和错误的更新交互 | 依赖 U2 接口；渲染层不接收任意本地路径或安装 URL。 |
| U4 | **发行验收**：跨两个版本的 Windows 实机/虚拟机升级、数据保留、异常与 Release 完整性验证 | 发布检查记录、README 中首次手动升级与故障恢复说明 | U0–U3 完成且全部验收通过。 |
| U5 | **后续差分下载**：启用 NSIS 差分，失败回退完整包；最终重建 EXE 仍须通过签名清单摘要校验 | 差分和全量路径的带宽、耗时与完整性记录 | 独立后续阶段，U4 稳定后再做。 |

## 7. 尚待确认的实施门槛

1. U0 已用真实 `0.2.0` Setup 和同一修复候选在 Windows Sandbox 完成按用户内容迁移、自选可写目录、外部指针、目标冲突、全机清洁安装、标准账户与管理员的共享旧资料拒绝，以及确认账户归属后的备份恢复。全机共享旧资料的直接覆盖升级安全中止，须按账户人工恢复；详见 [U0 验证记录](online-update-u0-verification.md)。U4 的双版本自动更新与发行验收仍未完成。
2. 确定 Ed25519 私钥的保管人与受保护发布环境；生成并固定首个公钥后，验证密钥遗失或轮换时的恢复流程。
3. 在固定 `electron-builder` / `electron-updater` 版本的打包样机上验证 `update-downloaded.downloadedFile`、`latest.yml` 生成、异步 `before-quit` 与 `quitAndInstall` 的组合。若这一集成门槛不通过，先退到方案 A，不发布不受保护的自动安装。

满足这些门槛并通过第 5 节验证后，U1–U4 才可作为完整的安装版自动更新交付。
