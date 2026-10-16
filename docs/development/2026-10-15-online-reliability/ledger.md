# 实施账本

- OR0：保留未提交并发修复；差异快照保存于忽略目录。原位开发，测试复制/临时目录隔离。
- 决定：按设计的首份计划建议交付 OR0–OR2，用户已选 wy/tx。未重新发起设计评审或要求重复授权。
- OR1：结构化错误、12s/6s预算、一次重试所有者、500事件/2MiB白名单诊断，基础 RED→GREEN。
- OR2：搜索内存缓存、wy详情快照、热词兼容迁移、独立取消、版本代次、设置和 IPC 接入。
- Final review：superpowers:requesting-code-review 的独立只读 reviewer；无 Critical，4 Important；未执行网络或整套构建。
- Final fixed：畸形详情行不能覆盖旧值 — malformed entity rows 回归 RED→GREEN。
- Final fixed：合法截断专辑仍可展示且不写完整快照 — limited albums 回归 RED→GREEN。
- Final fixed：脱离当前 map 的旧代次最后消费者仍 abort — detached generations、热词取消 RED→GREEN。
- Final fixed：HTTP 429 等待证据透传 — real HTTP boundary 合成 Response RED→GREEN。
- 另修复：强制刷新失败标 stale；详情 available 分支实际渲染提示；确认不存在的30s负缓存。
- Ruling：受限完整专辑保留现有分页展示但不缓存 — 维持已有用户能力，同时不将部分结果冒充完整快照 — 代价是再次访问超大专辑会重取。
- Ruling：hotWords 继续由既有实例管理，生产新策略与旧按日分支并存 — 避免重复调度并保留兼容验证 — 后续可在旧缓存迁移窗口结束后收敛。
- 发现验证隔离不足：既有 E2E 加载实际源并联网。保留早期 44/44 观察，不计最终离线验收；以全新纯合成探针替代后续 UI 检查。
- 最终自动验证：verify-final.log 退出0，66/66套件，5/5门禁；新基础/集成18/18、热词新增3/3；纯合成 Electron UI 退出0。
- 没有 deferred minor 审查项。设计明确后续阶段与本期未覆盖项列 OR2.md，不把它们记为已完成。
- 未提交、未推送；没有安装/发布。逐文件比较确认开始时全部7份已跟踪文件差异原样保留。
- GraphFlow 增量索引成功：12文件、155符号、230引用；历史向量回填仍有missing队列，不影响本次代码索引结果。
