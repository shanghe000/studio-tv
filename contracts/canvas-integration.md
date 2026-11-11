# 画布联调边界（2026-10-03）

本文件记录本轮画布复刻的新增联调范围，不修改已经冻结的 v1.0.0 OpenAPI，也不代表后端已实现。当前使用本地 Yjs 文档、IndexedDB/localStorage 和浏览器素材代理；生成、支付与多人协同均未连接服务端。

## 可复用与待扩展

| 能力 | v1 可复用 | 新边界 |
| --- | --- | --- |
| 项目与普通快照 | 项目 CRUD、pin、snapshot、ETag/revision、受控分享及克隆 | 原图 meta/name、parentId 分组、节点/连线样式需明确转换；权限、锁定项目和模板来源也需定义 |
| 媒体 | 上传、complete、READY、资产读取/删除 | 本机 URL 和 rhtv-asset 引用须映射为权威 assetId；TEXT 素材另建库条目类型 |
| 素材库 | 身份、字符串 ID、分页、并发与错误模型 | 文件夹树、素材条目、移动、级联删除、缩略图和引用关系 |
| AI 应用 | 资产、报价、账务、任务状态机制 | 版本化应用目录、输入规格、绑定、计价及独立运行协议 |
| 协同 | 身份、项目权限和 revision 规则 | 房间连接、持久确认、更新同步、断线恢复、generation fence 与修复 |

v1 的 GraphSnapshot 不能直接完整透传原生 Yjs 图；其 nodes/edges/viewport 与原图的 meta、分组和扩展 data 必须有版本化导入/导出规则。应保存转换后的快照和所需编辑器扩展，避免恢复时丢失分组、样式或输入绑定。

## 已接入本地行为的旧接口

这些路径由 `dist/replica.js`、`canvas-runtime.js`、`asset-runtime.js` 在浏览器模拟；上线后须换成真正服务端适配器。

- 项目：`/canvas/list`、`create`、`rename`、`delete`、`pin`、`unpin`；`checkUserIdByCanvasId`、`getCanvasDetail`/`detail/byCanvasId`；`share/link`、`share/clone`、`createFromCase`、`saveLockedCopy`。
- 文件夹：`/canvas/asset/type/list`；`/canvas/asset/user/folder/first-level/list`、`second-level/list`、`second-level/item/list`、`item/search`、`create`、`item/batch-add`、`batch-delete`、`move`、`thumbnail/update`；兼容 `/canvas/asset/user/group/create`、`rename`、`item/list`、`item/batch-add`、`item/rename`。
- 用户偏好：`/canvas/user/detail`、`user/update/shortcutKeyConfig`。节点标签与生成历史目前为空，无后端记录。
- 角色目录：`/canvas/character-library/filter/options`、`list`、`favorite`。公共内容为采样快照，收藏保存在当前浏览器。
- 应用目录：`/api/webapp/list`、`webapp/detail`、`webapp/user/list`、`likeOrCollect/webapp/list`、`portal/tag/tree`、`cost/average`、`portal/creation/list`。公共内容与输入规格为采样快照；个人发布列表为空。

素材列表返回 `{records,current,size,total,pages,hasNext}`。文件夹同时提供 `id/groupId/code/name/type/nodeKind/nodeType/isFolder`；素材条目提供 `id/itemId/groupId/itemName/nodeType/content/url/thumbnail`。创建使用 `{name,parentCode}`；添加使用 `{folderId,nodes:[{itemName,content,nodeType,thumbnail}]}`；移动使用 `{targetCode,groupIds,itemIds}`；批量删除使用 `{groupIds,itemIds}`，逐项失败返回 `failedItems`。

服务端必须区分“移除库条目”和“删除底层媒体文件”，检查所有项目引用。文件夹移动禁止形成环；团队与个人资源需按租户、拥有者和项目权限隔离。不能仅凭客户端传入的 teamId/groupId 授权。

## AI 应用与运行

应用的 `inputNodes` 包含 `nodeId/nodeName/fieldName/fieldType/fieldValue/fieldData/description/descriptionEn`；`fieldData` 当前是 JSON 字符串，须显式解析和校验，不能执行其中脚本或透传第三方凭据。采样类型包括 IMAGE、VIDEO、AUDIO、STRING、INT、FLOAT、LIST、SWITCH、BOOLEAN。

应定义独立 AppInputSchema：固定应用版本、字段 ID、类型、默认值、枚举与边界、必填规则和输入资产绑定。IMAGE/VIDEO/AUDIO/STRING 可在编辑器自动创建输入节点，通过 binding.sourceNodeId 连向应用节点。执行前由服务端解析图、校验绑定与资产权限，再复用 v1 的报价、账务和任务状态。

任意节点、分组或整图执行不能转换成首页 GenerationInput 假装运行。`/canvas/task/run`、`/canvas/media/task/run`、AI 助手及相关生成接口当前明确不可用。价格只有已采样的 skuId + priceFactors 组合可展示快照，其他组合显示“待接入”；结算必须使用服务端实时、版本化报价。

## Yjs 与本机素材

当前编辑器使用 connectLocalFixture，本地撤销重做与节点更新是真实 Yjs 操作，但没有网络协同。`/__rhtv_media/:id/:name` 由同源 Service Worker 从 IndexedDB 读取，仅在保存文件的浏览器中有效；Range/HEAD 支持用于图片、音频和视频预览。该地址不能发送给生成服务，也不能作为跨设备分享中的资产地址。

后续协同需要定义 WebSocket 消息版本、项目房间鉴权、更新序号与 durable ACK、断线重放、快照压缩及 generation fence。原 `/canvas/client-backup/claim`、`complete`、`yjs-baseline-reset/candidate`、`yjs/divergence-repair/candidate/init`、`chunk`、`complete` 不属于 v1；正式协议完成前保持未实现状态。


## 嵌入剪辑与 HyperFrames

OpenCut 在 `/opencut/index.html` 原生运行，读取画布素材/本地资产，使用 IndexedDB/OPFS 保存草稿，通过 WebCodecs 在浏览器编码。父窗发 `opencut:import-video(s)`、`import-timeline`、`reset-project`、`open-export-dialog`、`flush-save`；子窗通过 `opencut-export-to-canvas` 传回 `File/Blob` 数组。必须校验 source 与 origin，导回的文件仍通过正式资产上传协议提交后端。

HyperFrames 是 `/labs/rhhyperframes` 的独立 Nuxt 页面，项目编辑还嵌套 `/hyperframes-studio/index.html`。`/canvas/hf/projects` 返回 `{projects:[]}`；项目会话列表返回分页 `records`。OpenClaw 会话/Agent 创建成功值必须为字符串 ID，聊天为 SSE；当前真实报待接入，不返回伪造生成结果。Studio `/studio-api` 使用直接 JSON（不包 `code/data`），后续必须单独定义项目文件、预览与服务器渲染协议。其 render 进度通过 EventSource 同步，不属于当前 v1。
