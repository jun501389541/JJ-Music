# OR8 官方安装版应用内更新验收

2026-10-23最新结果：[CI39916946344](https://github.com/jun501389541/JJ-Music/actions/runs/39916946344)已通过官方0.4.2→0.4.6实际检查/下载/安装→自动重启，16项检查全部通过，合成资料位置、主题、音量、歌单、待写入歌词与哨兵保持。实际下载Setup摘要固定为`26d9761b4f04fa501bbc17e6f0d3652f0f791cb56d67e039b754af41204c7196`；详细证据见[最终交付](../2026-10-23-reliability-final-delivery.md)。以下0.4.5过程为历史记录，未被改写成新版本结果。

此探针只在一次性的 GitHub 托管 Windows runner 执行：安装公开官方 0.4.2，再由实际旧版窗口的 `window.jj.updates.check()` → `download()` → `install()` 完成公开 0.4.5 更新，观察安装器与自动重启，并通过重启后的生产 API 核对合成资料。它不重新构建应用，不设置签名密钥，不替换下载源，也不修改生产 U0 开关、公钥或任何更新行为。

## 执行与输入

手动运行 `.github/workflows/or8-updater-acceptance.yml`。工作流只有 `contents: read`，使用固定提交的官方 checkout/setup-node/upload-artifact action、Node 24 和 `windows-latest`，整个作业上限 20 分钟。无需 npm 安装、发布密钥或额外个人凭据。

- 基线：官方 `v0.4.2/JJ-Music-0.4.2-Setup-x64.exe`，SHA256 `7f0af318dff6730fca60399baffbd1745ebc82647435aad26ba07e66ab0d4f57`。
- 更新目标：应用正常检查公开官方 Release；必须恰好提供 0.4.5，否则验收失败。应用实际下载的 Setup 还须匹配 SHA256 `709387aef5fbc0fee15de5a2e24f0824d6e5b7f0ed678e13b8d9a672351cbe2c`。
- 如果未来最新版本变化，必须显式复核并更新验收目标和摘要；探针不会静默接受其他版本。

## 隔离和过程

PowerShell 与 Node 两个入口均在写文件、下载或创建进程之前拒绝非 GitHub 托管 Windows 环境。PowerShell 还拒绝已有 JJ Music 进程、默认用户资料、资料位置指针、已知安装/更新缓存目录和 HKCU/HKLM 安装登记。拒绝后不会停止已有进程。实际执行仅限新建的 `RUNNER_TEMP/or8-updater-<GUID>` 与已确认原先不存在的 runner 默认资料目录。安装目录和 TEMP/LOCALAPPDATA 更新缓存位于拥有标记的临时根下；无递归删除或广泛终止进程。

官方基线通过实际 NSIS 以当前用户方式静默装入拥有的目录；验证版本及 NSIS 标记后，仅新建合成设置、待写入歌词和哨兵文件。启动时不传 `--user-data-dir`，让实际重启也采用相同的默认资料位置；生产数据位置 API 必须核对到该位置。仅显式启用 `JJ_ALLOW_DEBUG_PORT=1` 与随机回环端口 `JJ_DEBUG_PORT`，清除 `ELECTRON_RUN_AS_NODE` 和 `NODE_OPTIONS`。不加载真实音源、不试听音乐。

NSIS的`StartApp`通过Windows Shell启动新版，可能不继承旧应用的进程环境。为观察这次实际重启，探针现同时临时设置一次性runner账户的上述两个User环境变量并广播Environment；预先拒绝已有值，finally删除并再次广播，整个runner随后销毁。端口由supervisor在回环地址临时分配，写入自有根，Node验证后使用；没有修改开发电脑环境、应用调试门禁或公开包，也不会手动启动新版。最终记录仅匹配本次安装exe路径的实际进程与版本。

Node 使用旧版实际预加载桥读取状态、创建合成歌单，然后调用检查、下载与安装。下载完成须由生产服务进入 `ready`，并在拥有的更新缓存中找到唯一匹配固定官方摘要的安装器，之后才发出安装请求。

生产 `quitAndInstall(false, true)` 可能显示 NSIS 界面。PowerShell 仅枚举可执行文件路径等于探针下载缓存请求、且文件摘要仍等于目标摘要的安装器进程窗口。只对这些窗口的可见、启用 Next/Install/Finish 按钮发送原生 BM_CLICK，并记录控件文本。不会向桌面发送键盘输入，不会操作其他窗口；未知界面、权限提示或不同进程形态将超时失败，保留已有证据。

旧应用必须退出；探针不手动启动新版，不直接运行目标安装器。只有安装器自动重启的窗口开放预先分配的独立重启 CDP 端口且生产状态报告 0.4.5，才进入资料连续性核对：相同默认资料路径、主题/音量、合成歌单 ID 和名称、待写入歌词、无音源及原哨兵内容。最后检查安装目录实际文件版本仍为 0.4.5。

## 证据和边界

CI artifact `or8-official-updater-<run_id>` 保留 14 天，包含：

- `supervisor-report.json`：基线输入摘要、NSIS 安装、允许操作的安装器路径、窗口控件及按钮操作、最终安装版本和失败原因。
- `updater-report.json`：每个实际 API 返回值、旧进程退出、下载缓存文件名/大小/摘要、重启状态和合成资料检查。
- `application.log`、探针 stdout/stderr 及可用的 U0 迁移日志。
- 旧版已安装、待安装、重启后三个阶段可用的 PNG；提前失败时只保留已到达阶段。

若发布的旧版状态为 `unavailable`，报告明确指出基线更新能力被阻止；不会为通过验收改 U0、公钥或已发布文件。检查/下载/安装任一异常会记录实际失败阶段和可取得的更新状态、缓存摘要。未达到重启和资料核对的失败不能记作应用内升级通过。

本地仅运行 PowerShell 语法解析、Node 语法检查和两个入口的日常主机拒绝检查；没有在开发者主机安装或启动此安装验收。实际成功与否以对应 CI run/artifact 为准，此文档不预先声称已经通过。此验收覆盖当前用户模式的合成资料，不证明真实用户完整资料、其他用户、全机模式、提权路径或所有网络条件。

## 实际执行记录

首轮 [39609669614](https://github.com/jun501389541/JJ-Music/actions/runs/39609669614) 已安装摘要匹配的官方0.4.2并预置合成资料；启动Node控制器前失败，原因是runner上Get-Command返回多个Node路径，Start-Process需要单一路径。尚未调用应用内更新API，不算产品更新失败或通过。报告artifact12348743441，SHA256 `6a200124d08a02d446976b38d093114fd48904fbc6ffb4b40275e0a3f671d9fc` 已核对并读取。

探针已明确选择PATH顺序中的第一个Node，并核验单一现存文件。两个命令结果的受控fixture复现旧Object[]，修复后String；实际命令和PowerShell解析通过。重跑结果另记。

第二轮 [39610138791](https://github.com/jun501389541/JJ-Music/actions/runs/39610138791)：实际旧版check返回available0.4.5，download进入ready并核对官方Setup完整SHA256，生产install调用使旧进程退出0。随后NSIS安装范围选择页被探针直接Next，安装器报“旧版安装目录与新目录不同；请先保持原安装目录完成资料迁移”，未能重启新版。9项前置检查通过，但完整升级失败。artifact12350875137，SHA256 `4332031a440f850ea114ee418af1222626caa136bf537461e267c6d69a89bd83` 已读取。不能把此结果记为更新链路通过。

探针现对严格路径/摘要限定的同一个NSIS窗口先点击与baseline相同的“Only for me”单选项，并通过BM_GETCHECK确认选中，再前进；目录保护保持不变。另补失败后的child.unref，报告落盘后释放控制器句柄，保留应用供runner取证，不终止任何无关进程。两处经独立复核、语法/选择器和零安装句柄回归验证，真实重跑另记。

继续只读核对固定依赖的 `app-builder-lib/templates/nsis/assistedInstaller.nsh`，确认交互安装的instFilesPre会在路径不含APP_FILENAME时追加应用子目录；`--updated`跳过目录页但不跳过该处理。静默`/D=.../Installed`基线没有经过交互目录规范化，与普通安装目录不同。验收基线现明确使用自有`Installed/JJ Music`，Node启动路径同步，使测试覆盖正常命名的旧安装目录；没有设置updater.installDirectory、追加目标安装器参数或修改公开Setup。非标准静默目录的保护拒绝仍作为边界保留。

第三轮 [39612630667](https://github.com/jun501389541/JJ-Music/actions/runs/39612630667) 确认“Only for me”点击前后均为选中，但旧基线仍在`Installed`，同样在目录保护处拒绝，9项前置通过、重启未通过。artifact12350972184，SHA256 `0005d43c8b02606202835a3168b24c4b681324713232aff6fbb9a52de33032c9` 已下载核对并读取；此结果支持继续修正基线目录，不能记为完整升级通过。

第四轮 [39614397601](https://github.com/jun501389541/JJ-Music/actions/runs/39614397601) 使用正常命名目录，安装器明确显示Installation Complete并由探针点击Finish，未再触发目录保护；控制器仍在等待重启CDP处失败，不能据安装成功认定新版资料核验通过。artifact12352491172，SHA256 `96cc0a1c16c0fd25326cc840ec5687df772849c6b47cdd17659b3b2e94d049fe` 已核对读取。基于固定NSIS源码的Shell启动路径补充上述临时账户调试观测；这是一项待重跑验证的原因判断。

第五轮 [39616546568](https://github.com/jun501389541/JJ-Music/actions/runs/39616546568) 仍在连接重启CDP处失败，但严格安装路径的进程快照确认0.4.5.0主进程带`--updated`自动启动，renderer采用原默认资料目录且携带预期调试端口。因此实际安装/进程重启已有证据，生产API资料核验仍未完成。artifact12353266356，SHA256 `7b8aeeb1c14df6019aab6d849073a8fa7008cd73e135d9fcab7e41fcbf038ba1` 已读取；不能再把缺少CDP笼统归为“未启动”。连接诊断现保留有界HTTP目标/错误变化及最终监听进程，以定位剩余观测问题。

第六轮 [39618073821](https://github.com/jun501389541/JJ-Music/actions/runs/39618073821) 确认旧版CDP可用，新版进程及renderer已运行，但同一个端口持续ECONNREFUSED，最终无监听；并非HTTP目标过滤导致。artifact12353922536，SHA256 `c408086e40c1054f75628ece0cff75503e6152dac85acaf5ab3120c6cd16a893` 已核对读取。为避免Windows旧TCP端口重绑定影响，探针为旧版进程与Shell启动的新版分配两个不同端口：旧版仅用显式child环境，新版仅用临时User环境；不能把这项修正预先记作通过。

第七轮 [39619505135](https://github.com/jun501389541/JJ-Music/actions/runs/39619505135) **完整通过**，运行提交e031be954be813b7f6ea190a7cb6393e2f471e35。artifact12353273379，SHA256 `9320fda708c25a5caa011dc2b0a7a15a10a4b7b789596fe1f62c96f96c5e92b7` 已下载核对并读取；重启截图已查看，显示0.4.5、浅色主题、音量37及三个歌单。

实际控制器UTC14:45:12.343至14:45:29.317，16项断言通过：官方旧版版本与合成资料读取，真实检查0.4.5、生产下载ready及公开Setup完整摘要，生产安装请求后旧进程退出，安装器自动重启的新版实际API报告0.4.5，原资料位置、主题/音量、创建的歌单ID/名称、待写入歌词、无音源及媒体哨兵均保持。旧CDP56335、新CDP56334，实际新版文件页面可用；未手动启动新版。supervisor核对安装版本0.4.5.0并通过，应用关闭后自有安装路径进程与调试监听均为空。

该结果覆盖正常命名目录下的当前用户官方安装版应用内更新与合成资料连续性；不扩展到全用户、其他账户、任意自定义静默目录、真实用户完整资料或听感。前六轮失败继续保留，不以成功覆盖历史边界。
