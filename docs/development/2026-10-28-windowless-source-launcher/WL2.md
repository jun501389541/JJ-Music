# WL2 宿主接入与构建资源记录

日期：2026-10-28。用户要求继续执行开发；未提交、推送、发布或安装。

## 当前实现

- Windows 默认直接启动原生 GUI helper，产品不再包含 runas/CMD/VBS 回退。旧链路仅存在于显式历史比较探针夹具。
- `LauncherStatusDecoder` 限制单行 8 KiB、总输出 64 KiB（含 stderr），验证 schema、代次、PID、状态顺序。原始 helper message/stderr 不进入产品错误；只展示安全阶段和数值码。
- 只有当前 `spawned` 和 ready 都有效才初始化成功；双方先后顺序均可。宿主退出、helper 提前关闭、非法状态及断管立即失败；迟到 ready 不得复活。原生启动时间计入原有 15 秒初始化预算。
- 取消和回收结清 init timer、pending 请求、文件轮询；stdin 只发送一个 `S` 控制 helper。helper 收到后终止 Job、等待宿主和全部 Job 活跃进程归零，再以 0 退出。
- 只将 helper 正常零退出认作确认回收。12 秒后强杀兜底、异常退出、或 15 秒仍不退出均报告回收未确认，scratch 保留。心跳 PID 仅供观测，不能用于 taskkill。
- 主进程在可信装配处指定 dev 和 packaged 路径；正式包只使用 `process.resourcesPath/native/source-launcher.exe`。Node 测试/CLI 的默认路径锚定已配置宿主目录，不搜索 CWD/PATH。缺失 helper 明确失败，不启动普通宿主。
- dev、build、生产测试 bundle 和 package 均显式构建原生 helper；extraResources 包含 helper 和 schema/protocol/arch/SHA-256 清单。包检查验证实际外置资源，旧版历史包仍按其原功能检查。

## 验证与修复

遵循现有执行计划和 TDD 技能。状态解析新增 5 项测试；宿主新增 11 项测试，覆盖 ready/spawned 两种顺序、旧代次、干净早退、错误/超限/断管、回收未确认保留目录、helper 缺失不回退、真实原生文件 IPC、取消与伪造心跳旁路影响。stop 新增 2 项测试；包检查新增缺失及摘要错误的回归。

1. 旧实现下 ready 前无 spawned 仍成功等 5 个测试失败，接入后通过。
2. 真实原生文件 IPC 往返成功；正常停用后 helper 退出码为 0、源宿主已退出、scratch 删除；伪造心跳指向旁边的合成 sentinel 不会结束该进程。
3. 初始化中取消会等待回收后拒绝，宿主退出且 scratch 删除；原有 init timer 不再滞留。
4. 原生宿主在 ready 前以 0 退出曾被 SourceEngine 当作用户取消而不拒绝。回归先失败；修复为初始化阶段由 host.start 的 catch 处理失败，避免提前递增代次。现在拒绝并停用源。
5. 缺失 helper 的合成包曾被包检查误报通过，回归先失败；现校验外置 PE x64 GUI、协议/架构与实际摘要，错误包失败，完整包通过。
6. 独立只读审查发现“任意 helper exit 都当作确认回收”可能提前删除 scratch。正常与强杀退出测试先失败，修改 stop 确认条件和超时后通过；回收未确认的目录保留也有回归覆盖。审查未发现其他 Important/Critical；无延期 minor。

原生控制管道不继承给宿主。SAFER、原子 JOB_LIST、子令牌复查及 owner 句柄监视保持。原生完整探针用当前源码重建并通过控制台、Unicode 参数、权限对比、owner/helper/host 退出以及创建返回屏障测试。

## 实际命令与结果

- `npm run verify`：类型检查、生产构建通过，**126/126 suites passed，5/5 gate passed**。日志 `.cache/wl2-verify-final.log`。
- `powershell -NoProfile -ExecutionPolicy Bypass -File tools/build-source-launcher.ps1 -TestBarrier`：当前源码测试构建成功。
- `node tools/probe/windowless-source-launch.mjs --startup-race --legacy-baseline`：全部通过，旧链路比较仅合成 ASCII 夹具。
- `npm run pack`：最终目录包构建成功，日志 `.cache/wl2-pack-final.log`。
- `node tools/probe/verify-package.mjs`：最终包的功能标记、解包宿主及依赖、外置 helper 的 x64 GUI/协议 1/SHA-256 均通过。日志 `.cache/wl2-package-check.log`。
- `node tools/probe/clean-profile-sources.mjs --synthetic`：把包复制到仓库外临时目录，使用空白资料和合成音源；导入/启用成功、识别 5 个平台，受控播放地址解析、320k 音质保持以及真实本地 lx.request 往返通过，未通过项 0。不是逐个平台真实媒体播放或人工听感验证。日志 `.cache/wl2-isolated-sources.log`。
- `git diff --check` 通过；构建与探针 JavaScript 语法检查通过；GraphFlow 增量索引已更新。

构建/集成/完整回归在获准的 Windows 外部会话运行。原 PowerShell Get-FileHash 在嵌套构建环境不可用，改用 .NET SHA256 生成同样的清单，不改变全局设置。

## 验收边界

延续用户的继续开发授权，推进工程接入；不把尚未完成的 WL0 窗口归属/Terminal 与 Console Host 对比记为完成，也不因此宣布原截图问题已最终解决。WL1 当前会话权限与合成回收证据支持继续接入；正式交付仍须补窗口监测/人工观察、安装/便携包和升级矩阵。

未读取实际音源存储或运行用户真实脚本，未运行真实网络媒体/听感验收。SHA-256 清单不等于发布者签名。当前修改保留在工作区。
