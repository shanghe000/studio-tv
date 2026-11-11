# Models Router 多模态边界补充

2026-10-05。本轮为协议及 Go port 改造；未部署、未连接真实模型。Router 作为公司通用 infra，接入 vLLM-Omni、SGLang、自部署端点、模型厂商 API 与 Agent runtime；Codex 只是一种后端。

## 实际变更

- Router application 将私有 backend receipt 与公共 invocation 身份拆开，统一返回 domain Observation；同步、轮询、流和经过验证的回调都进入同一规范边界。流/回调 ports 尚未装配，没有回调端点。
- 能力新增可选 `sessionMode=NONE|OPTIONAL|REQUIRED`，与既有 supportsSession 一致。图片/视频请求可不带 session 或显式 null。supportsStream 表示原生增量输出，不等于任务状态 SSE。
- 产物增加可选 IMAGE/VIDEO/AUDIO/FILE kind；事件增加 progress.updated，严格绑定 type/data。进度、上下文、费用和未知计量仍保持 null，影像计量支持非 token 单位。
- 合同提供 LLM、文生图、图生视频的能力、请求和结果示例，按能力专用参数 schema 校验，拒绝无约束参数透传。全部示例标 RESERVED，不注册成运行时模型。
- STUDIO 新增独立的 RESERVED InvocationGateway 及规范输入/结果类型；现有 HTTP client 只新增 sessionMode 解析与一致性检查，没有开启提交推理。

OpenAPI info.version 为1.1.0，传输 protocol/header 仍为1。11个操作中仍为5 IMPLEMENTED、6 RESERVED；真实能力目录为空。STUDIO 冻结核心合同、页面、动画资源、登录与作品数据路径保持现有行为。

## 验证结果

- STUDIO 协同合同检查：32个测试通过；核心 OpenAPI 与 JSON/YAML 一致性、冻结核心校验通过。
- Router/STUDIO 四份 models-router 合同一致；所有示例通过对应 schema，参数另按能力版本验证。
- 两仓库本机 Go race 全套与 vet 通过；新测试覆盖未配置不接受任务、可选会话兼容、作用域/回调验证、事件配对和未知计量。
- 原生前端资源1198项摘要校验通过；未修改数据库、HTTP执行路径或生产运行配置。

本轮未配置 TEST_DATABASE_URL，本机数据库集成测试会跳过；未重跑数据库与 Docker 联合验证。上轮独立 PG17/真实 HTTP 的结果见[第1轮记录](iteration-01-result.md)，不计作本轮新增功能验收。真实推理、执行账本、持久事件、媒体交换和框架适配器仍需后续切片。

STUDIO 产品职责见[总体边界](models-router-design.md)，机器协议见[models-router](../contracts/models-router.yaml)。通用框架运行设计保存在独立 Models Router 仓库的 docs/models-infra.md；Codex 专项见[适配器说明](codex-router-infra.md)。
