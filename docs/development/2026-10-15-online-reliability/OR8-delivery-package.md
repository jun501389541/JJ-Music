# OR8 Portable 交付验收准备

2026-10-20 执行。本记录区分同版本演练、真正跨版本 Portable 资料连续性与安装器隔离限制，不代表 OR8 全部验收完成。

## 官方旧版与版本可用性

- 公开仓库 `jun501389541/JJ-Music` 的 latest Release 仍为 `v0.4.2`，发布时间 `2026-10-03T23:08:52Z`，包含 Setup、Portable ZIP、SHA256SUMS、latest.yml、更新清单和签名六项资产。
- 只读 `git ls-remote --tags origin refs/tags/v0.4.3` 未返回该标签；公开 Release tag API 对 `v0.4.3` 返回 404。该版本在公开标签/Release 范围可用；此检查不能排除未公开 draft，也不代替推送前再检查。
- GitHub connector 的仓库元数据读取成功，返回现有连接的 `admin/maintain/push/pull` 权限为 true。没有读取或输出令牌、密钥。该权限不证明签名 Environment、U0 变量和私钥当前有效。
- PATH、Program Files、Local Programs 的常见位置未发现 `gh.exe`。可继续使用已连接 GitHub 工具执行其支持的操作；签名发布仍走现有受保护工作流。

公开旧 ZIP 已从官方 Release 地址续传完成，缓存为 `.cache/or8-delivery/official-0.4.2/JJ-Music-0.4.2-Portable-x64.zip`。

| 项目 | 当前核验值 |
| --- | --- |
| 文件长度 | 145847983 bytes |
| SHA-256 | `0009b29e1bbedce4870244bc943b00dba512eab78f260f6dd8d70d1aae89a24a` |
| 比对依据 | 官方 Release API `digest` 与同 Release 下载的 `SHA256SUMS.txt` 均一致 |

旧的未完成下载只有 102391104 bytes，摘要不匹配；未使用该不完整文件启动应用。本地其他 0.4.2 构建与公开资产不同，不作为官方基线。

## 已执行的同版本演练

新增独立工具 `tools/probe/or8-delivery-package.mjs`，不构建源码、不修改版本、CI 或真实资料。

```powershell
node tools/probe/or8-delivery-package.mjs --old-zip=.cache/or8-delivery/official-0.4.2/JJ-Music-0.4.2-Portable-x64.zip
```

运行报告：`.cache/or8-delivery/3da80594-7d43-42f9-8f7c-0415301fc03d-portable-report.json`，`status=passed`，21 项通过，旧/新运行版本均为 `0.4.2`，明确标记 `same-version-rehearsal`。

- 每个 ZIP 在解压前都要求同目录 SHA256SUMS 中唯一对应项且摘要相符；解压前检查所有成员目标都在自有解包目录内。
- 解包至新建系统临时根，应用路径没有开发 node_modules 祖先；每次 EXE 启动传入独立自有 `--user-data-dir`。
- 三次真实打包 EXE 启动分别覆盖旧合成资料、空白合成资料和复制的旧资料。检查 UI/preload 可响应、实际数据目录正确、没有真实音源、Portable 更新入口不可用。
- 验证主题 `light`、音量 `0.37`、合成待写入歌词和通过 IPC 创建的 `OR8 Delivery Fixture` 歌单在复制资料启动后仍可读。
- 旧应用正常关闭后才复制 profile，复制前后逐文件摘要一致；新应用退出后原旧 profile 仍逐文件一致，合成音频哨兵未变。
- 只通过该次应用的生产窗口关闭流程退出；成功运行未调用强制清理，最后删除自有临时根。

摘要拒绝负例报告：`.cache/or8-delivery/d45d40c3-d542-497a-b0c2-6dc4c129f61f-portable-report.json`。合成错误 ZIP 使用官方校验文件，得到预期错误退出；没有创建解包临时根，也没有启动应用。`portable-report.json` 是最近运行指针，可能指向此预期拒绝负例，应以明确 run ID 取证。

默认工具 AppContainer 中官方旧 EXE 在 CDP 就绪前退出 `0x80000003`，标准日志为空，失败记录为 `4d77d777-1ffa-4652-9f84-fdfb42b40fb4-portable-report.json`。随后同一脚本在通过自动审核的普通进程环境执行，21 项通过；未修改应用、系统功能或用户安装。这里只把失败限定为当前受限执行环境下的现象，不据此断言应用缺陷或崩溃根因。后续真实 EXE 验收应沿用已验证可运行的普通进程环境。

## 新候选就绪后的验收

主代理完成唯一一次候选构建、打包和 SHA256SUMS 生成后运行，例如：

```powershell
node tools/probe/or8-delivery-package.mjs --old-zip=.cache/or8-delivery/official-0.4.2/JJ-Music-0.4.2-Portable-x64.zip --new-zip=.cache/or8-delivery/candidate/JJ-Music-0.4.3-Portable-x64.zip
```

工具要求候选 ZIP 同目录提供匹配的 SHA256SUMS，并要求应用实际运行版本高于旧版。此模式才会记录 `portable-profile-upgrade`。失败保留自有临时根用于排错；成功清理根目录。工具不会运行 Setup、更新检查、下载或安装接口。

上述命令已在主代理完成候选打包后实际运行。报告 `.cache/or8-delivery/3453be24-5911-4c45-9637-333ada55858d-portable-report.json`：退出 0，**22 项通过**，`kind=portable-profile-upgrade`，实际应用版本 `0.4.2 → 0.4.3`。候选 ZIP SHA-256 为 `f55d26a50a649908380ee0f510f792c6d7c3c0a76f2f700feb3d7c10ffa167e7`，与同目录 SHA256SUMS 一致，旧 ZIP 仍匹配公开官方摘要。

新包空白 profile 启动、复制旧 profile 后升级启动均完成；主题、音量、待写入歌词和旧版通过 IPC 创建的歌单读回正确。复制前后的 profile bytes 一致，新版启动后原旧 profile 逐文件摘要仍未变、合成音频哨兵未变。所有应用按生产窗口关闭流程退出，未触发强制进程清理；最后 `ownedRootRemoved=true`。该结果绑定本次候选摘要，不自动适用于后续重打包。

## 尚未验收的边界

- 当前系统未发现 `WindowsSandbox.exe`；可选功能只读查询在现有权限下无法确认状态。没有启用功能、创建账户、安装/卸载应用或停止其他进程。因此没有安全的现成 Sandbox 安装隔离证据，不能在日常宿主直接运行硬编码 `C:\\u0-*` 的历史安装脚本。
- `nsisInstallationTested=false`、`onlineUpdaterTested=false`。Portable 解包与复制 profile 只证明相应资料连续性，不证明 NSIS 注册表/快捷方式/旧卸载器迁移，也不证明两个公开版本之间的在线更新安装流程。
- 签名发布工作流中的受保护密钥、Environment 和 U0 门禁保持原状，未读取、替换或绕过。公开版本可用性与既有仓库权限不等于发布门禁已通过。
- 本演练没有解码、播放或人工听感验证；人工听感由用户明确保留待验。
