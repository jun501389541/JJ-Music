# 本地工程收尾记录

日期：2026-10-12。用户要求先完成开发和本地工程收尾，再集中进行真实人工验收。此记录不将本地自动检查或打包自检描述为人工试听，也不包含对外提交或发布。

## 更新内容

- 清洁 profile 音源探针不再注入已退役的 `onlineCatalogConsent` / `onlineCatalogConsentPrompted` 设置。
- E2E 使用隔离 profile；`JJ_E2E_ONLINE=1` 只用于要求在线结果断言，不伪造目录授权。
- 合成音源打包探针按当前安全播放链路检查 `jjstream://audio/<opaque-token>`，并验证源子进程确实发出 `lx.request`。Windows 下按本次临时副本的精确可执行文件路径结束 Electron 进程树；副本清理失败会记为探针失败。

## 自动检查

| 命令 | 结果 |
| --- | --- |
| `npm run verify:all` | 退出码 0；类型检查、生产构建、62/62 测试套件、5/5 平台门禁及 E2E 全部通过 |
| E2E | 44/44 通过；包含在线搜索、艺人/专辑资料、歌词、曲库 IPC、本地播放/seek/pause、音源列表及设置白名单。使用隔离 profile；报告无异常 renderer 错误，原用户 profile 未被写入 |
| 生产构建探针 | 未发现可达的测试注入接口 |
| 合成音源打包探针 | 退出码 0；打包版启动、音源导入/启用、5 个平台发现、320k 解析档、受控 `jjstream` 地址和本地 `lx.request` 标记均通过；只使用生成的合成脚本，临时 profile/应用副本已清理 |

E2E 会运行复制 profile 中当前已导入的音源，并可能访问真实在线目录/服务；这次 44 项自动断言通过，但不代表所有第三方音源长期可用。合成探针不运行这些用户脚本。

## 本地 Windows 构建产物

使用 `node tools/package.mjs --output=.cache/final-installer-2026-10-12` 生成 JJ Music 0.4.2 x64 产物：

| 文件 | 大小 | SHA-256 |
| --- | ---: | --- |
| `JJ-Music-0.4.2-Portable-x64.zip` | 145,853,798 bytes | `8efd27e3453618b9921569403ace1bf536ff0e352569f1b720afe97eb81c56e7` |
| `JJ-Music-0.4.2-Setup-x64.exe` | 103,618,404 bytes | `f7b049272e3c33406c2beea5e990bbacf3ef6d5ed8de708ab9898ac2a1d0a60d` |

清单位于 `.cache/final-installer-2026-10-12/SHA256SUMS.txt`。该目录在本地 `.cache`，未加入 Git；没有创建版本标签、上传或发布。

## 保留待办

- [统一人工验收清单](2026-10-12-final-manual-acceptance.md)中的阶段 A/B/C 操作、实际试听、音源管理和进度条交互仍待作者完成。
- GraphFlow context/plan/index 在本轮仍返回 `Transport closed`，没有图谱同步证据。
- 工程修改仍未提交、推送或发布。
