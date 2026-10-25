# 咪咕榜单接通与验收

日期：2026-10-24。承接已批准的三平台扩展设计和用户“继续执行”，不新增产品范围。当前仍在 `codex/platform-charts`，未提交、合并、推送或发布。

## 结果

咪咕目录与分页已接入，当前五个平台均有榜单实现。生产适配器对真实官方响应回放：9个榜单，新歌榜27553319共50首，分页20/20/10，原生songId和copyrightId保留。接口样本成功不代表全部榜单或真实音频兼容通过。

前一阶段“未接通”是当时的调查结论，现已被本记录取代。继续调查时给官方模块请求补充官网Referer（首次另带no-cache）后取得真实JavaScript，并沿明确导入链找到API。没有通过重复猜测路径或执行网页JS取得结果；不能把前次HTML响应解释为“咪咕没有榜单”。

## 本轮官方只读请求

本轮预先登记最多6次，实际5次，无自动重试。全部12秒信号、2MiB响应上限、固定官方主机，无Cookie或账号；模块只静态读取，不执行。既有前四次咪咕调查记录保留，本轮不重写历史。

| 次序 | 地址 | 结果 |
| --- | --- | --- |
| 1 | music.migu.cn/v5/static/js/index-40dab9ef.js，官网Referer/no-cache | HTTP200，9853字节JS，明确导入API模块 |
| 2 | music.migu.cn/v5/static/js/index-cebfdb6e.js，官网Referer | HTTP200，195字节，定义rank-index和rank-info路径 |
| 3 | app.u.nf.migu.cn/pc/bmw/rank/rank-index/v1.0 | HTTP200/code000000，9榜，2类分组，目录ID/名称/图片 |
| 4 | music.migu.cn/v5/static/js/index-5b71f095.js，官网Referer | HTTP200，13565字节，确认实时榜rankType与period为空字符串 |
| 5 | app.u.nf.migu.cn/pc/bmw/rank/rank-info/v1.0，rankId27553319/rankType空/period空 | HTTP200/code000000，131776字节，50个有序条目及嵌套JSON songData，无后续页 |

公开原始响应保存在忽略目录 `.cache/more-charts/`，不纳入提交；回放通过 `.cache/more-charts/mg-replay.mjs`，不再访问网络。未调用歌曲播放/下载地址接口或执行任何音源。

## 数据与分页

榜单ID和songId为受限数字字符串；copyrightId是独立的11位字母数字编码，真实样本如6005754QZEE，不能套用纯数字榜单校验。保留原始大小写，不把版权ID替代歌曲条目ID。songData内外songId/copyrightId必须一致，缺字段或损坏JSON视为schemaChanged，不能猜造歌曲。

完整且不超过500个有序songId时，以其序列生成SHA256指纹作为内部周期键。每页重新核对已取得序列，指纹变化返回空追加结果并要求用户显式刷新，避免同一天实时排序变化被updateTime日期漏检；缓存键含平台/榜单/页/指纹。指纹仅供内部校验，页面说明顺序变化会提示刷新，不展示内部哈希。

单次响应已包含有界列表和songData，按20首切片并仅标准化本页，不为播放自动抓取后续API或播放URL。空榜合法且可缓存；缺少完整序列时仅显示首页并说明限制。超过500个条目的快照按首版容量限制拒绝，不能无限处理响应。实际全部榜单容量及持续兼容未验证。

原wy/tx/kg/kw修订与交互保持不变，新增mg沿用榜单2MiB总缓存与清理，不迁移歌曲/歌单资料。MG曲目缓存恢复同时核对平台/songId/copyrightId。

## 自动验证与复核

- 新增MG真实结构、20/20/10、同日期排序变化、合法空/畸形、未完整快照、字母数字版权ID、500/501容量及内外身份冲突回归；适配器合计17项。发现实际版权ID带字母后先补RED再修复专用校验，真实50首回放通过。
- 独立复核未发现可证实P1/P2，指出的畸形album/img/audioFormats错误分类缺口已先复现普通TypeError，再在标准化边界统一为schemaChanged；补齐500/501与身份冲突用例。
- 服务11项正常权限测试通过，包含生产适配器快照及songId/copyrightId的持久化重建；状态5项及IPC严格参数测试保持。复核环境4个持久化失败已以最小rename复现Windows沙箱EPERM，不能当作产品失败，完整verify采用正常权限。
- 完整验证凭据：`.cache/more-charts/mg-verify-final.log` / `.exit`。修复畸形字段后完整验证退出0：类型检查、生产构建、98/98离线套件、5/5准入通过。
- 生产UI27项通过：`.cache/more-charts/mg-ui.log`。真实生产DOM/preload/main/adapter/cache，仅HTTP响应合成，独立profile已清理。包括MG20→40分页、保留6005754QZEE收藏、同日期重排阻止混合/刷新替换、五平台隔离、原四平台交互及控制台无异常；已查看MG截图。最终说明文案另经Web类型检查、生产构建和相同UI探针复核，最终日志为 `.cache/more-charts/mg-ui-final.log`。

## 剩余验收

本轮真实9榜列表和一个50首样本；其他榜单、长期可用性、真实封面、音频加载和听感仍需单独验收。没有运行用户个人源、日常profile或音乐文件；未改全局配置、版本号或发布资产。功能代码和文档保留当前分支，不自动提交或推送。

GraphFlow：本轮支持扩展名的生产TypeScript及文档已逐文件增量同步，未改变配置或删除图谱。Vue、测试及探针沿用现有配置排除范围。最终完整verify与UI退出均为0，页面说明文案的后续Web类型检查、构建和27项UI也通过。此前双平台阶段的GraphFlow连接待办随恢复同步完成。
