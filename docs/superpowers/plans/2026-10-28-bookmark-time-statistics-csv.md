# 书签时间与统计CSV Implementation Plan

> 使用superpowers:executing-plans，inline；最终独立审查。不得提交推送。

**Goal:** 两处书签精确修改时间，按当前日期/搜索/排序导出全部匹配统计。
**Architecture:** shared整数十分秒解析和move协议，store串行CAS/原子写；可复用时间编辑组件；共享统计全匹配查询，main冻结快照/原生CSV文件保存。
**Tech Stack:** TypeScript、Vue、Electron、生产bundle与生成媒体探针。
**Spec:** [批准设计](../specs/2026-10-28-bookmark-time-statistics-csv-design.md)

## Global Constraints
- 保留id/name/createdAt，100ms、0允许、同位置无写、重复拒绝，原文件v1容量不变。
- 本曲context实际时长检查，总览固定身份/原值CAS；未加载不强播，保存不seek。
- CSV固定已应用筛选，全匹配跨页；main快照打开对话框前冻结，不接收renderer行/路径。
- UTF8 BOM/CRLF/双引号转义/公式文本防护/C0拒绝；50000行/32MiB整体拒绝。
- 资料目录及别名保护、迁移互斥、关闭等待写；前置未提交改动保留，不提交推送。

## Review Focus
1. 打开后改名/删除/改时间，以及同位置请求，CAS不覆盖新记录。
2. 未匹配书签编辑、当前时长变化、换曲不能误改或启动播放。
3. CSV累计baseline和日期范围不同、搜索含Unicode、分页/排序不能少导。
4. 公式与多行/引号/控制字符及最终字节上限，不能生成危险/截断文件。
5. 保存对话框期间播放/筛选/迁移/退出，快照保持且文件发布边界可靠。

### Task1 时间编辑
Files: shared/track-bookmarks.ts，main/store/track-bookmarks-store.ts；新renderer/components/BookmarkTimeEditor.vue；TrackBookmarksDialog.vue、BookmarksView.vue；新test/bookmark-time.test.mts。
Interfaces: parseBookmarkTime(text):number；BookmarkMutation move {key,expected,positionMs}，纯时间编辑组件以validate(position)预检和store.mutate CAS。
- [x] 输入0/三种格式/精度/溢出和move原子/CAS/排序/无写/重复/失败测试RED。
- [x] 最小实现，原值保护、两个入口、保存不播放；生产bundle定向GREEN。

### Task2 CSV
Files: 新shared/statistics-csv.ts与main/library/statistics-csv.ts；shared/playback-statistics.ts抽取statisticsRows；main/index.ts、ipc-validation.ts、shared/ipc.ts、preload/index.ts；StatisticsView.vue；新test/statistics-csv.test.mts。
Interfaces: StatisticsCsvRequest {scope:'all'|'range',from?,to?,query,order}，validateStatisticsCsvRequest；serializeStatisticsCsv(snapshot,request,exportedAt):{text,rows,revision,exportedAt}；StatisticsCsvExporter.export(request):result|null/flush/busy。
- [x] 日期/全分页/排序/公式/多行/坏输入/字节行限、取消/冻结快照/目录/原子失败测试RED。
- [x] 共享查询、serializer、原生dialog与生命周期，页面禁用状态/结果反馈；GREEN和类型构建。

### Task3 验收审查
- [x] 扩展queue-search DOM，保留151项并新增时间编辑/取消/过期/CSV真实磁盘校验。
- [x] 原生生成媒体证明改时间不seek不播放；保留35原生用例。
- [x] 完整verify组件/独立审查，以基线对比；重要问题RED→GREEN修复。

### Task4 收尾
- [x] spec/开发记录/README/规则/路线图/ledger、计划勾选、GraphFlow索引。
- [x] 绝对路径验证后清理自有临时目录；未提交未推送。
