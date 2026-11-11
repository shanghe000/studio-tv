# deployment-host 内网直连发布记录

2026-10-04，发布标签 `studio-lan-v0.3.2`。实现版本 `e6fbea4`，随后提交本记录。前端、Go API、PostgreSQL 17 都部署在 deployment-host（`192.0.2.10`）的 Docker 容器中，服务目录 `/home/user/apps/rhtv-service`。

当前浏览器入口为 **http://192.0.2.10:18880/projects/**，公司同一内网直接访问，无需 SSH 隧道。

## 部署与登录配置

| 项目 | 已生效配置 |
| --- | --- |
| Web | 容器 `d9ec385de23b`，宿主 `192.0.2.10:18880` |
| API | 容器 `ddc9cba854f2`，宿主仅 `127.0.0.1:18881`，通过 Web 的 `/api/v1` 和素材路由访问 |
| 数据库 | 容器 `17e001879953`，沿用原容器和持久卷，不发布宿主端口 |
| 站点 origin | `http://192.0.2.10:18880`，PUBLIC_BASE_URL 与 ALLOWED_ORIGINS 一致 |
| 精确 IPAC 回调 | `http://192.0.2.10:18880/api/v1/auth/feishu/callback` |
| 发布前备份 | `/home/user/.config/rhtv-service/backups/20261004T062154Z` |
| 保留镜像 | `rhtv-service-api:before-lan-20261004`、`rhtv-service-web:before-lan-20261004` |

私密环境文件仍为 `/home/user/.config/rhtv-service/server.env`，权限 600，密钥不进入 Git 或前端。Web 只绑定实际内网 IP；API 和数据库没有新增对外端口。IPAC 通过真实系统管理员会话追加此精确回调，并保留原 localhost 回调；应用、人员、角色及唯一 `tv.access` 权限没有变更。飞书开放平台回调仍指向 IPAC，IPAC 服务本身未重新部署。

`ALLOW_PRIVATE_HTTP` 默认关闭，显式启用后只允许内部版使用 RFC1918 字面 IPv4 HTTP origin，公网 IP、任意 DNS 名称、IPv6 和外部版不适用。旧回环开发开关与 IPAC demo HTTP 上游开关保持原语义。本次没有数据库迁移、数据认领或作品分区改动。

## 实际直连验证

从用户电脑直接访问上述内网 IP，未使用 localhost URL 或隧道转发。

| 流程 | 结果 |
| --- | --- |
| 页面和登录配置 | `/projects/` 返回 HTTP 200；auth/config 为 configured=true、IPAC_FEISHU |
| 飞书登录 | 真实授权后回到 IP origin，原右上角显示维护者及正确头像，无工作空间栏 |
| 既有作品 | 两条用户作品可见；原作品完整 GET 响应哈希与之前一致 |
| 新建与保存 | 原生新建项目、文本节点编辑及图片节点上传成功，服务端 snapshot 保存至 revision 6 |
| 刷新恢复 | 文本和图片从服务端恢复，图片实际加载为 530×530，保存数据使用稳定 asset ID 引用 |
| 素材签名 | 实际 PNG 为 READY，素材 URL origin 是内网 IP；签名 HEAD 为 200、private/no-store |
| 文本复制 | 点击原生复制按钮，真实 execCommand 返回成功且复制内容与验收文本匹配；临时 textarea 已移除 |
| 嵌套编辑器 | 实际 OpenCut iframe 在同一 IP origin 加载，缺失的 UUID 与文本复制方法已适配 |
| 清理 | 本次临时作品及素材均已删除，两条用户作品保留 |
| 后端就绪 | `/readyz` 确认数据库和素材存储 ready |

保留的用户作品为 `prj_ae214fa33ae04631a1f65ce0537d1136` 和 `prj_f7664637fde9478281d30dadec39b7f5`。第一条完整 GET 响应 SHA-256 仍为 `0f5f0eb7bfaf037316c8776c64717762a91d2501ca61b22df1428c9c7bc0d1e8`。本轮仅清理自行创建的 `prj_1c9ec0e4214c49ecaaad027e610d006e` 和 `ast_07e4946233a94070b8a61e587fdac9e4`。

## 兼容与检查边界

HTTP IP 页面仍为非安全上下文，没有修改或伪造 isSecureContext。仅在原生方法缺失时，用浏览器 getRandomValues 生成 UUID v4，上传 SHA-256 使用固定 `@noble/hashes 2.4.0`，文本复制实际执行浏览器命令并在失败时拒绝。主页面和嵌套编辑器入口使用同一适配；已有原生方法保持不变。

Web 9 个测试文件、56 项测试、TypeScript 和生产构建通过；Go config/auth/authorization 定向测试及 config vet 通过，新增 43 个 origin 边界及回归子例。1198 个冻结原生资源哈希一致。本轮未重跑数据库全套；真实保存、素材上传和刷新流程实际经过现有 PostgreSQL。核心接口合同及 UI/CSS/图形资源未修改。

没有模拟原生 SubtleCrypto、图片 Clipboard、worker 或 HTTPS 安全上下文。尚未接入的模型、协同、离线备份等能力仍按已有边界处理，不以本轮检查声称全部未来功能等同 HTTPS。若后续切换团队域名及 HTTPS，更新站点 origin 和精确登录回调并关闭 HTTP 例外即可。
