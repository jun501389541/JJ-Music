# 当前曲命名书签 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans。沿用inline执行；最终独立审查。

**Goal:** 本曲多个命名时间点，暂停不启动、原子保存和过期防护。
**Architecture:** shared严格协议与窗口上下文；main串行单操作store；Pinia确认后发布；独立管理对话框接共用播放菜单。
**Tech Stack:** TypeScript/Vue/Pinia/Electron，tools/build-test生产模块测试。
**Spec:** [批准设计](../specs/2026-10-27-track-bookmarks-design.md)

## Global Constraints
- 位置100ms向下取整，0允许，新增/跳转必须小于实际有限曲长。
- 名称trim1–80；同名允许，同位置拒绝；每曲50、全局50000、8MiB，UUID主进程生成。
- 独立track-bookmarks.json；严格整体验证、坏文件不覆盖，写成功才发布，rename/remove比较原值。
- 当前曲key/代次/加载访问ID绑定，旧窗口拒绝；请求接受后只写原key。
- seek退出AB并保持pause，其余播放规则沿用；无全局总览/时间编辑/备份扩展，不提交推送。

## Review Focus
1. 同曲无续播点仍能添加，实际时钟捕获后输入不能漂移。
2. 同曲重播、维护与URL重试让旧窗口过期。
3. 保存中切歌只提交原身份，双击忙保护、旧revision不能回退。
4. 已过曲尾的旧书签保留改名删除，但不能seek。
5. 模态键盘焦点和全局快捷键不穿透，关闭不取消已接受写入。

### Task1 存储和IPC
Files: shared/track-bookmarks.ts、main/store/track-bookmarks-store.ts、test/track-bookmarks-store.test.mts；main/preload/ipc/build-test。
Interfaces: Bookmark{id,positionMs,name,createdAt}; BookmarkSnapshot{revision,records}; BookmarkMutation add/rename/remove；get/mutate/flush。
- [x] 写失败测试并运行RED：重复点、限额、CAS/并发/原子失败、损坏与重复ID、跨平台。
- [x] 实现单操作白名单、原子整体验证、主窗口/关闭迁移flush。
- [x] 定向GREEN/typecheck。

### Task2 上下文和确认状态
Files: player.ts、新renderer/stores/track-bookmarks.ts、test/track-bookmarks-client.test.mts、player-regression。
Interfaces: bookmarkContext/validateBookmarkContext/captureBookmarkPosition/jumpBookmark；Pinia initialize/mutate及busy。
- [x] RED实际时钟、暂停seek、不消费续播点、过期/越界/旧行，busy和旧应答。
- [x] 独立上下文+原行校验、保存确认后发布。
- [x] 受影响回归GREEN。

### Task3 当前曲管理
Files: 新components/TrackBookmarksDialog.vue、App/ui/track-actions、生产DOM/native探针。
- [x] 菜单与弹层，内联添加/改名/确认删除，曲名平台/状态/50条滚动/捕获点显示/忙保护。
- [x] focus trap/Escape/全局键盘保护，切歌显示过期且所有动作拒绝。
- [x] 生产DOM新增/改名/删除/重复/过期/重启/损坏；native暂停跳转/渐变，保留126DOM/31原生。

### Task4 收尾
- [x] 完整verify/typecheck/build和独立最终审查，修复复现问题后针对验证。
- [x] 记录准确证据/边界，更新README/PRODUCT_RULES/spec/plan/roadmap。
- [x] 清理本批temp，GraphFlow增量索引，不提交推送。
