# OR7 变更边界账本

基线 `.cache/online-reliability-or7/before.patch`、`untracked-before.json` 保存于 OR6 离线交付后；`preservation.json` 核对 44 份无关 tracked diff、49 个既有 untracked 文件，unexpected 为空。未修改既有播放器、下载、曲库和 OR0–OR6 产品代码。

| 范围 | 文件 | 变更 |
| --- | --- | --- |
| 准入/报告 | 新 `src/main/online/diagnostic-check.ts` | 明确live范围、串行单样本、共享60秒与取消、白名单分级和版本证据。 |
| 诊断入口 | `tools/diagnose-online.mjs`、新 `tools/probe/diagnostic-cli.mjs` | 删除日常配置自动发现、全源启动、全平台多曲搜索和原始错误输出；新默认合成/显式live。 |
| 资料探针 | 新 `tools/probe/catalog.mjs` | 默认合成契约，显式实际样本；图片签名与严格详情防止假成功。 |
| 回归 | 新 `diagnostic-check`、`diagnostic-cli`、`diagnostic-default` 三套件；`tools/build-test.mjs` | 生产同源模块、注入网络、真实CLI默认守卫与临时资料清理。 |
| 交接 | OR7、OR8、配置模板、计划 | 使用方法、证据分级、RR01–RR20映射和人工未验证项。 |

Ruling: 沿用当前未提交工作区及原差异保护；不提交推送。CLI真实模式实现不等于真实检查已执行。

Ruling: 一次检查只用一份明确源和每平台/能力一份明确样本；没有从日常 profile 取数据。模板 null 值默认拒绝，不提供编造歌曲作为真实样本。

Ruling: 初始化取消先撤销运行代次，finally 等待有界启动回收后删除临时资料。命令报告不打印脚本日志或原始错误。

完整检查与保留项见 [OR7.md](OR7.md) 和 [OR8.md](OR8.md)。
