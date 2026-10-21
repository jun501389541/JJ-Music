# OR8 真实目录与更新验收

2026-10-20 至 2026-10-21。使用已授权网易/QQ、自有资料目录和原始可信 HYW 源的停用副本；不修改日常资料，不执行更新候选脚本。

## 生产模块真实歌单

`tools/probe/or8-live-acceptance.mjs` 通过官方公开目录发现小歌单，再由生产构建模块 `LibraryRouter`、`PlaylistRefreshService`、`PlaylistStore` 处理：

- 网易 22/22，QQ 10/10，均为完整快照。
- 首次预览可用，取消 token 后空本地歌单保持为空；再次预览并明确应用后数量和有序条目摘要匹配。
- 自有歌单资料已回收。原始样本 ID 仅在忽略版本管理的资料内。

报告 `.cache/or8-delivery/live/or8-live-acceptance.json`，run `2026-10-20T09-48-29-350Z-452f7a16`。这是模块集成证据，不冒充实际 UI 操作。真实空列表、部分分页和限流仍只有受控回归。

## 真实源更新

原始 HYW v1.0.3，11640 bytes，SHA-256 `0fdb240b65bdd63bac717c9c4fa9dd4099a24c24b593a3447993d048208b28a0`。静态准入 low，无 blocker；测试副本保持停用，源运行时未执行。

使用其真实 updateURL 检查，生产更新器返回 `notAScript`，没有候选，因此本次没有实际应用/回退。没有编辑远端版本、替换为合成脚本或绕过准入。原始脚本摘要未变；自有停用副本保留用于复查。离线更新/回退事务与 OR6 UI 结果另计。

## 生产界面探针

`tools/probe/or8-live-ui-acceptance.mjs` 使用自有 userData，操作生产 DOM、preload 与 IPC。初版启动参数被生产显式调试门禁移除；随后修正为两个显式环境开关。另修正 Hash 路由选择器、Vue 按钮启用等待及 CDP 关闭超时，均为探针问题，未修改生产行为。

2026-10-21 最终运行 `status=completed`：真实网易22首导入，经生产IPC移除一首制造差异，生产按钮预览21→22，关闭预览后仍21；再次预览，经过实际确认框应用，最终22首，移除测试歌单并回收自有profile，errors为空。报告 `.cache/or8-delivery/live/or8-live-ui-acceptance.json` 及同run目录 `report.json`。

中间运行实际得到“歌单已变更，请重新预览远程更改”，未覆盖本地列表；工具现按这个明确提示最多重新预览一次并记录次数，不绕过CAS。确认框嵌套引号错误也已在探针中修正。成功结果只覆盖网易实际UI，QQ为上面的生产模块集成证据。

人工听感由用户明确保留待验。
