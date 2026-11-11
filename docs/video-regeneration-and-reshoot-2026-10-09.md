# 视频再次生成与原站视频重拍（2026-10-09）

## 两个入口

- **节点底部「开始生成」**：按当前原参考图、提示词及 H3 参数再生成一个版本。已有成片属于输出/历史，不能自动成为本轮的参考视频。
- **工具栏「视频重拍」**：编辑现有成片中的选定片段。Studio TV 尚未接通，继续置灰。

## 本次修复

1. H3 前端能力匹配仅检查目标的显式输入与直接媒体来源；不把目标旧成片、上游素材的生成来源递归当成输入。
2. 后端附件提取和参考角色绑定同时排除目标根层旧输出。显式写在参数里的视频仍作为输入校验，首帧模型不会静默忽略不支持的视频输入。
3. 原生视频表单清空预设后会在 `null` 与空数组间转换；提交时还会省略服务器历史对应的空本地缓存。只兼容这些可验证的等价表示，真正修改提示词、素材或历史仍被版本校验拦截。
4. 上述输入投影不写回画布，不删除旧输出和历史记录。

代码：`apps/web/src/service/{execution,video-command}.ts`；`apps/api-go/internal/modules/execution/application/{service,prompts,video_input_frontier}.go`。

## RunningHub 当前公开前端调研

来源：2026-10-09 从 [原站画布](https://rhtv.runninghub.cn/projects/canvas) 实际加载的 [公开脚本 index-BMMC0_z2.js](https://rhtv.runninghub.cn/project/assets/index-BMMC0_z2.js)。新建画布要求登录，因此以下是公开代码接线核验，**未实机提交原站生成任务，不能据此保证原站效果或当前账户模型权限**。

- 工具栏 `clipReshoot` → `handleClipReshoot` → `IDr`，创建独立 `rh-video` 分支，子类型为 `video-clip-reshoot`，引用原视频。
- 胶片轨道当前仅选 1 段；前端限制源视频不超过 600 秒，选段 4–30 秒，时间编辑按整秒吸附。模型自身可能另有限制。
- `aIn` 流程：部分选段先 `CROP_DURATION` 切开，`QNn` 将选段视频及编辑指令送入模型，再 `COMPOSE` 拼接未选部分和新片段。选满全片则跳过裁切与拼接。
- 参数使用自适应时长/比例。编辑提示强调只改用户指定内容、尽量保持逐时刻的主体动作、镜头和背景；留空仍然是以原视频为输入重跑，不是复用原始图片提示词。
- 模型通过 `video-clip-reshoot` 目录获取；不能仅凭静态提示文案认定当前账户可调用哪些模型。
- 「一键复刻」是另一个工具栏 handler，与选段重拍独立。

Studio TV 要启用重拍仍需完成片段编辑模型契约、裁切→生成→合成的任务编排，并验证时长、声轨及衔接。当前 H3 参考生成可提供新视频，但尚无这套选段编辑闭环的验收依据，不把普通重新生成包装成重拍。

## 验证

- 受影响前端用例、后端 H3 输入/条件绑定用例、Web 构建及 1198 个原生资源基线校验通过。
- 真实项目：`prj_fc4a4d65-1088-4048-ad64-c718c3432ae4`；节点 `node_1791554703502_nwg606j`。
- 代码部署：`ec1f153`（API/Web）、`429f9d6`、`5d47490`（Web）。
- 原生底部按钮真实任务 `tsk_f619e72651644ec997bb976aaf739a0e`，执行 `exe_5dc0057a74904005ba79838e181bc34e`，状态 `SUCCEEDED / APPLIED`，`testMode=false`。
- 日志 `fbb6881a-2533-504f-b9f5-3ea0957922fe`；调用 `inv_-Ws63L68kuW3rqFruYTd6tPMuKN1qo0u`。
- 实际模型附件仅 1 张原参考图 `ast_2c7c1f4082c5db50ea33dfcf2eebfd9cc84826f6cabaa2e0`，无旧视频；提示词及 outputPreset 与点击前一致。原生表单会补入 imageUrls 和等值 text 字段。
- 新视频 `ast_7c9e17165d0d91e653389871997213ebba42f98a31a1cd96`：MP4，864×480，5167ms。浏览器两处播放器 readyState=4、无媒体错误；刷新后仍保留新输出。
- 打开「历史→视频历史」，同时看到新输出 `out_b1bb0bfc281337a854a67d037daa03f0d22ad6172973035d77a11ef743b2c7dc` 与旧输出 `out_723a55dcec170218173d13abd98d2e4cdbce4309276045397edf7868c1a6c7fd`，未删除旧版本。
