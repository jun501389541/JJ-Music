# OR8：丢弃后明确重新选择歌词

2026-10-17，接续[附加歌词持久化](OR8-pending-supplemental-lyrics.md)，对应 RR16 的用户选择一致性。

## 缺陷与修复

生产候选入口和自动抓取共用 stageFetchedLyric。丢弃选择会记录主歌词指纹，阻止自动重复建议；但明确选择同一候选也被这条检查拦住，即使翻译已变化，结果仍不会重新进入待写入队列。

仅 IPC.lyricStageCandidate 现在标记 explicitChoice。自动解析与自动搜索保持原来的拒绝检查。PendingAssetStore.add 在同一份事务草稿中完成新选择入队、容量检查与对应拒绝记录删除，最后一次原子落盘；容量或磁盘失败不发布草稿。删除范围仅为同曲目、歌词类型及规范化主歌词指纹，保留其他曲目和同曲目其他文本的拒绝记录。

## 证据

- 有效生产UI RED：13437a88-4102-49ca-a385-8b9793af9073，真实设置按钮丢弃后，禁网无歌词、队列为空均通过；明确重选同主歌词并带新翻译时，explicit reselection restores discarded lyric with new translation 失败。
- 模块RED：.cache/pending-reselect-module-red.log，新选内容虽能保存，但拒绝记录仍为true；新增拒绝重置断言失败。
- 模块GREEN：.cache/pending-reselect-module-green.log，退出0，12/12通过。覆盖明确重选、拒绝清除跨重启持久化、其他曲目拒绝保留、容量失败保留旧拒绝及整队列。随后补强同曲目其他文本仍被拒绝的断言，纳入完整verify。
- 生产UI GREEN：2093fdb8-4361-4ede-a845-262af8ede090，退出0，51项通过，profileRemoved=true。真实“全部丢弃”后禁网不回读，明确重新选取同主歌词/新版翻译后立即可回读并恢复队列；清缓存、正常关闭再启动、新版翻译恢复、侧车写入失败保留及消除冲突后重试继续通过。日志 .cache/pending-reselect-ui-green.log，逐运行报告在 .cache/pending-assets-ui/。
- 独立只读复核无本轮P1/P2，确认只有明确候选入口开启该分支，自动建议的抑制范围不变、拒绝重置与新选择一起提交。
- 完整 npm run verify 退出0：类型检查、生产构建、90/90个生产打包离线套件、5/5项门禁通过，日志 .cache/pending-reselect-verify.log；探针语法与 git diff --check 通过。

## 边界

使用自有合成WAV与歌词，没有真实脚本、用户资料或听感验收；沿用第二隐藏窗口截图不可用的显式记录，行为证据为真实IPC/DOM及磁盘断言。自动源抑制以既有检查路径及模块记录为证据，未运行真实歌词接口。本轮不改变指纹对主歌词的既有定义、容量阈值、本地优先或歌词导出规则，未提交、推送、安装或发布。
