# IPAC 接入发布与验收

日期：2026-10-04（Asia/Shanghai）。发布标签 `studio-ipac-v0.3.0`。Studio 初始接入为 `782cbd1`，最终 API 实现为 `99a6eca`，实际 Web 验收为 `beb7602`；随后仅补充发布记录。IPAC 实际运行版本为 `2332037bb0ad8b8aeb6273c23039d95bf8945800`，源码分支 `feat/studio-auth-provenance` 已推送，尚未合并 IPAC main。

## 实际登记与授权

| 对象 | 已生效配置 |
| --- | --- |
| IPAC | dev，issuer `http://studio.example.invalid`，现有 demo 环境 |
| 独立应用 | Studio TV，App ID `cli_TuXqp8mBHxh8bZ1O` |
| 应用 UUID | `01a10519-6467-7ee6-8a6e-dfdee3415f61` |
| 精确回调 | `http://localhost:18880/api/v1/auth/feishu/callback` |
| 非游戏项目 | AIGC，代号 `aigc`，UUID `01a1052c-60d7-7770-83a6-9cc311f0be04` |
| 本应用环境 | 内部，代号 `internal`，NORMAL，UUID `01a1052c-60d7-778a-851a-d4ceaf003336` |
| 项目所有者与首批管理员 | 维护者，subject `019fd67e-7bea-7ee2-8598-2420269514c1` |
| 业务角色 | Studio TV 管理员，UUID `20b10ee4-ea58-4f74-8eac-4c0f2707f2b4` |
| 唯一有效能力 | `tv.access`，使用整个工作台；该角色只含这一项能力 |

已通过 IPAC 的能力清单 Preview、Submit 和管理员审核完成登记，并在 AIGC / 内部范围给维护者配置角色。目前只有这一名成员、一个角色分配，未授权其他人员或游戏项目。早期细分能力已弃用，两个未分配的旧角色已清空能力并标记停用；本轮不按查看者、创作者等进一步拆分。

非游戏项目使用显式 `code=aigc,name=AIGC`，不占用游戏项目编号。未指定非游戏代号的旧游戏项目创建方式保持兼容。本地创作作品与 IPAC 项目分别建模；管理员仍只能访问归属本人的作品、素材。

## 真实浏览器与接口验收

使用同一个 ego-browser TaskSpace，通过 deployment-host SSH 转发访问真实服务 `http://localhost:18880/projects/`，使用真实飞书账号维护者完成以下流程；未使用测试签发方或模拟登录。

| 流程 | 结果 |
| --- | --- |
| 飞书登录与精确回跳 | 成功，显示真实账号维护者，自动选中唯一已授权的 AIGC · 内部工作空间 |
| IPAC 在线判定 | SessionStatus 校验真实飞书来源；Runtime Check 允许，EffectiveScopes 只返回 AIGC / 内部及 `tv.access` |
| 创建与保存画布 | 新建真实作品、添加原生文本节点、双击编辑并失焦提交；服务端保存至 revision 3 |
| 刷新恢复 | 刷新后会话恢复，文本节点及内容从 PostgreSQL 恢复 |
| 素材上传 | 上传真实 PNG，经过申请、文件写入、完成确认；签名 HEAD 返回 200，`Cache-Control: private, no-store` |
| 实际撤销能力 | 临时移除该角色的 `tv.access`，既有业务请求返回 `403 IPAC_PERMISSION_DENIED`，已有签名素材 GET / HEAD 也返回 403，工作空间列表为空 |
| 恢复能力 | 恢复原角色能力后，业务请求及素材 HEAD 恢复 200；没有使用本地放行规则 |
| 可见退出入口 | 点击“退出”，账号与工作空间清空并返回首页；退出前为 200 的签名素材 HEAD 随后返回 401 |
| 退出前立即编辑 | 填写原生文本编辑器后直接点击退出，未手动等待自动保存；重新登录后检查服务端 snapshot，最后一次文本已保存，revision 3 |
| 多标签退出 | 两个真实飞书回跳形成不同本地 sid；退出前两个 Bearer 均返回 200，从旧标签退出后两个均返回 401，另一标签请求后也清空账号和工作空间 |
| 再次登录 | 真实飞书回跳成功，重新显示维护者、AIGC · 内部及退出按钮 |
| 验收清理 | 本轮临时作品（包括退出保存测试）与未被画布引用的测试素材已删除；当前账号在该工作空间的作品列表为 0，未处理历史无空间资源 |

退出仅撤销本站会话，不扩展为所有 IPAC 应用退出。已通过检查并开始传输的媒体请求可以完成，已下载内容无法收回。上游故障、跨用户资源、密码来源、未知来源、过期会话等拒绝路径另由自动化测试覆盖，不将这些测试伪称为真实用户浏览器流程。

## 自动化与资源基线

| 检查 | 结果 |
| --- | --- |
| Web | 43 项测试通过；TypeScript 检查和生产构建通过，包含退出等待保存、冲突保护和异步身份清理 |
| Go 与数据库 | deployment-host 隔离 Docker PostgreSQL 测试中，29 项顶层测试和 80 项子测试通过，0 跳过；实际数据库测试均执行，包含 9 个多会话退出场景 |
| Go 静态与并发检查 | vet、race 通过 |
| 合同 | 11 项检查通过；冻结核心 v1 的 61 个路径、71 个操作未改变，认证和工作空间使用独立扩展 |
| 原生资源 | 1198 个冻结资源 SHA-256 一致；本次认证改造没有修改原生动画、编译组件或图形品牌资源 |
| 官方 SDK | `ipac-client-kit v0.1.0` 固定版本，依赖已 vendor，Docker 使用 `-mod=vendor` |
| IPAC 上游 | 全量 Go 测试、vet、合同与架构检查、构建及发布脚本测试通过；没有新增 MySQL 迁移 |

Go 最终数据库测试日志保存在 deployment-host 的 `/home/user/apps/rhtv-service/.local/rbac-test/final-logout-test.log`。测试 PostgreSQL 容器和网络已清理，没有接触正式持久卷。正常认证拒绝过期 access token，专用退出校验仅允许其可信签名用于撤销，不能用于访问资源；伪造凭据、错误签名/算法/issuer/audience/purpose、缺字段与身份不匹配均有拒绝用例。

## 部署与恢复证据

deployment-host 运行目录 `/home/user/apps/rhtv-service`，Git 远程 `deployment-host:/home/user/repos/rhtv-service.git`。Web、Go API、PostgreSQL 17 分别运行在容器中：Web 宿主回环 18880、API 回环 18881、数据库不发布宿主端口。最终 API `/readyz` 返回 database/storage ready，`/api/v1/auth/config` 返回 `configured=true`、`IPAC_FEISHU`、无不可用原因。

本次替换 API / Web，没有重建 PostgreSQL 容器（`17e001879953`），没有删除数据库或素材卷。迁移 003 已生效；历史空工作空间资源保持原样，不按同名账号或新飞书登录自动认领。

dev 的 IPAC 容器更新为 `ipac-server:studio-20261004-2332037`，`/health/ready` 返回 ok。IPAC Web、MySQL、Redis 和其余 82 个既有 dev 容器保持原容器，现有 nginx 路由未修改。来源字段扩展使用现有 Redis 记录，无 MySQL schema 变更；来源不明的旧 IPAC 会话需要重新登录。

上线前备份及保留的应用镜像：

- deployment-host：`/home/user/.config/rhtv-service/backups/20261004T041845Z`，包含数据库、素材、环境文件与版本；保留 `rhtv-service-api:before-ipac-20261004`、`rhtv-service-web:before-ipac-20261004`。
- dev：`/home/ubuntu/ipac-releases/20261004-studio-backup`，包含 IPAC MySQL 备份、环境文件及容器清单；保留此前 IPAC 镜像。
- IPAC 发布文件：`/home/ubuntu/ipac-releases/20261004-studio-2332037`，通过现有带健康检查与失败恢复的发布脚本更新。

上述私密备份和运行配置均位于 Git 外的受限目录。临时登记凭据已在验收后清理，App Secret 仅保存在 deployment-host 私密环境配置及受限备份中，不进入前端或本文。

应用回退不自动撤销数据库迁移。若 IPAC 回退至没有 SessionStatus 的版本，Studio 会拒绝访问；不得改为依据旧 amr、临时人员白名单或仅登录即放行。恢复备份前必须另行评估发布后写入的数据，不能使用 `docker compose down -v`。

## 当前入口与后续边界

当前实测入口使用已建立的 SSH 转发：`http://localhost:18880/projects/`。`127.0.0.1:4174` 是显式 preview，未代表本次接入的后端服务。

当前采用现有 IPAC demo HTTP issuer 和明确启用的本地 HTTP 开发例外。面向团队常用域名部署时，需要统一 HTTPS 入口、PUBLIC_BASE_URL、ALLOWED_ORIGINS 和 IPAC 精确回调，并关闭 HTTP 例外开关；本次没有擅自变更现有 IPAC 域名或其他应用入口。

模型供应商尚未配置：LLM、文生图、图生视频、全能参考仍为占位，本次未发起模型或计费调用。充值、支付、社区等内部版隐藏策略保留。后续可在 IPAC 中增加细分能力、成员或项目环境；本次唯一有效业务权限保持 `tv.access`。
