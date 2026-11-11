# 画布生成入口验收（2026-11-04）

一次生成的通过条件是：从 STUDIO 画布实际构造请求，经过 STUDIO API、数据库任务、worker、媒体授权与签名，收到该次执行的服务封包；把该封包原样交给独立 Models Router 的真实适配器，最终的 Comfy / 官方视频 HTTP 接收器或 Codex 的 turn/start 接收器收到正确的原生生成请求。检查模型版本、输出参数、实际引用的素材及其字节摘要、排序和对应的角色。没有请求、投递重复、参数错位、素材不符或适配器拒绝都算失败。测试不访问厂商，不用生产账号或真实画布。

## 核算范围与明细

| 维度 | 口径和可核对的数据 |
|---|---|
| 连不连得上 | [有向端口及编辑矩阵](canvas-topology-matrix.md)：17 种基础内容类型的 289 个有向对，其中 51 对允许进一步尝试。模型、角色、数量、权限以及循环、自连、重复和缺失节点另行校验。 |
| 连接之后能不能生成 | [7,700 行逐项结果](canvas-topology-matrix.csv)：28 个绑定（含 2 个历史绑定），5 种 A 输入 × 5 种 B 输入 × 11 次操作。1,924 行就绪，2,549 行待补输入，2,527 行禁止，700 行的目标节点已删除。就绪行全部导出真实前端提交体；其余行不应产生对应的生成请求。另对 36 个需个人凭据的配置，以具备凭据的测试账号重复相同操作：[9,900 行逐项表](canvas-topology-credentialed.csv)，2,348 就绪，3,552 待补，3,100 禁止，900 目标已删除。两组合计 17,600 行、4,272 个就绪样本。 |
| 素材数量边界 | [48 个视频配置、3,438 种数量组合](canvas-video-counts.md)：图片/视频/音频从 0 到上限再加 1；1,559 可提交，81 缺输入，1,798 超限或不支持。需个人 Key 的型号按已配置计算；无 Key 另验置灰。 |
| 模型的参数值 | [型号、版本、配置与可用条件](canvas-model-parameters.md)：当前菜单 62 个（26 个直接可用，36 个需个人 Key）。791,310 是按独立字段和有效人物配对**计算的参数组合**，不是发送过的请求数。每个当前配置均有到达最终入口的代表请求；旧版绑定另验。 |
| 独立节点工具 | [工具入口、可用条件及复验](canvas-node-actions-2026-11-04.md)：18 个图片和 12 个视频主工具；进一步区分本地操作、媒体处理、需要具体模型的生成及不可用操作。 |

这些是不同维度，不能累加成“多少个功能”。任意重复操作、任意拓扑、提示词与素材内容没有有限总数。测试以最终图和操作序列分别建模：即使最终连线相同，断开重接造成的输入顺序、历史选择也必须正确。

## 实际接收结果

两组拓扑的 4,272 个就绪样本全部通过最终适配器。另发 62 个当前配置、63 个图片工具、5 个单音频快捷方式、3 个角色/场景/实体原生别名、16 个按时间顺序提交的任务、21 个连续生成及分支任务，合计 **4,442 次真实投递到 mock 生成入口**，没有遗漏或重复。附加验证与拓扑矩阵存在语义重叠，不把投递数称为互不相同的产品功能。61 个连续编辑步骤中 37 次到达生成入口、24 次符合预期地不提交。5 个真实 Router HTTP 入口样本属于已有投递，不重复计数。[按模型、测试组查看计数与封包摘要](canvas-boundary-results.json)。

## 运行链路

1. 冻结的原生操作构造器或 STUDIO 的实际 ExecutionAdapter，从节点与当前连接生成 canvas-runs 的请求体。浏览器实点另有工具栏截图；批量矩阵由代码驱动，不声称逐项人工点击。
2. 专用监听器在 loopback 启动 STUDIO 产品及真实 PostgreSQL 临时数据库，使用测试身份、测试目录和合成素材。图操作走正式编辑会话、操作存储和 API；生成任务经实际 worker 和签名 HTTP 到达捕获端。批量用例比对每项来源、版本和参数，包含文字与结构化脚本的值和先后。
3. 将每份原始调用交给固定版本独立 Router 的真实适配器；只替换身份/素材读取的测试依赖和最终厂商传输。按原始 JSON 的 SHA-256 和序号核对每一条，不把独立的适配器自测算进画布次数。两个阶段间通过同一份封包衔接，不宣称测过线上网关部署、真实身份鉴权或模型出片质量。
此外，Qwen 图像编辑、H3 首尾帧、H3 动作迁移、Seedance 首帧和 Codex 文本五条代表封包还经真实 Router HTTP 签名入口、临时 PostgreSQL 入队、正式 dispatch worker 和适配器到达最终 mock，用于单独检查两个阶段的衔接。

4. 同画布的连续用例使用合成媒体作为生成结果，经过正式资产落库和结果历史写回，再作为下一次输入。验证断开保留旧成品但不再拿旧输入执行、换源后只读新源、删除和重建、显式首尾帧换序、选历史、分支不串料，以及多级图片→视频→动作迁移。裁剪、倒放、音轨等走独立媒体接口，不计入模型入口。

## 如何复跑

需要本项目锁定依赖（npm ci）、Go、ffprobe、可建临时库的测试 PostgreSQL，以及与发布对应的 studio-model-router 检出。配置环境后，一条命令可跑完整套验收：`python3 scripts/verify-canvas-generation.py --out /path/to/new-private-directory`（包含生成和 FFmpeg）。以下是各步骤的独立命令，在 STUDIO 服务仓库根目录运行；使用全新的输出目录，检查所有命令的退出状态。不要将 TEST_DATABASE_URL 指向生产。驱动脚本会用 canvas_boundary_audit 编译专用监听器；普通 Go 回归无需启动外部驱动，两者分别运行并按各自结果验收。通过 --router 可指定 Router 的检出路径。本次两个端口均在回环地址上，两个阶段皆无真实推理。

```sh
export TEST_DATABASE_URL='postgresql://qa@localhost/studiotv_test?sslmode=disable'
export STUDIO_TEST_FFPROBE="$(command -v ffprobe)"
audit=$(mktemp -d)
STUDIO_CANVAS_AUDIT_EXPORT="$audit/topology" npm run test:web -- tests/web/canvas-topology-matrix.test.ts
STUDIO_CANVAS_ALIAS_EXPORT="$audit/aliases.jsonl" npm run test:web -- tests/web/execution-video-connections.test.ts
STUDIO_CANVAS_MODEL_EXPORT="$audit/profiles.jsonl" npm run test:web -- tests/web/canvas-catalog-submissions.test.ts
STUDIO_CANVAS_ACTIONS_EXPORT="$audit/tools.jsonl" npm run test:web -- tests/web/image-subfeature-comfy-contract.test.ts tests/web/image-semantic-tools.test.ts
STUDIO_CANVAS_ACTIONS_EXPORT="$audit/audio.jsonl" npm run test:web -- tests/web/native-audio-video-shortcut.test.ts

python3 scripts/test-canvas-boundary.py "$audit/topology-requests.jsonl" --jobs 8 --out "$audit/edits"
python3 scripts/test-canvas-boundary.py "$audit/topology-credentialed-requests.jsonl" --jobs 8 --out "$audit/keyed"
python3 scripts/test-canvas-boundary.py "$audit/topology-timeline.jsonl" --timeline --out "$audit/timeline"
python3 scripts/test-canvas-boundary.py --live --out "$audit/live"
for suite in profiles tools audio aliases; do
  python3 scripts/test-canvas-boundary.py "$audit/$suite.jsonl" --out "$audit/run-$suite" || exit 1
done
for lane in edits keyed timeline live run-profiles run-tools run-audio run-aliases; do
  STUDIO_CANVAS_ROUTER_REQUESTS="$audit/$lane/invocations.json" STUDIO_CANVAS_MEDIA_DIR="$audit/$lane/media" \
    python3 scripts/test-canvas-router-hop.py --summary "$audit/$lane/verified.json" || exit 1
done
```

真实 Router HTTP 入口的 5 个代表样本可用以下命令复跑：

```sh
STUDIO_CANVAS_ROUTER_REQUESTS="$audit/run-profiles/invocations.json" STUDIO_CANVAS_MEDIA_DIR="$audit/run-profiles/media" python3 scripts/test-canvas-router-ingress.py
```

9 种视频处理和 1 种音轨处理实际解码、像素及时长记录见[媒体结果 CSV](canvas-media-outputs.csv)；单独的脚本为 scripts/test-canvas-media-boundary.py。

每组输出 summary.json（STUDIO 接单及拦截）、results.json（案例及执行 ID）、invocations.json（真实签名投递的测试封包）、verified.json（最终接收计数与文件摘要）。本地验收封包含短期测试凭证，只存测试临时目录；仓库只保留[脱敏计数与摘要](canvas-boundary-results.json)。拓扑 CSV 列出每种模型及输入组合，可以按操作和就绪状态筛选。


## 人物调节选中节点后提交

冻结的原生 zU 从面板选项构造人物结果和连线，再经 o_ 提交单节点命令。该命令没有 maxConnect。若此时编辑面板已写入图、文、视频均不额外限量的默认值，真实入边和模型参数仍应一致。以下用例涵盖面部表情、外观年龄和妆容，并检验非默认数量约束的变化仍会阻止提交。

在已设置 TEST_DATABASE_URL 和 STUDIO_TEST_FFPROBE 的终端，用一个新目录保存记录：

```sh
portrait=$(mktemp -d)
STUDIO_CANVAS_ACTIONS_EXPORT="$portrait/requests.jsonl" node_modules/.bin/vitest run -c apps/web/vitest.config.ts tests/web/execution-server-writeback.test.ts -t 'single-node request after'
python3 scripts/test-canvas-boundary.py "$portrait/requests.jsonl" --out "$portrait/studio"
STUDIO_CANVAS_ROUTER_REQUESTS="$portrait/studio/invocations.json" STUDIO_CANVAS_MEDIA_DIR="$portrait/studio/media" python3 scripts/test-canvas-router-hop.py --summary "$portrait/studio/verified.json"
```

每条用例检查来自当前连线的图片和对应的系统预设标识，最终接收处为模拟生成服务。另在 image-selection-params.test.ts 使用同一原生构造器的空结果节点，核对首次拒绝后原节点能再次打开生成面板，进行中的任务及只读页面继续使用原生限制。


在隔离画布上还用 Ego 实际按住人物结果图拖动。让合成任务延迟 7.5 秒返回，确认鼠标仍按住时服务端已写入新的历史结果，再继续移动、松开并重新打开画布，服务端与网页均保留新坐标。另一次让提交明确返回 422，保留上次图片和历史，在图上直接拖动，松开后生成按钮可用，重新打开仍在松手位置。
