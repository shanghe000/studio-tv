# H3 视频历史参考图混入修复（2026-10-09）

## 原始故障

项目 `prj_fc4a4d65-1088-4048-ad64-c718c3432ae4`，视频节点 `node_1791554703502_nwg606j`。

- 原任务：`tsk_55ee60703e0f4772bda40879b0772e34`
- 日志 ID：`052023c7-c414-50b9-b772-db7cb98aed37`
- Router invocation：`inv_8FmL3HNYu0U_uGm3vZEiJQXHIFMxhyqr`
- H3 首帧 v2，5 秒。521ms 后失败，`H3_INPUT_INVALID`；Router 的参考数量/用途检查拒绝。

实际链路为原图片 → 重绘图片 → 视频。前端只选中了重绘结果；STUDIO 后端递归收集全部祖先图的逻辑，额外加入原图片，导致 Router 收到 2 个独立图片附件。首帧模式只允许 1 张。不是 GPU 生成失败，也不是需要重新上传图片。

## 修复范围

API `d543c58`：四种已发布 H3 能力 v1/v2 只使用直接连接的图片、视频、音频节点的当前输出，以及目标节点明确保存的附件。中间节点的旧生成素材不作为当前参考；文本条件与完整画布版本检查仍保留。首尾帧顺序、显式多参考、素材归属和历史选择校验保持有效。普通图片生成语义不变。

接受任务和后台绑定上游产物使用相同过滤规则，防止执行时重新混入祖先素材。API 单独部署，没有重建 Web、Router 或 H3。保留其他任务尚未提交的队列/监控开发文件。

## 验证

- 定向 Go 测试：H3 四种能力、两个版本、直接素材顺序、音视频输入、后台动态产物绑定及既有图片工具输入边界全部通过。
- 在用户原视频节点点击底部“开始生成”，提交 `tsk_3117a61c8684499ab7075083fbe28de1`，新日志 ID `337c37e4-0772-51ea-a531-29b467750964`，Router invocation `inv_NAEoaw8mYWomP6_PK5I1ukiHX0pxMwEc`。
- 新任务的 STUDIO 冻结请求和 Router 请求均为 1 个图片附件，指向重绘结果 `ast_2c7c1f4082c5db50ea33dfcf2eebfd9cc84826f6cabaa2e0`。保留原始失败记录。
- 原失败节点旧“重试”存在保存输入不一致提示；本次通过底部普通生成入口提交成功，没有放松画布并发保护。
- 最终状态：`SUCCEEDED`，`canvasBinding.applicationState=APPLIED`，`testMode=false`。输出 `ast_7688f84f88df48aec6a89b1e41c5ac250538c38bb1b37344`，MP4，864×480，5167ms。浏览器刷新后原节点为 finished，保留新任务 ID；实际 video 元素加载成功，videoWidth=864、videoHeight=480、duration=5.167、readyState=4，无媒体错误。
