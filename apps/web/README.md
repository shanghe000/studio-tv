# Web 工程

这是保留已验证界面的第一阶段工程化。React、Vue/Nuxt、画布、OpenCut 等原组件仍是原生编译产物，并未声称恢复其完整组件源码。自有入口、请求兼容层、身份、项目图转换和数据适配代码已转为源码管理，可独立构建，无外部 research 目录依赖。

## 运行和构建

在仓库根目录先安装已锁定依赖。`npm run dev --workspace @studiotv/web` 启动本地 Vite；默认使用 service 和内部版。`npm run build:preview --workspace @studiotv/web` 或 `npm run build:service --workspace @studiotv/web` 构建到 `apps/web/dist`。

使用 API 的开发模式可设置 `RHTV_MODE=service RHTV_DEV_API_TARGET=http://127.0.0.1:3001`。访问前端同源 `/api/v1`，由 Vite 或生产反向代理转发 API。部署配置放 `/runtime-config.js`，仅包含：

```js
window.__RHTV_RUNTIME_CONFIG__ = {
  mode: 'service',
  apiBase: '/api/v1',
  catalogMode: 'sample-snapshot',
  edition: 'internal',
  features: {community:false,billing:false,publicSharing:false,marketing:false,externalLinks:false}
};
```

部署配置不含服务器密钥、供应商密钥或数据库信息，不接受第三方 API 地址。服务端将后端实际地址藏在反向代理后。

## 两种明确运行模式

- `preview`：保留原来的本机预览身份、IndexedDB 素材、localStorage 项目和模拟接口。用于视觉、动画及交互基准。
- `service`：真实 HttpOnly 刷新会话、内存 Bearer、服务器项目 ID、强 ETag 快照保存、正式素材上传。不会将接口失败退回本地预览，未知或尚未实现功能返回错误。角色、模型、技能、应用等目录目前明确使用只读 sample-snapshot；收藏等写入没有本地成功兜底，后续接已预留目录接口。

原生编译组件依赖 `Rh-Accesstoken` 等 cookie/localStorage 名称。`src/api/auth.ts` 提供内存兼容视图，原生读取结果来自真实会话，setter 不落盘；实际刷新令牌仍是服务器设置的 HttpOnly cookie。切换为 service 时清除原 preview 的身份痕迹。

公司版本只使用飞书统一登录。登录前读取 `GET /api/v1/auth/config`，若 `configured=false` 将后端不可用原因映射为面向员工的中文提示，不创建本机身份；配置就绪时整页跳转同源 `loginUrl?returnTo=...`。OAuth 完成后回到站内路径，通过 HttpOnly cookie 刷新真实会话；回调 URL 不传递 token。原生密码/验证码/Google 窗口由自有样式隐藏，旧登录请求明确不可用，没有密码回退。飞书/IPAC 供应商密钥仅在后端，公共运行配置不包含任何凭据。

## 内部产品配置

`edition` 默认 `internal`，五个功能默认关闭：社区、充值会员与账单、对外分享/发布、营销活动与首页灵感、RunningHub/社交群等对外导航。保留项目、素材、技能和原生画布及嵌入编辑器。自有 feature policy 同时控制导航和动态菜单显示、直接页面路径、旧接口和新 API 客户端；禁止功能返回 403 `FEATURE_DISABLED`，不会模拟成功。后端也应独立执行相同策略，前端隐藏不能代替服务端授权。

`edition:'external'` 默认恢复五项；也可以在 `features` 中按布尔值覆盖。模式与版本独立，例如显式 `mode:'preview',edition:'internal'` 可以验收内部版交互，`mode:'preview',edition:'external'` 用于原复刻基线对照。修改配置后重新加载页面。所有入口隐藏与登录调整位于自有 TypeScript/CSS 运行层，不修改 native 编译文件。

## 图保存

`src/service/graph.ts` 将 native 图映射为冻结的 `ProjectGraph`：节点额外原生属性存 `data.__rhtv.native`；唯一 ID 为 `rhtv_meta_v1`、type 为 `__rhtv_meta` 的元节点保存 graph meta 与按连线 ID 索引的 UI 扩展。加载时先解析元节点再传给原画布，因此元节点不显示在编辑器里。保留分组、样式、绑定；清除凭据并拒绝未上传的 blob/本机素材地址。已上传 URL 转成 `rhtv-asset:<assetId>`，加载时由服务器重新取临时访问地址。

同步原画布的 fixture 读取前，先异步取得当前项目和图；列表返回前也预加载所展示项目。更新通过 `/projects/:id/snapshot` + `If-Match`，收到 412 暂停自动保存，保留当前内存修改，不自动覆盖服务器。不提供多人协同，Yjs 此阶段仅管理本地编辑、撤销重做。

退出页面前若有未保存操作，浏览器会提示。不要把客户端自动保存当成多人协同或离线恢复保证。服务模式不把私有图另存到 preview IndexedDB。

## 原生文件与嵌入应用

`public/project/assets`、`public/_nuxt`、`public/opencut/assets`、`public/hyperframes-studio/assets` 保持基线字节。`scripts/build-frame.mjs` 编译自有 iframe 边界并统一原生深路径入口，不重编译原站组件。OpenCut 导回媒体仍走正式资产上传；HyperFrames/Studio 的服务器工作区及 AI 接口明确未实现。

`npm run typecheck --workspace @studiotv/web` 和 `npm run test --workspace @studiotv/web` 检验身份请求边界、版本冲突、图格式及扩展恢复。仓库基线校验还应核对不可变原生资源 SHA256。
