# Studio TV 使用指南维护源

指南由本目录的文字和截图清单生成。正式页面位于
`apps/web/public/guide/index.html`，图片源位于同目录的 `images/`。
生成结果不依赖原截图采集目录、网络、本机字体或 PDF 工具。

## 文件

- `guide.json`：五章导航、章节源文件、功能图解分组和标题。
- `sections/*.html`：正文维护源。保留原有文字；可以直接调整 HTML，或加入下述占位符。
- `screenshots.json`：实际采用的截图、图注及每图不超过三条操作步骤。
- `styles.css`、`interaction.js`：共用版式及截图放大交互。
- `coverage-plan.json`：待补截图的建议位置。它是采集计划，不能作为已截图或功能开放证明，也不会显示给用户。
- `apps/web/public/guide/images/`：仓库内的原始发布图片。已有五张概览图从旧 HTML 无损提取；新图优先使用清晰、裁切适当的 WebP 或 PNG。

## 构建

从仓库根目录执行：

```sh
python3 scripts/build-user-guide.py
python3 scripts/build-user-guide.py --check
python3 scripts/test-user-guide.py
```

脚本仅使用 Python 标准库，可以从其他工作目录用脚本路径运行。
在线页面引用单独图片，所有截图均为懒加载，保留真实图片尺寸。图片地址含内容摘要，同名重拍后会自动更新缓存地址。
点击缩略图放大；可切换“原图尺寸”并滚动查看小字，再切回“适合屏幕”。按 Escape 或关闭按钮返回。

需要离线单文件交付时，显式指定输出文件：

```sh
python3 scripts/build-user-guide.py --self-contained-output /path/to/Studio-TV-使用指南.html
```

此导出使用相同正文和图片字节，将图片嵌入 HTML。它与在线版的图片存储方式不同，不是另一份需要手动维护的文字源。

## 添加图解

把干净截图保存到 `apps/web/public/guide/images/`，然后在
`screenshots.json` 的 `items` 中增加条目：

```json
{
  "id": "image-angle-panel",
  "group": "s2-image-angle-light",
  "file": "image-angle-panel.webp",
  "caption": "调整角度后生成新图片",
  "alt": "角度面板中的左右、俯仰和远近选项",
  "order": 1,
  "steps": ["选中图片并打开角度。", "调整参数，再点击生成。"]
}
```

图片 `file` 是 `images/` 内的相对路径，不是 URL。PNG/WebP 尺寸会从真实文件读取；也可显式提供 `width`、`height`，脚本会核对。其他支持的静态图片需填写尺寸。
图注和步骤只写读者需要的操作，不放任务编号、测试标记、签名链接或内部实现。
截图应逐张检查是否有密钥、地址栏令牌、历史报错或无关用户资料。

正文有三种占位符：

```html
{{figure:overview-canvas}}
{{gallery:s2-image-angle-light}}
{{figures:s2-image-angle-light}}
```

- `figure` 放置指定截图；适合章首概览。
- `gallery` 按清单顺序生成可展开的功能图解，带统一图注、放大按钮和步骤。未收到实际截图时不显示空分组。
- `figures` 只生成该组图片，供需要自定义 `<details>` 的正文使用。不要在另一位置重复引用同一图片。

分组标题与所属章节在 `guide.json.groups` 配置。多图默认两列，窄屏自动一列；需要保持全宽时，给分组设置 `"columns": 1`。每组可按功能拆成几个更小的图解，避免一条长列表堆满所有面板。
新增分组后须在相应章节放入占位符；缺文件、错分组、重复 ID、超过三步或未被正文采用的截图会阻止构建。

## 发布检查

先构建并运行 `--check`。确认五章正文和图片可读、功能状态准确，再检查首页入口、章节导航、展开图解、图片放大与窄屏阅读。
页面构建不能将指南改写为应用入口。应用、路由或缓存配置由工程自身维护。
