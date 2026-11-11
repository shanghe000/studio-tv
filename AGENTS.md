# Studio TV Service 工作约定

- 保留 `ui-baseline-v0.1.0` 作为已验证界面基线；`apps/web/public/project/assets`、`_nuxt`、`opencut`、`hyperframes-studio` 的原生编译资源未经专门迁移不可改动。自有接口和存储代码放 `src`。
- 冻结 `contracts/openapi.json`/`yaml` v1.0.0；新增能力用独立扩展并标明 IMPLEMENTED/RESERVED。未实现返回501，未知路径404，禁止假成功。
- preview 和 service 只启用一种数据来源；service 使用服务端鉴权、资产ID和版本控制，无假用户、原站认证或自动回落模拟数据。
- 模型能力通过现有供应商中立接口接入；新增供应商、模型参数与回调认证须按实际服务配置。未接入能力返回501，不默认调用未经用户授权的收费模型。
- 密钥、密码、令牌仅在环境配置/秘密目录，不进入Git、浏览器资源或日志。
- 构建必须从本仓库+锁文件复现，不依赖开发者电脑上的外部目录。

## 画布产品方向

- 不向网页用户暴露版本管理、本地/服务器版本比较、草稿合并选择或备份导入导出流程。用户只需编辑画布、查看节点占用和必要的同步状态；内部一致性校验、操作排序及本机持久保护由系统负责，不能以隐藏提示代替修复错误同步。
- 创建节点并连线、断线后重连、调整参考顺序和历史选择、修改参数后再次生成是正常操作，必须共同验证原生交互、自动保存和生成输入。模型不支持的组合须在连线/提交前明确定位，不得创建任务后才因可预知输入问题失败。
- 后台可保留 CAS、节点占用、操作记录和本机保护数据；不能为了消除提示覆盖未知提交结果、丢弃本地修改或把未保存内容标成成功。
- 当前产品优先单人画布的流畅性。每张画布由服务端授予一个账号编辑权，其已验证的多个页面可同时编辑。刷新或另开设备先取最新内容，只更新本页凭据，不移交或撤销同账号其他页面。其他账号只读，有编辑资格的成员可申请交接。浏览器只保留已确认状态的显示镜像与未确认操作队列，实时编辑不得维护可独立分叉的本地完整画布版本并进行三方合并。

## 使用指南随功能维护

- 正式使用指南的维护源为 `docs/user-guide/`（正文、截图清单、样式和交互），截图位于 `apps/web/public/guide/images/`。运行 `python3 scripts/build-user-guide.py` 生成 `apps/web/public/guide/index.html`，随网页镜像发布到 `/guide/`；不要直接手改生成的 HTML。首页顶部导航保留“使用指南”入口，构建时不可把独立指南改写成应用页面。
- 每次新增、调整或下线用户功能时，在同一变更中同步更新指南，包括入口、操作步骤、模型选择、参数限制和可用状态；涉及画布、2D画板、资产或协作等功能时检查对应章节。没有用户可见变化的内部修改无需改指南。
- 延续现有简洁中文、编号步骤和截图版式。每种可实际打开的操作面板尽量提供真实截图及简短步骤；相同面板的不同预设可合并说明。功能或界面变化时同步替换相关截图，不能只改文字。只写已实际开放的能力；未接入、暂停和有限支持须明确标注，不能把可见菜单或测试通过写成全部效果保证。
- 发布前运行 `python3 scripts/build-user-guide.py --check`，确认首页入口、章节导航、图解展开、截图放大和窄屏阅读正常，并确认部署的指南包含本次功能变化。截图须已加载完整、关键按钮清楚无遮挡；截图和示例不得带入密钥、签名下载地址或无关用户数据。

## Publication

- Keep new repositories private during preparation. Run `python3 scripts/check_publication.py`, project tests and a full-history credential scan before requesting publication.
- Write product documentation for readers. Do not publish internal handoff reports, workstation paths, historical deployment receipts or unfinished scaffold instructions.
- Preserve third-party attribution. Missing source or distribution permission is a release blocker, not a branding issue.
- Do not force-push history, change visibility, disable failing checks or replace integrity fingerprints merely to obtain a passing result.
