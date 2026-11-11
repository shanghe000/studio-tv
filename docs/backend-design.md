# Studio TV 后端设计

本文保留完整设计蓝图。第1轮已新增显式bootstrap、DDD assistant模块、ModelGateway及独立Router；旧v1仍由core提供，第3轮已实施资源、组织、媒体、任务与Worker；模型经独立Router做显式mock验证，真实推理未开启。实际切片见[任务记录](iteration-01.md)、[会话接口](assistant-api.md)和[Codex适配方案](codex-router-infra.md)。

建议保留 **Go 1.25 模块基线、chi、pgx、PostgreSQL 17**，建设模块化单体。API 与 worker 使用同一 Go 模块、同一版本代码；当前产品任务 worker 随 API 进程运行，后续可按负载拆为独立容器。数据库使用独立容器。现有 Docker 编译器为 Go 1.26.5，不在本轮切换。

数据库与协议配套见 [数据库设计](database-design.md)、[57 表 SQL 蓝图](design/database.sql)、[领域 API 设计](api-domain-design.md)、[领域扩展合同](../contracts/domain-extension.yaml)。原画布功能依据见 [画布接口与功能清单](runninghub-canvas-api.md)。

模型边界见[Router设计](models-router-design.md)。57表SQL仍为全量规划；004只实现GLOBAL/CANVAS会话和消息两表，包含成对Router引用，不与蓝图SQL同时执行。实施状态见[第3轮记录](iteration-03-result.md)，57表保持规划蓝图，实际迁移逐轮增量落地。

## 现状与重构边界

现有 `core.Server` 同时持有配置、PG pool、认证、授权、签名、JSON Schema 和路由；项目处理器同时负责 SQL、业务规则和 JSON DTO；素材处理器还负责文件流、哈希、rename、MIME、ffprobe 和 Range。图谱规则直接返回 HTTP 错误，幂等处理直接读取 chi 路径参数。

这些是需要拆开的耦合点。替换路由框架不能自动解决它们；也不能把现有安全检查、真实上传和事务重新实现一遍而默认行为相同。

- 冻结核心 v1.0.0 合同、路径、错误 envelope、身份与 owner 隔离。新增能力走独立 v2 领域扩展，旧接口继续投影已支持子集。
- 原领域蓝图合同保持PROPOSED；实际切片使用独立assistant-extension合同标明IMPLEMENTED/RESERVED。未知路径404，已注册预留操作501。
- 保留现有 preview/service 单一数据来源；不以模拟用户、生成结果或原站接口替代真实服务。
- 不调整 UI、画布、图形、动画和按钮交互；不增加工作空间选择、支付、社区或公共发布。
- IPAC 只决定工具级 `tv.access`；作品、素材及新私人业务数据仍按本地 owner 隔离。

## 上下文与聚合

下表与 SQL 蓝图的 57 张新表一致。聚合根不等于表：内部实体和版本表由聚合仓储协调。身份及当前作品/上传继续复用 `public` 既有表，不重复建用户、会话或权限体系。

| 上下文 | 主要聚合与职责 | 表归属边界 |
| --- | --- | --- |
| identity | User、IdentityLink、LocalSession；登录、刷新、退出、偏好 | 沿用 public 用户/身份/会话/刷新/登录事务表 |
| access | 工具访问用例与可信 IPAC 证据；实时 `tv.access` | 无新本地角色/permission/workspace 表，适配正式 IPAC SDK |
| canvas | CanvasProject、GraphSnapshot、TagSet；快照、版本、标签与媒体引用 | 沿用 public.projects；新增 canvas 的 tag_sets/tags/media_refs，3 表 |
| media | Blob、ModelAsset、UploadSession；真实文件、媒体事实、3D bundle | 沿用 public.assets/asset_uploads；新增 blobs/model_assets/model_files/model_uploads/blob_uploads，5 表 |
| catalog | Character、ModelCapability、Workflow、PromptPreset、SkillPackage、AIApp、VoiceProfile；公司目录与不可变版本 | catalog 的角色/模型/资源/版本等 21 表；筛选、收藏分别归属 typed 根 |
| library | Collection、Folder、LibraryItem；个人可复用节点与自有图库 | collections/folders/items/item_media_refs/folder_media_refs，5 表；item_type 为 NODE/ROLE_GALLERY/SCENE_GALLERY |
| execution | Task、Plan、Attempt、Output；依赖执行、输出、事件及历史投影 | tasks/plans/dependencies/attempts/outputs/events/history_heads/history_entries，8 表 |
| assistant | Conversation、Run、ToolCall；消息、Skill 版本、工具回执与流事件 | conversations/messages/runs/tool_calls/events，5 表 |
| studio | HfProject、HfRender、DirectorProject、DirectorModel；独立工程 | HF 6 表（含 hf_events）、独立导演 2 表，共 8 表；OpenCut 不建服务端时间线表 |
| platform | 事务消息可靠投递与消费去重；技术上下文 | outbox/inbox，2 表；不承载业务聚合或平台私钥 |

合计：canvas 3 + media 5 + catalog 21 + library 5 + execution 8 + assistant 5 + studio 8 + platform 2 = **57 张新表**。这些 DDL 仅在独立临时 PostgreSQL 17 验证，不应用到运行中的数据库，也不为完整蓝图一次上线所有空表。

`catalog.media` 管目录媒体引用，`media.blobs` 管实际自有文件，两者不重复承担上传。`library.items` 用有序 `item_media_refs` 保存图库图片和节点媒体引用，`folder_media_refs` 保存目录四槽封面，不另建一套角色/场景图库表。

目录 CURATED 与私人 PRIVATE 明确区分；公司目录不等于社区发布。私人写入必须匹配 owner，CURATED 的写入通过后续受控维护路径；不按姓名、管理员称谓或请求中的 userId 放行。

## 依赖方向与目录

```text
apps/api-go/
  cmd/api/                     HTTP composition root
  cmd/worker/                  后续后台任务入口
  cmd/migrate/                 保留增量迁移入口
  internal/bootstrap/          显式装配、生命周期
  internal/modules/
    identity/ access/ canvas/ media/ catalog/
    library/ execution/ assistant/ studio/
      domain/                  聚合、值对象、不变量、领域错误
      application/             command/query、用例、仓储和外部能力 ports
      adapters/http/           chi、DTO、headers/cookies、错误映射
      adapters/postgres/       SQL、pgx、行模型、锁与事务实现
      adapters/.../            IPAC、storage、ffprobe、Models Router等按需
  internal/platform/
    http/ contract/ postgres/ outbox/ inbox/ telemetry/
  migrations/                  已应用迁移不改，新迁移顺序追加
  vendor/                      固定官方依赖，保持 -mod=vendor 构建
```

domain 不 import chi、net/http、httpapi、pgx、SDK 或 env 配置；application 接收明确的 command/result/可信 actor，不接收 HTTP 请求。外层 adapter 实现应用层定义的 ports，bootstrap 装配具体实例。

跨上下文使用 ID、只读结果及小型 application facade；不直接 import 对方 SQL 仓储。查询可通过专用 read model 做联接，不强迫目录分页加载完整聚合。

身份模块提供无 HTTP 依赖的 VerifiedActor。HTTP 提取 Bearer/签名证明并映射结果；access 通过 SessionResolver、CapabilityChecker 取得真实证据。去掉 `core.New` 内的隐式类型断言和再次从 env 构造授权客户端，改为 composition root 显式注入。

用例决定事务，仓储不各自 Begin/Commit。PostgreSQL UoW 将需要的仓储绑定到同一个 pgx.Tx；application 不暴露 pgx。共享事务是单体内的一致性手段，不要求先拆数据库或建立分布式 saga。

UoW 默认 READ COMMITTED，树移动沿用此约定和统一根锁。REPEATABLE READ/Serializable 如被单独采用，遇序列化冲突重试整个事务；树写入还需验证新隔离策略，现有防环 trigger 不保证任意隔离级别都不会产生并发环。

## 聚合规则与事务边界

### 画布、媒体和个人库

CanvasProject 保留 graph JSONB，GraphSnapshot 校验节点、连线、分组、meta、有限数字及媒体引用，同时完整保留未知原生扩展字段。不会把 ReactFlow 每个节点拆成一行，也不让 typed DTO 丢失 `__rhtv.native`。

当前只有保存 graph 时递增核心 graph revision；rename、pin、cover 修改更新 updatedAt。重构保留此语义及强 ETag/If-Match/412，不把所有 metadata 修改偷偷改成 graph 版本冲突。

保存画布在同一事务中锁作品、比较 revision、核实本人 READY 媒体、保存 graph、刷新 `canvas.media_refs`。封面也进入引用投影；graph 仍是源数据，media_refs 用于精确反查和删除保护。

现有 `graph::text LIKE` 引用检查先保留兼容，再回填/比对投影后替换。保存引用与删除素材保持一致锁序；不能先查可删、提交后再新增引用。本人的其他作品素材仍可引用，不引入同一 project_id 限制。

MediaAsset/Blob 保证真实大小、SHA256、MIME、媒体轨道和 READY 状态；UploadSession 保证 grant 轮换、有效期、完成窗口、ETag 与单次完成。3D bundle 的 manifest 和真实文件均验证后才可用。

LibraryItem 引用媒体或完整可复用节点；ROLE_GALLERY/SCENE_GALLERY 的图片顺序、主图、owner 由同一聚合检查。目录移动校验同 owner、防环和目标类别，锁 Collection 修订头后短事务提交。

作品删除仍软删，不在分层重构中改成素材级联物理删除。历史隐藏、库条目删除、素材删除是不同用例；物理清理由引用和保留策略决定。

### 版本化目录与执行

模型能力按 node type 数据化，参数 Schema、UI 配置和 executor binding 分开；42 类节点不写成固定 Go 或 PostgreSQL enum。任务冻结 capability/version/params，目录更新不影响已接受任务。

工作流、提示词、Skill、应用、音色使用 catalog resource 与各自版本边界。角色图片/筛选属性保留完整语义；旧 v1 DTO 只输出允许的子集，丰富字段走新合同。

`catalog.resources` 只是共享 SQL 身份/归属登记，typed 根分别定义仓储与用例，不暴露万能 CatalogResource、GenericRepository 或 map service。DTO helper 可复用，业务聚合仍独立。CreateVersion 在根锁事务中一次写版本和完整子文件；SQL 拒绝已有版本/文件 UPDATE、DELETE，禁止向旧版本追加文件由应用入口保证。

接受任务时校验 owner/`tv.access`、graph、媒体与版本参数，然后在同一事务写 Task、Plans、Dependencies 和 outbox。返回真实 QUEUED 与 ID；没有 executor 的能力返回未配置，不能制造成功结果。

任务输出、媒体绑定、历史可见性、单调 events sequence 与任务状态在短事务推进。节点已经被用户修改/删除时，结果仍留历史；是否回填当前节点依据 project revision 和 execution marker 判定，不能覆盖用户的新内容。

历史删除只改变可见性与 history head revision/count，必要时返回 fallback；不连带清空任务输出或文件。终态、取消/完成竞争和重试保留旧 attempt/历史，由领域转换规则与 CAS/行锁约束。

领域对象提供命名行为，不开放 `SetState(string)` 或通用 `Update(map)`。状态 CHECK 只验证枚举；以下转换由 Go 聚合方法校验、application 在锁/CAS 内持久化，当前还没有实现这些方法：

| 聚合 | 允许行为与转换 |
|---|---|
| Task | QUEUED→PLANNING→RUNNING；需要执行确认时PLANNING→AWAITING_CONFIRMATION→RUNNING；规划失败→FAILED。全部计划终态后按成功计划/输出计算SUCCEEDED、PARTIALLY_SUCCEEDED或FAILED |
| 取消Task | 未提交执行器时可直接CANCELED；运行中先CANCEL_REQUESTED，再收尾CANCELED。终态不重开；完成已先提交则取消返回现有终态；取消已先提交则迟到结果不自动覆盖画布，已完成输出不清除 |
| Plan / Attempt | Plan在依赖成功后QUEUED→RUNNING→SUCCEEDED/FAILED；依赖失败则SKIPPED，取消则CANCELED。Attempt先PREPARED，再SUBMITTED/RUNNING；提交结果不确定为UNKNOWN，必须核对才能推进；重试创建新attempt，不改旧尝试身份 |
| Media / Upload | UPLOADING→PROCESSING→READY或REJECTED，删除为DELETED；READY只绑定已核实文件。grant轮换和complete单次提交；PROCESSING异步化属于后续功能，现同步complete语义保持 |
| AssistantRun | QUEUED→RUNNING；等待客户端工具时WAITING_TOOL→RUNNING；最后SUCCEEDED/FAILED；取消CANCEL_REQUESTED→CANCELED。同会话只允许一个活动run，回执必须命中该run的待处理call |
| HfRender | QUEUED→RUNNING→SUCCEEDED/FAILED，取消走CANCEL_REQUESTED→CANCELED；冻结工程revision/settings，使用独立租约和队列，不创建假的canvas task |

重试、重新生成是新命令/新执行标识；HTTP幂等重放不会生成新命令。状态迁移、lease takeover、取消竞争、失败依赖和迟到回执需要P2/P3真实用例测试，SQL蓝图校验不能代替这些业务测试。

### 身份和工具授权

保留正式 OIDC SDK 的 state/nonce/PKCE S256、RS256 issuer/audience/expiry 和 UserInfo subject/version 检查。PG 登录事务 5 分钟、单次 DELETE RETURNING 消费；身份只按 issuer+subject 绑定，不按邮箱/名字认领旧 owner。

本地 session expiry 为 min(12 小时, 上游期限)。每次 Bearer、refresh、签名素材都核验 IPAC SessionStatus 的真实飞书来源、sid/subject/version、active 和 expiry，再以 EffectiveScopes 与 Runtime Check 判定 `tv.access`。

刷新只保存 token hash，并锁 refresh/session 行。正常轮换原 token consumed 与新 token 同事务；重放时先提交 session 撤销，再返回 401。UoW 不能因为返回领域拒绝错误而把必须生效的 revoke 回滚，应显式区分“提交拒绝结果”和“回滚故障”。

上游会话失效/来源拒绝可撤销本地会话；IPAC 网络或协议故障返回 retryable 503，拒绝当前访问但不误撤销健康会话。退出同时处理旧 tab Bearer 与共享 refresh cookie，并保留上游离线时可退出的能力。

Cookie、CSRF、Origin、安全 returnTo 和 URL 不携带 access token 的行为不变。签名 GET/HEAD/PUT 绑定本地 sid、实时授权、owner 与 no-store；15 分钟签名期限不能替代撤权检查。

历史 ipac_workspaces/workspace_id 保持原样，不参与业务分区或 UI。能力清单登记继续是独立受控发布步骤，API 启动不修改 IPAC 角色或自动提交 manifest。

## 文件副作用与可靠 worker

当前上传在 PG 行锁事务内接收网络流、哈希和 rename，complete 在事务内再次哈希及 ffprobe。长 IO 占用连接/锁；文件 rename/chmod 与 PG commit 不构成同一原子事务，rollback 不会撤销已完成文件操作。

重构先保持既有同步 complete 返回 202 READY。以后改为 PROCESSING/worker 是明确功能变更，需新合同与前端兼容，不可称为无行为变化的目录拆分。

后续路径：先写 immutable staging blob、完成真实校验；再短事务复查 grant/state/version、绑定 blob。文件成功而 DB 失败可重试绑定或清理；DB 已提交而文件不可用由 reconciler 识别，读接口诚实返回 503。

API 事务落任务和 platform.outbox；worker 短事务用 `FOR UPDATE SKIP LOCKED` 认领、设置 lease、attempt 与 fence 后立即提交。网络请求、媒体处理、渲染均在锁外；成功/失败回写必须匹配当前 fence，防过期 worker 覆盖新执行结果。

lease 到期可恢复，heartbeat 也匹配 fence；消费者以 platform.inbox 唯一 event ID 去重，结果与 inbox 同事务。采用 at-least-once 投递加幂等状态推进，不承诺供应商端到端 exactly-once。

模型提交使用稳定 submission/idempotency key；timeout 后优先查询供应商回执。提交是否发生、是否计费无法确认时，attempt 记录 UNKNOWN 并进入核对流程，禁止盲目重复收费请求；没有查单或幂等能力的 provider 需明确恢复策略。

用户执行在发起收费调用前重新核实可信会话与工具权限；已提交的外部调用和已下载字节无法收回。内部清理/reconcile 用独立系统任务策略，不被浏览器 session 到期阻断，也不伪造用户授权。

外部回调先认证、去重并映射为内部事件，再推进领域状态；outbox、消息、attempt、日志不保存平台密钥或可复用 Bearer。SSE events 持久化 sequence 支持恢复，避免每个 token delta 单独 SQL 写入。

## 三阶段实施路线

| 阶段 | 实施切片 | 上线条件与兼容边界 |
| --- | --- | --- |
| P1：目录和基础素材 | 显式装配与 DDD 骨架；角色筛选/图片/收藏、动态模型版本、资源目录；个人库/自有图库/目录封面/标签；基础 blob、Skill 文件上传与引用投影 | 保留 UI/v1/auth；真实分页与文件完整性；先投影比对，再切引用检查；无 executor 仍不可生成 |
| P2：执行、历史、会话 | Tasks/Plans/Attempts/Outputs、outbox/inbox、worker；节点/全局历史；Conversation/Run/ToolCall/events | provider 方案确定才接真实调用；验证重复请求、崩溃、lease takeover、UNKNOWN、取消/完成和撤权；SSE 可恢复 |
| P3：独立 HF 与导演 | HF 上传/文件/修订/渲染事件与不可变 manifest；模型 bundle；独立 2D/3D Director 工程与模型 | 工程 revision 与 owner 明确；HF render 使用独立聚合，不要求 execution.tasks；渲染锁外执行；输出绑定真实媒体；不混用画布和独立工程 ID |

每个阶段按可运行垂直切片提交和发布，不以全量改目录作为上线完成。旧 handler 可暂作 façade 调新用例，先保留既有 SQL/锁顺序，再减少跨层依赖。

HF 的内部 HfProject 与旧 HFWorkspace DTO 可做映射，但不是 IPAC 工作空间。独立 HF 产物不能伪造核心 project_id；媒体允许独立来源所需增量迁移及旧上传投影须明确设计。

OpenCut 保持浏览器本地 IDB/OPFS；node Director 继续存画布 graph。只有独立导演入口才创建 studio.director_projects，不为实现完整服务端时间线额外增表。

迁移只追加新编号，不编辑已应用的 001/002/003、不清库、不重新分配 workspace 或 owner。预先备份、测试旧库升级及回退；停 worker 可以停止消费，新增 schema 不因回退应用而删除。

验收保持 frozen OpenAPI/扩展状态、原生 UI SHA、完整 graph 往返、ETag412、owner404、UUID/hash 幂等兼容、上传/Range/HEAD/no-store、refresh replay 与 401/403/503 区分。P2/P3 增加真实 PG/文件/worker 故障注入，不以 repository mock 代替系统验证。

## 框架和数据库依据

chi 使用标准 net/http handler/middleware，支持 subrouter 与 mount；现有 HTTP/JSON、cookie、ETag、媒体 Range 和上传可以逐个模块抽成 adapter。[chi 官方仓库](https://github.com/go-chi/chi)

此次核对的 Kratos 官方文档已经采用 **v3、Go 1.25+**。其 layout 的 service/biz/data 是模板约定，运行时不强制；Protobuf、HTTP/gRPC、生命周期和治理能力可以用于后续多服务，但不会代替业务建模。[Kratos 官方仓库](https://github.com/go-kratos/kratos) · [官方 layout](https://go-kratos.dev/docs/intro/layout/)

Kratos 也支持手写或 net/http handler，因此可以迁移；但本工程需要额外证明默认 codec、错误格式、timeout、404/405、headers 与流式媒体等价。目前无新增 gRPC/服务发现要求，保留 chi 的判断是降低本次兼容验证面；未来平台统一需要明确时再替换 transport。[Kratos HTTP](https://go-kratos.dev/docs/component/transport/http/)

PostgreSQL 17 已能承担单体事务和首期可靠投递。SKIP LOCKED 适合队列消费者竞争，不能拿来保证普通用户列表一致性；如采用 NOTIFY，仅作唤醒优化，outbox rows 才是持久事实。[PostgreSQL 17 SELECT](https://www.postgresql.org/docs/17/sql-select.html) · [PostgreSQL 17 NOTIFY](https://www.postgresql.org/docs/17/sql-notify.html)

是否引入 broker、检索服务或拆微服务，以后由实际吞吐、团队边界与独立发布需求决定；本轮蓝图不新增 Redis/Kafka/Elasticsearch，也不声称原站所有供应商 API 已确定。
