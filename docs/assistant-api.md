# Assistant 实际接口

本模块使用真实 Go/PostgreSQL 会话、消息、删除回执和任务证据。独立 [assistant-extension.json](../contracts/assistant-extension.json) / [yaml](../contracts/assistant-extension.yaml) 为 OpenAPI3.1、版本1.3.0：9个IMPLEMENTED操作和5个历史RESERVED运行入口。生产任务由execution模块注册，实际运行、事件和取消协议见 [execution-extension.json](../contracts/execution-extension.json)；本合同的历史RESERVED标记不能作为生产执行能力声明。客户端工具回执/恢复尚未实现，明确501。只有 Router 的模型输出使用明示的测试模式。

| 方法与路径 | 本模块实际行为 |
|---|---|
| GET `/api/v2/conversations` | 本人活跃GLOBAL/CANVAS/HF，会话更新时间降序、ID排序 |
| POST `/api/v2/conversations` | 持久创建GLOBAL/CANVAS/HF，UUID幂等回执；201、强ETag |
| GET `/api/v2/conversations/{id}` | 真实详情与当前revision/ETag |
| DELETE `/api/v2/conversations/{id}` | If-Match软删会话，返回accepted:true，保留消息证据 |
| GET `/api/v2/conversations/{id}/messages` | 本人未删除消息，seq、ID升序，真实count/分页 |
| POST `/api/v2/conversations/{id}/messages` | USER TEXT、授权READY ASSET、当前选中skill快照；不自动提交运行 |
| DELETE `/api/v2/conversations/{id}/turns/{turnId}` | turnId为真实USER消息ID；删除USER及下一物理USER前的ASSISTANT回复 |
| DELETE `/api/v2/conversations/{id}/messages/{messageId}` | USER同整轮语义，ASSISTANT/TOOL只删除自身 |
| GET `/api/v2/conversations/{id}/client-tools/pending` | 读取真实tasks/events；无工具证据返回none，有未实现工具证据501 |

所有接口使用服务端验证的 `httpapi.IdentityFrom` owner与实时 `tv.access`，不接受用户提供的owner/workspace。跨用户会话/消息404。CANVAS绑定本人未删除且internal_kind为空的public.projects；HF可不绑定，绑定后须为本人未删除studio项目，其底层Canvas也须有效。每次请求和回执重放都检查真实父级，父级/会话软删后404。GLOBAL不依赖项目或临时登录session。

创建正文例如 `{"kind":"GLOBAL","title":"首页会话"}`；GLOBAL项目字段仅可省略/null，CANVAS要求projectId，HF仅接受可选hfProjectId。创建UUID作用域为owner+operation+key，省略与null不同；根与回执原子提交。持久身份、kind和已建立绑定不可更改。

列表支持kind/projectId/hfProjectId/page/size/keyword。默认page1/size20，上限page100000/size100；keyword首尾去空白后最多300字符，SQL `%`/`_`按字面匹配。未知/重复字段400；不兼容的kind和项目过滤400。消息搜索TEXT部分；deleted_at非null行不进入count、records和分页。

## 用户消息写入

```http
POST /api/v2/conversations/cnv_example/messages
Content-Type: application/json
Idempotency-Key: f9b7a437-06f2-4d3c-884a-27d6bc3e0053
If-Match: "1"

{"content":[{"type":"TEXT","text":"帮我整理这个剧本"}]}
```

正文仅content，1..100段。TEXT保留原文，每段最多200000Unicode字符、NUL非法，整体不能只含空白。ASSET仅assetId，须实际属于本人、READY、未删除且父级有效；授权后同事务保存message_assets。STRUCTURED只实现ASSISTANT_SKILL_V1：skillId/revision/version/markdown及文件 `{path,content}` 须与当前允许的持久skill一致。其他STRUCTURED schema501。未知字段、浏览器指定role/id/seq/native状态/usage400；正文上限1MiB超413，非application/json415。

201数据为 `id/conversationId/seq/role/content/createdAt` 加conversationRevision。USER角色、ID、时间和seq由服务端生成。会话根加锁后查询实际QUEUED/RUNNING任务；新的USER遇活动任务409 ASSISTANT_TASK_ACTIVE，防止上一轮回复写入下一轮。仍可见的旧append回执可重放，因为没有新写入。消息、序号、根revision和回执原子提交，失败不消耗序号/UUID。

UUID必须36字符带连字符格式，大小写归一。消息operation为assistantAppendUserMessage；SHA256绑定canonical content、conversationId、冻结If-Match。同key同请求重放原201和原ETag，变内容/路径/版本409；新key旧版本412。重放重新读取实际活跃消息验证内容，已删除目标404，不从回执复活。旧回执ETag可能低于当前revision；继续写入前GET详情。

## 删除轮次与消息

```http
DELETE /api/v2/conversations/cnv_example/turns/msg_user
Idempotency-Key: f9b7a437-06f2-4d3c-884a-27d6bc3e0054
If-Match: "5"
```

两个入口不接受正文/查询，要求UUID与正整数强If-Match。200数据与ETag来自真实删除：

```json
{"conversationId":"cnv_example","deletedMessageIds":["msg_user","msg_reply"],"conversationRevision":6,"deletedAt":"2026-10-05T00:00:00.000Z"}
```

USER单消息也删除整轮，避免孤立回复；ASSISTANT/TOOL只删自身。边界是下一条**物理USER行**，即使已删除也不合并轮次。目标不存在、已删除或不属于会话404；turnId不是USER400。前端刷新已提交历史，使用实际deletedMessageIds。

会话锁内根据task.payload.task.messageId和assistant_results检查受影响的QUEUED/RUNNING任务，有则409；无法识别消息绑定的活动任务保守409。无关的新轮次任务允许旧轮次删除。一次最多1000条活跃目标消息，超413 TURN_TOO_LARGE且整笔回滚；可先单删部分ASSISTANT回复再重试。

只设置deleted_at、递增会话revision一次，next_message_sequence不回退/复用。012迁移保护消息内容/owner/seq/role/createdAt不可修改，deleted_at设置后不可改值或恢复。消息、message_assets、任务、结果与回执保留为证据；历史/context/运行输入排除已删除消息。

删除operation为assistantDeleteTurn/assistantDeleteMessage。UUID哈希绑定具体路径、目标、操作和冻结版本；同请求重放原200、时间、ID集合和ETag，后续消息不改变旧回执。每次重放仍检查活跃根/父级和真实删除行。变请求409，新UUID旧版本412。删除或保存回执失败，整个事务回滚。

## 客户端工具状态

读取真实owner会话tasks及相同owner events。目前明确Router mock不产生工具；没有工具/WAITING_TOOL证据时返回：

```json
{"session_id":"cnv_example","status":"none","call":null,"resume_command":null,"active_resume":null,"host_events":[],"terminal_recovered":false}
```

这是实际SQL absence，空toolCalls数组不算调用。实际payload/plans/event中出现工具调用或WAITING_TOOL，返回501 CLIENT_TOOLS_UNAVAILABLE，因为receipt/resume协议尚未实现；保留的历史工具证据也明确501，不造resume ID、回执或host_events。

## 传输与验证

缺If-Match428、非法/弱/重复400、旧版本412附CURRENT_REVISION。成功envelope为 `{code:0,message:"OK",data,requestId}`，分页 `{records,page,size,total,hasNext}`；错误 `{code,message,requestId,retryable,details}`，存储故障503。X-Request-Id与envelope一致，Cache-Control:no-store。

组合不变：postgres.New(pool) → application.New(uow) → RegisterRoutes(router,service,protect)。生命周期与活动任务port为optional interface；旧适配器缺生命周期port明确501，真实PostgreSQL完整实现。核心/媒体HF/生命周期迁移为004/010/012。

新增数据库用例：TestPostgresAssistantTurnDeletionReceiptsImmutableAndRestore、TestPostgresAssistantLifecycleActiveTaskToolsAndParentOwnership、TestPostgresAssistantLifecycleRollbackAndBoundedDeletion。覆盖并发回执、实际范围、不可复活、SQL不可修改、证据保留、活动任务原子拒绝、真实工具事件501/空证据none、Canvas/HF父级失效、两阶段事务回滚和1000条边界。只用显式含test名称且具CREATEDB权限的TEST_DATABASE_URL创建/删除自身随机独立数据库；无DSN明确SKIP，不能宣称PG通过。
