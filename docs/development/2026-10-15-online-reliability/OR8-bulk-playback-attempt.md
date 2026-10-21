# OR8 历史首字节通过项的扩展播放复验

日期：2026-10-16。

## 范围

此前媒体报告中有 24 个“脚本静态准入通过、该平台地址解析通过、媒体首字节验证通过”的组合，分属 16 份源脚本。本轮只筛选这些组合，静态拒绝、初始化失败及从未取得媒体响应头的组合均未执行。所有候选源在本轮执行前的 SHA-256 与历史摘要一致。

首次在受限执行沙箱内用隔离 Electron 的静音 `HTMLAudioElement` 对 24 项逐一播放 8 秒时，Electron 42.11.8 在应用入口前以 `2147483651`（`0x80000003`）退出。随后六项 FFmpeg 补测也都在取得地址前失败，没有读取音频字节。后续隔离对照确认这是执行沙箱阻断默认 Electron 与 Windows 受限宿主启动，并非候选源或探针参数本身；获批宿主执行中的完整复验结果见下文。

随后尝试使用生产 `SourceEngine`、既有公开 URL/DNS 守卫及 FFmpeg 内存管道补做最多 8 秒解码。前 6 项在地址解析阶段未拿到可用媒体地址，读取音频字节数均为 0，未进入 FFmpeg。为确认是否是源运行时问题，对 HYW 源单独执行了不请求曲目地址的启动检查：`supportsProvider` 为 false、活动源列表为空，隔离 source store 记录“音源初始化超时（15s）”。这说明 HYW 的本次失败不能归因为媒体接口拒绝。其它三个源的对应启动状态没有单独验证，因此不把这五个组合判为源故障；批量探针在第 6 项后停止，剩余 18 项未运行。

## 隔离启动诊断

为区分探针配置与宿主限制，先后在受限沙箱及获批宿主执行环境中补做了不加载任何真实音源的启动对照。Electron profile 和合成 `SourceStore` 位于忽略目录 `.cache/online-reliability-or8-decode/`；生产 `SourceRuntimeHost` 的协议 scratch 按实现创建在系统临时目录，均经正常 teardown 清理。运行结束后二十分钟窗口内未发现残留 `jj-source-*` 目录：

| 路径 | 结果 | 解释范围 |
| --- | --- | --- |
| 受限沙箱内 Electron 空应用，默认参数 | `0x80000003`，主脚本入口标记未出现 | 沙箱进程限制阻止默认 Chromium sandbox 启动；`--no-sandbox` 可启动，但不用于最终播放复验 |
| 获批宿主执行中的 Electron 空应用，默认参数 | 退出码 0，打印主脚本入口与 ready，版本 42.11.8 | 默认 Electron 启动正常，无需放宽 Chromium sandbox |
| Electron `ELECTRON_RUN_AS_NODE=1` | 退出码 0，版本 42.11.8 | Electron 二进制的 Node 模式可启动 |
| 受限沙箱内零网络合成源，`SourceEngine` `auto` | 15037ms 后初始化超时，源被禁用 | 受限执行环境未能完成 Windows 文件传输宿主启动 |
| 同一合成源，`SourceEngine` `ipc` | 79ms 初始化成功并登记网易云能力 | 只确认引擎与夹具逻辑，不用于真实源验收 |
| 获批宿主执行中的零网络合成源，`SourceEngine` `auto` | 642ms 初始化成功，无错误 | 生产 Windows 受限 `runas` 文件传输链正常 |
| Secondary Logon (`seclogon`) | 获批宿主查询状态为 `RUNNING` | 受限沙箱内此前的服务查询返回 Access Denied；服务状态正常 |

对照确认初次失败来自受限执行沙箱：获批宿主中默认 Electron 和生产 `SourceEngine auto` 都正常，`seclogon` 正在运行。没有把真实源改走 `ipc`、没有取消 Chromium sandbox，也没有降低 source-host 的受限 token。

## 沙箱内首次尝试记录

| 源脚本 | 平台 | 本轮观测 | 字节 | 摘要 |
| --- | --- | --- | ---: | --- |
| HYWmusic_公益版_v1.0.3.js | 网易云、QQ音乐 | 受限沙箱中未拿到地址；合成源 `auto` 同样超时 | 0 | 后续获批宿主复验通过 |
| gdstudio音乐源 v1.0.1（仅支持网易）.js | 网易云 | 受限沙箱中未完成地址解析 | 0 | 后续获批宿主复验通过 |
| lx-玉宁熙1.2.5.js | 网易云 | 受限沙箱中未完成地址解析 | 0 | 后续获批宿主复验通过 |
| stellarwave-v3.2.0.js | 网易云、QQ音乐 | 受限沙箱中未完成地址解析 | 0 | 后续获批宿主复验通过 |

前 6 项的临时 source store 已清理，源脚本没有被修改，也没有写出音频文件或读取播放器日常资料。该次沙箱内结果保存在忽略版本管理的 `.cache/online-reliability-or8-decode/decode-all-report.json` 与 `decode-canary-report.json`；历史单源报告仍在 `electron-playback-report.json`。

## 获批宿主扩展播放复验

在获批宿主执行环境中，通过原始 Electron 参数（未使用 `--no-sandbox`）重跑 24 个候选。每项再次通过静态准入与 SHA-256 对照，使用生产 `SourceEngine auto` 受限宿主、`SourceMediaProxy` 和注册后的 `jjstream` 协议，静音播放“孤勇者”8秒：

| 项目 | 结果 |
| --- | --- |
| 总体 | 24/24 通过，涉及16份源脚本；网易云13项，QQ音乐11项 |
| 播放 | 每项8.01–8.10秒，`readyState=4`，无 HTMLMediaElement 错误 |
| 清理与完整性 | 24/24 流清理、临时 source store 清理通过；源文件执行前后 SHA-256 一致 |
| 副作用 | 未写出音频文件；只用独立 profile/store，不读写播放器日常资料 |

逐项报告：`.cache/online-reliability-or8-decode/electron-playback-all-report.json`。这验证的是隔离 Electron 中真实源脚本的短时静音媒体播放与代理清理，不代表完整曲目、录音身份/音质、生产 UI 交互或人工听感通过。

## 验收边界

- 既有 HYW 源网易云和 QQ 音乐样本各 8 秒 FFmpeg 解码及隔离 Electron 静音播放仍为通过证据，详见 [短时解码记录](OR8-short-decode.md)。
- 24 项覆盖16份历史媒体头通过的源，不覆盖其它未取得媒体头的源，也不覆盖完整曲目、录音身份/音质或人工听感。
- 首次受限沙箱的6个地址尝试没有媒体字节；后续获批宿主复验已通过24/24。HYW两平台固定样本随后新增完整传输与严格FFmpeg解码通过，见[全曲解码记录](OR8-full-decode.md)；其他源全曲解码、产品 UI 日常交互、人工听感与安装/升级仍待验收。
