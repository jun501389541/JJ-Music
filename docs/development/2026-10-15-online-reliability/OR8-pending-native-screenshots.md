# OR8：第二隐藏实例的原生截图补齐

2026-10-20，仅修改 `tools/probe/pending-assets-ui.mjs` 的截图观测和本记录，不增加生产 IPC、不修改生产 main/preload/renderer，也不显示探针窗口。所有原有 **51 项 DOM、文件、正常退出、重启、队列及写入行为断言保留**。

## 已确认的旧限制

历史报告 `82574527-082a-417e-96d3-40789f9315ab`、`a05c8e04-2133-44dd-a12e-a9ccbb8fb55c` 明确记录 `CDP timeout: Page.captureScreenshot`，发生在重启后的隐藏实例。后续通过跳过第二实例截图保留了行为断言，未把空截图作为视觉证据，见[重启验收的历史边界](OR8-pending-restart-ui.md)。

## 观测实现

Electron 42.11.8 的本地类型声明支持 `webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })`。探针自有 guard 增加文件观察器：

- 请求和结果文件位置固定在本轮自有 profile 内，只读取普通文件。
- 只接受 UUID 请求身份和六个固定 label：`corrupt`、`repaired`、`after-restart`、`before-write`、`write-failed`、`after-write`；没有任意路径、方法名或生产 IPC 输入。
- 精确选择生产主窗口的 renderer URL，输出文件由固定 output、runId 和白名单 label 组合。
- 原生预捕获激活隐藏合成帧，等待实际页面动画完成（上限 600ms）及 200ms 稳定时间，再取最终 PNG；没有修改样式、禁用动画或伪造页面状态。
- 外层验证请求身份、label、固定输出文件、非零尺寸、PNG 签名，并断言窗口捕获前后均未显示。观察器不阻止进程退出。

最初原生实现运行 `5c687e9e-f761-4364-8689-e5ea97a5acb7`，51 项行为断言通过，产生六个 PNG，但实际查看发现主内容空白或状态落后一帧，因此没有把该次截图计为视觉通过。增加合成器预热与真实动画等待后再完整执行。

## 最终实际结果

通过主代理授予的共享 `out` 构建锁运行生产探针，未与其他生产构建并发。最终运行 **`efec731f-86a5-4a33-bb02-05ac1367608d`** 退出 0，原 **51 项通过**，Electron `42.11.8`，`profileRemoved=true`，renderer 异常和外部请求尝试均为 0。

六张 PNG 均为 **2558×1640**，捕获记录 `visibleBefore=false`、`visibleAfter=false`、`warmedCompositor=true`；第二实例四张不再跳过。逐张实际查看结果：

| label | 视觉核对 |
| --- | --- |
| corrupt | 设置页说明未读取到队列，写入/丢弃按钮禁用，损坏资料错误 toast 可见 |
| repaired | 显示恢复测试歌曲 1 项，写入/丢弃可用；上一条损坏 toast 尚未自然消失，按真实短时状态保留 |
| after-restart | 第二个进程显示恢复的 fixture 曲目 1 项 |
| before-write | 显示 1 项等待写入，尚未执行写入 |
| write-failed | 实际 EPERM rename 错误 toast 可见，队列仍显示 1 项且可重试 |
| after-write | 队列为空、按钮禁用，成功 toast 显示“已写入 1 项” |

报告为 `.cache/pending-assets-ui/efec731f-86a5-4a33-bb02-05ac1367608d-report.json`，六张图片使用相同 runId 和上述 label。截图是附加视觉证据；队列 bytes、音频 bytes、身份、失败保留与真实重试仍由独立行为断言核实。

`node --check`、`git diff --check` 通过。未执行真实音源、人工试听、宿主安装、提交或发布。该补齐解决本环境第二隐藏实例的截图观测缺口，不扩大既有网络守卫或文件故障验收边界。

同日后续完整保留上述51项与六图，再补混合队列/收藏验收：运行 `f6a86a7d-ddcf-4882-9fb6-abf025219881`，66项、七张hidden原生截图通过，新增队列图已实际查看；详见[混合队列记录](OR8-mixed-queue-favorites-ui.md)。白名单仅增加固定 `mixed-queue` label，其余通道约束未变。
