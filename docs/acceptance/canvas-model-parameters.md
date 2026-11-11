# 画布模型参数核算（2026-11-04）

当前无个人 Key 的只读目录共 84 项。去掉 20 个测试配置与 2 个仅供历史兼容的通用入口，以下 62 个按公开模型、用途和参数版本分别计算。36 个官方视频档需要对应个人 Key；“可选”表示目录已开放，多数仍需描述或素材。

这里枚举的是**请求体不同**的有限参数组合。提示词、用户/素材 ID、位置和尺寸等连续变量不作为有限选项；图、视频、音频输入数另见[视频素材数量矩阵](canvas-video-counts.md)。人物对应属于有序数组，两端各不重复、各有 0–4 五个编号、1–5 组，所以是 Σ[P(5,k)²] = 32,825。若忽略数组行顺序，是 1,545 个不同配对关系；不代表输入素材中一定有五个人。

| 模型标识 | 版本 | 生成类型 / 模式 | 离散字段及取值个数 | 参数组合 | 无个人 Key |
|---|---:|---|---|---:|---|
| codex-5-6-text-v1 | 2 | LLM | reasoningEffort 2 | 2 | 可选 |
| codex-6-text-v1 | 2 | LLM | reasoningEffort 2 | 2 | 可选 |
| codex-6-vision-text-v1 | 2 | IMAGE_UNDERSTANDING | reasoningEffort 2 | 2 | 可选 |
| codex-6-1-text-v1 | 2 | LLM | reasoningEffort 2 | 2 | 可选 |
| codex-6-1-vision-text-v1 | 2 | IMAGE_UNDERSTANDING | reasoningEffort 2 | 2 | 可选 |
| codex-image-generate-v1 | 3 | TEXT_TO_IMAGE | count 3 × transparentBackground 2 | 6 | 可选 |
| codex-image-edit-v1 | 3 | IMAGE_TO_IMAGE | count 3 × transparentBackground 2 | 6 | 可选 |
| flux1-dev-generate-v1 | 1 | TEXT_TO_IMAGE | outputPreset 1 | 1 | 可选 |
| flux2-klein-9b-generate-v1 | 1 | TEXT_TO_IMAGE | outputPreset 1 | 1 | 可选 |
| qwen-image-edit-2511-v1 | 1 | IMAGE_TO_IMAGE | outputPreset 1 | 1 | 可选 |
| seedvr2-image-enhance-v1 | 1 | IMAGE_ENHANCE | outputPreset 1 | 1 | 可选 |
| z-image-turbo-generate-v1 | 1 | TEXT_TO_IMAGE | count 4 × outputPreset 1 | 4 | 可选 |
| flux2-klein4b-generate-v1 | 1 | TEXT_TO_IMAGE | count 3 × outputPreset 1 | 3 | 可选 |
| h3-first-frame-v1 | 4 | FIRST_FRAME | outputPreset 24 | 24 | 可选 |
| h3-first-last-frame-v1 | 4 | FIRST_LAST_FRAME | outputPreset 72 | 72 | 可选 |
| h3-reference-v1 | 4 | OMNI_REFERENCE | outputPreset 72 | 72 | 可选 |
| h3-video-reference-v1 | 4 | OMNI_REFERENCE | outputPreset 72 | 72 | 可选 |
| h3-drama-reference-v1 | 3 | OMNI_REFERENCE | outputPreset 50 | 50 | 可选 |
| h3-action-reference-v1 | 3 | OMNI_REFERENCE | outputPreset 24 | 24 | 可选 |
| h3-sgun-long-reference-v1 | 3 | OMNI_REFERENCE | outputPreset 48 | 48 | 可选 |
| h3-tr-pika-twopass-ref-v1 | 3 | OMNI_REFERENCE | outputPreset 25 | 25 | 可选 |
| h3-motion-transfer-v1 | 2 | MOTION_TRANSFER | outputPreset 12 | 12 | 可选 |
| wan-animate2-motion-transfer-v1 | 1 | MOTION_TRANSFER | outputPreset 12 | 12 | 可选 |
| scail2-motion-transfer-v1 | 1 | MOTION_TRANSFER | outputPreset 12 × subjectMapping 32,825 | 393,900 | 可选 |
| scail2-person-replacement-v1 | 1 | MOTION_TRANSFER | outputPreset 12 × subjectMapping 32,825 | 393,900 | 可选 |
| moss-image-generate-v1 | 1 | TEXT_TO_IMAGE | outputPreset 6 | 6 | 可选 |
| h3-official-text-to-video-v1 | 1 | TEXT_TO_VIDEO | outputPreset 36 | 36 | 置灰 |
| h3-official-first-frame-v1 | 1 | FIRST_FRAME | outputPreset 6 | 6 | 置灰 |
| h3-official-first-last-frame-v1 | 1 | FIRST_LAST_FRAME | outputPreset 6 | 6 | 置灰 |
| h3-official-omni-reference-v1 | 1 | OMNI_REFERENCE | outputPreset 36 | 36 | 置灰 |
| h3-official-last-frame-v1 | 1 | LAST_FRAME | outputPreset 6 | 6 | 置灰 |
| h3-highspeed-official-text-to-video-v1 | 1 | TEXT_TO_VIDEO | outputPreset 36 | 36 | 置灰 |
| h3-highspeed-official-first-frame-v1 | 1 | FIRST_FRAME | outputPreset 6 | 6 | 置灰 |
| h3-highspeed-official-first-last-frame-v1 | 1 | FIRST_LAST_FRAME | outputPreset 6 | 6 | 置灰 |
| h3-highspeed-official-omni-reference-v1 | 1 | OMNI_REFERENCE | outputPreset 36 | 36 | 置灰 |
| h3-highspeed-official-last-frame-v1 | 1 | LAST_FRAME | outputPreset 6 | 6 | 置灰 |
| h3-lite-official-text-to-video-v1 | 1 | TEXT_TO_VIDEO | outputPreset 36 | 36 | 置灰 |
| h3-lite-official-first-frame-v1 | 1 | FIRST_FRAME | outputPreset 6 | 6 | 置灰 |
| h3-lite-official-first-last-frame-v1 | 1 | FIRST_LAST_FRAME | outputPreset 6 | 6 | 置灰 |
| h3-lite-official-omni-reference-v1 | 1 | OMNI_REFERENCE | outputPreset 36 | 36 | 置灰 |
| h3-lite-official-last-frame-v1 | 1 | LAST_FRAME | outputPreset 6 | 6 | 置灰 |
| h3-max-official-text-to-video-v1 | 1 | TEXT_TO_VIDEO | outputPreset 36 | 36 | 置灰 |
| h3-max-official-first-frame-v1 | 1 | FIRST_FRAME | outputPreset 6 | 6 | 置灰 |
| h3-max-official-first-last-frame-v1 | 1 | FIRST_LAST_FRAME | outputPreset 6 | 6 | 置灰 |
| h3-max-official-omni-reference-v1 | 1 | OMNI_REFERENCE | outputPreset 36 | 36 | 置灰 |
| h3-max-official-last-frame-v1 | 1 | LAST_FRAME | outputPreset 6 | 6 | 置灰 |
| seedance-2-5-official-text-to-video-v1 | 1 | TEXT_TO_VIDEO | generateAudio 2 × outputPreset 72 × returnLastFrame 2 | 288 | 置灰 |
| seedance-2-5-official-first-frame-v1 | 1 | FIRST_FRAME | generateAudio 2 × outputPreset 12 × returnLastFrame 2 | 48 | 置灰 |
| seedance-2-5-official-first-last-frame-v1 | 1 | FIRST_LAST_FRAME | generateAudio 2 × outputPreset 12 × returnLastFrame 2 | 48 | 置灰 |
| seedance-2-5-official-omni-reference-v1 | 1 | OMNI_REFERENCE | generateAudio 2 × outputPreset 3 × returnLastFrame 2 | 12 | 置灰 |
| seedance-2-0-official-text-to-video-v1 | 1 | TEXT_TO_VIDEO | generateAudio 2 × outputPreset 72 × returnLastFrame 2 | 288 | 置灰 |
| seedance-2-0-official-first-frame-v1 | 1 | FIRST_FRAME | generateAudio 2 × outputPreset 72 × returnLastFrame 2 | 288 | 置灰 |
| seedance-2-0-official-first-last-frame-v1 | 1 | FIRST_LAST_FRAME | generateAudio 2 × outputPreset 72 × returnLastFrame 2 | 288 | 置灰 |
| seedance-2-0-official-omni-reference-v1 | 1 | OMNI_REFERENCE | generateAudio 2 × outputPreset 72 × returnLastFrame 2 | 288 | 置灰 |
| seedance-2-0-fast-official-text-to-video-v1 | 1 | TEXT_TO_VIDEO | generateAudio 2 × outputPreset 36 × returnLastFrame 2 | 144 | 置灰 |
| seedance-2-0-fast-official-first-frame-v1 | 1 | FIRST_FRAME | generateAudio 2 × outputPreset 36 × returnLastFrame 2 | 144 | 置灰 |
| seedance-2-0-fast-official-first-last-frame-v1 | 1 | FIRST_LAST_FRAME | generateAudio 2 × outputPreset 36 × returnLastFrame 2 | 144 | 置灰 |
| seedance-2-0-fast-official-omni-reference-v1 | 1 | OMNI_REFERENCE | generateAudio 2 × outputPreset 36 × returnLastFrame 2 | 144 | 置灰 |
| seedance-2-0-mini-official-text-to-video-v1 | 1 | TEXT_TO_VIDEO | generateAudio 2 × outputPreset 36 × returnLastFrame 2 | 144 | 置灰 |
| seedance-2-0-mini-official-first-frame-v1 | 1 | FIRST_FRAME | generateAudio 2 × outputPreset 36 × returnLastFrame 2 | 144 | 置灰 |
| seedance-2-0-mini-official-first-last-frame-v1 | 1 | FIRST_LAST_FRAME | generateAudio 2 × outputPreset 36 × returnLastFrame 2 | 144 | 置灰 |
| seedance-2-0-mini-official-omni-reference-v1 | 1 | OMNI_REFERENCE | generateAudio 2 × outputPreset 36 × returnLastFrame 2 | 144 | 置灰 |

当前开放档 788,250 种；需另配凭据的型号 3,060 种。合计 791,310 种。排除人物数组的独立维度后，有 3,534 项标量参数组合。

可复算：`python3 scripts/canvas-model-parameter-audit.py --check`。Web 单测 `canvas-catalog-parameter-audit.test.ts` 对每个参数控件与正式目录比较，再经实际参数序列化函数逐个检验各字段乘积。两个 SCAIL 档的 32,825 个有序配对逐一通过各自的控件及请求校验；其 12 种输出预设独立验证，未重复执行 12 次相同配对循环。

最后一跳：`canvas-catalog-submissions.test.ts` 为每个具名型号使用真实提交适配器生成一次 /canvas-runs 请求；`python3 scripts/test-canvas-router-hop.py --router <Router仓库>` 使用实际 Router 源码（本次 c8dc968），分别截获 19 种私有生成 HTTP 请求、36 种条件性厂商 HTTP 请求和 7 种 Codex turn/start。可设置 STUDIO_CANVAS_ROUTER_REQUESTS 为 STUDIO 实际工作进程导出的 InvocationRequest 数组、STUDIO_CANVAS_MEDIA_DIR 为用 SHA-256 命名的隔离文件目录，通过 --summary 输出每个型号的重放数；按原始 JSON 字节 SHA-256 和行号核对每个封包恰好到达一次，并检查角色、素材和参数。另测 2 个不在新菜单的历史 Codex 入口（文本、视觉 @1）。已回归两处在终端发现的错误：Seedance 两个服务开关误入视觉条件，以及普通脚本/分镜 JSON 误作视觉条件。Codex 图片输入为 PNG/JPEG/WebP，每张至多 10 MiB、合计至多 16 MiB。只到发送边界，未验证 GPU 质量、供应商可用性、账号额度或成片。

独立的 Router 入站验收：`scripts/test-canvas-router-ingress.py` 用 STUDIO 工作进程原始 JSON 和隔离签名凭证请求真实 Router HTTP 服务，以 PostgreSQL 保存不可变排队收据；真实工作进程分别提交 Qwen 参考编辑、H3 首尾帧、H3 动作迁移、Seedance 2.5 首帧、Codex 6.1 文本。前三条发到本机 HTTP 测试服务；Seedance 使用隔离凭据库和不出网的官方传输替身，Codex 使用实际 app-server 适配器及模拟原生 JSON-RPC。检查发送一次以及同一收据的状态（异步视频/图像 RUNNING、Codex 模拟终态 SUCCEEDED）。此五例已包括在上面的型号样本中。
