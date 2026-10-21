# OR8：生成音频的标签、侧车与可恢复性验收

2026-10-20，使用新增 `tools/probe/or8-generated-assets.mjs` 验证生产资源写入路径；仅写本轮自有 `.cache/or8-generated-assets/`，不读取日常歌曲、不执行真实音源、不修改生产代码、不重建共享 `out/`。

## 实际执行

```powershell
node tools/probe/or8-generated-assets.mjs
```

默认导入现有 `out/test/library/` 中由项目生产源码打包的 `asset-export.js`、`tag-writer.js`、`embedded-lyrics.js`、`asset-files.js`。可用 `--bundle=<独立生产模块目录>` 指定其他已构建产物；探针本身没有构建步骤。报告记录这四个模块的 SHA-256 和时间戳。本轮模块时间为 `2026-10-20T09:41:30.055Z`，不把此结果当作未来修改后模块的证据。

FFmpeg 版本为 `9.0.2-full_build-www.gyan.dev`。通过 lavfi 实际生成 2 秒 440Hz/880Hz 合成音频，分别编码为 MP3/libmp3lame、FLAC/flac、OGG/libvorbis、WAV/pcm_s16le；封面也由 FFmpeg 生成 16×16 PNG。没有使用假帧、模拟解码返回或真实录音。

最终运行 `545f9a9b-7934-435f-bad5-93928f9158a4` 退出 0，**54 项通过**。完整报告 `.cache/or8-generated-assets/545f9a9b-7934-435f-bad5-93928f9158a4-report.json`，生成资料和恢复副本保留在同名运行目录。总计 18 次实际 FFmpeg 调用，其中 12 次为完整音频严格解码。

严格解码参数包括 `-v error -xerror -err_detect explode -map 0:a:0 -vn -c:a pcm_s32le -ar 48000 -ac 2 -f s32le pipe:1`，检查退出码、真实输出长度及 SHA-256。每种格式独立比较写入前后，不要求有损格式和无损格式彼此 PCM 相同。

| 格式 | 各次解码 PCM 长度 | 写入前及各次写入/恢复后相同的 PCM SHA-256 |
| --- | ---: | --- |
| MP3 | 768000 bytes | `8b38d6b3585d1b4fabf224bf382194e919a3299cb5fd3054bd38407d500d83c8` |
| FLAC | 768000 bytes | `85343a691c9747e0f82fb27510917d29cef07d34a7c227e69476970a4b043883` |
| OGG | 768000 bytes | `06f9266e907f81148e6519aa73d4bf671d96b080dbd605baf12da5b3b2ae1d49` |
| WAV | 768000 bytes | `b69789cade416445977acc6302fa511bae93fe2cdc3589257ef2a57f033ce6cf` |

## 已核实行为

- MP3/FLAC 通过生产 `exportAssets` 写入 title、artist、album、PNG、LRC，`music-metadata` 读回文本字段和封面原始 bytes，生产 `readEmbeddedLyric` 读回歌词。仅请求内嵌时没有创建同名侧车。
- 两种可写格式再直接调用生产 `writeTags` 独立修改 title，其他字段、封面、歌词保留；两次修改后完整严格解码的 PCM 长度与摘要都等于原始编码文件。
- 第一次 `.bak` 完整 bytes 等于原始编码文件；第二次修改没有覆盖这份原始备份。把备份复制为同格式恢复文件后，其 bytes、完整严格解码 PCM 都与原始文件一致。这验证手工备份恢复，不声称应用提供了恢复按钮。
- OGG/WAV 请求内嵌后实际回退同名 LRC/PNG 侧车，返回提示说明不支持标签写入；歌词文本和封面 bytes 精确一致。原音频所有 bytes 均未变、没有音频备份，写后仍严格解码成功且 PCM 摘要不变。

前两次开发运行的失败没有暴露生产缺陷：第一次使用两位小数时间戳与生产 FLAC reader 的三位毫秒规范化结果做字符串比较；已核实原 Vorbis LYRICS/UNSYNCEDLYRICS 均保留原文本，最终使用规范毫秒 fixture。第二次四个扩展共用 `generated` stem，OGG 写出的 LRC/PNG 使后续 WAV 的 `noClobber` 正确跳过；最终为每个格式使用独立 stem。历史失败报告保留，不把它们计为产品回归。

## 验收边界

这证明指定构建模块对这些生成样本的标签写入、侧车回退、严格解码和备份恢复；不证明所有编码器/元数据变体、日常曲库、Windows 文件锁或所有文件系统故障均通过，也不替代真实包中的对应 UI 路径。

失败时保留既有覆盖与待写入队列的证据沿用 [生产侧车失败与重试](OR8-pending-write-failure-ui.md)、[同文件资源写入串行保护](OR8-asset-write-serialization.md) 和待写入快照回归，本探针明确标记 `queueFailureTested=false`，没有把成功写入场景扩张成失败队列保护证明。

人工听感由用户明确保留待验；本探针 `listeningTested=false`。本轮未安装、提交、推送或发布。
