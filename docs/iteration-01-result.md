# 第1轮交付与验证

2026-10-05，基线fb4a1bc。执行子agent指定GPT-6.1 Sol / ultra，按独占文件并行工作；主agent整合协议、路由、实际验证及版本管理。仓库分别为rhtv-service与studio-model-router，后者Git远端deployment-host:/home/user/repos/studio-model-router.git。

## 已交付

- PF显式bootstrap负责配置、数据库迁移、IPAC认证/实时tv.access与生命周期；旧v1构造兼容，新增产品模块只能在受保护路由组装配。
- assistant分为domain/application/HTTP/Postgres。首页GLOBAL不依赖作品，画布CANVAS绑定本人有效作品；创建、分页、消息读取和软删已经真实实现。owner来自可信身份，UUID幂等、ETag、同owner FK与不可变绑定有测试。
- 004迁移只增加conversations/messages两张业务表及必要约束。57表完整蓝图仍为规划，不能叠加直接运行；没有一批空任务表。
- STUDIO ModelGateway有纯应用port与Router HTTP adapter，支持能力目录、逻辑会话创建/恢复/查询。每次签名固定actor、clientApp与原始请求，nonce轮换，禁止凭据重定向，错误脱敏；用量/上下文/费用使用nullable类型与十进制金额。
- Router独立Go DDD服务、PG数据库、Compose、vendor与固定摘要Docker构建器。当前持久sessions和防重放nonce，另有迁移账本。支持多产品服务凭据登记、两层actor作用域、逻辑会话自然键幂等和恢复；无适配器时能力目录为空。
- 实施合同分别为assistant-extension（4 IMPLEMENTED /5 RESERVED）与models-router（5 IMPLEMENTED /6 RESERVED）；JSON/YAML一致。冻结核心合同与原生资源未修改。

## 验证证据

`python3 scripts/test-iteration-01.py --run --source-stable` 在deployment-host执行。独立internal network、两台临时PG17容器、随机0600凭据文件、没有发布端口；测试源码白名单上传。PF与Router完整Go套件及真实Router HTTP调用运行完成。

| 检查 | 结果 |
|---|---|
| STUDIO Go测试（含子用例） | 226 PASS /0 FAIL /0 SKIP |
| Router Go测试（含子用例） | 21 PASS /0 FAIL /0 SKIP |
| 实际数据库 | 001..004、历史登录迁移、owner/FK/绑定/序号、并发幂等、仓储重建、GLOBAL不依赖项目、软删、nonce持久去重均通过 |
| HTTP联合 | 真实client→Router→PG；双actor同conversation隔离、跨actor404、自然键恢复、签名/nonce拒绝、真实空目录与501边界均通过 |
| 本地 | 双仓库Go race/vet通过；Linux amd64编译通过；合同验证及新增合同测试通过 |
| 原生界面资源 | 1198项hash校验通过 |
| 清理 | 自建容器、network、临时image标签、秘密文件与远程测试目录均清理，无cleanup error |

本地机器证据目录 `.local/iteration-01/20261005T171121-574e585ed134/` 含summary、逐测试JSON、日志、来源清单。归档SHA256为`0eeff1471ed30241b09d23dcc20d4d45926be80c07acf8063628e7a2e0051a96`，测试后核对源码清单无变化。无test files的Go包状态不计入“测试SKIP”。

## 尚未开启

本轮没有生产部署/迁移、UI改动或真实模型调用。ModelGateway尚未作为assistant业务运行消费者装配，产品会话Router双引用仍为NULL；没有消息追加、invocation、worker、SSE、取消、工具回执、产物导入或原生Codex绑定。预留接口明确501，不能把测试夹具当生成结果。

下一切片先确定Codex runtime作用域与能力profile，再加原生binding/单写租约、invocation幂等与不确定提交恢复、持久事件、统计归属及产品消息追加。实际adapter启用前补嵌套metadata协议校验。用量、上下文和费用方案见[codex-router-infra.md](codex-router-infra.md)；已有Codex会话IMPORT/FORK/RESUME另行受控接入。
