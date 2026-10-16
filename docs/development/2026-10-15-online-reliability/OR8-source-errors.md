# OR8 后续 — 保留宿主失败证据

2026-10-16，用户要求继续执行。按 [计划](../../superpowers/plans/2026-10-16-online-reliability-source-errors.md) 修复真实检查暴露的超时分类丢失，不改变第三方源或播放候选策略。

## 根因与改动

真实HYW网易检查曾在约20秒后失败，但报告为unknown。宿主已在超时时设置ETIMEDOUT，能力健康层也可识别；SourceEngine的getMusicUrl及requestWithFallback最后却把候选详情拼成新普通Error，丢弃了机器证据。

现在两处汇总分别保留每次尝试的规范化失败：

- 单一失败或所有code/scope一致时保留该分类；混合原因仍为unknown，不借第一个候选代表整体。
- HTTP状态只有全部一致才保留；429等待在每项都有有效证据时取最大，不用部分信息冒充完整等待期。
- 提供者ID及版本只有一致才保留，不能把多个源汇总成一个源的失败。原候选和逐档音质顺序、唯一429重试、取消和后续候选成功路径保持。
- 原本地详情文案保留；结构化failure.message仍为受控摘要，诊断导出不含错误中的token/路径。修复范围为引擎到同进程调用方的证据传递，没有宣称Electron IPC已经序列化整份Error元数据。
- 严格目标音质无可用档位时为qualityUnavailable；没有对应动作时为unsupported。诊断白名单补齐cooling、qualityUnavailable等已定义的受控码，不能在导出时再次丢掉已识别状态。

## 实际证据

文件位于 `.cache/online-reliability-errors/`：

| 检查 | 结果 |
| --- | --- |
| RED | `red.log`：超时/网络、歌词汇总、429、冷却等新增断言在旧行为上失败。混合原因与后续成功控制组保留。 |
| 局部GREEN | `green.log` 11/11，包含5个新增汇总回归和6个既有能力健康接入回归。Node类型检查通过。 |
| 独立只读复核 | 未发现可复现新增P1/P2。reviewer重跑5/5，并以纯内存额外验证4/4：同码不同scope、部分HTTP、部分等待、单一提供者身份。未运行真实源。 |
| 完整verify | `verify.log`退出0：类型、生产构建、81/81套件、5/5门禁。没有额外包重试层。 |
| 定向实际检查 | `hyw-wy-live.json/log`。使用此前用户授权的HYW、同一网易实际曲目，单平台一次检查。初始化通过；解析约20016ms后失败，现在正确记录timeout；没有取得地址，未发媒体请求，listening仍notRun。命令退出1，未把分类修复称为上游恢复。 |
| 差异保护 | `preservation.json`：45份无关tracked diff、65个既有untracked文件不变，unexpected=[]；21份原脚本changedSources=[]。 |
| 静态检查 | `git diff --check`通过，GraphFlow增量索引已执行。 |

## 变更账本与保留项

基线 `before.patch`、`untracked-before.json`。本轮只修改 `source-engine.ts` 的两处汇总及辅助函数、`diagnostic-check.ts` 的错误码白名单；新增 `source-failure-evidence.test.mts`、本计划与记录。没有修改宿主超时值、候选排序、用户资料、第三方脚本、HTTP403访问策略或原有并发修复。

真实样本的服务超时仍然存在；没有不断换曲/换源直到成功，也没有制造真实限流。全曲播放、听感、日常交互与安装/升级验收仍待人工确认。没有提交、推送、安装或发布。
