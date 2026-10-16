# OR7 — 默认离线诊断与显式真实检查

2026-10-16。按 [计划](../../superpowers/plans/2026-10-16-online-reliability-or7.md) 实施；OR7 开发验收阶段只运行离线与合成检查。随后用户明确授权逐个测试指定目录的21份实际源，真实检查结果另见 [OR8](OR8.md)。分级结果始终区分合成协议、目录、地址解析、媒体加载和人工听感。

## 使用方式

先运行 `node tools/build-test.mjs` 构建与产品同源的模块，再从仓库根目录运行：

```powershell
npm run diagnose
node tools/probe/catalog.mjs
node tools/diagnose-online.mjs --help
node tools/probe/catalog.mjs --help
```

前两条默认均为 synthetic：不寻找 APPDATA、LX 或日常配置，不运行实际脚本，不联网。引擎检查只在临时目录运行作者生成的源，返回固定合成地址；资料检查注入标准、合法空值及结构错误样本，不声称实际目录可用。临时目录和源进程在 finally 清理。

真实检查仅在用户明确选好样本后使用：

```powershell
node tools/diagnose-online.mjs --live --config E:/test/live.json --source E:/test/trusted.js --platform wy,tx --report E:/test/new-source-report.json
node tools/probe/catalog.mjs --live --config E:/test/live.json --platform wy,tx --capability search,lyric,cover --report E:/test/new-catalog-report.json
```

以上是使用示例，未在本期执行。路径必须指向用户明确指定的测试文件；不自动扫描或复制日常 profile。`--report` 以排他新建方式写文件，不覆盖既有报告。未知/重复/不完整参数在任何配置和脚本读取前拒绝。源检查仅接收明确脚本正文文件，仍由既有引擎静态校验后执行；资料探针不执行脚本。

配置以 [live-check.example.json](live-check.example.json) 为模板，先填写实际样本。模板字段为 null，直接运行会在联网/源读取前被拒绝。仅填写所选能力需要的字段：search 需要 keyword，lyric/musicUrl 需要 track（实际平台 id、source、name、singer、meta），cover 需要 coverUrl，详情需要 artistId/albumId，playlist 需要 playlistId。QQ 的精确详情仍为 unsupported，不因增加探针而宣称产品已支持。

并发为 1；每个平台每能力只用一个明确样本，不搜索多首直到成功。源检查为一次初始化和每平台一次严格 128k 解析；网络辅助层沿用已有有界请求/重试。所有检查共享至多 60 秒预算，Ctrl+C/SIGTERM 取消，后续样本不再执行，也不接收迟到成功。初始化被取消时先撤销运行代次，再等待已有有界启动自行回收；不会留下活动进程。

报告只含固定 schema/mode、平台、能力、状态、耗时、受控错误码及白名单适配器修订/脚本 SHA-256。不含关键词、歌名、歌词、脚本、完整路径、URL、请求头、日志或原始错误。导出时再重建字段。未执行的目录/解析/媒体/听感明确 notRun；源初始化和地址解析分别列出。源摘要是内容标识，不是发布者签名。任何 failed/timeout/cancelled 使 CLI 非零退出，不把未知失败归因为中转失效。

## 实际验证与复核

证据相对 `.cache/online-reliability-or7/`：

- `runner-red.log`、`cli-red.log`：新增模块和入口缺失时失败；`version-red.log`：版本证据字段缺失。
- `catalog-contract-red.log`：初版合成探针错误地期待 ResourceCache 抛异常，修正为校验结构化失败信封；`cli-green2.log` 通过。
- 独立只读复核发现一项 P2 的两条路径：伪图片和 malformed 专辑被标 passed。`review-red.log` 先确认两项失败，再复用图片签名/MIME 校验并启用详情严格可靠性路径；`review-complete.log` 15/15，通过正常封面、合法空专辑和部分歌单拒绝。复核确认闭环，无新的可证实 P1/P2。
- `diagnose-default.log`：实际默认引擎合成检查通过；`catalog-default-green.log`：实际默认资料合成检查通过。旧目录失败记录保留于 `catalog-default.log`。
- `default-guard-green.log`：真实 CLI 进程的网络和日常音源文件访问守卫通过，临时目录已回收。第一次 `default-guard.log` 是 Windows NODE_OPTIONS 反斜线被去除的测试启动问题，改用正斜线后通过。
- 完整检查及最终差异保护结果见 [OR8.md](OR8.md)；新增源码接入 `tools/build-test.mjs`，套件经生产 bundle 与正式 runner 验证。

默认命令现在可用于离线验证；历史 `test:e2e` 仍会复制日常配置，不纳入默认离线运行。没有增加自动全平台扫描、定时联网 CI、遥测、远程适配器代码或实际媒体播放。RR14/15/18 有离线证据，真实平台、实际源、媒体与听感保持未验证。
