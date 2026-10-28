# WL1 原生启动验证记录

日期：2026-10-28。范围：独立 helper、构建与合成探针；未替换生产 runas 链路。

此处为 WL1 阶段记录；后续已完成宿主与构建接入，见 [WL2 记录](WL2.md)。

## 环境与命令

VS 2026 Build Tools 18.9.2、MSVC 14.51.36231，x64，C++17，`/MT /O2 /W4 /WX`。普通产物为 GUI 子系统、asInvoker、未签名。

命令见 [原生 README](../../../native/source-launcher/README.md)。构建和探针均实际执行；原生探针在沙箱中先返回路径访问拒绝（5），在获准的外部会话执行。

## 已验证

- 参数转义单测编译通过；新启动链路中文/空格/括号/`&` 路径原值到达宿主。512 MiB 参数、ELECTRON_RUN_AS_NODE、宿主工作目录保持。
- PE 为 x64 GUI；通过控制台子系统的合成宿主实际查询 GetConsoleWindow，结果为空。
- 宿主 token 的 SeShutdownPrivilege 不存在。旧 runas 与新 helper 的特权名称集合、组输出摘要一致；不输出用户名或 SID 原文。
- helper 结束回收宿主及后代；owner 结束回收整树；宿主正常退出报告真实退出码 23，并回收存活后代。
- 重复/未知参数、非法数值、错误 owner、scratch 外脚本、相对路径均拒绝。安全 launchId 在参数错误时保留。

旧链路首次使用中文路径未生成报告；改用 ASCII 夹具后权限对比通过。该现象提示旧链路路径兼容性有限，未单独定位编码根因。

## 审查及修复

独立只读审查发现暂停创建至 AssignProcessToJobObject 之间可能残留暂停宿主。增加仅测试构建的创建返回屏障，helper 在屏障处被杀的测试先失败（8秒后仍存活，随后清理合成PID），再改为 PROC_THREAD_ATTRIBUTE_JOB_LIST 原子入 Job，同一测试通过。正式产物不包含测试屏障。

错误参数丢失 launchId 也经失败断言复现后修复。原生完整探针包含权限/回收/错误/控制台/创建竞争测试，不冒充 Electron 真实音源验收。

## 未完成门槛

WL0 未完成原截图窗口归属、Terminal/Console Host 对比。当前会话权限比较不代表所有普通账户/安全策略和嵌套 Job 环境均可用。WL2–WL4 尚未实施，生产路径未切换；状态乱序、ready/取消、断管、完整包与人工无闪窗仍待验。无真实音源、安装升级或听感测试。

## 离线回归

`npm test` 实际通过既有 `tools/build-test.mjs` 和 runner 执行。沙箱轮为 76/123，临时目录 rename 等出现大量 EPERM，失败原始日志为 `.cache/windowless-native-offline-tests.log`。同一命令在获准外部会话重跑为 **123/123 suites passed**，退出码 0；日志为 `.cache/windowless-native-offline-tests-unsandboxed.log`。未修改生产 TypeScript，也未运行安装、真实脚本、网络接口或人工听感检查。

GraphFlow 增量索引首次返回 Transport closed；重试后成功（indexedFiles=5，indexedSymbols=74）。
