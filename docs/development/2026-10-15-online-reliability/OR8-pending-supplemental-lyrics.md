# OR8：待写入歌词附加文本的持久化

2026-10-17，接续[跨重启主歌词回读](OR8-pending-restart-ui.md)，补齐当时保留的翻译/音译丢失边界，对应 RR08、RR16。

## 改动

此前候选入口把翻译和音译留在解析缓存中，PendingAsset 只保存主歌词。生产实例正常退出后，队列和主歌词仍可用，翻译、音译却随缓存消失。

PendingAsset 现可保存可选 tlyric、rlyric、lxlyric；暂存入口从 ResolvedLyric 保存这些字段，恢复入口原样还原。旧队列缺少这些字段仍兼容，不要求迁移或重新联网获取。保留侧车/内嵌本地歌词优先与只读回读不重写队列规则。

四个文本字段共同计入既有的单条200000字符、总2000000字符限制，不扩大容量；超额明确拒绝，不截断文本或淘汰已保存选择。读取校验也检查可选文本类型及单条合计长度。侧车和标签确认写入仍遵循既有主歌词写入规则，本轮不合并翻译到LRC，不新增其他导出格式。

## 验证

- 生产UI RED：890d8331-6af7-4394-8bbb-c56c7176b53d，主歌词回读通过，restart preserves chosen translation and romanization 失败。使用生成WAV与合成附加文本，无真实源、录音或日常资料。
- 模块RED：.cache/pending-supplement-module-red.log，新增容量用例未得到应有拒绝。首次修复复验中的一个断言误在 store.load 之前调用 list，得到空内存视图；修正测试前置加载，不据此更改产品。
- 模块最终结果：.cache/pending-supplement-module-final.log，退出0，10/10通过。覆盖三个附加字段各自使单条超额、附加字段使全队列总量达上限时拒绝新增、原磁盘/内存不变，以及包含主歌词/附加字段和旧记录的重新加载。
- 生产UI GREEN：46ef3bad-d261-4f2b-94fa-75d194c58951，退出0，47项通过，Electron 42.11.8，profileRemoved=true。候选携带翻译/音译，正常关闭后同profile新PID恢复二者；既有队列、禁网主歌词回读、失败保留和真实侧车成功写入检查仍通过。日志 .cache/pending-supplement-ui-green.log，逐运行报告在 .cache/pending-assets-ui/。
- 独立只读复核无本轮P1/P2，确认容量未绕过、旧字段缺失兼容、暂存与恢复字段对应；lxlyric 的持久化以模块测试为证据，不冒充真实源或候选界面验收。
- 完整 npm run verify 退出0，类型检查和生产构建通过，90/90个生产打包离线套件、5/5项门禁通过，日志 .cache/pending-supplement-verify.log。探针语法与 git diff --check 通过。

## 边界

沿用上一轮明确的第二隐藏窗口截图不可用限制，所有DOM及文件断言保留。此证据不覆盖人工听感、真实歌词接口、崩溃断电或翻译合并导出；不将OR8整体标为通过。本轮未提交、推送、安装或发布。
