# OR8：候选歌词回读与确认写入

2026-10-17，对应 OR-05、OR-10、RR16、RR20。扩展 [损坏资料界面验收](OR8-pending-ui.md) 的生成素材生产流程，覆盖待写入选择、清缓存和确认写侧车。

## 发现与修复

生产探针发现候选选择之后立即离线回读不到歌词；待写入队列本身仍正确保存在内存和磁盘，问题在显示用解析缓存。

IPC.lyricStageCandidate 直接构造 ResolvedLyric，绕过 searchLyricOnline，缺少后者通常写入的顶层 provider 版本标记。stageFetchedLyric 用 resolved.provider 调用 primeLyricCache，因而将选择写入未带版本的桶；正常 lyricResolve 用 lyricDeps.provider() 的适配器修订哈希读取另一个桶。既有模块测试只证明相同上下文中的暂存与缓存清理，未覆盖这处生产候选入口接线。

修复仅在候选入口为结果写入与正常解析一致的 provider 版本。asset.provider='search' 的来源标记保持原语义；不改变歌词优先级、音源绑定、容量和写入确认流程。

## 验证

扩展 tools/probe/pending-assets-ui.mjs：在自有临时目录生成1秒、8000Hz单声道PCM WAV，通过生产曲库扫描入库，调用真实 stageCandidate，再操作设置页的“清除资料缓存”和“全部写入”。保留上一轮损坏启动、恢复和丢弃检查。

- 初次扩展误用 LocalMusicInfo 不存在的 source 字段，属于探针断言错误；改为核对真实文件路径、解析时长和采样率，不据此修改产品。
- 有效 RED：运行28dd4a8b-38e4-44e6-8fb8-b7718012b2fc，在清缓存之前的 staged choice immediately resolves in production 断言失败，hasProviderRevision=false。更早的扩展运行也在清缓存后回读失败，两者保留各自报告。
- GREEN：运行90f27085-00d4-4379-aff1-a2119878419e，Electron 42.11.8，退出0，28项检查通过，hasProviderRevision=true，profileRemoved=true。
- 选择后立即回读、清缓存后禁网回读都返回所选歌词；清普通缓存保留服务和磁盘的待写入选择；暂存期间尚无LRC。
- 点击真实“全部写入”后，LRC文本符合预期、磁盘待写入队列为空、生成WAV字节完全相同，离线解析来源为sidecar。
- 已查看写入前后截图：1项待写入且按钮可用，随后队列为空且按钮禁用。无renderer exception，既有守卫捕获的外部请求尝试为0。
- 独立只读复核未发现P1/P2，确认读写版本键一致，且行为断言确实能捕获原缺陷。
- 修复后的完整 npm run verify 退出0：90/90个生产打包离线测试套件、5/5项平台门禁检查通过；日志为 .cache/pending-assets-write-verify.log。探针语法检查与 git diff --check 均通过。

报告、逐运行截图及日志保存在 .cache/pending-assets-ui/，本轮有效RED/GREEN命令输出为 .cache/pending-assets-ui-write-red.log 和 .cache/pending-assets-ui-write-green.log。

## 边界

后续已补充真实侧车输出目录冲突、失败保留和消除冲突后重试的36项生产UI验收，见[写入失败与重试](OR8-pending-write-failure-ui.md)。这不扩展为全部磁盘故障或所有格式验收。

本轮使用合成WAV和合成歌词，没有真实源脚本、真实录音或日常资料。网络守卫范围、隐藏测试窗口及限定进程/目录回收方式沿用上一轮记录。此结果只证明当前实例的候选回读、普通缓存清理与侧车成功写入，不冒充跨重启全部暂存展示、所有标签格式写入、磁盘失败、真实听感或人工日常验收。本轮未提交、推送、安装或发布。
