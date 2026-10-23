# OR8 整批交付记录

2026-10-23最新交付：[v0.4.6](https://github.com/jun501389541/JJ-Music/releases/tag/v0.4.6)已公开，含PR #1/#2全部修复；完整测试、真实安装升级、远程签名/摘要与远程ZIP升级均通过，见[最终记录](../2026-10-23-reliability-final-delivery.md)。新增24项真实完整解码中19通过、5未通过，真实源更新仍无合格候选，人工听感保留待验。下文0.4.5交付过程保持历史原样。

2026-10-21。按用户“全部一起执行”授权，包含工程、自动验收、提交推送及受保护发布；人工听感明确保留待验。下列为当前结果，历史切片中的“未提交/发布”描述仅代表当时状态。

**当前结果：开发和发布交付已完成，[v0.4.5](https://github.com/jun501389541/JJ-Music/releases/tag/v0.4.5) 已公开，匿名API复核通过。人工听感、无有效候选的真实源更新/回退及下文明确列出的扩展范围仍未验证，OR8不因此整体标为全部通过。**

发布后交付及首批验收工具已合入main至c6b35d1，主分支CI39609631541通过；QQ真实歌单UI、受控缓存故障和绑定/快速按钮证据已补齐，详见[发布后按项验收](OR8-post-release-acceptance.md)。后文“未合并main”为发布时快照。

官方安装版应用内0.4.2→0.4.5更新已在[CI39619505135](https://github.com/jun501389541/JJ-Music/actions/runs/39619505135)通过16项检查，包含真实检查、下载、安装器自动重启及合成资料连续性，见[更新记录](OR8-updater-live.md)。无需重新发布0.4.5；真实源更新/回退仍缺合格候选，听感保持待验。

## 工程与审查

- `AuxiliaryRequests` 接入艺术家图片、歌曲详情补全和下载封面，复用分平台/能力健康状态及脱敏诊断，不增加重试层。诊断统一 lyric/playlist 命名。
- 默认磁盘桶容量合计 252.5 MiB；搜索内存缓存另计。不是全局历史目录扫描，也不保证事务临时文件的瞬间峰值。
- 超时信号计入服务失败，普通取消保持取消；受控回归先失败后通过，辅助套件 11/11。
- scratch 回收仅在 owner 与 child 均确认退出，路径/token/marker 匹配且无链接时运行；不扫描其他临时目录，不确定时保留。初始受控回归10/10，路径别名修复后11/11，最终CI亦通过。
- 全部待交付运行时代码经过独立审查，已修复确认的问题；最终 `npm run verify` 退出 0，93/93 套件及 5/5 门禁通过，包含类型检查与生产构建。日志 `.cache/or8-delivery/verify-final.log`。

## 自动验收

| 范围 | 实际证据 |
| --- | --- |
| 原生媒体协议生命周期 | 9 场景通过，零外部请求，`.cache/or8-delivery/native-media.log` |
| 生成 MP3/FLAC/OGG/WAV | 54 检查、12 次完整严格解码；PCM 摘要、备份恢复与不支持格式侧车回退，见 [格式记录](OR8-generated-assets.md) |
| 混合本地/网易/QQ 收藏与队列 | 生产 UI 66 检查，身份保持、去重、单条移除、不可用不切换到本地、DOM 拖拽，见 [混合记录](OR8-mixed-queue-favorites-ui.md) |
| 隐藏原生截图 | 7 张截图，暖启动 compositor 后读取实际页面，见 [截图记录](OR8-pending-native-screenshots.md) |
| 真实歌单模块 | 网易 22/22，QQ 10/10，预览→取消保持→再次预览→应用完整快照，见 [真实记录](OR8-live-delivery.md) |
| 真实歌单 UI | 网易22首、QQ10首，分别移除一首后预览→取消保持→再次预览→确认恢复完整快照，profile已回收，见[发布后验收](OR8-post-release-acceptance.md)及[真实记录](OR8-live-delivery.md) |
| 候选包 | 打包、asar 校验、独立合成源能力检查通过；源检查工具曾报告退出清理警告，不据此声称该工具正常关闭 |
| 官方旧便携包→候选 | 实际版本 0.4.2→0.4.3，22 检查，旧资料与哨兵摘要未变，应用正常关闭，见 [包记录](OR8-delivery-package.md) |

## 交付门禁

当前分支 `codex/online-reliability-delivery`。`a6f4041` 和 `v0.4.3` 已推送；首次 CI 完整验证在 scratch 清理套件失败，签名和 Release 已被门禁阻止，没有公开 0.4.3。保持标签不可变，修复后使用 0.4.4。提交不包含 `.cache`、`.graphflow`、真实源脚本、用户资料或凭据。

NSIS 真正安装/卸载/同路径升级验收放在一次性 GitHub-hosted Windows runner，在签名前执行。工具在日常主机和 self-hosted runner 上先拒绝，不改账户、不停止其他进程。失败阻止签名/发布；保留既有 U0、Environment 和签名密钥门禁。

以下保留交付过程中各次失败与修复记录；最终安装、远程六资产签名/摘要及公开发布结果见“最终版本0.4.5”。便携资料升级不代表在线更新安装完成。

CI 修复：原始临时路径与 realpath 直接比较会拒绝根路径别名（包括 Windows 8.3 拼写）。已先添加路径别名回归并观察失败，再将临时根与目录均规范化；原始入口和规范路径反复核验，仍拒绝 scratch 根及其后代链接。11/11 局部检查通过；日志 `.cache/or8-delivery/scratch-ci-{red,green}.log`。失败 CI [39548384414](https://github.com/jun501389541/JJ-Music/actions/runs/39548384414) 保留，不绕过门禁。

修复提交 `fe53af4`、新标签 `v0.4.4` 已推送。修复版完整验证 `verify-044.log` 退出0，93/93套件、5/5门禁；candidate-044打包和asar检查通过，官方0.4.2→0.4.4便携升级22项通过。新版 [CI 39549099994](https://github.com/jun501389541/JJ-Music/actions/runs/39549099994) 已启动，安装和签名结果待执行。

该次 CI 的 verify 已成功，真实首次 NSIS 安装退出0；验收脚本将 Windows ProductVersion `0.4.4.0` 错当成与 `0.4.4` 不同，签名和发布再次被阻止。失败报告 artifact `12322918796` 已读取。检查现仅接受精确 X.Y.Z 或 X.Y.Z.0，3个正例、6个反例及本地EXE元数据通过，脚本解析通过。无产品运行时代码变化。保持失败标签不变，下一版本为0.4.5；最终远程ZIP仍须实际升级验证后才能公开。

## 最终版本 0.4.5

提交 `b6b2c2a` 和标签 `v0.4.5` 已推送。[CI 39550013388](https://github.com/jun501389541/JJ-Music/actions/runs/39550013388) 两个job全部成功。最终CI日志已读取，93/93套件及5/5门禁通过。

一次性Windows runner真实执行：首次安装0.4.5、卸载保留合成资料、安装官方摘要匹配的0.4.2、同路径升级0.4.5，四次安装/卸载进程均退出0，EXE版本和NSIS marker匹配；settings/playlists/pending三份资料逐文件长度和SHA256在各阶段保持一致。报告13个阶段记录，`status=passed`，artifact `12323481319`；下载ZIP摘要 `d239ca96b04c91c316ec5d6a05b48ae2273172fe04b307da974fefd9f7512c29` 与API匹配，本地 `.cache/or8-delivery/ci-installer-final.json`。

签名与六项资产草稿上传成功后，已下载全部远程文件，逐项匹配API长度/SHA256，使用受保护Environment公钥独立验证更新清单签名、Setup的SHA256/SHA512及latest.yml，再运行资产集合检查，两项命令均退出0。

远程ZIP实际执行官方0.4.2→0.4.5升级，22项通过，报告 `.cache/or8-delivery/601a8ee5-369d-4281-9b0e-91527f348958-portable-report.json`；旧profile和哨兵未变、应用正常关闭、自有根已回收。此次结果绑定远程ZIP，不沿用本地候选摘要。

Release `419195081` 于 `2026-10-21T05:43:47Z` 公开。更新说明后观察到草稿关联变为untagged，发布前重新核验确切ID、六资产摘要和既有v0.4.5标签的提交 `b6b2c2a3b51d433668aa79de929df82e14994d4a`，明确绑定该标签后公开；没有覆盖或重建Git标签。随后匿名公开API返回draft=false、同一ID和六项相同资产，凭据 `.cache/or8-delivery/published-verification.json`。

| 远程二进制 | SHA-256 |
| --- | --- |
| Portable ZIP，145883325 bytes | `c45fbcb1009fbdc0897b2128b443f0d6a963b4be7317b6cf8f2d305fff5df319` |
| Setup，103642729 bytes | `709387aef5fbc0fee15de5a2e24f0824d6e5b7f0ed678e13b8d9a672351cbe2c` |

Git分支 `codex/online-reliability-delivery` 已推送，发布来自 `b6b2c2a`，本次未合并main。0.4.3/0.4.4为失败验收标签，没有公开相应Release。更新私钥、U0门禁、日常资料和原始源保持不变；图谱和本地报告/包未提交。

## 保留边界

真实 HYW updateURL 本次返回非脚本，未生成候选，未伪造真实更新和回退成功。平台真实故障/限流、其他编码变体、全部源全曲身份与实际音质、日常交互及人工听感仍按相应记录保留；合成回归不能替代这些证据。没有第三平台扩展或全局缓存仲裁器。
