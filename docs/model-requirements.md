# Studio TV 模型能力需求

2026-10-05。按现有首页、画布按钮和[原站接口分析](runninghub-canvas-api.md)整理。这里定义产品需要的能力，不选择模型厂商或承诺运行时可用。具体参数必须来自 Router 的能力版本 schema；不复制原站 modelCode、密钥、价格或SKU。

## 能力清单

| 优先级 | 能力 kind | Studio TV 功能 | 输入 → 输出 |
|---|---|---|---|
| P0 | LLM | 首页/画布多轮对话、剧本、分镜规划、优化提示词、图片风格及提示词反推、媒体分析、歌词 | 文字及经授权图片/视频 → 文字/结构化结果 |
| P0 | TEXT_TO_IMAGE | 角色、场景、分镜图、文本图片节点 | 文字 → 图片 |
| P0 | IMAGE_TO_IMAGE | 参考图、人物风格一致性、三视图、分镜预设、全景、画板生成 | 文字+一张/多张图片 → 图片 |
| P0 | TEXT_TO_VIDEO | 文本视频节点 | 文字 → 视频 |
| P0 | IMAGE_TO_VIDEO | 单图、首帧、首尾帧生成 | 文字+图片及参考角色 → 视频 |
| P0 | OMNI_REFERENCE | 图片/视频/音频全能参考 | 文字+多模态素材 → 视频 |
| P1 | IMAGE_EDIT | 局部重绘、擦除、扩图 | 图片+可选蒙版、区域、提示词 → 图片 |
| P1 | IMAGE_CUTOUT | 抠图、去文字、元素抠图 | 图片+可选描述 → 透明/处理图片 |
| P1 | IMAGE_LAYER_DECOMPOSITION | 编辑元素与图层拆分 | 图片 → 多张图层+顺序/元素信息 |
| P1 | IMAGE_ENHANCE | 图像放大、高清与修复 | 图片+尺寸/倍率 → 图片 |
| P1 | IMAGE_VARIATION | 多角度相机、多角度照明 | 图片+角度/光照 → 图片 |
| P1 | VIDEO_TO_VIDEO | 编辑生成、续写、动作迁移、片段重拍生成阶段 | 视频+可选图片/音频/提示词 → 视频 |
| P1 | VIDEO_ENHANCE | 视频放大、修复、增强、降噪/补帧、去水印字幕模糊 | 视频+目标参数 → 视频 |
| P1 | TEXT_TO_AUDIO | 配音与音色/说话参数 | 文字 → 音频 |
| P1 | TEXT_TO_MUSIC | 音乐与歌词歌曲 | 提示词/歌词 → 音频 |
| P1 | AUDIO_TO_AUDIO | 参考音频生成 | 文字+音频 → 音频 |
| P1 | AUDIO_SEPARATION | 全部音频、人声、环境音分离 | 视频/音频 → 一段/多段音频 |
| P2 | VIDEO_DEPTH | 视频深度转换 | 视频 → 深度视频 |
| P2 | GENERATE_3D_MODEL | 文本/图片/多视图生成3D模型 | 文字/图片 → GLB等文件与预览图 |
| P2 | GENERATE_3D_WORLD | 文本/图片/视频生成3D世界 | 多模态素材 → 世界资源与预览图 |

20项是需求分组，不是20个已部署模型。一个后端可以满足多项需求，同一项也可由不同版本的能力满足。IMAGE_TO_VIDEO 的首尾帧、OMNI_REFERENCE 的角色/风格/动作、IMAGE_EDIT 的蒙版均是受约束输入角色/参数，不新增任意URL入口。蒙版按图片素材传入；角色库、场景库和音色库本身是产品数据功能，不冒充模型能力。

P0表示首批接通重点；P1/P2在对应真实适配器验证后开放。原站未返回配置的降噪/补帧等按钮在此仅作为需求，不能宣称可运行。具体模型可用性由 Router 给出 available/reason 和输入输出/参数约束；不按框架名字推断全部支持。

## 不需要模型的功能

画布移动/缩放/小地图、上传、历史切换、复制/下载、图库CRUD和普通本地编辑不调用模型。裁剪、旋转、镜像、网格切图、速度/倒放、切段/拼接、媒体压缩可用浏览器或FFmpeg处理；OpenCut导出和3D查看器属于编辑/预览能力。片段重拍需要“切段 → 模型生成 → 拼接”的组合任务。全能参考/图层拆分等不能用同名媒体工具假装完成。

## STUDIO 与 Router 分工

PF保存本人作品、对话与消息、生成输入快照、业务任务/结果和长期素材；Router封装 vLLM-Omni、SGLang、自部署服务、厂商API与Agent，返回统一调用、事件、产物与技术计量。用户身份来自IPAC飞书登录与tv.access，历史以稳定owner隔离，不增加工作空间界面。

生成输入包括能力ref/version、parameterSchemaVersion、prompt/结构化输入、授权asset版本/摘要、参数和可选会话。宽高、时长、帧率、数量、seed、区域/蒙版、参考角色、输出格式仅在对应版本声明时接受。结果使用TEXT/STRUCTURED/ARTIFACT，文件校验并导入PF长期Asset后才作为可用结果；不永久保存厂商下载URL。

公司内部版没有充值、钱包扣减、会员资格、报价确认或订单支付流程。产品生成不依赖price、skuId、余额、付费额度。保留 token、上下文、图片数量、视频秒数等运行信息；Router的供应商成本可供运维核算，不能变成PF用户充值账单。

## 本轮实施边界

- `GET /api/v2/model-requirements` 返回本文件对应的产品需求列表。
- `GET /api/v2/model-capabilities?kind=LLM&limit=100` 通过可信owner查询真实Router目录，后续用返回的cursor分页；未配置501，不用需求列表或原站目录替代运行时模型。
- 会话详情/文本消息写入、角色/场景私人图库CRUD与分页由对应DDD模块提供；实际范围以各实施合同为准。
- 产品任务账本、事件、取消、产物校验导入和画布DAG已实施；20类能力经独立Router进行明确TEST MODE测试。当前不产生真实模型推理，测试产物不冒充正式生成，技术计量未知保持null。

Go继续使用chi/pgx/PostgreSQL17，domain/application与HTTP/DB/provider解耦；本轮不换框架。机器接口见[模型查询扩展](../contracts/model-product-extension.yaml)，图库和会话合同独立于冻结核心v1。
