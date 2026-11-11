# 模型能力与适配器预留

所有能力当前 `stage=RESERVED, connected=false`。不调用模型、不探测密钥，不对任何供应商声明可用。`model-capabilities.json/yaml` 是 provider-neutral JSON Schema 2020-12，不是一个已连接的公共模型调用 API。

| 能力 | 内部输入 | 可选传输 |
| --- | --- | --- |
| LLM | messages 的 TEXT/ASSET parts 与 parameters | JSON、SSE、轮询或异步回调 |
| TEXT_TO_IMAGE | prompt、outputCount、parameters | JSON、轮询或异步回调 |
| IMAGE_TO_VIDEO | sourceAssetId、prompt、parameters | 轮询、异步回调或 JSON |
| OMNI_REFERENCE | prompt、资产角色 references、parameters | JSON、轮询、异步回调或 SSE |

类型只是适配边界；供应商支持的参数、角色、数量、时长与响应取决于版本化 Model.parameterSchema/inputs/invocationTypes。LLM 的部件形式也不强迫供应商使用 OpenAI messages 格式；视频和全能参考可有不同 endpoints、原生请求/回调、签名与异步状态。

适配器接口预留：

```text
validate(input, capabilityVersion, invocationType) -> validated input or error
prepare(validated input, authorized asset handles) -> provider-native request
submit(native request, idempotency context, abort signal) -> receipt
poll(receipt) -> provider state (when provider supports polling)
consumeEvent(signed callback or stream event) -> provider state (when supported)
cancel(receipt) -> cancellation acknowledgement (when supported)
normalize(provider state) -> outputs/usage/evidence (never invented)
```

`AdapterInvocation` 绑定 requestId/modelId/capabilityVersion/invocationType 和能力输入；nativeRequest 是仅服务端构造的 schemaVersion+body，不由浏览器提交供应商 endpoint、API key、Authorization 或任意网络 URL。凭据只在后端密钥环境中；发现目录不返回密钥、供应商私有地址或收费可用性推断。

Provider receipt、usage 与 evidence 应由各适配器定义原生 schema，并由服务端标准化到 v1 的结果资产、任务状态和账务证据；不能把“返回了字符串”当成视频生成完成。暂不保证每种供应商支持取消、stream、poll 或 usage，适配器必须显式报告支持能力与未实现状态。

首页仍使用冻结 v1 `modelId+capabilityVersion+invocationType` → 完整报价 → Generation。新 capability schema 不新增一条绕过报价/权限的公共 provider proxy。未来接通需配置提供商、验证原生协议、实现适配器，再修改 stage 并完成独立验收；预留本身不消耗模型调用额度。
