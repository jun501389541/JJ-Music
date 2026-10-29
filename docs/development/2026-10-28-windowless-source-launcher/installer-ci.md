# 无窗口候选的隔离 NSIS 验收

日期：2026-10-29。继续实现计划Task4，复用既有 `or8-ci-installer.ps1`，不在本机执行安装器，不运行真实音源或发布。

普通CI增加 `workflow_dispatch.inputs.installer_acceptance` 布尔选项，默认false。只有手动触发且该值为true时，在Windows packaged-sources的完整打包与摘要检查后执行现有安装验收；push、PR和默认手动运行均跳过。保持只读contents权限，不引用签名环境、密钥或发布流程。无论验收成功失败，已生成的report.json和日志上传artifact保留14天。

脚本保留写入前的github-hosted/Windows保护、已有资料与安装注册拒绝、精确0.4.2正式安装包SHA256检查。矩阵包含候选全新安装、保留合成资料卸载、正式0.4.2安装、同路径候选升级，逐次确认产品版本、安装标记、候选native资源和合成资料字节库存。不启动播放器，不代表其他用户/全用户安装、实际播放或在线更新通过。

本地YAML解析、默认关闭/条件/只读权限/报告步骤检查及git diff --check通过；保护脚本在本机返回CI_ONLY_REFUSAL，未进入安装。独立只读复核无Important/Critical问题。

## 远端结果

[CI 40799371336](https://github.com/jun501389541/JJ-Music/actions/runs/40799371336) 对提交 `63c44826facc26e418a8f59c054e6a19a859d8e5` 两个job均success。前置完整验证、原生探针、成品合成源、打包及摘要检查通过。实际NSIS验收报告status=passed，共15项阶段证据：

- 候选全新安装、保留资料卸载、正式0.4.2安装、同路径候选升级均exitCode=0。
- 正式基线产品版本0.4.2.0，候选安装及升级后0.6.0.0；候选EXE摘要一致。
- 两次候选安装后的实际资源均确认x64 native helper、协议1和清单摘要。
- settings.json、playlists.json和library/pending-assets.json的名称、长度、SHA256库存，在卸载、旧版安装、升级后均与合成基线逐字一致。

候选Setup SHA256：`b9d78700b1eea1f551c27a8e06582148a397cddc998b1740767ea62e420cd588`。正式0.4.2 Setup SHA256：`7f0af318dff6730fca60399baffbd1745ebc82647435aad26ba07e66ab0d4f57`。

[归档报告及日志](https://github.com/jun501389541/JJ-Music/actions/runs/40799371336/artifacts/12865174189)保留14天。本地忽略证据 `.cache/windowless-installer-40799371336.zip`、`.cache/windowless-installer-report.json`，已读取报告核对上述阶段。资料均为runner自有合成内容。

该结果只关闭本候选当前用户安装、保留资料卸载和0.4.2同路径升级子矩阵；没有运行安装后的播放器、真实音源、在线更新或其他账户/全用户迁移。未执行本机安装、未发布、未合并main。
