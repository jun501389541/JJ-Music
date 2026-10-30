# DLNA设备面板的视口与滚动

本轮继续既有D6界面可用性验收；保留此前日志轮换和选择前提示修改，不提交/推送/发布，不搜索或控制真实设备。

## 复现与修复

既有面板没有高度约束或滚动，设备名称也没有断词保护。在940×620视口（应用声明最小窗口）中加入24项长名称布局夹具，面板顶部为-1167px，内容高度1716px，横向溢出1248px，首项与操作区无法正常访问。

修复限定面板高度为视口高度减140px，在面板内纵向滚动；网格列允许收缩，按钮/选择框限制宽度，长名称可换行。未改变设备数据、按钮处理、播放器或IPC。正常窗口和空设备状态保持原流程。

## 实际验证

- 修改前：同一成品布局探针失败，证据`.cache/dlna-ui-smoke/run-UbtpeX/layout.json`及`layout-top.png`。
- 修改后：Node/Web类型检查和目录打包通过，候选`.cache/dlna-layout-candidate/win-unpacked`。
- 原夹具重放通过：面板在940×620视口内、没有横向溢出，存在内部纵向滚动，最后一个长名称条目可滚动到达；截图已目视检查。证据`.cache/dlna-ui-smoke/run-ZJwEej`。
- 现有普通成品探针通过，证据`.cache/dlna-ui-smoke/run-aEOpAS`；两轮发现调用0、console错误0，隔离进程均已结束。
- 日志`.cache/dlna-layout-before.log`、`.cache/dlna-layout-after.log`、`.cache/dlna-layout-normal.log`、`.cache/dlna-layout-typecheck.log`与`.cache/dlna-layout-package.log`。

夹具是将带真实组件样式作用域的DOM按钮克隆为24项，清除禁用状态以测量布局；克隆不含Vue事件监听，未点击，没有替换生产API或伪造发现响应。它只证明渲染与滚动，不证明真实设备数据流、选择成功或设备控制。QA脚本留在忽略目录`.cache/dlna-layout-probe.mjs`，未增加镜像实现的单元测试。

沿用本会话Browser初始化EPERM后已授权的Electron CDP成品检查路径。此次仅CSS，不重复完整离线套件；此前140/140和5/5为上轮日志修复证据，不当作本轮重跑。真实设备/音源/听感仍未验，正式0.7.0资产不变。
