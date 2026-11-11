# Studio TV 领域接口设计

2026-10-05。顺序：先 [表结构](database-design.md) 与 [SQL蓝图](design/database.sql)，再定义本合同。依据 [原站接口解析](runninghub-canvas-api.md)；真实模型请求尚待核对，下面是 Studio TV 自有协议，不把原站推测当成已验证的供应商协议。

完整规划见[domain-extension.yaml](../contracts/domain-extension.yaml)，保持PROPOSED/RESERVED。第1轮已实现并注册4个会话操作及5个预留run操作，实际协议以独立[assistant-extension.yaml](../contracts/assistant-extension.yaml)及[会话说明](assistant-api.md)为准；未知v2路径404，明确预留操作501。

STUDIO→Models Router为独立服务协议，不由浏览器直连；统一能力调用、逻辑session、输出交换和Codex复用草案见 [Router设计](models-router-design.md)。本文机器合同仍为基线，相关字段变更待P2一起更新；Router原生协议不透传给PF前端。

## 1. 协议规则

| 项目 | 定义 |
|---|---|
| 入口 | 新领域合同 `/api/v2`；当前 `/api/v1` 认证、项目、快照、上传、签名媒体继续使用。旧合同不修改，原生前端由自有兼容层转换 |
| 登录与隔离 | 沿用 IPAC 飞书登录、实时会话检查及整个工具 `tv.access`；私有对象由服务端会话确定 owner，跨owner对象404。不接收 userId/teamId/workspaceId 来指定数据归属 |
| 目录可见性 | `CURATED` 公司维护目录；`PRIVATE` 本人资源。CURATED 是内容分类，不是社区发布，不代表未登录可读。公司目录写入先用受控导入命令，不开放公共投稿 |
| ID / 版本 | ID用字符串；模型版本用 `{capabilityId,version}`，资源版本用 `{resourceId,version}`，version为不透明字符串；数据库中没有独立 `versionId` 主键。可变对象 `revision` 为正整数 |
| 成功包 | `{code:0,message:"success",requestId,data}`；错误包沿用v1 `Error`，真实HTTP错误状态，不以200伪装失败 |
| 分页 | `page`从1，`size`默认20、最大100，`keyword`去首尾空格；返回 `{records,page,size,total,hasNext}`。节点历史size≤20。固定排序加id作同值排序键 |
| 修改并发 | `If-Match: "<revision>"`；冲突412，缺少必要前置条件428。标签用tag_set版本，文件夹/条目单改用自身版本；批处理用collection版本；HF文件用文件版本，渲染启动用工程版本 |
| 幂等 | 需要的创建、运行、上传、批处理、取消使用UUID `Idempotency-Key`；owner+operation+key锁定结果，同请求重放，不同请求409。业务变化、幂等记录和outbox同事务提交；v1原有hash/重放语义不重写 |
| 动态字段 | graph、模型参数、Skill内容和工具数据允许版本化JSON；按所选固定schema二次验证。页面config中的字符串min/max不强制丢弃，但执行参数仍须符合schema |
| 异步 | 提交成功202表示已持久接收，随后查询/SSE；供应商或执行器未配置501，不创建假成功结果。取消202进入CANCEL_REQUESTED，完成实际停止/收尾后才CANCELED |
| 文件 | 前端拿短期上传/下载授权；不发永久存储凭证。blobId不是权限凭证，不接收任意外部URL代替受授权文件 |

SSE使用带Bearer的Fetch流；不把token放query。`id`等于作用域内事件seq，`Last-Event-ID`重连去重。事件正文为合同`Event`，包含`type/schemaVersion/createdAt/data`；事件种类和data schema随事件版本固定。任务、Agent、HF分别持久化到自己的events表，outbox不当公开历史流。过期游标410 `EVENT_CURSOR_EXPIRED`；定期检查IPAC会话及工具权限，撤权终止流，503临时故障不撤销有效本地会话。

## 2. 接口与表对应

以下省略公共前缀 `/api/v2`。路径内 `{id}`均由当前会话校验；字段详细约束以机器合同为准。

| 功能 | 接口 | 主要请求 / 返回 | 表 / 阶段 |
|---|---|---|---|
| 分类/角色筛选 | GET `/catalog/categories?namespace=...`、`/characters/filters` | 分类、uiType、选项code/color/seq | catalog.categories/filter_options，P1 |
| 公共角色分页/详情 | GET `/characters`、`/characters/{id}` | keyword、favoriteOnly、filters；返回属性与有序三视图、当前收藏态 | characters/attributes/images/favorites，P1 |
| 角色收藏 | PUT `/characters/{id}/favorite` | `{favorited:true或false}` → 最终收藏态；幂等设置 | character_favorites，P1 |
| 目录图进入画布 | POST `/catalog/media/materialize` | `{projectId,mediaIds}` → 本人READY Asset[]；再更新画布 | catalog.media、media.blobs、public.assets，P1 |
| 模型/家族/版本 | GET `/models?nodeType=...`、`/models/groups`、`/model-capabilities/{id}/versions/{version}` | 能力code、版本、inputSchema、inputRequirements、uiConfig/defaults/outputKinds | models/groups/capabilities/versions/group_members，P1 |
| 资产库根/子目录 | GET `/library/entries` | categoryCode、parentId、keyword、recursive；Folder或Item统一分页 | library.folders/items，P1 |
| 单类文件夹/条目 | GET `/library/folders`、`/library/items`、`/library/items/{id}` | 分类、目录、kind/itemType、时间范围、keyword；保留完整可复用nodeContent | library各表，P1 |
| 新建/改名/封面 | POST `/library/folders`、PATCH `/library/folders/{id}` | name/categoryCode/parentId；默认kind=MIXED；封面用本人Asset ID | folders/folder_media_refs/collections，P1 |
| 保存/更新节点 | POST `/library/items`、PATCH `/library/items/{id}` | name/categoryCode/itemType/kind/content；显式主素材/文字及依赖引用 | items/item_media_refs/collections，P1 |
| 批量入库/删除/移动 | POST `/library/batch-create`、`/library/batch-delete`、`/library/move` | itemIds/folderIds或items、expectedCollectionRevision；移动加目标分类/目录 → 新revision/changedIds | library各表，P1 |
| 自有角色/场景图库 | 同items，itemType=ROLE_GALLERY或SCENE_GALLERY；GET/POST `/library/items/{id}/images`、PUT `.../images/order`、DELETE `.../images/{imageId}` | 添图用assetId；排序用imageIds，主图用mainImageId | items/item_media_refs，P1 |
| 标签定义/排序/显隐 | GET/POST `/tags`、PATCH/DELETE `/tags/{id}`、PUT `/tags/order`、POST `/tags/preset` | name/color/visible、ids、preset/replace → 完整TagSet+revision | canvas.tag_sets/tags，P1 |
| 工作流/提示词/Skill | GET/POST `/workflows`、`/prompts`、`/skills`；GET/PUT/DELETE `/{资源}/{id}` | scope/categoryId/keyword/favoriteOnly/recentOnly；新建/更新提交typed content，更新创建新版本 | catalog.resources及各自versions/files，P1 |
| AI应用/音色目录 | GET `/apps`、`/voices`及`/{id}` | App工作流版本+输入定义；音色按modelCode/language/dialect/gender/sceneCode筛选 | app_versions/voice_versions，P1 |
| 资源收藏/最近使用 | PUT `/{workflows或prompts或skills或apps或voices}/{id}/favorite`；POST `.../usage` | favorited；使用记录可带projectId/nodeId，服务端校验关联 | resource_user_states，P1 |
| Skill附件 | POST `/blob-uploads`、`/{id}/complete`、`/{id}/renew`；GET `/skills/{id}/files/download` | purpose=SKILL、声明文件 → 上传grant；完成后以uploadId绑定Skill版本，读返回授权URL | blobs/blob_uploads/skill_files，P1 |
| 节点/组/画布生成 | POST `/canvas-runs` | projectId/baseRevision/targetType/targetId/graph/executionKey? → Task | tasks/plans/dependencies，P2 |
| 轮询/参数复用 | GET `/tasks/{id}`、POST `/tasks/batch-status`、GET `/tasks/{id}/snapshot` | ids/includeOutputs；冻结图谱、模型版本和已解析参数 | tasks/plans/outputs，P2 |
| 确认/停止/状态流 | POST `/tasks/{id}/confirm`、`/cancel`；GET `/events` | 确认比较task revision；取消reason?；持久SSE | tasks/plans/events，P2 |
| 全局历史/下载 | GET `/history`、POST `/history/batch-delete`；GET `/outputs/{id}/download` | projectId/kind/分页，ids；输出授权文件 | history_entries/outputs，P2 |
| 节点历史/删除当前输出 | GET `/projects/{id}/nodes/{nodeId}/history`；DELETE `.../history/{outputId}` | page/size/knownRevision；删除比较history revision → 新revision/resultCount/fallbackOutputId | history_heads/entries，P2 |
| FFmpeg与画板 | POST `/media-jobs`、`/sketch-runs` | 处理spec使用assetId；画板sourceAssetId/prompt/styleVersion/modelVersion/mode → Task | tasks/plans/outputs，P2 |
| Agent会话/消息 | GET/POST `/conversations`、DELETE `/{id}`、GET `/{id}/messages`；POST `/{id}/runs` | CANVAS绑定本人project；消息parts+skillVersions/modelVersion/interactionMode → AssistantRun | assistant各表，P2；HF会话P3 |
| Agent流/停止/工具回执 | GET `/assistant-runs/{id}`及`/events`；POST `/cancel`及`/tool-calls/{callId}/result` | 可重连事件；客户端回执校验run/call/状态/期限，不信任任意成功声明 | runs/tool_calls/events，P2 |
| 3D模型/世界文件 | POST `/model-uploads`及`/{id}/complete或renew`；GET `/model-assets`及`/{id}`；DELETE `/{id}`；GET `/{id}/download` | 多文件manifest、entrypoint、sha256、大小、格式；READY后供画布/导演引用 | media.model_assets/files/uploads，P3 |
| HyperFrames工程 | GET/POST `/hf-projects`；GET/PATCH/DELETE `/{id}` | 独立工程、名称/revision；不使用IPAC工作空间 | hf_projects，P3 |
| HF文件 | GET `/{id}/files`、GET/PUT/DELETE `/{id}/files/content?path=...`；POST `/{id}/files/bind`；GET `.../files/download` | 文本content；二进制purpose=HF上传后uploadId绑定；替换需文件版本 | hf_files/blobs/blob_uploads，P3 |
| HF导出/进度/历史 | GET/POST `/{id}/renders`、GET/DELETE `.../{renderId}`、POST `.../{renderId}/cancel`；GET `/{id}/events` | fps数值24/30/60、quality/format/resolution?/composition?；固定工程文件revision渲染 | hf_revisions/revision_files/renders/events，P3 |
| 独立导演工程 | GET/POST `/director-projects`；GET/PUT/DELETE `/{id}` | type=2D或3D、name/content/thumbnailAssetId | director_projects，P3 |
| 个人导演模型 | GET/POST `/director-models`、DELETE `/{id}` | modelAssetId/name/categoryId/previewAssetId；kind默认PROP | director_models，P3 |

角色filters的query为JSON数组，例如 `[{"categoryCode":"gender","optionCodes":["female"]}]`；分类间AND，同分类OR，剔除all、空值和重复值。查询先分页角色ID再批量加载属性/图片/收藏，避免JOIN重复造成total或分页错误。目录列表由数据库返回，service不能回落fixture；已有静态内容仅作为经审核的初始化种子。

资产库`/entries`由UNION读模型统一count/排序；省略parentId查根，递归搜索显式开启，不将两份独立分页拼一页。库批量命令采用全成全败：先锁collection，检查全部对象与expectedCollectionRevision，再写入。原站部分失败返回尚未核实，旧PF合同本来要求原子批处理，兼容层只能显式映射，不能伪造成功项。

自有图库与公共角色分开。添加公共图先materialize为本人READY资产；图谱保存仍检查本人有效assetId。角色/资源收藏只更改用户态；应用工作流、音色或预设是读详情后本地图谱修改，保存复用原快照接口，不另外编造生成调用。私有Workflow图中的媒体引用也需本人有效资源；公司模板必须在使用时转换目录媒体引用，不能将别人的assetId复制给当前用户。

## 3. 执行、历史与文件规则

`RunInput`结构示例；projectId、modelCode、参数须替换为本人作品及可用目录项：

```json
{
  "projectId":"project_1", "baseRevision":8,
  "targetType":"NODE", "targetId":"n1",
  "graph":{
    "schemaVersion":"1",
    "nodes":[
      {"id":"rhtv_meta_v1","type":"__rhtv_meta","position":{"x":0,"y":0},"data":{"version":"1","meta":{},"edges":{}}},
      {"id":"n1","type":"rh-image","position":{"x":100,"y":100},"data":{"subType":"text-image","modelCode":"configured-model","params":{"prompt":"图形","resolution":"1k"}}}
    ],
    "edges":[],"viewport":{"x":0,"y":0,"zoom":1}
  },
  "executionKey":"generate-action-1"
}
```

提交前端尽量先保存；后端验证当前project revision，冻结请求graph但不隐式覆盖已保存快照。NODE/GROUP必须提供请求图中存在的targetId，CANVAS必须为null（内部target_id规范为projectId）。meta节点不执行；planner验证DAG、资产归属、参数类型、结果数与依赖，保存plans、固定模型能力版本及resolved params。原生modelCode/subType由兼容层解析为目录能力；文本/媒体URL仅为UI展示，执行输入解析为本人READY资源或已授权目录物化资源，禁止裸URL取回。

图片/视频/音频结果绑定真实Asset；模型绑定ModelAsset；WORLD_3D输出授权文件；脚本/分镜为有schemaCode的结构化输出。只有SUCCEEDED输出进入可用历史；失败输出保留诊断记录。未知状态枚举使用PF合同定义，不照抄原站未实测的task status。

普通图片工具、视频模型、LLM、分镜和3D生成统一canvas-runs。优化、识别、抠图等辅助按钮可由兼容层构造临时执行节点，在提交图中选中该节点；不改已保存画布。片段重拍等多阶段操作使用DAG：FFmpeg切段→模型生成→拼接。媒体工具不用大模型执行器；实时画板先把PNG上传为真实Asset，再提交sketch-runs，按用户操作节流/取消，重新打开不能自动恢复收费提交。

Worker短事务领取可执行plan/租约，递增fence，外部调用在事务外执行；回写同时匹配plan/fence/lease和合法状态。provider提交后响应超时记录attempt UNKNOWN，先查询/核对，不能因租约失效再次收费提交。物理文件与PG不是原子事务：先staging/校验，短事务绑定READY对象；失败由重试或清理任务收敛。

history的节点显隐、全局显隐分开，删除只改可见性。节点删输出在head锁内更新revision/resultCount并确定fallback，前端收到后改当前展示并保存图谱。输出/冻结参数/物理文件不跟随历史删除，GC需检查所有图谱、库、版本、任务和HF引用。knownRevision与当前不一致返回412以重拉第一页，不能拼接不同版本分页。

Skill主文件必须为唯一有效SKILL.md；相对路径规范化，禁止逃逸与重复路径。SQL保证owner与blob/receipt关联；application还要校验receipt READY、purpose、HF工程绑定、媒体kind、真实内容/大小，不能将这些称为已存在的SQL约束。HF文本/二进制保存递增文件与工程revision，渲染冻结完整文件manifest，不读取运行中可变文件。HF输出先有授权下载，回画布走真实Asset上传/导入；未导入前outputAssetId=null，不填伪Asset或canvas项目ID。WORLD_3D文件复用P3多文件上传/校验成为本人ModelAsset后进入图谱，不能保存裸blobId作为执行授权；兼容层可保留原来的选中结果与预览。

HF预览、lint、复制/重命名文件、组件安装、删除时间线元素可由兼容层和Studio应用用例组合文件读写及版本校验；不单独建空业务表。它们的专用原生`studio-api`兼容协议在P3实施时补合同，**当前119个领域操作不宣称覆盖这些专用协议**。预览/渲染在隔离环境中运行，不给用户HTML、组件或渲染进程数据库/IPAC密钥。新增客户端工具需固定允许的工具名/参数schema，不将LLM输出直接当服务端命令。

## 4. 保持原有前端逻辑

| 当前/原生行为 | 接入方式 |
|---|---|
| 项目CRUD、pin、图谱快照、预签名上传与媒体Range | 复用当前v1真实API，保留ETag、owner检查、错误包、登录刷新/撤权语义 |
| 原站POST分页、旧PF返回DTO | 自有HTTP兼容层调用v2用例，转换分页数字、三视图/属性、版本引用和节点内容；不透传原站接口 |
| Frozen Model/Generation.mode有限枚举 | 旧API只投影其已定义子集；42类nodeType进入新能力目录，不能改旧enum或强行全部塞进IMAGE/VIDEO |
| 冻结Folder.kind没有MIXED | 原生库使用新合同；旧接口只投影匹配的typed目录，不返回违反旧schema的MIXED值 |
| 画布移动/连线/缩放/小地图/图形/预览等 | 保持本地交互；修改图谱的行为沿用快照保存；UI不新增工作空间或权限选择 |
| 导演节点模式 | schema仍在node.data与graph中，不创建重复独立导演工程；只有独立2D/3D入口用director-projects |
| OpenCut | 继续浏览器IndexedDB/OPFS与本地导出；本轮不编造其服务端工程或渲染接口 |
| 支付、充值、社区、投稿、公共分享 | 内部版继续隐藏；未建支付/订单/公共授权表 |

## 5. 实施边界

P1先上目录真实分页、角色收藏、个人库、标签与资源版本，并接通对应悬空前端操作；P2上worker、生成、历史和Canvas Agent；P3上多文件3D、独立HF与导演服务。每个操作通过真实集成验证后才标IMPLEMENTED；未配置的模型保持明确错误。

稳定错误至少包括：401未登录，403工具撤权，404对象不可见，409幂等内容/状态/引用冲突，412版本冲突，422参数/schema/文件不合法，429容量限制，501能力/供应商未配置，502供应商协议错误，503依赖临时不可用。重试限于明确未提交的动作；UNKNOWN不得作为普通可重试错误。
