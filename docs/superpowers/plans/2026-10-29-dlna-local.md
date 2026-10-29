# DLNA 本地投放 Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development for independent protocol/media/session tasks, integrate sequentially. 用户授权按最新设计连续开发；明确暂时没有设备，先模拟验证，不扫描或控制实际设备。保留既有未提交设计和产品规则，不自动提交推送本新功能。

设计：`../specs/2026-10-29-dlna-casting-design.md`。先D0–D3本地投放；在线D4及真实设备兼容留后续。

1. D0核对既有引擎、媒体授权、IPC入口；无设备时仅记录模拟边界。XML依赖接入前核对官方版本和限制。
2. D1a实现 `src/main/dlna/lan-policy.ts`，只接收已选物理接口的私有IPv4同子网设备、同设备HTTP(S)URL，地址固定；不修改公网guard。`src/test/dlna-lan-policy.test.mts`经生产bundle回归。
3. D1b在该边界上实现有界LAN HTTP客户端、XML限制、SSDP解析/生命周期、注册表和SOAP。用模拟设备验证恶意URL、服务版本、大小/深度、取消及超时；默认不启动网络。
4. D2实现仅授权trackId的媒体租约及HTTP流，GET/HEAD/Range/416、连接数和撤销回归，复用现有文件释放。
5. D3实现会话代次、保守播放确认、远程引擎及输出面板；测试迟到事件、双端互斥和队列身份。不把模拟通过记为实机或听感验收。

每项先RED后GREEN，接入 `tools/build-test.mjs` 和现有runner；按修改范围验证，阶段结束完整verify。D1b–D3另补精确接口和测试步骤，不一次重写player store。

- [x] D0/D1a：LAN信任域及生产bundle回归，独立复核；完整verify129/129及5/5通过。无真实设备，XML依赖核查在D1b接入前完成。
- [x] D1b：协议、显式发现和模拟设备；XML/SOAP/能力及越界回归。
- [x] D2：本地HTTP租约；GET/HEAD/Range/416、撤销、文件授权与连接数回归。
- [x] D3模拟范围：本地投放闭环与UI；停止确认、切换、代次、播放确认。未验证真实声音。
- [x] D4模拟范围：主进程在线资源ID、活动代理引用、LAN渐进MP3/Range、混合身份及音源版本撤销。不转码、不接清单或未知编码。
- [x] D5模拟范围：能力驱动音量查询/映射/读回、定位、接管/停止确认/取消加载回归。无实机配置，自然结束保守不推进。
- [x] D6自动部分：独立成品面板、无自动扫描、固定中文网络错误提示及累计回归138/138和5/5；设备/多网卡/防火墙/听感单列未验。统一状态见 `../../development/2026-10-29-dlna/README.md`。
- [ ] 真实设备/听感：无设备，保持未验证。
