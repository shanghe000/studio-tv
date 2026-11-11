# Codex 全型号、模型详情与推理参数接入设计

状态：**DESIGN，未实现本设计的新目录、参数和功能默认策略**。2026-10-06，STUDIO 源码核对基线 `29052a2`。本轮只设计，不修改 Web/runtime、冻结原生资源或已发布合同，不部署、不调用模型。既有实现和真实验收仅作为下面标明的基础；完整型号的可用性及推理档位须以 deployment-host 实际 Router/Codex 目录为准。

## 1. 页面和工作方式保持不变

原模式菜单仍只有 **Agent、图像、视频、动作模仿**。这是工作方式，不是型号；`GPT6.1 Sol`、`GPT6 Astra` 等完整型号名只能进入该功能原有的兼容模型菜单，不能成为第五种模式，也不能与四模式同级。

- 原文本、歌词、剧本、图片、视频的模型按钮、级联弹层，以及各自原本存在的参数面板继续由原生组件渲染。接入层替换目录数据、显示名称和受支持的参数，不重建菜单、移动按钮、增添底部行或改变生成快捷键。**原剧本/歌词没有普通文本的 `Gd` 参数面板**，不能只靠 `display:true` 声称这些入口已有可调推理控件。
- Agent/Home 聊天、Studio Frames、画板、解析和部分优化面板原本没有独立 LLM 型号入口。这些功能使用 STUDIO 的功能默认策略，并可接收其原调用方已经明确选择的兼容型号；不为实现选型另加控件。Agent 的“生成偏好”只配置后续图片/视频生成，不替代聊天 LLM，也不把媒体偏好当成已执行工具。
- 原预设、风格、场景、草图、参考、数量和业务参数保留语义。是否支持由真实能力合同决定；不通过改名把图片理解变成图片生成，或把普通视频生成变成动作迁移。
- 模型详情先填入原菜单已有的名称/说明位置、原参数面板及已有任务详情。原位置不存在时，只保存可审计 metadata 和默认选择，不新建详情弹层或选择行。

现有证据：[native-model-entrypoints.md](native-model-entrypoints.md)、[工作方式核对](modes-and-agent-integration.md)；细分坐标见 [功能矩阵 JSON](model-function-matrix.json)，实际为 214 个合并坐标、294 个细分操作。该旧入口文档中的早期未配置状态不覆盖后续 [图片真实验收](image-capability-integration.md#部署与真实验收)，也不表示所有入口均已接通。

## 2. 权威目录与完整型号详情

执行键继续使用 `capabilityRef + capabilityVersion`，不能使用显示名或浏览器提交的裸 `modelRef` 选上游。Web 从 `GET /api/v2/model-capabilities` 获得公开能力，STUDIO 从签名 Router 目录重新解析；型号身份来自该精确能力的权威 metadata。既有 `model.modelRef` 的公共 alias 保持不变；新增详情中的实际原生 model ID 必须与旧 alias 明确区分，由 Router 给出映射。两种文本/视觉能力可以共享同一物理型号，但能力、输入、输出和参数版本仍分别绑定。

| 字段 | 来源和用途 | 当前基础 / 本设计 |
|---|---|---|
| `capabilityRef`、`version`、`kind` | Router 发布；STUDIO 按真实功能和输入筛选、执行 | 已有。原 `modelCode` 投影为公开 capabilityRef，不能把旧供应商 alias 当真实型号 |
| `model.providerRef/modelRef/title/version` | Router 权威型号 metadata；title 显示完整变体，如 `GPT6.1 Sol`、`GPT6 Astra` | 已有字段；**DESIGN** 全型号映射、完整名称和能力发布。ref 的命名不由 Web 猜测 |
| `title`、`reason`、`available`、`testMode` | 原模型行名称/说明及可用性 | 已有。同一物理型号的文本/视觉行可按功能补充“图片理解”，先分桶再渲染，不能同名误合并 |
| `inputKinds/outputKinds`、会话/流/取消支持 | 功能兼容边界 | 已有粗粒度字段；**DESIGN** 补精确功能、引用角色、数量/大小限制的权威声明，不能从型号名称推断 |
| `parameterSchemaVersion/parameterSchema` | 精确能力版本允许的参数及默认值 | 已有。当前文本/视觉版本 2 只公开 `reasoningEffort: low/high`；**DESIGN** 按实测型号发布完整档位 |
| 图片引擎详情 | 真实图片能力的 engine/provider/model 信息及来源 | 当前仅真实 `Codex Image · 生成`、`Codex Image · 参考图编辑`，模型 title 为 `Codex Image`；**DESIGN** 原详情可显示官方文档所述引擎名称，同时明确本次运行没有报告内部引擎身份，不能开放任意聊天型号作为生图引擎 |

新型号只在 Router 有实际配置、准确输入/输出合同且 `available=true/testMode=false` 时成为真实候选。原目录已存在的测试能力仍明确 TEST MODE；用户选择未知、停用或不兼容能力时拒绝，不静默换成另一个型号。

复用现有公开字段优先。新增详情通过**独立版本化扩展（DESIGN，下文与Router提议同步）**关联 capabilityRef/version，不就地改写已冻结 `@1/@2` ModelDescriptor/title/alias。新公开profile与 `ModelDetails.displayName` 承载完整名称，旧记录关联精确历史详情。详情缺失可以少显示信息，不能编造档位、引擎、上下文窗口或上限。

当前 Web `compareModels` 和 Go `PreferCapability` 主要按同供应商的数值型号版本排序，不能表达同代 Sol/Astra/Luna 的默认优先级。**DESIGN** 默认使用 STUDIO 后端版本化功能策略，不能“字符串最大”“菜单第一项”即默认，也不把显示名更换当作能力升级。

### deployment-host 实际目录与尚未生效的范围

主任务只读快照 `studio-model-router/.local/model-details-design/runtime-discovery.json`：Codex **0.160.0**，`CODEX_APP_SERVER_MODEL_LIST`，2026-10-06 08:30:52 UTC；11个型号、8个非hidden，本次生成请求0次。下面是原生目录支持声明，**不是 STUDIO 当前8型号都已发布/执行的证明**；UI保留完整变体，原生原始 displayName仍可在详情记录。

| 计划原菜单完整名称 | 实际原生 model ID | 原生 reasoning档位 | 原生默认 |
|---|---|---|---|
| GPT6.1 Sol | `gpt-6.1-sol` | low / medium / high / xhigh / max / ultra | low |
| GPT6 Astra | `gpt-6-astra` | low / medium / high / xhigh / max / ultra | low |
| GPT6 Sol | `gpt-6-sol` | low / medium / high / xhigh / max / ultra | medium |
| GPT6 Luna | `gpt-6-luna` | low / medium / high / xhigh / max | medium |
| GPT5.6 Sol | `gpt-5.6-sol` | low / medium / high / xhigh / max / ultra | low |
| GPT5.6 Terra | `gpt-5.6-terra` | low / medium / high / xhigh / max / ultra | medium |
| GPT5.6 Luna | `gpt-5.6-luna` | low / medium / high / xhigh / max | medium |
| GPT5.5 | `gpt-5.5` | low / medium / high / xhigh | medium |

这8个原生型号都声明 TEXT+IMAGE，但当前 STUDIO 只发布5.6文本、6/6.1文本及图片理解等既有profiles。**DESIGN** 扩展视觉profile后才能让其它型号进入图片理解菜单；现5.6 text-only是产品profile限制，不能写成原生5.6不会读图。hidden型号不自动进入用户菜单。

Ultra是独立原生 `ultra` 档位，并涉及自动任务委派；不能映成 `xhigh/max` 或原页面“Agent”模式。当前普通profiles关闭multi_agent且未接该档位：详情可列出原生支持、`effectiveAvailable=false`和原因；原参数list只开放已经可执行的档位，若原控件支持disabled可用禁用项，否则不提供可点击Ultra。未来先实现专用受控profile及授权/工具边界，再分别验证Ultra生效，不能切换后仍偷偷用high。

快照的 `serviceTiers` 为 `id:priority/name:Fast`，另有speed tier `fast`；6 Sol/Luna默认priority，其余上述型号默认null。Fast是速度/服务档位，不是reasoningEffort。当前adapter未实现speed映射，本设计只保留native详情来源、明确effective未接；如未来接入必须用单独schema参数和原有可用参数位置，不把Fast塞进Low/High档位。

图片快照仅报告 `imageGeneration:true`，没有实际引擎ID。按主任务核对的 [官方图片文档](https://learn.chatgpt.com/docs/image-generation)，**DESIGN** 可在原图片模型说明显示“GPT Image 2 · Codex工具”，同时注明“官方文档标识；本次运行未报告引擎型号”。当前真实回执仍记录Codex Image公开能力；不能声称已实测内部模型必为GPT Image 2，也不能提供2/2.5切换选项。

## 3. 各功能的选择来源和适用能力

| 位置 / 功能 | 保留的原入口与选择来源 | 型号、推理和合同设计 / 现边界 |
|---|---|---|
| 首页 Agent → 开始创作；画布 Agent 对话/续聊 | 原四模式；无聊天 LLM 菜单。媒体偏好是后续执行模型 | STUDIO 功能默认，或经过验证的原调用选择；按本轮及历史实际 TEXT/IMAGE 输入选择文本/视觉。无原参数 panel 时推理同样采用功能默认，不新增行。当前真实聊天不代表画布工具循环已实现 |
| 首页/助手图像直接模式 | 原 inline 模型及参数按钮；原媒体偏好位置 | 文本→TEXT_TO_IMAGE；有真实参考→IMAGE_TO_IMAGE。只展示图片能力自己的引擎/参数，不把 GPT 文本/视觉型号塞入生图菜单 |
| 首页/助手视频直接模式 | 原模型级联菜单、子模式和参数按钮 | 按首帧/首尾/全能/编辑等真实合同过滤；不因 Codex 支持图片理解而开放视频。当前真实视频未配置 |
| 首页/助手动作模仿 | 原动作模式、角色图+动作视频；无证据支持另增自由 LLM 菜单 | 专门动作迁移功能默认/原调用选择，保持两种引用角色和原限制。未配置明确拒绝 |
| 普通文本节点 | 原 `Lc` 模型按钮、相邻 `Gd` 参数面板 | 原菜单显示完整实际型号；TEXT/JSON 输出按feature合同，推理在原面板按精确schema提供 |
| 歌词节点/生成歌词对话 | 原 `Lc` 模型按钮，原prompt/生成；未发现相邻 `Gd` | 原模型选择保持；推理用该feature默认或合法调用选择并返回resolved metadata。未来若用模型按钮锚定参数详情，须单独UI适配验证，不算原站已有 |
| 剧本/分镜策划、场景路由 | 原模型菜单、styleLibrary/scene选择，沿用节点明确选择；原config未渲染 `Gd` | TEXT或IMAGE理解，`storyboard.script/scene-router` 等模板和JSON合同不丢失。推理用feature默认/合法调用值；未来锚定原模型按钮的参数详情同样需单独UI适配验证。原 `max_tokens` 等未映射参数不能声称生效 |
| 脚本全局资产、分镜图/故事板图/视频组、批量 | 原各阶段/批量条自己的媒体模型栏和预设 | 从所选阶段的真实图片/视频能力冻结选择；文本策划的 GPT 型号不能直接继承为图片引擎。保持镜号、数量、依赖和场景引用，按阶段验收 |
| 图片“解析”/反推提示词 | 原按钮、生成出的文本节点菜单；入口本身无新选择器 | 原固定 alias 仅按该 feature+actual IMAGE 精确兼容；默认视觉型号，文本节点已有的明确兼容选择可继续传入。原提示词/正负输出要求保留；当前解析已真实验收 |
| 局部元素识别、图层识别 | 原工具/参数；无独立型号菜单的位置透明默认 | 图片理解 + point/bbox/layer JSON 合同；不能自由文本假成功，不能等同后续抠图/补背景。完整流水线仍需单独实现/验收 |
| 图片/视频风格提取 | 原上传参考图→提取按钮，无型号菜单 | `image.style-extract` + 单张 IMAGE + STUDIO 模板；接收明确调用选择或功能默认。当前已验收单图风格文字，不能静默用文本能力/丢图 |
| 提示词优化、Skill Markdown 优化 | 原优化按钮；视频已有的优化模型菜单及其关联仍在原位置 | 优化 LLM 与目标生成模型分开。目标 `modelCode` 是条件；仅优化菜单的显式选择/调用cap绑定可选优化 LLM。无原菜单使用功能默认；保留原优化 DTO，包括 Skill JSON字符串 |
| 2D 画板/完整 Director 2D→快绘 | 原“截屏→捕捉→添加到画布”、风格栏、手动/实时及生成按钮；无型号菜单 | 草图PNG→IMAGE_TO_IMAGE，`sketchboard.generate/SKETCH`；功能默认实际参考图编辑引擎，不加 GPT 菜单。手动已真实验收；实时仅沿用本地防抖/丢旧结果，后台取消未支持 |
| 3D Director 文字/图片 AI识别 | 原固定 lookup、原识别按钮；本地对象/材质菜单不是 AI 型号菜单 | 无图选 LLM、有图选图片理解，功能默认或原调用选择，要求完整导演布局JSON。当前专门模板/协议未登记，保持拒绝，不冒称已接入 |
| Studio Frames 聊天/修改 | 原发送/停止/上传，没有 LLM菜单或推理panel | 保留后端默认，当前可接明确capRef/version；**现业务DTO不传parameters，后端使用{}**，接收明确effort/返回resolved详情需独立DTO扩展，不是改目录名称即可生效。无新增型号行；文字/消息string合同不证明工程工具或附件读图完成 |
| 应用、工作流、视频分析/复刻等 | 原应用版本/各节点模型或固定阶段调用 | 仅权威应用声明和实际输入支持的能力可选。VIDEO/AUDIO/3D、工具编排及未知固定 alias 不按任意 GPT 回落；未实现保留准确错误 |

原型坐标只证明位置和数据来源。验收单位仍是每个功能的输入、模式、参数、输出结构、回填和恢复，不是这张表的行数或可见型号数。

## 4. 选择、推理和详情怎样传递

**DESIGN 选择来源：** 原生入口本次明确用户选择/该功能调用方的合法明确选择 → 当前节点或会话已冻结且兼容的选择 → STUDIO 后端feature默认。一个命令内两处明确选择矛盾则拒绝，不能猜测谁覆盖谁；用户有意换型产生新的完整绑定。生成目标型号不能作为优化型号，聊天型号不能作为生图型号，不使用全局无关偏好覆盖当前节点。

每次选型先确认 feature/output contract，再收集实际当前输入及需要保留的会话媒体。目录只保留真正兼容的能力；TEXT续聊仍须兼容此前 IMAGE 历史。原四模式不因选择 GPT 型号切换；加图也不能让不支持图的显式型号静默升级。

Web 保持原 `modelCode/config/params` 回调，把公开 `capabilityRef/capabilityVersion/parameterSchemaVersion` 补入自有冻结数据。`modelRef` 和完整名称来自该候选的 `model`，可以显示/记录，但不是另一个可覆盖执行键的请求参数。STUDIO 接受时重查相同精确 pair，解析其 modelRef/provider，校验可用性、feature、输入/输出、引用和参数；浏览器自报标题、型号metadata或schema不能赋予能力。

存在原参数面板的入口，推理继续投影为其中的 `reasoning_effort` list，提交 canonical `routerParameters.reasoningEffort`（助手DTO为 `parameters.reasoningEffort`）。**DESIGN** list 的选项逐精确能力schema及effective支持动态构造；不能给所有型号统一套Low/High，更不能将缺少档位误认为该型号支持。没有原参数面板的歌词/剧本/Agent/Home/HF等入口采用feature默认和合法调用参数，返回resolved元数据/历史，不靠目录 `display:true` 假装已有可调UI；HF还需扩展业务DTO。

新模型的合法默认与用户新选值冻结，不沿用另一个型号的旧值。相同capRef/version只改effort保持会话；换型号/能力版本另建epoch，按合同处理授权历史。**现TEXT→IMAGE_UNDERSTANDING即使同物理型号也因capRef不同而新建epoch**；本设计先保持该规则，是否复用必须由Router另行定义同模型会话兼容合同，不能仅凭modelRef相同跨profile复用。

旧版本 1 无推理参数仍用 `{}`；当前版本 2 原 Low/High继续合法。扩展到其它真实档位或参数必须发布新不可变能力/schema版本，保留 exact旧版本。参数控件不广告无真实映射的 temperature、max_tokens/上限、图片size/ratio或批量参数；原条件可以保留为用户约束，但不能显示为已保证的原生模型参数。

原生 `aEt/bTe` 会按 modelName去重，`nk` 会修复缺失选值并提交参数。沿用先按actual kind/输入投影、保留不可用已选值、绑定选择回调的seams。**DESIGN必要改造：当前旧参数保护主要特判version1，新增version3后须将任何已绑定旧版本（含2）的整个config按exact schema投影，不能拿latest enum污染历史**。只将该节点已选的合法历史能力注入其当前视图，不把全部旧profiles放回新用户菜单。相关实现见 `model-selectors.ts:44–80`、`execution.ts:43–58、380–390`、`native-parameters.ts:5–15`。

## 5. 保存、历史和服务端冻结

已有 `ModelBindings` 保留：按本人作品+节点ID+节点类型+同modelCode从服务端快照恢复版本，在原生菜单/执行/保存副本补回；原生白名单丢字段不成为升级理由。版本丢失时只从本人同作品、同节点、同公开ref的唯一历史计划及 exact metadata 恢复；不能猜 ref 的 `v1` 后缀。换型号、删除/同ID重建、换账号、迟到目录响应必须隔离。

服务端接受任务时冻结：公开能力精确版本、schema版本、合法参数、实际输入/引用、功能/场景/预设、模板版本/哈希、输出合同和幂等摘要。**DESIGN** 独立选择/详情回执增加服务端解析的 `modelRef/modelRevision/catalogRevision`，原生model ID、provider/路由来源、`requestedEffort/resolvedEffort`、原生默认/功能默认来源、availability/限制和策略版本。Router原生身份映射与PF快照必须一致；这些字段不能由浏览器自报后直接信任。

接受时的selection metadata snapshot与运行时观察值分别记录。历史详情按该快照/精确版本显示；现public Plan主要公开ref/version/parameters，尚未提供完整selection snapshot。本设计新增的resolved详情需要独立合同，并保留旧任务原始请求；名称可更新显示，但不得用latest详情重新解释历史型号/effort/输出。

目录只公开 latest，明确旧选择仍走已有 `GET /api/v2/model-capability-version?ref=...&version=...`；PF再调用 Router 的 exact查询。旧版本停用/不存在、schema不匹配和新参数非法均明确拒绝。worker提交前再核验精确metadata及冻结参数；已有 Router回执继续轮询/恢复原请求，不重新选型。改变未来功能默认不会回写已保存选择或已接受任务。

认证、`tv.access`、作品/素材归属、参数与引用校验继续在 STUDIO API执行；客户端mode/header/modelRef不能赋权。详情查询同样不得公开原生thread ID、服务器路径、secret或grant URL。

### STUDIO 与 Router 的新扩展协作（全部 DESIGN）

与 [Router型号详情设计](../../studio-model-router/docs/codex-model-details-design.md) 同步；以下Router路由均未实现，PF新增合同也未发布：

| Router提议接口 | PF业务侧的使用方式 |
|---|---|
| `GET /extensions/model-details/v1/catalog` | Gateway签名读取当前身份视图；PF按feature/真实输入筛兼容候选和版本化默认，不把discovered未启用项当执行候选 |
| `GET /extensions/model-details/v1/model?ref=...&revision=...` | 读取已绑定ModelDetails精确revision；旧任务详情不得查询latest冒充旧事实 |
| `POST /extensions/model-details/v1/resolve` | PF可做预检并解析 `codex:gpt-6.1-sol` 等稳定精确modelRef、modelRevision、catalogRevision、cap/schema及参数默认；不是执行授权令牌，submit仍重新验证 |
| `POST /extensions/model-details/v1/invocations` | STUDIO Gateway把业务cap-only请求编译成 `selection + 既有InvocationRequest` wrapper，原子冻结完整选择后提交；新accepted hash必须同时覆盖selection/request，不能仅写旁路日志后走旧Submit |
| `GET /extensions/model-details/v1/execution?invocationRef=...` | 仅PF后端按owned任务/计划读取requested/resolved/actual事实，生成用户可见安全回执；不将native invocation身份直接交浏览器 |

PF可用独立 `model-details.v1` 合同增加只读目录/精确详情和owned任务执行详情（提议公共路径 `/api/v2/model-details/catalog`、`/api/v2/model-details/model?ref=...&revision=...`、`/api/v2/model-details/execution?taskId=...&planId=...`，均DESIGN）。保留现业务生成路径和原UI，任何新参数支持只在明确扩展合同中声明；HF接收parameters需要同步业务DTO扩展。

现业务请求只带capRef/version也可由PF immutable registry权威关联唯一modelRevision；不能从Web显示名称再猜model ID。未来带完整选择的独立请求，PF需核验cap/schema/modelRef/revision一致且当前仍授权，不能拿历史catalogRevision绕过停用。新接受command/hash、幂等回执、worker、恢复和Router验证共同覆盖完整selection；旧base请求仍保持原hash路径，不迁移旧回执。Web/menu冻结的选择、PF接受快照、Router接受回执要能逐字段对应。

执行事实分层：`requested`是原用户选择/省略事实；`resolved`是可信registry及默认解析后实际发送的model/effort；`actual`只记原生明确确认，没回报effort或图片引擎则为null及来源说明。不能把“已发送high”写成原生已报告high，也不能从模型输出自称型号推导身份。

## 6. 产品提示词和模型服务边界

功能 SYSTEM/DEVELOPER 模板继续在 STUDIO Go后端 `prompt_templates.go` 编译，`studio-authored-1` 正文、版本与哈希不因名称/effort目录扩展更改。Web只提交 USER文字、已授权历史、媒体assetId、feature/scene/preset选择及用户条件；SYSTEM/DEVELOPER、template正文/哈希不能从浏览器注入。

PF将 `PromptSelection` 解析为 `PromptSpec`，包括可信 instructions、映射到 input indexes 的 USER/ASSISTANT消息、conditioning角色和严格outputContract；模板摘要随精确能力、参数和已授权媒体grant一起送Router。Router负责实际modelRef解析/运行及参数生效，不决定PF业务权限，也不承担RunningHub功能模板。换型不得丢掉草图/风格/JSON输出约束；模板未注册则拒绝，不以普通聊天冒充成功。

现有 DTO 路径示例（示例ID无真实身份；**展示当前合同，完整新型号接入仍为DESIGN**）：

**A. 原文本节点模型菜单和推理面板 → `POST /api/v2/canvas-runs`：**

```json
{
  "projectId": "prj_example",
  "targetType": "NODE",
  "targetId": "text_example",
  "graph": {"nodes": [{
    "id": "text_example", "type": "rh-text", "position": {"x": 0, "y": 0},
    "data": {
      "subType": "text-text", "modelCode": "codex-6-1-text-v1",
      "capabilityRef": "codex-6-1-text-v1", "capabilityVersion": "2",
      "parameterSchemaVersion": "2",
      "params": {"prompt": "用户文字", "reasoning_effort": "high"},
      "routerParameters": {"reasoningEffort": "high"}
    }
  }], "edges": []}
}
```

选择新真实型号时替换成其目录公开 pair/schema，不能从名字自行生成ref。服务器重新解析该 pair的modelRef；PF编译默认LLM或该节点feature模板，Router收到 `capability:{ref,version}`、`parameterSchemaVersion`、`parameters`、`promptSpec`，没有浏览器指定上游私有model路径。

**B. 原 Agent发送/续聊 → `POST /api/v2/assistant/conversations/{id}/runs`：**

```json
{
  "capabilityRef": "codex-6-1-text-v1", "capabilityVersion": "2",
  "messageId": "msg_example", "parameters": {"reasoningEffort": "low"}
}
```

这是现有API shape。原页面无型号/推理选择器，**DESIGN** 由功能策略产生默认pair/effort，或接受调用方合法明确选择；API读取本人持久message和历史，并重新校验。有实际图片历史时选择兼容的视觉pair，不能只改显示名而继续text-only。模板分别使用当前GLOBAL/CANVAS/HF产品合同，不声称已经执行画布工具。

**C. 原画板手动生成请求 → 自有上传/任务桥接：**

```json
{
  "canvasId": "prj_example", "prompt": "用户画面描述",
  "image": "data:image/png;base64,<绘图截图>",
  "styleCode": "<原选中风格code>", "generationMode": "manual"
}
```

保持原 `POST /canvas/sketchboard/realtime/generate` 请求，不添菜单。自有桥接上传PNG获得owned asset，生成IMAGE_TO_IMAGE节点，冻结实际目录pair（当前 `codex-image-edit-v1@1`）、`count:1`，以及：

```json
{
  "schemaVersion": "1", "featureCode": "sketchboard.generate",
  "conditions": {"styleCode": "<原风格code>", "generationMode": "manual"},
  "referenceBindings": [{"assetId": "ast_example", "role": "SKETCH"}]
}
```

上面对象是 `promptSelection`，不是SYSTEM模板。PF生成草图功能PromptSpec及真实MEDIA输出合同，再调用Router；返回结果沿用原status/imageUrl/history/加入画布。未来图片引擎多型号仅在权威图片目录真实支持后按该功能默认或已有调用选择绑定，不继承聊天GPT选型。

## 7. 本设计的交付和验收边界

| 阶段 | 需要实现/确认 | 验收 |
|---|---|---|
| 目录 | deployment-host每个完整型号的真实modelRef、可用状态、TEXT/IMAGE/其它输入、effort档位/default；Router不可变profiles及详情合同 | 目录与实际原生model list一致；未配置、VIDEO理解、图片内部引擎未知均不假冒支持 |
| 原菜单投影 | 全名、actual-input筛选、原config面板的动态effort；图片独立引擎信息 | 原四模式/菜单位置/键盘/回填不变；无额外Agent/Home/HF行；同名去重不丢候选，默认repair不改已选版本 |
| 功能策略和API | 版本化feature默认、合法调用选择、完整新参数生效、服务器复核/冻结 | 无菜单入口透明选择；明确不可用不fallback；请求/Router每轮实际modelRef和effort对应，不只UI改名 |
| 兼容与功能 | 已保存exact1/2、历史重放、跨型号会话、业务模板与各类输出 | 旧参数/模板哈希/任务不改；结构化JSON仍严格校验；图片理解/生成/工具执行分别验收 |

本轮没有实现以上新增目录/档位/策略，没有对所有型号或所有功能作真实验收。当前已实现的exact版本、Low/High、原菜单、风格及图片/画板手动链路可继续使用；完整画布Agent、导演JSON、实时后台取消及专门视频/蒙版/图层能力不随新型号目录自动上线。

源码核对入口：`model-catalog.ts:3–69`（metadata/目录/精确选择），`model-selectors.ts:44–87`（原菜单投影、无额外聊天控件），`assistant.ts:305–322`（历史模态与run DTO），`studio.ts:75–78`（Frames调用），`execution.ts:310–345`（功能工具/画板），`model-bindings.ts:15–36`（版本保留）；Go `service.go:89–151、251–287、388–434、665–688`（接受与worker复核），`prompts.go:38–102` 和 `prompt_templates.go:239–246`（可信模板/摘要），`modelgateway/application/invocation.go:51–126`（Router边界DTO）。
