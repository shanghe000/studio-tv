# 第3轮：产品接口、独立 Router 与原生前端接入

2026-10-05。当前内部版已将下表中的产品操作接入 Go/DDD 模块和 PostgreSQL 持久数据；原生前端通过自有适配层使用这些接口。模型能力由独立 Models Router 提供，当前明确启用 TEST MODE。实现、自动测试和实际浏览器验收分别记录；本记录不代表原站全部高级按钮已实现。

## 产品与模型边界

浏览器只调用 Studio TV。STUDIO Go API 处理 IPAC 身份、本人项目与资源、对话、任务、历史和结果素材。每个受保护请求实时核验 IPAC 会话与 `tv.access`，私有资源再核验拥有者；产品界面不引入 IPAC workspace、角色或权限管理。

Models Router 是独立服务，使用独立 PostgreSQL。STUDIO 通过服务凭据及签名身份提交模型请求，Router 凭据不进入浏览器。模型产物经摘要、MIME 与实际字节校验后导入 STUDIO 的持久素材。

| 功能 | 已实现的产品操作 | 模型边界 |
| --- | --- | --- |
| 项目、项目文件夹、移动、画布保存 | 实际项目/成员关系/JSONB 快照；版本前置条件、幂等事务、刷新恢复 | 无模型调用 |
| 上传、素材库、角色/场景、素材文件夹、节点收藏 | 实际文件字节与拥有者素材；分页、引用约束、版本化编辑 | 无模型调用 |
| 角色目录、应用、提示词、技能、工作流、导演资源 | 服务器目录导入；私有内容、收藏、使用记录、分类持久化 | 目录或媒体缺失保留真实空页/失败 |
| 对话、附件、技能快照、单轮/消息删除 | 本人持久会话、消息与事件；删除不复活；刷新恢复当前任务 | LLM 经 Router；未知计量为 `null` |
| 单节点、分组、整画布执行 | 实际 DAG 任务、事件、结果历史；上游产物关联、取消、重复请求与节点任务归属 | 当前20类能力均明确 TEST MODE |
| AI 应用表单执行 | 当前 APP 版本、实际字段与本人 READY 素材；单个任务及依赖任务形成作品记录 | 不编造缺失的原站供应商工作流 |
| 媒体裁剪、拼接、压缩、倒放、抽帧等 | 实际 FFmpeg 文件处理、可取消任务与结果入库 | 无模型调用；测试素材保留来源标记 |
| HyperFrames/Studio 文件、会话、预览、编辑、渲染 | 实际文件、事件、版本化编辑/撤销字节、签名预览、不可变渲染快照和可播放产物 | 助手经 Router；渲染使用实际 Chromium/FFmpeg |
| 偏好、标签、通知 | 本人 SQL 状态；实际任务完成产生通知与已读状态 | 无模型调用 |

原冻结核心 v1 保持不变。新增接口采用独立扩展：[执行](../contracts/execution-extension.yaml)、[资源](../contracts/resources-extension.yaml)、[素材库](../contracts/library-extension.yaml)、[媒体](../contracts/media-extension.yaml)、[组织与通知](../contracts/organization-extension.yaml)、[对话](../contracts/assistant-extension.yaml)。逐项原生请求映射、协议保留项与数据限制见 [前端接口接入说明](frontend-api-integration.md)。

Router 未配置适配器时返回真实501；当前通过 `ROUTER_ADAPTER_MODE=mock` 显式开启测试适配器。图片、视频、音频、3D及文本是有 TEST MODE 标记的测试产物，任务、取消、事件、文件导入和历史仍走实际服务与数据库。当前没有收费模型调用，也不编造 token、上下文余量或账单。真实供应商适配器需另行配置和验证。

## 内部版范围与保留协议

充值、会员、钱包、报价、社区及公开发布关闭。OpenCut 保留实际浏览器本地编辑/导出；原生动画、宠物、缩略图、导演 WebGL 与编辑器继续承担界面渲染。

客户端工具执行/回执、交互响应、技能聊天生成文件数组及自动 HF workspace-authoring 尚无完整产品协议，返回明确501。HF 文件、预览、可视编辑与渲染已实现，不将普通 LLM 回复包装成自动创建工程或工具执行成功。原站专用重拍流程及被字典关闭的 StoryCanvas 也不列为已实现功能。

已导入目录仍有内容缺口：部分角色缺实际图片；提示词、音色、导演/动画目录缺记录，部分灵感/模板媒体缺字节，应用与原站工作流关联不完整。接口接入不等于内容填充完成，缺失内容不使用预览 fixtures 或虚构素材补齐。

## 已完成的验证

隔离完整测试记录为 `.local/iteration-01/20261005T221719-58a3d10f1276/summary.json`：STUDIO **394 PASS**、Router **68 PASS**，均0失败、0测试跳过，`errors=[]`、`cleanup_errors=[]`。这组验证使用独立 PostgreSQL17、实际 Router HTTP、Chromium 和 FFmpeg，封闭网络且不发布端口，模型适配器仅为显式 mock；其临时资源已清理。该记录验证服务与工具处理，不替代原生按钮的实际浏览器验收。

最终前端全量 **24文件/375 PASS**，类型检查、service 生产构建及 diff 检查通过，原生编译基线的 **1198文件** 校验一致。终态补丁只在当前拥有任务的结果已应用且队列已刷新后释放原生 `c5` running overlay；迟到、旧任务、旧画布及退出后的结果不能释放当前状态。生成结果通过原生管理器要求的有界 `allowFields` 应用真实 output/status。frame 在 head 阶段安装网络/session 适配，DOM 就绪后安装功能策略和预览观察，避免提前读取 `document.body` 导致接入中断。

实际浏览器已证明：IPAC 维护者登录正常、本人项目列表加载；角色目录当前页20条/总415条由真实分页返回；原生文生图生成了实际 `SUCCEEDED` 任务与 PNG 测试产物；画布保存到 revision11 后刷新恢复；原生项目文件夹创建及删除均成功，临时空文件夹已删除。缺图片的目录项保持真实缺失。本节只覆盖这些已观察动作。

浏览器通过实际 `ProductClient`/`AssistantAdapter` 在同一持久 CANVAS 会话完成两轮 Router TEST MODE 调用，两个任务均 `SUCCEEDED`，PostgreSQL 历史为 USER/ASSISTANT/USER/ASSISTANT。原始回复文本可以不包含标记，适配器显示会标注 TEST MODE，任务元数据为 `testMode:true`；未知 usage/context 保持 `null`。这项验证不代表原生聊天界面已完整验收。

普通项目加载曾触发 IPAC 每请求 Argon2 校验的并发容量拒绝。STUDIO 现统一限制出站 IPAC 并发为2，每次仍执行实时会话与权限核验，未加缓存、重试或绕过鉴权。目录跳转保留 LAN 端口，嵌入页面地址规范化为尾斜杠，避免原生 Studio 目录导航失效。

原生 Studio 浏览器验收已完成：加载实际工程文件并播放1秒时间轴；检查器将位置X从0改为10，服务文件保存到revision3；撤销恢复原文件字节到revision4。真实 Chromium/FFmpeg 导出任务 `SUCCEEDED`，浏览器解码MP4为1秒、640×360、readyState4且无媒体错误；原生下载成功，原生“导入到画布”创建了实际VIDEO素材及 `rh-video` 节点，画布revision16刷新后仍存在。播放器从最近所属DOM/ShadowRoot节点查找原生React检查器上下文；容器为UID1000配置可写HOME，修复Chromium启动失败。没有改写原生编译文件。

## 发布与清理

本次部署前已将 deployment-host 的既有 STUDIO 数据库备份到服务外私有目录。当前 STUDIO `926e506` / `studio-internal-v0.5.5`、Router `07bf2fd` / `v0.2.1-mock-internal` 已部署，STUDIO API/web/PostgreSQL均健康。浏览器直接访问 `http://192.0.2.10:18880/projects/`，不依赖SSH隧道。内部版旧短信登录/支付初始化请求明确 `FEATURE_DISABLED`；渲染历史用真实时间戳投影，失败记录保留真实错误。

浏览器验收的临时空文件夹、普通项目、HF工程、会话、两条渲染记录、三条生成历史、五个素材及七条任务通知均通过实际产品接口删除，全部200；会话/HF工程/渲染记录复查404。保留确定性共享素材库及服务审计记录。清理后全局原有普通项目3个、素材10个；项目ID/版本/画布摘要集合 `7c819771b229fca95646def70e4600ba`，素材ID/字节摘要集合 `d01e6f578239fcc19774ca90d305fe3d`，与验收前一致。
