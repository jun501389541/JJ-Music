# 歌单搜索平台清空与刷新位置修复

2026-10-24。承接“继续开发”，修复既有F2搜索控件的两个状态缺陷，不新增平台、接口或用户数据格式。本轮不提交、合并、推送或发布。

## 修复

- 原来每次切换到输入框为空的平台都会继承上一平台的草稿。用户清空某平台，再从另一个平台返回时，已清空的关键词因此重新出现。现仅在会话内首次访问新平台时带入草稿；已访问、明确清空的平台保持空白，其他平台的结果和输入不变。
- 原来从多页结果刷新或重试首页成功后，分页已回到第一页，列表仍停在旧滚动位置。现成功接收首页时重置该平台scrollTop，并在生产DOM更新后恢复到0；失败返回旧缓存或错误时保留完整集合和原位置。组件已离开、已清空或切换平台后的旧回调不会改写当前列表滚动。

## 红绿与复核

`playlist-search-store.test.mts` 新增两项先RED：清空后返回得到First而非空字符串；成功首页重试仍为400而非0。修复后生产打包store合计7项全部通过，日志 `.cache/playlist-management/search-state-red.log`。

生产Electron旧构建也复现清空平台回填问题，运行 `f7a16b28-4966-4047-9e32-9a45c6365d7e`。修复后 `node tools/probe/playlist-search.mjs` **30项通过**，运行 `9d18b700-3148-412d-9791-6e8955dab1e2`。新增清空平台返回、失败保留60个结果和300px位置、重试成功后实际DOM scrollTop为0；原摘要平台身份、分页失败重试、浏览播放提示、确认保存、取消、单次令牌、返回状态和分类竞态检查继续通过。零渲染异常/console error，profileRemoved=true。日志 `.cache/playlist-management/search-state-ui-final.log`，报告 `.cache/playlist-search-ui/report.json`；截图已查看。

沿用独占profile和合成官方结构HTTP，不访问真实端点、音乐或音源。独立只读审查核对首访集合、成功/失败分支和updateResults两次存活/代次检查，未发现本轮新增Important/Critical。

最终 `npm run verify` 退出0：Node/Web类型检查、生产构建、**104/104套件、5/5准入**。日志 `.cache/playlist-management/search-state-verify-final.log`；此次全量包含上轮最后补充的显式样本目录检查（不存在或非目录在构建前退出2），默认仍仅使用生成音频夹具，未读取真实音乐或调用真实平台。

GraphFlow本轮连接恢复，前期遗留的12个支持TS文件已逐项补核（11个unchanged、playlist-search store重新索引）。本记录、前期计划/记录、产品规则及README已在最终写入后逐文件增量同步；Vue/MTS/MJS沿用现有索引范围，不修改配置。
