# 无窗口候选的隔离 NSIS 验收

日期：2026-10-29。继续实现计划Task4，复用既有 `or8-ci-installer.ps1`，不在本机执行安装器，不运行真实音源或发布。

普通CI增加 `workflow_dispatch.inputs.installer_acceptance` 布尔选项，默认false。只有手动触发且该值为true时，在Windows packaged-sources的完整打包与摘要检查后执行现有安装验收；push、PR和默认手动运行均跳过。保持只读contents权限，不引用签名环境、密钥或发布流程。无论验收成功失败，已生成的report.json和日志上传artifact保留14天。

脚本保留写入前的github-hosted/Windows保护、已有资料与安装注册拒绝、精确0.4.2正式安装包SHA256检查。矩阵包含候选全新安装、保留合成资料卸载、正式0.4.2安装、同路径候选升级，逐次确认产品版本、安装标记、候选native资源和合成资料字节库存。不启动播放器，不代表其他用户/全用户安装、实际播放或在线更新通过。

本地YAML解析、默认关闭/条件/只读权限/报告步骤检查及git diff --check通过。实际远端结果待补。
