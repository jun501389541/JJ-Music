# OR8 — 集成证据与待人工验收

2026-10-16。首批平台为用户选定的网易云（wy）与 QQ 音乐（tx）。OR0–OR7 代码和离线证据已交付；随后用户明确授权“每个音源都试试吧，你自定义来测试就行”。21份源已逐项静态检查，允许者已实际运行，并对地址成功项补充音频首字节抓取。本文件保留失败与人工未验收项，**不将 OR8 整体标为通过**。

## RR01–RR20

“离线覆盖”仅表示所列受控路径，不能代替真实服务或人工操作。

| 场景 | 离线证据 | 真实/人工状态 |
| --- | --- | --- |
| RR01 有旧值后超时/结构错误 | catalog-reliability、online-resource-cache，旧值带 stale 与安全错误 | 两平台目录各一次真实搜索通过；真实故障后的缓存UI未验收 |
| RR02 首次失败与合法空 | catalog-reliability、diagnostic-cli，miss/空结果不混淆 | 未验证实时空结果 |
| RR03 远程歌单空/部分分页 | playlist-snapshot、playlist-refresh、OR6 合成 UI；完整候选才确认，空不自动清列表 | 待选真实歌单 |
| RR04 服务失败与单资源缺失 | online-capability-health、capability-health-integration，资源/档位不冷却整个平台 | 未制造真实限流/故障 |
| RR05 429/共享预算 | online-reliability-policy、capability-health-integration、player-regression、diagnostic-check | 实时 Retry-After 未验证 |
| RR06 共享请求取消 | online-resource-cache，独立取消与最后订阅终止 | 待真实 UI 快速切换 |
| RR07 旧请求/源变更 | source-revision、source-cache-invalidation、playlist-refresh，代次和 CAS 阻止迟到回填 | 待可信实际源更新 |
| RR08 损坏/写失败/配额 | online-resource-cache、cover-byte-store、online-asset-cache、playlist-refresh | 主机离线文件路径覆盖，未做真实磁盘耗尽 |
| RR09 地址/格式/拒绝/低档 | playback-reliability、source-media-proxy、player-regression，双时钟和原预算只恢复一次 | 实际遇到403、抓取失败及再次解析失败；全曲解码/恢复和听感未验收 |
| RR10 歌词失败/缓存/取消 | local-lyric-cache、online-asset-cache、online-capability-health | 待实际歌词服务 |
| RR11 半开/手动限频 | online-capability-health、capability-health-integration、OR6 合成 UI | 无后台扫平台，未人工制造429 |
| RR12 更新失败/停用/回退 | source-revision、source-updater、OR6 合成 UI，10 个运行版本回归 | 实际源初始化和解析见下表；实际更新/回退未执行 |
| RR13 适配器修订/schema | catalog-reliability、online-resource-cache，旧修订不冒充新成功 | 未发布新版本 |
| RR14 敏感错误/报告 | online-diagnostics、diagnostic-check、diagnostic-cli、diagnostic-default；白名单重建 | 无上传，真实私有错误未采集 |
| RR15 默认与显式真实模式 | diagnostic-default 进程守卫、diagnostic-cli 参数准入；默认不读日常源、不联网 | 用户扩大授权后，显式运行20份实际源，1份静态拒绝不执行 |
| RR16 本地/手工/待写入 | local-lyric-cache、online-asset-cache、asset-export、OR6 合成 UI | 待作者实际资源操作 |
| RR17 回拨/无效时间 | online-resource-cache、playback-reliability、player-regression | 用注入时钟验证，不修改系统时间 |
| RR18 合成与真实分级 | diagnostic-check/default、source-update-state、OR6 UI；真实初始化/解析/音频头另计 | 真实首字节见下表，不代表全曲/身份/实际音质或听感通过 |
| RR19 切歌/绑定/收藏 | player-regression、online-resolver、playback-router、provenance-persistence、scan-concurrency | 待作者日常快速操作 |
| RR20 关闭/清除/用户资料 | online-diagnostics、online-asset-cache、OR6 合成 UI；关闭保护仍保留基础路径 | 待实际资料验收 |

## 人工验收顺序

1. 已按用户授权完成目录样本选取、21源静态与允许源的初始化/解析，另做音频首字节抓取。复测时仍用独立配置与显式模式，不能将合成结果或音频头成功当作全曲播放。
2. 在应用中对两平台各试听所选歌曲，核对条目身份、实际平台、目标/实际音质和音频是否正常；分别记录媒体加载与人工听感，不能仅据地址成功打勾。
3. 快速切歌、取消、重排队列和切换绑定源，检查旧曲不续播、不把成功计入另一条目；混合本地/在线收藏仍保持原条目身份。
4. 对已保存测试歌单查看刷新差异，先取消、再明确应用；部分获取与合法空结果须给出可理解反馈，不能自动覆盖列表。
5. 用测试资源确认本地歌词/手工封面优先，待写入选择在清普通缓存后保留，关闭诊断和可靠性策略后仍能使用基础播放。
6. 对明确可信测试源执行更新和回退，核对稳定身份、保持停用、初始化反馈及播放未验证；之后再单独试听，不以初始化成功代替播放验收。

每项记录执行时间、平台/能力、适配器修订或脚本摘要、分级状态及失败关联；实际曲目与路径保留在本地测试配置，不复制到可分享的诊断报告。

## 保留边界

- 现有在线辅助路径尚非全部纳入新健康策略，例如艺术家图片、下载内部抓取、质量徽标补全；没有宣称全链路诊断均有完整关联 ID。
- 缓存沿用按桶和二进制 LRU 配额，没有新增跨所有历史辅助缓存的全局磁盘仲裁器。普通缓存损坏不删除用户资源。
- 实际源/平台目录/地址/音频头证据见下节；仍无全曲解码、人工听感、发布安装/升级验收。不扩展第三个平台，不提交推送、打包安装或发布。
- 既有历史阶段文档的“后续阶段待实施”是当时快照；以本文件和 OR6/OR7 的更新状态为准。

## 本轮最终检查

| 检查 | 已读取的实际证据 |
| --- | --- |
| OR6 全量 | `.cache/online-reliability-or6/verify.log` 退出0，75/75套件、5/5门禁、类型与生产构建通过。 |
| OR6 合成 UI | `ui-final.log` 退出0，更新/回退/保持停用/验证等级、歌单与平台缓存保留、开关/清除；截图已查看，无renderer错误、无外部fetch。 |
| OR7 最终全量 | `.cache/online-reliability-or7/verify-final.log` 退出0，78/78套件、5/5门禁、类型与生产构建通过；修复复核发现后运行。 |
| OR7 局部复核回归 | `review-complete.log` 15/15：准入、取消/总预算、分级/脱敏/版本、两项误报与正常/空/部分契约。 |
| OR7 默认实际进程 | `default-final.log` 2/2；在全量后仅补充CLI私有文件错误测试，未再改产品/工具代码，守卫与错误脱敏均通过。 |
| 差异保护 | OR6 `preservation.json` 30份tracked、40份untracked；OR7 44份tracked、49份untracked；unexpected均为空。 |
| 静态检查 | `git diff --check` 及三个新/改诊断入口 `node --check` 通过；GraphFlow增量索引已执行。 |

尚未执行：全曲解码和实际应用播放、人工听感、日常交互确认、安装/升级/发布。不以历史实际profile E2E、合成成功或音频首字节补齐这些项。

## 授权后的21份实际源检查

用户指定目录后明确授权全部脚本并委托选样本。本轮用两平台现有搜索适配器各查询一次“孤勇者”，从实际返回中选取歌曲和原平台元数据，保存于忽略版本管理的本地测试配置；没有编造平台ID，也未改日常配置。两次目录搜索分别通过（wy-1、tx-1）。

21份均保存原始SHA-256并静态校验。20份通过既有准入后串行运行，每份独立临时资料、每平台一个固定样本、该源共享60秒；1份被既有规则拒绝而未执行。首轮19份初始化成功，网易样本16份解析成功、QQ样本13份解析成功。

对至少一个平台解析成功的18份源，另做同曲受限首字节验证：再次取得当前地址后，通过现有公开地址/重定向/DNS约束发Range请求，最多在内存保留1024字节并立即取消。不写音频文件、不下载整曲、不播放。分别识别MPEG、MP4等格式头，不验证歌名/录音身份、整曲可解码、码率/无损真实性或人工听感。网易13份、QQ11份读到格式头；8份两平台都通过。

| 文件 | 静态 | 初始化 | 网易解析 | QQ解析 | 网易首字节 | QQ首字节 |
| --- | --- | --- | --- | --- | --- | --- |
| HYWmusic_公益版_v1.0.3.js | 通过 | 通过 | 通过 | 通过 | 通过 | 通过 |
| gdstudio音乐源 v1.0.1（仅支持网易）.js | 通过 | 通过 | 通过 | 失败 | 通过 | 未测 |
| lx-玉宁熙1.2.5.js | 通过 | 通过 | 通过 | 失败 | 通过 | 未测 |
| stellarwave-v3.2.0.js | 通过 | 通过 | 通过 | 通过 | 通过 | 通过 |
| stellarwave-v4.0.0.js | 通过 | 通过 | 通过 | 通过 | 通过 | 通过 |
| xinghai-music-sourcev2.3.13.js | 通过 | 通过 | 通过 | 失败 | 通过 | 未测 |
| 全豆要-聚合音源-V4.1（酷狗挂了）.js | 通过 | 通过 | 通过 | 通过 | 通过 | HTTP 403 |
| 墨澜音乐源v2.3.0.js | 通过 | 通过 | 通过 | 通过 | 通过 | 通过 |
| 屿溪-终章.js | 通过 | 通过 | 失败 | 通过 | 未测 | 通过 |
| 幻音音源 v3.js | 通过 | 通过 | 通过 | 通过 | 抓取未通过 | 抓取未通过 |
| 念心音源 v1.0.2.js | 通过 | 通过 | 通过 | 通过 | HTTP 403 | 通过 |
| 收集の聚合接口.js | 通过 | 通过 | 通过 | 通过 | 通过 | 通过 |
| 溯音音源_v1.js | 通过 | 失败 | 失败 | 失败 | 未测 | 未测 |
| 独家音源-v6 (修复).js | 拒绝 | 未执行 | 未测 | 未测 | 未测 | 未测 |
| 稳定版音源 v1.0.3.js | 通过 | 通过 | 失败 | 失败 | 未测 | 未测 |
| 统一音乐源.js | 通过 | 通过 | 通过 | 失败 | 再次解析失败 | 未测 |
| 聚合API接口 (CF) v3.js | 通过 | 通过 | 失败 | 通过 | 未测 | 通过 |
| 裤佬SVIP音源(二改整合版) v3.0.0.js | 通过 | 通过 | 通过 | 通过 | 通过 | 通过 |
| 西瓜聚合.js | 通过 | 通过 | 通过 | 通过 | 通过 | 通过 |
| 非常刀 v5.js | 通过 | 通过 | 通过 | 失败 | 通过 | 未测 |
| 𝖧౿ᥣᥣ𝗈 Ԝ𝗈𝗋ᥣᑯ260809.js | 通过 | 通过 | 通过 | 通过 | 通过 | 通过 |

原始报告、脱敏明细与复测脚本在 `.cache/online-reliability-or8/`：`inventory.json`、`catalog-search-report.json`、`source-results.json`、各 `source-NN-report.json`、`media-results.json`、`summary.json`；曲目原始元数据仅保存在本地 `live-config.json`，地址仅留在检查进程内存。表中的解析为首轮结果；音频头阶段重新解析失败单独列出，不修改首轮观察。

`独家音源-v6 (修复).js` 的静态拒绝原因码为 `uninspectable-remote-control`，没有移除规则或修改脚本。gdstudio的文件名注明仅网易；表中QQ失败不据此断言整份源损坏。其他unknown/抓取失败没有足够证据归因为版权、鉴权或服务永久失效；HTTP403只表示本次访问被拒绝。媒体探针初版原始进度日志的泛化network标记已在最终明细统一为fetchFailed，不能作为已证实的网络错误分类。

`preservation.json` 与 `preservation-media.json` 均为 originalCount=21、changed=[]、remainingTemp=[]；原脚本字节全部不变，独立测试目录已回收。正常权限只读CIM检查没有发现本项目out/test/source-host.cjs的残留node/electron进程。沙箱CIM访问曾被系统拒绝，后以获批正常权限完成只读复核，没有终止其他进程。
