# 在线更新 U0：旧版数据安全核查

状态：**v0.3.1 U0 隔离环境验收通过**，本地候选 Setup SHA-256 为 `793B8432194DDC019E45BE7057A75937B9104F1E292923BA78DD04A047A4D692`，以已校验的官方 v0.2.0 Setup 为旧版样本，完成下文五项 Windows Sandbox 场景。全机旧版存在共享资料时，安装器先以退出码 42 拒绝；明确样本账户归属、备份并逐文件校验后可重试。此次验证覆盖真实 v0.2.0 到 v0.3.1 安装器升级，不覆盖更新器自动下载、退出与安装流程（U4）。本地候选使用一次性 Ed25519 测试密钥，不得作为公开发行资产；公开发行包须由签名发布工作流生成。

## 已核实的事实

- `v0.2.0` 标签中的 `resolveDataDir` 将「已打包且程序目录可写」判为便携数据位置 `exeDir/data`。`pointerPath` 在同一条件下把 `data-location.json` 放在程序目录。此判断不识别 NSIS 安装身份。
- `v0.2.0` 的 NSIS 配置允许按用户或全机安装，并允许自选安装目录。按用户安装和自选可写目录因此都可能命中上述便携路径；是否实际命中须在相应账户与目录权限下测量。
- `v0.2.0` 锁文件和本机安装的 `app-builder-lib` 均为 26.15.3。该版本的 NSIS 模板在升级时先调用旧卸载器，再安装新文件。旧卸载器的 `un.atomicRMDir` 与 `RMDir /r $INSTDIR` 会处理安装目录中的其他文件。`deleteAppDataOnUninstall: false` 只涉及 AppData 清理，不能保护 `$INSTDIR/data`。
- `customInstall` 位于旧版卸载**之后**，不能用于抢救旧数据；`customUnInstall` 会编入新版卸载器，不能改变已经发行的 0.2.0 卸载器。`customInit` 位于安装节之前，但它在安装模式、UAC 内外实例和自选路径场景中的行为仍需打包验证。
- 官方 `v0.2.0` Release 包含 `JJ-Music-0.2.0-Setup-x64.exe` 与 `SHA256SUMS.txt`。Setup 已下载至工作树的 `.cache/legacy-0.2.0/`，长度 103122524 字节；本地 SHA-256 为 `0bd693a17390003757025645d2b121780a73a9fc985c49276d3ca78c7c6ef7c1`，与官方校验文件一致。该未签名校验文件仅作为本次样本核对依据，不是未来自动更新的信任根。
- 2026-09-26 的隔离工作树基线：`npm test` 为 31/31 套件通过。它没有运行 NSIS 升级，也不能证明用户数据安全。

## U0 实施设计与选择

前置迁移曾比较两条路径：

| 路径 | 与现有构建的关系 | 待验证风险 |
| --- | --- | --- |
| 在 NSIS `customInit` 中执行备份 | 可保留 electron-builder 默认安装脚本 | 运行时尚未经过 `CHECK_APP_RUNNING`；仍在写入的数据可能被复制成不一致快照。UAC 内外实例、旧安装注册信息和最终目标路径也可能不一致 |
| 为当前 `app-builder-lib` 版本维护带前置钩子的安装脚本 | 可把备份放在 `CHECK_APP_RUNNING` 与 `uninstallOldVersion` 之间，时序更明确 | 需要随 electron-builder 模板升级审查差异，打包维护成本较高 |

最终在模板的 `customCheckAppRunning` 中执行按用户迁移，确保旧进程停止后、旧卸载器运行前完成复制与校验；另在 `customInit` 检查已注册的全机旧目录，防止 UAC 内部实例跳过前一钩子。全机共享资料无法安全判断账户归属时退出 42，不复制到提权账户。

1. **安装身份**：让安装器创建仅 NSIS 安装版持有的标记；应用使用标记及安装注册信息判断安装版，停止以目录可写性决定安装版数据位置。ZIP 版继续保持便携数据语义。标记在旧版卸载后由新版安装器写入，因此不能独自解决旧版数据迁移。
2. **卸载前保护**：新安装器在调用旧卸载器之前定位注册的旧安装目录，检查 `data/`、`data-location.json` 与现有 AppData 指针。若旧数据位于安装目录，先复制到安装目录外的隔离目标，逐文件核对长度和 SHA-256，再原子写入新位置指针。遇到目标冲突、无法读取、空间不足或校验失败，安装应终止；不得让旧卸载器先运行。不得覆盖已有自选数据目录。
3. **权限与账户**：按用户安装须在原用户上下文迁移。全机安装要分别验证标准用户发起、UAC 提权和多账户使用；不能假定提升后的 `%APPDATA%` 一定属于原用户。若无法可靠识别原资料的拥有账户，安装器应拒绝自动迁移并给出恢复方式。
4. **恢复**：迁移过程不主动删除旧资料；旧卸载器随后仍会清理安装目录，因此校验过的外部副本须保留到新版首次启动确认后。迁移失败时保留旧版和日志；安装阶段失败时可用旧包重装，并从已验证的外部副本恢复。

## 必须执行的隔离 Windows 测试

| 场景 | 升级前记录 | 通过条件 |
| --- | --- | --- |
| 0.2.0 按用户安装 | 安装目录、资料目录、指针、曲库/设置/歌单/音源 | 手动安装首个更新版后，逐文件及应用内内容一致 |
| 0.2.0 全机安装 | 管理员与标准用户各自的数据位置及权限 | 两个账户资料不串用，升级后均可读写 |
| 自选可写安装目录 | `$INSTDIR/data` 和指针的实际内容 | 旧卸载前完成独立备份，升级后使用备份数据 |
| 已迁移至自选数据目录 | 指针及目标目录 | 不覆盖目标，不丢失指针，升级后仍使用目标 |
| 目标冲突或复制失败 | 故意制造同名目录、只读文件、空间不足 | 安装中止；旧版和原资料仍可使用 |
| 首版更新器后续自动升级 | 安装身份、退出与下载日志 | ZIP 不启动 Setup；安装版数据持续位于安全位置 |

每个场景先保存文件清单与哈希，再升级并对照；同时在界面确认曲库、设置、歌单与音源。测试必须使用已核对 SHA-256 的真实 0.2.0 Setup，不能只用 `win-unpacked` 或模拟目录替代。

## 已实现的资料快照工具

`tools/probe/upgrade-data.mjs` 是独立验证工具，不安装软件、不迁移资料。它读取指定目录下的所有普通文件，记录相对路径、字节数与 SHA-256；输出清单必须在资料目录之外且不存在，防止覆盖原始证据。目录链接、空基线、损坏清单和读取异常均以错误退出。

在隔离 Windows 环境中关闭旧版应用后执行（下面路径是测试样例，须替换为该场景实际资料路径）：

```powershell
node tools/probe/upgrade-data.mjs snapshot 'C:\U0\old-profile' 'C:\U0\before.json'
```

升级后、首次启动新版之前，针对迁移目标运行：

```powershell
node tools/probe/upgrade-data.mjs compare 'C:\U0\before.json' 'C:\U0\migrated-profile'
```

输出列出缺失、变化和新增文件。退出码 0 表示快照已保存或文件完全一致；1 表示存在差异；2 表示输入或读取错误。工具不忽略缓存文件，因此应在应用关闭时取证，并把升级中的合法变化逐项记录；文件一致也不能代替首次启动后的界面验收。清单可能包含个人文件名，只应保留在测试环境。

自动化测试位于 `src/test/upgrade-data.test.mts`，覆盖异地复制、同长度篡改、文件丢失、新增文件、清单覆盖、空/缺失目录、目录链接及非法清单，已纳入 `npm test` 自动发现。

2026-09-26 验证结果：新增工具 6/6 测试通过；完整 `npm test` 为 32/32 套件通过，退出码 0。完整日志在本工作树 `.cache/u0-tests.log`。这些测试使用临时样本目录，没有执行安装或升级。

## 2026-09-27 Windows Sandbox 实测

沙盒配置将已校验的官方 0.2.0 Setup 和本地候选 Setup 以只读目录映射到沙盒，结果映射到工作树 `.cache/u0-sandbox/output/`；网络、剪贴板和 vGPU 均关闭。该目录是临时证据，不属于发布物。

| 测试 | 证据 | 结果 |
| --- | --- | --- |
| 官方 0.2.0 按用户安装到 `C:\U0Case\Installed` 并启动 | `baseline.json`；官方 Setup SHA-256 `0BD693A17390003757025645D2B121780A73A9FC985C49276D3CA78C7C6EF7C1` | 安装退出码 0；旧版将 35 个资料文件写到 `$INSTDIR/data`，AppData 目标为空 |
| 官方 0.2.0 原样覆盖重装 | `negative.json` | 两次安装退出码均为 0；升级前存在的 `u0-sentinel.txt` 升级后消失，证实旧卸载路径会删除安装目录资料 |
| 第一版前置迁移钩子 | `upgrade-attempt1.json` | 新安装器退出码 40，旧资料保留；未完成迁移 |
| 前两轮诊断 | 候选包 SHA-256 `3F9F3F86B3ECC92ADF4D370EA5D4C292524B9D195A3FE5DA31E85F9B409F7A61` | 旧应用创建了空的 AppData 目标；修正空目录冲突后，迁移在 260 字符的临时缓存路径上失败。两次均在旧卸载前停止，旧资料保留 |
| 按用户升级，自选可写安装目录 | `upgrade-positive-confirmed.json`；候选 Setup SHA-256 `A02C42B9DC140FF7F29D7B23FD404D71B411A52F8A6120A06326AEC0488D2BC4` | 两次安装退出码 0；迁移前后 35 个文件逐一哈希一致；NSIS 标记存在，哨兵文件保留。后续人工启动发现 JavaScript 错误，原探针的“进程存活”不能证明新版可用 |
| 已有 AppData 目标冲突 | `conflict.json` | 新安装器退出码 40；旧 EXE、旧资料哨兵和目标冲突文件都保留，NSIS 标记未写入 |
| 外部数据目录指针 | `external.json` | 新安装器退出码 0；指针哈希一致，外部文件不变，旧安装目录资料进入独立备份；新版启动后未新建安装目录资料 |
| 全机安装，管理员账户曾运行旧版 | `allusers-initial.json` | 真实 0.2.0 在 `C:\Program Files\JJ Music\data` 建立资料；候选安装器退出码 40，旧资料保留。安装上下文的 AppData 为 `C:\ProgramData`，不能据此认定资料所属用户 |
| 全机安装专用拒绝提示复测 | `allusers-failclosed-confirmed.json`；候选 Setup SHA-256 `F81AA9BBC29FD4397B5D8E317690C90AE4F89A2C93507EE5707994AB06799D26` | 安装器退出码 42；旧资料仍在，NSIS 标记未写入。标准账户的旧版进程在当前非交互式探针中提前退出，不能据此判定正常桌面登录行为 |
| 全机安装，无共享旧资料 | `allusers-clean-initial.json`；同一候选 Setup | 旧版与新版安装退出码均为 0，新版标记存在，安装目录没有新建 `data`。原探针仅凭进程存活错误地报告新版启动成功，账户隔离尚未得到证明 |

迁移脚本改用较短的同级临时目录后，按用户真实升级通过。其本地 6 项用例通过，包含空 AppData 目录、冲突目标、外部指针、全机安装拒绝自动归属以及长嵌套缓存路径。另加安装目录与注册表旧目录不一致时的卸载前拒绝保护。全机安装含旧目录资料时使用专用退出码 42 与账户恢复提示；本地和沙盒拒绝行为都已通过。早期候选 Setup SHA-256 为 `F81AA9BBC29FD4397B5D8E317690C90AE4F89A2C93507EE5707994AB06799D26`；NSIS/ZIP 打包成功，当时 `npm run verify` 为 38/38 套件通过，直接迁移测试为 6/6。完整日志为 `.cache/u0-final-verify.log`。修复启动错误后的候选包哈希和复测结果见下文。

## 历史候选与后续复测

修正版沙盒复测 `allusers.json`：候选 Setup SHA-256 `F24C7845B65D5A5C77F7A3BC91EF813F4CDEEB337BDF874BBC0D4A478ABE939C`，旧版与新版全机安装退出码均为 0，新版 NSIS 标记存在。管理员账户的新程序启动端点响应成功，`C:\Users\WDAGUtilityAccount\AppData\Roaming\jj-music` 生成 35 个文件，安装目录没有 `data`；标准账户目录独立生成 37 个文件，但其非交互式启动未响应端点，不能据此判定 UI 正常。用户随后在沙盒内手动打开新版主界面，确认正常显示，设置页的 App 数据目录为 `C:\Users\WDAGUtilityAccount\AppData\Roaming\jj-music`。

修正版按用户升级复测 `upgrade.json`：同一候选 Setup 退出码 0；旧版安装目录 35 个资料文件与迁移后 AppData 中的 35 个文件逐项哈希一致，哨兵文件保留，NSIS 标记存在。新版启动端点响应成功，启动后未在安装目录新建 `data`。用户在沙盒内手动打开新版，确认主界面正常、设置页 App 数据目录为 `C:\Users\WDAGUtilityAccount\AppData\Roaming\jj-music`，原有内容可见。

修正版自选外部目录复测 `external.json`：安装器退出码 0，旧指针与新指针 SHA-256 一致，外部哨兵文件哈希不变，安装目录旧资料留有独立备份，NSIS 标记存在；新版启动端点响应成功，启动后没有在安装目录新建 `data`。设置页路径的人工核对待完成。

此前候选 Setup SHA-256 为 `66061C7CBC933C3253EE623C2DBCC0024C568A042C14A025C96ADFD901F29D1E`。该包在 Windows Sandbox 的 `upgrade.json` 曾通过 35 文件哈希迁移及新版启动；`allusers.json` 在无共享旧资料时安装成功；`external.json` 通过外部指针和备份检查；`conflict.json` 在冲突时退出 40。其标准账户提权路径后来发现资料丢失，**这些成功记录不能作为最终候选的验收依据**。

内容样本 `content.json` 使用官方 0.2.0 安装后准备了设置、歌单、本地 WAV 曲库记录和禁用音源，再由最新候选升级。39 个文件迁移前后哈希一致，新版应用的 `window.jj` 桥接读回 `theme=light`、`volume=0.37`、包含一首歌的 `U0 Fixture Playlist`、`U0 Fixture Track` 曲库记录和禁用的 `U0 Fixture Source`；数据目录为当前账户的 `%APPDATA%\jj-music`。该探针先在已打包 EXE 上验证过 CDP 通道，避免再次将错误弹窗算作启动成功。

全机旧资料恢复样本 `recovery.json` 使用同一候选包：真实 0.2.0 全机安装在 `C:\Program Files\JJ Music\data` 写入 36 个文件；首次新版安装退出码 42，旧 EXE 与旧资料保留、未写入新版标记。验收脚本在明确当前 WDAG 账户是样本资料所有者后，先将全部文件复制到独立备份并逐文件校验，再复制到该账户的 `%APPDATA%\jj-music` 并校验，把已备份的旧目录移出安装路径后重试。第二次安装退出码 0，标记存在，备份与账户目录哈希仍一致；新版界面桥接读回该账户目录及样本设置 `theme=light`、`volume=0.37`。真实多用户机器仍须先人工确定资料属于哪个账户，不能自动套用该样本的账户归属。

标准账户发起安装的非交互探针 `standard-installer.json`：用 `Start-Process -Credential` 启动全机 Setup 后，90 秒内没有安装日志或 UAC 提示，进程超时；旧 EXE、旧目录与哨兵哈希保留，NSIS 标记未写入。这一探针没有覆盖真正的交互式提权路径。

## 2026-09-28 标准账户提权失败与修复候选

最终候选 `4E35B04C18EECA5B74BB1DB03A5B8FCD6623E8EA5B8DF2B0852BF339702790FF` 的独立沙盒结果：

| 场景与证据文件 | 关键结果 |
| --- | --- |
| 标准账户发起且全机旧资料存在：`standard-interactive.json`、`standard-postmortem.json` | 退出 42；旧程序、共享资料、哨兵哈希保留；无新版标记 |
| 管理员直接运行：`direct-admin.json` | 退出 42；哨兵哈希前后一致，旧程序保留 |
| 全机安装且无共享旧资料：`allusers.json` | 退出 0；管理员与标准账户的应用启动端点响应，资料目录隔离 |
| 按用户自选可写目录：`content.json` | 退出 0；39 文件哈希一致；设置、歌单、曲库、音源由 UI 桥接读回 |
| 全机共享资料人工恢复：`recovery.json` | 先退出 42；独立备份和目标目录校验后重试退出 0，内容读回 |
| 已迁移至外部目录：`external.json` | 退出 0；指针、外部文件不变，残留资料有独立备份 |
| 目标资料冲突：`conflict.json` | 退出 40；旧程序、旧资料与目标文件保留 |

在隔离沙盒中，由 `U0Standard` 发起真实 0.2.0 全机安装的升级，再选择 `U0Admin` 运行候选 Setup `66061C7CBC933C3253EE623C2DBCC0024C568A042C14A025C96ADFD901F29D1E`。`standard-interactive.json` 记录 Setup 退出码 0、新版标记出现，但旧安装目录的 `data` 和测试哨兵消失；`standard-postmortem.json` 检查 WDAG、标准账户、管理员账户的 AppData 以及 ProgramData，均未找到哨兵。**该候选存在真实资料丢失，不能发布。**

原因定位到 electron-builder 26.15.3 的 NSIS 模板：`installSection.nsh` 在 UAC 内部实例跳过 `CHECK_APP_RUNNING`，使放在 `customCheckAppRunning` 中的卸载前迁移检查未执行，随后调用旧卸载器删除共享目录。修复候选在 `customInit` 增加注册全机安装目录检查；此钩子在内外实例的 `.onInit` 均执行。检测到共享旧资料时调用迁移脚本的全机模式，以退出码 42 在卸载前拒绝。初始化阶段只检查，不复制正在使用的文件；正常按用户迁移仍在停用旧进程后的安装节执行。

修复候选 Setup SHA-256 为 `4E35B04C18EECA5B74BB1DB03A5B8FCD6623E8EA5B8DF2B0852BF339702790FF`，`npm run dist` 和 `npm run verify`（38/38 套件）通过。新沙盒的 `standard-installer.json` 记录官方旧包哈希匹配、安装退出码 0、共享资料哨兵建立；`standard-interactive.json` 记录 `U0Standard` 发起同一修复包，退出码 42，旧 EXE、共享目录及哨兵仍在，未出现新版标记。`standard-postmortem.json` 中 U0Standard 的初始化日志记录注册旧目录、全机模式及退出码 42；哨兵 SHA-256 与升级前一致。拦截在标准用户外层实例的 `.onInit` 发生，早于提权，所以没有出现“Run as”窗口。随后在同一沙盒以 WDAG 管理员账户直接运行修复包，`direct-admin.json` 再次记录退出码 42、旧 EXE 和共享资料保留、哨兵 SHA-256 前后一致、标记不存在。

另一个全新沙盒的 `allusers.json` 记录官方旧版全机安装但未运行旧应用时，无共享 `data`；修复包退出码 0，标记出现，管理员与 `U0Standard` 的应用启动端点均响应，两人各自 AppData 中有 35 个文件，安装目录仍无 `data`。`content.json` 用同一修复包升级官方 0.2.0 按用户安装：设置、歌单、曲库和音源样本连同其余资料共 39 个文件逐项哈希一致；新版 UI 桥接读回 `theme=light`、`volume=0.37`、包含一首歌的 `U0 Fixture Playlist`、`U0 Fixture Track` 和禁用的 `U0 Fixture Source`，数据位置为当前账户 AppData。

修复包的 `recovery.json` 再次验证全机旧共享资料恢复：36 个旧文件存在时首先退出 42，旧 EXE 和资料保留、新标记不存在；在测试样本的账户归属明确后，将全部文件独立备份、复制到该账户 AppData 并逐文件验证，移走已备份旧目录后重试安装退出 0。新版标记存在，备份与目标仍通过验证，UI 桥接读回 `theme=light`、`volume=0.37` 和 AppData 路径。对真实多账户机器仍须人工确认所有者，不能自动套用测试账户。

修复包的 `external.json` 验证已迁移至自选外部数据目录的旧版：安装退出码 0，旧指针与新指针 SHA-256 一致，外部文件前后不变，旧安装目录残留资料有独立备份，新版启动端点响应且启动后仍未创建安装目录 `data`。同一包的 `conflict.json` 验证迁移目标已含不同资料时退出码 40，旧 EXE、旧哨兵和冲突目标哈希保留，未写入新版标记。

验收核对命令按候选 SHA-256 与 2026-09-28 的时间戳核对上述 7 组沙盒记录，全部满足预期。另加全机安装目录仅存在 `data-location.json` 时退出 42 的本地用例；最终 `npm run verify` 为 38/38 套件通过，`git diff --check` 通过。当前 ZIP 与 `win-unpacked` 均不含 NSIS 安装标记。

早期候选的人工启动曾发现 `electron-updater` CommonJS 具名导入导致主进程报错；进程存活探针因此出现假阳性。导入已改为默认导入后解构，后续沙盒探针要求启动调试端点响应，内容样本还通过 UI 桥接读回实际资料。此历史故障不再作为当前候选的待办。U4 仍须以两个连续版本验证更新、退出与安装流程；不得在日常 Windows 环境运行会卸载旧版的测试。U5 为后续阶段。

历史状态记录（截至 2026-09-28，发布前）：交付保存在 `feat/online-update` 分支的独立工作树。U1–U3 的签名发布草稿流程、更新服务、受限 IPC 与界面已实现并通过本地验证；不带发行配置的默认构建不嵌入公钥，因此更新服务保持“不可用”，不会触发检查、下载或安装。真实按用户安装已确认 NSIS 写入 `nsis-install.marker`；ZIP 不包含该标记。当时 U0 已通过隔离环境矩阵，U4 尚未执行，也没有创建或公开 GitHub Release。

2026-09-26 后续开发验证：`npm run verify` 为 37/37 套件通过；`npm run dist` 生成 NSIS、ZIP、`latest.yml` 和固定仓库 `app-update.yml`；`node tools/probe/smoke-update-release.mjs release 0.2.0` 使用一次性测试密钥对真实打包产物签名、验签、核对六项资产后删除测试签名文件。打包生成的 `out/main/index.js` 显示公钥为空且 `available` 条件包含 `false`；`release/win-unpacked/resources/nsis-install.marker` 不存在。这些结果仅证明默认发行包的更新入口关闭，不证明 U0 或 U4 的安装安全。

## 2026-09-29 v0.3.1 发布候选 U0 复验

本轮真实旧版 Setup SHA-256 为 `0BD693A17390003757025645D2B121780A73A9FC985C49276D3CA78C7C6EF7C1`；所有场景的新候选 Setup SHA-256 均为 `793B8432194DDC019E45BE7057A75937B9104F1E292923BA78DD04A047A4D692`。沙盒输出位于执行工作树 `D:\Workspace\Codex\JJ Music\JJ-Music-online-update\.cache\u0-sandbox\v031-output-793B8432-run1\`，此目录是临时证据，不属于发行物。

| 场景与证据 | 验收结果 |
| --- | --- |
| 全机安装，旧版仅留下空 `data`：`allusers-empty-data\allusers.json` | 官方 0.2.0 与新候选安装退出码均为 0；确认旧 `data` 存在但条目数为 0。新安装后旧目录清理，NSIS 标记存在；管理员及标准账户分别在自己的 Roaming `jj-music` 目录生成 35 个资料文件，ProgramData 和安装目录均未承载用户资料。 |
| 按用户安装并迁移内容：`content\content.json`、`content\content-ui.json` | 旧资料共 39 个文件，迁移前后逐文件哈希一致；应用桥接探针读回当前账户 Roaming 目录、`light` 主题、音量 `0.37`、一首曲目的 `U0 Fixture Playlist`、`U0 Fixture Track` 曲库记录和禁用的 `U0 Fixture Source`。 |
| 全机共享资料拒绝、备份、恢复与重试：`recovery\recovery.json` | 首次安装退出码 42，旧 EXE 与旧目录保留，未写新版标记。确认样本账户后，36 个旧文件的独立备份与账户目标逐文件校验通过；旧目录移出安装路径后重试退出码 0，备份和目标再次校验通过，应用读取到该账户 Roaming 目录及原设置。 |
| 外部数据目录指针：`external\external.json` | 安装退出码 0；新指针与旧指针匹配，外部资料哈希保持一致，旧安装目录残留存在独立备份。新版启动成功，启动后没有重新创建安装目录 `data`，外部资料仍通过校验。 |
| 目标资料冲突：`conflict\conflict.json` | 安装退出码 40；旧 EXE、旧资料哨兵和已有冲突目标均保留，目标前后哈希一致，未写入新版 NSIS 标记。 |

上述五项均使用同一 SHA-256 的 v0.3.1 本地候选和真实官方 0.2.0 Setup。候选构建通过 `npm run verify`（38/38 套件）、`npm run dist` 与 `tools/probe/smoke-update-release.mjs` 的一次性密钥签名/验签及资产检查；临时签名文件已由探针清除。本地测试密钥与签名结果不用于发布。此矩阵验证安装器的数据迁移与失败保护；U4 的在线自动更新仍须在后续用两个连续公开版本独立验收。
