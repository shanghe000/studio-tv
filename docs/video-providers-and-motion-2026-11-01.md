# 视频供应商与动作迁移接入

状态：**IMPLEMENTED，官方入口默认停用**。未提供官方 API Key，本次没有执行收费推理；官方适配器的协议测试使用本地 HTTP transport。完整视频效果仍由人工验收。

Studio TV → Models Router → 具体执行器的边界保持不变。新增供应商使用独立执行器，将异步提交、查询、素材角色和输出回收映射为已有中立协议。切换模型是新任务的明确选择；已经接受的任务继续按冻结的 capability/version 执行，不自动回退到其它供应商。

- 官方 MiniMax H3、Highspeed、Lite、Max：文生、首帧、尾帧、首尾帧、全能参考。
- 官方 Seedance 2.5、2.0、Fast、Mini：文生、首帧、首尾帧、全能参考。
- ComfyUI：H3 动作迁移、Wan Animate2 动作迁移、SCAIL2 动作迁移、SCAIL2 人物替换。

以上官方入口在基础服务未配置或用户未填写个人厂商 Key 时仍可见但置灰。个人设置按厂商保存一次 Key，自动匹配该用户选择的相关官方型号；MiniMax 可选择 global/cn 地区，自部署模型无需 Key。官方服务严格使用个人 Key，不回落到共享开发者 Key。接口和失败原因见[个人厂商 Key 接入](personal-provider-keys.md)。供应商的分辨率档位、自动比例与时长限制由真实目录描述，浏览器只选择目录中的完整元组，不拼造未声明组合。Seedance 2.5 全能参考使用智能时长和自动比例；其它模式按各自声明的档位选择。

## 参数和素材

目录扩展 `x-video-parameter-metadata.schemaVersion=1`、`x-video-mode`、`x-media-roles` 与 `x-subject-control` 驱动自有前端控件。角色以 STUDIO 素材 ID 写入现有 `promptSelection.referenceBindings`，不将浏览器 URL 直接作为厂商下载地址。多人 `subjectMapping` 保持数字对象数组，禁止字符串化、重复人物及越界索引。

新目录明确选择当前参考素材语义。任务的私有 `CatalogVideoRoles` 标志随冻结请求保存，worker 恢复后沿用接受时的策略；旧任务不会因部署取得新的角色推断行为。尾帧使用 `END_VIDEO` / `LAST_FRAME`，不降为首帧。

`supportsCancel=false` 的新视频能力在接受时冻结私有取消策略。STUDIO 和 Router 都拒绝中途停止请求，并继续查询真实结果，不把本地状态改成“已取消”来代替上游停止；终态可继续正常读取。

动作迁移要求一张人物图和一段 5.2–15 秒动作视频，当前输出约 5 秒。H3、Wan Animate2 要求单人；SCAIL2 支持同一张图中的 1–5 人，按画面从左到右的检测编号（从 0 开始）配对图片人物和源视频人物。SAM3 自动生成身份遮罩，不要求用户绘制字母或上传手工遮罩。具体限制及操作以使用指南和目录说明为准。

## 授权素材临时出口

**IMPLEMENTED：** `POST /internal/model-assets/export-media` 仅接受现有独立 model-media 服务 Bearer，入参同 `read-media`：`subjectRef/sourceRef/sourceVersion/sha256/readGrantRef`。返回 HTTPS URL、失效时间及校验后的媒体元数据。请求和每次下载都重新验证原始发起人、任务 grant、项目访问权限和不可变媒体摘要。

`GET/HEAD /storage/model-media/export?token=…` 使用一小时以内的加密下载租约；AES-GCM 密钥由现有服务端签名密钥分域派生。身份及 grant 不以明文进入 URL，签名地址不写入任务、Git 或日志；撤销权限后，条件请求和 Range 也不能绕过验证。HTTP 本机环境停用第三方出口。Router 还须显式允许 STUDIO 公开出口主机；官方 Key 从不发往媒体主机或浏览器。

冻结的 v1 核心 OpenAPI 无变动。官方 Key、外部 secret 挂载与启用流程见 Models Router 的 `docs/official-video-apis.md`；本文件不记录凭据。
