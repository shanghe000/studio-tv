# 2026-10-06 已有 API 回归

本轮按现有路由及扩展合同的 `IMPLEMENTED` 清单审计；冻结核心合同中的未来功能不算已上线。测试 agent 没有部署、撤销用户会话或修改用户既有记录；主 agent 完成修复发布和 Web 验收，结果见文末。全程没有调用 AppGrowing、真实模型或收费供应商。

## 验证环境与结果

| 层次 | 实际执行 | 结果 |
| --- | --- | --- |
| 本地合同 | `scripts/verify-contracts.sh`：冻结合同、JSON/YAML 对等、示例及全部扩展合同单测 | PASS，53 项测试 |
| 本地 Go | auth/config/authorization/httpapi/security/core/bootstrap/resources/execution/modelgateway/assistant/organization 定向包 | PASS；本机未配置独立 PostgreSQL，不能据此声称数据库回归已执行 |
| deployment-host 已部署源码 | `scripts/test-api-docker.sh`，随机独立 PostgreSQL 容器与测试库 | PASS；需显式 Router 的 4 个联合用例跳过，随后由下一项补齐 |
| 完整隔离联合回归 | `scripts/test-iteration-01.py --run --development-snapshot`：STUDIO + 两个临时 PostgreSQL + Router HTTP + 显式 mock | PASS；STUDIO 536、Router 354 个测试/子例，0 fail、0 test skip，清理无错误 |
| 修复后的最终源码 | `scripts/test-iteration-01.py --run --source-stable`，包含 013/014/015 迁移及新增上下文/命令 | PASS；STUDIO 586、Router 354 个测试/子例，0 fail、0 test skip，清理无错误 |
| LAN 线上 | `http://192.0.2.10:18880`，部署源码 `29052a2`；使用已有真实授权会话 | 167 个成功业务 HTTP 请求、26 条语义断言；另 14 项匿名、健康与未知路由检查全部通过 |

联合回归使用内部 Docker 网络、不发布端口、只启用 explicit mock；模型适配器和身份夹具仅存在于独立测试环境。带有 mock 的成功结果不能视为真实供应商执行验收。开发快照早于本轮角色库与标题最终修复；最终源码结果单列。

机器记录位于 `.local/iteration-01/20261006T174513-28595baf013a/summary.json`，STUDIO 39 个有测试包、Router 12 个有测试包通过。其余包为无测试文件，`packages.skip` 不代表测试被跳过。

## 线上实际覆盖

| 接口范围 | 验证行为 |
| --- | --- |
| 身份与边界 | 未登录及伪造 Bearer 返回 401；伪造团队头返回 403；退休 workspace 路由与未知路由返回 404；内部计费入口返回 403；响应 body/header 的 requestId 一致 |
| 项目、完整画布 | UUID 幂等及大小写重放、变更请求 409、拒绝 owner 注入、旧 workspace 头不改变本人读取；GET snapshot 强 ETag、保存递增 revision、旧版本 412、完整图读取一致、blob 引用拒绝；重命名及重复置顶 |
| 真实素材 | 68 字节 PNG 申请及幂等重放、renew、真实签名 PUT、错误校验和拒绝、complete 重放、实际 1×1 媒体 READY；签名 HEAD、206 精确字节范围、416 越界、篡改签名 401、private/no-store；画布引用阻止删除 409，解除引用后可删除 |
| 私有会话 | GLOBAL 创建及重放、不同请求 409、USER 文本保存及 receipt 重放、旧 revision 412、历史仅保留一条 USER 消息、无模型输出或活跃 run；pending client tools 读取、本人消息删除与历史更新 |
| 私有提示词 | 创建与重放、详情、修改需要 If-Match、旧版本 412、favorite 目标状态、usage 写入、删除后 404 |
| 文件夹 | 创建与重放、本人 project tree、项目所属文件夹读取、移动及 revision 冲突、移动回根目录、删除后 404 |
| 目录与其他已实现读取 | characters/filters、prompts、skills、workflows、apps、voices、director projects/models、catalog categories/configs/dictionaries/entries、preferences/tags、HF projects、studio registry/fonts；library state/entries/folders、notifications v1/v2及未读数 |
| 模型能力 | 实际目录分页结束、29 个版本条目无重复；exact capability/version 与目录一致且 no-store；无参数、重复参数、未知版本及超范围查询拒绝；未提交 invocation |
| tasks/history | 空 batch-status、未知 ID、读取已有本人 3 条 history 详情及对应 task/events、事件序号类型；没有取消或删除既有任务或历史 |

不同 owner 的真实数据隔离、并发写入、事务回滚、上游权限撤销/故障及签名失效，通过隔离 PostgreSQL/HTTP 用例验证；线上仅有一个已授权真人会话，不声称完成两个真人账号间的线上验收。

初探时目录 namespace/tree projectId 漏传、renew 后仍用旧上传 URL、以及消息分页键识别错误均为临时测试脚本问题。已按实际合同更正并验证成功，未判为服务故障。核心 snapshot 缺失 If-Match 当前返回 400 `IF_MATCH_REQUIRED`，扩展模块返回 428；记录实际行为，未擅自修改冻结核心合同或实现。

## 清理与覆盖边界

每轮只删除脚本自行创建并登记的 ID，删除后 GET 均确认 404。最终临时项目、素材、会话、文件夹及提示词已清理；失败初探创建的项目/上传资产也已清理。用户既有作品、消息、任务、设置和通知未修改。

线上未提交 canvas/app/assistant/HF 模型运行，未执行取消和 history/output 删除；这些写入、事件、worker 与结果回收行为在完整隔离 explicit mock 联合回归覆盖。线上也未修改既有偏好、tag 排序或通知状态；相应持久化和 ownership 在隔离数据库用例覆盖。未以本轮 API 回归代替浏览器 UI、真实模型或所有 178 个增量 IMPLEMENTED 操作的逐项生产验收。

两份独立测试源码归档脚本已补新合同及 `seed/character-media.json` 白名单，`test-media.py` 同时补已存在的 `stylecatalog/seed/styles.json`；这些是 `go:embed` 的构建输入。七条新增 PostgreSQL 用例列为必须 PASS。修改仅影响独立测试源码打包，不改变服务或部署行为。

已独立审查角色媒体新 manifest 与路径边界：415 个唯一角色、1660 个唯一文件、66,693,766 字节；所有文件均被缩略图或三视图引用，路径内容哈希与登记哈希相同，来源只含允许的公开 CDN。API 在符号链接解析后限制目录根路径，并在素材导入时再次核对 SHA-256；独立导入器拒绝重定向与缓存文件符号链接。结构审查通过，未发现新的路径越界或远程 URL 代理入口。

线上脱敏请求记录保留于 `.local/api-regression-20261006/online-results.json`，不包含请求凭证、body、用户既有内容或签名查询串。

## 最终源码回归

首次 `--source-stable` 于 `.local/iteration-01/20261006T180550-abd3dfa897dc` 执行，Router 354 个测试/子例通过；STUDIO 562 通过、4 失败、0 跳过，测试环境清理成功。标题新增 2 条、context 1 条及 commands 2 条真实 PostgreSQL 用例实际通过。

四个失败共同原因是新角色媒体路径尚未纳入 `resources.catalog_media` 的数据库 CHECK。`TestCatalogMaterializationBoundLocalBytesPostgres` 明确报 `catalog_media_path_check` / SQLSTATE 23514；角色升级、原目录导入和完整运行时初始化因此失败。角色库 agent 随后新增 015 兼容迁移，保留旧目录分支，严格允许 64 位小写哈希 WebP 新路径，并验证 19 种非法路径、旧行保留及重复迁移。

修复后再次完整执行，证据位于 `.local/iteration-01/20261006T181207-8152be6c4f3d/summary.json`：**STUDIO 586、Router 354 个测试/子例全 PASS，0 fail、0 test skip；STUDIO 43 与 Router 12 个有测试包通过；清理无错误。** 七条新增真实 PostgreSQL 必测用例全部 PASS（标题 2、角色升级 1、015 路径边界 1、context 1、commands 2）；先前失败的完整 bootstrap/runtime、catalog 导入和真实媒体 materialize 也已 PASS。

最终测试源码归档 SHA-256：`fc6acf0ce31afb9dcadb5065e37da2fa4c44217f4f1ec4d34bcbd6cd1fbb3dcb`。这轮覆盖正式初始化、迁移、Owner/CAS/幂等、任务/消息上下文及画布命令原子事件。它不改变线上部署；新增接口的生产验收须在正式上线后单列。

## 新接口上线后 LAN 补验

主 agent 确认发布 `0d7cce87dc983107f08b1b9341a2ca090ae5b1a2` 后，使用同一私密授权会话执行 **70/70 PASS（47 个实际 HTTP 请求、23 条语义断言）**，证据 `.local/api-regression-20261006/new-live-results.json`。

- 仅创建本轮一个新项目、两条 GLOBAL 会话，项目及会话均 DELETE 200、GET 404；删除项目后的 context 也为 404，未修改用户既有数据或主 agent 的 UI 验收项目。
- context 读取权威 revision、强 ETag/no-store、当前 `params.prompt` 和文本草稿；不带 reserved metadata/native state；匿名 401、owner 查询注入 400、未知项目 404。
- commands 实际提交并持久化 receipt、顺序重放及大小写 UUID 重放一致，后续命令不改历史 receipt；不同 body 409、旧 revision 412、缺少 If-Match 428、伪造 agentContext 501、改 status 等非法输入 400。graph revision 与前两条命令 event cursor 单调增加，删除节点同时删除连线；原生字段、metadata 和原有文本状态保留；没有产生模型执行 history。线上未并发提交，真实并发由前述隔离 PostgreSQL 用例覆盖。
- 首条有效 USER 文本生成并保存标题，自定义标题保持；消息幂等重放及后续消息不改首次主题，真实列表关键词查询能找到保存后的标题，历史仅有 USER 消息，无模型输出。

这轮新增线上验收对应首发 SHA `0d7cce8`。独立终审随后发现上下文 URL 文本的大写 scheme、非法转义及分号查询漏脱敏；首发验收不代表后续补丁验收，补丁结果单列如下。

## 最终发布与 Web 核对

最终代码版本 `15185cc491b8f8130ff9a21a90b4d44da302f7d4` 已部署到 deployment-host，API、Web、数据库正常，LAN 地址仍为 `http://192.0.2.10:18880`。部署前备份位于 `/home/user/.config/rhtv-service/backups/20261006T100626Z`。

- 角色库实际网页缩略图正常；首个角色详情三张图片实际解码为 768×1026、768×1026、768×432。点击“添加到画布”产生三个图片节点，保存后服务端上下文仍有三个有效素材 ID。
- 首条 USER 消息“为图形冒险故事规划三幕剧本”生成同名标题；原生历史列表展示该标题和1轮，选中后恢复消息与面板标题。没有提交模型运行。
- URL 脱敏补丁覆盖17种授权链接绕过与9种普通创作链接保持场景；domain/execution 测试及 vet 通过。最终版本 LAN 使用临时文本节点验证大写协议、无效百分号和分号、编码凭证键均被省略，普通参考 URL 保留，truncated/revision 如实返回。
- 浏览器验收项目与会话已删除，GET 项目、会话及 context 确认404。三个角色素材是可复用的私有目录缓存，保留供后续角色插入；没有生成测试模型产物，也没有删除既有用户素材。

截图与脱敏断言位于 `.local/api-regression-20261006/role-library-ui.png`、`conversation-title-ui.png` 和 `browser-release-results.json`。1198个原生资源基线与冻结核心合同均未修改，原菜单和交互布局沿用。

当前 `toolExecutionAvailable=false` 已在线核对；typed commands 是首批手动用户 API 基础，完整 Agent 工具循环及实时画布同步仍待实现，未把普通模型回复当作画布修改成功。
