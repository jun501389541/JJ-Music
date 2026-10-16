# OR6 变更边界账本

基线：`.cache/online-reliability-or6/before.patch`、`untracked-before.json`。保留 OR0–OR5 和原有播放器/曲库/下载修复，不提交推送。

| 范围 | 文件 | 变更 |
| --- | --- | --- |
| 生命周期 | `source-engine.ts`、新 `shared/source-lifecycle.ts` | 候选隔离、运行代次、失效/提交事件、启动前与迟到退出隔离。 |
| 更新事务 | `source-updater.ts` | 同源互斥、原内容校验、检查正文绑定、每日队列重读、停用保持、恢复。 |
| 缓存 | `resource-cache.ts`、`online-asset-cache.ts`、`lyric-service.ts` | 选择性失效正/负/在途结果，按源防 ABA，平台和用户资产保留。 |
| 接线 | `main/index.ts`、`source-media-proxy.ts`、`playback-router.ts` | 生命周期清理、媒体代次身份、元数据通知与验证等级。 |
| UI/契约 | `types.ts`、`preload/index.ts`、`ipc-validation.ts`、`player.ts`、`SourcesView.vue`、`source-update-state.ts` | 检查基线摘要、参数验证、通知分类、已安装/初始化/播放未验证提示。 |
| 验证 | 新 `source-revision`、`source-cache-invalidation`；扩展 player/local-lyric/source-update-state；合成 Electron probe | RED/GREEN、独立复核、完整 75/75 离线、停用源真实 UI 路径。 |

Ruling: 使用当前已授权工作区的未提交依赖，以 diff 和哈希核对保护无关工作。

Ruling: 内容版本与运行代次分离；候选发布与磁盘提交顺序明确。已有 runtime 的 transient 状态优先于启动记录，失败启动仍由确切启动对象辨认。

Ruling: 未绑定脚本资产随候选集合变化失效，其他绑定源和平台缓存不因此丢弃。自动资源失去引用不立即删除普通封面字节，更不扫描用户资料。

完整证据与保留边界见 [OR6.md](OR6.md)。OR7、OR8 及真实服务/听感尚待接续。
