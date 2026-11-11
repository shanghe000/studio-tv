# Studio TV 第2轮后端

2026-10-05。Go + chi + pgx、PostgreSQL17、独立Web/API/数据库容器。继续按领域、应用服务、仓储/外部适配器、HTTP与启动装配推进；本轮不引入Kratos，也不声称已迁移全部既有core逻辑。

## 本轮交付

| 切片 | 实现与合同 |
|---|---|
| 模型需求 | [20类能力清单](model-requirements.md)，P0覆盖语言与多模态理解、文生图、图生图、文生视频、图生视频、全能参考 |
| 能力查询 | `GET /api/v2/model-requirements`仅声明需求；`GET /api/v2/model-capabilities`透传配置Router的实际能力及参数schema，未配置501，无采样模型兜底；[实施合同](../contracts/model-product-extension.json) |
| 消息历史 | [assistant v1.1](assistant-api.md)：新增会话详情、USER TEXT追加；事务内推进seq/revision和幂等回执；重试不重复消息，重建服务可读历史；6 IMPLEMENTED / 5 RESERVED |
| 角色/场景库 | [library v1](library-api.md)：本人ROLE/SCENE图库分页、关键词过滤、创建/详情/完整投影更新/软删；UUID幂等、强ETag、本人READY图片引用；5 IMPLEMENTED / 12 RESERVED |
| 素材完整性 | 活跃项目或图库引用阻止素材删除，409 ASSET_IN_USE；软删图库后释放有效引用，历史引用保留 |
| 内部版 | [收费屏蔽](internal-edition.md)：充值、支付、钱包、会员、报价/报价确认强制禁用；保留生成按钮和用量/上下文；内部billing开关不能重启收费 |
| 装配与发布入口 | 显式装配assistant/library/modelgateway，可信IPAC身份与实时tv.access后进入；Nginx代理v1/v2；Router配置仅给API，模型真实调用保持关闭 |

新DDL仅006：`library.collections`、`library.items`、`library.item_media_refs`，并为assets增加复合owner唯一键。消息写入复用004和核心幂等表，不建立收费、钱包、订单或额外执行表。

## 验证

- 独立PostgreSQL17、实际PF→Router HTTP联调：PF287、Router33个测试/子测试PASS，0失败、0测试SKIP。空库建表、001–004旧库升级、重复迁移、双用户、并发UUID重试、同ETag竞争、事务回滚、历史恢复、库引用约束及素材删除均通过。
- 测试容器、网络、临时数据库与目录已按精确ID清理，未连接生产数据库，没有模型调用。证据目录：`.local/iteration-01/20261005T183302-532e0fe7eb1c/summary.json`（本地，不入Git）；runner新增本轮关键PG用例为必需PASS项。
- 前端69测试、类型检查、构建PASS；Go完整race/vet PASS；45扩展合同测试及冻结核心校验PASS；1198原生编译资源哈希一致。
- 这里的Go数量包含子测试；无测试文件的包不记为测试SKIP。浏览器验收和发布状态以以下记录为准。

## deployment-host发布

已发布到 `http://192.0.2.10:18880/projects/`：后端代码`9b076fb`，账户菜单补漏`4b09460`，最终应用标签`studio-internal-v0.4.1`。API、Web与PostgreSQL容器正常；API宿主端口仍仅回环18881，数据库不发布宿主端口。Router未配置，未部署真实模型适配器。

更新前为`23ca77f`，迁移001–003；已备份数据库、素材、配置与版本到 `/home/user/.config/rhtv-service/backups/20261005T103427Z`。更新后迁移001–004、006齐全。8条项目行、12条素材行的完整行聚合哈希与更新前相同，既有数据保留。没有生产测试作品、图库或会话写入。

生产入口检查：页面200；未登录读取4类v2入口均401；钱包与报价403 FEATURE_DISABLED；未知v2路径404。真实飞书登录后需求清单200/20项、图库200/空分页、会话200/空分页、能力目录501 MODEL_ROUTER_NOT_CONFIGURED，没有用需求清单填充可执行模型。

ego-browser核对首页、账户菜单和既有画布：维护者及飞书头像绑定、两条本人作品、生成/新建入口、原有画布节点与工具栏、图形仍在，无工作空间UI；收费开关false，账户菜单的余额预警补漏后不可见。未编辑画布或发起生成。补漏仅改自有功能策略，中英文标签测试、构建与原生哈希校验再次通过。

一次并行读取中图库请求因上游鉴权返回503 IPAC_UNAVAILABLE；随后单独读取及全部串行复查均200。此记录保留该观测，不绕过IPAC或伪造空成功。机器证据位于 `.local/iteration-02/production-http.json`、`production-authenticated.json`、`production-authenticated-serial.json`、`production-before.json`、`production-final.json`、`deploy-v0.4.1.log`，均不入Git。

## 尚未实现

前端助手/角色库尚未改用上述新API；本轮数据库API实现不能等同于原生按钮已打通。真实推理适配器、内部生成任务、Worker、事件流、输出回收、原生生成的余额/SKU依赖解耦、文件夹和独立库图片管理继续迭代。助手runs等预留接口501；内部版报价接口403。没有伪造免费报价、模型结果、用量或可用模型。
