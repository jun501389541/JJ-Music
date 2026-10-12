# 阶段 B 实施计划

日期：2026-10-12。设计：[D-B 设计](2026-10-12-phase-b-design.md)。执行方式：当前聊天内顺序实施。模型推荐：GPT-6.1 Sol high；行为测试同档位。

## 范围

依次完成 D-B、B1、B2、B3、B4、G-B。采用已确认设计中的精确参数；用户授权直接进入 B 不代表 G-A 真实试听已通过。保留当前工作区改动，不创建提交或发布。

## 工作清单

- [x] 核对 player.resolve、缓存、播放代次、PlaybackRouter、SourceEngine.getMusicUrl、音乐 IPC 和现有行为测试入口。
- [x] 形成具体 D-B 推荐策略和接口设计。
- [x] 确认 D-B 产品取舍，将设计状态更新为已确认。
- [x] B1：在 shared/types.ts 定义实际播放资源类型，播放器保存 resolvedResource；队列和收集保持原条目；覆盖换源与重启身份行为。
- [x] B2：新增录音匹配纯模块，建立资料规范化正例和版本/缺失资料反例，覆盖候选界限。
- [x] B3：新增统一解析编排模块并测试调用顺序；源引擎 strict 请求不降档，桥接/路由传递取消信号；播放器移除独立平台先回退流程。
- [x] B4：总预算、有限限流重试、源代次和目标档缓存策略、失效地址处理及实际来源/未检测显示；覆盖停止与快速切歌的真实取消和迟到结果。
- [x] G-B 自动化：相关模块回归和 npm run verify 通过，见 [执行记录](2026-10-12-phase-b-execution.md)。
- [ ] G-B 人工验收：原平台/换平台目标档、降档、快速切歌与失败场景，已并入 [A/B/C 统一清单](2026-10-12-final-manual-acceptance.md)。

## 文件与检查

| 工作 | 文件入口 | 有意义的行为检查 |
| --- | --- | --- |
| B1 | src/shared/types.ts、player.ts、NowPlayingView.vue、PlayerBar.vue | 原平台/id 不变，资源平台/id 可不同，实际播放后只收集原曲 |
| B2 | 新匹配模块、src/test 中相应样本 | 合作歌手顺序与标点；Live/Remix/翻唱/缺时长拒绝 |
| B3 | 新解析模块、source-engine.ts、playback-router.ts、main/index.ts、preload/index.ts | 跨平台同档优先；strict 端到端；取消到实际请求 |
| B4 | player.ts、解析模块、播放页反馈 | 低档缓存不跳过目标；清缓存后迟到请求不回填；预算耗尽不重启预算 |
| G-B | tools/build-test.mjs、现有 runner、执行记录 | 类型、构建、相关回归、请求门禁；真实兼容不作虚假声明 |

测试使用生产模块和可控传输/时间，断言行为和事件顺序，避免只对源码字符串做镜像断言。新增模块接入现有 esbuild 与测试 runner，不另造重复运行框架。Windows 沙箱权限问题按已有记录处理，失败不能删除测试伪装通过。
