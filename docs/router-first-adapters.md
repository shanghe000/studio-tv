# Router 首批适配器：ChatGPT 订阅、Codex、cc-connect、sub2api 与 H3

2026-10-06。调研公开源码和文档，并新增未装配的Codex离线适配包；未读取个人登录令牌、安装网关、启动推理或租用 GPU。方案目标是复用公司已有订阅和自部署能力；价格、额度和真实可用性仍须以具体账号和部署测量为准。

## Codex 能否看图、生成图片

能看图，也具备生成/编辑图片的工具路径，但两者是独立能力。Codex app-server 的 turn 接受 image/localImage；本机 `codex-cli 0.159.2` 生成的 model/list schema 有 inputModalities，`modelProvider/capabilities/read` 有 imageGeneration 标志。官方源码的 image-generation extension 使用 provider 的 Images client，并输出图像产物。[app-server 官方文档](https://learn.chatgpt.com/docs/app-server)、[原生图片工具实现](https://github.com/openai/codex/blob/402f5b6fdf28a7a72c153dbe6fe01e252205d7d6/codex-rs/ext/image-generation/src/tool.rs)、[图片 backend](https://github.com/openai/codex/blob/402f5b6fdf28a7a72c153dbe6fe01e252205d7d6/codex-rs/ext/image-generation/src/backend.rs)

`model/list` 只用于选择模型，不证明账号有权限，也不证明当前 provider 支持每种工具。普通文字、图片理解、图片生成要分别验收。选不同推理模型也不意味着更换了图片生成模型，后者通常由图像工具/backend 决定。

官方目前另有 Sign in with ChatGPT 计划用量路线，可用用户 OAuth token 调用公开 `/v1/responses`，或让 app-server 使用该 provider；需要该集成的注册及账号授权。此路线要求 HTTP stream=true、store=false、随请求发送历史，不支持 image_generation 和音视频输入等；不能把 ChatGPT 网页可用的功能原样当成此 API 路线的能力。[官方模型调用](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)、[app-server OAuth 配置](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server)、[限制](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)

## 三种封装的取舍

| 方案 | 实际提供什么 | 对 Studio TV 的适合程度 | 本轮结论 |
|---|---|---|---|
| Router 直接驱动 Codex app-server | 原生 thread/turn、模型选择、图片输入、工具、事件、用量；图像工具取决于 provider | 普通聊天可使用限制工具的 profile；剧本用 STUDIO 指令与输出 schema；长任务/HF 可另开 Agent profile | 优先候选：链路短，Router 能直接管理隔离、恢复、取消和产物 |
| Router → cc-connect Bridge → Codex | 多平台消息桥接、会话管理、权限请求、模型切换和附件转发；其 Codex adapter 已驱动 app-server | 若还需要飞书机器人等入口，有复用价值。STUDIO 已有身份、会话和事件，额外桥接会重复一部分状态 | 学习其进程/事件实现；暂不作为 STUDIO 必需中间层。Bridge 文档仍标 Draft，须固定版本验证 |
| Router → sub2api → 上游 | HTTP 订阅/API key 网关、账号调度和兼容接口；不是工具执行 runtime | 适合无工具的文本/VLM、图像 HTTP 能力。若需要 Codex 工具和持久 thread，仍需 app-server | 可选独立上游服务，Router 通过受控 HTTP adapter 接它；不把其用户/充值体系搬进 STUDIO |

cc-connect 核对版本 `dfad19415a38b00b2c5c288610784d1a7eef337f`：Codex adapter 实际调用 initialize、thread/start/resume、turn/start，并用 localImage 转发图片；Bridge session_key 由外部 adapter 构造，不能让 STUDIO 浏览器任意指定。[项目](https://github.com/chenhg5/cc-connect)、[Codex adapter](https://github.com/chenhg5/cc-connect/blob/dfad19415a38b00b2c5c288610784d1a7eef337f/agent/codex/appserver_session.go)、[Bridge 协议](https://github.com/chenhg5/cc-connect/blob/dfad19415a38b00b2c5c288610784d1a7eef337f/docs/bridge-protocol.md)

sub2api 核对主项目 `Wei-Shaw/sub2api` 的 `b8dece9000c68815a5b867ca5a1e6f236e173905`：有 OpenAI 图像 generation/edit 入口，OAuth 图像实现转换成带 image_generation 工具的 Responses 请求；Codex 上游地址包含 `chatgpt.com/backend-api/codex/responses`。这与官方公开 API OAuth 路线不同，源码证明有桥接实现，尚不能证明目标账号能够运行、额度如何计算或所有图像参数都有效。[项目](https://github.com/Wei-Shaw/sub2api)、[图像实现](https://github.com/Wei-Shaw/sub2api/blob/b8dece9000c68815a5b867ca5a1e6f236e173905/backend/internal/service/openai_images_responses.go)、[网关实现](https://github.com/Wei-Shaw/sub2api/blob/b8dece9000c68815a5b867ca5a1e6f236e173905/backend/internal/service/openai_gateway_service.go)

sub2api 以 API key 隔离部分 session，而 STUDIO 全体用户可能共用一个 Router→网关服务 key。因此 Router 仍须自行按 clientApp+subjectRef+conversationRef 生成独立、不接受浏览器指定的会话关联；账号池的黏性路由不能替代用户隔离。网关故障或账号限流不能自动改走收费 API。项目自身也提示上游协议和服务中断风险，不把该路线标成官方支持的公司订阅共享 API。[会话隔离测试](https://github.com/Wei-Shaw/sub2api/blob/b8dece9000c68815a5b867ca5a1e6f236e173905/backend/internal/service/openai_gateway_service_session_isolation_test.go)、[项目说明](https://github.com/Wei-Shaw/sub2api)

## H3 Base 能覆盖什么

应把发布的 checkpoint 和完整 H3 产品分开。官方开源 Base checkpoint 的输出是视频和音频；宣传中的多模态理解表示模型会利用参考上下文，不等于可返回识别文字、bbox 或 JSON 的通用 VLM API。

| STUDIO 能力 | H3 首批覆盖 | 待补能力 |
|---|---|---|
| 文生视频、首帧/尾帧/首尾帧视频 | Base FL2VA；T2VA 也走此分区 | 指令整理、素材校验、队列/事件/取消、产物归档 |
| 图片/视频/音频全能参考，动作参考/视频编辑类需求 | Base Ref2VA 候选 | 将输入顺序与主体/风格/动作关系编译为 H3 prompt；按目标任务验收，不能保证原站每种编辑按钮都等效 |
| 图片理解、剧本、区域识别、导演实体解析 | Base 未提供对应文字/JSON 输出端点 | Codex/VLM 或单独看图模型 |
| 文生图、图生图、人物/分镜预设 | 本次 Base 两种 checkpoint 未提供独立图片输出 | Codex 图像路径/订阅图像网关若验证通过可覆盖一般生成编辑；否则补专门图像模型 |
| 蒙版修复、语义抠图、拆层、精确相机/灯光、超分、深度、3D | 无已验证的等效能力 | 专门模型或工具；提示词可以表达愿望，不能提供精确 mask/alpha/layer/depth/mesh 保证 |
| 配音、音乐、独立音频和音轨分离 | Base 联合音视频输出不能直接等同全部音频 API | 分别验收或补 TTS/音乐/分离模型 |

官方 H3-Context-IR 多阶段管线没有开源，可使用其托管服务，或自行构建上下文处理。我们的替代方案是 STUDIO 编译业务模板，Router H3 adapter 将统一 promptSpec/条件素材编译成 H3 输入；必要时调用文本/VLM 做关系解析，且这一步的模型、版本和用量也必须记入执行记录。不能声称这与官方隐藏 IR 同效。[官方模型卡](https://huggingface.co/MiniMaxAI/MiniMax-H3)、[官方中文部署说明](https://github.com/MiniMax-AI/MiniMax-H3/blob/d21241f0a4b3acbb34c97dae47fa417b7065e438/README.zh-CN.md)

vLLM-Omni 当前提供 H3 的 T2VA、FL2VA、Ref2VA 和 `/v1/videos` 服务 recipe，有同步与异步路径，可作为首选 HTTP 服务候选；SGLang 保留为替代。租 GPU 前再用固定版本和目标分辨率、时长、并发验收，不能仅凭能加载权重判断能满足业务时延。[vLLM-Omni recipe](https://github.com/vllm-project/vllm-omni/blob/9146284c16abbe7309f3f79dfdacfb48cdf2499a/recipes/MiniMaxAI/MiniMax-H3.md)

## 建议首批方案及下一次验收

1. 先验 Codex 订阅文本与看图：多轮剧本、服务端指令、JSON 输出、两个用户隔离、进程重启恢复、取消、用量/限流。
2. 图像单独验 Codex 原生工具或 sub2api 图像上游：文生图、多图编辑、尺寸/比例、透明背景、参考一致性。只发布通过的 profile。
3. H3 用 FL2VA 与 Ref2VA 两个视频 profile。先 Base 原生分辨率，再决定 2K 重生成；不预购算力或下载大权重。
4. 按需求逐个补专用模型，先补图片/蒙版/抠图，再考虑超分、相机/光照等。避免一次部署整套没有使用证据的模型。

已确认：公司管理订阅账号提供内部能力，当前没有 sub2api 实例。先准备 Codex adapter 和离线协议测试，实际公司凭据在后续部署配置；不导入当前电脑的个人登录目录。STUDIO 的 IPAC 登录与历史归属保持独立，模型认证在 Router 运维侧处理。成本评估包含订阅额度和限流、GPU 空闲时间、失败重试、存储及运维，不能将订阅描述为无限 API。充值、会员与付款入口继续不出现在 STUDIO。

## 本轮落地状态

提示词协议改造已在deployment-host部署，现有20项Mock profile保持原版，真实推理仍关闭。接口核对及验证数字见[提示词链路核对](prompt-pipeline-audit.md)。

Router `ba9697f` / `v0.3.1-offline-codex` 新增Codex invocation adapter、注入式RPC transport及私有状态端口，39项离线race测试及子用例、vet通过，0失败/跳过。已覆盖首次角色历史注入、恢复仅追加新输入、actor/调用隔离、UNKNOWN不重复生成、图片授权和字节预算、取消、去重及schema结果校验端口。包未装配、未部署，也未发布实际可用的Codex profile。

下一运行切片须接入生产PrivateStore与会话checkpoint、公司认证和runtime启动器、OS工具隔离、完整JSON Schema验证器，以及事务事件outbox。公司账号真实验收通过后再发布文本/看图profile；原生图片工具产物另行适配，不计作本轮完成能力。逐轮完整用量、上下文余额和金额仍为未知，不能用累计token推算。Router工程说明为 `docs/codex-app-server-adapter.md`。
