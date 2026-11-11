# 画布官方视频费用预估

`POST /api/v2/model-price-estimates` 为 IMPLEMENTED 独立扩展，详见 `contracts/model-price-estimates-extension.json`。要求已登录并具备 `tv.access`，不接收用户 ID、地区或 API Key。STUDIO 将同一用户和精确请求签名转发给 Router `/v1/price-estimates`，不在 STUDIO 保存厂商价格、凭据或余额，响应禁止缓存。

请求示例：

```json
{
  "capabilityRef": "h3-official-text-to-video-v1",
  "capabilityVersion": "1",
  "parameters": {"outputPreset": "768p-16x9-5s"},
  "media": {"imageCount": 0, "videoDurationsMs": []}
}
```

材料统计从当前画布本次实际输入得出。每个视频一项毫秒数，未知传 null；无视频必须传空数组。未知不等于零秒。参数须与当前精确版本生成请求一致；切换型号、参数或材料后须重新估算，响应回显精确版本用于丢弃过期请求。HTTP 成功采用 STUDIO 标准 `data` 包装。

前端按状态显示：

- ESTIMATE：`amount + currency`，显示“预估”。
- RANGE：`minimumAmount–maximumAmount + currency`，附上自动比例/时长假设。
- LOWER_BOUND：`minimumAmount + currency` 并显示“起，实际可能更高”，没有上限。
- UNKNOWN 或接口失败：费用未知，不能显示 0 或免费。

应保留 `basis` / `warnings` 和可点击 `sources`；公开估算不代表余额、优惠、资源包或真实扣费。MiniMax 配置 CN 账户时显示 CNY；global 显示 USD，未配置时明确提示地区未确认。Seedance 为火山引擎 CNY，不做固定汇率转换。自部署模型无厂商费用估算，不能由此显示推理计算成本为零。

“计费规则与来源”同时显示 `checkedAt`，例如“公开价格核对日期：2026-11-02”。这是本次静态公开价表的核对日期，不是厂商承诺的生效日、当前账户账单日期或实时余额查询。前端仅接受真实、规范的 `YYYY-MM-DD` 日期和非空 `pricingRevision`；字段缺失或格式错误时显示费用未知，不把未核验数据当作最新报价。

当前 Seedance 带视频输入的最低 token 完整官方表尚待核验，仅给基础公式起价，不伪造精确费用。详细官方来源与限制见 Router `docs/video-price-estimates.md`。此接口不影响当前生成、余额或冻结 v1 generation-quotes；没有收费调用或实际账单回填。
