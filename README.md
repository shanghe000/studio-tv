# studio-tv

独立脱敏源码版本，使用中性 Studio 品牌。历史截图和示例素材已移除或替换为占位素材；部署前需配置自己的地址、存储、账号与模型凭据。详见 [脱敏说明](SANITIZED-DISTRIBUTION.md)。

# Studio TV

当前功能状态与开发缺口统一维护在 [无限画布节点功能台账](docs/canvas-node-status.md)（含文本、图片、视频、音频、剧本、Agent、画板、导演及 H3 接入边界；[机器可读版本](docs/canvas-node-status.json)）。历史文档中的未配置状态不覆盖后续上线验收。

Studio TV 内部创意工作台，使用 Git 管理。前端通过 `/api/v1` 调用 Go API，新增后端功能使用 `/api/v2` 扩展；Web、API 和数据库是三个独立容器。网站采用灰紫主题、电视标志及简约图形画布伙伴；工程、仓库与部署名称为 `studio-tv`；既有登录和素材协议标识保留兼容。

品牌与颜色规范见 [Studio TV 品牌](docs/studio-brand.md)。

原生界面组件、CSS、动画和嵌入编辑器的编译资源保持冻结。可维护的 TypeScript 适配层负责接口衔接、内部版开关及画布持久化；这不是原站 React/TSX 源码的恢复。`ui-baseline-v0.1.0` 保存原界面，`service-foundation-v0.1.0` 保存上一阶段服务，`go-internal-v0.2.0` 保存上一阶段 Go 内部版。原生资源校验值见 `baseline/artifact-manifest.json`；该阶段的检查和登录限制保存在 [历史 Go 验收](docs/go-internal-verification.md)，当前认证与授权接入见 [IPAC 接入说明](docs/ipac-integration.md)。

## 工程结构

| 目录 | 用途 |
| --- | --- |
| `apps/web` | TypeScript + Vite，界面入口、API 客户端、画布编解码和内部功能开关 |
| `apps/web/public` | 冻结的原生界面与目录采样资源 |
| `apps/api-go` | Go + chi + pgx，唯一 API 服务；业务、认证及数据库迁移 |
| `contracts` | 冻结核心 v1，独立画布、统一登录、工具访问授权扩展及模型占位协议 |
| `infra` / `compose.yaml` | Nginx、Go API、PostgreSQL 容器 |
| `scripts` | 构建检查、隔离数据库测试、备份与 deployment-host 发布 |
| `tests` | 前端适配和协议检查；Go 测试在各自源码包内 |

旧 TypeScript/Fastify 后端和密码账号初始化已退出本工程的构建、运行路径，可从上一阶段 Git 标签查看。

## 当前最小服务

2026-10-05 第1轮新增显式启动装配、DDD会话模块和PF→Router Gateway。真实PG与HTTP联合验证见[第1轮交付](docs/iteration-01-result.md)。第2轮增加用户文本消息写入、私有角色/场景库管理与真实分页、产品模型需求清单和Router实际能力查询，并强制关闭内部版收费。接口见[会话](docs/assistant-api.md)、[角色/场景库](docs/library-api.md)、[模型需求](docs/model-requirements.md)及[内部版](docs/internal-edition.md)；最终验证与部署状态见[第2轮交付](docs/iteration-02-result.md)。Models Router仍为独立Go仓库与数据库，边界见[总体设计](docs/models-router-design.md)和[Codex适配方案](docs/codex-router-infra.md)。

项目列表、新建、重命名、删除、置顶；完整画布读取与保存，ETag 防止覆盖别人已保存的版本；图片、视频、音频上传与真实媒体校验，带签名的文件读取和 Range 请求，删除前检查项目引用。数据由服务端保存，服务模式不自动退回模拟数据。具体接口见 [最小 API](docs/api-minimal.md)。

统一登录使用官方 IPAC client-kit 的 OIDC 授权码流程，保留 state、nonce、PKCE、RS256 和 UserInfo 校验；登录事务与本地会话持久化到 PostgreSQL。浏览器只在内存持有 access token，刷新凭据位于 HttpOnly Cookie。身份以 IPAC issuer/subject 关联，不按邮箱合并旧密码账户。

登录与刷新通过上游 SessionStatus 实时检查真实飞书来源、sid、人员版本和期限，密码或未知来源不能冒充飞书。日常请求复用最长五分钟的会话与应用授权租约：IPAC EffectiveScopes 中任一有效 `tv.access` 授权即可使用整套 Studio TV，不再逐接口、逐素材或逐 Agent 工具调用远程 Runtime Check。同一会话并发刷新合并为一次；租约过期后必须重新验证，失败不沿用旧允许结果。每次请求仍验证本地令牌、会话撤销、账号状态及资源归属；本地退出立即生效，上游撤销最多五分钟生效。前端沿用原有页面和画布功能，不显示或选择工作空间、不请求空间列表、不传空间头。作品和素材仍按本人归属隔离，不按 IPAC 范围分区。Studio TV 使用独立中台身份，初始管理员为维护者；AIGC 是 IPAC 中的非游戏授权项目。能力清单通过 SDK Preview/Submit 后由 IPAC 管理员审核，服务启动不会自动批准。

2026-10-04 的 0.3 阶段已在 dev 部署 IPAC 来源/SessionStatus 与非游戏项目支持，在 deployment-host 发布 Studio，并完成真实飞书登录、画布保存/刷新、权限撤销/恢复及退出验收。当时按 AIGC（`aigc`）/ 内部建立工作空间，仅维护者获授 Studio TV 管理员角色及 `tv.access`；该工作空间产品设计已被用户本次要求纠正，现改为后台工具访问授权。原 [IPAC 发布验收](docs/ipac-verification.md) 保留为历史证据，不作为本次改造的验收结果。

本次代码 `8be955f` 已部署 deployment-host，数据库和存储就绪。真实首页及画布显示维护者和飞书头像，原账户菜单与退出确认保留，没有新增工作空间栏；既有用户作品完整 GET 响应在更新前后哈希一致。新建作品、原生文本编辑、退出、重新飞书登录和 revision 3 画布恢复已实测；唯一临时验收作品已清理，两条真实用户作品保留。发布标签为 `studio-ipac-v0.3.1`。完整证据见 [工具级授权发布记录](docs/ipac-tool-access-verification.md)。当前协议见 [IPAC 接入说明](docs/ipac-integration.md)、[授权边界](docs/ipac-rbac.md)。缺少配置或上游状态协议不可用时，界面明确提示，不提供模拟登录或本地授权兜底。

默认 `RHTV_EDITION=internal`：充值、会员、余额、支付、社区、营销活动、公开分享及原站服务外链隐藏，对应已知服务接口返回 `403 FEATURE_DISABLED`。内部版收费强制关闭，`FEATURE_BILLING=true` 也不能开启；其他功能仍有独立开关，未实现的操作返回501。模型运行的token、上下文与资源用量统计可以保留，不建立内部余额、订单或支付流程。

产品模型需求整理为20类，覆盖语言、图像、视频、音频及3D。`GET /api/v2/model-requirements` 返回需求；`GET /api/v2/model-capabilities` 只返回已配置Router的实际能力，无配置返回501，不把采样模型当作可执行能力。第3轮接入真实产品任务账本、Worker、持久事件、素材回收与原生前端适配，模型侧使用独立Router明确标记的TEST MODE。角色/场景、资源目录、文件夹、通知、偏好、媒体与Studio操作由真实接口持久化；实际验证与剩余边界见[第3轮记录](docs/iteration-03-result.md)。

2026-10-05 已补齐[Models Router 多模态边界](docs/models-router-multimodal-update.md)：通用适配器Observation、可选会话、影像计量/产物、进度事件及三类请求示例。该协议设计阶段未部署，随后第2轮已将PF后端及内部版屏蔽发布deployment-host；真实模型适配器仍未开启；通用执行接口已进入第3轮的显式mock测试。

## 数据库选型

PostgreSQL 17 保存项目、JSONB 画布、素材元数据、幂等键及登录会话。既有工作空间映射和 `workspace_id` 列保留原值，不再参与业务授权或数据分区；作品、素材和上传继续按 `owner_id` 隔离。沿用既有 PostgreSQL schema 和持久卷，项目保存、幂等与会话轮换使用数据库事务和锁。

文件内容保存在独立 `asset_data` 卷，数据库只保存元数据与引用。后续可切换对象存储；当前没有 Redis、消息队列或生成 Worker。正式接入异步模型任务时再增设任务表和 Worker，不把长期生成请求塞进同步 HTTP 请求。

## 本地开发与验证

需要 Go 1.26.5、Node.js 22（至少 22.12）和 Python 3.10+。Go 依赖由 `go.mod`/`go.sum` 锁定并 vendor，Docker 编译器固定版本且使用 `-mod=vendor`；前端使用 `package-lock.json`。

```sh
npm ci
npm run build
python3 -m venv .local/contract-tools
.local/contract-tools/bin/python -m pip install -r scripts/contract-requirements.txt
npm run verify
```

`npm run dev:web -- --port 4174` 默认使用服务模式。API 地址由 `RHTV_DEV_API_TARGET` 指定，默认 `http://127.0.0.1:3001`。离线预览需明确使用 `RHTV_MODE=preview`；预览数据不代表真实后端。

Go 环境配置见 `.env.example`；`DATABASE_URL` 由 Compose 注入。开发 Go 服务：`npm run dev:api`。Docker 会先执行迁移，再启动 API。源码没有个人电脑路径或私有 Go 仓库下载要求。

没有 `TEST_DATABASE_URL` 时 Go 数据库测试会明确跳过。完整数据库验证须在 Docker 主机运行 `./scripts/test-api-docker.sh`：临时 PostgreSQL 容器、独立网络、随机 schema，结束后清理，不接触正式持久卷；测试容器包含 ffprobe 用于真实媒体校验。

## deployment-host 部署

Git 远程：`deployment-host:/home/user/repos/studio-tv.git`。运行目录：`/home/user/apps/studio-tv`。环境配置：`/home/user/.config/studio-tv/server.env`，权限 600，不进 Git。IPAC App Secret 只注入 API 容器，不进入前端或代码。

```sh
./scripts/backup-deployment-host.sh
./scripts/deploy-deployment-host.sh
```

运行容器使用 `studio-tv-*`，API/migrate 二进制和自有 Go/npm 包也使用 `studiotv`。历史记录中的 `rhtv-service` 路径不重写；改名时保留旧路径兼容链接。

已有 deployment-host 部署先设置 `STUDIOTV_COMPOSE_PROJECT=rhtv-service` 保留 Compose 管理身份；容器通过 `docker rename` 改名，服务 ID 和启动时间不变，不在并行开发期间重建。管理标签、默认网络与数据卷保留旧名称，新安装默认使用 `studio-tv`。

已有部署同时必须设置 `STUDIOTV_REUSE_EXISTING_DATA=true`、`STUDIOTV_POSTGRES_VOLUME=rhtv-service_postgres_data`、`STUDIOTV_ASSET_VOLUME=rhtv-service_asset_data`；发布脚本据此加载 external 卷覆盖，既有卷不存在时直接失败，不创建空卷。新安装使用默认的 `studio-tv_*` 卷。数据库名/用户、JWT issuer/audience、Cookie、`rhtv-asset:` 和原生桥接标识沿用已有协议。改名不修改 IPAC 应用身份、权限、回调或访问地址。

三个容器独立运行：Nginx Web 在 deployment-host 的 `192.0.2.10:18880` 提供内部访问入口，并代理 `/api/v1`、`/api/v2` 与素材请求到 Go API；Go API 宿主端口 18881 仍仅回环访问；数据库仅 Compose 内网访问，不发布宿主端口。

```sh
# 同一公司内网直接访问，不需要 SSH 隧道：
# http://192.0.2.10:18880/projects/
# server.env 使用以下入口配置，其他私密配置保持原值：
WEB_BIND_IP=192.0.2.10
WEB_PORT=18880
PUBLIC_BASE_URL=http://192.0.2.10:18880
ALLOWED_ORIGINS=http://192.0.2.10:18880
IPAC_REDIRECT_URI=http://192.0.2.10:18880/api/v1/auth/feishu/callback
ALLOW_PRIVATE_HTTP=true
```

`WEB_BIND_IP` 默认仍为回环地址，deployment-host 私密环境文件明确指定内网 IP。`ALLOW_PRIVATE_HTTP` 默认关闭，只有内部版、RFC1918 字面 IPv4 地址才可开启 HTTP 例外，不允许公网 IP 或任意域名。IPAC 已登记此精确回调；原 localhost 回调保留供历史版本恢复。现有 IPAC demo HTTP 上游仍使用原来的显式开发开关，两类配置分别控制本站入口和上游协议。

入口切换后浏览器需要在新的 IP 地址登录。Web/API/数据库数据卷及用户归属不随入口变更。前端只在缺少原生能力时适配安全随机 UUID、素材 SHA-256 和文本复制，并在嵌套编辑器入口使用同一适配；不修改原生界面资源。若使用团队域名与 HTTPS，可关闭 HTTP 例外并沿用浏览器原生能力。上线验证记录见 [deployment-host 内网直连](docs/deployment-host-lan-verification.md)。

## 发布与恢复

`postgres_data` 和 `asset_data` 独立持久化，重建应用不删除数据。备份脚本把数据库、文件、环境配置及 Git 版本保存在 deployment-host 的受限目录。不能使用 `docker compose down -v`。

发布脚本仅快进 main；服务器有未提交改动会停止并保留。可传入服务发布标签回退应用，数据库迁移不会自动撤销。历史用户、项目、素材及工作空间列保留，旧密码身份不会自动变成飞书身份，也不按同名或同邮箱转移作品归属。空或既有 `workspace_id` 不再阻止真实 owner 访问其作品。回滚应用时必须保留真实身份、有效授权期限和归属隔离边界，不能降级为旧认证来源或仅登录即放行。定时备份、HTTPS 与全量模型服务是后续事项。
