# F1 双平台榜单实施计划

> 使用 superpowers:executing-plans 顺序实施，最终 requesting-code-review 独立复核；不自动提交/合并/推送/发布。

**Goal:** 网易云与 QQ 目录榜单浏览、分页及已加载范围播放。

**Architecture:** 新 platform-charts 适配器和 ChartsService，不复活退役 JJ 榜单。复用 ResourceCache、CapabilityHealth、请求策略、TrackList、既有播放器。新 IPC 只接收平台和受限 ID/页号/周期，不接受地址。

**Tech Stack:** TypeScript、Vue/Pinia、受限 HTTP、生产模块离线测试与隔离 Electron UI。

- [x] F1-A：至多每平台一次官方榜单列表和一次首页响应核实；记录失败及字段结构，不重试制造通过。离线夹具先 RED 后 GREEN，实现列表、标准曲目和每页20/最多500、周期及严格校验。
- [x] F1-B：ChartsService 独立能力、预算、缓存/取消/错误与清理接入，严格IPC/preload；测试缓存旧值、取消、结构错误和参数注入。
- [x] F1-C：恢复 /charts 为平台榜单页面，侧栏入口；保留各平台状态，迟到结果失效，手动加载/重试，显示部分结果和范围，复用收藏与常规队列播放。
- [x] F1-D：完整verify、隔离生产UI、独立复核并修复、开发记录和GraphFlow。真实网络证据与离线/听感分开，真实接口失败不阻塞其余离线交付，也不声称真实通过。


2026-10-24：功能、自动验收、独立审查及文档完成；后续扩展阶段GraphFlow连接恢复并完成补同步，F1-D自动化事项已完成，详见[开发记录](../../development/2026-10-24-platform-charts.md)。真实播放、后续页和听感边界保留，不提交/合并/推送/发布。
