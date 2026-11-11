# RunningHub Agent 产品核对与 STUDIO 实现范围

2026-10-06。已登录查看[原画布](https://rhtv.runninghub.ai/project/canvas/2106768132243689474)的 Agent、工作方式、生成偏好、历史、SkillHub 和一键复刻入口，并读取当前页面实际加载的 [CanvasEditorShell-Y7-TSLFr.js](https://rhtv.runninghub.ai/project/assets/CanvasEditorShell-Y7-TSLFr.js)。没有提交原站模型生成。本页把可见产品行为、源码声明和真实执行验收区分开。

## 产品含义

Agent 是画布中的创作编排助手。用户描述目标，助手收集素材与条件、规划工作流、调用画布/媒体工具，并用会话、活动状态、交互卡片和产物展示过程。

| 原入口 | 实际语义 |
|---|---|
| Agent / 图像 / 视频 / 动作模仿 | 四种工作方式；后面三项为相应媒体任务，不是聊天 LLM 型号 |
| 生成偏好 · 自动 | 图片/视频执行模型、比例、清晰度等偏好；不提供聊天 LLM 选择 |
| 附件 | 图片、视频、音频输入；具体理解/生成能力必须按模态验证 |
| SkillHub | 选择创作技能/指令包，原会话请求附带所选版本与来源 |
| 先询问 / 自动 | 创作步骤的产品执行方式；与登录/数据访问权限批准分开 |
| 一键复刻 | 独立 `one-click-remake` Agent。点击后首先出现视频素材收集卡：画布选择、本地上传、确认素材/交给 AI。未继续提交生成 |
| 历史 | 会话列表、标题/Session ID 搜索、消息恢复；原站此作品当前列表为空，不据此推断标题生成算法 |

主 Agent 默认标识为 `canvas-main`，浏览器声明 `source=canvas-new`、`canvas_id`、`chat_mode`、`rich_stream`、语言、`host_capabilities` 和 `auto_mode`。这些原站请求字段是产品上下文，不能作为 STUDIO 权限依据。

## 当前源码声明的画布工具

| Capability | 工作职责 | 首批 STUDIO 映射 |
|---|---|---|
| `canvas.read.v1` | 读画布 | 当前用户作品快照、节点和连线 |
| `canvas.workflow.create.v1` | 创建工作流 | 一次命令创建节点和连线，原子提交 |
| `canvas.node.update.v1` | 更新节点 | 按节点输入 schema 修改，保留专属功能模板 |
| `canvas.node.delete.v1` | 删除节点 | 删除节点及相关连线，强版本校验 |
| `canvas.group.create.v1` | 创建分组 | 分组及成员领域命令 |
| `canvas.group.modify.v1` | 修改分组 | 成员/分组变更领域命令 |
| `canvas.node.run.v1` | 执行节点 | 服务器读取当前节点，冻结功能、模型和提示词 |
| `canvas.group.run.v1` | 执行节点组 | 依赖校验、异步任务及真实结果 |
| `canvas.layout.relayout.v1` | 整理布局 | 布局算法生成位置命令 |
| `canvas.video.compose.v1` | 视频合成 | STUDIO 媒体处理任务 |
| `canvas.video.frame.extract-last.v1` | 提取视频尾帧 | STUDIO 媒体处理任务 |
| `canvas.image.stitch.vertical.v1` | 图片纵向拼接 | STUDIO 媒体处理任务 |
| `canvas.audio.master.create.v1` | 创建总音轨/TTS 批量 | 音频任务；真实 TTS 未配置时明确不可用 |
| `canvas.audio.master.split.v1` | 拆分总音轨 | STUDIO 音频处理任务 |
| `canvas.video-analysis.update.v1` | 更新视频分析 | 只对一键复刻声明，依赖真实视频理解 |

共 15 类；普通 `canvas-main` 排除最后一项，声明 14 类。工具名还包括 `create_workflow`、`run_canvas_nodes`、`update_canvas_node` 等。这是前端支持声明，不代表已经逐一生成验收，也不代表支持每个节点按钮或任何服务器操作。

## 会话与画布怎样衔接

原站有 `client_tool_call`、执行摘要/键、pending/recovery、工具结果/resume，以及 `agent_activity`、`host_event` 和工作流结果。交互意图包含 inform、choose、collect、confirm、artifact、error。工具调用有 session/call/capability 归属、参数摘要和状态检查；不是把普通聊天文字直接当作已提交画布修改。

STUDIO 沿用同样的产品分工：Agent 编排已有产品用例；图片/视频/动作能力各自执行；用户预设、Skill、节点功能提示词和媒体偏好保留。当前用户的 STUDIO Token 由可信执行器携带，模型不接触凭证。原生 Codex shell/文件/网络工具不作为画布操作入口。

此前“AI 操作画布、推进工作流”的方向与原站一致；“操作任意画布功能”应作为逐项扩展目标。初期按上表登记可用工具，未实现和未配置能力明确返回不可用。保留原工作方式和菜单，不把模型型号插入工作方式列表；不新增工作空间、权限或费用界面。

## 本轮代码切片与剩余工作

- **已实现服务器上下文**：`GET /api/v2/projects/{projectId}/agent-context`，真实登录+实时 `tv.access`+本人作品校验；返回最多100节点、200连线和1200字符/文本字段，明确 total/truncated。元节点、任意原生扩展、任务状态、凭证/路径/签名URL不透传。图片仅有素材ID，不能冒充已理解像素。
- **已接入 CANVAS 会话**：发起模型运行前保存当前 Web 草稿；保存冲突/切换/取消时不提交新轮次。后端从已授权作品读取上下文，以 USER 级创作数据冻结到该次请求；既有 SYSTEM/DEVELOPER 提示词、版本和hash不变。
- **首批服务器命令**：普通文本/图片/视频节点创建、输入更新、移动/删除，连线创建/删除；强ETag、持久幂等回执、原子提交。特殊节点、模型选择、素材绑定和 Agent run 归属尚未实现时拒绝，不静默套普通节点行为。
- **仍待实现**：direct app-server 动态工具循环、Agent run/会话授权续期、全项目事件流与 Web 合并、服务器生成结果回填，以及上表剩余工具的专属适配。目前 `toolExecutionAvailable=false`，普通 LLM 回复不能被展示为已操作画布。命令底座存在不等于模型已经能调用它。

接口分别见 [上下文合同](../contracts/agent-context-extension.json)、[首批命令合同](../contracts/canvas-commands-implemented-extension.json)；完整设计见 [Agent API 与实时画布](agent-api-and-live-canvas-design.md)。完整草案继续是 DESIGN/RESERVED，不能据其11条路径推断线上可用。
