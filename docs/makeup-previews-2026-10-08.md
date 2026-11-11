# 妆容示例图修复（2026-10-08）

报告项目 `prj_81d7005480d947f7a9ba63ab68c823f2`，“工具验收原图” → 人物调节 → 妆容调节。

## 原因与改动

浏览器复现：现代·人设分类有 26 个选项，但图片元素为 0，空白占位为 26。不是图片请求失败；STUDIO 自有语义配方 `portrait-recipes.json` 中的 `coverUrl` 原本就是空字符串。

从之前只读采集的原站公开目录 `.local/model-feature-audit/live-portrait-readonly.json`，按原选项 ID 和中文名称严格匹配全部 83 个妆容配方，获取 400px WebP 示例图。文件随仓库构建发布到 `/studio-makeup-media/<sha256>.webp`（合计 703,900 字节）。版本化清单 `apps/web/src/service/catalog/makeup-previews.json` 保存原公开 URL、配方 ID、名称、版本、尺寸、字节数和 SHA256，部署不依赖本地采集记录或访问原站。原生冻结资源没有修改。

`makeup-previews.ts` 仅给匹配的 SYSTEM makeup 配方补展示用封面。USER 上传、自定义妆容、其他工具及不匹配的配方不受影响。不修改后端不可变提示词目录、promptCode 或 referenceImageUrl；原生内置妆容的 selector 不含 coverUrl，图片输入仍只有用户原图。原站示例图用于选项预览，不是 STUDIO 模型实际生成效果，不能承诺输出与示例一致。

## 验证

- 83/83 对应本地文件，逐一验证 SHA256、字节长度、WebP 文件头；采集时核验内容类型和解析尺寸。
- 资源适配、图片语义工具及预览专项：50 项测试通过。
- Web 构建（含 TypeScript）通过；1,198 份原生资源基线校验通过。
- deployment-host Web 已部署。在报告项目中逐个打开五个分类，图片解码成功数分别为现代·人设 26/26、古装·人设 27/27、剧情·节点 12/12、年代·风格 11/11、特效·设定 7/7；全部来自同源 `/studio-makeup-media/`。点击“冷峻时尚”后选中标识与当前所选名称正确。未提交新的生成任务。

本次仅修复示例图显示，不把全部 83 种妆容升级成逐项生成验收通过。
