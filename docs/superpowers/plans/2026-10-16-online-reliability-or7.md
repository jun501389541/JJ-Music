# OR7 诊断与检查实施计划

> For agentic workers: 使用 superpowers:executing-plans 顺序实施；末尾一次独立只读复核，保留当前未提交工作，不提交推送。

**Goal:** 默认诊断不读取实际配置、不联网，只使用生成的临时合成源；真实模式显式选范围并生成脱敏分级证据。
**Architecture:** 新独立诊断策略模块处理参数准入、串行任务/总预算/取消和报告字段白名单；工具共享 CLI 桥接 compiled 模块。旧 diagnose 替换为安全默认，新 catalog probe 不自动搜索实际歌曲。
**Tech Stack:** Node、TypeScript、既有 SourceEngine 与平台目录适配器、生产打包离线测试。
**Spec:** ../specs/2026-10-15-online-reliability-design.md，OR7、RR14/15/18。

## Global Constraints

- 默认只用临时资料和合成源。真实模式必须 `--live --config <测试JSON> --platform wy,tx`；源诊断另须 `--source <明确脚本文件>`。未显式指定时不扫描 APPDATA 或日常 profile。
- 并发 1；每平台每能力至多一个样本，整体 60 秒；SIGINT/SIGTERM 取消且清理临时进程和资料。请求沿用既有取消/有界抓取。
- 报告分 synthetic、catalog、resolution、media、listening；未执行等级明确 notRun，解析成功不代表媒体或听感。
- 只白名单重建结果，不导出关键词/曲名/原始错误/URL/脚本/头/本地路径。配置和脚本有读取上限。
- 本轮只运行合成与注入测试，不执行 live 模式，不提交推送安装发布。

## Review Focus

- 拼错参数或不完整live参数必须在任何文件/源读取前拒绝；默认命令不得访问用户目录。
- 总预算/取消须阻止后续样本，即使底层忽略取消也不提交迟到成功；所有进程最终清理。
- 对每个平台各执行一个样本；不能重试多个关键词/曲目掩盖失败；未声明或不支持保持明确状态。
- 任意第三方错误、日志、元数据不进入stdout/报告，失败只用受控代码；未知失败不得推断为上游坏或引擎全好。
- 源代码仅在显式live下且通过既有静态准入后执行；测试临时文件不得回写实际配置。

## Task 1 — 准入与报告

- [x] 写失败回归：默认模式、参数拒绝、敏感结果重建、分级、串行/去重/取消/总预算。
- [x] 实现 `src/main/online/diagnostic-check.ts` 并加入 `tools/build-test.mjs`，局部GREEN。

## Task 2 — 两个工具

- [x] 重写 `tools/diagnose-online.mjs` 为共享CLI入口，新增 `tools/probe/catalog.mjs` 与 `diagnostic-cli.mjs`。
- [x] CLI注入测试验证默认不读取用户数据/live参数先验证，显式样本最多一次且报告脱敏。
- [x] 默认引擎执行生成源只返回合成地址，资料探针离线注入标准/空/结构变化样本；真实适配器仅在live分支动态加载。
- [x] 默认CLI真实进程smoke，拒绝外网守卫；不运行任何live检查。

## Task 3 — 交接

- [x] 一次独立只读复核并修正P1/P2，完整verify，差异/哈希保护和增量索引。
- [x] OR7记录、使用示例与配置结构、真实验收未验证清单；OR8汇总RR01–RR20证据及人工操作清单。

Ruling: 原工作区包含OR0–OR6未提交依赖，保留基线后原地顺序实施。
Ruling: 不新增媒体实际播放/听感自动判定；报告中的这两个等级始终未执行，需要后续用户明确样本验收。
