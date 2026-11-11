# 无限画布节点功能上线与缺口台账

更新：2026-10-08。维护入口为本文件和 [机器可读台账](canvas-node-status.json)。旧 [原站功能矩阵](model-function-matrix.md) 是入口索引，不代表 STUDIO 上线状态。

本轮已部署并完成H3与基础视频处理真实验收：STUDIO API `e7a00ed`、Web `dbc44ad`、Router `fb8265f`、H3 `0.3.0`。详见 [接入与验收记录](h3-video-integration.md) 和 [任务/资产记录](h3-video-live-acceptance.json)。其余功能继承2026-10-07代码核对及更早实测，不冒充本轮全量逐按钮验收。

2026-11-04 补充：模型、端口、断线重连、当前素材和独立节点工具，以[本次画布生成入口验收](acceptance/canvas-boundary.md)及其逐项矩阵为准。下表保留原功能编号和历史实测范围；新验收截在实际模型之前，不将 mock 结果标为线上真实出片。

## 统计口径

覆盖旧矩阵全部 **214 个合并坐标、294 个细分操作**，按 **101 个功能组**维护（其中长视频智能选帧另作专项）。机器台账保留每个 F 编号到功能组的映射及 7 个 B 边界项；子入口没有自己的实测证据时不继承功能组的 LIVE 状态；不把同一预设、不同按钮或同一能力重复相加为模型数。

| 状态 | 功能组数 | 判定 |
|---|---:|---|
| 已上线·代表实测 | 28 | 有线上真实代表样本；子选项范围见备注，不是每一项均实测 |
| 已接线·待专项实测 | 24 | 代码/协议已接，有相关用例或基础能力；该原生按钮尚缺完整真实验收 |
| 部分实现·有缺口 | 22 | 已有底座，但存在明确缺口/未完成的子流程，不能称整体可用 |
| 上游就绪·画布未接 | 0 | 上游已验收，Router/STUDIO/画布接线与页面闭环仍未完成 |
| 未打通·缺能力/适配 | 23 | 缺真实模型、功能协议或专门适配，不算已打通 |
| 入口或行为待核验 | 4 | 历史候选/入口可达性或行为待确认，不算上线 |

## 本轮重要修正

- 10月10日补充：再次生成输入隔离与原生提交校验已修复，详见 [新建/再次生成场景矩阵](regeneration-input-audit-2026-10-10.md)。后端101项、前端296项相关测试通过；本轮不按所有图片子功能真实重新出图统计。

- 10月8日补充：分镜大师连续编辑两处前端拒绝已修复；45分支完成契约核验，“角色三视图→推镜头”两次真实生成完成。生成接口已加入持久日志、log_id与飞书报错通知，见 [专项记录](generation-observability-2026-10-08.md)。

- 图片18项工具的最新真实记录在 [图片工具上线验收](image-node-tools.md)：已接通的语义编辑和本地处理不再误记为未配置；编辑元素、真正超分仍缺。角色/人物/分镜预设不以目录数量冒充逐项真实生成。
- 新画布 Agent 的建节点、连线、一次生图、自动回填及排版已上线；旧文档“完全没有工具循环”已过期。其首批纯文字限制仍有效。共享普通 CLI 登录状态见 Router 的 [共享登录记录](../../studio-model-router/docs/shared-cli-auth.md)。
- 视频基础媒体异步完成链已修复并真实验收；模型结果和本地处理结果都持久写回独立节点，详见下节。
- “全部音轨提取”已由FFmpeg打通；人声/环境音分离仍是另一类模型。H3不能自动补齐视频解析、深度、超分、补帧、修复、精确重拍或完整复刻。

## 视频异步闭环进展

2026-10-07记录的MEDIA缺口已在本轮修复：原生工具提交会绑定保存版本与节点，登记查询，后台写回真实资产并保留历史；任务完成后无需依赖原浏览器继续打开。全部音轨第一项已映射确定性FFmpeg，仍不提供人声/环境音分离。

本轮四条H3路径、裁剪/2x倍速/倒放/右转90°/全部音轨提取均真实成功并刷新恢复；首尾帧抓取生成两图片节点。详细输入范围、失败草稿、修复过程与残余限制见 [本轮记录](h3-video-integration.md)。取消、镜像、其他参数、OpenCut、批量等未逐项实测，不能继承代表样本状态。

## 未接通入口的展示标记（2026-10-08）

前端适配层 `canvas-tool-availability.ts` 对已确认缺口的节点工具显示灰色图标/文字和“暂不可用”原因，并拦截鼠标及键盘触发，防止继续创建悬空结果节点。规则绑定所属节点，不按全页面同名文字禁用；切换节点、菜单重绘和卸载会恢复适配层自有属性，不改原生 disabled 或任何画布数据。

覆盖：图片编辑元素、精确放大/高清；视频重拍、复刻、画质处理、深度捕捉、解析、分轨、修复、编辑/延长、纯文生成、动作模仿及超出当前范围的 5x/10x；文本/分镜中的视频理解入口；音频识别、对口型及未接入的音频生成入口。已存在且无真实模型绑定的纯文视频、音频、3D 生成节点也按明确子类型提示缺能力。新增已绑定真实能力的生成按钮不按旧子类型覆盖。

混合菜单保留：图片“画质→增强”和视频“音频分离→音频分离（完整音轨）”；图片解析、人物/风格/预设/摄像机、重绘/擦除/抠图、H3 首帧/首尾帧/全能参考及本地媒体处理不在置灰规则内。上传、播放、预览、下载和添加节点不整体禁用。WIRED/REVIEW 未验证项不会因此视为不可用；本标记不改变任何功能上线状态。以后接通新功能必须同步移除对应明确缺口规则，并补专项验收。

验证：受影响前端四组测试共 83 项通过，TypeScript 检查通过。线上核验：视频工具栏 6 个明确缺口项呈灰色（opacity 0.42）并带原因；完整音轨子项保留、人声/环境音子项禁用；点击禁用子项出现原因且节点数仍为 14。图片画质菜单增强可用、放大/高清禁用，编辑元素禁用；切换图片/视频后标记按所属节点恢复。捕捉帧弹窗正常打开，H3 生成按钮保持未禁用。图片“高清”参数同名项额外有隔离测试。只更新 web（2365ce7），API/Router 未重启；本轮未新发模型生成任务。

2026-10-08 补充：按产品要求，技能、插件导航及画布工作流/Agent 技能书入口暂时置灰，不改变资源数据和后端能力状态。2D/实时画板“限时免费”等收费显示补漏已上线，保留工具与生成按钮。详见 [内部版本记录](internal-edition.md#2026-10-08暂停入口与收费显示补漏)。

## 文本

| 编号／功能 | 状态 | 现有结果与限制 | 下一步 | 证据 |
|---|---|---|---|---|
| T01 文字生成、重试、上下文与型号/推理强度 | 已上线·代表实测 | 真实文字与Low/High切换、后台完成和刷新恢复已有证据。 | P3：保持现有回归；新功能另验 | [text](text-llm-replacement.md)、[persist](canvas-server-writeback-2026-10-06.md)、[imagebase](image-capability-integration.md) |
| T02 参考图片理解 | 已上线·代表实测 | Codex视觉真实可用；5.6不进入图片理解候选。 | P3：不把视觉可用扩展为视频/音频理解 | [imagebase](image-capability-integration.md)、[text](text-llm-replacement.md) |
| T03 图片反推提示词 | 已接线·待专项实测 | 保留视觉模板和图片输入；该文本节点快捷入口未找到独立线上任务证据。 | P2：原按钮生成及刷新验收 | [exec](../apps/web/src/service/execution.ts)、[text](text-llm-replacement.md) |
| T04 参考视频理解/生成文字 | 未打通·缺能力/适配 | 没有真实视频理解适配器；H3是视频生成，不输出视频分析文字。 | P2：接视频理解或经过验收的抽帧+ASR分析链 | [exec](../apps/web/src/service/execution.ts)、[grants](../apps/api-go/internal/modules/modelmedia/application/reader.go)、[router](../../studio-model-router/internal/bootstrap/execution.go) |
| T05 歌词生成 | 已接线·待专项实测 | 已映射LLM；专用歌词临时节点及标题/标签回填未真实验收。 | P2：歌词入口与取消/回填专项 | [text](text-llm-replacement.md)、[texttest](../tests/web/text-tools-protocol.test.ts)、[exec](../apps/web/src/service/execution.ts) |
| T06 选中文字转图片 | 已接线·待专项实测 | 建节点/连线及图片能力存在；不能用Agent生图验收替代该快捷按钮。 | P2：选中文字→图片→刷新 | [matrix](model-function-matrix.json)、[exec](../apps/web/src/service/execution.ts)、[imagebase](image-capability-integration.md) |
| T07 文字转视频 | 未打通·缺能力/适配 | 可创建后续节点，当前H3 API必须有视觉参考，未开放纯文生视频。 | P2：先图后视频另列流程；纯文入口保持不可用 | [exec](../apps/web/src/service/execution.ts)、[h3](../../studio-video-api/handoff/integration-contract.json) |
| T08 手工编辑、文档导入、排版 | 已接线·待专项实测 | 保留原生编辑和保存；各种文档格式/富文本子操作没有逐项现场证据。 | P3：按支持格式验导入和刷新，不需模型 | [matrix](model-function-matrix.json)、[front](frontend-api-integration.md) |

## 剧本/分镜/实体

| 编号／功能 | 状态 | 现有结果与限制 | 下一步 | 证据 |
|---|---|---|---|---|
| S01 文本生成结构化分镜 | 已上线·代表实测 | 已有真实两镜头与表格恢复记录；不是所有复杂剧本均已验证。 | P2：统一服务端与表格字段校验 | [text](text-llm-replacement.md) |
| S02 图片参考分镜 | 已接线·待专项实测 | 视觉输入、结构化输出路径存在；该组合待真实验收。 | P2：图片→shots/entities→表格 | [text](text-llm-replacement.md)、[storytest](../tests/web/storyboard-execution.test.ts) |
| S03 视频参考分镜 | 未打通·缺能力/适配 | 缺视频理解。 | P2：与视频解析一起接入 | [text](text-llm-replacement.md)、[grants](../apps/api-go/internal/modules/modelmedia/application/reader.go) |
| S04 自动场景、六类场景、画风/全局要求 | 已接线·待专项实测 | 模板和两阶段分类已实现；不把一个电影样本算六场景全通过。 | P2：代表场景与自动分类单独验收 | [text](text-llm-replacement.md)、[storytest](../tests/web/storyboard-execution.test.ts) |
| S05 角色/场景/道具/商品单个及批量生图、四视图、人设、变装 | 已接线·待专项实测 | 已有真实图片模型和专门实体提交适配；整套实体/批量/变装按钮未逐项真实验收。 | P2：按原入口验证选中范围、参考身份和历史回填 | [storytest](../tests/web/storyboard-execution.test.ts)、[front](frontend-api-integration.md)、[imagebase](image-capability-integration.md) |
| S06 合成分镜故事板 | 已接线·待专项实测 | 分镜输出与故事板接线存在；不等同图片工具栏四宫格的实测。 | P2：真实多镜头故事板及节点回填 | [storytest](../tests/web/storyboard-execution.test.ts)、[exec](../apps/web/src/service/execution.ts) |
| S07 独立直接生图/生视频候选按钮 | 入口或行为待核验 | 当前可见按钮可达性未确认；不能重复算已上线入口。 | P3：先核实可见UI，合并别名 | [matrix](model-function-matrix.json) |
| S08 分镜图组/故事板组批量视频、视频组重新生成 | 部分实现·有缺口 | 单节点H3已接入并实测；批量组包、整组素材/音色与回填尚未专项验收。 | P1：复用单镜H3推进批量依赖/恢复 | [h3canvas](h3-video-integration.md)、[matrix](model-function-matrix.json)、[exec](../apps/web/src/service/execution.ts)、[h3](../../studio-video-api/handoff/integration-contract.json) |
| S09 实体图上传、资源复用、名称描述编辑 | 已接线·待专项实测 | 常规资产/资源接口已接；实体按钮组合待专项。 | P2：上传→引用→刷新 | [front](frontend-api-integration.md)、[resources](../apps/web/src/service/resources.ts) |
| S10 实体音色上传、试听和绑定 | 部分实现·有缺口 | 音频资产存储不等于音色克隆/绑定生效；音色资源与后续模型缺验收。 | P2：分开验证保存试听与合成条件 | [resources](../apps/web/src/service/resources.ts)、[matrix](model-function-matrix.json) |

## 图片

| 编号／功能 | 状态 | 现有结果与限制 | 下一步 | 证据 |
|---|---|---|---|---|
| I01 文生图、参考图编辑、模型选择 | 已上线·代表实测 | 真实PNG、参考图和刷新保留已验。 | P3：保持版本与资产校验 | [imagebase](image-capability-integration.md)、[image](image-node-tools.md) |
| I02 生成数量、透明参数及其他参数 | 部分实现·有缺口 | count支持1/2/4且每张建独立节点；透明抠图已验，任意尺寸/质量/格式菜单不代表全部受支持。 | P2：只按能力schema开放；普通透明开关单独验收 | [batch](image-batch-canvas.md)、[image](image-node-tools.md) |
| I03 角色设计 | 已接线·待专项实测 | 18项角色选项已有目录/语义编译；未找到每项真实角色生成证据。 | P2：代表角色标签的原按钮验收 | [image](image-node-tools.md) |
| I04 风格库、预设、摄像机控制 | 已上线·代表实测 | 风格图、电影写实、胶片及ARRI/Zeiss组合有真实任务；不是校准相机模拟。 | P3：其余选项保持契约级验证标识 | [image](image-node-tools.md) |
| I05 解析 | 已上线·代表实测 | 真实输出正/负提示词文本节点。 | P3：保持原模板与引用 | [image](image-node-tools.md) |
| I06 局部元素识别/点击定位 | 部分实现·有缺口 | 有视觉理解，但bbox协议/点击坐标精度未完整验收。 | P2：定位schema及坐标/命中专项 | [imagebase](image-capability-integration.md) |
| I07 画质增强 | 已上线·代表实测 | 真实生成增强图；不宣称量化提升或原像素保持。 | P3：明确是语义增强 | [image](image-node-tools.md) |
| I08 画质放大/高清、精确倍率超分 | 未打通·缺能力/适配 | 无真正超分能力。 | P2：提供可控倍率或目标尺寸超分接口 | [image](image-node-tools.md) |
| I09 图片换背景快捷入口 | 已接线·待专项实测 | 普通参考编辑换背景已实测；快捷按钮另验。 | P2：验证该快捷入口及源图绑定 | [imagebase](image-capability-integration.md)、[exec](../apps/web/src/service/execution.ts) |
| I10 人物调节：情绪、视线、嘴形、年龄、肤色、发型、体态、妆容、保护项 | 已上线·代表实测 | 162选项已有语义接线；仅调皮眨眼代表路径真实生成，其余未逐项实机。 | P2：按选项保留代表验收范围；不承诺身份/背景像素锁定 | [image](image-node-tools.md) |
| I11 人物姿态/关节控制 | 已接线·待专项实测 | POSE与原图关系已编译；关节精度及完整人体结果未专项。 | P2：真实姿态对照与保护项验收 | [image](image-node-tools.md) |
| I12 人物服饰配件候选入口 | 入口或行为待核验 | 原入口是否可达未确认。 | P3：不把目录标签当独立功能 | [matrix](model-function-matrix.json) |
| I13 重绘、擦除、扩图 | 已上线·代表实测 | 原图+标记图语义编辑真实通过；区域外可能变化，扩图尺寸由模型决定。 | P3：严格mask模型/局部合成作为另一期 | [image](image-node-tools.md) |
| I14 抠图、去文字 | 已上线·代表实测 | 透明PNG有效像素和实际去字已验。 | P3：保留透明输出硬校验 | [image](image-node-tools.md) |
| I15 角度、打光 | 已上线·代表实测 | 90度侧面与侧光代表样本通过；是生成意图，不是3D物理重建。 | P3：其余参数代表验收 | [image](image-node-tools.md) |
| I16 编辑元素：默认分层/专门图层拆分 | 未打通·缺能力/适配 | 目前明确提示不可用，无独立图层输出模型。 | P2：分层RGBA、层级、位置/蒙版接口 | [image](image-node-tools.md) |
| I17 全景图生成/预设 | 已上线·代表实测 | 2:1图片已生成；未证明无缝球面、指定2K/4K。 | P3：接缝/像素要求另验 | [image](image-node-tools.md) |
| I18 标注、裁剪、旋转、调色、宫格裁剪 | 已上线·代表实测 | 真实本地处理、像素/尺寸校验和刷新保存；宫格实测4格，不代表任意格数均实测。 | P3：维持独立图片节点与资产 | [image](image-node-tools.md) |
| I19 镜像 | 已接线·待专项实测 | 保留原生本地操作；本轮未找到独立真实镜像文件证据。 | P2：像素对照和刷新 | [matrix](model-function-matrix.json)、[front](frontend-api-integration.md) |
| I20 分镜格子创建/合成 | 已接线·待专项实测 | 与已验的4格裁剪不同；创建格子及再合成待原按钮验收。 | P2：格子编辑→合成→刷新 | [matrix](model-function-matrix.json)、[front](frontend-api-integration.md) |
| I21 全景查看、FOV、参考线、截图、多视角、导入导演 | 已接线·待专项实测 | 原生本地查看保留；不因全景生成通过而承诺这些全部验收。 | P3：球面查看/截图导回/导演引用分别验 | [matrix](model-function-matrix.json)、[front](frontend-api-integration.md) |
| I22 普通图片组执行 | 已接线·待专项实测 | DAG/组任务存在；多图批次和整组执行是不同语义。 | P2：真实组依赖、失败范围和恢复 | [exec](../apps/web/src/service/execution.ts)、[persist](canvas-server-writeback-2026-10-06.md) |
| I23 预览、下载 | 已上线·代表实测 | 实际图片解码/下载与持久化已有证据。 | P3：保持鉴权链接恢复 | [image](image-node-tools.md)、[imagebase](image-capability-integration.md) |
| I24 加入Agent | 部分实现·有缺口 | 旧视觉聊天有图片理解；新画布工具Agent首批只收纯文字历史，不能概括为所有Agent附件可用。 | P2：明确legacy视觉与新Agent多模态分支 | [agent](canvas-agent-implementation-2026-10-07.md)、[imagebase](image-capability-integration.md) |
| I25 分镜大师：三视图/剧情四宫格 | 已上线·代表实测 | 两个原生代表场景有真实图；四宫格合成图后需裁成节点。 | P3：不自动扩展到所有分镜场景 | [image](image-node-tools.md)、[imagebase](image-capability-integration.md) |
| I26 分镜大师：其余宫格、光影、景别、构图、情绪、天气等 | 已接线·待专项实测 | 场景白名单/提示词及图生图接线完成；其他选项没有逐个真实生成。 | P2：代表场景抽验，布局/人物一致性另验 | [image](image-node-tools.md)、[exec](../apps/web/src/service/execution.ts) |

## 视频

| 编号／功能 | 状态 | 现有结果与限制 | 下一步 | 证据 |
|---|---|---|---|---|
| V01 首帧、首尾帧生成 | 已上线·代表实测 | 首帧、首尾帧均经原生按钮真实生成864×480、5.167秒视频，后台回填与刷新通过。 | P3：维持v1已验组合；扩分辨率/时长需新版本 | [h3canvas](h3-video-integration.md)、[h3](../../studio-video-api/handoff/integration-contract.json)、[h3live](../../studio-video-api/handoff/live-acceptance.json)、[router](../../studio-model-router/internal/bootstrap/execution.go) |
| V02 多图参考、全能参考 | 已上线·代表实测 | 全能参考入口的2图+1音频、1图+1视频+1音频真实出片；多图旧别名入口未专项验收。 | P2：满配输入与多图别名入口专项；保持素材顺序和授权 | [h3canvas](h3-video-integration.md)、[h3](../../studio-video-api/handoff/integration-contract.json)、[h3live](../../studio-video-api/handoff/live-acceptance.json)、[grants](../apps/api-go/internal/modules/modelmedia/application/reader.go) |
| V03 视频参考模式 | 部分实现·有缺口 | 含视频H3通过全能参考入口真实可用；旧VIDEO_TO_VIDEO视频参考模式仍不直接映射。 | P1：整理旧视频参考入口，不能把参考生成当精准编辑 | [h3canvas](h3-video-integration.md)、[h3](../../studio-video-api/handoff/integration-contract.json)、[exec](../apps/web/src/service/execution.ts) |
| V04 纯文生视频 | 未打通·缺能力/适配 | 底层可能有能力，但当前三个profile API未开放纯文。 | P2：待上游新profile/验收，不静默先造图 | [h3](../../studio-video-api/handoff/integration-contract.json)、[h3opts](../../studio-video-api/handoff/capability-options.json) |
| V05 视频编辑/精准帧标注编辑 | 未打通·缺能力/适配 | 全能参考生成不等于按指定帧/区域改原视频；当前无编辑合同。 | P2：视频编辑模型或明确重生成产品方案 | [h3](../../studio-video-api/handoff/integration-contract.json)、[h3opts](../../studio-video-api/handoff/capability-options.json)、[exec](../apps/web/src/service/execution.ts) |
| V06 视频延长 | 未打通·缺能力/适配 | 未提供extend/连续时间保持能力。 | P2：续接模型或首尾衔接方案独立验收 | [h3](../../studio-video-api/handoff/integration-contract.json)、[exec](../apps/web/src/service/execution.ts) |
| V07 视频重拍/片段重拍 | 部分实现·有缺口 | 10-09原站公开代码确认：选段→裁切→视频编辑生成→拼回，区别于底部再次生成；PF缺端到端接线，保持置灰。 | P2：先修媒体闭环，再定义片长、声轨与衔接；不可直接挂普通H3 | [10-09调研](video-regeneration-and-reshoot-2026-10-09.md)、[native](../apps/web/public/project/assets/index-DeyN_Phq.js)、[exec](../apps/web/src/service/execution.ts)、[h3](../../studio-video-api/handoff/integration-contract.json) |
| V08 一键复刻 | 未打通·缺能力/适配 | 缺视频理解/镜头与实体规划/审核和生成全流程；H3只补生成阶段。 | P2：视频解析→结构化镜头→参考图→H3→拼接分阶段验收 | [matrix](model-function-matrix.json)、[agent](canvas-agent-implementation-2026-10-07.md)、[grants](../apps/api-go/internal/modules/modelmedia/application/reader.go) |
| V09 画质：高清、放大、增强、降噪、补帧 | 未打通·缺能力/适配 | 没有对应真实视频增强/补帧适配器；导出60fps或放大尺寸不算AI增强。 | P2：视频超分/时序降噪/插帧模型；分别注册 | [exec](../apps/web/src/service/execution.ts)、[router](../../studio-model-router/internal/bootstrap/execution.go)、[h3opts](../../studio-video-api/handoff/capability-options.json) |
| V10 剪辑（OpenCut）、时间线、导出/加入画布 | 已接线·待专项实测 | 保留浏览器编辑器及本地存储；Studio导出实测不能算OpenCut所有按钮已验。 | P1：原视频入口→编辑→导出→上传→刷新 | [front](frontend-api-integration.md)、[matrix](model-function-matrix.json) |
| V11 捕捉帧、首帧/当前帧/尾帧、逐秒抽帧 | 已上线·代表实测 | 捕捉帧面板截首帧/尾帧后生成两独立PNG节点，刷新保留；当前帧/逐秒/右侧加号未专项实测。 | P2：补当前帧、逐秒与快捷入口专项 | [h3canvas](h3-video-integration.md)、[native](../apps/web/public/project/assets/index-DeyN_Phq.js)、[matrix](model-function-matrix.json)、[front](frontend-api-integration.md) |
| V12 深度捕捉 | 未打通·缺能力/适配 | 需要VIDEO_DEPTH_CONVERTER；当前没有视频深度模型，H3不会输出深度图。 | P2：时序一致的深度视频/深度帧服务 | [native](../apps/web/public/project/assets/index-DeyN_Phq.js)、[exec](../apps/web/src/service/execution.ts)、[router](../../studio-model-router/internal/bootstrap/execution.go) |
| V13 解析/视频分析 | 未打通·缺能力/适配 | 无VIDEO理解；不能直接把视频给当前Codex图像入口。 | P2：视频理解或抽帧+时间戳+ASR链，明确漏检边界 | [exec](../apps/web/src/service/execution.ts)、[grants](../apps/api-go/internal/modules/modelmedia/application/reader.go)、[router](../../studio-model-router/internal/bootstrap/execution.go) |
| V14 音频分离：全部音轨 | 已上线·代表实测 | 原音频分离第一项已接EXTRACT_AUDIO；真实WAV、独立音频节点和刷新通过。 | P2：无音轨错误分支专项；人声/环境音仍独立缺能力 | [h3canvas](h3-video-integration.md)、[native](../apps/web/public/project/assets/index-DeyN_Phq.js)、[mservice](../apps/api-go/internal/modules/media/application/service.go)、[mediatest](../apps/api-go/internal/modules/media/adapters/ffmpeg/engine_test.go) |
| V15 音频分离：人声/环境音 | 未打通·缺能力/适配 | 需要音源分离能力；抽取整个音轨不能替代。 | P2：人声/伴奏/环境声分离接口 | [native](../apps/web/public/project/assets/index-DeyN_Phq.js)、[exec](../apps/web/src/service/execution.ts) |
| V16 视频修复：去水印、去字幕、去模糊 | 未打通·缺能力/适配 | 没有对应真实修复模型；提示词重生成不能算修复。 | P2：视频修复模型及时间一致性验收 | [native](../apps/web/public/project/assets/index-DeyN_Phq.js)、[exec](../apps/web/src/service/execution.ts)、[router](../../studio-model-router/internal/bootstrap/execution.go) |
| V17 裁剪（画面） | 已上线·代表实测 | 原裁剪按钮1:1产生480×480独立视频，MEDIA后台回填与刷新通过。 | P2：补其他比例与边界裁框专项 | [h3canvas](h3-video-integration.md)、[native](../apps/web/public/project/assets/index-DeyN_Phq.js)、[exec](../apps/web/src/service/execution.ts)、[mediahttp](../apps/api-go/internal/modules/media/adapters/http/routes.go)、[mservice](../apps/api-go/internal/modules/media/application/service.go)、[writeback](../apps/api-go/internal/modules/execution/adapters/postgres/node_writeback.go)、[mediatest](../apps/api-go/internal/modules/media/adapters/ffmpeg/engine_test.go) |
| V18 倍速 | 已上线·代表实测 | 原倍速2x产生2.625秒独立视频并保留音轨，刷新通过；仅支持0.25–4倍，旧5x/10x不可用。 | P1：整理超范围选项；补其他倍速与失败重开工具 | [h3canvas](h3-video-integration.md)、[native](../apps/web/public/project/assets/index-DeyN_Phq.js)、[exec](../apps/web/src/service/execution.ts)、[mediahttp](../apps/api-go/internal/modules/media/adapters/http/routes.go)、[mservice](../apps/api-go/internal/modules/media/application/service.go)、[writeback](../apps/api-go/internal/modules/execution/adapters/postgres/node_writeback.go)、[mediatest](../apps/api-go/internal/modules/media/adapters/ffmpeg/engine_test.go) |
| V19 倒放 | 已上线·代表实测 | 原倒放按钮真实成片、独立节点、音轨及刷新通过；仍有256MiB解码缓冲上限。 | P2：补超限/取消交互专项；失败从源视频重开工具 | [h3canvas](h3-video-integration.md)、[native](../apps/web/public/project/assets/index-DeyN_Phq.js)、[exec](../apps/web/src/service/execution.ts)、[mediahttp](../apps/api-go/internal/modules/media/adapters/http/routes.go)、[mservice](../apps/api-go/internal/modules/media/application/service.go)、[writeback](../apps/api-go/internal/modules/execution/adapters/postgres/node_writeback.go)、[mediatest](../apps/api-go/internal/modules/media/adapters/ffmpeg/engine_test.go) |
| V20 旋转/水平垂直镜像 | 已上线·代表实测 | 右转90°实测480×864独立成片、音轨及刷新通过；水平/垂直镜像未逐按钮实测。 | P2：镜像和其他角度专项 | [h3canvas](h3-video-integration.md)、[native](../apps/web/public/project/assets/index-DeyN_Phq.js)、[exec](../apps/web/src/service/execution.ts)、[mediahttp](../apps/api-go/internal/modules/media/adapters/http/routes.go)、[mservice](../apps/api-go/internal/modules/media/application/service.go)、[writeback](../apps/api-go/internal/modules/execution/adapters/postgres/node_writeback.go)、[mediatest](../apps/api-go/internal/modules/media/adapters/ffmpeg/engine_test.go) |
| V21 时间裁切、拼接、压缩 | 部分实现·有缺口 | MEDIA后台回填已补；时间裁切、拼接、压缩不同原生组/重拍入口仍待专项。 | P1：逐入口验证次序/音轨与结果绑定 | [h3canvas](h3-video-integration.md)、[media](media-execution.md)、[exec](../apps/web/src/service/execution.ts)、[native](../apps/web/public/project/assets/index-DeyN_Phq.js) |
| V22 Draft渲染成片 | 未打通·缺能力/适配 | 原流程依赖专门供应商Draft任务标识；H3当前直接出MP4，无Draft阶段。 | P3：保持不可用，不伪造上游taskId | [native](../apps/web/public/project/assets/index-DeyN_Phq.js)、[h3](../../studio-video-api/handoff/integration-contract.json) |
| V23 风格/预设应用 | 部分实现·有缺口 | 目录与条件可保存，H3四条单节点路径已验；视频风格/预设组合未逐项验收。 | P2：验证语义条件与素材输入 | [h3canvas](h3-video-integration.md)、[exec](../apps/web/src/service/execution.ts)、[h3](../../studio-video-api/handoff/integration-contract.json) |
| V24 长视频智能选帧 | 部分实现·有缺口 | 不能把可均匀抽帧写成智能镜头分析已可用；原生有智能失败降级提示。 | P2：先验基础抓帧，智能选帧单独接理解能力 | [native](../apps/web/public/project/assets/index-DeyN_Phq.js)、[matrix](model-function-matrix.json) |

## 复刻工作台

| 编号／功能 | 状态 | 现有结果与限制 | 下一步 | 证据 |
|---|---|---|---|---|
| R01 解析脚本/资产、审核、继续、重编分镜 | 未打通·缺能力/适配 | 专门复刻分析/审核协议未完整接入，缺视频理解。 | P2：先补真实分析与可恢复阶段状态 | [matrix](model-function-matrix.json)、[front](frontend-api-integration.md)、[grants](../apps/api-go/internal/modules/modelmedia/application/reader.go) |
| R02 角色/场景/道具图、三视图、变装 | 部分实现·有缺口 | 通用图片能力可复用，复刻工作台专门API和回填未打通。 | P2：独立适配工作台实体与资产，不冒充普通图片按钮 | [imagebase](image-capability-integration.md)、[matrix](model-function-matrix.json) |
| R03 分镜视频单/批量生成、重拍 | 部分实现·有缺口 | 上游H3可承担部分生成；复刻任务阶段/审核/重拍拼接仍缺。 | P2：依赖单节点H3和复刻分析完成 | [matrix](model-function-matrix.json)、[h3](../../studio-video-api/handoff/integration-contract.json) |
| R04 角色声音、音色、成片/对比导出 | 部分实现·有缺口 | 媒体导出与音频资产基础存在；该工作台声音/对比导出端到端未验。 | P2：分别补绑定、对比布局及导出验收 | [matrix](model-function-matrix.json)、[media](media-execution.md)、[resources](../apps/web/src/service/resources.ts) |
| R05 设定板/生成角色参考声音候选 | 入口或行为待核验 | 可见独立入口/生成协议未确认；不重复计数。 | P3：确认入口后再分配模型 | [matrix](model-function-matrix.json) |

## 音频

| 编号／功能 | 状态 | 现有结果与限制 | 下一步 | 证据 |
|---|---|---|---|---|
| A01 语音、音乐、参考音频生成 | 未打通·缺能力/适配 | 无真实TTS/MUSIC/AUDIO_TO_AUDIO；H3带音轨视频不等于这些音频模型。 | P2：语音/音乐/音频变换接口分别提供 | [exec](../apps/web/src/service/execution.ts)、[router](../../studio-model-router/internal/bootstrap/execution.go) |
| A02 音色目录、试听、收藏 | 部分实现·有缺口 | 资源API有实现；音色内容与供应商voice ID未完整接通。 | P2：真实音色资源及模型绑定 | [resources](../apps/web/src/service/resources.ts)、[front](frontend-api-integration.md) |
| A03 音频生成视频 | 部分实现·有缺口 | 全能参考的图+音频已真实可用；至少需要视觉参考，纯音频生成视频仍未开放。 | P1：音频节点快捷入口专项并明确视觉参考要求 | [h3canvas](h3-video-integration.md)、[h3](../../studio-video-api/handoff/integration-contract.json)、[h3opts](../../studio-video-api/handoff/capability-options.json) |
| A04 音频提取文案 | 未打通·缺能力/适配 | 没有真实ASR/音频理解。 | P2：ASR含时间戳与语言信息 | [exec](../apps/web/src/service/execution.ts)、[grants](../apps/api-go/internal/modules/modelmedia/application/reader.go) |
| A05 图片对口型 | 未打通·缺能力/适配 | 音频条件视频不等于已经通过对口型验收；无专门同步能力。 | P2：唇同步接口及音画同步验收 | [exec](../apps/web/src/service/execution.ts)、[h3](../../studio-video-api/handoff/integration-contract.json) |
| A06 音频裁切/倍速 | 已接线·待专项实测 | 引擎具备音频trim/atempo；原音频节点按钮/结果保存待逐项核验。 | P1：原按钮→实际WAV/媒体→刷新 | [media](media-execution.md)、[front](frontend-api-integration.md)、[mediatest](../apps/api-go/internal/modules/media/adapters/ffmpeg/engine_test.go) |

## 3D/世界

| 编号／功能 | 状态 | 现有结果与限制 | 下一步 | 证据 |
|---|---|---|---|---|
| D01 文字/图片/视频生成3D世界、文字/图片生成3D模型 | 未打通·缺能力/适配 | 目录映射/显式mock不等于真实3D能力；无真实供应商。 | P3：实际3D/世界文件、纹理和预览协议 | [exec](../apps/web/src/service/execution.ts)、[router](../../studio-model-router/internal/bootstrap/execution.go) |
| D02 预览、材质、变换、截图、文件导出、加入导演 | 已接线·待专项实测 | 已有文件导入验证和原生查看；所有格式及原按钮未逐项产品验收。 | P3：用真实文件验显示、导出及引用 | [front](frontend-api-integration.md)、[media](media-execution.md)、[matrix](model-function-matrix.json) |

2026-10-08 入口补齐：首页视频生成、动作模仿、爆款复刻及 AI 应用新增/选择/单节点运行已置灰；首页 Agent、图片模式和画布 H3 保留。旧模式提交也拦截。此为可用性展示调整，不提升 G03/G04/G05/W01 的验收状态，详见 [内部版本记录](internal-edition.md)。

2026-10-08 独立 Agent 面板补漏：画布内 `ap-*` 菜单的视频/动作模仿、一键复刻/爆款和 SkillHub 已纳入暂停规则，旧模式的发送/回车也拦截；停止任务、切换模式、Agent/图像及会话管理保留。SkillHub 等待公司内部服务接入，不删除既有数据。

2026-10-08 H3 入口更新：画布 Agent 视频模式已解除置灰，参数随 H3 当前能力目录展示；动作模仿、一键复刻、SkillHub 和首页视频仍暂停。详见 [Agent H3 接入记录](h3-video-integration.md#2026-10-08画布-agent-视频直接生成)。

## Agent/首页

| 编号／功能 | 状态 | 现有结果与限制 | 下一步 | 证据 |
|---|---|---|---|---|
| G01 纯文字Agent、工具改画布、选型、单节点生成、查询、移动 | 已上线·代表实测 | 真实建节点/连线/生图/自动回填/刷新及排版续轮通过；不含整图、撤销和子Agent。 | P3：保持工具权限与回执 | [agent](canvas-agent-implementation-2026-10-07.md)、[persist](canvas-server-writeback-2026-10-06.md) |
| G02 图片/视频/音频附件、加入Agent分析 | 部分实现·有缺口 | legacy视觉聊天可用；新工具Agent首批仅纯文字，视频/音频理解未接。 | P2：明确入口能力并补多模态工具Agent | [agent](canvas-agent-implementation-2026-10-07.md)、[imagebase](image-capability-integration.md) |
| G03 图像直接模式/首页生图 | 已接线·待专项实测 | 实际图片能力存在，不能用图片节点验收冒充首页/助手入口全验。 | P2：模式→建图→结果→刷新 | [exec](../apps/web/src/service/execution.ts)、[imagebase](image-capability-integration.md) |
| G04 视频直接模式/首页视频 | 部分实现·有缺口 | 画布 Agent 视频已接四个 H3 能力，首尾帧真实生成/回填/刷新通过；首页视频仍待接线，纯文生视频未接。 | P1：首页新建画布链路；Agent 验收见专项记录 | [h3canvas](h3-video-integration.md)、[h3](../../studio-video-api/handoff/integration-contract.json)、[exec](../apps/web/src/service/execution.ts) |
| G05 动作模仿 | 未打通·缺能力/适配 | 缺专门动作迁移验收；H3视频参考不证明动作精确跟随。 | P2：明确动作条件/角色保持并实机验收 | [exec](../apps/web/src/service/execution.ts)、[h3](../../studio-video-api/handoff/integration-contract.json) |
| G06 技能卡片、先询问/自动与生成偏好 | 部分实现·有缺口 | 技能与偏好存储存在；复杂技能/确认交互/生成偏好全语义未完成。 | P2：按当前Agent工具范围逐项对齐 | [agent](canvas-agent-implementation-2026-10-07.md)、[resources](../apps/web/src/service/resources.ts) |
| G07 聊天转Skill | 未打通·缺能力/适配 | 专用文件数组输出适配未接。 | P2：结构化文件生成/合法引用/保存 | [front](frontend-api-integration.md)、[text](text-llm-replacement.md) |
| G08 Skill Markdown优化 | 已接线·待专项实测 | 原生JSON字符串DTO已修复并有协议用例；未有专项真实模型验收。 | P2：原按钮优化→保存→重开 | [texttest](../tests/web/text-tools-protocol.test.ts)、[exec](../apps/web/src/service/execution.ts) |
| G09 技能目录/收藏/手工文件、角色库/资产/历史 | 已接线·待专项实测 | 真实业务API和部分线上证据；逐资源缺失如实保留，不当新模型。 | P3：资源内容完整性与原按钮专项 | [resources](../apps/web/src/service/resources.ts)、[front](frontend-api-integration.md) |

## 画板/导演/Studio

| 编号／功能 | 状态 | 现有结果与限制 | 下一步 | 证据 |
|---|---|---|---|---|
| P01 2D画板手动生成 | 已上线·代表实测 | 草图PNG/SKETCH→真实生成→加入画布和刷新已验。 | P3：保持草图输入 | [imagebase](image-capability-integration.md) |
| P02 2D实时生成、重新生成、风格 | 部分实现·有缺口 | 手动链可用，实时持续刷新/最新草图补跑/上游取消未验。 | P2：实时节流、结束与恢复专项 | [imagebase](image-capability-integration.md)、[exec](../apps/web/src/service/execution.ts) |
| P03 2D绘图/图层/撤销/历史/保存/下载/加入画布 | 已接线·待专项实测 | 原生编辑存在，截图与导回有代表证据；不等于所有本地工具已逐项验。 | P3：细分编辑/结果保存专项 | [front](frontend-api-integration.md)、[imagebase](image-capability-integration.md) |
| P04 3D导演AI文字/图片识别 | 未打通·缺能力/适配 | 布局feature/schema与筛选仍有缺口；不是3D生成模型问题。 | P2：先接结构化布局协议、再验本地摆场 | [text](text-llm-replacement.md)、[imagebase](image-capability-integration.md) |
| P05 导演确认/重摆、本地资源/动画/相机/灯光/录制、2D导演 | 部分实现·有缺口 | 原生本地编辑和资源API存在；AI结果依赖及部分资源缺失，完整导回未验。 | P3：分开验证本地编辑、资源内容与AI布局 | [resources](../apps/web/src/service/resources.ts)、[front](frontend-api-integration.md)、[matrix](model-function-matrix.json) |
| P06 Frames聊天自动创建/修改工程 | 部分实现·有缺口 | 普通聊天与Studio文件能力存在；自动工程工具/结构化卡片链未完整接通。 | P2：工程工具协议与真实文件产物 | [front](frontend-api-integration.md)、[text](text-llm-replacement.md)、[release](iteration-03-result.md) |
| P07 Studio工程预览、编辑、导出、导回画布 | 已上线·代表实测 | 原生1秒640×360导出、下载、VIDEO资产/节点和刷新通过；不等同OpenCut。 | P3：保持工程版本与资源引用 | [release](iteration-03-result.md) |

## 应用/工作流

| 编号／功能 | 状态 | 现有结果与限制 | 下一步 | 证据 |
|---|---|---|---|---|
| W01 AI应用节点、工作流/整图运行 | 部分实现·有缺口 | 权威应用版本/DAG机制存在；未登记外部工作流和无真实模型步骤不能执行。 | P3：按应用逐项注册与验收 | [front](frontend-api-integration.md)、[exec](../apps/web/src/service/execution.ts) |
| W02 遗留外层分镜回调 | 入口或行为待核验 | 仅toast的遗留回调不是当前可见组按钮；不新增入口或重复计数。 | P3：保留历史索引，使用实际组入口 | [matrix](model-function-matrix.json) |

## 跨节点

| 编号／功能 | 状态 | 现有结果与限制 | 下一步 | 证据 |
|---|---|---|---|---|
| X01 图片/视频提示词优化 | 已接线·待专项实测 | 目标生成模型仅作优化上下文；原生DTO已测，独立真实按钮验收待补。 | P2：原按钮回填，不丢用户参数 | [texttest](../tests/web/text-tools-protocol.test.ts)、[exec](../apps/web/src/service/execution.ts) |
| X02 从图片提取风格 | 已上线·代表实测 | 真实视觉返回原生单条风格描述DTO。 | P3：保持固定别名与图片归属校验 | [imagebase](image-capability-integration.md) |

## H3接入与参数边界

2026-10-08 补充：Agent 5 秒入口已部署并完成代表实测，见 `h3-video-integration.md` 与 `agent-h3-live-acceptance.json`。长时长已部署（Web `b325634` / Router `62ed054`）：首尾帧、图片音频参考、含视频全能参考可选 5/10/15 秒，纯首帧保留 5 秒。上游六个长时长组合 GPU 验收通过；产品层本次完成菜单/参数/旧版本及离线恢复核验，没有追加长视频生成，不扩大原有功能组 LIVE 计数。证据见 `h3-duration-ui-acceptance.json`。

来源：[接入合同](../../studio-video-api/handoff/integration-contract.json)、[实机记录](../../studio-video-api/handoff/live-acceptance.json)、[最新选项矩阵](../../studio-video-api/handoff/capability-options.json)。这些是本地交接文件，不是新HTTP路由；运行时能力以鉴权 `/v1/capabilities` 为准，再与验收组合白名单交集。

| Profile | 当前API接收 | GPU已验证 | 画布状态 |
|---|---|---|---|
| h3.fl2va.u02.v1 | 首帧或首尾帧；864×480/480×864；请求5秒 | 横屏首帧、首尾帧 | 已部署，原生画布实测 |
| h3.ref2va.u06.v1 | 多图+独立音频；864×480/480×864；请求5秒 | 横屏2图+1音频 | 已部署，原生画布实测 |
| h3.ref2va.video.v1 | 至少一份视觉参考，至多1视频，可加图/独立音频；864×480；请求5秒 | 横屏1图+1视频+1音频 | 已部署，原生画布实测 |

- 当前三profile输出24fps，5秒请求实际124帧、约5167ms。官方模型范围、API开放范围和实机验证范围分别记录；不把5秒永久写死，也不把未经开放/验收的4–15秒全展示为可提交。
- 参数按 `(profile_id,width,height,requested_duration_seconds,fps)` 有效组合投影；分别保存 `service_accepts / gpu_validation / default_canvas_enabled / disabled_reason`。fps当前固定24，API没有可提交fps字段。请求时长、预计帧数与结果真实 `duration_ms` 分开。
- 当前视频参考上传2–15秒、H264 MP4≤64MiB；实际只用开头最多124帧，原视频音轨不作声音条件。独立音频应由Router按可信metadata强制每段2–15秒且合计≤15秒；上游0.3目前未完整强制这两项，不宣传3×15秒。
- 最大参考数（9图、3音频、混合总数12及视频profile至多1视频）是合同校验上限，不是满配GPU/质量验收；竖屏虽被部分profile接收，仍未GPU验证。
- Router H3适配、私有鉴权/actor隔离、持久上传与任务映射、UNKNOWN原任务查询及MP4校验已实现。PF音视频授权读取和64MiB视频输出边界已接入。四条单节点路径均已实测。
- 后端拒绝不支持的H3取消，原生取消按钮仍待整理；没有精确进度；不提交seed/steps/负面提示词/参考强度/音轨开关等伪参数。共享CLI登录、原AutoDL公网映射保持独立。

### 排队、生成耗时与超时策略

[最新运行记录](../../studio-video-api/handoff/performance-and-model-loading.json)：同一 Comfy 进程、一个 H3 GPU worker，接口可同时接单，GPU FIFO 串行。FL2VA 与 Ref2VA 为两套不同 DiT；多种 profile 不表示多卡并行或完整权重同时驻留。

四次已记录的接单到归档耗时约 165、318、134、219 秒，318 秒样本含前一任务等待。未测稳定 P50/P95、冷/热切换代价，也不包含 STUDIO 上传与成片导回。画布只显示真实排队/运行状态，不给保证的倒计时。STUDIO/Router 的任务等待必须适配队列与长推理，不能用一个固定短请求超时判失败或重新生成；上游原应用共用队列也会增加等待。

## 下一步实施顺序与用户需准备的能力

| 批次 | 要完成的闭环 | 用户需准备 | 完成标准 |
|---|---|---|---|
| 已完成代表验收 | MEDIA回填，裁剪/倍速/倒放/旋转、首尾帧捕捉、全部音轨提取 | 无新模型；用自有测试视频 | 原生按钮→真实资产→独立节点→刷新；失败/取消和旧结果隔离 |
| 已完成代表验收 | H3首帧/首尾帧及全能参考，角色/参数、上传/幂等/恢复、成片导回 | 现有H3接口已齐；保持服务可访问 | 两条画布真实生成闭环，按动态已验组合开放 |
| P1 复用入口与体验 | 已完成全能参考；继续批量分镜、首页、OpenCut及取消/超范围菜单整理 | 现有Ref2VA可启动；更长时长/竖屏需上游新验收 | 输入不丢失，实际参数/结果可追踪，批量不重复生成 |
| P2 视频理解/复刻 | 解析、时间戳镜头、实体/对白、审核、图像/H3生成及拼接 | 视频理解API，或视觉抽帧+ASR方案 | 每阶段真实结构与资产、可恢复任务；整链才标复刻可用 |
| P2 专门视频工具 | 超分/降噪/补帧/去字修复/深度/音源分离/精准重拍 | 对应专门模型API；H3不自动涵盖 | 每工具实际文件、时序一致性和原按钮验收 |
| P2/P3 其余节点 | 图片分层/超分、歌词、语音音乐、导演布局、3D、复杂Agent/应用 | 分层/超分、TTS/音乐/ASR/唇同步、3D等按功能准备；部分仅需现有LLM适配 | 不以目录可选或普通模型成功替代各业务输出协议 |

## 补充待办

- P1：本轮清理失败测试草稿时，删除与原生省略的执行字段产生DELETE_EDIT保护冲突，需专项核对删除投影与隐藏元数据的合并。已核对并清理本次无结果草稿，普通生成、回填、刷新和继续添加节点通过。不能通过取消冲突保护来修复。

## 记录维护规则与本轮变更

- 每次完成一项，在JSON功能组更新状态、证据、真实任务/资产或测试记录、版本和残余限制，再同步本页。只有真实按钮输入→执行→资产/文字→回填→重载通过，才提升为相应范围的LIVE。
- 未实测、已知断链、未接模型分开保留；不能把未知当不存在，也不能把源代码能组包当已经上线。旧验收证据保留日期，不覆盖历史事实。
- 2026-10-07建立统一台账。2026-10-08已完成H3与MEDIA实现、部署和代表实测；8个功能组提升LIVE，历史细分入口按实际证据更新，镜像/快捷别名等仍保留未验标记。
- 文档校验仅核对JSON结构、索引完整性、证据链接与差异；不重复全量回归。后续代码修改按受影响范围测试，再补必要的真实页面验收。

## 2026-10-08 2D 画板修复补充

“显示更多”六项风格与空描述草图自动生成已实测；修复生成中仍显示等待、子路由状态丢失及短轮询限制。当前是异步自动出图，移除原站 4–6 秒承诺。P02 保持 PARTIAL：持续作画最新草图补跑与上游取消仍未验收。详见 [画板验收记录](sketchboard-generation-2026-10-08.md)。

## 2026-10-08 人物调节修复补充

I10 增补露齿笑真实样例；I11 原图+骨架姿态生成及默认站姿视觉验收完成，提升为 LIVE（代表路径）。功能组计数现为 LIVE 29、WIRED 23，其余不变。修复新节点队列未提交导致误判已删除的问题，未取消并发与输入一致性校验。详见 [人物调节修复记录](portrait-generation-fix-2026-10-08.md)。

### 2026-10-09：视频再次生成

节点底部「开始生成」复用原图原提示词真实生成成功，864×480、5.167 秒，回填、播放和刷新通过，新旧结果均在视频历史中。修复旧视频误计输入与原生空预设/历史缓存序列化差异。「视频重拍」仍置灰，含义为选段编辑后拼回，详见[修复与原站调研](video-regeneration-and-reshoot-2026-10-09.md)。

### 2026-10-10：生成图片选中后输入框

修复无上游生成图片被原生界面误判上传图、重绘结果默认隐藏参数的问题。正式页面 7%/30% 缩放可直接显示原提示词面板，多选/只读等限制保留，视频输入框正常，未修改生成数据。详见[验收记录](generated-image-composer-2026-10-10.md)。
