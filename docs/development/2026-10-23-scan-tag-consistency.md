# 扫描与确认写入的资料一致性

基线：main合并提交`0e2f5b84fdd4a5ef785b55a6c546c80766a8a12b`。用户在确认剩余事项后授权继续开发；本轮处理扫描/标签并发候选及交付记录同步，不发布新版本，不执行真实第三方音源或人工听感。

## 确认与修复

原候选只在模块层控制返回时机。本轮正式测试使用自有MPEG解析夹具，经生产`exportAssets`实际内嵌标题和写入侧车歌词，再走`readTrack`/`updateTrack`。扫描已捕获旧资料但暂停提交；确认写入后放行，原实现分别将新标题改回旧标题、抹掉新侧车来源记录，两项正式断言失败。

根因：扫描只识别下载删除与目录移除，没有识别同一路径已发布的新资料。修复复用每次扫描的在途失效集合：`updateTrack`发布前，将该路径加入所有活动扫描的集合。扫描的排队和提交检查因此丢弃旧结果；结束即释放集合，不增加永久路径表或修改扫描并发度。其他路径正常提交，之后的新扫描仍执行stat增量检查。

## 生产集成证据

新增`tools/probe/scan-tag-consistency.mjs`，每轮构建生产main/preload/renderer并复制到自有临时目录。FFmpeg生成一秒MP3，配置与曲库均自有；不读日常profile。复制bundle仅增加`readTrack`结果完成后的时序门，捕获真实解析结果，未替换生产IPC、写入逻辑或索引值。

从实际歌曲页点击“重新扫描”，等旧资料解析完成后，经正式preload的`match.apply` IPC写入新标题；核对文件及索引已更新，再放行扫描，检查IPC索引、磁盘index和实际列表文本。这里覆盖DOM扫描与正式写入IPC，没有声称点击在线候选对话框、执行第三方源或完成听感。

- RED：运行`5659b233-1a18-46d6-85ab-e649480351fa`，7项前置检查通过；文件与写入后索引均为新标题，迟到扫描后`finalName=scan captured old title`，预期断言失败。应用正常退出，自有profile已回收。
- 首轮修复集成：`1e7e819f-8988-4d93-a271-0edb10a0e0c0`，文件、内存、磁盘和列表一致性均通过；末项“零外部请求尝试”断言失败，不作为整轮通过。
- 确认轮：`315a0616-65dc-4ee7-b399-d419f41f41d9`，11项检查通过，renderer异常0，正常退出，profile已回收。离线守卫在Node fetch发出前拒绝四个平台目录请求，脱敏主机为app.u.nf.migu.cn、c.y.qq.com、music.163.com、songsearch.kugou.com；报告保留阻断尝试，不再将其混同网络请求成功。

逐轮报告保留在`.cache/scan-tag-consistency/<runId>-report.json`；日志`.cache/ga-fixes/scan-tag-ui-{red,green,green-confirm}.log`。只保留脱敏检查及主程序日志，复制bundle、生成MP3和测试profile已回收。正式测试使用解析夹具，生产集成使用FFmpeg实际生成MP3，两者验证等级明确分开。

## 验证与交付边界

正式RED日志`.cache/ga-fixes/scan-tag-red.log`；初轮GREEN为扫描5/5，包括嵌入、侧车、不可读目录、离线根目录和移除文件夹。后续加强对其他路径提交及新扫描增量行为的断言，纳入本轮完整verify确认。

完整确认轮`npm run verify`退出0：类型检查、生产构建、93/93套件和5/5门禁通过，日志`.cache/ga-fixes/scan-tag-verify.log`；包含加强后的扫描5/5。`node --check tools/probe/scan-tag-consistency.mjs`及`git diff --check`通过。逐行复核扫描集合的登记/释放、路径规范化、删除/移除保护与资料发布顺序，未扩大到第三方源或其他资料写入流程。

交付状态记录已补齐PR #1合并与main CI结果；原有OR8源复查文档没有改写，真实源更新/回退继续缺合格候选，人工听感继续待验。本轮修复在`codex/scan-tag-consistency`分支实施，不发布新版本。

用户继续执行后，提交前再次运行完整`npm run verify`，退出0、93/93套件及5/5门禁通过，日志`.cache/ga-fixes/scan-tag-precommit-verify.log`；探针语法及差异检查通过。生产代码自上一确认轮未再改动，界面11项验收沿用上述同一修复代码的确认轮记录。

## 分支交付

修复提交为`4c2fc7098f84b6297d5bcd3852489bee55285111`。原有2026-10-22 OR8源复查记录以独立文档提交随本分支交付，正文SHA-256仍为`C1119F6799A0F9084AC6281E0CE98D74E021C041FF57D92199B0E1C6EB8AEA01`，未重新运行真实探针或修改历史结论。后续通过PR交付到main，远端CI以该PR的检查为准；本次不合并或发布。
