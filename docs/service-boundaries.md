# 服务边界与实施阶段

核心协议维持 `contracts/openapi.json` / `openapi.yaml` v1.0.0 原样。独立的 `canvas-extension.json/yaml` 是 additive v0.1.0，HTTP 操作仍为 **RESERVED**。统一飞书登录使用新增 `auth-extension.json/yaml`，真实登录待 IPAC 应用配置与认证来源扩展。内部版本的社区、支付、分享等功能由服务端开关先拒绝，返回 **403 FEATURE_DISABLED**；其他未实现的操作返回 **501 NOT_IMPLEMENTED**。文档、采样数据和 UI 控件不证明服务已实现。

| 范围 | 本轮阶段 | 行为 |
| --- | --- | --- |
| 项目元数据与完整快照、资产上传/读取 | Go 最小服务 | 复用冻结 v1；业务与存储使用真实 PostgreSQL 和文件卷 |
| 统一飞书认证与本地会话 | 模块已实现；真实 IPAC 登录待接入 | OIDC 校验和持久会话；缺配置或可信来源时关闭登录，不模拟身份 |
| 社区、充值、支付、会员、公开分享 | 内部版本默认关闭 | 界面隐藏，已知对应接口 403；开关恢复后未实现接口仍 501 |
| 兼容图编解码 | 前端适配范围 | 保留组、样式与 meta；保存仍使用冻结的 snapshot 接口，不执行图 |
| 素材文件夹、库条目、角色/AI 应用目录与收藏 | RESERVED | 明确 501；不回退本地模拟成功 |
| GLB/GLTF 模型资产 | RESERVED | 独立 modelAssetId/上传 DTO，不修改冻结 Asset.kind |
| 节点/分组/整图运行、AI 应用执行、多人协同、模型提供商 | RESERVED | 无收费调用、无虚构结果、无伪协同 |
| HyperFrames 工作区、文件、会话、渲染 | RESERVED | 独立资源和权限空间；不假借核心 Project/Generation ID |

本轮没有提供商连通性声明。`model-capabilities.json` 只预留 LLM、文生图、图生视频、全能参考四类能力与适配接口，所有 descriptor 的 `connected=false`。后台适配实现和密钥配置属于后续工作。

## 核心协议复用

沿用 `/api/v1`、Bearer、强 ETag/If-Match、单调 revision、Idempotency-Key、UTF-8 JSON、UTC Z 时间、不透明字符串 ID、页码分页和统一 Error/成功 envelope。公开目录的 `favoriteOnly=true`、应用 `scope=OWNED/FAVORITED` 必须登录；无效 Bearer 不得静默降为匿名。没有新增宽松的“万能成功”兼容层。

画布扩展操作声明未来成功响应，目前返回 501（内部开关屏蔽的功能 403）；未知路径 404。当前只有个人空间，X-Team-Id 不会被解释成已授权团队；本轮不接功能权限/RBAC。引用主体必须来自服务端权威 ID，不从已舍入的大整数缓存恢复。文件删除、项目保存、分享和执行始终再次核验租户、资产归属与引用权限。

## 不改变冻结 ProjectGraph 的兼容图格式

普通节点顶层仅 `{id,type,position,data}`，连线仅 `{id,source,target,sourceHandle,targetHandle}`，图仅 `{schemaVersion,nodes,edges,viewport}`。原生节点 `parentId/extent/style/width/height/zIndex` 等额外 UI 属性保存在 `node.data.__rhtv.native`。原始节点 data 的业务字段仍作为不可信 JSON 保留。

图中有且只有一个元节点：

```json
{"id":"rhtv_meta_v1","type":"__rhtv_meta","position":{"x":0,"y":0},"data":{"version":"1","meta":{},"edges":{}}}
```

`rhtv_meta_v1` 满足冻结 Id 格式；`type="__rhtv_meta"` 只作非执行标识。`meta` 保存经清洗的原生 graph.meta；`edges[edgeId]` 保存原生连线的样式、动画和 UI 属性。decoder 将元节点移除再交给渲染器，恢复节点原生属性与连线 UI。空图仍保存这一个元节点。它不能参与模型执行、图依赖、节点计数、计费或输出；任何未来执行器必须先排除它。

编解码与服务器均须拒绝 reserved ID/type 冲突、源数据的 `__rhtv` 冲突、重复 ID、悬空连线、组循环以及 `__proto__/prototype/constructor` 键。源图中的凭据、provider apiUrl、令牌、脚本和 `blob:`/本机代理/短时签名 URL 不能进入持久快照或分享。媒体使用权威 assetId 绑定，恢复预览时重新获取授权访问 URL；保存和分享核验所有资产引用。原 meta.name 不替代 Project.name，元数据不提供权限。

快照保存继续使用 v1 `GET/PUT /projects/{projectId}/snapshot`，全量 graph 加 If-Match；10 MiB 上限含元节点。公开分享冻结特定 revision，并服务器清洗私有输入、凭据和不可分享的资产；即使空图也走同一清洗路径。不以“能解码 JSON”证明安全或执行合法。

## 文件夹与库条目

新增 namespace 是 `/library/folders`、`/library/items`、`/library/moves`、`/library/deletions`。`parentId=null` 表示根目录，根媒体类别是 `kind`，不让一个 parentCode 同时混作类别码与文件夹 ID。列表 GET 省略 parentId/folderId 时仅选根目录，指定 ID 时仅选直接子项；不隐式递归。文件夹允许 IMAGE/VIDEO/AUDIO/TEXT/MODEL_3D；移动在一个授权个人/团队空间内完成，不形成环，不跨类别暗改类型。

库条目 IMAGE/VIDEO/AUDIO 引用本服务授权且 READY 的 `assetId`；TEXT 的 content 是纯 text；MODEL_3D 引用独立且 READY 的 `modelAssetId`。不能把 TEXT 或 3D 偷塞入冻结 Asset.kind。移除库条目仅移除引用，不删除底层媒体。底层删除沿用引用阻塞规则，活跃任务/项目依赖需检查。批量移动、删除以每个资源的 expectedRevision 在单一事务校验；任一失败整体失败，不返回虚假的 `failedItems:[]`。递归删除必须显式 recursive=true，单个 DELETE folder 只允许空目录。

## 角色与 AI 应用目录

角色 `/characters`、筛选 `/character-filters`；应用 `/ai-apps`、标签 `/ai-app-tags`。ID 是目录中的权威字符串，所有应用有不可变 `version`。角色筛选以重复的 `filterOptionIds` query 传目录中权威 option ID，不能混用显示文字。收藏用 PUT 设置、DELETE 移除，重试不翻转。采样快照仅可做种子数据，不能证明当前可执行性或权限。

AppInput 使用独立 `id/nodeId/fieldName/type/required/defaultValue/constraints`。旧 inputNodes.fieldData 是 JSON 字符串，导入时解析成验证后的约束，禁止脚本与供应商凭据。类型涵盖 IMAGE/VIDEO/AUDIO/STRING/INT/FLOAT/LIST/SWITCH/BOOLEAN；INT/FLOAT/BOOLEAN 保留实际类型，不把所有字段当字符串。默认值和 submitted value 均通过目录声明的 JSON Schema 2020-12 约束。

输入绑定是 `{appNodeId,inputId,sourceNodeId}`。绑定必须属于本次指定 appNodeId，inputId 必须在 appVersion 目录中且唯一；sourceNodeId 必须在已授权项目图中。媒体来源必须对应授权且 READY 的 assetId，TEXT 对应纯文本节点；禁止任意 URL 或源节点 ID 冒充资产。媒体 values 同样只接受授权且 READY 的 assetId；数值/开关 values 按实际类型和约束校验，required 输入不可提交 null。values/bindings 对同一输入冲突、未知字段、缺必填值、类型或版本变化均失败。

`/ai-app-invocations` 只保留输入形状，当前 501。后续应定义独立 AppRun/CanvasRun 报价、状态和输出，不把任意图转换成首页 GenerationInput。可复用 v1 的报价快照、幂等、账务与结果资产机制，但不能复用其首页请求形状冒充图执行。原 `/canvas/task/run`、图估价、task batch/cancel 仍未实现。

## GLB/GLTF 模型资产

`/model-assets/uploads` 接收 projectId、format、entrypoint 与文件 manifest；GLB 只有一个文件，GLTF 必须列出入口、buffers 和纹理。所有路径是工作区内相对路径，禁止绝对路径、`..`、反斜线和 URL scheme。总大小不超过 512 MiB；逐文件 SHA-256/MIME/大小由服务器验证，所有内部引用必须命中 manifest。禁止外部 URI、可执行文件、归档展开和跨租户文件。

READY 模型响应包含 manifest 的逐文件短时访问 URL 与统一 urlsExpireAt，GLTF 载入器将内部相对引用按 manifest 重写到已授权 URL。上传返回独立 modelAssetId 和短时预签名 PUT；完成后校验全 manifest 进入 PROCESSING→READY/REJECTED。ETag 不等于 SHA-256。3D 的模型载入/预览只能用受控资源，不能因为有 GLB 后缀就执行内嵌脚本或远程取依赖。全部接口仍 RESERVED。

## 协同与 HyperFrames

Yjs 当前只是浏览器本地文档。房间鉴权、二进制消息版本、序号、durable ACK、断线重放、压缩、generation fence、锁定与分歧修复要独立协议；没有网络协同可以被称为已上线。原 `/canvas/client-backup/*`、`/canvas/yjs*` 不能返回伪成功。

HyperFrames namespace `/hyperframes/workspaces/{workspaceId}` 独立管理 files、sessions、renders；每个 file/session/render 归属该 workspace，并独立核验用户/团队，ID 不等同 projectId/generationId。文件修改以 ETag 控制，禁止路径越界。未连接的 Agent 聊天必须 501，不因创建 session 成功而虚构回答。服务器渲染固定 workspaceRevision，使用无宿主文件权限/任意外网的隔离 worker、时长/分辨率/内存限额；取消与结果读取检查 workspace 归属。浏览器独立编辑/编码功能不代表服务器 render 已实现。

原 `/studio-api` 可由后续兼容器适配直接 JSON，正式扩展仍使用统一 envelope。SSE/渲染事件、Yjs WebSocket 与 OpenClaw 会话流尚未定义完整线上协议，本轮不暴露假事件流。

## 验证

`tests/contracts/test_extensions.py` 离线校验 OpenAPI、本地 `$ref`、JSON/YAML等价、冻结合同 hash、有效/无效示例、兼容空图/分组/样式 roundtrip，以及输入绑定/目录版本/路径等跨字段规则。安装 `tests/contracts/requirements.txt` 后运行 `python tests/contracts/test_extensions.py`。它检验协议与实例，不证明 RESERVED API 或模型已实现。前端编解码和服务器功能另由其自身测试验收。
