# F1 双平台榜单开发记录

实施：2026-10-23 至 2026-10-24。分支 `codex/platform-charts`，基线本地 main `d2840d7`。本批未提交、合并、推送或发布。

## 交付行为

侧栏“排行榜”进入 `/charts`，网易云和 QQ 列表由应用目录适配器读取，无需音源或平台账号。每页20首、手动加载、最多500首；平台各自保留选择和已加载页。双击及“播放已加载的 N 首”复用常规队列，播放仍需已有可用音源。收藏复用标准歌曲身份和现有菜单。

分页失败保留旧内容；部分结果显示重试；周期不一致保留旧页并要求显式刷新。迟到请求不覆盖当前平台。封面由主进程按已知榜单 ID 查询并通过既有域名限制读取，IPC 不接收自定义 URL。旧 JJ-only 榜单入口继续不可用。

新增 chartList/chartTracks 健康能力及独立2MiB缓存。列表新鲜10分钟、曲目5分钟、最大旧值保留30分钟；沿用全局容量、清理、退出刷新、合并请求和取消规则，不缓存播放 URL。关闭在线可靠性时绕过资料缓存。无用户资料格式迁移。

## 真实目录响应证据（2026-10-23）

按设计共4次，不重试；每平台各列表一次、明确榜单首页一次。所有请求只访问官方公开目录，无脚本执行、Cookie、代理中转、音频或听感检查。

| 请求 | 结果 | 关键契约 |
| --- | --- | --- |
| music.163.com/api/toplist/detail | HTTP200 / code200，65榜 | list 中 id/name/coverImgUrl/updateTime |
| music.163.com/api/v6/playlist/detail，id19723756，n20 | HTTP200 / code200，20曲，平台总数100 | playlist.tracks/trackIds/trackCount/updateTime |
| c.y.qq.com/v8/fcg-bin/fcg_myqq_toplist.fcg | HTTP200 / code0，25榜 | data.topList，id/topTitle/picUrl |
| u.y.qq.com/cgi-bin/musicu.fcg，GetDetail，topId4/offset0/num20 | HTTP200 / code0，20曲，平台总数100 | detail.data.data.period/topId/totalNum 与 songInfoList |

原始公开响应及摘要位于忽略目录 `.cache/charts/`，不纳入提交。生产 ChartAdapter 对这4份原始响应的受控回放通过。后续分页（网易按20个有序 ID 补详情、QQ offset/period）只有离线/受控 UI 证据，本轮未再访问真实接口；不能据此保证所有榜单或长期兼容。最初采样 helper 没有正确传递12秒信号，采用了受限 HTTP 默认超时；生产适配器已正确使用 guardedFetch 转发信号，勿将采样描述为精确12秒验证。

## 自动验证

- `npm run verify`：退出0，类型检查、生产构建、98/98离线套件及5/5目录准入检查通过。记录 `.cache/charts/verify-final.log` 与 `.exit`。
- 新增适配器6项、服务7项、页面状态4项；扩展IPC参数拒绝。覆盖标准化、有序分页、上限、部分响应、周期、旧缓存、跨平台隔离、持久化重建、强刷遵守 Retry-After、共享取消及最后消费者终止上游。截止预算沿用既有 runOnlineRequest 及其离线测试，未声称单独实测12秒真实超时。
- 独立复核发现1项P2：后页成功隐藏前页部分结果提示/重试。先以生产测试bundle复现，再修复为检查全部 partialPages；并修复重试部分首页时清除已加载后页。对应回归先失败后通过。其余无可证实P1/P2。
- `node tools/probe/platform-charts.mjs`：17项隔离生产UI检查通过，包含两平台同ID隔离、20→40手动加载、切换恢复、失败保留/重试、周期变化/刷新、部分首页修复保留第二页、收藏的 tx_mid1 平台身份、受限封面IPC、无音源提示/无播放、无渲染异常/控制台错误。使用真实生产 DOM/preload/main/adapter/cache，仅HTTP响应是合成夹具；生成的独立profile已移除。报告及截图在 `.cache/platform-charts-ui/`。已查看截图，页面布局、范围和状态符合设计。
- UI是原生Electron窗口，按已批准计划沿用项目的隔离Electron/CDP探针；并非在内置浏览器启动一个替代网页。未运行依赖日常曲库的 test:e2e。
- 测试过程中一次错误地将过滤参数传给不支持过滤的 runner，触发全套沙箱测试并出现环境 rename EPERM；已停止，随后正常权限下完整 verify 通过。扩展UI夹具时发生过分支拼接错误导致列表等待超时，修正探针后重跑通过；没有修改生产逻辑来迎合夹具。

## 限制与交付

真实音源兼容、实际音频播放、听感、真实平台后续页及真实图片加载不在上述通过结论内；仍按人工/真实验收清单待验。此次没有运行第三方音源、读取日常音乐、修改全局配置或升级版本号。README仅标识开发分支能力，不改变v0.4.6发布说明。后续提交/合并/推送/发布须分别遵循用户授权。
## GraphFlow同步状态

本批主要 TypeScript 和文档已逐文件索引；最后清理 store 中重复的相同赋值后，补索引返回 `Transport closed`，重连 context 也失败，因此最后这一项补同步未确认成功。Vue、测试和探针扩展名沿用现有配置的排除范围。未调整全局配置或删除图谱数据。连接恢复后仅需重索引 `src/renderer/src/stores/charts.ts` 及本记录；功能不依赖图谱服务。

重复赋值清理后，重新构建生产测试bundle、4项页面状态回归及Web类型检查均退出0。完整 verify 的98/98结论来自此前同逻辑版本，不将图谱失败混同为功能失败。

2026-10-24 后续状态：更多平台与咪咕接通阶段GraphFlow连接已恢复，store及相关记录重新增量同步，前述补同步待办已完成；保留此前失败过程作为历史证据。
