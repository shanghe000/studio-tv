# 内部版最小 API

核心入口 `/api/v1`，新增DDD模块入口 `/api/v2`，Go API 与前端独立部署。核心 v1.0.0 合同保持冻结；统一登录路径见 `contracts/auth-extension.json/yaml`，唯一工具权限和既有操作的授权要求见独立 `contracts/authz-extension.json/yaml`。前端沿用原有布局和功能，不显示工作空间。既有登录与作品验收见[工具级授权发布记录](ipac-tool-access-verification.md)，新增功能的验证及发布状态见[第2轮交付](iteration-02-result.md)。

| 范围 | 接口 | 当前行为 |
| --- | --- | --- |
| 登录配置 | `GET /auth/config` | 返回 provider、configured、同源 loginUrl、unavailableReason；真实 SessionStatus 探针通过才宣告配置可用，无密钥 |
| 飞书登录 | `GET /auth/feishu/login?returnTo=/projects/`、`GET /auth/feishu/callback` | 官方 IPAC SDK OIDC + PKCE + UserInfo，随后在线确认真实飞书来源、sid、版本和期限 |
| 本地会话 | `GET /auth/csrf`、`POST /auth/sessions/refresh`、`DELETE /auth/session` | CSRF、在线状态检查、轮换刷新、退出撤销；兼容 `/auth/refresh`、`/auth/logout` |
| 当前用户 | `GET /me`、`PATCH /me/preferences` | 本地资料与偏好，保留冻结响应形状；有效身份不等于业务范围授权 |
| 项目 | `GET/POST /projects`、`GET/PATCH/DELETE /projects/{projectId}` | 具备工具级 tv.access 的本人作品、分页、筛选、创建幂等、修改与软删除 |
| 置顶 | `PUT/DELETE /projects/{projectId}/pin` | 实时 tv.access；重复设置不翻转状态 |
| 画布 | `GET/PUT /projects/{projectId}/snapshot` | 完整图与 ETag；写入须 If-Match，冲突 412；校验本人和工具权限 |
| 素材上传 | `POST /asset-uploads`、`POST /asset-uploads/{uploadId}/renew`、`POST /asset-uploads/{uploadId}/complete` | tv.access；申请、续期、字节/校验和/MIME/真实媒体校验 |
| 素材读取 | `GET /assets`、`GET/DELETE /assets/{assetId}` | 本人素材、详情、会话绑定签名 URL、引用检查后删除 |
| 文件传输 | `/storage/uploads/{uploadId}` PUT、`/storage/assets/{assetId}` GET/HEAD | 非 API 前缀；专用签名、在线会话与工具权限、Range；任意浏览器 URL 不能冒充素材 |
| 健康 | `/healthz`、`/readyz` | 非 API 前缀；进程、数据库迁移和存储检查 |

密码、验证码、Google 登录没有启用。充值、支付、会员、钱包、报价、报价确认的已知接口在内部版强制返回 `403 FEATURE_DISABLED`，不能用收费开关重新开启。社区及分享默认关闭；其开关可恢复入口，未实现的功能仍返回501，未知路径404。内部版详细规则见[内部版说明](internal-edition.md)。

新增接口均要求登录和实时 `tv.access`，列表与写入由稳定 `owner_id` 隔离：

| 完整路径 | 当前行为 |
| --- | --- |
| `GET/POST /api/v2/conversations` | 私有GLOBAL/CANVAS会话分页、幂等创建 |
| `GET/DELETE /api/v2/conversations/{id}` | 会话详情与强ETag软删 |
| `GET/POST /api/v2/conversations/{id}/messages` | 真实历史查询；仅USER TEXT追加，UUID幂等及If-Match；不自动调用模型 |
| `GET/POST /api/v2/library/items` | 私有角色/场景库，page/size/keyword/kind分页、幂等创建 |
| `GET/PATCH/DELETE /api/v2/library/items/{id}` | 详情、完整投影更新、软删；强ETag；素材必须是本人READY图片，活跃库引用阻止素材删除 |
| `GET /api/v2/model-requirements` | 产品需要的20类能力需求，不代表模型已部署 |
| `GET /api/v2/model-capabilities` | 配置Router后读取实际能力/参数schema，未配置501，无采样数据兜底 |

详细字段与状态见[会话](assistant-api.md)、[角色/场景库](library-api.md)、[模型需求](model-requirements.md)。文件夹、库图片独立管理、执行任务及助手runs仍明确501。前端助手和图库尚未接入上述新API；本轮完成后端，不把数据库API可用误报为原生按钮已打通。真实模型接入均保持关闭。

## 身份与工具访问授权

受保护接口需要 Bearer access token，令牌只在前端内存，refresh 只在 HttpOnly Cookie。刷新和退出需要合法 Origin 与 X-CSRF-Token。每次认证和签名文件访问核验上游 SessionStatus；真实撤销返回 401，临时不能确认返回 503，不退回模拟数据。

本轮唯一业务能力为工具级 `tv.access`。角色在 IPAC 配置，后端每次业务请求由可信会话调用官方 SDK EffectiveScopes，并对属于本应用且含 `tv.access` 的真实范围调用 Runtime Check；任一范围允许即可使用工具。不能按本地角色名或前端按钮放行。项目、素材、画布和上传保留 `owner_id` 隔离，不按 IPAC 范围分区；本人素材引用不受旧空间列影响，即使应用管理员也没有跨用户旁路。

前端不请求工作空间、不传 `X-Workspace-Id`，原页面和画布功能沿用。旧 `GET /workspaces` 退役为通用 404；没有 `/authz/workspaces`、子路径或授权自查接口。后端完全忽略旧空间头，不能使其改变授权、数据或幂等结果。IPAC 项目编号、权限环境编号、本地画布作品编号是不同概念。历史空间列与原值保留但不参与业务隔离；旧密码身份仍不会随新登录自动认领，本版没有历史认领接口。详见 [IPAC 接入](ipac-integration.md) 和 [授权边界](ipac-rbac.md)。

## 通用协议

成功 `{code:0,message:"OK",requestId,data}`；错误 `{code,message,requestId,retryable,details}`，使用真实 HTTP 状态。ID 是不透明字符串，日期为 UTC。未认证 401、无工具权限 403、临时 IPAC 授权故障 503。独立授权扩展不改写冻结核心字段。

创建项目、申请/续期/完成上传需要 UUID `Idempotency-Key`；同键同参数重放首次结果，同键不同参数 409。画布完整保存使用读取返回的强 ETag 作为 If-Match；冲突 412，不覆盖新版本。

## 后续迭代

1. 接入新会话和图库前端API，去除前端静态数据依赖。
2. 在独立Models Router选择首批适配器，增加不依赖余额/报价的内部异步任务、Worker、结果资产回收与状态通知。
3. 按内部使用需要实现素材文件夹、团队协作与更多目录功能。
4. 对外服务时再实现并开放公开分享、社区和计费，不能仅恢复按钮就宣称上线。
