# OR8：应用异常退出后的受限宿主生命周期

日期：2026-10-16。接续 [UI 交互验收](OR8-ui-playback.md) 暴露的硬退出边界。

## 复现与实现

新增 `source-owner-lifecycle.test.mts`，运行生产 TypeScript 打包的 SourceRuntimeHost / source-host，使用作者生成的零网络源和专用临时目录。Windows 自动传输必须确认为受限文件模式。测试先让所属父进程阻塞事件循环，再只强制结束该父进程，观察记录到的宿主 PID。

修复前：主进程退出后等待 6 秒，宿主仍在运行，断言失败；测试清理了自己创建的宿主与临时目录。修复后：相同测试通过，卡顿时宿主存活，父进程死亡后自行退出。

共享运行时在初始化元数据中写入实际应用 `ownerPid`，不使用 runas / cscript 启动链的父 PID。文件模式宿主每秒对 ownerPid 发信号 0，只有系统明确返回 ESRCH 才自行退出。权限不足、未知探测错误和缺失/无效 ownerPid 不作为死亡依据；不依赖墙钟或父进程定时续约。

原生 `_kill` 与 `reallyExit` 在 process 安全锁定前私有捕获，因为绑定公开 kill / exit 包装器仍会访问随后被禁用的底层属性。信号 0 不结束被探测进程；宿主只结束自己。原生 errno 通过 getSystemErrorName 解释，避免 Windows libuv ESRCH 与 os.constants.errno 编号不同导致检测失效。脚本的 kill / _kill / exit / reallyExit 仍被禁止。

## 验证

- 回归 4/4：Windows 受限宿主的父进程卡顿与死亡、权限不足、旧初始化无 ownerPid、无效 ownerPid；后三项也检查脚本进程操作限制。
- 刚构建的 `out/main/source-host.js` + Electron 二进制受限启动：同一个主进程死亡回归 1/1，约 3.08 秒完成整个场景。测试 owner 是隔离 Node 控制进程，经共享运行时启动生产 Electron 宿主；没有强杀用户正在使用的应用。
- 本地生产宿主日志：`.cache/online-reliability-owner-electron.log`。完整离线门禁日志：`.cache/online-reliability-owner-verify.log`。
- 本轮 `npm run verify` 退出 0：类型检查、生产构建、85/85 离线套件与 5/5 门禁通过；`git diff --check` 通过。GraphFlow 已增量索引。

## 保留边界

- 检测依赖宿主事件循环；脚本自身卡死时，存活父进程仍由既有超时/终止机制处理。父进程和宿主同时卡死不在本次通过范围内。
- 极快的 PID 重用可能延迟宿主自退；不会向重用 PID 发终止信号。权限不足宁可保留进程，也不误杀健康宿主。
- 生产代码不让宿主递归删除 scratch，也不扫描或删除历史临时目录。测试的专用目录由测试控制进程校验范围后清理；应用被强杀仍可能留下临时文件。
- 本次只修改文件模式的反向存活检测；没有宣称所有平台、IPC、所有衍生进程或任意崩溃场景均已覆盖。
- 未执行真实音源、外部端点、人工试听、安装或发布；保留已有 OR8 尚未验收项。
