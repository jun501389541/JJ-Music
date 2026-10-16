# OR6 音源更新与版本衔接实施计划

> For agentic workers: 使用 superpowers:executing-plans 在当前已授权工作区顺序实施，末尾一次独立只读复核。保存前五阶段和既有并发修改，不提交推送。

**Goal:** 更新/回退只在持久化成功后发布候选，旧运行代次不再服务或填回地址/健康/源生成缓存，验证等级如实显示。
**Architecture:** SourceEngine 显式发布失效/提交代次并隔离 transient runtime；源事务互斥。主进程按稳定身份与运行代次联动媒体、健康、资产缓存，目录修订独立；返回安装与初始化结果，不宣称播放成功。
**Tech Stack:** Electron、TypeScript、现有 SourceStore/SourceEngine/ResourceCache、Vue、生产打包离线回归。
**Spec:** ../specs/2026-10-15-online-reliability-design.md，OR6、OR-05/07/09/10，RR07/12/13/16/18。

## Global Constraints

- 检查只读下载并解析，不执行候选；仅明确安装/回退才改变代码。停用源更新仅写盘，保持停用。
- 稳定 ID 与内容版本维持兼容；运行代次另外防止同内容恢复的 ABA。候选持久化前不进入可用源、健康或用户请求。
- 更新开始即撤销旧代次；成功发新版本事件；失败恢复旧代码也不能接受更新前结果。
- 失效只针对受影响源和未绑定聚合源资产；目录缓存与用户歌单、收藏、手工/待写入内容保留。
- 目录修订随应用交付，不增远程目录代码；旧修订不冒充新成功。
- 分别显示已安装、初始化通过/未运行/未确认和实际播放未验证；SHA-256 不称发布者签名。
- 继续纯合成与离线验证；不使用真实用户源、实时端点、旧profile E2E或diagnose，不安装发布提交推送。

## Review Focus

- 候选初始化成功但尚未保存时不能被歌词、封面、播放或可用平台接口访问。
- 失败恢复到相同源内容时，旧缓存命中/在途结果/媒体令牌仍必须失效。
- 旧子进程迟到退出不能删除或停用新进程；事件在停止等待前发出。
- 同源重复更新/回退不得相互恢复旧版本覆盖用户刚确认的新版本；更新期间删除/停用优先。
- 元数据更新检查通知不打断播放解析，真正运行代次变化仍撤销旧解析。

## Task 1 — 更新事务与运行身份

Files: source-engine.ts、source-updater.ts、source-media-proxy.ts；新源版本衔接测试；shared契约。

- [x] RED：候选不可路由、提交后事件/可用、失败恢复同内容代次不同、旧exit隔离、更新互斥、停用/删除边界。
- [x] 实现 runtime generation、失效/提交事件、源事务保护与媒体代次匹配。
- [x] 生产打包局部GREEN，重跑旧更新与源生命周期回归。

## Task 2 — 源缓存失效

Files: resource-cache.ts、online-asset-cache.ts、main/index.ts；新/扩展回归。

- [x] RED：定向失效须移除成功/负缓存并取消旧flight；ABA不能重新填回；其他源、目录和用户资料保留。
- [x] 实现按源与未绑定聚合的缓存失效/代次检查，运行事件衔接媒体/健康/本地自动歌词缓存。
- [x] GREEN，验证同版本内容变化、恢复旧版、持久化重读。

## Task 3 — 反馈与通知

Files: main/index.ts、preload/index.ts、shared/types.ts/source生命周期契约、SourcesView.vue、source-update-state.ts、player.ts；相应回归。

- [x] RED：元数据检查不撤销有效解析；运行变化仍撤销；反馈明确初始化等级及播放未验证。
- [x] 接入生命周期与结果反馈，保留确认和风险说明。
- [x] 合成UI验证停用源更新/回退反馈、检查不执行与基础资源保护。

## Task 4 — 交接

- [x] 独立只读复核，Important及以上修复并回归。
- [x] 完整npm run verify、合成Electron、差异/哈希保护；OR6.md与账本；增量索引。

Ruling: 在当前授权工作区保存基线后继续集成，另建干净工作树会缺少尚未提交的OR0–OR5依赖。
Ruling: 源资产的未绑定候选集合需要随任何成员的运行代次改变而失效；绑定资产只失效相应源，目录缓存独立。失去引用的普通封面字节继续受原LRU配额管理，不扫描/删除用户文件。
