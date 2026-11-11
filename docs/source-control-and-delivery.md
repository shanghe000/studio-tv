# 源码与自动交付

源码主仓库：<http://studio.example.invalid/maintainer/studio-tv>。
交付协调仓库：<http://studio.example.invalid/maintainer/studio-delivery>。
Jenkins：<http://192.0.2.10:8080/job/studiotv-main/>。

`main` 更新由 Jenkins 检测，固定产品、Models Router、H3 和交付仓库的
commit 后执行检查、隔离数据库集成测试、镜像构建、临时 dev 部署验证，
全部通过后自动发布 deployment-host。正式发布没有人工确认步骤。镜像、提交、
迁移摘要和验证结果由发布清单关联，探针失败时回退应用镜像。

Models Router、H3 服务保持独立仓库；公司 IPAC 和其他既有基础服务是
外部依赖，不复制其用户、数据或凭据。编译资源基线仍保留原有历史及
校验清单，部分原站编辑器只有已采集编译资源，不能视为已恢复上游源码。

2026-10-28 归档包含 deployment-host 上未同步到原 bare 仓库的 HTTPS 指南提交、
Agent launcher 与直接网络配置改动，并保留本机未跟踪的设计文档。
旧 bare 仓库 `/home/user/repos/studio-tv.git` 保留作迁移来源备份。

生产数据、素材库、数据库备份、公司授权、API token、模型权重和环境配置
继续位于独立数据/秘密目录，不进入 Git 或镜像。测试使用临时数据库和
显式 mock，不使用生产模型账号或发起收费推理。已发布迁移只允许追加，
应用回退不自动恢复旧数据库覆盖发布后的新数据。

`security/secret-scan-baseline.json` 仅存已审查误报的规则、精确文件路径和
值的 SHA256，包含冻结资源中的公开 Firebase 项目标识、内容校验值及
无效测试样例；同一路径中的新值仍会阻断交付。
