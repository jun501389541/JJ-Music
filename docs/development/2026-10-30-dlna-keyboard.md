# DLNA面板键盘交互

本次收尾增量索引及一次重试均返回GraphFlow Transport closed，待连接恢复后补做；未修改全局配置。

后续独立只读复核已补齐：覆盖全局快捷键、面板异步状态、12项组件测试、测试构建入口、成品按键探针和日志轮换链路，未发现重要问题。下文额度限制为当时状态。复核未运行测试，不替代成品或实机验收。

复核时发现的轻微交互：切换过程中Esc关闭再重开，切换成功仍会关闭面板；后台选择锁及Stop安全屏障不受影响。后续已修复，详见[输出切换轮次](2026-10-30-dlna-picker-switch-cycle.md)。

收尾重新执行完整`npm run verify`退出0：141/141套件、5/5门禁，类型检查和生产构建通过。这次完整运行已包含最新12项面板用例，日志`.cache/maintenance-closeout-verify.log`。本次补齐复核和完整验证，没有新增产品行为或发布资产。

在前轮空资料成品中用原生键盘事件复现两项问题：聚焦输出按钮后空格没有打开面板，面板内Esc没有关闭弹层。RED日志为`.cache/dlna-keyboard-space-red.log`及`.cache/dlna-keyboard-escape-red.log`。

全局快捷键现在将原生按钮的空格交回浏览器点击行为；面板内未被处理、非输入法合成的Esc关闭弹层并恢复触发按钮焦点，同时使尚未返回的网卡刷新失效。其他快捷键保持原逻辑。

验证结果：

- 完整`npm run verify`日志确认141/141套件、5/5门禁通过，类型检查及生产构建通过，见`.cache/dlna-keyboard-verify.log`。
- 完整回归启动后追加两项Esc测试，使用其生产SFC构建另行运行最新测试文件，12/12通过；完整回归的套件统计不冒充已包含这两项新增用例。
- 隔离目录成品`.cache/dlna-keyboard-candidate/win-unpacked`构建通过；明确传入`resources/app.asar`后的版本及原生启动器资源检查通过。初次误传目录造成检查命令EISDIR，纠正参数后通过，非产品故障。
- 已扩展复用`tools/probe/dlna-output-ui.mjs`：原生Space打开、Esc关闭及恢复焦点均通过，重开不自动发现，发现调用0、console错误0，隔离进程清理完成。证据`.cache/dlna-ui-smoke/run-RZNprv`；日志`.cache/dlna-keyboard-ui.log`。
- 本轮独立复核因代理额度限制未执行；已自行检查快捷键影响范围及刷新失效逻辑，该检查不替代独立复核。

不运行真实音源或设备发现、控制，不访问用户资料。物理设备兼容及听感仍未验；修改未提交、推送或发布，正式0.7.0资产不变。

## 后续原生导航补验

继续扩展同一空资料成品探针，使用原生Tab从输出按钮进入网卡选择框，再以Esc关闭并恢复焦点；恢复后以Enter连续打开、关闭，均通过。证据`.cache/dlna-ui-smoke/run-AB2az9/result.json`，日志`.cache/dlna-keyboard-tab-enter-complete.log`；发现调用0、console错误0，隔离进程清理确认。

首次Enter探针仅发送按键标识，没有发送回车字符，因此未触发原生按钮激活并超时；补齐CDP字符字段后通过。该失败保留在`.cache/dlna-keyboard-tab-enter.log`，未因此修改产品代码。本轮仅变更探针与记录，未重复构建或将前轮完整回归说成本轮重新运行。通用E2E会复制个人资料及读取音源，本轮未运行。
