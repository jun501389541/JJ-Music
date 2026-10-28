# Windows source launcher

已接入 Windows 宿主默认路径及开发/测试/打包构建。Windows 10+ x64，MSVC C++17、Windows SDK；静态 CRT、GUI 子系统、asInvoker。用户不需要安装编译工具。

在仓库根目录执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools/test-source-launcher-argv.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File tools/build-source-launcher.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File tools/build-source-launcher.ps1 -TestBarrier
node tools/build-test.mjs
node tools/probe/windowless-source-launch.mjs --startup-race --legacy-baseline
```

正常产物：`build/native/x64/source-launcher.exe` 与 `manifest.json`，均忽略入库。`-TestBarrier` 独立输出到 `.cache/windowless-race`；仅此测试构建包含暂停屏障，正式产物不接受测试屏障环境变量。哈希清单用于一致性，不代表签名；本轮产物未签名。

helper 输入为设计规定的八个命名参数，stdout 仅 schema 1 JSON；宿主不继承任何 helper 句柄。`ELECTRON_RUN_AS_NODE=1`，内存参数由调用方传入，工作目录为宿主目录。错误只报告安全阶段和数值码，不报告原始路径或环境。

SAFER NORMALUSER 后确认关机特权不存在；如仍存在，用 CreateRestrictedToken 删除并复查。创建时通过 `PROC_THREAD_ATTRIBUTE_JOB_LIST` 原子纳入私有 kill-on-close Job，在暂停态检查子令牌后恢复。持有所属创建进程的真实句柄，owner/helper/host 退出均回收 Job。正常回收等待宿主及 Job 活跃进程归零。创建/属性/API 失败时直接失败，不回退。

探针仅使用自行生成的本地合成宿主，不读取已安装音源、不访问远程接口。`--legacy-baseline` 会显式运行旧生产启动器，可能短暂创建旧控制台，用 ASCII 路径比较权限；新路径另用中文、空格、`&`、括号测试。权限比较仅覆盖当前会话的特权名称集合和组输出哈希，不是完整令牌等价证明。

原生 API/受限进程可能无法在 Windows Codex 沙箱内访问必要路径；本轮在获准的外部会话完成探针。不得因此放宽产品权限或改为普通令牌。

参考：[创建属性 Job 列表](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute)、[微软对暂停创建后再入 Job 的竞争说明](https://devblogs.microsoft.com/oldnewthing/20230209-00/?p=107812)。

WL2 状态/ready/取消已接入；开发、测试和打包会构建 helper，包检查验证外置资源的架构、协议清单和摘要。仍需完成 WL0 原窗口归属与两类默认终端基线、安装升级验收、WL4 窗口监测与人工观察。不要把 PE GUI 和 GetConsoleWindow 为空解释为已完成所有无闪窗验收。

主进程 stdin 管道只向 helper 写一个 `S` 停止字节；helper 非阻塞轮询该管道，回收 Job 并等待活跃进程归零后以 0 退出。主进程只将此正常退出视作确认回收；12 秒后强杀兜底、异常退出或 15 秒仍不退出均为回收未确认，scratch 保留。该管道不传递音源请求，也不继承给宿主。

自动窗口事件证据：编译参数测试夹具后运行 `node tools/probe/windowless-window-events.mjs`。观察器 ready 后才启动合成链路；用 600ms 非激活窗口校准 SHOW 事件。`--inject-window` 和 `--inject-fast-window` 是预期失败的负控制。无法解析 HWND 或祖先进程、快照失败、溢出均不得记为通过；详细证据和限制见 `docs/development/2026-10-28-windowless-source-launcher/WL4.md`。

旧链路只保留在显式 `--legacy-baseline` 使用的历史探针夹具中；产品不导入它。该比较是当前合成配置下的历史链路复测。

嵌套 Job 合成验证：先编译参数测试夹具，再运行 `node tools/probe/windowless-nested-job.mjs`。覆盖兼容外层 Job 中的正常停止和 owner 退出；成功检查发生在外层 Job 关闭之前。`--inject-no-stop` 是预期非零的负控制。此夹具不进入产品包，不代表任意第三方 Job 限制均已验证；证据见 `docs/development/2026-10-28-windowless-source-launcher/nested-job.md`。

同一探针还覆盖外层 Job 三进程上限导致的真实宿主创建失败，检查仅产生 `createProcess` 错误且未执行宿主。全部场景在关闭外层 Job 前确认活跃进程归零；`--inject-no-limit` 为撤掉上限的预期失败负控制。

路径边界探针：`node tools/probe/windowless-paths.mjs`。短路径必须成功，长路径若拒绝则检查安全错误并在报告标记 `supported:false`；当前普通及扩展格式约338/1058字符路径均被拒绝，不能据探针退出0宣称支持长路径。`--inject-stderr-path` 是预期非零的泄露负控制，详情见 `docs/development/2026-10-28-windowless-source-launcher/path-boundary.md`。
