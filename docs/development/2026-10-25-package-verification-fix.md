# 验包工具跨机器时间戳修复

日期：2026-10-25。用户授权修复发布后测试发现的验包误报。

## 行为

- 默认调用继续比较本地 src 与包的 mtime，陈旧本地包仍退出1；原有12项功能标记和3项外置依赖检查保留。
- 新增显式内容模式，必须同时提供 ASAR 路径与稳定版期望版本。检查包内 package.json 版本、功能标记和外置依赖，不拿跨机器 ZIP 时间戳与当前 checkout 比较。
- 内容模式输出明确说明不判断当前 checkout 的新鲜度，不能替代官方摘要和签名验证。
- 缺路径、非法/重复版本、未知选项和多个路径退出2；错版、损坏元数据、缺功能或依赖继续失败。
- EXE 信息从所检查 ASAR 的相邻程序目录读取，避免自定义路径仍打印默认 release 目录的 EXE。
- 使用 process.exitCode 正常退出，让 finally 在成功和失败时均清理自有临时解包目录。

## 用法

本地打包检查（原用法）：

```powershell
node tools/probe/verify-package.mjs
node tools/probe/verify-package.mjs release/win-unpacked/resources/app.asar
```

对已独立验证摘要/签名的发行包检查内容：

```powershell
node tools/probe/verify-package.mjs <解压目录>/resources/app.asar --artifact-version=0.5.0
```

artifact-version 是期望的包内版本，不是出处认证或源码匹配证明。

## 验证

- 新增8项真实CLI/合成ASAR回归；修复前0/8，修复后8/8。
- 覆盖旧时间戳发行包、陈旧/新鲜本地包、错版、缺标记、缺外置依赖、坏元数据、错误参数，以及成功/失败路径的临时目录清理。
- `node tools/build-test.mjs` 构建后运行针对性回归；`npm run test` 通过标准构建、发现与运行流程，110/110套件通过。
- 原始官方v0.5.0 ZIP及其文件时间保持不变；新内容模式退出0，版本0.5.0和全部15项内容/依赖检查通过。
- 独立静态复核无P1/P2阻断问题。

原始误报和修复后日志均保留在忽略的 `.cache/release-0.5.0/package-verification-fix/`，没有将历史失败记录改写为通过。本次交付验包工具、回归与验证记录，不改变应用运行代码、发行资产或版本。
