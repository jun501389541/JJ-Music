# 交叉渐变实现与自动验收记录

日期：2026-10-26

设计：[交叉渐变设计](../superpowers/specs/2026-10-26-crossfade-design.md)

计划：[交叉渐变实施计划](../superpowers/plans/2026-10-26-crossfade.md)

## 自动验收

生产播放器状态机与 `WebAudioEngine` 被打入原生 Electron 探针。探针生成 440 Hz、880 Hz 等本地 WAV 夹具，通过 `127.0.0.1` 提供；所有其他 HTTP(S) 请求都会被取消并计数。运行期间没有访问在线音源或真实播放链接。

命令：

```powershell
$env:TEMP = '<isolated-worktree>\.tmp-tests'
$env:TMP = $env:TEMP
$env:JJ_CROSSFADE_ELECTRON_DIST = '<installed-electron-42.11.8>\dist'
node tools/probe/crossfade-lifecycle.mjs
```

验收结果：

- 探针 run ID：`1792953933135-15860`
- Electron：`42.11.8`
- 原生场景：`8/8` 通过
- `blockedExternalRequests=0`；结束时活动媒体请求 `0`
- 播放器停止前有 1 个慢速合成媒体请求；停止后请求归零且双通道 `src` 已清空
- 临时 Electron profile 已删除
- 交叠中两条实际媒体时钟均前进；共享分析器同时检测到 440 Hz 与 880 Hz 能量（本次分别为 231、181）

场景包括：

1. 两个媒体通道同时播放，交接完成后旧通道释放。
2. 交叉渐变设置为 0 时只加载当前通道。
3. 损坏的下一曲预载失败时，当前曲继续播放且损坏通道释放。
4. 交接后向真实 incoming `<audio>` 元素注入 `MediaError` code 3，验证播放器回滚到 outgoing 的实时位置与状态。错误事件为合成注入，不代表浏览器实际解码损坏音频时也触发了同一事件路径；真实无效 WAV 的预载另有第 3 项。
5. 交叠中手动下一首播放第三个队列项并释放过期通道。
6. 交接后 seek 留在新曲，按指定位置播放并释放旧曲。
7. 以 2× 开始交接，再调到 4×；验证时长按墙钟秒数调度、剩余渐变在任一媒体先结束前缩短，旧通道释放后新曲继续播放（本次初始时长 2.9899 秒、变速后剩余 1.2912 秒）。
8. 停止取消活动的慢速本地媒体请求并清空通道来源。

隔离 worktree 的 `node_modules/electron` 未包含 Electron 可执行文件，因此探针通过 `JJ_CROSSFADE_ELECTRON_DIST` 使用工作区已安装的 Electron `42.11.8`；探针 profile 仍在隔离 worktree 内临时创建并于结束时删除。没有改动原工作区的 Electron 安装或用户数据。

## 完整项目验证

在隔离 worktree 内执行 `npm run verify`，结果：

- Node 与 Web TypeScript 检查通过。
- Electron Vite 主进程、preload 与 renderer 生产构建通过。
- 离线套件：`123/123` 通过；音频引擎交叉渐变回归用例 `13/13` 通过。
- 内置在线目录门禁：`5/5` 通过。
- 离线运行按项目规则跳过缺失的真实音源脚本样本；没有运行联网验收。

预载期间旧曲自然结束的边界由离线回归测试覆盖：取消尚未发声的新曲并只发出一次旧曲 `ended`；迟到的新曲 `playing` 事件不会恢复已取消的交接。

## 验收边界

自动结果证明生产播放器和双通道音频图可在本机 Electron 中处理生成的媒体夹具。它不证明网易云、QQ 音乐或其他真实地址的可用性，不覆盖安装包升级，也不替代人工试听。人工听感按用户选择保留待验。

交付分支为 `codex/crossfade-reliability`；用户于 2026-10-26 授权提交并推送本批改动。真实音源播放与人工听感仍按上述边界保留待验。
