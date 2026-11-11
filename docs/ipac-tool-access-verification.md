# 工具级 IPAC 授权发布记录

日期：2026-10-04（Asia/Shanghai）。本次按用户要求移除 Studio TV 工作空间界面和作品分区，只通过 IPAC 的真实飞书身份和唯一工具级能力 `tv.access` 控制访问。前端沿用原有页面、画布、账户菜单和退出确认，内部 AIGC 授权范围不进入 TV 的产品流程。

代码 `8be955f14cc57de815b7c9eae09fda4870fbfc31` 已部署 deployment-host，本轮浏览器验收及临时作品清理完成。发布标签为 `studio-ipac-v0.3.1`，包含实现及本发布记录。[0.3 发布验收](ipac-verification.md) 保留当时的真实记录，其工作空间设计已被本次纠正替代，不能将旧结果计为本轮验收。

## 已部署版本与恢复证据

| 对象 | 本轮结果 |
| --- | --- |
| Studio 代码 | `8be955f14cc57de815b7c9eae09fda4870fbfc31`，已部署 deployment-host |
| API 容器 | `19cc7c10fb28` |
| Web 容器 | `563a0566fb78` |
| PostgreSQL 17 容器 | `17e001879953`，沿用原容器和数据 |
| 服务就绪 | API `/readyz` 确认数据库与存储正常 |
| 实测入口 | 通过 deployment-host SSH 转发访问 `http://localhost:18880/projects/` |
| 发布前备份 | `/home/user/.config/rhtv-service/backups/20261004T055324Z` |
| 最终 release 标签 | `studio-ipac-v0.3.1` |

运行目录仍为 `/home/user/apps/rhtv-service`。本轮替换 Studio API/Web，未改动 IPAC 登记、权限、源码或运行部署；沿用既有独立应用、精确回调、AIGC / 内部授权范围、维护者管理员及唯一 `tv.access`。IPAC 范围由后端查询并复核，不成为作品的数据分区。

历史工作空间映射、`workspace_id` 列和已有值保留，既有 NULL 也不清空或重分配。作品、素材和上传继续按 `owner_id` 隔离，不按同名或同邮箱合并旧账号。没有删除正式持久卷或用户作品。

## 本轮真实浏览器和接口检查

使用真实 deployment-host 服务与真实账号维护者。以下结果不来自 preview、模拟身份或测试签发方。

| 流程 | 当前结果 |
| --- | --- |
| 首页与画布身份 | 原有 header 正确显示维护者；飞书头像加载成功且与账号匹配 |
| 工作空间界面 | `customBar=false`、`workspaceRuntime=false`；未显示或请求工作空间 |
| 退役实验接口 | `GET /api/v1/workspaces` 返回通用 404 |
| 原有账户交互 | 原账户菜单及原退出确认保留 |
| 既有用户作品 | 更新前后完整 GET 响应 SHA-256 一致，见下方证据 |
| 新建与编辑 | 新建真实临时作品，原生文本编辑成功；snapshot 保存请求不带 `X-Workspace-Id` |
| 退出 | 从原账户菜单进入原退出确认，确认后返回首页，`auth.user=null` |
| 重新飞书登录 | 用户明确交回控制后，真实飞书回跳成功，重新进入临时画布并显示维护者 |
| 保存恢复 | 实际 API snapshot 为 revision 3，包含验收文本，页面文本恢复；画布 header 正常且无工作空间栏 |
| 无空间参数 | 实际 GET snapshot 和 GET projects 均不传 `X-Workspace-Id` |
| 临时验收作品清理 | 唯一本轮临时作品成功删除；真实列表中的两条用户作品保留 |
| 最终首页 | 刷新后仍显示维护者且无工作空间栏，最终截图已目视检查 |

既有作品 ID：`prj_ae214fa33ae04631a1f65ce0537d1136`。更新前后完整 GET 返回的 SHA-256 都是：

```text
0f5f0eb7bfaf037316c8776c64717762a91d2501ca61b22df1428c9c7bc0d1e8
```

该证据只表明上述既有作品的完整读取响应在本次更新前后一致，不扩展成对所有用户数据的逐项校验。唯一临时验收作品 `prj_3ceed2157cec4da7a99536fc6ae62322` 已在恢复验证后删除；清理后的真实列表保留 `prj_ae214fa33ae04631a1f65ce0537d1136` 和用户新作品 `prj_f7664637fde9478281d30dadec39b7f5`，没有编辑或删除它们。旧作品完整 GET 哈希在清理后仍与上方一致。最终首页截图保存在本地 `.local/browser-qa/tool-access-home.png`。

## 自动测试与冻结边界

| 检查 | 本轮结果 |
| --- | --- |
| Web | 8 个文件、44 项测试通过；TypeScript 检查和生产构建通过 |
| Go 与隔离数据库 | 30 项顶层测试、89 项子测试通过，0 跳过；5 项实际数据库测试执行 |
| Go 静态检查 | vet 通过 |
| 合同 | 12 项检查通过 |
| 核心合同 | 冻结 v1 的 61 个路径、71 个操作保持不变 |
| 原生资源 | 1198 个资源 SHA-256 与冻结基线一致 |

本轮 Go 隔离测试日志位于 deployment-host 的 `/home/user/apps/rhtv-service/.local/tool-authz-test/final-test.log`。本轮未重新执行或声明 race 检查结果。

负向授权路径由自动测试覆盖：任一可信有效范围的 `tv.access` 可授权整个工具，但仍须逐请求执行 EffectiveScopes 与 Runtime Check；无权返回 403，失效会话/版本返回 401，IPAC 故障返回 503。伪造空间头不能影响权限、数据或幂等；历史空空间和不同旧空间值不阻止真实 owner 访问，跨用户资源仍拒绝。签名素材 GET/HEAD 和上传 PUT 同样重新确认会话及工具权限。

本轮没有通过修改生产 IPAC 角色能力来重复撤权/恢复实测。真实生产撤权/恢复及旧版多标签验收只属于 [0.3 历史记录](ipac-verification.md)，不与本轮自动测试混称。

## 发布收尾

浏览器验收与临时作品清理已完成。实现与发布记录在 Git main 管理，发布标签为 `studio-ipac-v0.3.1`。记录提交只更新文档，运行中的 API/Web 仍对应上述实现版本。

LLM、文生图、图生视频、全能参考继续保留占位，未接模型供应商或发起计费调用。充值、支付、社区等内部版隐藏策略和当前 demo HTTP / 明确启用的本地开发例外保持原配置。
