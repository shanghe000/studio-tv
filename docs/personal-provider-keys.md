# 个人厂商 API Key 接入

状态：**IMPLEMENTED**。用户在个人设置中配置一次 Key，STUDIO 按已验证的个人身份自动匹配相应官方视频模型。MiniMax H3 各型号共用 `minimax-official`，Seedance 各型号共用 `volcengine-official`。自部署 ComfyUI 模型无需 Key。保存 Key 不调用厂商验证或生成接口。

接口见 [个人凭据扩展](../contracts/provider-credentials-extension.yaml)。冻结的核心 OpenAPI、画布与中立 invocation 请求没有新增凭据字段。

1. `GET /api/v2/me/model-provider-credentials` 返回两家厂商的 `providerRef/title/configured/maskedKey/region?/updatedAt/configurable/reason?`，常规 STUDIO envelope 的 `data` 内含 `items/schemaVersion=1`。
2. `PUT /api/v2/me/model-provider-credentials/{providerRef}` 只接受 `apiKey/region?`。MiniMax 地区为 `global` 或 `cn`，省略时默认 `global`；Seedance 不接受地区。接口只返回掩码和状态，不支持读取原值。
3. `DELETE` 同一路径清除个人 Key。未提交的任务不能继续使用删除的版本；已在厂商接受的任务是否能恢复查询，以 Router 明确的版本与删除策略为准，不能静默借用他人的 Key。

MiniMax 官方 H3 使用按量计费平台 API Key；Coding Plan 的套餐 Key 不适用于视频生成。选择 Key 对应的 global/cn 平台地区，平台权限、余额与可用型号仍以厂商账户为准。

STUDIO 使用登录身份生成 Router actor proof，将 CRUD 代理到 Router 的 `/v1/provider-credentials`。Key 仅通过配置写请求发到加密 vault；画布提交参数、项目快照、任务 JSON、模型选择、日志和错误响应均不包含 Key。共享项目的存储所有者不会替代实际发起人，Router 必须按 `clientApp + subjectRef + providerRef` 解析个人 Key。官方视频严格使用个人 Key，不回落开发者配置或其他用户的 Key。

实际提交的模型参数与提示词条件拒绝 `apiKey/providerApiKey/authorization/credentialRef`（忽略大小写及下划线、连接符差异），返回 422 `PROVIDER_CREDENTIAL_PARAMETER_FORBIDDEN` 并提示去个人设置配置。这个保留字段检查不扫描任意画布展示元数据或人物标签，也不把 `subjectRef` 当作凭据字段。

Router 必须先部署加密 vault 与专用 master key，STUDIO 网页才能保存和使用个人 Key。vault 未就绪时 GET 仍返回两家厂商，但 `configurable=false`；保存和删除明确失败。个人 Key 服务须由运维显式部署，参考素材读取、临时出口等基础条件仍会检查。`ROUTER_OFFICIAL_VIDEO_ENABLED` 是旧共享开发者 Key 路径的开关，不控制已部署的个人 Key 服务；个人 Key 不回落共享 Key。

模型目录的 `parameterSchema.x-model-source` 明确声明 `kind: SELF_HOSTED|API`。需要个人 Key 的 API 模型附带 `credentialProviderRef/credentialConfigured/unavailableCode`。该元数据由 Router 投影，STUDIO 透传目录；前端不得通过模型名字猜测来源，不把 source 或 Key 写成模型参数。目录中的用户状态与可用性是请求时投影，不修改冻结的模型参数约束或已接受任务。

任务失败保留稳定 `task.errorCode/plans[].errorCode`。画布 `errorMsg` 与即时 HTTP 错误使用 STUDIO 编写的中文说明，只映射已知错误，丢弃厂商原始消息：

| Code | 页面提示的原因 |
| --- | --- |
| `PROVIDER_CREDENTIAL_REQUIRED` | 个人设置尚未配置该厂商 Key |
| `PROVIDER_CREDENTIAL_KEY_REMOVED` | 本次任务绑定的 Key 已移除，需重新配置并提交 |
| `PROVIDER_CREDENTIALS_DISABLED` | Key 服务暂不可用 |
| `OFFICIAL_VIDEO_NOT_CONFIGURED` | 官方视频服务尚未开放 |
| `OFFICIAL_VIDEO_INSUFFICIENT_BALANCE` | 厂商账户余额不足 |
| `OFFICIAL_VIDEO_AUTH_FAILED` | Key 无效或权限不足 |
| `OFFICIAL_VIDEO_RATE_LIMITED` | 调用过于频繁 |
| `OFFICIAL_VIDEO_USAGE_LIMIT` | 调用额度或套餐配额已用尽 |
| `OFFICIAL_VIDEO_CONTENT_REJECTED` | 提示词或素材未通过内容审核 |
| `OFFICIAL_VIDEO_INPUT_INVALID` | 参数或素材不符合模型要求 |
| `OFFICIAL_VIDEO_REJECTED` | 厂商拒绝本次请求 |

同步提交失败与异步查询失败都会进入 task 和对应 plan 的失败状态，随后写回画布。余额等失败原因不通过真实收费任务验证；本地 transport 和执行器 fixture 覆盖身份绑定、脱敏、错误保留与状态回传。
