# Studio TV

面向图像与视频创作的画布工作台，连接项目、素材、生成任务与模型服务。

**状态：开发中。** 目前需要独立配置身份服务和模型路由，尚不提供开箱即用的独立部署版本。

## 项目结构

| 目录 | 内容 |
| --- | --- |
| `apps/web` | TypeScript / Vite 前端及画布适配层 |
| `apps/api-go` | Go API、权限检查、任务与数据库迁移 |
| `contracts` | API 与事件协议 |
| `infra` | 容器、代理与观测配置 |
| `docs/user-guide` | 使用指南源文件 |

模型调用由 [Studio Model Router](https://github.com/shanghe000/studio-model-router) 承担；视频工作流位于 [Studio Video API](https://github.com/shanghe000/studio-video-api)。

## 本地开发

需要 Node.js 22.12+、Go 1.25+、Python 3.10+；完整服务还需要 PostgreSQL 17、媒体处理工具和身份服务。

```sh
npm ci
npm run typecheck
npm run test:web
npm run build
```

API 配置项见 [.env.example](.env.example)。在自己的环境中配置数据库、签名密钥和身份服务，然后运行 `npm run dev:api` 与 `npm run dev:web`。模型服务未配置时不会自动启用模拟推理。

## 功能与边界

项目包含画布保存、素材管理、生成任务和多模态模型接口。各节点能力与限制见 [功能台账](docs/canvas-node-status.md)。身份接入使用 IPAC 协议及其会话状态扩展，不能仅替换为任意 OIDC 地址。

部分前端资源为第三方编译产物，尚无完整的可编辑源代码；分发范围见 [第三方组件](THIRD_PARTY.md)。资源完整性与运行环境验证完成前，不提供正式发行包。

## 验证与贡献

```sh
npm run verify
python3 scripts/build-user-guide.py --check
python3 scripts/check_publication.py
```

数据库集成测试需要显式配置隔离环境；没有数据库配置时的本地测试不代表数据库验证完成。

[贡献指南](CONTRIBUTING.md) · [安全政策](SECURITY.md)
