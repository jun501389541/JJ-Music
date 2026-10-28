# WL4 合成窗口事件观察

日期：2026-10-28。范围：当前 Windows 会话的原生合成启动链路；不读取真实音源、用户窗口标题或窗口内容，不修改默认终端。

## 观察器

新增 `window-watch.cpp`，通过 out-of-context WinEvent hook 观察 CREATE/SHOW/foreground，使用消息循环处理回调。按进程快照归属到本轮 Node 协调进程的子树，仅保留该树的 PID、事件、窗口类、是否可见及是否顶层。事件缓冲上限 1024；超时、溢出、快照失败均不能通过。

`window-positive.cpp` 提供 600 ms 的 WS_EX_NOACTIVATE 测试窗口，证明 SHOW 捕获有效且控制窗口不取得前台。`windowless-window-events.mjs` 在 hook ready 后依次运行该控制与原有原生生命周期探针。只排除精确正控制 PID；经 helper 注入的同类窗口不能被排除。

## 校准与审查修复

- `--inject-window` 故意经 helper 启动 600 ms GUI 夹具，检测到 CREATE/SHOW 两条违规并退出 1；正常链路退出 0。
- 独立审查指出异步回调时窗口或祖先进程已消失会丢失归属。增加立即创建/销毁的 `--inject-fast-window`：修复前错误通过，实际复现假通过。
- 修复后，HWND 无法解析与祖先链不完整分别计数，只要非零就标记 inconclusive 并退出 1。快速负向控制实际得到 unresolvedWindows=3，正确拒绝通过。原始报告与 result.json 均保留；不确定不能改写成 0 违规成功。
- 并行离线测试期间曾出现 unresolvedAncestry=8，本轮按不确定保留。完整套件结束后串行复测通过，未知窗口、未知祖先、快照失败、溢出和超时均为 0；正常启动链路可见/控制台/前台违规为 0。

## 复现与证据

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools/test-source-launcher-argv.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File tools/build-source-launcher.ps1 -TestBarrier
node tools/probe/windowless-window-events.mjs --inject-window
node tools/probe/windowless-window-events.mjs --inject-fast-window
node tools/probe/windowless-window-events.mjs
```

两个负向命令预期退出 1；正常命令预期退出 0。不要把预期负向失败当成正常链路失败，也不要把不确定当成通过。正向控制会显示自身非激活测试窗口约 600 ms。

最终串行成功证据：`.cache/window-events-csUIYp/report.json` 和 `result.json`，命令日志 `.cache/wl4-window-events-serial.log`。快速负向日志 `.cache/wl4-negative-fast.log`；并行不确定日志 `.cache/wl4-window-events.log` 和 `.cache/window-events-7pSjC7/`。

当前源码用 MSVC `/W4 /WX` 编译通过。原生权限/Unicode参数/owner、helper、host退出及创建返回屏障探针也随本轮观察串行通过。审查修复后的完整生产 bundle 离线 runner 为 **126/126 suites passed**。

参考：[SetWinEventHook](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setwineventhook) 要求注册线程持续处理消息；[GetWindowThreadProcessId](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getwindowthreadprocessid) 对已失效窗口可能无法解析，故本探针保留“不确定”结果。

## 边界

这是事件观测与合成校准证据，不是人工“绝无闪窗”结论。当前没有完成原截图窗口归属、Terminal/Console Host 两种默认设置矩阵、系统终端代理的跨进程完整归属、真实音源、安装升级后的窗口和人工听感验收。桌面其他活动可能导致不确定结果，应保留原报告并在受控会话重测，不改系统设置或关闭用户窗口来通过。
