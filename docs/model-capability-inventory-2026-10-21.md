# Studio TV 生成能力与 ComfyUI 接入统计

**2026-10-22 增量更新：**已在原接入基础上新增 Z-Image-Turbo · BF16、FLUX.2 [klein] 4B · FP8 批量生图，以及 MiniMax H3 · SGUN 潜空间连续长片。当前云端私有服务共 **18 个 profile**，其中 **9 个 Comfy 固定 profile 对 Router／STUDIOTV 发布**；此次三项均已发布并通过服务健康与能力门禁检查。图片数量、20／30秒长片的实测、质量边界及本轮画布验收记录见 [批量图片与长片部署报告](comfy-batch-and-longform-2026-10-22.md)。

以下保留 **2026-10-21 接入批次的历史记录**。“本轮6个”“共15个”及当时的 RESERVED 状态均指该历史批次，不应覆盖上面的增量更新。原始工作流、首帧／首尾帧、文戏／武戏及模型软连接继续保留；新增长片使用独立工作流。

更新：2026-10-22，记录 2026-10-21 批次接入。本文区分当前产品入口、已有真实供应能力和本次新增接入。**本轮 6 个固定 profile 已完成云端 GPU 验收，并发布到 ComfyUI 私有服务、Router 和 Studio TV；Studio TV 画布中的 FLUX.1 生成、H3 文戏、H3 武戏和 SeedVR2 放大也已完成真实端到端验收。**FLUX.2 和 Qwen 编辑已通过云端逐模型验收，但没有追加整套浏览器生成测试。`IMPLEMENTED` 表示已有实现；`RESERVED` 表示暂未打通，不能以工作流文件存在或测试占位冒充真实能力。

改动前审计基线：Studio TV 本地与 deployment-host 均为 `1ea481c10c0ac3ecfef779d1a697ba3f0cbbaef3`。Router 原目录 33 项，其中 13 项真实、20 项 TEST MODE；13 项包括 2 项旧默认文本/视觉配置、5 项显式文本/视觉配置、2 项图片工具配置及 4 项视频配置。本轮追加下文 6 项已验收 Comfy 能力；普通菜单过滤旧默认配置、TEST MODE 和被新文武戏替代的旧全能参考选项，历史 ref/version 保留精确解析。

## 20 类产品能力

| 能力 | 产品生成入口与用途 | 基线真实实现 | 本次 ComfyUI 接入／边界 |
|---|---|---|---|
| 语言与理解 | 首页/画布 Agent，普通文本，剧本、分镜规划，提示词优化，歌词，图片解析、风格提取 | IMPLEMENTED：公司配置的 gpt-5.6-sol、gpt-6-sol、gpt-6.1-sol 文本；后两者有图片理解 | 视频/音频理解仍 RESERVED，不能把视频生成模型用于分析 |
| 文生图 | 图片节点、角色/场景设计、分镜图、草图手动生成 | IMPLEMENTED：Codex 图像工具，宿主与图像工具是不同概念 | 已发布 FLUX.1 [dev]、FLUX.2 [klein] 9B · KV FP8；均固定 1024×1024 |
| 图生图与参考图 | 普通参考编辑、角色/风格、三视图、全景图 | IMPLEMENTED：Codex 参考图编辑 | 已发布 Qwen-Image-Edit-2511 · Lightning 4步，单图输入、1024×1024 输出；仅支持已映射参数 |
| 生成式局部编辑 | 重绘、擦除、扩图 | IMPLEMENTED：Codex 图像工具 v3 的原图/标记图语义编辑 | 不能声称像素级蒙版保持；新 Qwen 普通参考编辑不会自动获得全部局部工具适配 |
| 抠图与去文字 | 图片抠图、去文字 | IMPLEMENTED：Codex 语义编辑，透明结果另有验证 | 独立分割模型 RESERVED，不把语义抠图称为精确分割 |
| 图层拆分 | 编辑元素、分层 | RESERVED：缺真实分层供应与回填适配 | 存在节点/权重不等于已接通 |
| 图片增强 | 画质增强、放大、高清 | IMPLEMENTED：既有“增强”为 Codex 生成式修复 | 已发布 SeedVR2 3B · FP8 到 IMAGE_ENHANCE，保持比例放大 2 倍；输入最长边≤1024，输出最长边≤2048；提示词不参与处理 |
| 多角度与照明 | 相机、多角度、灯光 | IMPLEMENTED：Codex 参考图语义编辑 | 不承诺精确三维/光学变换；独立专用能力 RESERVED |
| 文生视频 | 文本→视频、视频节点纯文本模式 | RESERVED：当前公开视频 profile 需要视觉参考 | 本次不把 Ref2VA 工作流错误注册成纯文生视频 |
| 图生视频 | 首帧、首尾帧 | IMPLEMENTED：既有 H3 FIRST_FRAME / FIRST_LAST_FRAME | 按用户确认继续保留，不映射成 Ref2VA 文/武戏 |
| 全能参考 | 图片、视频、音频组合参考生成 | IMPLEMENTED：原图片音频参考、含视频参考 | 已发布 MiniMax H3 · Cobijada Hybrid INT8 文戏、武戏两个独立 Ref2VA profile；新菜单替换旧全能参考项，旧版本可精确解析 |
| 视频编辑与续写 | 编辑、延长、动作迁移、片段重拍 | RESERVED | 参考生成不能冒充精确编辑或续写 |
| 视频增强与修复 | 超分、增强、降噪、补帧、去水印/字幕/模糊 | RESERVED | 明确不发布文戏 A/B/C/D 增强工作流及云端 2K 分支 |
| 视频深度 | 深度捕捉/转换 | RESERVED | 不从 H3 附带声称此能力 |
| 语音生成 | 文本转语音、音色、对口型关联入口 | RESERVED | 已盘点 Qwen3-TTS/Fish S2 工作流和缓存权重；仍缺独立任务映射与合成验收，见后文 |
| 音乐生成 | 音乐、歌曲、歌词配乐 | RESERVED | ACE-Step、MiniMax Music3、Stable Audio 3、YuE2 确有工作流和权重；未完成音频任务协议及验收 |
| 音频参考生成 | 参考音色、声音克隆、音频生音频 | RESERVED | Qwen3-TTS/Fish 克隆流、MMAudio 拟音流仍未对接；上传 H3 参考音频不等于独立输出音频 |
| 音频分离 | 全部音轨、人声、环境音 | IMPLEMENTED：FFmpeg 完整音轨提取 | 人声/环境音模型分轨 RESERVED |
| 3D 模型生成 | 文本/图片/多视图生成模型与纹理 | RESERVED | 已有 SHARP 高斯改视角流及权重，但产物为 PLY 高斯点，未适配 STUDIO 网格/资源协议；导演灰模布局识别不等于网格生成 |
| 3D 世界生成 | 文本/图片/视频生成世界 | RESERVED | 不公开未实现目录 |

入口与底层模型不是一一对应。一个图片编辑工具可服务多个语义入口；FFmpeg 的裁剪、变速、倒放、镜像、旋转、抓帧、提取整轨属于本地媒体处理，不统计为生成模型。完整原生入口盘点见 [功能矩阵](model-function-matrix.md)；能力需求来自 `modelgateway/application/requirements.go`，具体运行类型映射来自 `web/src/service/execution.ts` 的 `nativeKinds`。

## 本轮 6 个已发布模型与验收

云端私有服务保留原 9 个 profile，加上本轮 6 个，共 15 个。新项均为 `available=true, runtime_validation=VERIFIED`；每项固定 API 图及验收记录均钉 SHA-256，运行时不接受任意工作流、权重名或采样参数透传。原始 ComfyUI 文武工作流、模型软连接、旧 U02/U06 接口未改，A/B/C/D 增强工作流未发布。

| Router 公开 ref | 真实模型／工作流 | 云端固定 profile | 新 GPU 实测 |
|---|---|---|---|
| `flux1-dev-generate-v1` | FLUX.1 [dev] | `comfy.flux1.dev.t2i.v1` | 1024×1024，原 20 步；65.14 秒 |
| `flux2-klein-9b-generate-v1` | FLUX.2 [klein] 9B · KV FP8 | `comfy.flux2.klein9b.t2i.v1` | 1024×1024，原 4 步；48.79 秒 |
| `qwen-image-edit-2511-v1` | Qwen-Image-Edit-2511 · Lightning 4步 | `comfy.qwen.edit2511.v1` | 单图编辑到 1024×1024，原 4 步；108.46 秒 |
| `seedvr2-image-enhance-v1` | SeedVR2 3B · FP8 | `comfy.seedvr2.image.upscale.v1` | 单图 512×512→1024×1024；16.75 秒 |
| `h3-drama-reference-v1` | MiniMax H3 · Cobijada Hybrid INT8 · 单采极速文戏 | `comfy.h3.drama.ref.v1` | 单图参考，864×480，124 帧／24fps；128.84 秒，冷加载 |
| `h3-action-reference-v1` | MiniMax H3 · Cobijada Hybrid INT8 · 最强武戏 | `comfy.h3.action.ref.v1` | 单图参考，864×480，124 帧／24fps；32.95 秒，热模型 |

以上是本机 RTX 5090 的单次验收耗时，包含不同缓存状态，不能据此认定武戏恒比文戏快，也不是排队等待或生产延迟承诺。文戏回调实测为 5 个采样步；保留 DMAD 4step LoRA、beta 与原 sigma 扩展配置，不因 LoRA 名字称其为固定 4 步，也不把节点的扩展参数误加为“6 步”。武戏手工 sigma 配置回调实测为 10 步。

此外，**正式私有 API 已验收 SeedVR2 1024×1024→2048×2048**：任务 `0d4bb2ba-6a7c-4ab9-b269-935d7eddf0e7` 成功，耗时 10.03 秒，返回 PNG 的下载 SHA-256 验证通过。观测到 `QUEUED → RUNNING/UPSCALING → RUNNING/ARCHIVING → SUCCEEDED`；运行阶段 `progress=null`，成功后才为 `1`。它的内部 20／45／95／100 是编码、超分、解码、后处理的加权里程碑，不是真实扩散采样步，未作为百分比公开。

验收记录保存在云端 `/root/studio-video-api/acceptance/`，新 profile 存在 `/root/studio-video-api/profiles/`。文戏两个既有 10 秒预设另钉 `h3-drama-existing-presets.json`，已核实际成片存在及文件散列，并逐节点比较模型、LoRA、注意力和 sigma 配置与当前有效链一致。发布图与本轮文武实际提交图也已复核；仅有 ComfyUI 对 FLOAT 字段进行 `1 → 1.0` 等类型转换，数值与结构相同。

## 视频目录与参数约定

本次新增公开 ref 为 `h3-drama-reference-v1`、`h3-action-reference-v1`，均为 `OMNI_REFERENCE`、`modelRef=h3`、`x-video-mode=OMNI_REFERENCE`；原始文/武工作流有不同 LoRA 与采样配置，不能伪装成两种基础权重或首尾帧模型。

STUDIO 以 Router 的 `title` 展示真实模型名和必要工作流差异。尺寸、比例、时长只接受 `properties.outputPreset.enum` 中的完整组合；`x-enum-labels` 优先，`x-output-presets` 可描述 `{value,width,height,aspectRatio,durationSeconds,fps}`。界面不能把不同预设的分辨率、比例、时长任意拼成未经服务支持的组合。

### 本轮新增模型公开预设完整集合

| 模型 | `outputPreset` | 真实输出尺寸／比例 | 时长与帧率 |
|---|---|---|---|
| H3 文戏 | `landscape-480p-5s` | 864×480，9:5 | 约 5 秒，24fps；124 帧，实际约 5.167 秒 |
| H3 文戏 | `portrait-768p-10s` | 768×1376，24:43 | 约 10 秒，24fps；243 帧，实际约 10.125 秒 |
| H3 文戏 | `landscape-736p-10s` | 1280×736，40:23 | 约 10 秒，24fps；243 帧，实际约 10.125 秒 |
| H3 武戏 | `landscape-480p-5s` | 864×480，9:5 | 约 5 秒，24fps；124 帧，实际约 5.167 秒 |
| FLUX.1 [dev] | `1024-square` | 1024×1024，1:1 | 单张图片 |
| FLUX.2 [klein] 9B | `1024-square` | 1024×1024，1:1 | 单张图片 |
| Qwen-Image-Edit-2511 | `1024-square` | 1024×1024，1:1 | 单张图片，API 编辑流按此画布缩放裁切输入 |
| SeedVR2 3B | `2x` | 保持输入比例，宽高放大 2 倍；输入最长边≤1024、总像素≤1048576，输出最长边≤2048 | 单张图片；提示词忽略 |

这些尺寸经 32 像素网格对齐，不应在界面写成精确 16:9／9:16。H3 时长按 `17k+5` 帧格对齐，预设显示“约 5 秒／约 10 秒”，实际帧数、帧率和时长随产物返回。文戏更大尺寸／15 秒的部分旧成片额外启用了 realism LoRA，不能当作当前原始文戏链的同配置验收，因此没有混入本表。原首帧模式保留 864×480、24fps、5 秒；原首尾帧模式保留 864×480、24fps、5／10／15 秒，不套用本表的新 Ref2VA 组合。

文武两项共享 Cobijada H3 Hybrid INT8 基座、Qwen3-VL-32B INT8 ConvRot 编码器、FP16 视频 VAE 和 FP32 音频 VAE。文戏保留 DMAD LoRA，武戏保留 turbo 8step、speed slider、Motion Repair、Combat V2 等原 LoRA 配置；两项代表不同固定工作流，不是两个独立训练的基础模型。它们仅提供全能参考，不能代替首尾帧 conditioner。

新全能参考 API 校验上限为 9 张图、1 段视频、3 段独立音频，合计不超过 12 个参考，至少一个视觉参考，按模态保留顺序。这个数量是输入校验上限，不代表每种满槽组合都经过 GPU 实测。HTTP 参考媒体接受 PNG／JPEG／WebP、H.264 MP4、WAV／MP3，不含 FLAC；参考视频转为模型需要的 24fps，不把视频原声自动当作参考音频。页面与私服各自的文件大小限制仍须同时满足。

模型能力由已鉴权目录判断。新任务将当前媒体输入规则保存到私有执行记录，恢复时保持相同规则；旧 H3 四种历史 ref/version 继续兼容。生成图片/视频贡献当前选中的成片，不把它们过去用于生成的祖先图片重新塞入新任务。

## 实测进度链路

实现：ComfyUI 真实观察 → H3 私有服务 → Router `progress`/`progressDetail` → STUDIO worker → 持久 Plan 与任务事件 → 服务端画布回写 → live-snapshot/SSE → 原生加载卡中的自有进度标签。

- Plan 的 `progress` 是 0–1 或 `null`；画布显示字段为 0–100 或 `null`。
- `scope=SAMPLING` 明确显示“采样进度”，不能把它称为端到端完成百分比。模型加载、排队、解码、保存阶段没有测量时保持 `null`，显示对应阶段文字。
- 只读取已确认采样节点的真实 `value/max`。H3 视频 VAE 解码节点也会发送自己的进度，该数值不混入采样百分比。SeedVR2 只显示 `UPSCALING` 阶段，百分比未知。
- 实际观察或阶段变化才持久化；重复相同观察不增加进度写入。验证产物并导入 STUDIO 后，成功任务才能报 `scope=TASK, progress=1`。失败/取消不伪造 100%。
- 自有前端替换固定原生版本 `K3` 的计时估算标签，保留加载卡、取消按钮和上传进度。所有已确认的 server-managed 任务在未知进度时显示“运行中/排队中”，不继续估算增长。
- 通过 `X-Models-Router-Features: progress-detail-v1` 请求扩展；独立合同为 [generation-progress-extension.json](../contracts/generation-progress-extension.json)。冻结 `contracts/openapi.json`/`yaml` v1 不变。

迁移 `024_measured_generation_progress.sql` 只把顶层 `progressDetail` 加入现有显示字段忽略列表，不修改用户画布内容。嵌套参数、输入版本、素材角色与授权校验保持有效。

## 已有工作流和权重，但本轮仍未接通的能力

下表来自云节点只读库存、后端节点注册信息及实际软连接目标检查。文件可读、节点已注册和部分 CPU 导入检查，仅证明有接入基础，不能证明模型能够稳定完成任务。现有成功历史中没有这些能力的 GPU 合成验收，因此仍为 `RESERVED`。

| 能力／已有工作流 | 已核实的模型及资源 | 尚缺的可执行映射或验收 |
|---|---|---|
| Qwen3-TTS 声音设计／克隆：N06 两份工作流 | `Qwen3-TTS-12Hz-1.7B-Base`、`VoiceDesign`、`CustomVoice` 主权重各约 3.6GiB，语音 tokenizer 各约 0.64GiB；公共缓存软连接可读，`Qwen3TTSModel` CPU 导入成功，Flash Attention 模块存在 | 固定文本、语言、音色描述、参考音频／转录文本协议；模型实际加载、5090 合成及声音质量验收；克隆流的转录节点也须单独核验 |
| Fish Audio S2 Pro 单人／双人／多人：N01／N02／N03 | `s2-pro`、`s2-pro-fp8`、`s2-pro-w4a16` 公共缓存目录及权重、tokenizer、`codec.pth` 实际存在；已跟随目录软连接核实，并非空缓存 | 说话人标签与多参考音频映射、codec 与推理依赖实际加载、单卡生成验收；未开放为 STUDIO 独立语音模型 |
| ACE-Step 音乐：N05 | ACE-Step 1.5 XL Turbo DiT、`qwen_0.6b_ace15`、`qwen_4b_ace15`、`ace_1.5_vae` 权重可读，核心节点已注册 | 描述／歌词／语言／节拍／秒数的固定合同，音频产物回填及实际生成验收 |
| MiniMax Music3 音乐：N08 | Music3 DiT FP32／FP16／INT8、约 17.2GiB 文本编码器、DAV 音频解码模型已有公共缓存链接，Music3 核心节点已注册 | 歌词、全局描述与时长映射；32GB 单卡显存峰值与加载策略实测；独立音频任务验收。不得因名含 MiniMax 而混入 H3 视频接口 |
| Stable Audio 3：N07 | `stable_audio_3_medium` checkpoint、T5Gemma 编码器可读；公共库同时含 small music／sfx 变体 | 固定提示词／时长输入，模型与编码器实际运行及音频验收；其他变体没有因文件存在而自动上线 |
| YuE2 音乐／翻唱：N09 | `yue2_3b_bf16` 约 7.26GiB、`sheetsage2_bf16` 音频编码器约 1.29GiB 可读，核心节点已注册 | 歌词／曲风／旋律参考／生成长度映射、界面 Primitive 值编译、显存与完整输出验收 |
| MMAudio 视频拟音：N04 | MMAudio large 44k、VAE、Synchformer、CLIP 特征模型及 BigVGAN 相关文件已存在，加载与生成节点已注册 | 视频输入、拟音提示词、负面词及音轨产物协议，实际音画同步与音频生成验收；不等同台词 TTS |
| SHARP 高斯改视角：L02 | `LoadSharpModel`、`SharpPredict`、`GaussianViewer` 已注册；`sharp_2572gikvuh.pt` 约 2.62GiB 可读，流中还包含 Qwen 编辑分支 | 单图／相机参数映射、渲染与导出验收、STUDIO 资源类型适配。实际产物为 `.ply` 高斯点，不能冒充已有 GLB 网格／纹理生成 |

音频还有明确的归档缺口：这些 TTS 工作流使用的 `SaveAudio` 在当前官方 ComfyUI 默认输出 FLAC，而现有服务输出白名单没有 `.flac`；参考音频上传的 15 秒限制也不能直接当成音乐输出长度限制。后续需要独立音频 task、容器／采样率／声道／实际时长校验及资源回填，再做实测。3D 对应的 PLY／高斯资源同样不在当前图片视频输出协议内。上述工作本轮未扩大 GPU 任务、未安装新依赖，也未调用外部收费接口。

本轮优先接入 4 个图像 profile 和文武 2 个视频 profile，是因为它们能与现有图片、参考编辑、图片增强、全能参考入口形成明确合同，并已逐模型实际完成生成；其余能力没有用模板或占位结果冒充实现。

## Studio TV 真实画布验收与发布记录

验收画布：[ComfyUI 模型与进度验收 · 2026-10-22](http://192.0.2.10:18880/project/canvas/prj_90175dc9-de83-409d-ad30-c7797e0f39ef)。使用真实登录用户，通过普通画布入口提交，不使用模拟生成结果。

| 画布入口 | STUDIO 任务 ID | 实际结果 |
|---|---|---|
| FLUX.1 [dev] 图片生成 | `tsk_c6da4bb9697049459f0fa3595e12b986` | SUCCEEDED，1024×1024 PNG；采样回报 10／20，画布显示“采样进度 50%” |
| H3 单采极速文戏，全能参考 | `tsk_75bbd167c3ea48beaca41716ec110b5f` | SUCCEEDED，864×480、124 帧、24fps；实际 5.167 秒；采样 2／5，解码阶段不伪造百分比 |
| H3 最强武戏，全能参考 | `tsk_667a19059f2540e2bff94e8901e15237` | SUCCEEDED，864×480、124 帧、24fps；采样 3／10、6／10、9／10；确认独立武戏配置 |
| 图片→画质→放大，SeedVR2 3B | `tsk_4cb92d09921c4b79a9f56451f29131d9` | SUCCEEDED，复用上述 FLUX.1 图片，1024×1024→2048×2048 PNG；运行时仅显示超分阶段，完成并导入后进度为 1 |

图片和视频产物已导入 deployment-host 的 STUDIO 资产存储。浏览器中的视频可播放，读取来源为 STUDIO 同源地址；2048×2048 图片已完整加载。刷新后 3 个画布节点及成片仍可恢复。武戏完成后切回文戏能正常保存，未出现虚假的版本冲突。

原生放大／高清入口补齐了真实 SeedVR2 目录；无效的模拟模型不再出现在生产普通菜单，也不能作为生产重试的回落。测试覆盖了生成结果再次作为输入、原生表单空字段、来源连线、模型切换和并发保存边界，保留任务、素材归属、版本与语义守卫。

发布实现：Studio TV `904ff8c4773bca110894bfb729b4c3a449d06fbf`，Router `125c0f888731ebb93f478f31a63ea91eeac0db28`；本段之后仅补充文档提交。1521 项前端测试、生产构建与类型检查、1198 项冻结原生资源校验通过；Go 全包／race 与隔离 PostgreSQL 测试、云端 69 项运行时测试通过。发布保留已有数据库、资产卷、模型软连接和 deployment-host 原有未提交运维文件，未升级 ComfyUI 内核，未调用外部收费模型。
