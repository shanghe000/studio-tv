# Studio TV 的 IPAC 认证与授权接入

本工程使用官方 `ipac-client-kit v0.1.0`，并接入 IPAC 的真实认证来源与在线 SessionStatus 扩展。前端、Go API 和 PostgreSQL 独立运行；IPAC 负责统一飞书登录及唯一应用使用权限 `tv.access`，Studio TV 内部管理项目协作者、团队成员与共享资产，见 [内部协作设计与发布记录](design/studiotv-internal-collaboration.md)。[2026-10-04 发布验收](ipac-verification.md) 和 [工具级授权发布记录](ipac-tool-access-verification.md) 保留当时的真实历史证据，不代表本次七天会话的真人验收。

## 应用与初始授权

Studio TV 是独立的 IPAC 中台应用，在非游戏 AIGC 项目中登记其内部环境。当前只登记一个能力 `tv.access`，表示可以使用整套工作台。现有作品、画布与素材操作都检查此能力；具体模型能力以服务端实际接入与配置为准，未接入功能返回 501，登录或授权测试不调用收费模型。

初始管理员为维护者。人员绑定须核对 IPAC 中的真实 subject，不能仅按名字或邮箱推断身份。IPAC 中的应用管理权与 Studio 的业务使用权分别配置；应用管理员不获得服务端跨用户作品旁路。本轮业务使用权限统一采用 `tv.access`，不提前拆分多组功能角色。

应用使用权的角色和授权范围在 IPAC 管理，Studio 不在本地复制其 RBAC 判定规则。STUDIO 项目与团队的 OWNER/EDITOR/VIEWER 为本地资源权限，不能替代 `tv.access`。IPAC `project_id + environment_id` 仅由后端获取和复核，不映射成需要用户选择的 TV 工作空间；画布作品的本地 `projects.id` 与 IPAC 项目编号含义不同。前端不请求工作空间或传递范围选择参数。详见 [授权边界](ipac-rbac.md) 和 [工具授权扩展合同](../contracts/authz-extension.json)。

## 登录与会话

入口为 `GET /api/v1/auth/feishu/login?returnTo=/projects/`。后端在 PostgreSQL 保存五分钟、单次消费的登录事务，直接进入 IPAC 的飞书登录入口，并将安全的 OIDC authorize 地址作为继续地址；完成后回到精确登记的 `/api/v1/auth/feishu/callback`。

官方 SDK 完成 Discovery、state、nonce、PKCE S256、RS256 验签、issuer、audience、有效期、subject、sid、session_version 与 UserInfo 核验。本工程不复制 SDK 的 OIDC 实现，`internal/auth/oidcrp` 仅保留类型别名及构造函数转发。SDK 固定版本和全部依赖已 vendor，容器以 `-mod=vendor` 构建，没有开发电脑路径替换或构建时私有仓库下载。来源和校验和见 [SDK 说明](../apps/api-go/internal/auth/IPAC_SDK.md)。

认证身份仅通过 `(issuer, subject)` 关联本地用户。浏览器只在内存持有十五分钟 access token；refresh 令牌放在 HttpOnly Cookie，哈希保存在 PostgreSQL。刷新须 CSRF 和合法 Origin，每次轮换。本地会话固定最长 168 小时，且不超过真实上游会话期限；刷新不移动截止，cookie 使用实际截止。旧会话不被自动延长，服务重启不丢失身份或登录事务。

多个标签同时轮换同一旧 token 时，五秒内失败方返回 `REFRESH_RACE_RETRY` 和 `Retry-After: 1`，不回任何新凭据、不清 cookie、不撤销胜出会话；前端等共享 cookie 更新后只重试一次。超窗重放仍撤销该会话。退出、停用或已过期会话不受此竞争窗口保护。冻结 v1 的十五分钟 JWT 和 `expiresIn=900` 响应保持不变，持久会话到期后 JWT 即使尚未过期也不能认证。

自有前端按 access 期限提前静默续期，在页面唤醒、恢复联网时检查续期；原生登录事件先用 HttpOnly cookie 恢复。503 保留会话并显示恢复重试，冷启动故障保留原画布路径；仅真实失效才清身份并要求飞书。一天期的 CSRF 过期会精确重新获取后有限重试，不把其他 403 当作可绕过错误。令牌和身份不写入 localStorage。

service 模式在加载原生页面和功能提示之前执行登录前置门禁。先恢复仍在七天期限内的真实会话，再用已有 `GET /api/v1/projects?page=1&pageSize=1` 检查 `tv.access`；通过后才加载首页或指定业务页面。匿名访问自动进入同源飞书登录入口，经 IPAC 认证后回到原路径和查询参数。页面片段只在当前标签的 sessionStorage 保存和恢复，不进入 OIDC 返回地址；该存储不包含令牌、用户身份或授权结果。SPA 页面切换不重新执行该启动检查。

只有明确会话失效才自动重新登录；无应用权限或账号停用显示拒绝进入，临时登录／授权故障显示恢复重试。重试先静默续期，避免短 access token 到期时误结束有效七天会话。未完成的登录使用标签内标记抑制自动循环，允许用户手动重试。主动退出后停留在登录门禁，旧业务界面不可见、不可操作；重新登录由用户触发。已准入文档发生身份清理或更换后，须完整重载再显示业务页面，避免保留旧身份界面。

固定的 OpenCut、HyperFrames 与 HyperFrames Studio 独立外壳也在门禁通过后才执行原生入口。构建仅变换这三个 dist HTML 副本；嵌入已登录 STUDIO 主页面时复用主页面真实会话，不再轮换第二份 refresh cookie。独立外壳的私有客户端不向原生外部 transport 提供 STUDIO 令牌。生成作品和签名预览文档保持原有媒体访问边界。

显式退出先保存当前画布；保存失败、冲突或仍有未保存编辑时保持登录并提示。合法 Origin 与 CSRF 下，服务端撤销共享 refresh Cookie 对应会话，以及有效本地 Bearer 签名和 subject/sid 对应的当前标签会话，不依赖上游在线；不能通过裸 sid 或伪造 Bearer 撤销其他会话。专用撤销校验允许签名可信但已过期的 access token 结束其会话，仅用于撤销；正常认证、刷新和媒体访问仍严格校验期限，不能借此认证或延长权限。退出不扩大成所有 IPAC 应用退出。退出后的迟到刷新响应不能重新接受旧身份。

## 真实飞书来源与在线状态

旧 IPAC 曾对密码登录同样签发 `amr=["feishu"]`。0.3 阶段已部署的上游补丁从成功的认证流程产生并持久化来源：飞书为 `auth_provider=feishu`、`amr=["feishu"]`，外部密码为 `external_password`、`amr=["pwd"]`；旧记录缺字段或未知来源为 unknown，必须重新认证，不能根据旧 amr 补造来源。本次七天会话继续依赖真实飞书来源，并增加下述客户端绑定。

IPAC 仅对白名单 STUDIO 应用创建专属会话，配置为 IPAC 服务端的 `IPAC_FEISHU_SEVEN_DAY_CLIENT_IDS=<STUDIO_TV_CLIENT_ID>`。期限从真实飞书 callback 的认证时间起算七天，不从每次 authorize、STUDIO callback 或 refresh 重新计时。authorize 必须消费绑定完整授权请求、父 SSO SID 与客户端的一次性飞书 proof；旧 SSO 不能静默续成新的七天。其他应用的全局 SSO 仍为十二小时，OIDC 短 JWT 仍为五分钟。

专属 SID 不能作为全局 SSO cookie 使用；SessionStatus 按已经验证的 Basic 客户端精确绑定，授权码与 UserInfo 同样验证客户端。父 SSO 自然十二小时到期不结束 STUDIO 专属会话；显式撤销在 Redis 原子操作中级联，主体停用或版本变化仍拒绝。启用白名单后旧无客户端绑定的 STUDIO SID 失效，需要真实飞书登录一次，新会话才适用七天策略；不恢复旧失效会话，也不自动给予应用权限。

SDK 核验后的可信 subject、sid、版本，通过后端 App ID/Secret 的 HTTP Basic 调用 IPAC 扩展：

```text
POST {IPAC_BASE_URL}/oidc/session-status
{"subject_id":"可信sub","session_id":"可信sid","session_version":1}
```

响应包括 `active`、`auth_provider`、`amr`、`subject_id`、`session_id`、`current_session_version`、`expires_at`。只有完整身份一致、active、尚未过期且来源确为飞书才能建立或使用本地会话。密码会话不能冒充飞书。未知或失效会话返回 inactive 和空期限，不暴露另一人的资料；网络、数据库或协议故障拒绝访问并返回 503。

登录与 refresh 强制实时查询在线状态；普通 Bearer、签名媒体和 Agent 操作复用最长五分钟的真实状态租约，到期后必须重验。租约不超过上游会话期限。同会话的并发查询合并，已取消的页面不会取消其他请求共享的刷新。确认上游撤销时同步撤销本地会话；临时故障不会错误撤销原本有效的会话。应用配置接口还会使用不存在的 subject/sid 发出只读探针，确认扩展确已部署、Basic 凭据有效、inactive 响应结构正确后才返回 `configured=true`。探针不会创建、恢复或延长会话；成功协议探针最多复用五分钟，故障仅合并两秒。

旧 `IPAC_FEISHU_SOURCE_CLAIM`、`IPAC_FEISHU_SUBJECT_ALLOWLIST` 已从部署配置删除，不能作为来源或在线状态的绕过方式。缺少配置返回 `IPAC_NOT_CONFIGURED`；状态扩展暂不可用返回 `IPAC_SESSION_STATUS_UNAVAILABLE`，界面只显示可理解的中文提示。

## 业务权限与数据隔离

业务权限统一为整个 Studio TV 的 `tv.access`。后端通过可信飞书身份调用官方 SDK `EffectiveScopes`，校验主体/应用 ACTIVE、版本匹配及至少一个含精确 `tv.access` 的非空真实项目环境范围后，生成最长五分钟的应用访问租约；不再重复 Runtime `Check`。租约与应用、issuer、subject、上游 sid、版本和本地会话隔离。到期必须重新取得真实允许，错误不延长旧租约。浏览器不能指定 IPAC 身份或范围，登录成功也不能代替应用授权。

作品、画布、素材和上传保留本地 `owner_id` 存储归属，并独立检查本地项目/团队权限，不按 IPAC 范围划分业务数据。协作者仍使用实际 UID、会话与令牌，只有已授权的明确资源可使用其存储 owner；应用管理员没有跨用户旁路。旧 `GET /api/v1/workspaces` 实验接口退役并返回通用 404，不新增 `/authz/workspaces` 或授权自查接口。`X-Workspace-Id` 已退役，前端不发送，后端即使收到也完全忽略。版本失效撤销会话并返回 401；无权为 403；暂时无法判定为 503。没有本地放行或预览数据回退。

签名素材 URL 绑定本地会话、用户、资源；每次 GET/HEAD/PUT 都重新核验会话，并复用同一五分钟应用授权租约。本地退出立即拒绝后续请求，上游撤销最迟在租约到期后的请求生效；已通过检查并开始传输的请求可以完成，已下载字节无法收回。上传完成会再次鉴权。媒体响应 no-store，旧签名和过期签名不能代替授权。

能力清单位于 `contracts/ipac-capabilities.template.json`，应用代号使用实际 `IPAC_APP_ID`。通过官方 SDK Manifest Preview 核对，Submit 后由 IPAC 管理员审核生效；应用启动不会自动提交或批准清单。

## 环境与上线

| 配置 | 说明 |
| --- | --- |
| `IPAC_ISSUER_URL` | 与 Discovery 完全一致的外部 issuer |
| `IPAC_BASE_URL` | SessionStatus、Runtime、Manifest 的根地址；留空使用 issuer |
| `IPAC_APP_ID` / `IPAC_APP_SECRET` | 独立 Studio TV 应用；Secret 只注入 API 后端 |
| `IPAC_REDIRECT_URI` | 精确等于 `PUBLIC_BASE_URL + /api/v1/auth/feishu/callback` |
| `PUBLIC_BASE_URL` / `ALLOWED_ORIGINS` | 本站真实入口和可信浏览器来源 |
| `ALLOW_PRIVATE_HTTP` | 默认关闭，仅内部版的 RFC1918 字面 IPv4 入口可明确开启 HTTP |
| `IPAC_ALLOW_INSECURE_HTTP` | 默认关闭，仅配合明确的 `ALLOW_LOCAL_HTTP` 开发环境启用 |

deployment-host 的运行配置仍位于私有环境文件，权限 600，不进入 Git、前端资源或日志。当前公司内网入口为 `http://192.0.2.10:18880/projects/`，精确回调同步为该 origin 的 `/api/v1/auth/feishu/callback`；新增回调已登记，原 localhost 回调保留。`WEB_BIND_IP` 明确为 deployment-host 内网 IP，只有 Web 入口开放；API 和数据库保持原有边界。实际发布与登录验证见 [内网直连记录](deployment-host-lan-verification.md)。若切换 HTTPS，关闭 HTTP 例外开关。IPAC 的浏览器 issuer 必须可由用户访问，后端 Base URL 必须可由 API 容器访问。

首次接入顺序为 IPAC 认证来源/SessionStatus 补丁、独立应用及精确回调登记、唯一能力审核和项目环境/角色配置、Studio 私有环境注入与应用发布，最后真实飞书回跳和有权/无权流程验收。历史 `8be955f` 阶段只更新 Studio，发布标签为 `studio-ipac-v0.3.1`；其真实登录、退出、保存恢复与临时作品清理证据保留在 [工具级授权发布记录](ipac-tool-access-verification.md)。本次七天策略需同步发布 STUDIO 与 IPAC，不把历史证据冒充本次真人验收。

迁移 `002_ipac_auth.sql` 保留历史用户和作品，撤销旧密码会话。旧 `003_ipac_workspaces.sql` 的映射、`workspace_id` 列和既有值原样保留，不删表、不清空、不重分配；它们不再参与权限判定或作品、素材和上传的业务隔离。空列不会产生 `WORKSPACE_UNASSIGNED` 阻止真实 owner 访问。历史密码身份与飞书身份仍不按同名或同邮箱合并，作品归属不自动转移；本版没有认领接口。

## 2026-10-07 七天会话验证

- STUDIO API `816ed2d`：Docker 内真实隔离 PostgreSQL、FFmpeg/Chromium 全量测试 447 个通过，4 个已有外部 Models Router mock 测试因未配置独立 mock 地址跳过；认证包另行 `-race` 通过，包含固定截止、短上游夹紧、真实并发刷新和超窗重放撤销。
- STUDIO Web `0532b35`：61 文件、977 个测试通过，类型检查、构建和 1198 个冻结资源校验通过。冻结合同与独立扩展验证另行 63 个测试通过。
- 浏览器 TaskSpace 46 使用明确的本地测试夹具验收提前续期、页面唤醒、原生登录事件、503 恢复、CSRF 重新获取、跨标签竞争的一秒重试、冷启动保留画布路径及真实失效提示；没有替换生产身份或执行模型。
- IPAC `23c49bf`：完整 `go test -mod=vendor -race ./...`、`go vet` 与两入口构建通过，含隔离真实 Redis 的 40 轮创建/撤销竞争、16 路一次性 proof 消费及真实 TTL；HTTP 接入口、架构合同和跨客户端边界均通过。

本轮不声称已等待真实七天，也不将历史真人 OAuth 流程算作本轮真人登录验收。期限边界通过受控时钟与本地浏览器测试验证；启用后现有用户需重新真实飞书登录一次。

### 发布与检查

2026-10-07 15:56（Asia/Shanghai）完成：先准备两端镜像，在同一窗口先切 deployment-host STUDIO API/Web、后切 dev IPAC；STUDIO 发布源为 `01e0b66`（API `816ed2d`、Web `0532b35`），IPAC 运行代码 `23c49bf`。IPAC 私有配置仅新增上述 STUDIO 客户端白名单，其他应用期限、签名密钥与挂载不变，无新数据库迁移。

- STUDIO `/healthz`、`/readyz` 为 200，真实 `/api/v1/auth/config` 为 `configured=true`；内网 `/projects/` 为 200。匿名项目与团队接口为 401，未知路径为 404。IPAC readiness 为 200；Prometheus 的 STUDIO API 与自身采集均为 up。
- 保留 `rhtv-service_postgres_data` 和 `rhtv-service_asset_data` 两个既有外部卷。项目 32、用户 2、文件夹 2、节点收藏 1 均未变化；资产由 75 增至 76，发布期间另一个已授权聊天仍在专用 QA 项目做图片操作，不把并行新增误记为部署迁移。切换时无运行中模型任务或 assistant agent run。
- deployment-host 只重建 API/Web；其数据库、agent launcher/egress、Models Router 和监控容器 ID 未变化。并行聊天的临时 Router 测试容器自行结束。dev 只更换 `ipac-server`，其他容器 ID 全部未变。
- deployment-host 私有备份在 `.local/login-seven-day/release-backup/`，保留上线前 pg_dump 及前镜像 `studio-tv-api:before-seven-day-20261007`、对应 Web 标签。dev 私有备份在 `/etc/ipac/release-backups/20261007-seven-day/`，保留配置与旧容器参数，旧镜像为 `ipac-server:before-seven-day-20261007`；新发布目录 `/home/ubuntu/ipac-releases/20261007-studiotv-seven-day-23c49bf/`。
- 仅本聊天创建的隔离 PostgreSQL/Redis 容器、SSH 测试隧道和含临时数据库口令的文件已清理。保留不含凭据的测试结果及正式回退备份。

启用后需由现有用户完成一次真实飞书登录；新登录固定七天，旧会话不延长。本轮未代替用户执行生产 OAuth，也未调用任何计费模型。IPAC 旧二进制回退必须同时清理本次专属会话及子索引，不能保留后在再次升级时恢复；具体边界见 IPAC 仓库 `docs/PF独立七天飞书会话.md`。

IPAC 来源补丁只扩展 Redis 会话/授权码记录，不需要 MySQL 迁移。旧来源不明的统一会话在下次访问时需重新登录。回滚为不支持 SessionStatus 的旧 IPAC 时，Studio 保持拒绝认证和业务访问，不能降级回旧 amr 或临时人员清单。

## 2026-10-07 登录前置与顶部入口验证

完整 Web 回归为 69 个文件、1207 项通过，包含 52 项登录门禁、34 项固定编辑器外壳与构建变换、3 项 Hyper Frame 入口以及 5 项新增匿名／退出后唤醒续期回归。类型检查、service 构建、差异检查和 1198 个冻结原生资源校验通过。API、OIDC、7 天截止与冻结合同没有改动，仍由服务端独立执行认证与授权。

TaskSpace 49 使用显式本地协议夹具和实际构建结果验证：匿名主页面及三个固定编辑器外壳均先进入同源登录入口，保留原路径与查询；失败返回后手动重试保留片段。冷启动 503 只有一次 refresh，点击重试后才再发一次；403 不进入 OAuth，主页 root 隐藏且 inert，没有执行原生入口。固定 OpenCut 外壳故障时 root 为 display:none，原生模块没有启动。夹具只在 localhost 提供，不连接 IPAC，不执行模型，也不进入构建或 Git。

匿名真实 HTTP 检查确认 STUDIO `/auth/config` 为 `configured=true`，受保护项目读取为 401，飞书入口直接 302 到 IPAC `/oauth2/feishu/start` 并携带 `/oauth2/authorize` 继续地址。此检查不包含新的真人 OAuth 回调；正常回调协议沿用已部署的服务端实现。

### 发布与线上核对

2026-10-07 将 `7879ba9` 发布到 deployment-host，仅构建和替换 Web 容器，保留其他并行聊天已经上线的 CLI 登录能力。API、数据库、Agent、Models Router 和监控容器 ID 均未改变；API `/readyz`、内网 `/projects/` 与固定 `/opencut/index.html` 均返回 200。Web 回退镜像为 `studio-tv-web:before-login-gate-20261007`，构建日志和容器基线留在 deployment-host 私有 `.local/login-gate/`。

TaskSpace 49 的线上检查使用已有真实会话：画布启动只有一次 session refresh 和一次受保护权限读取，成功显示现有项目；Hyper Frame 按钮为 `display:none`，头像和语言按钮可见。随后通过“返回首页”进入项目列表，再进入 `/projects/` 首页，两页均正常显示且未要求再次飞书登录。未新建或修改生产项目，未执行模型。验证结束已关闭该 TaskSpace 和本地协议夹具服务。
