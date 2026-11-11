# 生成失败告警操作人（2026-10-26）

生成失败通知新增独立的“操作人”“用户ID”字段。`api.log` 与 `generation.log` 的所有生成生命周期记录新增 `actor_id`，告警记录同时写入 `actor_name`；原有日志ID、任务、节点、模型与错误码继续保留。

- 画布、Assistant、App、媒体、Sketch、Studio 使用任务已持久化的 `InitiatedBy`；旧任务缺失该字段时沿用原有 owner 回退。共享项目按点击生成的成员归属。
- Agent 与工具执行使用运行记录的发起人；前端生成预检查诊断使用已验证的登录身份，不接受浏览器提交的姓名或用户ID。
- 仅告警时查询 Studio TV 本地用户表，最长 250ms，不额外调用 IPAC 或飞书。普通生命周期日志不新增姓名查询。
- 查询失败保留用户ID及原错误，显示“姓名暂不可用”；完全没有身份时显示“未知操作人”。姓名是告警时的资料名称，不是历史快照。
- 中文姓名保留，换行与控制字符清理，长度最多80个字符；不把姓名、用户ID加入 metrics 标签。

验证覆盖通知内容、文件日志、去重、姓名查询异常/超时、已取消的请求，以及共享项目发起人经数据库重载后的后台失败告警。没有发起实际模型生成。

## 发布与验证

- API 版本 `e7d5874` 已部署 deployment-host；发布前生成与 Agent 活跃任务数为0，发布后 API 健康检查通过。
- 本地 observability、bootstrap、execution/agentrun PostgreSQL adapter 的单元与并发检查通过。
- deployment-host 独立 PostgreSQL 容器实测 `TestGenerationLogAfterCommitAndAsyncFailure` 与 `TestPostgresCollaborativeExecutionActorReadWriteAndRevocation` 通过；覆盖事务提交、协作者重载、失效执行者和重复终态。测试数据库与容器已清理。
- 飞书消息格式在本地 HTTP 接收器校验，未向正式群补发旧失败或测试消息；新产生的生成失败告警开始带操作人字段。
- 发布仅重建 API；其余容器ID、服务器原有未提交修改保持不变。旧镜像保留为 `studio-tv-api:before-actor-log-e7d5874`。
