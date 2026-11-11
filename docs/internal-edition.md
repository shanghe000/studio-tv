# Studio TV 公司内部版

本版本面向公司内部创作，界面不展示充值、钱包或 RH 币余额、会员订阅、套餐管理、订单支付、价格与按 Token 计费提示。生成、运行、取消生成、编辑和导出操作保留；Token 用量与上下文统计继续展示。内部使用并不表示供应商推理免费，供应商费用及内部资源预算应由后续服务端接入另行管理。

## 配置与服务端边界（IMPLEMENTED）

- `RHTV_EDITION` 默认 `internal`。Go 配置解析和前端 `resolveFeatures` 在内部版强制 `billing=false`，旧 `FEATURE_BILLING=true`、`VITE_FEATURE_BILLING=true` 或运行时 `features.billing=true` 均不能重新开启。配置仍校验布尔值是否合法。
- HTTP 路由守卫同时检查版型；即使调用方直接构造 `Config{Edition:"internal", Features:...}` 并打开 billing，收费路径仍返回 `403 FEATURE_DISABLED`。未设置版型的程序化配置也按内部版拒绝收费。未知路径保持 404。
- `/api/v1/wallet`、`/wallet/entries`、`/membership`、`/catalog/products`、`/orders` 及订单明细、checkout、cancel、`/billing/webhooks/{provider}` 均被屏蔽。`catalog/products` 是充值/会员商品协议，与创作模型能力目录不同。
- 冻结合同中 `POST /api/v1/generation-quotes`、`GET /api/v1/generation-quotes/{quoteId}`、`POST /api/v1/generations/{generationId}/quote` 和报价确认 `POST /api/v1/generations/{generationId}/confirm` 在内部版同样返回 `403 FEATURE_DISABLED`。前端还拦截旧 `/api/v1/generations/quote` 别名；服务器未注册这个别名，保持 404。
- 前端同样阻止原生 `/pay/*`、`/api/product/*`、`/api/member/*`、钱包/会员相关 `/uc/*`，以及 `/canvas/price/*`、`/api/area/price/*`、`/api/workflow/webapp-price-estimate` 和 `/api/balanceAlert/*` 请求。`/vip-rights/*` 等直接路由显示功能未启用。
- 外部版可另行配置 billing，但目前这些收费接口仍是 501 预留协议；打开开关不会实现收费。

## 原生界面适配（IMPLEMENTED）

现有入口只加载冻结的 `project/assets` 组件；自有 `src/features/billing-ui.ts` 定义精准收费显示选择器，覆盖顶部和账户菜单余额/会员卡、支付/订阅/套餐弹窗及遮罩、首页价格、画布生成价格和浮层、Agent 输入旁价格、导演识别收费提示、草图钱包/单次价格、分镜批量生成价格和模型会员徽标。动态新增或重用控件、语言切换后的文本也重新检查；无需改写冻结编译资源。

选择器仅作用于 `body[data-rhtv-billing="false"]`，不隐藏 `.generate-action-button`、`.run-price-btn`、`.ap-send-btn`、`.sketch-studio__send`、各批量生成按钮或它们的容器。运行按钮里的 `is-placeholder` 和 `run-price-btn__action-text` 操作文字保留。不使用笼统的 `token`、`price`、`member` 类名或任意文本扫描规则，因此用量/上下文和作品文本仍可显示。

认证、飞书登录、身份、工具级 `tv.access` 与 owner 数据隔离不变；未新增工作空间或权限 UI。冻结 Auth DTO 的 `user.wallet`、`memberships` 和 `teamIds` 字段保留现有兼容空值，不作为真实余额、会员资格或内部权限来源。

2026-10-07 起，画布右上角头像旁的 Hyper Frame 入口暂时隐藏。自有前端使用精准的 `button.hyperframes-btn` 样式，在原生组件挂载前安装，并覆盖异步重挂载；头像、语言和其他画布操作继续显示。既有编辑器模块与嵌入播放器保留，固定独立编辑器外壳须经过 [登录前置门禁](ipac-integration.md) 才执行原生入口。

## 原生生成接入仍需处理（RESERVED）

这一补丁只移除收费入口和显示，没有实现真实推理，也不以虚假免费报价驱动原生生成。冻结原生组件内仍有以下依赖，接入时需要正式的内部版生成适配：

| 现有字段/流程 | 后续处理 |
| --- | --- |
| 用户 `walletInfo.balance`、`balance`、`memberInfo`；模型的 `personalMember`、`teamMember`、会员时段 | 原生生成前余额/会员校验不能决定内部版是否可生成。真实模型可用性和资源限制由服务端判定，不给用户补造余额、会员或席位。 |
| SKU `skuId`、报价 `totalPrice`、`currency`、`estimatePrice`、`avgAmount`、`unitPaidPrice`、`paidQuantity` | 从内部任务与模型能力协议解耦这些价格依赖；不能以 0 元或成功的空报价作为占位。 |
| `freeLimit`、`freeLimitCount`、价格加载/不可用状态 | 不将免费额度或价格服务状态伪装成推理可用性；生成操作需接入真实任务状态和明确不可用原因。 |
| LLM SKU 单价与分层价格、`pricing`/价格因子 | 不渲染消费者计费说明；保留实际输入/输出 Token、上下文和资源用量，供应商费用按内部服务端策略记录。 |
| 冻结 v1 `GenerationQuote.maximumCost`、`lineItems`、`pricingVersion`、`chargingPolicy`；任务 `confirmationQuote`、`billing` | v1 协议暂不改动。内部版真正执行前需独立扩展与适配，并明确任务确认/资源预算语义，不能伪造免费 quote 或跳过服务端约束。 |

内部版的报价与报价确认路径为403；直接 `POST /api/v1/generations` 保留生成主体，继续返回 `501 MODEL_PROVIDER_NOT_CONFIGURED` 和“模型供应商尚未配置，未执行生成。”。外部版即使打开 billing，生成与报价仍为501。没有编造免费quote或执行模型。

## 本地验证

前端功能策略测试覆盖内部billing覆盖无效、原生收费估价/余额预警及报价确认请求拦截、收费路由与控件、生成和Token/上下文标签保留；前端类型检查通过。Go config/core测试覆盖内部/外部版配置组合、直接构造配置不能绕过所有已登记收费路由、收费请求不进入认证/业务处理、直接生成预留接口保持501、未知billing/quote路径保持404。原生资源和冻结v1合同未修改。

已随 `studio-internal-v0.4.1` 发布deployment-host。ego-browser实测账户菜单中的中文“余额预警”后补齐中英文匹配，复查不可见；用户姓名/头像、新建和生成按钮、既有画布可加载。接口守卫与既有数据一致性验证见[第2轮发布记录](iteration-02-result.md)。本轮没有接入原生生成或验证真实模型输出。


## 2026-10-08：暂停入口与收费显示补漏

用户要求暂时关闭技能、插件和画布工作流入口。`src/features/paused-entries.ts` 对本站 `/projects/skill`、`/projects/plugin` 导航、`data-toolbar-icon="workflow"` 画布按钮和 Agent 技能书入口显示灰色并标注“暂未开放”；鼠标、回车/空格、中键点击均拦截。保留项目、资产、画板与生成等相邻按钮，不按任意“技能/工作流”文字匹配，不改资源库数据或后端接口。已有工作流分组和画布内容不删除。此为前端入口暂停，不宣称后端服务被关停。

对冻结 SketchStudio、Director、CanvasEditor 与主包的收费控件来源及样式进行检查，补齐草图预览 `sketch-studio__preview-empty-free` 的“限时免费”、模型促销徽标，以及独立价格、货币图标、免费次数、提示词价格占位的隐藏。现有钱包、充值、会员、价格浮层/弹窗隐藏规则继续生效。仅在 billing=false 时隐藏明确的收费叶子节点，不全局删除文字；作品、提示词里用户填写的“免费、会员、积分”保留。生成箭头 `run-price-btn__icon` 经查是操作图标，保留；计时、绘图、保存、截屏图标也保留。

web 发布版本 742da39。6 组相关测试共 31 项通过，TypeScript 检查通过。线上验收：首页技能/插件 opacity=0.42、aria-disabled=true，点击技能后仍在首页；画布工作流点击仅提示原因，未打开面板且节点数保持 14，画板按钮 opacity=1。实时画板“限时免费”与钱包 display=none；实时、手动两种界面可见文本中无免费/付费/充值/余额/积分/会员/计费/价格提示，手动价格 display=none，生成按钮仍显示。纯 2D 画板正常打开，工具栏、保存工程、截屏入口保留。另做截图视觉检查。此次只更新 web，未提交任何模型任务；不把界面验收当成实时绘图推理能力验收。


## 2026-10-08：首页模式与 AI 应用入口补齐

用户要求将首页未接通功能和画布 AI 应用节点置灰。web 21eb6cf 补齐首页模式菜单的视频生成、动作模仿，以及爆款复刻入口。模式菜单按冻结组件的 React mode key 区分，不按整页“视频”文字匹配；Agent、图片模式与画布 H3 视频节点保留。旧页面/恢复状态若仍选中视频或动作模仿，发送按钮也置灰，并拦截输入区 Enter 提交；切换模式、普通输入、换行及输入法组合不被阻止。

AI 应用新增入口（含共享的节点选择面板）、选择应用、应用卡片与单节点运行按钮暂停；已有 rh-ai 节点显示灰色及“暂未开放”标签，不删除数据，保留移动、删除与查看。此为界面入口策略，不关闭通用执行 API，也不宣称已接通 AI 应用。已接通的图像与 H3 节点不在这组规则中。

5 组受影响测试共 86 项通过，另对最后收窄的输入区 Enter 规则重跑 6 项测试通过，类型检查通过。未调用模型生成。本次仅更新 web；既有功能状态计数不变。

线上核验：首页 Agent/图片菜单 opacity=1，视频/动作模仿 opacity=0.42 且 aria-disabled=true；实际点击动作模仿仅提示原因，保持 Agent 模式。图片模式仍正常切换到 Codex Image，发送按钮无暂停标记。画布添加菜单仅 AI 应用置灰（文本、图片、视频仍正常）；点击 AI 应用未打开选择弹窗，节点数仍为 14。已有 AI 应用节点的运行/管理边界以定向测试覆盖，本轮未新建 AI 应用节点或提交模型任务。


## 2026-10-08：独立画布 Agent 面板补齐

web 042c94d 为独立 `.agent-chat-panel` 增加规则：首页 `home-*` 与画布 Agent `ap-*` 并非同一个组件，不能用首页验收覆盖后者。画布 Agent 的视频/动作模仿模式、视频子模式、一键复刻/爆款入口、SkillHub 置灰并拦截点击/键盘操作。SkillHub 提示等待公司内部 SkillHub 接入，未删除任何技能记录或用户数据。Agent、图像菜单与历史/新建/关闭保留。

旧状态仍在视频、动作模仿或爆款模式时，通过所属面板的真实 `chatMode/isTrendingHitMode` 判断，禁止发送按钮和输入框 Enter 提交。停止已有任务、Shift+Enter 换行、输入法组合、Escape 不被拦截；切回 Agent/图像后恢复原有按钮状态。88 项相关测试和 TypeScript 检查通过；本轮仅部署 web，不发模型任务。

线上核验：视频/动作模仿菜单、一键复刻、SkillHub 为灰色（opacity=0.42）且 aria-disabled=true，Agent/图像菜单保留正常状态；点击 SkillHub 仅提示等待内部服务接入，未打开面板。切到图像仍显示 Codex Image，发送按钮无暂停标记；切回 Agent 和关闭面板正常，画布保持 14 个节点。旧模式提交与停止按钮边界由定向测试覆盖，未提交模型任务。

## 2026-10-08：画布 Agent H3 视频开放

Web d05a85d 已解除画布 Agent 视频的总入口暂停，首帧、首尾帧和全能参考按 H3 当前能力目录展示模型、参数与素材限制；纯文生视频、动作模仿、一键复刻、SkillHub 仍不可用，首页视频仍待迁移。保留原生输入与参数界面，模型分类改为可读名称。130 项定向测试与类型检查通过，首尾帧和三类素材全能参考两个真实任务成功，回填、刷新和 MP4 元数据读取通过。详见 [接入记录](h3-video-integration.md) 与 [验收证据](agent-h3-live-acceptance.json)。
