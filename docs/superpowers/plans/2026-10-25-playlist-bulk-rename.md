# 普通歌单批量改名实施计划

> 本计划按 `superpowers:executing-plans` 与 TDD 内联执行。设计已于2026-10-25获用户批准；保留当前工作区里所有之前的未提交改动，不提交或推送。

状态：2026-10-25 已完成，详见[开发记录](../../development/2026-10-25-playlist-bulk-rename.md)。

**目标：** 在普通歌单批量管理中提供前后缀、逐字查找替换两种互斥改名模式；显示完整预览，确认后一次原子更新名称。

**架构：** 新增 shared 校验/变换契约和主进程 `PlaylistBulkRename` 租约服务。`PlaylistStore` 在串行队列中提供名称快照与原名称 CAS 批量更新。严格 IPC/preload 将预览、应用、丢弃接入应用维护锁；Vue 管理页在复制/合并和批量改名面板间切换。

**技术栈：** TypeScript、Vue、Electron IPC、JSON 原子持久化、`tools/build-test.mjs` 生产模块离线测试、独占资料目录 Electron 验收。

**设计：** [2026-10-25-playlist-bulk-rename-design.md](../specs/2026-10-25-playlist-bulk-rename-design.md)。

## 执行顺序

### 1. 共享名称变换契约与红测 ✅

新增 `src/shared/playlist-bulk-rename.ts` 与 `src/test/playlist-bulk-rename.test.mts`，先用 `tools/build-test.mjs` 装载测试。契约包括：

- `affix` 与 `replace` 两种互斥模式、普通歌单 ID/输入片段验证和预览行结果类型。
- 限1000个唯一 ID、名称4096字符、输入片段256字符、候选序列化20MiB。
- `replace` 对所有字面出现项做大小写敏感替换；`$&` 等保持字面值。
- 计算每个目标名称长度后再构造结果，超限整批失败；空白目标、NUL、无操作参数整批拒绝。
- 保留旧名相同的预览行与 unchanged 计数；0个变化时不能确认。

先运行新增测试并确认预期失败，再实现生产纯函数并通过测试；登记新 shared 文件到测试构建映射。

### 2. Store 名称快照及批量 CAS 原子事务 ✅

修改 `src/main/store/settings-store.ts`，先新增生产测试覆盖 Store 缺失方法后红测：

- 在已有 mutation 队列中仅读取选中 ID、名称，并于复制前校验名称长度/总字节，不遍历或返回曲目。
- 批量更新接收服务持有的 `expected(id,oldName)` 与 `nextName`；队列内拒绝重复/未知/系统 ID、已删除或名称已改变的任一项。
- 只对当前 Playlist 对象设置 name，保留 apply 时最新的曲目、来源、封面、位置等并发更新。
- 全部变化仅经一次 `mutate` 与一次原子保存；写失败回滚整个批次，已排队后续变更仍成功。

通过 `tools/build-test.mjs` 装载 Store 测试：成功持久化/重启、名称CAS、并发改曲目与元数据保留、空变更拒绝、超界拒绝、注入写失败与后续队列继续。

### 3. 主进程候选服务与单元测试 ✅

新增 `src/main/library/playlist-bulk-rename.ts` 和对应服务测试，并在 `tools/build-test.mjs` 登记：

- `preview(mode,ids,transform,signal)` 从 Store 名称快照计算行结果；服务只保留一份10分钟UUID候选。
- 新请求更新代次并替换旧候选；取消/迟到请求不能复活候选；discard 仅删除匹配 token。
- `apply(token)` 同步消费 token，再调用 Store CAS；失败不可复用 token。
- `clear()` 淘汰当前候选并使进行中的旧代次失效。

先确认服务测试红，再实现，覆盖代次、取消、替换、租期/时钟倒退、重复消费、精确丢弃、source CAS 与字节/名称扩展边界。

### 4. 严格 IPC、preload 与维护生命周期 ✅

修改 `src/shared/ipc.ts`、`src/main/ipc-validation.ts`、`src/preload/index.ts`、`src/main/index.ts`；扩展 IPC 测试：

- 增加只收模式/有序ID/变换参数/请求ID的 preview 通道，token-only apply/discard 通道；测试额外参数、未知键、路径/曲目注入和 malformed token 均被拒绝。
- Main 通过现有 `cancellableRequest` 传递 AbortSignal；预览与 apply 使用相同 quitting/movingData/relinkGuard 检查。
- 资料迁移开始、应用退出和本地重新定位维护锁取得时调用 `clear()`。确认在 relinkGuard 切换为 blocked 的实际调用点同步清租约。
- preload 只暴露具名方法，不允许渲染层提交目标名称列表、歌单对象或元数据。

运行已有 IPC 离线测试及新增严格校验用例；做 TypeScript 类型检查。

### 5. Vue 批量改名面板与管理页集成 ✅

新增 `src/renderer/src/components/PlaylistBulkRenamePanel.vue`，修改 `src/renderer/src/views/PlaylistsView.vue`：

- 批量管理在复制/合并与批量改名工具间切换；选择使用当前过滤结果显示顺序。切换卸载旧面板并使旧 token 作废。
- 请求或提交期间禁用工具切换。预览请求提供取消，busy=false 后允许切换。
- 提供两个互斥变换表单、全部所选旧名/新名和变更统计、无变化时禁用确认、明确确认按钮。
- 输入/模式/选择/顺序/筛选变化、取消、离页清理租约；late result 不覆盖新预览。
- 保存后刷新并退出批量模式；保存成功但刷新失败提示已保存、不要重试；提交失败提示重新预览。

先构建 renderer 并完成指定隔离 Electron Probe；检查选择/筛选/工具切换与忙碌状态、输入扩展超限、重复确认、原子写失败、刷新失败以及队列/元数据/收藏/默认歌单不变。

### 6. 全面验证、记录和审查 ✅

- 新增 `tools/probe/playlist-bulk-rename.mjs`，只用独占 UUID profile 与合成歌单；保留报告、截图并清理临时资料。
- 更新开发记录，记录完成项、验证证据和边界；必要时只在新设计/开发记录追加，不覆盖 QQ、歌单复制合并等已有未提交资料。
- 执行 `npm run verify`（生产构建 + 全部离线套件 + 门禁），核对精确退出码、测试数与门禁数。
- 请求新鲜独立 reviewer 检查 diff 和设计符合性；修复发现并重新验证。增量同步 GraphFlow。
- 最终保留用户工作区，不提交、不推送、不发布、不 bump 版本。

## 审查重点

1. 超长替换在构造目标字符串前拒绝，禁止大膨胀分配；UTF-16 length、NUL、空白等规则在 renderer、IPC 和 service 一致。
2. 名称 CAS 精确到选中 ID 与旧名，写入只改 name，不回放旧曲目或整份歌单快照。
3. lease 只消费一次；迟到响应、旧组件 discard、迁移/退出/重新定位无法令旧候选复活。
4. 任一批次项过期或写盘失败均不留下部分改名；一次写入后的后续排队操作继续。
5. 输入/模式变化清预览；loading 取消恢复 busy 并可切换；apply期间不能切换/重复应用。
6. 所有旧的工作区修改保持原样；本功能没有外部网络、真实音源或个人音乐文件访问。
