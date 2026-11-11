# 纯文本功能与 LLM 替换核对

后续状态（2026-10-07）：首批纯文字画布 Agent 工具闭环已上线，不能继续采用文末“Agent 工具未接”的历史结论。文本、歌词、剧本、视觉和专用结构化输出仍按各自验收边界判定，最新汇总见 [统一台账](canvas-node-status.md)。

核对日期：2026-10-06。原站目标：[无限画布](https://rhtv.runninghub.ai/project/canvas/2106768132243689474)。只读实际 `POST https://www.runninghub.ai/canvas/model/list`，HTTP 200、`code:0`；未提交原站生成。功能与请求依据见 [模型功能表](model-function-matrix.md)、[原站接口](runninghub-canvas-api.md)。目录名称是原站返回值，不据此认定后台真实权重或供应商。

## 结论

纯文本输入、文本或 JSON 输出的推理可以复用同一种 LLM 能力。剧本、场景分类、歌词、提示词优化、技能 Markdown 的区别主要在产品提示词、上下文和输出约定；不需要为每个按钮部署一个模型。当前真实文本能力为 Codex 5.6、6、6.1。

能够替换模型能力，不等于当前每个入口已经无痕兼容。普通文本已有真实验证；结构化脚本、歌词回填、导演布局、技能文件和 Agent 工具流程还要分别满足原生返回约定。图片／视频输入另外筛选理解能力，不能因为输出文字就走纯文本模型。

## 原站公开 LLM

通用目录 `MULTIMODAL_TEXT` 共 **11 条**，均标记 `modelType:LLM, available:true`。本次 `TEXT_TEXT` 没有独立返回目录。

| 原站显示名 | 原站 modelCode | 分镜目录也有此名称 |
|---|---|---|
| 全能语言模型3.6 flash | `llm-gemini36flash-multimadal-text` | 否 |
| 全能语言模型3.5 flash | `llm-gemini35flash-multimadal-text` | 是 |
| 全能语言模型3.1 pro | `llm-gemini3.1pro-multimadal` | 否 |
| 全能语言模型3.1 flash | `llm-gemini3.1flash-multimadal` | 否 |
| 全能语言模型-5.5 | `llm-openai-gpt-5.5` | 是 |
| 全能语言模型-5.5 Pro | `llm-openai-gpt-5.5-pro` | 是 |
| Bytedance-Seed-2.0 Pro | `llm-bytedance-seed-2.0-pro` | 是 |
| Qwen-3.8-Max | `llm-qwen/qwen3.8-max` | 否 |
| Qwen-3.7 Plux | `alibaba-qwen3-7-plux` | 否 |
| Qwen-3.7 Max | `llm-alibaba-qwen3-7-max` | 否 |
| 全能语言模型-4.8 | `llm-opus-4.8` | 否 |

`MULTIMODAL_STORYBOARD` 的 **4 条**是上述名称的专用路由，不另外算四种 LLM：`llm-gemini35flash-multimadal-storyboard`、`llm-storyboard-openai-gpt-5.5`、`llm-stortboard-openai-gpt-5.5-pro`、`llm-storyboard-bytedance-seed-2.0-pro`。`stortboard` 是原响应拼写。

`TEXT_LYRICS` 另有 **2 条文本生成服务**：Suno-Lyrics (`text-lyrics-rhart-audio-suno-lyrics`)、Mureka-Lyrics (`text-lyrics-mureka-ai-generate-lyrics`)；原站标记 `OPENAPI`，不能断言内部就是某个通用 LLM，但其产品侧文字输出可以用 LLM 实现。

Agent、HyperFrames、独立提示词优化、对话转 Skill 没有公开所用 LLM 型号，不能补造为上述某个型号。导演文字识别复用固定 `llm-haimaflash-image-regecognition`（目录显示“全能语言模型3.5 flash”），文字分支删除图片参数，并非文字生成三维网格。

## 纯文本功能坐标与替换状态

下表只列无图片、视频、音频输入的分支。场景和风格是同一次功能的参数或模板，不是新模型。状态区分代码适配与真实验证，不将已有通用 LLM 测试算作每个功能都已验收。

| 功能坐标 | 原站请求／结果约定 | 现有 LLM 能力与适配情况 |
|---|---|---|
| 无限画布 → 文本节点 → 文本模式 → 生成／重试（F001） | `task/run`；`text-text/multimodal-text`，`params.prompt`、上游文本 → 文本节点内容 | 可替换；5.6、6、6.1 选型生效已有真实验证，沿用原生模型菜单 |
| 无限画布 → 文本节点 → 歌词模式 → 生成（F004） | `task/run`；`text-lyrics`，`prompt` → 歌词文字 | LLM 可写歌词，目录与执行已映射；专门歌词任务结果尚未真实验收 |
| 无限画布 → 脚本策划节点 → 文本生成分镜脚本 → 生成（F010） | `MULTIMODAL_STORYBOARD` → 镜头、实体、对白／音效、时长及图／视频提示词 | 可替换；已有真实两镜头结果与表格恢复验证；当前 Go schema 比 Web 表格要求宽，仍需统一字段校验 |
| 无限画布 → 脚本策划节点 → 创作场景 → 自动（F013） | 同选定 LLM 先输出 `{scene,confidence,reason}`，再按场景生成脚本 | 分类 JSON 与两阶段适配已实现；独立自动分类流程未真实验收 |
| 无限画布 → 脚本策划节点 → 创作场景 → 漫剧制作／竖屏短剧／MV音乐视频／知识口播／电商广告／专业影片（F014–F019） | `storyboard-prompt-comic/short-drama/mv/knowledge/ecommerce/film`；同一模型、不同功能模板 | 复用 LLM；六个模板已注册；不能用“电影场景已验证”推定六种均已验收 |
| 无限画布 → 脚本策划节点 → 画风／全局要求 → 生成（F020） | 风格、`globalPrompt` 合入当前脚本输入，用户模型保持不变 | 已保留；是输入编排，不需要另一个 LLM |
| 无限画布 → 图片节点 → 下方参数面板 → 优化（F099） | `prompt/enhance`：`prompt,scene,nodeCategory,refImageCount,modelCode,nodeId,canvasId` → `enhancedPrompt` 回填 | 需要 LLM；此接口只传参考数量。目标图片 `modelCode` 是优化上下文，不是优化 LLM 选型；本轮修正这一误绑定 |
| 无限画布 → 视频节点 → 提示词输入栏 → 优化提示词（F168） | 同 `prompt/enhance`，另保留视频场景、`videoParams` → 改写文字 | 同上；视频模型仍用于后续视频生成，不能拿它执行文字优化 |
| 无限画布 → 音频节点 → 音乐 → 生成歌词（F199） | 隐藏 `rh-text`，`transientKind:lyrics-generation`；文字回填歌词，按选项回填标题／标签，支持取消 | LLM 可承担；临时任务与回填格式要单独验证，不等于音乐生成已接通 |
| 技能 → 创建／编辑技能 → 优化 Markdown（F033） | `skill/file/content/optimize {message}` → `data.output` 为 JSON **字符串**，内含 `optimized_content` | `skill.optimize` schema 已实现；本轮修复 Web 返回裸 Markdown 导致原生 JSON.parse 失败的投影 |
| 无限画布 → 导演节点 → 3D导演 → AI识别 → 文字识别（F255） | `director-text-scene`；可见布局协议＋用户文字 → 实体／关系／坐标 JSON；本地资源摆场 | LLM 可生成布局；当前误沿用 IMAGE 能力筛选、布局 feature/schema 未注册，不能直接改名即用 |
| 无限画布 → Agent → 将当前对话转为 Skill（F032） | `skill/chat/generate {sessionId,instruction,maxTurns:20}` → 文件数组 | 需要 LLM 总结及文件格式；当前专用接口适配未接，不可算已替换 |
| 首页 → Agent → 开始创作（F035）；无限画布 → Agent → 发送／续聊／重试（F025） | 首页先新建画布，再聊天；历史、session、流事件 → 文本／工具意图 | 纯文字聊天与用户历史已真实验证；原站没有公开聊天 LLM 型号菜单，采用后台默认；完整画布操作不属于纯文本替换 |
| 无限画布 → Agent → 专业创作卡片／SkillHub → 文字写作类技能（F027） | 技能提示词／文件、用户请求 → 文本；如技能要求生成媒体或改画布则进入工具流程 | LLM 部分可复用；技能内容加载、执行与工具完成状态必须保持，不能只返回聊天文字冒充完成 |
| 无限画布 → HyperFrames → 聊天／生成方案／继续修改（F039，文字部分） | `openclaw/chat` → 文本、方案／表单／工程卡片及文件事件 | 普通聊天／代码文本已真实验证；完整工程文件、预览和工具流仍缺适配，不能称全部无痕替换 |
| 无限画布 → AI应用节点／工作流 → 已登记的文字输出应用／文本节点（F041/F042，条件分支） | 依权威应用版本的 `inputNodes` 和输出定义执行，可能包含多阶段步骤 | 其中纯文字推理可复用 LLM；须按已登记应用逐项适配，不能据应用名称把所有外部工作流算成纯文本功能 |

图片解析、图片反推提示词、从图片提取风格、图像参考脚本需要图片理解；视频分析、视频参考脚本、一键复刻需要视频理解。画板生成、人物调节、全景图、分镜故事板、文生图／视频／音频／三维输出需要对应媒体能力。手工文本编辑、文档解析、自动排版、目录查询不独立调用 LLM。

## Web 与后端的兼容边界

1. **沿用原生界面。** 原有文本／剧本／歌词模型选择控件只替换目录数据为实际可用型号，不在四种工作方式中插入 LLM，不新增模型选择行。原站未提供 LLM 控件的 Agent／Frames／优化等入口使用后台功能默认；本轮移除额外 Agent／首页聊天型号控件。三个真实型号不会伪装成原站十一种模型。
2. **模型与功能分开。** Web 选中的真实 `capabilityRef/version` 必须进入任务并生效；`featureCode/sceneCode`、风格、用户文字、历史、输出 schema 不随型号切换丢失。图片／视频优化请求中的目标媒体型号只作功能上下文。
3. **产品合同由 STUDIO 负责。** STUDIO 冻结功能提示词和输入、校验文字／JSON，再还原原生 DTO、任务状态、历史和回填；Router 提供中立 `LLM` 能力，实际 Codex／DeepSeek／千问等由目录与适配器管理。不能把不同供应商旧 modelCode 全局静默映射到一个模型。
4. **保留已知提示词。** 现有 STUDIO SYSTEM/DEVELOPER、`studio-authored-1`、模板哈希与可见原生 USER 提示词不改。本次没有获得原站后台隐藏系统提示词，不宣称文本质量或隐藏编排完全一致。
5. **参数按版本接入。** 本轮新增 Codex 能力版本 2／参数 schema 2，将原生 `reasoning_effort:low/high` 映射到 Router `reasoningEffort`，每轮显式传入上游；旧版本 1 保留空参数，通过精确版本查询继续使用，不能静默升级。原站该字段 `display:false` 会隐藏控件，本轮按用户要求复用原参数面板开放 Low／High。分镜 `max_tokens`（0–70000、默认70000）仍未映射，不能显示但忽略或伪称为有效上游限制。
6. **Agent 工具另行接入。** 普通 LLM 已接通不代表能够创建／更新／运行画布节点，或写入 Frames 工程。当前 Router 原生工具关闭；需受控工具协议及 STUDIO 授权执行、结果回传、并发版本检查，保持业务与模型服务分离。

因此，模型能力层可以复用现有三个文本型号；完整“无痕替换”的验收单位是每个产品入口的输入、预设、选型、原生参数、结果结构与恢复行为，而不是模型名称是否已换。

图片理解与生成的功能坐标、专门能力和当前接入边界见 [图片能力核对](image-capability-integration.md)。
