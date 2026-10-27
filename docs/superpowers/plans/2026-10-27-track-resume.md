# 逐首播放进度记忆 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans，沿用inline执行，不逐任务派代理。

**Goal:** 当前曲显式恢复点歌前进度，逐首重启记忆，不自动续播。
**Architecture:** shared校验/进度候选；主进程独立原子文件；Pinia协调捕获点和同键声道所有权；player当前访问校验及共用菜单。
**Tech Stack:** TypeScript/Vue/Pinia/Electron，现有200ms观察器、生产bundle与离线生成音频。
**Spec:** [批准设计](../specs/2026-10-27-track-resume-design.md)

## Global Constraints
- 保存position>=5000且duration>10000且position<duration-5000，否则删除；未知时长不采集。
- 50000条/8MiB，单批32，50000待提交；串行原子确认、revision单调。
- 普通从头；显式继续不重新load、保留pause、退出AB、沿用seek规则。
- 自动重试保留访问，取消预载后新访问；同键回滚归还所有权。
- 仅主窗口，关闭/迁移flush已接受；本批不提交推送，前置基线已保存。

## Review Focus
1. 旧捕获点不会被实时写入替换，回滚捕获点仍有效。
2. 同键双声道旧曲不得删除新点，失败访问迟到确认不抢回。
3. 曲长变化、加载/维护/旧菜单应拒绝，不误seek。
4. 未发声不写、最后尾段不保证、独立坏文件不阻塞播放。
5. 独立记录、重启和原lastSession不争夺恢复权。

### Task1: 独立协议与原子存储
Files: 新shared/track-resume.ts、main/store/track-resume-store.ts、test/track-resume-store.test.mts；改main/preload/ipc/build-test。
Interfaces: ResumePoint {key,positionMs,durationMs,updatedAt}; ResumePatch {key,point:ResumePoint|null}; ResumeSnapshot {revision,records}; store.get/apply/flush。
- [x] 生产bundle失败测试：整批校验、并发、失败回滚、损坏原文件、边界。
- [x] 实现候选原子写入和严格load，IPC关闭迁移拒绝与flush。
- [x] 定向GREEN及类型检查。

### Task2: 进度与所有权协调
Files: 新renderer/stores/track-resume.ts、test/track-resume-client.test.mts；改engine/player/App/shared observer。
Interfaces: initialize/register(id,key)/sample(s)/capture(id)/restore(id)/consume(id)/flush/shutdown。
- [x] RED捕获旧点、短曲未知/首尾门槛、未发声、同键旧release、回滚/失败确认。
- [x] 复用声道ID，playing抢占、rollback显式归还，保留访问捕获；key合并批次/5秒/失败退避。
- [x] player显式continue校验加载身份和代次，seek前清AB；所有权和既有player测试GREEN。

### Task3: 菜单和生产验收
Files: utils/track-actions.ts、tools/probe/queue-search.mjs、crossfade-lifecycle-main/bundle。
- [x] 共享播放菜单显示位置/不可用状态/曲名平台，旧菜单不改新曲。
- [x] 实际DOM暂停跳转与重启记录/坏文件，新播放保存不覆盖捕获点。
- [x] 原生生成媒体同键重叠回滚所有权/取消预载/显式继续保持暂停。

### Task4: 完整验证和记录
- [x] tools/build-test生产离线、typecheck/build/verify，DOM/native保留既有验收。
- [x] 独立最终审查按本批baseline，修复可复现问题并验证受影响项。
- [x] 更新README/PRODUCT_RULES/spec/plan/roadmap/开发记录，清理本批临时目录，GraphFlow增量索引。
