# 2026-10-15 审查修复记录

依据：[全局审查报告](2026-10-15-global-audit.md)。基线提交 `f3d1cf5`，版本 0.4.2。本轮修改保留在工作区。

## 已修复的两项 P2

### 解析失败后的队列重试

`src/renderer/src/stores/player.ts` 的重试分支重新按原曲目 ID 定位队列位置，并确认当前曲目身份仍有效；条目不存在或当前意图已改变时结束旧尝试。重排和删除前方条目后仍重试原曲目，第二次失败保持在该条目并退出 loading。重试次数限制和原有总解析截止时间继续沿用。

`src/test/player-regression.test.mts` 新增 6 个用例：

- 重排后重试成功、重试失败；
- 删除前方条目后重试成功、重试失败；
- 重排后共享预算耗尽，不再发起 URL 请求；
- 删除正在解析的条目后，结束旧尝试。

### 删除下载与扫描提交的并发一致性

`src/main/library/music-library.ts` 为每个在途扫描维护临时失效路径集。显式下载删除会同时使这些扫描中相应路径的结果失效；批次提交丢弃旧读取结果，即使该路径尚未形成索引条目也适用。扫描完成或异常退出时释放集合；新扫描仍可收录后来重新创建的文件。

`src/test/download-library.test.mts` 新增 2 个用例，分别覆盖一个和两个并发扫描。通过延迟元数据读取结果的交付，确认删除后音频不存在、下载列表为空、内存及持久化曲库为空、重新加载后为空，后续重建相同路径可正常扫描入库。

测试先等待下载暂存文件清理完成再登记扫描目录，以免暂存文件干扰目标竞态。所有删除和重建均使用测试自身的临时合成音频。

## 验证证据

| 检查 | 本轮结果 | 日志（仓库 `.cache/`，不进入版本库） |
| --- | --- | --- |
| 新回归在修复前运行 | 69 项中 7 失败，失败对应两项报告缺陷；删除当前条目的既有防护通过 | `audit-fix-2026-10-15-red.log` |
| 修复后相关套件 | 69/69 通过 | `audit-fix-2026-10-15-green.log` |
| `npm run verify` | 类型检查、生产构建、62/62 活跃套件、5/5 平台门禁通过，退出 0 | `audit-fix-2026-10-15-verify-retry.log` |
| `npm run test:e2e` | 44/44 通过，原 profile 文件未写入；恢复生产构建后，三个测试钩子不可达，退出 0 | `audit-fix-2026-10-15-e2e.log` |
| 默认目录打包 | 正常权限下仍在 Electron 解压目录重命名处 EPERM，退出 1 | `audit-fix-2026-10-15-pack.log` |
| 显式本地运行时目录打包 | 从修复后的源码重新构建并生成目录包，退出 0 | `audit-fix-2026-10-15-pack-localdist.log` |
| 新包合成音源探针 | 干净临时 profile、开发依赖目录之外运行，未通过项 0，退出 0 | `audit-fix-2026-10-15-packaged-probe.log` |

第一次全量 verify 暴露了新测试读取到下载标签暂存文件的时序干扰；增加可观察的暂存清理等待后，完整重跑通过。该次失败日志保留为 `audit-fix-2026-10-15-verify.log`。受限环境的临时文件原子 rename 也会遇到 EPERM，正式验证使用正常文件系统权限完成。

## 可重复的打包替代路径

`tools/package.mjs` 新增 `--electron-dist=<路径>`，转交 electron-builder 的 `electronDist` 选项。空参数直接报错。使用者须确保指定运行时与目标 Electron 版本和架构一致。本轮使用项目已安装的 Electron `42.11.8`、Windows x64；该运行时也用于本轮 Electron E2E。

```powershell
node tools/package.mjs --dir --electron-dist=node_modules/electron/dist --output=.cache/audit-fix-2026-10-15-package-localdist
node tools/probe/clean-profile-sources.mjs --synthetic --app=.cache/audit-fix-2026-10-15-package-localdist/win-unpacked
```

新包位于 `.cache/audit-fix-2026-10-15-package-localdist/win-unpacked/JJ Music.exe`。探针确认音源接口可用、合成脚本导入和启用成功、五平台能力可见、320k 请求解析为应用内受控 `jjstream` 地址，且 fork 子进程实际发出了 `lx.request`。探针结束后已清理自身隔离应用进程树。

该替代路径避免默认解压流程的目录重命名；当前证据不能确定默认路径 EPERM 的底层原因。未修改依赖包或全局权限。

## 保留验收边界

- 两项报告缺陷的受控回归已通过；整体产品仍需按 [统一人工验收清单](2026-10-12-final-manual-acceptance.md) 验证真实音源、换源规格、过渡听感、滑块失焦、混合收藏和复制目录内的实际写入/删除操作。
- E2E 只证明本次隔离配置与所测路径；合成探针只证明受控脚本路径，不能代表所有外部音源。
- 本轮生成了新目录包；未生成新 NSIS 安装器，未执行安装、升级或发布。
