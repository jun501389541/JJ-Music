# WT03 路径支持边界实测

日期：2026-10-28。用户本轮明确“暂不运行真实音源”，继续使用合成夹具；未修改产品或 Windows 长路径策略。

新增 `tools/probe/windowless-paths.mjs`，每次在独有 `.cache/windowless-paths/<uuid>` 内生成宿主、脚本和初始化文件。短路径必须真实启动，核对 argv 原值（含 scratch 尾反斜线）、工作目录、512MiB 参数、匹配 launchId 的 spawned/childExit 和实际宿主退出码 23。

| scratch 路径长度（UTF-16 字符） | 格式 | 当前结果 |
| --- | --- | --- |
| 194 | 普通绝对路径 | 启动成功，尾反斜线及参数原值保持 |
| 338 | 普通绝对路径 | 拒绝，arguments / Win32 3 |
| 339 | 扩展路径前缀 | 拒绝，arguments / Win32 87 |
| 1058 | 普通绝对路径 | 拒绝，arguments / Win32 3 |
| 1059 | 扩展路径前缀 | 拒绝，arguments / Win32 87 |

路径包含中文、空格、括号和 `&`。长度是本次夹具实际值，不是测得的精确最大支持阈值。扩展路径组的实际输入额外带扩展前缀；表中长度按生成的普通 scratch 字符串统计。

超长路径首轮按成功启动断言运行，实际在 arguments 阶段失败；本轮按设计“超出支持范围明确失败”继续刻画边界，未扩大产品长路径支持。最终探针将这些结果记录为 `supported:false`，只允许单条带匹配 launchId 的安全 arguments/createProcess 错误，并检查没有 spawned、没有执行宿主、错误不含夹具路径。短路径成功控制仍为强制条件；令牌等其他阶段失败不能被当作路径拒绝通过。

另用自有纯文本 `invalid.exe` 证明文件存在但不可执行时返回单条 createProcess launchError，helper 退出 1；不是可执行代码注入或真实脚本运行。

实际命令 `node tools/probe/windowless-paths.mjs` 退出码 0，表示支持/明确拒绝契约检查通过，**不表示长路径受支持**。日志 `.cache/windowless-paths.log`；最终报告 `.cache/windowless-paths/410f677b-706b-4a4a-8964-caed7e450084/result.json`。JavaScript 语法和差异空白检查通过；不重跑未受影响的产品构建及离线套件。

独立复核发现错误分支只检查 stdout、未检查 stderr。先加 `--inject-stderr-path` 负控制，在探针捕获结果中注入自有路径，原断言错误接受（日志 `.cache/windowless-paths-stderr-red.log`）；再将两类错误分支改为同时检查 stdout/stderr，同一负控制按目标断言拒绝（`windowless-paths-stderr-negative.log`），正常六种夹具结果重跑通过。未修改产品错误输出。

本轮不证明任意长度、UNC/重解析点或所有 Windows 策略，也不证明端到端应用在长路径下可用。当前 helper 不应宣称支持超过 MAX_PATH 的配置路径；若以后扩展支持，需要单独实现并将对应断言改成必须启动成功。未提交推送。
