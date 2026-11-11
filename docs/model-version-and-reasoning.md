# 模型精确版本与推理强度

最新目录继续只发布当前版本。已保存的作品和已接受的任务按各自明确的 capabilityRef、capabilityVersion 和 parameterSchemaVersion 执行，不因目录更新而升级，也不以当前 schema 重新解释旧回执。

## 推理参数

五个 Codex 文本/图片理解公开型号沿用原 ref，当前能力及参数 schema 版本为 2。canonical 参数为 reasoningEffort，合法值 low/high，默认 low。Router 每轮实际向原生模型传递该值，推理强度变化不改变同型号、同能力版本的会话身份。

STUDIO 将这个字段投影为原生目录字段 reasoning_effort，使用原有参数面板的 list 控件，标题“推理强度”、选项 Low/High。原目录缓存虽然已有同名参数，但 display=false 会隐藏入口，原生 MCe 还会恢复隐藏默认值；本轮按用户要求显式 display:true。这是原面板内新增可见参数，不是全局额外一行，也不修改四种工作模式或原生模型菜单。

请求投影仅输出对应 schema 广告的参数。用户在原面板选的新值优先于上一次运行保存的 routerParameters 值；非法类型或值拒绝。温度和 token 上限没有真实 Router schema，本轮不声称已经映射。

能力版本 1 仍接受原始空参数对象。保存的版本 1 节点不展示版本 2 的推理控件；编辑同型号的提示词或参数不会更改版本。明确改选另一当前目录型号才绑定其版本 2。旧请求、历史和模板正文/哈希保持不变。

## 原生画布版本保留

冻结的原生 `oL → wct → D1n/L1n` 只保留其白名单字段，包含 `modelCode/params/taskId`，会丢弃 STUDIO 的顶层能力版本字段。STUDIO 自有存储层从完整服务端快照建立按作品、节点 ID、节点类型和当前公开 modelCode 匹配的版本绑定。原生参数菜单、保存和执行在副本上补回绑定；不修改冻结资源或用户输入，也不把内部元数据放进原生参数控件。新型号的明确选择会更新绑定，删除节点清除绑定，退出登录清空全部绑定。

若旧快照已经丢失版本，但节点仍有任务 ID，则加载时读取当前身份可见的任务，限定同作品、唯一同节点计划、同公开型号，再查询精确版本 metadata 恢复 schemaVersion。删除的历史和不可见任务不会复活，型号已更改时不会恢复旧选择；不根据 ref 字符串的 `v1` 后缀猜能力版本。可匹配的历史计划若缺少版本或返回格式不一致，停止加载，不回落最新版。没有版本或可匹配历史证据的未绑定节点沿用当前目录默认策略。

绑定按认证 epoch 隔离，迟到的任务和精确版本响应不能写回退出后的身份。自动保存入队时冻结绑定；旧保存完成不会回滚新的选择或恢复已删除节点。渲染缓存检测原生节点/data 的原地字段变更，保持最新 params、taskId 和其他原生数据。

## 独立版本查询

新增 GET /api/v2/model-capability-version?ref=...&version=...，协议见 [独立扩展](../contracts/capability-versions-extension.json)。响应 data 为原有公开 Capability 结构，带精确 schema 和真实 availability，Cache-Control: no-store。需要飞书身份和每请求 tv.access；浏览器不能提供 Router 身份或上游配置。

STUDIO Gateway 使用 Router 的独立 GET /extensions/capability-versions/v1/capability?ref=...&version=...，查询参数分别编码，支持包含斜杠的公开 ref。未知版本 404，额外/重复/错误查询或 body 400，配置缺失 501，上游故障或返回版本不一致 503。未找到时不会选择其他型号或最新版本。

Web 仅为明确旧版本读取精确 metadata；默认和当前版本仍用正常目录。Canvas/Assistant 对明确旧版本按该 schema 校验。worker 在尚未提交的冻结请求上回查精确版本、schemaVersion 和参数；已有上游回执继续原轮询/恢复路径，不重新选目录。版本 1 回放仍使用原请求，不增加 reasoningEffort。

## 验证边界

自动回归运行实际冻结 `oL` 来复现字段丢失，覆盖旧版本重载、保存、原菜单和请求仍为版本 1 空参数，以及明确改型的版本 2 High。另覆盖 native Low/High 投影、文本/剧本/实际图片参数冻结、历史计划恢复、版本/类型/作品不匹配、删除再建同 ID、缓存原地变更、旧队列和响应迟到后的认证取消。原生编译资源和 v1 合同没有修改。

2026-10-06 部署后已在原生网页面板实际点击 High→Low，均成功回填；STUDIO 冻结参数和 Router 原生记录确认每轮分别发送 high、low。另将真实版本 1 节点通过原生编辑、保存和重载后继续生成，确认仍为版本 1、空参数，且不发送 effort override。原生曾丢失顶层版本的节点，也已通过本人同作品历史计划恢复版本 2 并保存。真实图片与画板验收见 [图片能力核对](image-capability-integration.md#部署与真实验收)。
