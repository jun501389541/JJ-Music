# OR8 官方安装版应用内更新验收

此探针只在一次性的 GitHub 托管 Windows runner 执行：安装公开官方 0.4.2，再由实际旧版窗口的 `window.jj.updates.check()` → `download()` → `install()` 完成公开 0.4.5 更新，观察安装器与自动重启，并通过重启后的生产 API 核对合成资料。它不重新构建应用，不设置签名密钥，不替换下载源，也不修改生产 U0 开关、公钥或任何更新行为。

## 执行与输入

手动运行 `.github/workflows/or8-updater-acceptance.yml`。工作流只有 `contents: read`，使用固定提交的官方 checkout/setup-node/upload-artifact action、Node 24 和 `windows-latest`，整个作业上限 20 分钟。无需 npm 安装、发布密钥或额外个人凭据。

- 基线：官方 `v0.4.2/JJ-Music-0.4.2-Setup-x64.exe`，SHA256 `7f0af318dff6730fca60399baffbd1745ebc82647435aad26ba07e66ab0d4f57`。
- 更新目标：应用正常检查公开官方 Release；必须恰好提供 0.4.5，否则验收失败。应用实际下载的 Setup 还须匹配 SHA256 `709387aef5fbc0fee15de5a2e24f0824d6e5b7f0ed678e13b8d9a672351cbe2c`。
- 如果未来最新版本变化，必须显式复核并更新验收目标和摘要；探针不会静默接受其他版本。

## 隔离和过程

PowerShell 与 Node 两个入口均在写文件、下载或创建进程之前拒绝非 GitHub 托管 Windows 环境。PowerShell 还拒绝已有 JJ Music 进程、默认用户资料、资料位置指针、已知安装/更新缓存目录和 HKCU/HKLM 安装登记。拒绝后不会停止已有进程。实际执行仅限新建的 `RUNNER_TEMP/or8-updater-<GUID>` 与已确认原先不存在的 runner 默认资料目录。安装目录和 TEMP/LOCALAPPDATA 更新缓存位于拥有标记的临时根下；无递归删除或广泛终止进程。

官方基线通过实际 NSIS 以当前用户方式静默装入拥有的目录；验证版本及 NSIS 标记后，仅新建合成设置、待写入歌词和哨兵文件。启动时不传 `--user-data-dir`，让实际重启也采用相同的默认资料位置；生产数据位置 API 必须核对到该位置。仅显式启用 `JJ_ALLOW_DEBUG_PORT=1` 与随机回环端口 `JJ_DEBUG_PORT`，清除 `ELECTRON_RUN_AS_NODE` 和 `NODE_OPTIONS`。不加载真实音源、不试听音乐。

Node 使用旧版实际预加载桥读取状态、创建合成歌单，然后调用检查、下载与安装。下载完成须由生产服务进入 `ready`，并在拥有的更新缓存中找到唯一匹配固定官方摘要的安装器，之后才发出安装请求。

生产 `quitAndInstall(false, true)` 可能显示 NSIS 界面。PowerShell 仅枚举可执行文件路径等于探针下载缓存请求、且文件摘要仍等于目标摘要的安装器进程窗口。只对这些窗口的可见、启用 Next/Install/Finish 按钮发送原生 BM_CLICK，并记录控件文本。不会向桌面发送键盘输入，不会操作其他窗口；未知界面、权限提示或不同进程形态将超时失败，保留已有证据。

旧应用必须退出；探针不手动启动新版，不直接运行目标安装器。只有安装器自动重启的窗口重新开放原随机 CDP 端口且生产状态报告 0.4.5，才进入资料连续性核对：相同默认资料路径、主题/音量、合成歌单 ID 和名称、待写入歌词、无音源及原哨兵内容。最后检查安装目录实际文件版本仍为 0.4.5。

## 证据和边界

CI artifact `or8-official-updater-<run_id>` 保留 14 天，包含：

- `supervisor-report.json`：基线输入摘要、NSIS 安装、允许操作的安装器路径、窗口控件及按钮操作、最终安装版本和失败原因。
- `updater-report.json`：每个实际 API 返回值、旧进程退出、下载缓存文件名/大小/摘要、重启状态和合成资料检查。
- `application.log`、探针 stdout/stderr 及可用的 U0 迁移日志。
- 旧版已安装、待安装、重启后三个阶段可用的 PNG；提前失败时只保留已到达阶段。

若发布的旧版状态为 `unavailable`，报告明确指出基线更新能力被阻止；不会为通过验收改 U0、公钥或已发布文件。检查/下载/安装任一异常会记录实际失败阶段和可取得的更新状态、缓存摘要。未达到重启和资料核对的失败不能记作应用内升级通过。

本地仅运行 PowerShell 语法解析、Node 语法检查和两个入口的日常主机拒绝检查；没有在开发者主机安装或启动此安装验收。实际成功与否以对应 CI run/artifact 为准，此文档不预先声称已经通过。此验收覆盖当前用户模式的合成资料，不证明真实用户完整资料、其他用户、全机模式、提权路径或所有网络条件。
