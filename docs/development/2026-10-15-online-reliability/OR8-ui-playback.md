# OR8 隔离生产桌面应用交互检查

日期：2026-10-16。按[交互检查计划](../../superpowers/plans/2026-10-16-online-reliability-ui-playback.md)，复用已获授权且 SHA-256 未变的 HYWmusic_公益版_v1.0.3.js 与两平台原固定样本。只补自动化集成证据，OR8 整体和作者日常操作仍不标为通过。

## 执行边界

- npm run build 在获批宿主环境退出 0；运行当前 out/main、out/preload、out/renderer 生产产物，Electron 42.11.8、应用 0.4.2。
- 新建空 profile，通过实际 data.location IPC 确认数据目录，初始源列表为空。没有复制、读取或修改日常资料。媒体音量为零且窗口静音。
- 测试启动入口先安装观察器再导入生产主程序，并将应用路径设回仓库根目录。它覆盖生产主程序/预加载/Vue/源宿主/媒体引擎的集成，不是发布安装包的正常启动验收。CDP 驱动原生 Electron 窗口，截图尺寸为 2558×1640。
- 通过正式 sources.import/toggle 导入启用原 HYW；生产 SourceEngine auto 仍用 Windows 受限宿主。初始队列经生产 player store 动作建立；下一首/上一首与停用开关通过实际 DOM 控件操作。
- 唯一替代的业务 IPC 是自动 sources:verify-platform：本次共返回 5 次明确 unknown，防止后台抽测其它平台。musicUrl、source toggle、媒体协议和播放 store 未替换。Main fetch 与 reader 只增加透传观察，记录字节、EOF、取消和信号，不替换真实响应或重定向/DNS 守卫。

## 最终观察

最终运行 runId 为 1792156801591-23952，脚本退出 0，报告 passed，7 个检查点均完成。

| 操作 | 实际证据 |
| --- | --- |
| 初次网易样本播放 | playing=true、loading=false，时钟达到 0.410667 秒；原条目、解析 original 与 actual 身份一致 |
| 连续下一首→上一首→下一首 | 最终 QQ 条目时钟达到 0.403447 秒，无播放错误；原条目与解析身份一致，没有被旧选择回填 |
| 把当前 QQ 条目从索引 1 移到 0 | 当前曲保持 QQ，解析身份不变，时钟继续达到 0.612426 秒；本项使用生产 moveInQueue 动作，不宣称 UI 拖拽已验证 |
| 源管理实际停用开关 | 后端源已停用且可用平台为空；当前 QQ 上游在尚未 EOF 时从 cancelled=0/Abort=false 变为 cancelled=1/Abort=true，字节停在 3,883,008；此观察先于随后切歌 |
| 停用后再点击下一首 | 选择回网易条目，playing=false、loading=false、出现缺失音源反馈；新增媒体请求 0，原队列两个条目仍保留 |
| 清理及异常 | 两个 jjstream 请求最后均以预期 ERR_ABORTED 结束，Chromium 活动登记归零；Runtime console error=0、exception=0；应用退出 0，专用 profile 已清理，原 HYW 哈希未变 |

playing.png 和 disabled.png 均已实际查看：应用主界面与播放器正常渲染，无空白页或框架错误遮罩；源管理开关处于停用状态，底部出现缺失音源错误，播放时钟归零。没有由截图推断真实听感。

## 上游撤销与缓冲的区别

加强检查曾错误地要求：停用后 Chromium webRequest 活动登记必须在五秒内清零。该断言失败，当时播放器仍在消耗缓冲数据。随后增加上游 fetch/reader 透传观察，确认真实活动上游已经收到 Abort 并取消一次，但 Chromium 的一个请求登记仍存在，已缓冲声音也可继续；直到下一次切歌后该登记结束。

因此撤销证据以上游 reader/信号为准，不能把 Chromium 登记数量直接当作应用上游请求数量。当前规范要求源版本失效、在途隔离及禁止停用源的新播放，没有规定立即清空已有音频缓冲。本次保留该行为；若期望停用后立即静音，需要明确新的播放器交互规则，不能宣称本轮已实现。

## 失败观察与限制

- 沙箱构建读取 browser-shims.ts 时 EPERM；宿主运行同一构建通过，没有修改源码规避限制。
- 测试初版通过 NODE_OPTIONS 预加载时 Electron API 尚未就绪，另一次 CDP 过早读取尚未出现的 DOM。修正测试启动入口与空值等待；这些失败在音源执行前发生。
- 一次增加观察器后的真实运行在初次网易播放阶段失败，媒体请求数为 0；报告 report-1792156651191-43892.json 保留，未将失败归因于版权、永久源故障或确定限流，也没有换源/换曲。最终诊断运行通过不抹去此观察。
- 上述失败时，旧探针直接强杀应用主进程，收尾发现一条遗留受限源宿主。已比对创建时间、失效父进程、专用 scratch 和初始化 apiId 与该失败运行对应，再清理该实例及其专用目录，没有操作其他进程。探针失败路径现改为先通过已有窗口关闭 IPC 正常退出，且记录应用 PID，避免可通信时直接强杀。
- 独立零网络清理检查使用作者生成的源，初始化后故意抛出 controlled-cleanup-check；cleanup-report.json（runId 1792157209394-19556）记录应用退出 0、controlledFailureCleaned=true、profileCleaned=true。随后只读进程检查相关宿主为 0、遗留 scratch 已不存在。它证明当前可通信失败路径的正常清理，不证明应用被强杀或失去响应后所有受限子进程均能自动回收；该硬退出边界需单独受控复核。
- 代码没有提供“永远不会错播”的证明。本次只有两条固定样本、一次连续控制序列；未验收随机长时间操作、真实 URL 故障恢复、绑定到另一音源、混合本地在线收藏或作者日常使用。

本地产物位于忽略目录 .cache/online-reliability-ui-playback/：probe.mjs、真实交互 report.json、按 runId 保存的 report-*.json、playing.png、disabled.png、独立的 cleanup-report.json；启动日志与诊断日志仅留本地。最新报告不含媒体 URL、响应头、源原文或原始错误文本，原始歌曲 ID 只留本地，不复制到本文。

本轮仅新增验证计划、一次性探针和验收记录，没有修改生产源码；执行了探针语法检查和生产 build，没有新增完整 verify 运行、提交、推送、安装或发布。人工听感、作者日常操作、真实更新回退和安装升级仍待验收。
