# 播放数据工具 Implementation Plan

> 执行：superpowers:executing-plans，inline；最终独立审查。用户禁止未经请求提交推送。

**Goal:** 安全备份补缺四类播放数据，然后集中浏览并播放书签。
**Architecture:** 白名单解析与逐store序列化补缺；原生文件选择和10分钟预览lease；独立总览使用已保存曲目索引，player在metadata后保护代次定位。
**Tech Stack:** Electron、Vue、TypeScript，现有原子文件与生产bundle测试。
**Spec:** [设计](../specs/2026-10-28-playback-data-tools-design.md)

## Global Constraints
- 四类只补缺失整曲key，统计不相加；64MiB备份，各store原上限。
- 单类别原子，跨类别失败如实报告，可重试，不声称整批回滚。
- 预览不写，提交重新判断；令牌10分钟、一次消费；不接收renderer路径。
- 书签不构造媒体地址，不能匹配保留禁播；跨曲以起播点加载，不能后置裸seek。
- 前置未提交工作保留，不提交推送。

## Review Focus
1. 重复恢复/响应丢失不能相加统计，已有日期与书签保留。
2. 预览后并发写入不能覆盖，新记录受store串行保护。
3. 恶意大文件/非法身份/额外字段与原文件损坏不能被静默覆盖。
4. 总览旧行、加载失败、途中切歌不能跳错曲或绕过维护锁。
5. 统计coverage不能因导入部分旧历史错误扩展。

### Task1 四类备份补缺
- [x] 捕获当前源码基线，写backup数据解析/merge/store失败与重试测试并见RED。
- [x] 新main/library/playback-data.ts解析、容量、lease；四store importMissing和statistics exportFile。
- [x] 生产build-test与定向测试GREEN。

### Task2 设置接入
- [x] IPC表/严格校验/preload与原生对话框；设置组件预览/确认/部分结果/刷新。
- [x] 生产构建和DOM导出恢复往返（含不写预览、重复补缺）。

### Task3 书签总览
- [x] 新shared/bookmark-catalog.ts已知曲目身份解析测试RED→GREEN。
- [x] player受代次保护的metadata后定位入口，总览路由/侧栏/搜索分页及过期校验。
- [x] 生产DOM与生成媒体验证。

### Task4 收尾
- [x] verify全套、独立审查、修复重要发现、文档/README/规则/路线图/索引。
- [x] 临时目录只清理自有范围，保留未提交源码与证据，不提交推送。
