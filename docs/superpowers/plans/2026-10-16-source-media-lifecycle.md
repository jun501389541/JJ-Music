# 源媒体请求生命周期修复计划

> 用 executing-plans 顺序实施、TDD先RED后GREEN，末尾一次独立只读复核。工作区从已推送f5c77d2继续，只保留.graphflow本地状态，无其他未提交源码；不自动提交推送。

**Goal:** 源停用/更新不仅撤销令牌，也终止已经发出的媒体请求，消费者取消能传到等待响应头阶段。
**Spec:** ../specs/2026-10-15-online-reliability-design.md，OR5/OR6/OR8，RR07/12/19。
**Architecture:** SourceMediaProxy单独追踪活动请求，按provider撤销AbortController；头阶段与abort竞争且清理忽略signal的迟到响应，返回前重新校验身份；流阶段abort即取消reader并终结下游。Electron协议传递Request.signal。

## Constraints

- 其他源/其他消费者的独立请求不受影响；不改变Range、字节限制、重定向/地址守卫。
- 活动请求追踪独立于令牌LRU/到期清理，旧令牌即使被清理，源撤销仍能找到其活动连接。
- 普通长流不因15分钟令牌过期被中断，令牌期限仍只控制新请求；源撤销立即中断旧流。
- 消费者取消/源撤销不冒充网络失败；响应头超时仍为网络类故障。
- 每个终止路径清理timer、signal监听器和活动注册。忽略abort的fetch迟到时取消body，不能交付旧数据。
- 只用内存合成并发回归，不执行实际源/联网；原文件和日常资料不变。

## Tasks

- [x] 受控RED：撤销时pending header/已建body/多Range请求/其他源隔离、令牌被清理后撤销、消费者signal和迟到响应。
- [x] 最小实现请求注册与清理、abort竞态、返回前检查及协议接线，局部GREEN；保留既有慢流、Range、大小和403语义。
- [x] 独立复核，必要修正先RED；完整verify和合成Electron检查；差异保护与交接/索引。

交接与验证边界：`../../development/2026-10-15-online-reliability/OR8-media-lifecycle.md`。局部14/14，完整82/82套件和5项准入检查通过；Electron合成检查通过。原生协议取消信号的实际传播、真实解码和听感未在本轮验证。

## 继续执行：原生协议取消桥接

原生 Electron 42.11.8 探针证实：等待响应头期间，renderer AbortController 已取消，而协议 Request.signal 未触发，代理上游仍在等待；已建立流的 body 取消正常，源撤销也正常。webRequest 的 ERR_ABORTED 事件可观察到准确的 Chromium 请求编号。

- [x] 保存上一轮改动，建立隔离资料、阻断外网的原生探针并记录缺口。
- [x] 受控 RED：同 token 两条 Range 只取消其中一条，以及未关联请求拒绝，共两个失败；建立独立协议边界，以主进程注入编号关联 onErrorOccurred，完成/错误清理关联。覆盖伪造编号、重放和取消先于协议分发。
- [x] 原生 8 项验收：头部取消、流取消、同 token Range 隔离、头部/流源撤销、HTMLAudioElement 取消、HEAD 和 OPTIONS。
- [x] 完整 verify、现有 Electron 合成界面检查、一次独立只读复核、交接与索引。

结果：局部19/19，原生8/8，完整重跑83/83套件及5项准入检查通过，Electron合成界面检查通过。首轮下载LRC读取偶发失败及未改动原因已保留在交接文档，不能视为已修复。无新增提交推送。

Ruling：保留 jjstream 与现有不透明令牌，使用现有默认 session 的 webRequest 事件，不新增 renderer IPC 或播放状态分支。三项监听器在唯一协议注册点安装；当前应用另有的 onHeadersReceived 不受影响。按用户当前继续开发指令保留工作区，不自动提交推送。原生探针只证明协议流传输，不证明音频解码和听感。

Ruling: 当前工作区源码干净，沿用用户现有工作区进行窄范围修复，保留.graphflow本地数据，不引入缺少需求的UI或媒体试听。
