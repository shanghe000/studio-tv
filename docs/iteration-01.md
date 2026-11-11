# 快速迭代：第1轮

基线fb4a1bc。主agent负责需求讨论、协议决策、集成、真实验证和Git提交；执行子agent统一指定GPT-6.1 Sol、ultra。因本会话原生子agent线程数上限，Router使用原生子agent，其他任务使用同参数的独立Codex执行进程；不是用户侧独立聊天任务。

## 已敲定范围

- Studio TV与Models Router独立仓库/Go服务/数据库；原有UI、动画、图形、登录头像保持。
- IPAC飞书认证与工具tv.access；私有业务数据按稳定用户owner隔离，不增加工作空间或业务RBAC界面。
- DDD模块化后端，保留chi/pgx/PG17；不一次上线57张规划表。
- PF保留产品历史/素材；Router接模型与agent原生能力，真实推理默认关闭。Codex真实适配方案讨论中，不能用假生成结果宣称完成。
- 首页GLOBAL对话与画布CANVAS对话共享消息模型，分别独立归属；能力协议支持统计、上下文估算及费用来源。

## 任务与接缝

| 任务 | 独占文件 | 交付/验收 |
|---|---|---|
| Router最小服务与合同 | 同级studio-model-router；contracts/models-router.* | DDD分层、服务身份与可信actor证明、持久逻辑session/自然键幂等、capability清单；未知404、未实现501。双用户/双产品隔离、重启读取、nonce持久去重、容器/增量迁移 |
| PF会话历史 | internal/modules/assistant；004_assistant_core.sql | 真实创建/分页/消息读取/软删、owner与作品归属、强ETag、UUID幂等；最小迁移，不开启runs |
| 启动装配拆分 | internal/bootstrap；cmd/api/main.go；core/server.go构造接缝 | 显式认证/授权/SessionVerifier、生命周期清理、受保护模块注册；保持现有v1行为，旧构造兼容 |
| STUDIO→Router Gateway（主agent） | internal/modules/modelgateway | 应用层port与标准HTTP adapter；精确签名、nonce轮换、身份绑定、禁止凭据重定向、标准错误与数据验证；不导入厂商SDK |
| 隔离联合验证 | scripts/test-iteration-01.py；Gateway integration_test.go | deployment-host临时PG/私有network，双方完整Go测试及真实HTTP互通；源代码白名单上传，实际覆盖不得用skip掩盖，确切ID清理 |
| 集成与首页补充（主agent/下一子任务） | product注册、独立会话实施合同、GLOBAL类型 | 整合模块，新增受保护路径；机器合同与迁移一致，首页无假project，字段保持真实实现状态 |

给每个执行者的必读上下文：AGENTS.md、backend-design.md、models-router-design.md、codex-router-infra.md、domain-extension的相关schema/paths及原有Go认证/HTTP/迁移实现。按文件所有权协作；不擅自跨目录重写、提交、部署或读生产环境；主agent统一解决接缝变化。

## 推进方式

每个任务先落可验证代码，报告函数入口、变更文件、测试证据及未实现能力。主agent在一个切片测试通过后提交明确版本，再派发依赖它的下一项。没有适配器或真实运行时的调用明确返回未配置/未实现，不生产假会话消息、token费用或生成媒体。

本文件是任务范围记录；实际完成状态和测试结果写入本轮交付记录，不把派发任务等同于已完成。
