# OR0 — 基线与交付范围

日期：2026-10-15。基线 HEAD：`f3d1cf56f10c431a448c597e5cf7fb8baf1b0c5b`。

用户授权按设计开发，并选择首批 **网易云 wy + QQ tx**。遵循设计最后一节的分期建议，本期实施 OR0–OR2；OR3–OR8 不计为完成。设计中“本轮只写文档”的旧会话边界不再限制本次已授权实施。

## 工作区保护

开始时已有 README、PRODUCT_RULES、music-library.ts、player.ts、下载/播放回归与 tools/package.mjs 的修改；另有审查报告、修复记录、设计及 .graphflow。未撤销、提交或推送这些内容。本次新增 AGENTS.md，记录上下文优先、技能复用及验证边界。

变更前保存 `.cache/online-reliability-baseline/preexisting.patch`。当前 checkout 原位增量实施，避免新 worktree 漏掉未提交的并发修复。没有将既有修复归为本专项代码。

已有审查两项 P2 的实现和回归已在当前文件中确认；最终完整 runner 再次覆盖这些用例。未重做播放一致性 A–C。

## 基线检查的准确含义

- 最初受限权限 `npm run test` 为 41/62，多个临时文件原子 rename 报 EPERM；不能作为产品回归结论。
- 正常权限重跑为 65/65：该次构建已包含本期早期新增的 3 个基础模块测试套件，不是“未改动 checkout 的纯基线”。
- 最终以本期最终源码的 `verify-final.log` 为正式结果：66/66 套件、5/5 门禁、类型和生产构建通过。

## 验证隔离问题

既有 `npm run test:e2e` 通过 44/44，但它复制实际 profile，并加载了其中的 21 个音源及目录/歌词真实请求。原 profile 比较通过，未写入；该结果单独归为既有 E2E 的真实环境观察，不当作离线合成证明，也不证明音质/听感。此次执行前隔离审查不足，后续不应将该入口直接用于默认离线验证。

本期新增 `tools/probe/online-reliability.mjs`：只创建全新合成 profile，不复制实际源，Node fetch 边界拒绝外部请求。后续 UI 验收使用此入口，日志证明源列表为零，外部 fetch 为零。OR7 仍需系统改造既有 diagnose/E2E/真实探针边界。

所有本期日志和截图放 `.cache/online-reliability-baseline/`，不进入版本库。
