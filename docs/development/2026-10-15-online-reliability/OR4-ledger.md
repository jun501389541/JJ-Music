# OR4 变更边界账本

日期：2026-10-16。前置工作与无关工作保留，不提交推送。

| 范围 | 文件 | 内容 |
| --- | --- | --- |
| 完整候选 | `src/main/online/playlist-import.ts`、`library-router.ts` | 分页预算与取消、完整性标志、完整远程快照独立缓存。 |
| 差异与确认 | 新 `src/main/online/playlist-refresh.ts`、`src/shared/playlist-refresh.ts` | 主进程候选令牌、差异、版本检查、应用/丢弃。 |
| 保存列表 | `src/main/store/settings-store.ts` | 所有修改串行，原子落盘失败回滚，版本快照，退出 flush。 |
| IPC | `src/main/index.ts`、`ipc-validation.ts`、`src/preload/index.ts`、`src/shared/ipc.ts`、`types.ts` | 新预览/应用/丢弃接口，导入读取取消，完整性状态；缓存清理及退出衔接。 |
| UI | 新 `PlaylistRefreshPanel.vue`、`PlaylistDetailView.vue`、`PlaylistImportView.vue` | 完整差异确认、空单警告、取消和迟到保护、导入部分/旧值提示。 |
| 验证 | 新 `src/test/playlist-refresh.test.mts`、`playlist-snapshot.test.mts`、`tools/build-test.mjs`、`tools/probe/online-reliability.mjs` | 生产打包回归与全新合成 profile 的 Electron 检查。 |
| 文档 | 本记录、`OR4.md`、`docs/superpowers/plans/2026-10-16-online-reliability-or4.md` | 计划、证据及剩余边界。 |

本期开始前差异保存在 `.cache/online-reliability-or4/before.patch`，既有 untracked 哈希保存在 `untracked-before.json`。保护核对见 `preservation.json`，无意外变动。特别保留播放器、曲库扫描/删除、下载及 OR0–OR3 的既有工作；OR4 没有将这些差异计为本期新增实现。

远程缓存只保留普通资料，不删除保存歌单、下载文件、手工封面或待写入资源。禁用缓存不禁用明确的远程刷新；不完整/过期候选不写入保存列表。后续 OR5–OR8 仍未完成，真实服务和人工听感未验证。
