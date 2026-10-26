# QQ 公开歌单搜索接通：LX Music 参考

2026-10-25。用户要求继续开发，并明确提出参考 LX Music。沿用已批准的 F2 搜索、只读详情、确认导入设计，不扩展到账号、签名或播放接口。

## 参考与原因

读取 LX Music Desktop 官方仓库固定提交 `ad95d5091c9ed689fa72b5e5c849df65f5a679ce`：

- [tx/songList.js](https://github.com/lyswhut/lx-music-desktop/blob/ad95d5091c9ed689fa72b5e5c849df65f5a679ce/src/renderer/utils/musicSdk/tx/songList.js) 的 search 方法使用旧 `client_music_search_songlist`，有完整字符集、remoteplace、分页参数及特定 User-Agent/Referer。
- [tx/musicSearch.js](https://github.com/lyswhut/lx-music-desktop/blob/ad95d5091c9ed689fa72b5e5c849df65f5a679ce/src/renderer/utils/musicSdk/tx/musicSearch.js) 的歌曲搜索走单独签名请求，不能把它和歌单搜索混为一谈；本轮未实现/运行其签名。

此前最小参数的旧端点返回-3003，新 musicu 搜索返回 is_filter=-2，只证明那些请求不可用。本次按 LX 完整查询参数和请求头组合得到旧接口有效响应，不能归因到单一参数或声称取消了上游过滤。生产请求使用 HTTPS，没有沿用 LX 的 HTTP URL、递归重试、运行时或大范围代码；字段映射由本项目独立实现。

## 有界真实元数据

先登记最多3次搜索及1次现有歌单读取，每响应2MiB、搜索每次12秒、详情15秒总预算。不登录、不带Cookie、不执行下载脚本、不运行个人音源、不播放/保存/下载音频。

关键词“轻音乐”：

| 请求 | 结果 |
| --- | --- |
| HTTPS旧搜索，page_no0，num_per_page20 | HTTP200、code0/subcode0；15摘要，平台总数56355 |
| 相同完整参数及头，HTTP对照 | HTTP200、相同15摘要；生产不保留HTTP回退 |
| HTTPS旧搜索，page_no1 | HTTP200；17摘要，平台总数56355；原生ID与第一页不同 |
| 首条7739249772，现有公开歌单读取 | 完整90/90首、无警告，首条tx_003UC2r11971cr |

原始响应与摘要保存在忽略目录 `.cache/qq-lx-reference/`，不提交真实创建者资料或第三方源码。原始响应另作生产适配器离线回放，避免为了重复验证新增真实请求。以上仅为公开元数据样本，不代表真实音源、音频或听感通过。

## 接入规则

- 固定 `https://c.y.qq.com/soso/fcgi-bin/client_music_search_songlist`，完整 query/header，原有主机/重定向守卫、2MiB、取消、Retry-After和有界策略重试保持。
- 严格核对成功码、列表、总数、返回page_no和num_per_page；错误、畸形或应有内容却返回空页不作为合法无结果。
- 保留原生字符串歌单ID；把标题/作者的十进制和十六进制HTML实体解成文本，非法码点安全替代，不执行HTML/JS。
- 每页请求20条，平台实测会返回稀疏15/17条。按已确认页槽及总数继续，手动加载、最多10页/200条，不自动补齐或改动页偏移。
- 既有封面仅追加实际返回的 `qpic.y.qq.com`，保留gtimg.cn，不允许整个qq.com家族；HTTP图片URL仅标准化为HTTPS，不以搜索通过替代图片加载验证。
- QQ加入独立playlistSearch能力，取消界面静态未接通门禁，适配器修订仅QQ更新v2。其余四平台、已有歌单、来源身份、播放器和数据格式不变。

## 验证与交付

新增QQ专项6项，先在旧生产bundle上运行0通过/6失败，再实现，专项与旧适配器合计11/11通过。覆盖完整请求、字符串大ID、实体解码、稀疏页/10页上限、合法空与错误结构、图片边界、取消/限流及无需LX音源的能力和Pinia入口。

隔离UI探针补QQ两页、只读详情、确认导入、原生曲目ID和来源歌单ID，删除其自身合成歌单后继续原有四平台和异步回归。仅替换HTTP，实际DOM/preload/main/adapter/cache/导入保存为生产实现；外网渲染请求阻断，使用UUID资料副本并清理。

最终 `npm run verify` 退出0：类型检查、生产构建、112/112离线套件、5/5准入检查通过。首次完整运行仅旧封面主机集合断言未更新（111/112）；补入精确qpic主机及对应封面传递用例后，封面18/18与完整verify重跑通过，没有放宽为整个qq.com。

隔离生产UI运行 `afd78419-a670-4f7a-a53c-2782959113e4` 共36项通过，rendererErrors为空、profileRemoved=true。截图已查看（最终保留画面为网易云列表，QQ具体行为由DOM断言记录，不把该截图称为QQ实图）。正式适配器回放真实两页响应分别15/17条通过，首条标题正确解码、原生ID与页面元数据保持。独立最终只读复核未发现可操作P1/P2。

凭据：`.cache/qq-lx-reference/red.log`、`green.log`、`cover-green.log`、`verify.log`（首轮失败保留）、`verify-final.log`、`production-replay.json`；UI摘要 `.cache/playlist-search-ui/report.json`，日志另复制 `.cache/qq-lx-reference/ui.log`。真实封面加载、实际音源播放及人工听感没有重新执行。README区分当前源码与已发布0.5.0包，后者不包含本轮QQ搜索。版本及发行资产不变，未提交、推送、合并或发布。

## 实施环境

沙箱禁止写 `.git/refs`，创建worktree失败；依 using-git-worktrees 技能的明确回退在原目录继续，保留上轮三平台刷新测试、README和记录。没有修改Git权限、全局配置或个人资料。原111套件离线基线已通过。