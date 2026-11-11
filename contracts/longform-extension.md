# H3 分段长片扩展（IMPLEMENTED）

本扩展不修改冻结的 v1 OpenAPI。所有 STUDIO 路由位于现有已登录且 `tv.access` 验证的业务路由内。网页不操作文件版本、备份或内部读授权；只操作片段、生成历史、采用和合片。

## 路由与响应

- `GET /api/v2/longform/capabilities`：透传真实服务能力，包含 `available`, `defaults`, `options`, `limits`, `actions`, `settingsSchema`。未配置/未授权真实执行返回 501，不生成模拟结果。
- `POST /api/v2/longform/projects`：创建画布视频节点绑定。
- `GET /api/v2/longform/projects?canvasId=...&nodeId=...`：`data.items` 返回该登录账号的绑定列表，支持刷新恢复，不以浏览器缓存作为权威。
- `GET /api/v2/longform/projects/{id}`：当前状态，包含后台归档后的候选与合片地址。
- `POST /api/v2/longform/projects/{id}/actions`：修改草稿、生成、重抽、采用、合片和段后停止。
- `GET /api/v2/longform/projects/{id}/artifacts/{artifactId}/content`：已验证账号/项目归属的 MP4 内容，支持 HTTP Range。

JSON 成功响应沿用 `{code:0,message:"OK",requestId,data}`；create/actions 的 `data` 为项目本体。STUDIO `id` 是稳定 UUID，与 Router 内部项目 ID 分离。状态枚举为 `QUEUED/RUNNING/SUCCEEDED/FAILED/UNKNOWN/STOPPED`。`revision` 仅作后台并发前置条件，不呈现为用户存储版本操作。

## 创建输入

```json
{
  "requestId":"<UUID>","canvasId":"<PF项目ID>","nodeId":"<rh-video节点ID>",
  "title":"长片", "settings":{"seed":"2026110401"},"commonPrompt":"共用描述",
  "segments":[{"id":"EP01_S01","prompt":"本段剧情","duration":10,"seed":"2026110401"}],
  "references":[{"kind":"IMAGE","assetId":"ast_...","role":"REFERENCE_IMAGE"}]
}
```

写请求携带现有 `X-STUDIO-Canvas-Session`。服务器核对真实用户、画布编辑权、编辑会话和已保存的视频节点；参考只能来自该节点直接输入连线或明确附件，且每次模型读取重新检查实际资产访问权。只有服务端将资产 ID 转为受限不可变内容授权，浏览器不能提交 URL、模型路径、`mediaId` 或 `attachment`。

参考最多 18 份：9 IMAGE、3 VIDEO、3 独立 AUDIO、3 视频配对 AUDIO。配对音轨用 `kind:"AUDIO",role:"VIDEO_AUDIO",videoIndex:0`，序号须对应输入视频且不得重复。独立音频不带 `videoIndex`。

完整参数由 `settingsSchema` 声明，STUDIO 不编造可用模型/选项。uint64 种子为十进制字符串，避免 JavaScript/JSON 数值精度损失。

## 动作

所有动作包含 `requestId`（UUID）、`expectedRevision`（当前项目 revision）、`type`；可带 `canvasId` 辅助前端编辑会话头选择，服务器仅核对绑定后移除，不转发。

| type | 附加字段 |
| --- | --- |
| updateDraft | patch: title/settings/commonPrompt/segments/references；STUDIO 服务转为云端顶层字段 |
| generateAll | 无 |
| retrySegment | segmentId，及可选 prompt/seed/settings/references/commonPrompt |
| regenerateFrom | segmentId |
| keepFollowing | segmentId，明确接受后续原片衔接 |
| append | segments；服务自动追加并生成，不另发 generateAll |
| adoptCandidate | segmentId,candidateId；null 撤回采用 |
| composeSelected | 无 |
| stopAfterSegment | 无；不调用全局 GPU interrupt |

相同 requestId/相同正文安全重放；改变正文返回冲突。明确上游 4xx 拒绝记录为确定失败，不在后台循环重提。连接中断/5xx 保留原请求和 requestId 恢复，不能擅自新开生成任务。可修参数、上下文和前段缺失错误保留上游 4xx/错误码；不伪装成成功或泛化成无限重试。

## 产物与画布

后台独立轮询已接受任务，即使页面关闭仍回收。产物通过服务鉴权的固定 Router 路由读取，检查 MP4 类型、声明长度和 SHA256 后导入 STUDIO 自有不可变资产。候选/合片增加 `assetId`, `url:"rhtv-asset:..."`, `downloadUrl`。合片成为原视频节点输出；全部已归档候选/合片进入现有生成历史，不进入模型待执行队列。

长片产物单文件上限 1 GiB；仅此导入入口扩容，不改变普通上传/模型视频的既有上限。云端原生视频/合片归档还受 `H3_MAX_OUTPUT_BYTES` 限制，当前基线默认 **512 MiB**；实际端到端上限取云端限制和 STUDIO 限制的较小值。当前读取过程有界但使用内存缓冲，不能宣传无限大小或无限时长。上下文与模型状态保留在云端项目，下载 MP4 不等于可恢复 LATENT。

长片 JSON 请求上限 4 MiB，完整项目状态响应上限 16 MiB；只扩本路由，不改变普通 Gateway 上限。历史达到项目响应容量限制时须拆成新长片，不能宣传任意长候选历史。

`SUBMITTING` 与 `COMPOSING` 同样属于活跃任务；后台互斥和恢复不得仅检查 RUNNING。超出 16 MiB 的真实状态读取明确返回 `413 LONGFORM_STATE_TOO_LARGE`，保留原任务/幂等请求，不能当成确定提交失败重新生成。
