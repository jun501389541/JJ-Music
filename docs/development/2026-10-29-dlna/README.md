# DLNA 当前开发与验收状态

本地与在线渐进MP3投放的生产模块、IPC、远程引擎和输出面板已实现，验证使用模拟设备和独立资料。用户暂时没有真实设备；真实兼容、网络可达、防火墙、多网卡及听感未验证，真实音源仍暂不运行。

入口：播放器“本机输出”→选择网卡→显式搜索→选择设备。启动应用或打开面板不会自动搜索。切换失败不自动让本机发声，停止未确认需用户明确处理风险；返回本机保持暂停。

当前支持渐进MP3及设备声明可用的暂停、定位、音量。在线目标与解析档位分开，设备兼容时使用320k/128k，不转码。HLS/DASH/DRM、未知编码、完整MediaServer/NAS浏览、AirPlay和多房间均未开放。没有实机自然结束配置时，STOPPED不自动推进队列。

详细证据：[本地阶段](D1-D3.md)、[在线与控制](D4-D6.md)、[网络提示](D6-network-errors.md)。历史阶段记录保留当时状态，不替代当前记录。最新累计 `npm run verify` 退出0：类型检查、生产构建、138/138套件和5/5门禁通过，日志 `.cache/dlna-cumulative-verify.log`。最新成品 `.cache/dlna-errors-final/win-unpacked` 资源校验通过，日志 `.cache/dlna-cumulative-resources.log`；面板证据 `.cache/dlna-ui-smoke/run-CsOyNA`，发现调用0、console错误0。

用户已明确授权提交并推送，本轮代码与文档交付到 `codex/windowless-source-launcher` 功能分支；未合并main、未发布。GraphFlow连接已恢复，增量索引已完成。分项记录中的未提交和连接关闭保留为历史时点。
