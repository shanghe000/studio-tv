# STUDIO 当前 Router 能力接入

当前纯文本入口、原站真实型号及兼容缺口以 [text-llm-replacement.md](text-llm-replacement.md) 为准。下方真实调用记录属于对应历史版本；当前 Agent/首页恢复原站没有聊天型号控件的界面，文本／剧本／歌词仍沿用原生模型菜单。

## 可执行入口

| STUDIO 入口 | Router 当前能力 | 输出 |
|---|---|---|
| 首页/画布助手 | LLM / AGENT，带图走 IMAGE_UNDERSTANDING | 文本，持久会话 |
| Studio Frames 助手 | LLM / AGENT | 文本；现有协议中的素材 URL 作为作品资料 |
| 文本、剧本、分镜、歌词节点 | LLM / AGENT | 原功能约定的文本或 schema JSON |
| 提示词优化、技能Markdown优化、LLM invoke | LLM / AGENT | 保留功能模板及结构化校验；对话转Skill专用接口尚未接入 |
| 图片识别、图片反推提示词、带图对话 | IMAGE_UNDERSTANDING / AGENT | 文本或 schema JSON |
| 文生图、图像编辑、人物调节、视频/音频/3D生成 | 当前显式 TEST MODE | 等真实媒体上游接入 |

| 模型 | 文本 profile | 图片理解 profile |
|---|---|---|
| Codex 5.6 | `codex-5-6-text-v1` | 不提供 |
| Codex 6 | `codex-6-text-v1` | `codex-6-vision-text-v1` |
| Codex 6.1 | `codex-6-1-text-v1` | `codex-6-1-vision-text-v1` |

Web 从真实能力目录读取 `model` 元数据，按 kind、输入及输出类型筛选，提交明确的 capabilityRef/version。默认 Codex 6.1；用户选择优先，未知、不可用或输入不兼容的选择拒绝，不自动替换。图片理解目录不显示5.6，视频输入不会选择仅支持 TEXT/IMAGE 的模型。旧 `codex-text-v1`、`codex-vision-text-v1` 保留已有任务和会话兼容，不进入新模型菜单。

助手请求在接受时私下冻结 Router 会话 epoch；请求的 `correlation.conversationRef` 使用同一个 epoch，与 Router session 的会话关联一致。STUDIO 业务会话 ID 仍保存在产品任务和消息历史中。同模型成功续聊复用 epoch，换模型或上一轮失败时新建 epoch 并保留完整历史；既有 generic 会话继续使用原产品会话 ID，旧冻结请求和回执不改写。

模型描述只包含 `{providerRef,modelRef,title,version}`；原生型号和运行配置留在 Router。后续真实 DeepSeek/千问适配器登记相同能力与元数据后，沿用同一前端选择及请求协议，不预先展示未接入的供应商。

## 提示词与历史

`prompt_templates.go` 字节不变。SYSTEM/DEVELOPER、`studio-authored-1`、模板 SHA256、功能条件、USER/ASSISTANT 顺序及图片角色继续由 STUDIO 后端冻结，Router 原样接收。JSON_SCHEMA 的 TEXT 输出先按原 schema 校验，再投影为 STUDIO STRUCTURED 结果，方便剧本/分镜界面读取。

画布现有四个 `styleLibrary` 选项（电影写实、动漫插画、商业产品、时尚大片）按原 ID、标签、提示词及封面/参考 URL 登记为独立服务端目录。执行时核对目录版本与内容，再作为 USER 条件冻结；不会提升为 SYSTEM/DEVELOPER。前端保存和执行均保留预设元数据，不自动下载风格封面。实际图片输入仍要求授权 STUDIO 资产。未知隐藏预设保持501，篡改已知选项会被拒绝。

Codex 原生 structured outputs 支持的 schema 原样下发；STUDIO 原有宽松 schema 作为当前 USER 的输出要求传输，不收紧或改写。两种路径都必须通过同一原 schema 的终态校验，失败不会返回成功结果。

分镜节点将已校验的结果投影为原生分镜表；`executionOutputs`、`structuredOutput` 和 `script` 保留完整原始结果。场景及风格取生成时的冻结配置，未知结构明确提示且保留原文。刷新可只读恢复已完成任务，不重新调用模型；终态清理运行标记，保留自定义及 TEST MODE 徽标。

公司账号仅用于模型授权；用户/逻辑会话按 IPAC 身份隔离。原生 Codex thread/turn、凭据和路径留在 Router 私有存储。真实任务保留 `testMode:false`；UNKNOWN 只读核验回执，不重新生成。当前运行中的真实模型取消返回501；未开始的任务仍可取消。上下文容量/已报告 tokens 可返回，未报告用量和费用不补造；产品充值收费保持隐藏。

连续使用同一型号复用成功的会话绑定；切模型（包括 A→B→A）或前轮失败时，用新绑定注入完整 STUDIO 历史。绑定键仅冻结在私有 plan，重试和旧回执不改键，不新增业务表。Router 按 actor+实际模型隔离运行目录。

## 内部图片协议

`POST /internal/model-assets/read`，独立服务 Bearer；请求 `{subjectRef,sourceRef,sourceVersion,sha256,readGrantRef}`，`sourceVersion=sha256:<digest>`。授权检查包含用户、存活的任务/父资源、资产 READY、版本/摘要及未过期读取 grant；成功返回 PNG/JPEG/WebP 原始字节，最多10MiB。凭证错误401，不可读统一404，未配置503。固定私有网络 origin，禁止重定向和浏览器URL，不使用用户登录token。

## 部署

STUDIO `MODEL_REAL_EXECUTION_ENABLED=true` 为显式开关，默认false。图片服务 token 从 `MODEL_MEDIA_SERVICE_TOKEN_FILE` 读取。Router使用显式 `mock-codex`，独立 actor HOME、受控模型及工具关闭策略；公司 auth copy、runtime、媒体密钥都在 deployment-host 外部配置目录。STUDIO Web 继续由 `192.0.2.10:18880` 访问。

新型号目录显式配置 `ROUTER_CODEX_MODELS=gpt-5.6-sol,gpt-6-sol,gpt-6.1-sol`，Router 迁移006保留旧目录并扩展模型隔离键。原 `ROUTER_CODEX_MODEL=gpt-6.1-sol` 保持旧 profile 行为。

## 首轮真实接入验收

2026-10-06，deployment-host 真实链路通过：画布助手两轮对话及刷新后历史恢复、上传图片识别、电影写实预设下的两镜头分镜（6秒/7秒），分镜表和角色/场景/道具均能读取。SYSTEM/DEVELOPER、`studio-authored-1` 与对应模板哈希核验一致。隔离数据库回归 STUDIO 447、Router 285 项通过，Web 402 项及类型检查、构建通过。本轮测试作品、会话与上传素材使用正常业务接口清理。

## 型号选择与显示验收

2026-10-06，deployment-host 网页真实验收通过：文本节点分别选择5.6、6、6.1，私有回执对应 `gpt-5.6-sol`、`gpt-6-sol`、`gpt-6.1-sol`。助手按5.6→6→6续聊→5.6→6.1切换，均记住最初代号；同6复用原生 thread，回切5.6使用新 thread并携带历史。随后6识别三色图、6.1读取历史图片判断等宽；带图菜单只有6/6.1。七轮助手的 SYSTEM/DEVELOPER、`studio-authored-1`、模板 SHA256及原生 instruction hash一致。Frames选择5.6成功生成HTML标题卡，使用原 `studio-tv/assistant/hf` 模板。共11次真实调用成功。

修复了新模型 epoch与Router correlation不一致导致的提交前409，以及Canvas附件栏与工具栏为同级节点时的图片菜单误判。数据库及实际Router HTTP回归 PF454、Router294，Web436项通过；类型检查、主站/iframe构建、1198个原生资源校验通过。Frames图形入口、头像、紫色边框、悬停与减少动画模式，以及费用隐藏已核对。本次两项目、两会话、两图片通过业务接口清理，读取均404。

## 原生菜单与图片解析修复

2026-10-06，移除首页、助手、Frames及工具中额外插入的模型选择行。助手型号从现有 Agent 模式菜单选择；原图像/视频模型菜单继续只选择对应媒体能力。文本/剧本/分镜节点在原生菜单去重和默认初始化之前按真实输入过滤，实际型号选择同步冻结 capabilityRef/version/schema，不改原生组件与事件。

本轮四次真实调用成功：画布 Agent 选6、首页 Agent 选5.6并进入新画布、附图 Agent 选6识别三色图、图片工具栏“解析”默认6.1 vision；Router 私有回执分别为 `gpt-6-sol`、`gpt-5.6-sol`、`gpt-6-sol`、`gpt-6.1-sol`。带图 Agent 菜单仅6/6.1，Frames无新增模型行。

解析失败由旧固定代码与原生默认初始化覆盖型号、丢弃参考图引起。只对未显式选型的原隐藏解析模板及原图片连线恢复兼容；其他未知代码、已修改模板或显式不兼容选择仍拒绝。真实请求保留2628字原USER提示词（SHA256 `87531563949237a209a49f179e2be378a459b326cf3e7c62b7409f13699860ab`）、一份授权原图、SYSTEM/DEVELOPER、`studio-authored-1`及模板哈希；结果包含正向/负向提示词，刷新恢复结果不重新生成。图片/视频工具栏加入Agent按钮改为焰橙图形，原点击和动画保留。

视频目录补齐原生各级的 nodeTypeList，每个实际型号单独可选。网页验收视频级联的模式筛选、展开、文生视频选择回填通过；临时修正助手门户菜单层级及展开边界，关闭即恢复。图像/视频菜单无Codex混入，尚未接入的媒体仍明确TEST MODE。旧视频复刻作品自带的型号对象仅在渲染投影中与公开全能参考目录取交集；匹配项使用当前名字/config，不匹配项不展示，持久元数据不重写。未知选值保留为不可选状态，防止原生初始化自动换型；主动选择公开型号才更新能力版本。原生Ror菜单及nk真实初始化效果回归覆盖旧型号、旧优化配置、输入不兼容和自动覆写风险。

隔离数据库及实际Router HTTP回归 PF462、Router294项通过；前端456项、类型检查、主站/iframe构建、50项协议检查和1198个原生资源校验通过。本轮两项目、两会话、一份上传图片通过业务接口清理，读取均404。入口明细见 [native-model-entrypoints.md](native-model-entrypoints.md)，未验收项明确标注。
