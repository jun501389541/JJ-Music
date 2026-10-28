# WL3 发行资产与安装后资源验收

日期：2026-10-28。本轮未提交、推送、发布或在本机执行安装器。

## 已完成

1. 使用 `node tools/package.mjs --output=.cache/wl3-release --electron-dist=node_modules/electron/dist` 构建实际 NSIS 和便携 ZIP，退出 0：
   - `JJ-Music-0.6.0-Setup-x64.exe`，103835911 bytes。
   - `JJ-Music-0.6.0-Portable-x64.zip`，约 139.3 MiB。
   - `SHA256SUMS.txt` 恰有两个本版本目标；逐个重算 SHA-256，均匹配。
2. ZIP 实际解压到本轮新建目录，解压前检查条目绝对目标均位于该目录。`verify-package.mjs <asar> --artifact-version=0.6.0 --require-native-launcher` 通过；宿主/依赖与外置 x64 GUI helper、协议 1、清单摘要均正确。
3. 对真实 ZIP 解压包执行 `clean-profile-sources.mjs --synthetic --app=<fixture>`。探针再复制到仓库外临时目录，用空白资料、合成源和本地标记服务验证导入/启用、5 平台声明、受控地址解析、320k 音质及本地 lx.request；未通过项 0。实际请求包括五个平台的标记，但这不等于逐平台真实媒体播放。
4. NSIS **未执行**。用构建器固定校验值的 7zip 静态解出其应用载荷，同样以强制 native 模式检查通过。这证明安装包携带了资源，不证明 NSIS 安装/升级逻辑执行成功。
5. `or8-ci-installer.ps1` 的候选全新安装与同路径升级之后，检查实际安装目录的 asar/外置资源；使用 `--require-native-launcher`。旧 0.4.2 基线仍保留兼容检查。

## 审查修复

独立审查发现通用包检查会根据 `source-launcher.exe` 标记选择是否检查 native，候选 CI 若复用了旧/回退 bundle 可能跳过检查却记录 native 已验证。

新增强制模式回归先失败；现在该模式要求 native 集成标记和外置资源同时存在，旧集成即使旁边有合法 helper 也失败；完整新包通过。历史制品不带强制参数时继续兼容。该回归所在包检查套件 10 项通过；最终完整离线 runner **126/126 suites passed**。

## 环境与日志

默认 release 目录重命名返回 EPERM，改用任务独立输出目录，没有删除旧产物或结束用户进程。构建器工具缓存也遇最终目录重命名 EPERM；下载压缩包摘要与已安装依赖内固定值 `be071f15bd6da2f78fe81c6ddef2009b0c4d8a51f36b780cb806c7e6df95e1b3` 一致后，直接使用已解压的构建工具做静态提取；未修改系统工具或 ACL。

日志：`.cache/wl3-dist.log`、`wl3-zip-check.log`、`wl3-zip-sources.log`、`wl3-nsis-extract.log`、`wl3-nsis-check.log`、`wl3-offline-tests-final.log`。提取路径记录在 `.cache/wl3-release/portable-fixture-path.txt` 与 `nsis-payload-path.txt`。

## 未执行的真实安装/升级

既有 `or8-ci-installer.ps1` 在任何写入前要求一次性 GitHub-hosted Windows runner；本轮保留此保护，没有伪造 runner 环境或触碰本机注册表/已有安装。只读检查显示本机 Windows Sandbox 功能已启用，但没有因此把 CI-only 脚本当本机脚本运行。

候选 Setup 的全新安装、0.4.2→当前同路径升级、保留数据卸载及安装后运行，仍需在一次性环境执行并留证。此次没有启动 CI（未获提交/推送授权）。发行资产仅为本地未发布构建，未宣称发布者签名或正式发布。

后续已补两条旧正式便携资料到本地候选的真实升级启动与升级后合成源生命周期，见 [便携跨版本补充记录](portable-upgrade.md)。这不改变本节真实 NSIS/在线更新未验的状态。
