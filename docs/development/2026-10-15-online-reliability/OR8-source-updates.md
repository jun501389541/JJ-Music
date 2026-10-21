# OR8：真实音源更新与回退的有界补验

2026-10-21 21:28（Asia/Shanghai），运行 `node tools/probe/or8-source-updates.mjs`，结果为 `bounded-no-eligible-candidate`。本次覆盖已授权目录 `D:/Music/音源/V260912` 中全部 21 份原始 JavaScript；不能将本结果记为真实更新/回退已通过。

## 实际结果

| 项目 | 数量 / 结果 |
| --- | --- |
| 原始脚本读取、头部解析、生产静态准入 | 21 |
| 前后 SHA-256 一致 | 21 / 21 |
| 生产准入拦截 | 1：`独家音源-v6 (修复).js`，`uninspectable-remote-control` |
| 无显式 updateURL，未猜测主页链接 | 18 |
| 显式 updateURL | 2，均准入未阻断 |
| 唯一真实 URL 请求 | 2 / 上限 8 |
| 生产 checker 返回 `notAScript` | 2 |
| 合格候选 / 应用 / 回退 | 0 / 0 / 0 |
| 源脚本运行 | 0 |

| 原始脚本 | 更新地址主机 | 实际响应字节 | 响应 SHA-256 | 生产 checker |
| --- | --- | ---: | --- | --- |
| HYWmusic_公益版_v1.0.3.js | 103.79.184.97 | 239 | `f9a3a3e6f29a2732c4afd096247181c220cc3a6a8f8a78626992afe8a28d63a2` | `notAScript` |
| 念心音源 v1.0.2.js | gitee.com | 156 | `4f22116df334c99a9aad324a1129f6c1134f93d0de9872eec25b17b74d8155ab` | `notAScript` |

这些是本机本次经生产 `safeFetchBytes` 收到的字节及判断；未解析响应来追踪其它发布入口，不推断上游永久失效。SHA-256 只说明字节身份，不证明发布者身份。

脱敏逐文件证据在 `.cache/or8-source-updates/report.json`：运行 ID `2026-10-21T13-28-25.825Z-5a1da1bb`，UTC `13:28:25.826` 至 `13:28:29.079`。报告保存各文件字节数、版本、风险等级、准入规则 ID、前后完整哈希、请求主机与返回大小/哈希，不保存更新 URL、查询参数、凭据或源代码正文。

## 探针与验收边界

探针只接受原始头部中的 `updateurl` / `update-url` / `update_url`，不回退到主页，不抓页面猜链接。请求逐个执行，以完整 URL 去重，最多 8 个；每个请求超时 12 秒、上限 4 MiB，使用生产 URL guard 的重定向及连接保护。原始脚本先全量读取并哈希，最后再次读取校验；拦截脚本不请求更新。

生产 `checkForUpdate` 接收真实下载的完整原始响应字节。后续可应用候选仍须通过当前 `validateSourceBeforeStart`，名称和已存在的作者相符、UTF-8 可往返。沿用 checker 的 `newVersion` / `contentChanged` 契约：同版本真实内容变化可接受，不制造假候选、不改版本、不放宽风险准入。报告分别记录变化类型。

只有取得合格候选才创建停用副本，使用生产 codec 保留原始文件精确字节，调用 `applySourceUpdate`（传入真实 `baseSha256`）和 `rollbackSourceUpdate`。断言 stable ID、停用状态、候选/原始/历史字节、两次重载持久化和版本身份恢复；lifecycle 的 `reload` 必须抛错，`invalidate` 必须各触发一次。这里的在途失效仅能证明回调契约，不代表真实 worker / 网络请求已执行或取消。

**本次候选数为零，上述应用/回退断言分支未执行。** 当前阻塞是授权原始目录的显式更新入口未提供可应用脚本；需原作者入口恢复或用户提供真实新版本直链/文件，才能补齐真实事务证据。本次已按有界条件停止。

## 隔离、清理与验证

仅新增探针和本记录；生产模块私有打包至 `.cache/or8-source-updates/<runId>`，不修改共享 `out/`，不打开日常用户配置。原始 21 份文件没有写入。运行后已移除本次私有 bundle、停用副本（本次未创建）和下载正文，仅保留脱敏报告。工具和本文随后随c6b35d1合入main；本地报告、原始源及下载正文没有提交。

`node --check tools/probe/or8-source-updates.mjs` 通过；真实探针退出码 0、内部错误 0。此退出码表示有界检查与清理完成，**不表示真实更新/回退通过**。不属于离线生产套件，未使用生产构建替代真实候选验收。
