# 输出切换与面板打开轮次

处理前轮独立复核指出的轻微交互问题：选择输出后，在异步切换完成之前用Esc或按钮关闭并重新打开面板，旧切换成功会无条件关闭新面板。

`choose()`现在记录启动时的面板轮次，只在同一轮次成功后关闭，并使该轮未完成的接口刷新失效。面板关闭不取消后台切换，也不提前释放busy；跨轮失败仍呈现全局停止未确认提示。此修复只影响UI关闭时机。

采用真实生产SFC脚本及受控Promise：新增迟到成功不关闭重开面板、同轮成功正常关闭、重开后Stop失败仍提示三项用例。修复前第一项RED，其余14项通过；修复后15/15通过。日志`.cache/dlna-picker-choose-red.log`、`.cache/dlna-picker-choose-build-test.log`和`.cache/dlna-picker-choose-green.log`。

独立只读复核未发现Important或安全、异步逻辑回归；复核未运行测试。

完整`npm run verify`退出0：类型检查和生产构建通过，141/141套件、5/5门禁，已包含最新15项面板测试；日志`.cache/dlna-picker-choose-verify.log`。

目录候选`.cache/dlna-picker-choose-candidate/win-unpacked`构建通过，asar版本和原生启动器资源检查通过；日志`.cache/dlna-picker-choose-package.log`及`.cache/dlna-picker-choose-resources.log`。成品Space、Tab、Esc、Enter及重新打开面板检查通过，发现调用0、console错误0、隔离进程清理确认；证据`.cache/dlna-ui-smoke/run-VPGYjR`，日志`.cache/dlna-picker-choose-ui.log`。异步切换竞争使用前述受控SFC测试验证，成品探针不执行设备选择，不能将其说成实体设备切换证据。

GraphFlow上下文及规划在本轮开始时可用，收尾增量索引两次均返回Transport closed，待连接恢复补做，未修改全局配置。

后续累计验收：在同一最新候选运行`clean-profile-sources.mjs --synthetic`，应用复制到没有开发依赖祖先的临时目录，创建空资料，仅导入项目合成脚本。五平台启动、受控播放地址、320k档位及宿主真实`lx.request`到自建回环标记服务均通过，失败项0，隔离进程树已清理；日志`.cache/maintenance-latest-synthetic.log`。未播放音频，不将启动/解析链路解释为解码或听感验收，也不将此检查替代前述日志压力回归。

上述后续验收时GraphFlow已恢复，增量索引调用成功；此前连接中断记载保留为历史。当前未发现新的离线开发阻塞项，待办仍为实体设备/物理网络、真实音源及人工听感验收，继续遵守用户暂缓要求。

未访问个人资料、运行真实音源、发现或控制实体设备，物理网络兼容及听感仍未验；未提交、推送或发布。
