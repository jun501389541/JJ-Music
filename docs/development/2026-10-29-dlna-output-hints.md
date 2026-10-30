# DLNA选择前提示

依据已批准DLNA设计第7节：不能保证按原进度Seek时，应提示从头开始；返回本机保持暂停，模拟验证不代表真实设备兼容。

原面板没有显示从曲首加载的既有行为，并且只有连接后才显示实机兼容/听感未验。现将“实验性”放入面板标题，在网卡选择和设备操作前固定显示切换输出从曲首加载、返回本机保持暂停、真实兼容与听感未验证。连接后的重复提示移除，保留远程音效限制。

本轮仅改静态文案，不改变播放器、IPC、网络或设备控制；未新增镜像文案的测试。此前日志轮换修复保留在同一开发分支，不覆盖或提交。

验证：

- `npm run typecheck`退出0，Node/Web均通过。
- 目录候选`.cache/dlna-hints-candidate/win-unpacked`打包成功，未运行安装器。
- 现有`tools/probe/dlna-output-ui.mjs`通过：输出面板初始关闭、打开关闭、网卡初始未选、搜索禁用、实际桥接断点发现调用0、渲染console错误0，隔离进程清理确认。
- 证据`.cache/dlna-ui-smoke/run-MrIIxz/output-panel.png`已目视检查：新增提示在操作区之前可见，无文字截断或控件遮挡。此证据仅覆盖当前视口和空设备列表，不扩展为小窗口/大量设备矩阵。
- Browser路径此前初始化EPERM，沿用本会话已允许的原生Electron CDP回退；未触发实际设备搜索，未读取真实音源或用户曲库。

日志`.cache/dlna-hints-typecheck.log`、`.cache/dlna-hints-package.log`和`.cache/dlna-hints-ui.log`。本轮未重复完整140套件：代码行为未变；上轮日志修复的完整140/140、5/5证据单列，不作为本轮重新运行。

修改保留`codex/source-log-rotation`，未提交/推送/发布，正式0.7.0资产不变。
