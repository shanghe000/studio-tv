# STUDIO 产品资源接口（资源实施域）

本扩展在真实 PostgreSQL 中存储私有资源、目录、节点快照、收藏、使用记录、偏好和 HyperFrames 文件。没有原站 HTTP 转发、浏览器数据回落、虚构钱包或模型调用。接口均在 `/api/v2` 下，产品主服务必须显式装配模块并提供可信 `tv.access` 装饰器；owner 仅取已验证的稳定 `public.users.id`。冻结核心 OpenAPI 和原生 UI 编译资源未改动。独立 [resources-extension.json](../contracts/resources-extension.json) 与 [library-extension.json](../contracts/library-extension.json) 描述实现状态，JSON 副本同时是合法 YAML1.2。

资源路由共92项：85项 IMPLEMENTED，7项 RESERVED。图库/目录扩展21项 IMPLEMENTED。接口存在不意味着有上游或收费模型能力；公开目录是本地明确导入的采集子集。

| 领域 | 实际路径与行为 |
|---|---|
| 角色 | GET `/characters/filters`；GET `/characters[/{id}]`；PUT `/{id}/favorite`；POST `/{id}/usage`。关系型目录记录保留 attributes/images；筛选分类和值以已导入过滤目录校验。 |
| 提示词 | GET `/prompts[/{id}]`；POST `/prompts`；PUT/DELETE `/{id}`；favorite/usage。typed prefixPrompt、suffixPrompt、STYLE/PROMPT、mediaScope/menuType、referenceAssetId，完整私有版本持久化。 |
| Skill | 同 `/skills`，保存 Markdown 与实际文件 `{path,content,encoding,mimeType,type,primary}`、samples、描述/用途字段。私有 IDs 是 UUID 派生十进制文本，兼容原生 usage helper；不把 UUID 强制转成 JS number。 |
| 工作流 | 同 `/workflows`，保存有边和节点的完整 workflowContent；POST `/{id}/apply {projectId}` 校验本人有效画布、记录真实 usage、返回图谱，前端插入后仍走主画布保存。 |
| AI应用 | GET `/apps[/{id}]`、favorite/usage；GET `/{id}/usage-history` 返回本人真实使用记录；GET `/{id}/creations` 要求主服务注入 CreationHistory，未注入501。实际运行和完成作品属于 root execution 域，使用回执不会假冒作品。 |
| 音色 | GET `/voices[/{id}]`，modelCode、language、dialect、scene、gender 筛选及收藏/使用写入。目录当前真实为空，未复制旧供应商模型/音色可用性。 |
| 导演 | `/director-projects` 与 `/director-models` 私有完整 CRUD。2D/3D 布局完整 JSON；模型引用本人 READY MODEL，或经主资产链路验证的 READY FILE 3D格式；封面为本人 READY IMAGE。节点模式仍保存画布图谱。 |
| 服务器目录 | GET `/catalog/categories`、`/configs`、`/dictionaries`、`/entries[/{id}]`。namespace 明确，类别/配置/本地记录从 PG 查询。模型和参数目录属于独立 Router/root，资源域不提供旧 vendor models。 |
| 标签/偏好 | GET/PATCH `/preferences`；GET/POST `/tags`、PATCH/DELETE `/{id}`、PUT `/order`、POST `/preset`。visible、顺序、快捷键与 buzzyPopFlag 均实际写入。 |
| HF工程 | GET/POST `/hf/projects`、GET/PATCH/DELETE `/{id}`；GET/POST `/{id}/sessions`。实际 owner、可选 own canvas FK、revision、软删及会话关联。 |
| HF文件 | GET `/studio/projects/{id}`；GET/POST/PUT/PATCH/DELETE `/files/{path}`；duplicate-file、upload、registry/install、lint、file-mutations/remove-element。内容是 PG BYTEA，不依赖某台电脑的绝对路径。 |
| HF事件/字体 | `/studio/events?after=N` 返回实际事务提交的 owner file-change；`/studio/fonts` 查询本人已上传字体；`/studio/fonts/google` 查询服务器目录；`/studio/registry/blocks` 查询真实 STUDIO_BLOCK 数组。 |

资源 DTO 是 `{resource:{id,name,description,scope,revision,version,categoryIds,coverAssetId,coverUrl,favorited,createdAt,updatedAt},content:{…}}`。私有写入 `{name,description?,categoryIds:[],coverAssetId?,content}`；POST 必须 UUID `Idempotency-Key`，PUT/DELETE 要求强 `If-Match: "revision"`。Favorite PUT 使用所读资源 revision，保存 owner favorite 记录；usage POST UUID，并校验可选 projectId、nodeId。重复 key/body 重放事务回执，不同 body409；已删除根不通过回执复活。Revision 冲突412带 CURRENT_REVISION，缺失428。未知路径404，未实现能力501，错误不转换为空成功。

分页默认 page1/size20，最大100，返回 records/page/current/size/total/pages/hasNext，total 是本地可见数据真实计数；超范围页保留 total。私有查询与写入通过 owner 串行根保持计数与页内容一致。公开导入应在 HTTP 开始服务之前完成，整个种子事务提交。公共源总数不冒充本地已导入总数。

节点/工作流中的媒体只用 `rhtv-asset:<id>` 和权威资产 ID。远端 URL、本机路径、未登记媒体不能变成执行输入。资产检查包含 owner、READY、未删除、有效父画布以及必要类型，并对资产/画布加共享锁。封面/图库只允许 IMAGE。已不可用的引用在读取时隐藏或令完整节点不可见，历史 FK 引用不会自动授权媒体读取。

目录与节点由独立 `library` 聚合服务实施：真实 folders、nodes、folder_media_refs、node_asset_refs。GET `/library/state`；GET/POST `/library/folders`；GET/PATCH `/folders/{id}`；GET `/library/entries`；GET/PATCH `/nodes/{id}`；POST `/batch-create`、`/move`、`/batch-delete`。union records 为 `{type:"FOLDER",folder:{…}}` 或 `{type:"ITEM",item:{…}}`；单独 folders 是直接记录。批量操作 UUID + expectedCollectionRevision，子树、节点与图库、引用、revision、回执同事务提交；跨 owner/删除父目录404，循环或非法类别移动400。有效树从未删除根递归可达，父目录删除后不能继续访问孩子。图库保留原 ROLE/SCENE CRUD，并有真实独立图片添加、顺序、主图、删除操作；当前前端仍用完整 assetIds/mainAssetId 更新实现同样原子语义。

快捷键采用原生确认值：newline=`enter|shift-enter`、submitTask=`enter|shift-enter|none`、interactionMode=`rhtv|comfyui`，zoomSensitivity10..100。标签 preset 的 content/ecommerce 名称来自冻结源码 rXn；颜色 #9B87C4 是明确 STUDIO 自有策略。只有 authenticated POST preset 才实例化本人标签，种子不建立 owner 数据。

HF 文件路径限制512字符，每段200；拒绝绝对路径、反斜线、冒号、NUL、`.`/`..`、重复斜线和换行，不进行远端抓取。文件每个8MiB、上传请求16MiB，utf8/base64 有真实校验；目录改名/删除是一次 PG 前缀操作，目标冲突409、revision过期412。所有文件写入使用工程 ETag，内容与 file-change 事件同时提交。duplicate 返回真实新路径。lint 实際验证 JSON 文件；它不是假冒完整 JS/CSS 编译器。HTML 时间线删除解析保存内容，支持 ID、tag/class/attribute、child/descendant、数字 nth-child/of-type；不执行脚本，未支持 CSS selector501。渲染/签名预览导航由 root 媒体域实施；这里没有 completed 假渲染。

HF会话需要 root assistant 的 HF schema/权限扩展：权威工程键 `resources.studio_projects(id,owner_id)`，canvas 复合 FK `public.projects(id,owner_id)`；studio_sessions session_id UNIQUE，session+owner FK assistant.conversations。未绑定 HF 会话的一次工程绑定需要 root 调整 migration004 原有 identity guard，仅允许同 owner HF 从 NULL 到有效工程，并保持已建立绑定不可更改；migration010当前已有工程 owner FK。已有绑定的 own HF 会话可以直接加入真实映射。资源域不创建假的会话/agent/run。

显式种子 `postgres.Repository.ImportCatalog(ctx)` 从编译内嵌 `seed/catalog.json` 建立719公共条目、185类别行（APP读取21根树）、11值记录、123受限已有媒体来源；source_name/source_hash/version/row_count 在 catalog_imports 审计。离线 `seed/build_catalog.py` 从仓库 fixtures.json、media-map.json 与 tag 名称源码证据复现，不读取凭据、不联网。删除源 favorite/isCollect/isOwn、价格、钱包、密钥、模型可用性；媒体只保留已经存在的受限 `/project/assets/` 文件，未知媒体为空。当前没有采集 prompts/voices/animation/director presets/Google font/studio blocks，它们是实际空的 PG 目录；不会用虚构结果填满。种子是目录的明确版本投影，绝不作为 API 请求缓存或浏览器失败回落。

公共媒体显示可以引用既有 bundled 展示文件；选为自己的执行输入必须经过 root `POST /catalog/media/materialize`，校验 family/resourceId/revision/content JSON pointer/source_version 和精确目录媒体登记，生成本人 READY asset。资源域还留有独立可选 MediaMaterializer 接口 `/catalog/media/import`，未注入时501，当前前端用 root 路线。不存在任意 URL 导入。

装配：`resourcesPostgres.New(pool)` → 明确 `ImportCatalog(ctx)` → `resourcesApplication.New(repo)` → `resourcesHTTP.RegisterRoutes(r,svc,protect)`。图库仍装配既有 Service/RegisterRoutes；另装配 `libraryPostgres.NewEntries(pool)` → `libraryApplication.NewEntries(repo)` → `libraryHTTP.RegisterEntryRoutes`。服务与领域无自动环境读取；PG pool、资产导入 port、身份 decorator 均由 root 传入。

主资产删除事务新增检查：

```sql
EXISTS(SELECT 1 FROM resources.active_asset_references WHERE asset_id=$1 AND owner_id=$2)
```

统一 view 包含有效 resource、gallery、node、folder 引用，排除软删和不可达父目录；不替换 root 既有 assistant/execution 引用。HF renderer读取port是 `StudioGet(ctx,domain.Actor{OwnerID},id)` + `File(ctx,actor,id,path)`，获得真实 utf8/base64、MIME、revision；主服务负责签名导航、渲染、完成结果的资产导入。OpenCut 原生 IndexedDB/OPFS 完全保持本地语义。

测试覆盖 typed 内容、完整资产引用、非法 URL/路径、身份隔离、HTTP边界/ETag/UUID/合同、目录子树事务、并发幂等、真实收藏/使用/偏好/标签、HF字节恢复/目录前缀/事务事件。PG测试只读显式 TEST_DATABASE_URL，由 testdb 创建随机独立数据库，缺失时明确 SKIP，不称为 PG 通过。最终 isolated PG17 由主代理运行；当前资源代理的 gofmt/go test/go vet/race 结果记录在本地交接文件。

当前本地根 CreationHistory 接缝：`service.History` 注入 `Creations(ctx,domain.Actor,appId,domain.Query) (application.CreationPage,error)`，仅返回本人实际已完成任务及签名资产作品。未注入原生查看作品接口501；`usage-history` 单独保持真实使用记账。种子模板的 recommended=true 是明确 STUDIO 本地推荐策略；APP时间筛选使用采集到的带时区 publishTime/createTime，其他记录使用真实本地入库时间。Hottest/Reputation 同时按已持久化本地使用/收藏及已采集公开统计排序，Recommend按已存标记/seq，Newest按已存时间；不丢弃请求的 sort。
