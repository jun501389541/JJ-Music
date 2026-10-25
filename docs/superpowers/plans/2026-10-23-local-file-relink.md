# 本地文件重新定位实施计划

> 使用 superpowers:executing-plans 顺序执行；最终按 requesting-code-review 独立复核。不自动提交、推送或合并。

**Goal:** 实施已批准的逐首重新定位设计，保留用户列表和播放引用，失败可恢复。

**Architecture:** 共享纯函数只迁移明确匹配旧本地 ID/path 的条目。主进程维护短时不可伪造候选；确认后在应用写入隔离窗口内保存逻辑事务，再幂等修复三份资料并重载存储。启动在加载服务之前恢复未完成事务。音乐原件、待写入资源和下载记录不修改。

**Tech Stack:** TypeScript、Vue/Pinia、Electron IPC、music-metadata、原子 JSON 写入及生产模块离线测试。

- [x] R1：新增 shared/local-file-relink.ts 纯引用迁移及 main/library/local-file-relink.ts 候选/可恢复事务。正式测试覆盖新旧路径、在线同 ID、顺序/进度、冲突、取消、格式/候选变化、各持久化失败恢复；先 RED 再 GREEN。build-test 纳入生产模块。
- [x] R2：SettingsStore/PlaylistStore/MusicLibrary 增加安全重载，MusicLibrary 暴露扫描状态；主进程在所有在途 IPC/资产写入完成且无下载/扫描时提交，失败保留恢复记录并阻止继续写资料。启动先恢复，退出等待在途提交。IPC 只接受源条目 ID/路径及 opaque token，实际新路径来自主进程选择框。
- [x] R3：preload 显式接口；右键单首菜单选择→信息预览→确认/取消；成功更新 library 与 player 本地引用，不自动播放，不丢队列位置。原文件已恢复或目标冲突拒绝。同步 PRODUCT_RULES。
- [x] R4：完整 verify，隔离 UI 验收，独立审查并修复；更新开发记录与 GraphFlow。

执行期间将具体裁定及验证写入 docs/development/2026-10-23-local-file-relink.md。
