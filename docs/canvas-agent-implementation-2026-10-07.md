# 画布 Agent 实现与验收记录

后续配置更新（2026-10-07）：账号来源已改为 deployment-host 普通 CLI auth.json，见 [共享登录记录](../../studio-model-router/docs/shared-cli-auth.md)；正文独立公司凭据副本为当时部署记录。H3 上游已就绪，视频节点尚未完成接入；最新功能状态见 [统一台账](canvas-node-status.md)。

2026-10-07，接续普通单节点后台保存。代码主提交 `b6c8fb5`，部署配置修正 `7eb0fa1`。当前生产为 `d866881`，Agent 已启用。隔离环境正负向工具验收通过；真实产品画布已完成创建文字与图片节点、连线、一次图片生成、自动回填和刷新恢复。首批范围与剩余限制见下文。

## 本批实现

原画布 Agent 入口使用独立的 `/agent-runs` 协议。开启后从专用 discovery 获取精确的 `codex-6-1-text-v1@2` 和参数 schema，默认 Low，可接受现有调用方明确传入的 High；不新增模式或型号控件。普通生成任务仍使用现有 Router，旧任务与历史保留。

已实现的工具为读取画布、创建/修改/移动/删除普通节点、选择精确型号、增删连线、提交单节点生成、查询及取消生成任务。生成只读取服务器画布和真实上游依赖，比较修订后冻结输入，沿用已验收的后台保存及前端同步。模型没有通用 HTTP、SQL、shell、文件或浏览器业务工具。

Agent run 固定绑定用户、父登录会话、会话、项目以及提示词和工具版本。每个会话只能有一个活动 run，不能与旧 assistant 生成重叠；运行中禁止删除会话或相关历史。工具由后端持有当前用户 Bearer 调用正式 STUDIO API，逐次复核本地身份和权限；远端 IPAC 的已验证证据按用户最新要求复用最长五分钟的应用授权租约，撤权最迟在租约到期时观察到，登录刷新强制复核。本地退出、账号禁用和资源归属仍逐次检查。Bearer 不写入模型、数据库、运行目录或日志。

工具原生调用编号、参数摘要、稳定 UUID、结果与事件持久保存。重放不重复写图或生成；写请求返回不确定的服务错误时保留待核对状态，不换键重发。数据库 JSONB 的格式变化不会破坏回执比对。历史正文中的签名链接只在模型上下文投影中脱敏，不修改用户原消息。

浏览器可恢复已登记运行、显示真实工具活动、取消并读取最终已保存回复。凭据过期时暂停新工具；同一登录会话刷新后继续，重新登录可查看和取消旧运行，但不能接管它。服务重启后要求重新提供同一会话的凭据，未知原生提交不自动发起第二轮模型调用。

## 当前限制

- 首批 Agent 对话只接收保存的纯文字历史，不接收直接上传的图片、视频、音频或结构化消息。可通过工具操作已有普通媒体节点和调用已有生成能力。
- 不包含 Ultra/子 Agent、整图/分组执行、撤销、复杂导演与批量编排。
- 默认单次十分钟、32 次工具调用、两个 Agent worker；生成 worker 独立，查询任务可有界等待。
- 公司 Codex 登录由部署人员维护，必须使用当前有效的独立凭据副本。单看 access token 的到期时间不能证明凭据仍有效。
- 视频生成等待用户交付 MiniMax H3 推理服务。优先 FL2VA 首帧/首尾帧，再独立接 Ref2VA 全能参考。

## 定向验证

遵照用户要求，本轮没有重跑未改动的 Router 全套测试。首轮受影响数据库包为 125 项通过、0 项功能失败；两项依赖隔离 Router 的原有联动测试被跳过，因此该次汇总为 FAIL，不作为最终全通过证据。补齐隔离 mock 服务后只跑这两项及其子项，共 29 项通过，0 跳过。

新 Agent 的最终 application/HTTP/executor/真实 PostgreSQL 定向运行 20 项通过；随后历史脱敏仅重跑相应一项 PostgreSQL 用例并通过。运行时另有私有协议、跨 thread/turn/tool 拒绝、完整结果核对、取消、恢复及 JSONB 回执的定向 race 检查。前端五个相关文件 92 项及类型检查通过，补充终态错误后仅复验 Agent 文件的 19 项。

前后端生产构建、两个新增/修改的扩展合同、受影响 Go 包静态检查通过；1198 个原生编译资源基线不变。

本地证据目录：

- `.local/iteration-01/20261006T235933-5b1c12549c35`：首轮定向检查，含明确的两项跳过。
- `.local/iteration-01/20261007T000148-d8ce114305ea`：补齐旧联动 29 项。
- `.local/iteration-01/20261007T000934-479191d44329`：Agent 最终 20 项。
- `.local/iteration-01/20261007T001234-4863ed765de8`：历史脱敏一项。

## 真实验收与部署

使用独立 launcher、每个会话的隔离容器、固定版本 Codex 0.160.0、只读空工作目录和专用模型出口。模型容器以 UID 11001 运行，移除全部 Linux capabilities；没有 STUDIO token、数据库配置、源码、其他用户目录或 Docker socket。启动器是唯一持有 Docker 权限的服务。

容器实测可连接指定代理，不能直连 STUDIO 私网或任意公网测试地址。持久状态采用 256 MiB 预检及两秒监控，尚非内核磁盘配额。

首次模型验收发现原公司凭据副本已被刷新链淘汰，返回 `token_invalid / refresh_token_reused`；已从可信运行配置复制较新的单个凭据文件至 STUDIO 私密目录，没有共享或修改 Router HOME。模型请求恢复后，legacy 历史验收停在 UNKNOWN。改为固定版本支持的 paginated 完整历史并通过七项定向检查后，真实 fixture 返回已完成文本，但工具计数为零，仍未通过验收。检查原生结果确认前几次内部工具分发 host 均被关闭，不能作为成功 STUDIO 回调证据。开启 host 后定位到固定版本配套二进制缺失；已增加专用只读挂载与 SHA256 校验。随后真实正向 fixture 27.30 秒通过：恰好一次 STUDIO 读取回调、完整分页历史与真实回执匹配、终态文本校验通过。随后负向 fixture 21.78 秒通过。额外检查实际执行的原生 JS 输入与输出：process/require/fetch 均为 undefined，node:fs 导入返回 unsupported import in exec，STUDIO 读取返回 revision:1；不是仅依据模型自述。当时真实产品画布闭环尚待完成；后续产品验收记录见本节末。仅模型回复完成不能证明画布操作成功。

备份：`/home/user/.config/rhtv-service/backups/20261006T161604Z`。临时验收文件位于 `/home/user/.config/rhtv-service/agent-acceptance`，不包含对外暴露的模型 RPC。

正向验收日志：`/home/user/.config/rhtv-service/agent-acceptance/live-companion.log`。启动器六项定向检查通过；此后候选 d1ed452 已发布，五个容器健康、migration 019 完成。

负向日志：`/home/user/.config/studio-tv/agent-acceptance/live-denial.log`。命名迁移后规范部署目录为 `/home/user/apps/studio-tv`、裸仓库 `/home/user/repos/studio-tv.git`、私有配置 `/home/user/.config/studio-tv`；旧路径兼容链接保留。生产发布前新备份：`/home/user/.config/studio-tv/backups/20261006T165617Z`。

产品首轮现场记录：验收项目 `prj_88febe3c-6abb-4b99-a67c-e524f36fc88a`，run `agr_080009ffcb394e8298d220c442c032ad`。画布读取、型号查询返回成功；普通文字节点操作已登记但未获得完成回执，run 如实标为 UNKNOWN。主控通过已登录正式 API 以原稳定幂等键重放，确认提交到 graphRevision 2，页面自动显示文字节点；这不计为 Agent 自动写入通过。另发现终态详情与事件页之间的竞态会漏显示最后几条工具活动，已补针对性修复；未发出图片生成。

候选 c0502c2 的第二次现场 run `agr_a1cf29fcc6684d8595bc8dbc1f82f09b`：两项读取完成后在下一工具前失败。私有日志定位到 `BROKER_WAIT_CREDENTIAL / UNAVAILABLE / ACTIVE`，排除先发生的用户取消和原生拒绝；登录尚未过期，未发出图片生成。用户随后在权限优化任务明确要求降低远端权限查询频率、扩大粒度，统一应用授权租约由该任务实现，Agent 不另设重复缓存或跳过归属校验。


最终产品生成验收（`978d82f`）：run `agr_6441dc2ce7134d6e9a6c97e8ada7b9a0` 为 SUCCEEDED，13 次工具，真实创建 `acceptance3-text` / `acceptance3-image`、连接文字到图片、选择 `codex-image-generate-v1@1`，仅发出一次图片生成。任务 `tsk_632991fb600d48a4a3254d0aacca4910` 为 SUCCEEDED，canvasBinding 为 APPLIED，产物 `ast_83929d9a93820e365f3ba0e54ad83f77b7a94745826ab1bb` 为真实 1254×1254 PNG。画布显示图形书桌图片；刷新后节点、图片与最终回复均恢复。截图：`.local/agent-acceptance/product-image-978d82f.png`。

该次运行超过九条事件时暴露 PostgreSQL 文本别名排序错误，浏览器提前报错但后台如实继续成功。`d866881` 将排序显式限定为数值源列；单条隔离 PostgreSQL 测试 1 PASS / 0 SKIP，覆盖跨 9→10 分页、终态和空页游标。生产读取上述真实运行的 31 条事件，序号连续 1…31、nextCursor=31、terminal=true。报告：`.local/iteration-01/20261007T013722-bfb4b0c33b55/studio-summary.json`。未放宽客户端严格游标校验。

权限优化合入 `978d82f`，包含最多五分钟租约、并发请求合并、到期失败关闭和本地撤销检查。相同已登录 QA 画布六次并发只读均为 200；本轮耗时 19/31/47/60/72/85 ms，修改前为 183/357/524/713/885/1040 ms。这是该样本的现场耗时，不冒充上游请求计数或全站性能承诺。更新前备份：`/home/user/.config/studio-tv/backups/20261006T173330Z`。


最终页面闭环复验（`d866881`）：同一会话继续排版，run `agr_8cd700e66cef4b3a97862f125ea7acaf` SUCCEEDED，9 次工具，三次移动均重新读取确认；原生页面直接显示已保存的成功回复，没有提前结束或通用错误。真实 22 条事件连续、nextCursor=22、terminal=true；画布 revision 13，三个位置分别为 (100,80)、(100,350)、(600,350)，一条原连线及成功图片均保留，没有提交额外图片生成。证据 `.local/agent-acceptance/product-layout-final.json`。本次额外前端修复仅跑 23 项 Agent 定向测试与 typecheck；事件排序仅跑一项真实 PostgreSQL 测试。完成后保留验收画布供用户查看。
