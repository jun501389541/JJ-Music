# DLNA搜索结果与网卡绑定

本轮继续检查未发布累计修改，发现OutputDevicePicker在选择另一张网卡后仍显示旧设备；迟到搜索也可写回旧设备并提前结束新搜索的忙碌状态。

## 修复

选择网卡时同步清空设备列表并递增搜索代次。搜索只接纳当前代次的设备、普通错误和结束状态；搜寻与输出切换的忙碌状态分开计算，避免取消搜索状态时释放输出切换锁。停止未确认是全局风险，网卡变化或旧搜索失败均不得隐藏该提示。

只作UI结果隔离，不宣称取消已发起的主进程发现；后端仍依既有预算和显式调用管理网络。未改播放引擎、设备协议或媒体租约。

## 回归方法和当前证据

`tools/build-test.mjs`使用已安装的Vue SFC编译器和生产esbuild配置编译真实OutputDevicePicker脚本，仅替换player音频边界；Vue保持external，使测试effectScope可以释放真实watch。合成window桥接不调用IPC或网络。该回归验证组件脚本状态，不替代成品渲染或实际设备验收。

- RED：基线组件4项用例中3失败，分别为旧设备残留、迟到结果和忙碌状态、旧错误污染；输出切换锁用例基线通过。
- GREEN：加入停止未确认保护用例后5/5通过，使用相同生产脚本打包入口。
- 累计`npm run verify`退出0：141/141离线套件、5/5门禁，Node/Web类型检查及生产构建通过，日志`.cache/dlna-picker-cumulative-verify.log`。
- 独立只读复核涵盖组件代次、busy锁、Stop提示、SFC测试构建及此前日志轮换，未发现Important回归；复核未代替实际运行验证。
- 目录候选`.cache/dlna-picker-candidate/win-unpacked`构建及版本/原生资源校验通过。普通面板证据`.cache/dlna-ui-smoke/run-LaNSow`，940×620/24项长名称布局证据`.cache/dlna-ui-smoke/run-ffkBf2`均通过；发现调用0、console错误0，两个隔离进程均清理确认。
- 成品检查沿用本会话Browser初始化EPERM后已授权的Electron CDP回退；未搜索实际设备。布局夹具只验证DOM和滚动，网卡异步状态由真实SFC脚本回归证明，两者分别记录。
- 日志`.cache/dlna-picker-package.log`、`.cache/dlna-picker-resources.log`、`.cache/dlna-picker-ui.log`与`.cache/dlna-picker-layout.log`。测试替身仅存在于out/test，打包配置明确排除该目录，不进入正式产品桥接。
- 早期收尾GraphFlow索引和结果回填返回`Transport closed`；后续网卡刷新任务中服务恢复，增量索引与结果回填已补做。未修改全局配置或图谱存储。

源码、测试、此前日志轮换/提示/布局修复均保留`codex/source-log-rotation`，未提交推送或发布；正式0.7.0资产不变。真实音源、实际发现和设备控制未执行。
