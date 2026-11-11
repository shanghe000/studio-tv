# STUDIO character catalog media

角色目录的 415 个角色已有持久化名称与属性，但原 normalized capture 在缺少本地 `media-map` 条目时清空了 `images[].url`。独立的 `studio-character-media-1` 清单修复这批媒体引用，不重建原采集目录、不改变角色身份，不修改 frozen Web 编译资源。

清单记录 415 张 240px 缩略图与 1245 张 768px 三视图（`closeUp`、`fullBody`、`multiView`），总计 1660 个 WebP，66,693,766 字节。每份文件的原始公开来源、固定缩放参数、SHA256、字节数、宽高和内容类型均可核对。二进制仅存在于 ignored `.local/catalog/studio-character-media`；Git 保存清单与重现脚本。缩图由源 CDN 的显式 `imageMogr2` 操作一次性采集，无模型调用。

## 导入与部署

从仓库根目录执行：

```sh
python3 scripts/import-character-media.py --download
python3 scripts/import-character-media.py --verify
```

`--download` 仅补缺失文件，已有文件必须与清单一致；来源重定向、内容变化、非 WebP 或不符合尺寸的响应均失败。`--verify` 完全离线。缓存文件名包含完整 SHA256，不覆盖现有异常文件，不接收用户输入的外部 URL。首次显式捕获使用 `--capture`，有清单时禁止覆盖；新采集版本须另行审核、增加版本并更新升级逻辑。

deployment-host 缓存目录为 `/home/user/apps/rhtv-service/.local/catalog/studio-character-media`。Compose 将同一缓存只读挂至 API 的 `/app/catalog/studio-character-media` 和 Web 的 `/usr/share/nginx/html/studio-character-media`。部署脚本先补齐、离线验证，再启动新镜像；运行时 API 和角色库请求不会连接 CDN。Web 通过内容寻址的 `/studio-character-media/<sha256>.webp` 显示角色图；清单也包含独立缩略图 URL。

`ImportCatalog` 保留 `captured-2026-10-05-v2` 原始内容与审计，随后在 PostgreSQL 事务中登记 `studio-character-media-1`，仅升级完全匹配原始内容的 SYSTEM CHARACTER 行，revision 从 1 变 2；其名称、属性、身份和用户收藏保留。首次冲突或重跑后发现数据、媒体登记或清单审计被改变，返回冲突并回滚，不覆盖异常目录。

选择角色图进入画布后仍使用 `/api/v2/catalog/media/materialize`。请求必须来自已授权 session，引用当前 SYSTEM 资源 revision 和真实 JSON 指针，媒体路径必须已登记。API 校验缓存文件名中的 SHA256后，再走现有本人资产导入、项目归属与签名访问机制。新增路径只允许固定目录下完整 SHA256 文件名；缺失本地文件返回错误，不回退供应商 URL。

## 备份与恢复

`backup-deployment-host.sh` 先离线验证，再额外保存 `character-media.tar.gz` 与 `character-media-manifest.json`。恢复时解包到上述缓存目录，使用对应 Git revision 的清单运行 `--verify`，然后部署。数据库备份仍保留 catalog import 审计和角色版本，资产备份仍保留用户物化后的本人素材。若不恢复缓存，也可由对应版本的 `--download` 重现；来源变化时停止，不接受新的字节替换旧版本。

## 验证

前端回归涵盖三个视图、缩略图、标准角色 ID（包括跨家族冲突规范化后的 `character_298`）与素材 JSON 指针注册。Go 回归涵盖 415 行完整升级、身份属性保留、重复导入与冲突回滚。真实 PostgreSQL/FFmpeg 集成还检查本地 WebP 被导入成可授权本人素材，缓存被篡改后返回 503；不调用任何收费模型。
