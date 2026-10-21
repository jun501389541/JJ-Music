# OR8：损坏待写入资料的生产界面验收

2026-10-17，对应 RR08、RR16，补齐 [读取故障保护](OR8-pending-read-recovery.md) 当时仅静态核对的生产界面启动与恢复证据。

## 方法

新增 tools/probe/pending-assets-ui.mjs。执行 `node tools/probe/pending-assets-ui.mjs` 会先用 electron-vite 构建当前生产源码，再创建专用临时 profile，写入损坏的 pending-assets.json 和合成音频哨兵。独立 Electron 测试入口安装离线守卫、隐藏本次测试窗口后，加载生产 main/preload/renderer；通过本地 CDP 操作真实设置页及 IPC。

守卫覆盖主进程 globalThis.fetch 与 Chromium HTTP(S)，不等于拦截 Node http/https/net 的全面断网沙箱。本次没有源脚本、扫描目录或真实媒体输入。探针核对实际 data.location 指向自有 profile、sources.list 为空；只结束自己创建的 Electron 进程，并在父路径、fixture 前缀和 realpath 校验后删除该临时目录。

## 实际结果

最终运行 ID：6e6c06dc-478a-48cc-908c-383e15bffba8，Electron 42.11.8，退出0、报告 passed，15项检查通过，profileRemoved=true。

- 损坏附属资料没有阻止生产应用启动。
- 设置页显示失败说明，未显示成空队列；“全部写入”和“全部丢弃”均禁用，损坏原文没有出现在界面。
- 强制调用 pending、writePending、discardPending 也拒绝，原损坏字节不变。
- 修复专用测试文件、离开后重新进入设置页，同一进程显示1项待写入，两个按钮恢复可用；不需要重启服务。
- 点击真实“全部丢弃”后，界面显示空队列，磁盘 entries 为空，合成音频哨兵未修改。
- 无 renderer exception，守卫记录的外部请求尝试为0。

损坏态与恢复态截图均已人工查看，标签和禁用/可用状态符合断言。当前报告及逐运行报告、截图、构建和主进程日志保存在 .cache/pending-assets-ui/；最新执行输出为 .cache/pending-assets-ui-run.log。每次运行开始即写 starting，启动/断言/清理失败均记录 failed，截图和日志按 runId 区分。

首两次探针未进入应用：分别暴露 Windows NODE_OPTIONS 路径转义、Electron API 在 Node 预加载阶段不可用的问题。修正测试入口后才取得有效UI证据；两次失败的临时资料均已回收，没有将其当成产品回归或通过结果。最终探针补充逐运行报告及版本记录后重跑通过。

独立只读复核未发现P1/P2；node --check 与 git diff --check 通过。没有修改生产代码，因此未重复完整 verify；本轮新鲜验证为生产构建与上述15项隔离UI检查，前轮90/90套件记录不计作本轮重跑。

## 保留边界

后续扩展：生成WAV扫描、候选暂存回读、清缓存保留及真实“全部写入”侧车路径已补验，并发现、修复候选入口缓存版本缺失。扩展探针28项通过，详见[确认写入记录](OR8-pending-write-ui.md)。上文15项和未修改产品代码是本页原轮次观察，不改写为后续结果。

这是生成资料的集成验收，不代表损坏的真实资料已自动修复，也不替代人工听感、作者日常操作、真实源更新回退或安装升级验收。测试窗口隐藏、结尾结束测试进程，不验证系统可见窗口展示或正常退出流程。本轮没有提交、推送、安装或发布。
