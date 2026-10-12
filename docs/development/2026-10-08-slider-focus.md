# 进度条焦点与快捷键修复

用户报告：拖动进度条后调整音量，进度条出现整行异常外框。

## 定位

隔离数据启动真实 Electron，拖动进度条后焦点停留在播放进度控件；随后按方向键会触发全局 `:focus-visible` 样式，在整行 20px 点击区域画矩形外框。拖动已经结束，`is-dragging` 为 false。单独 Ctrl+Up 的复现没有触发外框，这解释了“调整音量后回窗口，进度条继续跟着鼠标”的现象：指针捕获丢失后旧 Slider 仍保留 `dragging`，窗口重新收到指针移动时会继续预览。

另发现 SliderBar 未区分 Ctrl/Meta/Alt 修饰键，处理方向键后事件又进入 App 全局快捷键：Ctrl+Up 调音量可能同时修改进度，普通左右键可能执行两次进度调整。

## 修复

- 滑块焦点提示改为圆点周围描边，保留键盘可见性，不描整行点击区域。
- SliderBar 将修饰键快捷键交给播放器。
- App 不重复处理控件已经 `preventDefault` 的按键。
- Slider 在 `lostpointercapture` 或窗口 `blur` 时取消当前拖动、释放捕获并清空进度预览；取消的进度手势不会提交 seek。

## 检查

类型检查和构建通过。此前真实 Electron 观察：拖动结束无残留拖动状态；方向键聚焦后整行 outline 为 none，圆点 outline 为 2px；Ctrl+Up 在进度条聚焦时音量 80→85，在音量滑块聚焦时 85→90；普通 ArrowDown 在音量滑块上 90→88。没有新增或运行测试套件，未使用真实曲库。本次新增失焦与捕获丢失处理后再次通过类型检查和构建；未运行测试套件。GraphFlow context/plan/index 因 Transport closed 不可用。改动未提交。
