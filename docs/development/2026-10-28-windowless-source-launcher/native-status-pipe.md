# 原生状态管道断开验收

日期：2026-10-29。补齐WT08的真实句柄断管检查，复用现有TestBarrier测试构建；生产helper及TypeScript逻辑没有修改，也没有新增生产故障开关。

`windowless-source-launch.mjs --startup-race`在已有六组检查后增加一组：创建独立helper，等待既有15秒暂停创建屏障写出宿主PID并确认该PID存活，再关闭父进程stdout读取端。恢复后helper状态写入遇到断管，必须在22秒有界等待内无信号退出、退出码1、stderr为空，且已知宿主PID消失。所有通过断言发生在finally回收之前，不能靠测试清理制造通过。

正常命令退出0，包含新增的 `PASS broken native status pipe fails helper and reaps the known host`；日志 `.cache/native-broken-pipe.log`。

负控制 `--startup-race --keep-status-pipe`保留读取端，helper和合成宿主继续运行，因此在 `broken status pipe must fail the helper` 等待处超时，命令按预期退出1；finally终止本次helper并等待已知宿主消失。日志 `.cache/native-broken-pipe-negative.log`。没有将这次预期失败解释为产品故障。

独立只读复核无Important/Critical问题，Node语法及git diff --check通过。此次只增加原生合成probe，已运行完整相关原生场景，不重复无关产品verify和打包；现有CI的startup-race命令会自动包含新检查，但此前远端成功记录早于本次probe变更，不能算作新检查的远端证据。

边界：此项证明真实状态管道断开时helper失败及已知宿主回收，不是全部API故障注入或任意后代组合结论。子树回收的其他证据保持既有独立场景。未运行真实音源、安装器、真实播放或人工窗口验收。
