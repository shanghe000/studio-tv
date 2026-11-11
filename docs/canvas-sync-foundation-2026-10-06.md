# 画布同步基础与草稿保护

2026-10-06 开发切片。目标是让现有画布写入留下可补读的事件，并防止自动保存用新 ETag 提交旧整图。代码与验收状态见文末；没有切换线上 Router 或直接 Codex 链路。

本文保留第一轮切片的验收边界；后续有界 SSE、Web 原生增量同步和历史输入解析见 [最新实现记录](canvas-sync-and-inputs-2026-10-06.md)。

## 本轮范围

- 增加 `GET /api/v2/projects/{projectId}/live-snapshot`，一致读取完整持久图、graphRevision、updatedAt 与 eventCursor。该图是已授权的持久文档，不是模型提示词，也不是可信任务状态。
- 增加 `GET /api/v2/projects/{projectId}/events?after=0&limit=100`，有限 JSON 分页补读。每次请求重新认证、校验 `tv.access` 和 owner。游标使用十进制字符串，不能转成 JavaScript Number。
- 现有 typed commands 继续原子写入 `canvas.changed`。旧整图保存、项目移动及删除等图/修订变更通过数据库事务写入 `canvas.invalidated`，使旧入口不会跳过事件。
- 自动保存绑定已确认的图版本与本地编辑来源，按节点/字段合并独立修改；冲突保留本地草稿并暂停提交，不能简单换成新 ETag 重试旧整图。

独立机器合同是 [canvas-sync-implemented-extension](../contracts/canvas-sync-implemented-extension.json)。冻结 v1 合同不改；完整 [Agent 设计合同](../contracts/agent-canvas-extension.json) 仍为 DESIGN / RESERVED。

## 事件语义与边界

live-snapshot 的 eventCursor 与 graphRevision 来自同一数据库快照。客户端先读快照，再从该 eventCursor 补读，避免两次读取之间漏掉写入。分页中的 `nextCursor` 是最后返回的序号（空页为请求的 after）；`eventCursor` 是该次一致读取的流末端，未读完分页时不能直接用它作为已消费游标。

旧整图写入发 `LEGACY_GRAPH_WRITE` invalidation；只推进修订的移动发 `REVISION_ONLY`；删除发 `PROJECT_DELETED`。删除后读接口返回404，不提供绕过对象存活检查的 tombstone 读取。迁移前仅已有 commands 事件，历史旧整图写入不补造；同步必须从当前一致快照开始。

重命名、封面与置顶目前不递增项目 revision；本轮保留其既有行为，不把这些仅元数据写入计作图事件。没有事件保留期或清理机制，不能声称已实现游标过期410。项目事件及命令回执保持 append-only。

本轮**没有** SSE、原生 Web 事件订阅/远端图自动应用、服务端 node execution projection、后台生成产物回写或 Agent 工具循环。显式 SSE 请求得到不可用响应；`nodeStates=[]` 与 `nodeExecutionAvailable=false` 如实表达尚无服务端节点状态投影，`toolExecutionAvailable=false` 不变。旧 graph 中客户端写入的 status/taskId/output 不可作为可信执行证据。

草稿保护与三方合并运行在自有存储适配层；本轮没有增加原生菜单或冲突解决面板。冲突草稿保存在当前页面内存，未实现浏览器刷新后的离线草稿恢复。后续 Web 订阅接入仍需验证远端变更批量应用、抑制自动保存回声、媒体加载、焦点和光标保持，不能仅更新缓存 ETag。

旧 v1 整图和封面素材校验同步补上来源项目未删除的条件，与 commands 路径保持一致。本人已删除作品下的素材不能再作为这些入口的新引用。

## 原站研究转成 STUDIO 契约的决定

依据 [功能研究](runninghub-canvas-functional-reference-2026-10-06.md)、[7轮访谈](runninghub-agent-interview-2026-10-06.md) 与 [覆盖记录](runninghub-docs-coverage-2026-10-06.md)，保持以下区分：

| 主题 | 本轮保持的已实现行为 | 下一版需要明确的契约 |
| --- | --- | --- |
| 节点与功能 | commands v1 仅普通 text/image/video；title/text/prompt、位置、删除及空端口连线 | 节点类型、功能 subtype 和 capability 分开；特殊节点逐项增加 schema |
| 素材与连线 | 连线表达依赖，不宣称支持任意条件端口 | 输入引用冻结 sourceNodeId、选中 output/execution、asset/content version、modality、role、order、required，并逐项鉴权 |
| 媒体顺序 | 原站 order 是排序，不是过滤；拓扑顺序另算 | STUDIO 执行器目前没有完整消费 imageOrder/videoOrder/audioOrder；禁止依赖 Go map 递归顺序决定模型输入 |
| 历史输出 | 原站下游可以使用上游所选历史产物 | STUDIO 需要解析 selectedHistoryOutputId，校验未删除、已完成且归属正确的输出，冻结引用；不能把节点里全部历史素材一起传入 |
| 首尾帧 | 当前已验收能力按现有限制执行 | 首/尾应按有效输入角色与确定性排序解析，不能推广为任意多图输入都适用 |
| 提示词 | 保留当前功能 SYSTEM/DEVELOPER PromptSpec、版本和哈希 | 原站可见拼接为自身→父文本→预设；STUDIO 当前祖先扫描不同，需单独版本化改动与测试，不能虚构冲突优先级 |
| 执行状态 | task/history 才是服务端证据 | 输入 fingerprint、节点 incarnation、active execution binding 与核实产物共同控制服务端回写 |

因此没有为接入通用模型开放 mask、骨架、动作迁移、超分或全能参考的假能力。创建幂等也不等于生成去重或结果缓存。

## 验证记录

数据库验收使用已有 deployment-host 临时独立测试栈：两个隔离 PostgreSQL、内部网络、显式 mock 模型适配器，不发布端口，不读取或更改线上数据库、配置和模型登录目录。mock 成功不代表真实生成模型验收。

| 检查 | 结果 |
| --- | --- |
| 最终隔离 STUDIO 全量 Go/PG/HTTP 联合回归 | 622 个测试/子例 PASS，0 fail、0 test skip |
| 同栈 Router 全量回归 | 354 个测试/子例 PASS，0 fail、0 test skip |
| 新增数据库必测 | 4 个顶层用例全部 PASS：legacy/commands/organization 原子事件、并发一致读取、事件字节限制、旧入口来源素材删除保护 |
| 测试环境清理 | 无清理错误 |
| 前端全量回归 | 41个测试文件、626项 PASS；比此前590项增加36项草稿、排序、模型绑定与保存等待回归 |
| Web service 构建 | TypeScript检查、Vite及frame runtime构建全部 PASS |
| 合同 | 冻结合同校验与56项扩展合同测试 PASS |
| 静态检查与资源基线 | Go vet、git diff --check PASS；1198个冻结原生资源验证通过 |

最终数据库证据：`.local/iteration-01/20261006T195404-a433659c5f90/summary.json`。源码归档 SHA-256：`92405bedfea2d3b140fec4b5c1863792702a24de3b7b6be46fb122beee7a7b55`。43 个 STUDIO 与12个 Router 有测试包通过；summary 中无测试文件的 package skip 不表示测试被跳过。

此前 `.local/iteration-01/20261006T195102-d15886cae818` 有1个新增大事件测试失败：测试样本本身超过已有1MiB graph限制，未进入预期事件退化分支。修正为合法上限 graph，并补充实际 JSON 转义后的事件大小限制后得到上述最终通过结果。

前端最终记录在 `.local/canvas-sync-foundation/web-final.log`、`build-final.log`、`contracts-final.log`。覆盖旧队列遇上远端新增、连续本地输入、相同字段/删除冲突、组内位置与排序、素材准备期间刷新、重命名/置顶期间并发、迟到快照与已删除项目、模型精确版本及旧回包、失败重试与有界草稿，以及保存预校验失败阻断后续执行。仅有已知 ETag、首个完整快照尚未到达的兼容入口，也验证了同修订保留本地内容、较新修订暂停写入。

这些是适配层和实际冻结序列化代码的自动回归，不替代浏览器实时多标签验收。由于本轮没有启用订阅，未宣称 Agent 修改已能自动显示到打开的原生画布。

本轮尚未 commit/push/deploy；线上仍是原有 STUDIO→Router→Codex 链路。本轮没有浏览器上线验收或真实模型调用。
