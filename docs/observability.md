# Studio TV 日志、告警与服务监控

`infra/observability.compose.yaml` 是追加部署层。与原来的 `compose.yaml`、现有数据卷层和已启用的 Router/Agent 层一起使用，不单独替换生产配置。它新增 `studio-tv-prometheus-1`、`studio-tv-grafana-1`；API 启用独立指标监听和日志通知配置，API/Web 日志加入轮转。数据库和资产卷的名称、挂载及数据不变。

## 访问和私密配置

- Grafana：`http://192.0.2.10:18883`，默认用户名 `admin`，必须用服务器私密文件提供初始密码。首页为「Studio TV · 服务监控」。匿名访问和自助注册关闭，新增账号由管理员管理。
- Prometheus：服务器本机 `http://127.0.0.1:18884`。需要远程查看时用 SSH 转发，例如 `ssh -L 18884:127.0.0.1:18884 deployment-host`，再访问本机 `http://127.0.0.1:18884`。默认不开放给局域网。
- API 指标：Compose 网络内 `http://api:9090/metrics`，与业务端口分开，没有新增宿主端口。指标不包含凭据、请求体、用户/项目/任务 ID；该监听只用于受信任服务间访问。
- Grafana 仅连接独立监控 bridge，与业务默认网络分离。插件下载、插件安装入口、更新检查和遥测关闭，使用镜像内置的 Prometheus 数据源和面板；这不是宿主防火墙级别的外网封锁。

私密目录默认 `/home/user/.config/studio-tv/observability`，禁止提交到 Git：

| 文件 | 用途 | 宿主权限 |
| --- | --- | --- |
| `grafana_admin_password` | 初次创建 Grafana 管理员；仅该文件挂载到 `/run/secrets/grafana_admin_password` | 文件 `0444`，父目录必须为 `0700` 且仅部署用户可进入；也可由管理员设置 owner UID 472、`0400` |
| `feishu_webhook_url` | API 异步飞书通知器；挂载到 `/run/observability-secrets/feishu_webhook_url` | owner UID 1000，`0600`，API 容器 UID 1000 可读 |

Grafana 镜像使用 UID 472；本地 Compose 的 file-backed secrets 使用 bind mount，不会重新设置源文件的 UID/权限。不要将部署用户的 `0600` 密码文件直接挂给 UID 472，否则 Grafana 启动会失败。`0444` 只适用于私密 `0700` 父目录，不能把该文件搬到可公开遍历的目录。Web 不挂载任何秘密文件。API 只读挂载私密目录。

密码、Webhook URL 不应出现在终端回显、命令行参数、截图或日志里。Grafana 的管理员初始密码只在空数据卷初始化时使用；修改文件不会覆盖已经保存的管理员密码，后续密码变更应在 Grafana 管理界面完成并同步私密记录。

配置项可在 `/home/user/.config/studio-tv/observability.env` 设置。部署脚本检测到此私密文件后追加监控层，保留原有数据卷与已启用的 Router/Agent 层：

| 变量 | 默认值 / 用途 |
| --- | --- |
| `LOG_LEVEL` | `info`；API 结构化日志级别 |
| `STUDIOTV_ENV` | `deployment-host`；API 日志/通知环境标识 |
| `METRICS_ENABLED` / `METRICS_ADDR` | `true` / `0.0.0.0:9090`；需与抓取目标一致 |
| `STUDIOTV_ALERT_WEBHOOK_URL_FILE` | `/run/observability-secrets/feishu_webhook_url` |
| `STUDIOTV_OBSERVABILITY_SECRETS_DIR` | `/home/user/.config/studio-tv/observability` |
| `STUDIOTV_GRAFANA_BIND_IP` / `STUDIOTV_GRAFANA_PORT` | `192.0.2.10` / `18883` |
| `STUDIOTV_GRAFANA_ADMIN_USER` | `admin` |
| `STUDIOTV_PROMETHEUS_BIND_IP` / `STUDIOTV_PROMETHEUS_PORT` | `127.0.0.1` / `18884` |
| `STUDIOTV_PROMETHEUS_RETENTION_TIME` / `STUDIOTV_PROMETHEUS_RETENTION_SIZE` | `15d` / `5GB`，任一到达即清理旧块 |
| `STUDIOTV_PROMETHEUS_VOLUME` / `STUDIOTV_GRAFANA_VOLUME` | `studio-tv_prometheus_data` / `studio-tv_grafana_data` |
| `STUDIOTV_GRAFANA_LOG_LEVEL` | `info` |

Prometheus 抓取配置中的 `environment` 当前固定为 `deployment-host`；在其他环境复制部署时应同时调整该标签，不仅修改 API 的 `STUDIOTV_ENV`。

监控 bridge 不设置 `internal: true`：在 deployment-host 的 Docker 29.8.1 实测中，仅连接 internal bridge 的容器会忽略宿主端口发布，Grafana 18883 无法访问。隔离使用独立 bridge，外部插件功能由 Grafana 配置关闭。

## 指标和本地规则

Prometheus 每 15 秒抓取 API、自身和生成服务采集器，5 秒抓取超时，每 15 秒评估规则。Grafana 默认展示最近一小时并每 15 秒刷新；初次启动需要等待至少两次抓取，速率和分位数面板才有数据。

仪表盘包含请求吞吐、按响应类别的请求数、5xx 比例、普通 API P50/P95/P99、慢路由、正在处理的请求、数据库连接池、Go 堆/进程内存、goroutines、等待数据库连接时的取消和抓取可达性。增加 IPAC / Models Router 请求速率、响应类别、取消/错误和首响应 P95；首响应耗时包括等待 IPAC 并发槽位，不包含响应体读取或异步模型任务总时长。包装沿用现有 HTTP 客户端和鉴权缓存，不新增鉴权调用。HTTP 指标标签只包括方法、注册路由模板和响应类别；未知路径统一为 `unmatched`。`/events` 结尾的路由可能包含约 30 秒的事件流连接，因此普通 API 分位数及耗时规则排除这些路由；在途请求仍包含事件流。

| 规则 | 条件 |
| --- | --- |
| `STUDIOTVAPIDown` | 指标抓取失败持续 2 分钟 |
| `STUDIOTVAPITargetMissing` | API 抓取目标缺失持续 2 分钟 |
| `STUDIOTVHighHTTP5xxRatio` | 5 分钟内至少 20 个请求，5xx 比例超过 5%，持续 5 分钟 |
| `STUDIOTVHighHTTPP95` | 普通 API 的 5 分钟 P95 超过 2 秒且至少 20 个请求，持续 10 分钟 |
| `STUDIOTVDBPoolNearCapacity` | API 连接池已使用/最大连接数超过 90%，持续 5 分钟 |

在 Prometheus 的 Alerts 页面和 Grafana「本地监控规则状态」查看 `pending` / `firing`。没有部署 Alertmanager，因此这些规则本身不发送飞书消息。飞书错误通知由 API 的异步通知器负责，监控规则和通知送达是两条独立链路。规则是否 firing 不能用来判断消息是否送达。

## 日志与排查范围

API 使用 Go 标准 `slog` 输出 JSON，保留时间、级别、服务/环境、日志ID、操作及错误等字段。Web 的 Nginx 访问日志使用安全路由分类、日志ID、响应码和耗时，不记录 URL query 或原始资产 grant；可能包含未经清理 URI 的原生 Nginx error 日志关闭，由访问日志状态/耗时辅助排查。沿用 IPAC 的日志ID、结构化错误与飞书消息字段；同一错误按注册路由、状态及错误码在一分钟内去重，异步有界队列避免阻塞业务请求。4xx 与请求取消不推送，未实现功能的 501 记录 warning，其他 5xx/异常 panic 才通知。通知必须得到飞书 HTTP 200 和业务成功码才计为送达；失败只记录安全错误码，不输出 Hook。这里没有复制 IPAC 的私有日志框架依赖。API/Web/监控容器的 Docker `json-file` 日志每文件最多 `20m`、最多 5 个文件，落在服务器 Docker 数据目录并轮转。轮转会淘汰旧日志，不是永久日志归档。

按日志ID在 API 容器日志中检索，再结合响应类别、慢路由和连接池图表定位；不要在公开截图中展示秘密配置或完整用户内容。部署脚本/诊断只需要输出验证结论，Compose 合并检查使用 `config --quiet`，避免打印插值后的认证环境变量。

这些监控不采集请求体、画布内容、浏览器事件、PostgreSQL 整机指标、宿主磁盘/CPU，也不证明登录、撤权或每条业务路径可用。API `up=1` 表示指标可抓取；业务错误看 5xx/延时与日志。低流量时分位数容易受单次请求影响，无数据应显示为「无数据」。上游 IPAC/Models Router 的服务端内部耗时仍需在各自服务定位。

## 持久化、备份与升级

Prometheus 和 Grafana 分别保存到独立命名卷。Prometheus 保留约 15 天，超过 5GB 的已封存块也会清理；WAL、当前 head 和压缩过程仍需要额外磁盘空间，这不是 5GB 的硬文件系统配额。为 Docker 数据目录预留余量并观察磁盘使用。

备份时先确认最终 Compose 项目和卷名称，沿用生产已有数据卷层、Router/Agent 层及私密环境文件。只停止待备份的 `prometheus` 或 `grafana` 服务，在进程停止后备份对应命名卷，再启动该服务；Grafana SQLite 需要一致的备份。备份配置、Grafana 数据卷和 Prometheus 数据卷，秘密文件另行加密备份。数据库/资产继续使用原来的备份流程，不包含在监控卷备份中。不要执行 `down -v`，不要把监控卷指向数据库或资产卷。

恢复时使用与备份一致的镜像版本和卷名称，先恢复对应卷，再启动监控服务并检查健康、数据源和面板。重建容器保留命名卷；删除监控卷会丢失历史指标、账号及 Grafana 设置。

镜像固定为 Prometheus `v3.13.4` LTS 和 Grafana OSS `13.2.3`，同时固定多架构 manifest digest。升级先验证官方版本、镜像 digest、Prometheus 规则及 Grafana provisioning，再替换追加层；不要只改为 `latest`。Grafana 使用官方 `grafana/grafana` OSS 镜像，旧 `grafana/grafana-oss` 命名不再更新。

## 配置验收

使用最终部署参数运行 Compose `config --quiet`。用固定 Prometheus 镜像的 `/bin/promtool` 分别执行 `check config /etc/prometheus/studiotv-infra/observability/prometheus.yml`、`check rules /etc/prometheus/studiotv-infra/observability/alerts.yml` 和 `test rules /etc/prometheus/studiotv-infra/observability/alerts.test.yml`。规则测试覆盖故障持续时间、缺失目标、持续高错误比例、数据库池占用、普通请求延迟、低流量及事件流不误报。

启动后检查两个容器健康、Prometheus `studiotv-api` 抓取目标、Grafana 已预置的数据源/首页和未登录访问被拒绝。验收不需要为了触发告警而破坏服务，API 提供 `studiotv-api --observability-check`，只发送一条标明验收的通知并检查飞书业务成功码；不连接数据库、不启动第二个监听器。真实群验收应单独执行一次，普通启动和健康检查不会发送消息。Grafana healthcheck 只访问 `/api/health`，该健康接口可返回状态但不允许匿名读取业务仪表盘。

参考官方资料：[Prometheus 下载与 LTS 版本](https://prometheus.io/download/)、[Prometheus 抓取配置](https://prometheus.io/docs/prometheus/latest/configuration/configuration/)、[Prometheus 本地存储与保留策略](https://prometheus.io/docs/prometheus/latest/storage/)、[Grafana Docker 与文件秘密配置](https://grafana.com/docs/grafana/latest/setup-grafana/configure-docker/)、[Grafana 配置项](https://grafana.com/docs/grafana/latest/setup-grafana/configure-grafana/)、[Grafana 官方 Docker 版本](https://grafana.com/grafana/download?platform=docker)。


## deployment-host 验收记录（2026-10-07）

- API/Web 更新后运行正常；Prometheus 与 Grafana 容器健康，数据库和 Agent 容器的启动时间、原有数据卷未变化。
- Prometheus 最终使用 `127.0.0.1:18884`，避开已有 Models Router 的 18882；API 和 Prometheus 自身的抓取目标均为 up，抓取无错误。
- Grafana 浏览器登录与真实面板渲染通过；17 个面板、20 条查询和数据源 health 均验证成功。未登录仪表盘请求返回 401。
- IPAC、Models Router 的真实请求已进入同一指标注册表，连接池 5 个状态均可抓取。业务端口 `/metrics` 返回 404；指标监听没有宿主端口发布。
- API/Web 日志为 JSON，日志ID可与错误响应对应。虚构的秘密路径/query 标记以及真实 Hook/管理员密码均未出现在 API/Web 日志；Docker 日志轮转为每文件 20MB、最多 5 个文件。
- 独立执行一次 `studiotv-api --observability-check`，飞书返回成功，`notifications_sent=1`。没有制造生产 5xx 或重复发送验收消息。
- 一次性 PostgreSQL 17 完整默认 API 测试：51 个包成功，403 个顶层测试通过。4 个需要独立外部 Router 联合环境的测试按其配置条件跳过；本次没有再次发起收费模型任务。另新增 5 个观测集成测试并通过 race，覆盖流式响应、错误状态、私有指标及双监听器生命周期。
- 1198 个原生编译资源基线和 63 个接口契约测试通过，冻结的核心契约/编译资源没有变动。

历史数据从本次启动开始积累。低请求量、缓存命中或没有新上游调用时，速率/分位数面板可能暂时无数据；不能将无数据解释为零耗时或完全健康。

## 生成队列与服务心跳（2026-10-09）

新增仪表盘 [Studio TV · 生成队列与服务心跳](http://192.0.2.10:18883/d/studiotv-generation-overview)，UID `studiotv-generation-overview`。既有 API 首页和新仪表盘有互相跳转链接，共用 `studiotv-prometheus` 数据源。24 个面板分别展示主队列、执行端队列、等待年龄、采集新鲜度、服务就绪及本地规则状态。

STUDIO 每 5 秒只读聚合 `execution.tasks`，单次 SQL 超时 3 秒，按任务而非 plan 计数。`studiotv_generation_tasks{kind,capability_family,state}` 包含尚未提交 Router 的 `QUEUED`；`RUNNING` 包含上游调用、轮询和资产归档。`capability_family` 固定为 `h3|other`，不把任务、项目或用户ID加入标签。`studiotv_generation_oldest_queued_age_seconds` 表示最老排队年龄。采样失败保留旧数值并将 `studiotv_generation_queue_sampler_up` 置零；仪表盘只接受成功时间小于 30 秒的快照，不用旧值补零。

`generation-exporter` 每 15 秒并行只读探测 STUDIO API、画布 Web、Router、私有隧道后的 H3 API，以及 AutoDL 上的 H3 进程、ComfyUI 和 ART。健康路径校验响应内容，Web 校验 Studio TV 页面标记，STUDIO/Router readiness 包含真实数据库检查。H3 推理接入就绪要求鉴权健康、worker 启用、profile 存在、真实 H3 进程、H3 队列数据库、ComfyUI 队列/runtime 和两个 H3 入口节点及 SaveVideo 注册检查通过。这是服务可达和接入条件检查，没有独立 worker 线程进展 ticker，也不发起 GPU 生成来模拟心跳。

`studiotv_generation_queue_jobs{layer,state}` 分别读取 H3 SQLite 与 ComfyUI `/queue`；两层与 STUDIO 观察的是重叠任务，不能求和。SSH、执行端数据库或接口失败时撤下对应队列值，显示未知；超过 40 秒没有新快照时心跳归零，旧队列也撤下。服务和探针固定标签不包含凭据、提示词或媒体内容。

采集器镜像固定 Debian digest 与 Python/OpenSSH 包版本，UID 1000、只读文件系统、无 Docker socket。使用 host network 访问原有 localhost 服务，指标只绑定 Docker 桥 `192.0.2.10:18885`，不发布公司局域网端口；Prometheus 使用 `host.docker.internal:host-gateway` 抓取。配置和秘密放在 `/home/user/.config/studio-tv/generation-monitoring`（目录 `0700`，秘密 `0600`），挂载为 `/run/generation-secrets`。H3 API key 从已有外部秘密文件复制，监控使用专用 SSH key，AutoDL `authorized_keys` 强制命令为只读 `/root/.config/studio-video-api/monitoring/collect.py`，并用 `restrict` 禁止 Shell、PTY 和端口转发。原隧道密钥不挂进采集器。

追加部署层会启动采集器；API 加入原生队列指标，Prometheus 加入第三个抓取目标。H3 和 Router 无需重启。Prometheus/Grafana 只读挂载稳定的 `infra` 父目录，避免 Git 更新后旧文件/叶子目录挂载失效而漏载配置。部署脚本仅把 Git 跟踪的公开监控配置设置为文件 `0644`、父子目录 `0755`，使非 root 容器可读；外部秘密目录保持 `0700`，不受此步骤影响。服务器重启后 Compose `unless-stopped` 自动恢复；AutoDL 关机时心跳离线、下游队列未知，重新开机后原隧道和下一次探测自动恢复。采集器不修改接单、取消、断点续算或关机策略。

本地规则新增采集器不可达、服务心跳失败、服务未就绪、STUDIO 队列采样失败/过期、H3/Comfy 队列采样失败和长时间等待；故障通常需持续两分钟，采样故障一分钟，等待超过十五分钟且持续五分钟才触发。沿用既有本地规则展示，没有增加 Alertmanager 或对外消息发送。

验证包括 exporter 的 15 项断线/恢复/过期/局部数据库失败测试、隔离真实 PostgreSQL 队列统计与 race 测试，以及固定版本 `promtool check config/check rules/test rules`。验收不通过生成收费任务或停止生产推理服务制造故障；上线数据和面板验证记录保存在 `.local/generation-monitoring`。
