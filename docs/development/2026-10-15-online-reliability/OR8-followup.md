# OR8 后续改动 — 正式媒体诊断与源状态区分

2026-10-16。用户要求继续改动，按 [实施计划](../../superpowers/plans/2026-10-16-online-reliability-followup.md) 完成。本次保留原OR8的21份逐源快照，没有改写历史结果或第三方脚本。

## 改动

- 源已初始化但未声明平台/musicUrl时，诊断在发请求前返回 unsupported；未初始化则为 providerUnavailable。不再把两者都归入 unknown。实际已声明能力却解析失败的未知错误仍为 unknown，不根据文件名、脚本文案猜测版权或永久失效。
- 正式源诊断新增显式 `--live --media`。默认仍只合成且不联网；资料探针和非live不接受media参数。地址解析一次后保存在本轮进程内存，首字节检查复用该地址，不另发解析请求。
- 新 `diagnostic-media.ts` 复用公开URL/重定向/地址固定守卫，发 `Range: bytes=0-1023`，最多保留1024字节后关闭reader并撤销请求。识别拆分的MPEG/FLAC/Ogg/WAVE/音频MP4格式头；错误页、空流及不能识别的头不会标成功。仅检查格式头，不宣称全曲、录音身份、实际音质、可完整解码或听感。
- 每次媒体最多12秒且仍受同一个源检查60秒总预算约束，没有额外送一分钟。取消/超时会关闭reader；忽略取消的fetch迟到时，其响应body也被取消。未取得当前地址不发媒体请求。
- 报告只添加受控HTTP状态、字节数和格式枚举，保留现有版本/错误白名单；不输出URL、请求头或原始报错。普通403/404保留HTTP证据，不误称URL过期，429保留rateLimited。

示例（先用 `node tools/build-test.mjs` 构建）：

```powershell
node tools/diagnose-online.mjs --live --config E:/test/live.json --source E:/test/trusted.js --platform wy,tx --media --report E:/test/new-media-report.json
```

初始化/地址仍在resolution等级，首字节另在media/audioHead；listening保持notRun。没有media参数的既有入口行为保持。

## 实际检查

证据相对 `.cache/online-reliability-followup/`：

| 检查 | 结果 |
| --- | --- |
| 源状态RED/GREEN | `source-red.log`两个分类失败；`source-green.log`两个通过。使用作者生成的单平台/初始化失败源，未联网。 |
| 媒体RED/GREEN | `media-red.log`证明新模块/参数尚未存在；`media-green.log`13/13，含拆分头、忽略Range、HTML/空流/非音频MP4、HTTP、取消/超时、迟到body关闭。 |
| 入口接线 | `wiring-red.log`与`wiring-green.log`保留未接入及初次依赖接线错误；修正后 `integration-green.log`24/24，真实宿主只执行生成源，HTTP为内存响应。 |
| 独立只读复核 | reviewer检查共用预算、准入、白名单、1024上限、当前URL复用及关闭路径，未发现可证实P1/P2；纯内存media/check回归13/13。 |
| 完整检查 | `verify.log`退出0，类型检查、生产构建、80/80套件、5/5门禁。包含默认命令禁止网络/日常配置守卫。 |
| 正式真实入口 | `gdstudio-live.json/log`、`hyw-live.json/log`。只复测原授权目录中两份代表源，使用上轮已取得的两平台实际曲目，不重扫21份。两命令均退出1，正确保留失败项；不将单项成功写成整次成功。 |
| 真实结果 | gdstudio初始化成功，本次两平台解析失败，未发媒体请求。HYW初始化成功，网易解析失败，QQ解析成功且HTTP206读取1024字节MPEG头。两份的listening均notRun。 |
| 差异保护 | `preservation.json`：45份无关tracked diff、58个既有untracked文件未变，unexpected=[]；21份原始脚本哈希全部相同，changedSources=[]。 |
| 静态检查 | `node --check tools/probe/diagnostic-cli.mjs`、`git diff --check`通过；增量索引已执行。 |

本次真实结果与前轮存在波动，保留两个时刻的观察，不修改原表，不据此宣称某源稳定可播或永久失效。gdstudio虽然文件名写“仅支持网易”，运行时仍声明了QQ，因此本次QQ为解析unknown，而非根据文件名强制标unsupported；unsupported逻辑通过实际宿主运行作者生成的单平台源验证。

## 边界账本

基线 `before.patch` 与 `untracked-before.json`。仅在既有 `diagnostic-cli.mjs`、`diagnostic-check.ts`、其check回归与 `tools/build-test.mjs` 上修改；新增 `diagnostic-media.ts`、media/source两套件及本计划/交接。原有播放器、曲库、下载、缓存和21份源文件均未修改。

OR8的人工全曲播放、听感、日常交互和安装/升级验收仍未完成。没有提交、推送、打包安装或发布；未修改日常profile、第三方源或绕过静态拒绝/HTTP403。
