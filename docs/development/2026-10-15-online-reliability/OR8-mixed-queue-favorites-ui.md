# OR8：混合队列、收藏身份与无音源失败的隔离 UI 验收

2026-10-20，扩展 `tools/probe/pending-assets-ui.mjs`，仅使用原探针的生成 WAV、合成曲目和自有 profile。没有改生产代码、增加 dev hook、生产 IPC、真实音源、播放 URL 或凭据。

## 方法与边界

从生产 Vue app 已存在的 `#app.__vue_app__.config.globalProperties.$pinia._s` 读取 player/library stores，调用真实 store actions 和持久化 IPC，不替换 actions 或返回值。本地记录使用生产扫描生成的 fixture-local WAV；WY、TX 在线记录仅含合成 ID、相同曲名/歌手、1 秒时长和合成 songmid，没有媒体或封面 URL。

原有 51 项 DOM、文件、重启和写入断言，以及六张隐藏窗口原生截图完整保留。在其后补充：

1. 对 `[local, wy, tx]` 连续调用两次生产 `addToQueue`，确认只有三个独立身份。
2. 没有任何启用音源时调用生产 `playTrackAt` 选择 WY，`autoplay=false/retryUrl=false`。确认明确失败、playing/loading 为 false、current 仍是原 WY 意图、没有实际 resolvedResource、队列三项保留，没有悄悄改成本地同名文件。
3. 通过生产“播放队列”DOM按钮打开面板；向真实 TrackList 行分发带 DataTransfer 的合成 `dragstart/dragover/drop/dragend`，走实际 DOM 拖拽处理器及其 reorder 事件，使 `[local, wy, tx]` 变为 `[wy, tx, local]`，current WY ID 保留且索引由 1 变为 0。**这是合成 DOM 事件验收，不是物理鼠标/可信输入拖动，也没有用 store.moveInQueue 代替拖拽。** 当前意图来自失败选择，不声称正在实际播放音频。
4. 三项同名记录通过生产 `toggleFavorite` 收藏并用持久化 `playlists.items` 读回；重复 `addTracks` 返回 0、仍仅三项。移除 WY 收藏后 local/TX 两项保留，播放队列没有改变。
5. 末尾再检查 renderer 异常和外部请求尝试均为 0。

当前 SettingsView/SourcesView 与 AppSettings 没有每个 provider 的绑定选择器；`providerId` 是曲目来源身份。没有虚构该设置页或为此无必要地导入执行两个脚本。provider 多实例路由/歧义行为仍按现有模块回归边界保留，本轮未新增“绑定设置界面已通过”的结论。

## 实际结果

主代理授予构建锁后，运行 `node tools/probe/pending-assets-ui.mjs`。最终运行 **`f6a86a7d-ddcf-4882-9fb6-abf025219881`** 退出 0，**66 项通过（原 51 + 新增 15）**，7 张 PNG，`profileRemoved=true`，Electron `42.11.8`，没有 renderer 异常或外部请求尝试。

报告 `.cache/pending-assets-ui/f6a86a7d-ddcf-4882-9fb6-abf025219881-report.json`。新增 `mixed-queue` PNG 已实际查看：队列三条同名行、第一条 current 高亮、计数 `1/3`；底部显示 WY 音源不可用的明确错误并标识 WY。各行真实身份和重排结果由 store/IPC 断言验证，不能仅凭相同曲名的截图分辨所有 ID。

七次原生捕获前后 `visibleBefore/visibleAfter` 全为 false，未显示窗口或跳过第二实例截图；其实现与此前六图视觉证据见[原生截图记录](OR8-pending-native-screenshots.md)。`node --check` 和 `git diff --check` 通过。

未执行音源脚本、联网目录请求、人工试听或日常资料操作。本轮不证明跨重启混合队列/收藏持久化全部场景、物理鼠标拖拽、可播放在线源的成功播放或 provider 绑定界面，未安装、提交、推送或发布。
