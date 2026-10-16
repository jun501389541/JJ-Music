# OR4 歌单完整快照与确认刷新

> For agentic workers: use superpowers:executing-plans. 当前会话顺序执行；独立只读复核后验收，不提交推送。

**Goal:** 完整读取远程歌单后展示差异，只有用户明确应用才改变保存列表；任何失败/部分分页/并发编辑都不静默覆盖。
**Architecture:** 适配器报告完整性；LibraryRouter 独立缓存最后完整远程快照。PlaylistRefreshService 持有短期令牌和本地版本快照，PlaylistStore 串行 CAS 提交且写失败回滚。歌单详情内预览差异并确认应用，原有歌单名/封面及共同条目保留。
**Tech Stack:** Electron / Vue / TypeScript / 现有原子 JSON 与 ResourceCache。
**Spec:** ../specs/2026-10-15-online-reliability-design.md，OR4、RR03/RR06/RR07/RR08/RR19。

## Global Constraints

- 60 秒完整读取预算；单页12秒，瞬时失败每页最多一次，取消共享总截止。
- 远程缓存30分钟新鲜、30天最长展示，版本/schema键；单条2MiB、有界桶；用户歌单不属于缓存。
- 合法空单也只形成移除差异预览，不自动清空。部分结果可导入为新单但不能刷新提交。
- 保留本地/在线独立身份、共同条目的用户资料、歌单名称/手工封面和现有播放队列快照。
- 本期只跑离线回归与纯合成 Electron 探针；不使用真实源/外网/旧复制真实资料E2E。

## Review Focus

- 重复页、数量不符、无效行和分页上限不能冒充完整快照。
- 预览到应用间的重排/增删/改名/封面及质量补全不能被静默覆盖。
- 两次预览逆序返回、取消或删除列表后，旧令牌不能生效。
- 写失败不能让内存歌单与磁盘不一致，其他列表并发操作保持顺序。
- 缓存陈旧/损坏/写失败只影响远程资料，不删用户歌单或文件。

## Task 1 — 完整读取与缓存

Files: playlist-import.ts、library-router.ts、shared/types.ts；扩展导入/路由测试。
Interfaces: importPlaylist(..., options?: {signal;budgetMs}): Promise<ImportedPlaylist>，增加 complete；LibraryRouter.readSnapshot(source,input,signal?,force?): ResourceEnvelope<ImportedPlaylist>。

- [x] 添加合法空单/部分分页/重复页/结构变化/超预算/取消回归并确认RED。
- [x] 实现有界分页、每页唯一重试与完整性；只缓存完整成功，旧缓存失败保留状态。
- [x] 对编译后的生产回归确认GREEN。

## Task 2 — 差异与提交

Files: 新 shared/playlist-refresh.ts、main/online/playlist-refresh.ts；settings-store.ts；新回归。
Interfaces: preview(listId,signal?): PlaylistRefreshPreview；apply(token): Playlist；discard(token)；PlaylistStore.snapshot/applySnapshot expected revision。

- [x] 为本地CAS、合法空候选、元数据保留、过期令牌、并发取消和写失败回滚写RED测试。
- [x] 实现受控令牌、差异与列表串行事务；不接受渲染层发送替换曲目正文。
- [x] 局部GREEN。

## Task 3 — IPC 与 UI

Files: main/index.ts、ipc-validation.ts、shared/ipc.ts、preload；新 PlaylistRefreshPanel.vue、PlaylistDetailView.vue；既有导入UI迟到结果保护。

- [x] 接入预览/取消/应用，显示新增/移除/顺序变化；空单明显提示并明确确认。
- [x] 路由切换、关闭和新请求撤销旧订阅；应用前后保持原列表和队列边界。
- [x] 纯合成Electron探针验证完整差异确认、取消、不完整和空单不自动清空、冲突拒绝。

## Task 4 — 交接

- [x] 独立只读复核，修正Important及以上并回归。
- [x] 完整npm run verify、纯合成UI、差异保护核对；记录OR4.md与账本，增量索引。

后续：OR5 能力健康/地址恢复 → OR6 更新版本衔接 → OR7 诊断真实探针 → OR8人工验收；不以本期测试替代真实平台验证。
