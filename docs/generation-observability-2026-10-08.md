# 图片连续编辑修复与生成日志验收（2026-10-08）

部署：API `c6fc6bb`，Web `3d81875`。仅更新 STUDIO API/Web；Router、H3、数据库及 Agent Launcher 未重建。冻结的 1198 个原生界面资源校验通过。

## 分镜大师排查结论

45 个叶子操作均有原生入口、精确 sceneCode、STUDIO 提示词模板和真实 `codex-image-edit-v1` 接线。包含宫格 3、光影 16、三视图 1、画面推演 2、运镜 8、情绪 8、深度视差 1、场效 6。它们生成静态图片，运镜/视差是视觉表达，不是视频运镜或真实深度图。

修复两处共享链路问题：

1. 已生成图片的上游旧参考图被前端全部计入 quick-scene 兼容判定，导致 `MODEL_UNAVAILABLE`，尚未发起后台任务。现在以直接源节点当前图片进行判定；后台仍验证图片所有权、历史输出及完整祖先版本。
2. 原生已生成图片视图省略 `assetIds/batchOrigin/routerParameters/testMode/userPromptSnapshot` 等服务端元数据，保存后的输入比对误报 `STALE_EXECUTION_INPUT`。现在只恢复提交前已捕获且保存回执未变化的服务端元数据；源图改变、显式参数、提示词和历史选择仍受原有保护。

350 个相关 Web 测试通过，包含 45 个场景在生成图片上继续编辑的契约测试、原生构建器、保存校验与参数拒绝。Go 的执行、Agent、配置、日志与组合层相关测试通过；日志并发检查通过。隔离 PostgreSQL 实测提交后异步失败告警、失效执行者不误报、重复终态不重复告警，以及 Agent 失败与权限撤销；未运行全量回归。

## 本轮真实生成

从既有角色三视图节点 `sb_1791445125307_u0hdqq0` 的当前结果继续选择“运镜控制 → 推镜头”，两次真实调用均完成，服务端快照持久化 `finished`、独立图片节点与资产：

| 任务 | 新节点 | 资产 | 图片 | log_id |
|---|---|---|---|---|
| `tsk_9e96012ffe32432db5356953fa349d7f` | `sb_1791447351425_wywnm4r` | `ast_35b5084ebc696e7dec11eccc479bcc7f01ffa5fc282d34b8` | 1774×887 | `a2055910-9c5f-5bae-9c62-a934d0f64fec` |
| `tsk_666a7862c5a642708313d7bfd1dd1e4c` | `sb_1791447394759_3x7lf0i` | `ast_51ada272d9eac250115349739f66e9e3730e2bd40a9759cb` | 1774×887 | `6cbe6791-c038-5036-9274-4d56c9440850` |

本轮不是 45 个艺术效果逐项生成验收，其他操作保持各自已有证据口径。四个由此次诊断新建、无任务/输出/下游的空节点，经最新 revision 检查后用画布删除命令清理；保留用户原有节点和生成结果。

## 日志与飞书

沿用 g004_biz 的 Logrus 1.9.3 + file-rotatelogs 2.4.0 引擎及按日轮转/90天保留规则；接入 STUDIO 现有 slog 脱敏边界，不引入游戏工程的私有全局配置/uctx/Graylog。

- 容器：`/var/log/studio-tv/api.log`、`/var/log/studio-tv/generation.log`。
- deployment-host 持久目录：`/home/user/apps/studio-tv/var/log/studio-tv/`。
- 当日文件 `.YYYYMMDD`，固定文件名为软链接；同时保留容器标准输出。
- 字段：`log_id/request_id/task_id/project_id/node_id/execution_id/capability_ref/capability_version/scene_code/invocation_ref/stage/state/error_code/elapsed_ms/output_count`。
- 任务日志编号在重试/重启后保持稳定；接收记录关联初始 HTTP request_id，后台把任务 log_id 传给 Router。
- 覆盖画布、首页/Assistant 图片与视频、App、媒体处理/Sketch、Studio，以及 Agent 和 Agent 工具结果；包括提交拒绝、后台异步失败、可重试上游错误、持久化失败。
- 前端画布提交前拒绝通过有鉴权且校验项目编辑权限的诊断接口上报，标记 `CLIENT_PREFLIGHT`，不伪装为模型失败。已有服务端 requestId 的错误不重复上报。
- Webhook 仅保存在 deployment-host 私密文件，未提交到仓库。日志不含提示词、媒体内容、带签名链接或密钥。

飞书验收：固定验收通知获得成功 ACK；线上实际 `STALE_EXECUTION_INPUT` 报错 `log_id=5bf01289-a2ee-48ce-a3a8-c78e15df3989` 也获得 `FEISHU_ACKNOWLEDGED`。任务成功的接收/RUNNING/调用回执/SUCCEEDED 已在生成文件中核实。

告警使用现有有界异步队列与一分钟去重，发送结果可按 log_id 检索。它不是持久消息队列：断网、队列满或进程退出可能丢失通知；文件日志和任务记录是排查依据。浏览器完全离线时也无法提交诊断。
