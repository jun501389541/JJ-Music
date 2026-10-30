# DLNA面板的网卡刷新生命周期

继续既有网卡结果隔离任务，不触发实际发现或设备控制，保留此前工作区修改，不提交推送或发布。

## 复现与修复

面板重新打开时，旧选择即使已不在接口列表中仍被保留；快速关闭重开可让旧列表覆盖新列表，关闭后的错误也会写回。当前读取失败没有清空旧选项，还可能覆盖已有停止未确认提示；正常重试成功后普通旧错误仍残留。

`show()`为每次开关分配接口刷新代次，只采纳当前打开轮次的结果和失败。成功时仅清除已不存在的选择，仍可用的选择和设备缓存保持；当前失败清空接口、选择及设备。普通旧错误在重新打开时清除，停止未确认提示保留。沿用已有选择watch撤销旧搜索UI状态，不改变后端发现预算或播放逻辑。

## 验证

- 通过现有生产SFC脚本测试入口，用合成接口列表及受控Promise复现：前轮5项通过，新增5项均RED。
- 修复后10/10 GREEN，覆盖仍可用选择、接口移除、乱序打开轮次、关闭后错误和当前失败的全局Stop保护。
- 累计`npm run verify`退出0：141/141套件、5/5门禁，Node/Web类型检查和生产构建通过；日志`.cache/dlna-picker-refresh-verify.log`。
- 独立只读复核未发现重要问题，确认刷新代次、失效选择清理、有效缓存保留和Stop提示保护逻辑一致；未将静态复核代替运行结果。
- 目录候选`.cache/dlna-picker-refresh-candidate/win-unpacked`打包及版本/原生资源检查通过。基础面板证据`.cache/dlna-ui-smoke/run-1tPJK7`通过。
- 扩展现有`tools/probe/dlna-output-ui.mjs`实际关闭后重新打开面板：未选网卡、搜索禁用、无自动发现均通过，console错误0，隔离进程清理确认。证据`.cache/dlna-ui-smoke/run-RZJsUo`，日志`.cache/dlna-picker-refresh-ui-reopen.log`。沿用本会话已允许的Electron CDP回退，不访问真实音源或用户资料。
- 其他日志`.cache/dlna-picker-refresh-package.log`、`.cache/dlna-picker-refresh-resources.log`及`.cache/dlna-picker-refresh-ui.log`。这次完整verify后仅扩展QA探针并实际运行通过，未再次改变产品代码。

当前代码仅在开发分支；真实音源、实体网卡变化/防火墙/设备兼容与听感未验，模拟结果不扩大为物理网络验收。正式0.7.0资产不变。

GraphFlow早期返回Transport closed，收尾已恢复；本轮及前轮待补的增量索引和结果回填已完成，未修改全局配置。
