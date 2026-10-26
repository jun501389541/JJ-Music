# OR8 媒体请求生命周期补充验证

日期：2026-10-16；基线：`f5c77d255d9a819d0909e1e4a2d94cd3cb98f005`。

## 问题与修复

原实现撤销音源时只删除媒体令牌，已经等待响应头或正在传输的请求仍可继续；令牌因过期或容量被清理后，也无法通过令牌表找到这些连接。协议入口没有传递消费者的取消信号。

本次在 `SourceMediaProxy` 中独立登记活动请求，按 provider 撤销等待头部和已建立的流；头部等待与取消竞争，忽略取消信号的 fetch 若迟到返回，则取消其 body。交付响应前再次检查音源身份和令牌有效性。Electron 协议入口传递 `Request.signal`；流结束、取消、错误和超时均清理活动登记、监听器与计时器。

其他音源请求保持独立。正常长流不会因为令牌到期而中断；到期只限制新请求，源撤销仍能终止已建立的流。保留 Range、大小限制和既有错误分类。等待头部期间消费者取消返回 499，音源撤销返回 410，令牌到期或被清理返回 404，网络失败返回 502。

## 证据

- 首轮受控 RED：5 个新增生命周期用例全部失败，覆盖等待头部、活动 Range 流、令牌清理、消费者取消和音源身份变化。
- 第二轮受控 RED：响应头交付边界新增两个用例失败，分别暴露到期误报为源变更、已取得的 body 在取消竞态下未被释放。
- GREEN：新生命周期与原媒体代理两套测试合计 14/14 通过。新增文件含 7 个用例。
- `npm run verify`：退出码 0；82/82 测试套件通过；准入检查 5 通过、0 失败。
- `node tools/probe/online-reliability.mjs`：退出码 0；隔离资料下的 Electron 合成检查通过，外部 fetch 为零。
- 独立只读复核未发现可复现的 P1/P2；复核还检查了正常 EOF、消费者取消、空闲超时和读取错误路径的活动登记清理。
- `git diff --check` 通过；现有源码改动限于媒体代理和主进程协议接线。

日志保存在本地 `.cache/online-reliability-streams/`：`red.log`、`handoff-red.log`、`handoff-green.log`、`verify.log`、`ui.log`。这些日志不是版本控制交付物。

## 验证边界

生命周期回归使用内存 Response/ReadableStream，无外部网络。初轮 Electron 合成检查只覆盖现有界面和 IPC；随后原生协议补验及修复见下节。

本轮没有重跑真实音源、真实音频解码或听感验收，也没有改动原音源脚本与日常资料。先前 OR8 真实样本的首字节结果仍不能替代完整播放和听感验收。

本轮改动保留在工作区，未新增提交、推送或发布。

## 继续执行：Chromium 原生取消桥接

隔离原生探针复现 Electron **42.11.8** 的行为：等待响应头时，renderer fetch 已报 AbortError，但传给协议处理器的 Request.signal 仍未取消，上游请求仍登记为活动；流建立后可通过 body 取消清理。源撤销在两个阶段均能清理。

Chromium webRequest 对取消连接会报告准确请求编号。新增 `source-media-protocol.ts` 在 onBeforeSendHeaders 覆盖注入内部关联头，关联到一次协议分发；onErrorOccurred 按编号取消，onCompleted/onErrorOccurred 删除关联。关联必须匹配 URL、method，并且只能领取一次。同一 token 的两个 Range 连接分别取消，内部头不会被代理转发到音源上游。协议缺少有效关联时返回 499，不启动上游请求。

这里没有依赖 Electron 原生 Request.signal 恢复工作，而是合并它和 Chromium 事件产生的信号。继续使用默认 session 和既有 jjstream 协议；应用已有 onHeadersReceived 监听器不冲突。未来新增同类 webRequest 监听器时需统一安装，Electron 每类事件只保留最后一个监听器；参见 [Electron webRequest 文档](https://www.electronjs.org/docs/latest/api/web-request)。

验证证据：

- 协议边界受控 RED：两个用例失败，分别为头部取消未及时终止、无关联请求仍启动上游。修复后协议边界 5/5 通过，含同 token Range 隔离、完成后清理、伪造编号覆盖、取消先于分发、重放和不同 token 拒绝；与现有两套媒体测试合计 19/19。
- `node tools/probe/source-media-lifecycle.mjs`：每次先构建生产源码测试包，再启动隐藏 Electron 窗口和独立资料目录。8/8 原生用例通过：响应头取消、流取消、同 token Range 隔离、响应头/流源撤销、HTMLAudioElement 等待头部时移除 src、HEAD、OPTIONS。外部请求为零；每条中止路径取消 body 一次。
- 一次独立只读复核未发现可复现 P1/P2。附加内存检查确认流错误记录的 network 不会被后续 Chromium ERR_FAILED 覆盖为 cancelled。
- 首轮完整检查 82/83：既有 downloads-import 用例在读取 LRC 时偶发 ENOENT；该用例用 completed 状态后固定等待 30ms，而产品代码在音频发布后先标记 completed，再写侧车文件。单独重跑该套件 27/27。本次没有改变下载行为或通过增加固定等待掩盖该边界，完整重跑结果另记。
- 完整串行重跑 `npm run verify`：退出码 0，83/83 套件通过，5 项准入检查通过；上述偶发问题保留为后续事项，重跑通过不代表它已修复。
- 现有 Electron 合成界面检查退出码 0，通过且外部 fetch 为零；差异保护确认 HEAD 仍为基线提交，暂存区为空，已跟踪源码的改动仅限约定的媒体路径与测试构建入口。新增源码、测试、探针和本文档留在工作区。

本地证据：`native-red.log`、`protocol-green.log`、`native-acceptance.log`、`native-acceptance.json`、`native-verify.log`、`download-recheck.log`、`native-verify-recheck.log`、`native-ui.log`，均位于 `.cache/online-reliability-streams/`。

原生探针使用合成字节流，只证明协议取消、流清理和方法兼容；没有证明真实音频完整解码或听感。所有音源脚本与日常资料保持原状；当前改动尚未提交推送。

后续 LRC 读取时序及手动入库竞态的处理见 [下载收尾补充](OR8-download-sidecar.md)，本页保留当时首轮失败和重跑结果。

## 补验：媒体元素接收数据后的取消与报告有效性

2026-10-16 继续对照探针和本地产物，确认原有 `cancel-body` 已覆盖 renderer fetch 收到 3 字节后调用 AbortController：状态为 200 后以 AbortError 结束，上游信号中止，body 取消一次。原有 `audio-element-cancel` 仅覆盖 HTMLAudioElement 等待响应头时移除 src。

新增 `audio-element-body-cancel` 使用内存合成 WAV 的前缀，保留剩余数据不交付。探针同时等待媒体元素的 progress 事件及上游至少两次 pull，断言元素仍处于 NETWORK_LOADING、没有媒体错误且上游尚未中止，再移除 src 并 load。结果确认上游中止、body 只取消一次、活动请求归零。

此用例证明媒体元素已接收数据但读取仍挂起时的取消。该样本实测 readyState 为 0，不能用作元数据加载、音频解码、开始播放或听感通过的证据。

同时修复探针报告的陈旧结果问题：原先 Electron 启动失败时会留下上一次成功的 native-acceptance.json。启动器现在在构建前写入本次 runId 和 starting 状态；主进程写入 running、passed 或 failed，启动器捕获异常时写入同一 runId 的 failed。受限环境启动复现退出码 0x80000003 后，报告已明确记录本次 failed，没有保留旧的通过结果。

最终验证：

- `node tools/probe/source-media-lifecycle.mjs` 在沙箱外运行，退出码 0；Electron 42.11.8 原生用例 9/9，通过产物的 status 为 passed，外部请求为零。新增用例记录 progress、upstreamPulls、readyState、networkState 及一次 body 取消。
- 探针每次先运行 tools/build-test.mjs 构建生产模块；将对应 .mts 套件暂存到 out/test 后，通过 Node 测试运行器执行媒体代理、生命周期和协议边界三套回归：19/19，通过且退出码 0。
- 本轮仅扩展探针与验收记录，没有修改生产代码；沿用此前完整 verify 的历史记录，不将它报告为本轮重跑结果。

最新运行的本地产物仍位于 .cache/online-reliability-streams/native-acceptance.json。真实音源全曲解码、听感、日常 UI、真实更新回退、安装升级验收继续保留其原有状态。

## 2026-10-26：原生探针资料目录清理

检查发现 `source-media-lifecycle.mjs` 每次启动都会在 `.cache/online-reliability-streams` 创建唯一 `native-profile-*` 目录，但进程结束后没有清理，成功和失败运行都会累积测试资料。新增 `withDisposableProfile`，无论 Electron 探针成功还是抛错都删除本次创建的目录；启动超时现在先终止并等待子进程关闭，再进入清理，避免与仍运行的 Chromium 争用资料文件。

`source-media-probe-profile.test.mts` 用真实临时目录覆盖成功和失败两条退出路径，2/2 通过。完整 `npm run verify` 退出码 0：119/119 离线套件、5/5 内置 gate 通过；构建输出有一条 `search.ts` 同时被动态和静态导入的 Vite 分块提示，不影响构建结果。

修复后原生 Electron 复验 runId `1792945756078-56412`：Electron 42.11.8，9/9 媒体生命周期用例通过，`blockedExternalRequests=0`。该成功运行未新增残留目录。沙箱默认启动时的独立尝试曾以 `0x80000003` 失败并留下一个由本轮探针创建的目录；确认路径位于本项目固定 `.cache` 探针目录后已清理。此前 10 月 16 日和 20 日的历史 profile 均保留。

以上只验证探针资源清理和合成流协议生命周期，不代表真实音源、完整曲目解码、听感、日常 UI 或安装升级验收通过；不涉及生产播放代码、提交或发布。
