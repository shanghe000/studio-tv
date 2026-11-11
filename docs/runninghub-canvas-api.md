# RunningHub 无限画布接口解析与 Studio TV 接入清单

采集：2026-10-04～05。目标：[原站画布](https://rhtv.runninghub.ai/project/canvas/2106768132243689474)。依据：登录后的 Fetch/XHR、当前页面加载的 JS 调用及响应消费代码及其直接依赖。本轮只出文档，未运行生成、优化、识别、聊天或实时绘画任务。

**证据标记：实测 = 本次请求及响应；源码 = 当前调用字段/返回消费字段，未执行；推测 = 需要真实生成确认；本地 = 无独立业务 HTTP。空列表实测不能证明条目字段。源码兼容别名不能当成服务端必返字段。**

除注明外为 `POST`、JSON body，业务 API 主机是 `https://www.runninghub.ai`。以下路径是原站协议，Studio TV 后续通过兼容层映射到自己的服务，浏览器不继续请求原站。ID 除明确小整数字段外用字符串；`?` 表可选。常见业务包：

```json
{"code":0,"msg":"success","errorMessages":null,"data":{}}
```

HTTP 200 不代表业务成功；以 `code` 判断。常用分页 `P<T> = {records:T[],total:number,size:number,current:number,pages:number}`；请求通常用 `page`，返回用 `current`。消息列表部分分页数字是字符串，详见消息段。没有记录真实登录凭据、临时密钥或完整私人画布内容。

## 1. 入口、画布保存与按钮分流

| 动作 | 路径 / 请求 | response.data | 证据 |
|---|---|---|---|
| 进入画布检查使用权 | `/canvas/checkUserIdByCanvasId` `{canvasId,userId,includeYjsGeneration:true}` | 本次为 `true`，不是权限对象 | 实测 |
| 读取画布 | `/canvas/getCanvasDetail` `{id}` | `Canvas`，见下 | 实测 |
| 读用户交互偏好 | `/canvas/user/detail` `{}` | `{userId,buzzyPopFlag,shortcutKeyConfig:{newline,submitTask,interactionMode,zoomSensitivity}}` | 实测 |
| 功能开关/Agent等配置 | `/canvas/config/queryByTypes` `{types:["CANVAS_BUZZY_INTRO_CARD","CNAVAS_CLIENT_SWITCH","CANVAS_THUMBNAIL_QUALITY","CANVAS_NEW_AGENT","CANVAS_YJS_HISTORY_CLEANUP"]}` | `[{type,content}]`；content随type变化 | 实测 |
| 单项配置 | `/canvas/config/query` `{type:"MINMAX_H3_ICON"}` | `{type,content}` | 实测 |
| UI字典 | `/api/portal/v2/getDictConfig` `{dictTypes:["canvas_menu_show_agent","add_asset_whitelist","canvas_openclaw_agent"]}`；另有 `system_contact_way`、`sketchboard_style_live` | `[{distId:number,detailId:string,detailName:string,detailValue:string}]` | 实测 |
| 右上头像/名字 | `/uc/getUserInfo` `{userId}` | 用户对象，显示取 `id,nickName,headIcon` | 实测；Studio TV沿用IPAC用户 |
| 修改画布名称 | `/canvas/rename` `{id,name}` | 检查code，data未核对 | 源码 |
| 复制分享链接 | `/canvas/share/link` `{canvasId}` | `{shareUrl}` | 源码；内部版隐藏 |
| 分享页复制工程 | `/canvas/share/clone` `{shareId}` | `{canvasId}` | 源码；内部版隐藏 |
| 锁定画布另存副本 | `/canvas/saveLockedCopy` `{canvasId,canvasContent:{nodes,edges}}` | 新画布 `{id}` | 源码 |

`Canvas` 本次字段：`id,user_id,name,description,canvas_content:{nodes,edges},version,del_flag,create_time,update_time,thumbnail,thumbnail_origin_url,team_id,type,folder_id,item_count,nodes_count,edges_count,content_size,locked,lock_reason,lock_time,lock_operator,pinned`。保留原节点 data，不要只保存坐标和媒体 URL。

| 按钮集合 | 保存/请求逻辑 |
|---|---|
| 添加文本/图片/视频/音频/3D/脚本/分镜节点；选中、移动、连线、复制、粘贴、删除、分组、解组、改节点名称/文本/参数、整理画布、撤销/重做 | 修改图谱；原站通过 Yjs/WebSocket 同步，通常无逐按钮 Fetch/XHR。Studio TV目前通过快照API保存 |
| 小地图、缩放、重置视图、显示连线、网格吸附、面板宽度、网格/列表视图、折叠组、节点搜索/标签过滤、弹窗关闭、预览切换、播放/暂停、音量、全屏 | 本地UI；其中修改图谱的操作仍需进入保存链路 |
| 节点工具“生成/重试”、组一键运行 | 通用 `/canvas/task/run`，不是每个模型另一个submit接口 |
| 模型、分辨率、时长、比例、结果数、参考图/音频/视频、音色选择 | 读取模型config并更新节点params；原站可能另外请求价格估算 |
| 添加角色/资产/工作流/历史结果到画布，历史结果选中/复用参数 | 先读目录/详情，然后插入或更新图谱；不能把“添加”误做成收藏API |
| 保存资产、收藏、标签管理、目录改名/移动/删除、我的工作流保存/删除 | 有独立业务写请求，必须持久化 |
| 语言、固定/隐藏/排序工具栏 | 本地偏好；不要混进快捷键配置接口 |
| 普通组工具栏特定“保存工作流”“分镜批量生成” | 这两个handler提示“即将上线”；脚本/分镜专用批量运行仍有task/run |

`/canvas/logs/reportEvent {eventName,eventBody}` 是埋点；不承担目录、生成或图谱保存。本文不把埋点当业务接口。WebSocket二进制同步不属于Fetch/XHR，未在本轮定完整WS协议。

## 2. 角色库（公共角色）

打开、筛选、搜索、翻页、收藏已实际核对；详情复用列表里的三视图，没有单独detail请求。

| 按钮 | 路径 | payload | response.data / 行为 | 证据 |
|---|---|---|---|---|
| 打开筛选器 | `/canvas/character-library/filter/options` | `{}` | `{groups:[{code,name,seq,categories:[{code,name,uiType,seq,options:[{code,name,color,seq,filterOnly?}]}]}]}` | 实测 |
| 首屏/下拉加载 | `/canvas/character-library/list` | `{page:1,size:20,favoriteOnly:false}`；下一页page=2 | `P<Character>` | 实测 |
| 筛选 | 同list | 加 `filters:[{categoryCode:"worldBackground",optionCodes:["modern"]}]` | 同上 | 实测 |
| 搜索 | 同list | 加 `keyword:"军绿"`；可同时带filters和favoriteOnly | 同上 | 实测 |
| 我的收藏 | 同list | `favoriteOnly:true` | 同上 | 实测 |
| 收藏/取消收藏 | `/canvas/character-library/favorite` | `{id:2,action:1}` / `{id:2,action:0}` | 本次 `null`；状态由前端更新 | 实测，收藏已恢复 |
| 三视图预览、选择图、添加到画布 | 无专用导入HTTP | 已载入images转IMAGE节点 | 图谱同步 | 本地/源码 |

```json
{"id":"<id>","name":"角色名","description":null,"favorite":false,"attributes":{"gender":{"optionCode":"female","name":"女"},"hairColor":{"optionCode":"black","name":"黑","colorValue":"#000000"}},"images":[{"name":"面部特写","url":"<url>","type":"closeUp"},{"name":"全身立绘","url":"<url>","type":"fullBody"},{"name":"多视图","url":"<url>","type":"multiView"}]}
```

筛选组 `worldBackground / characterAttribute`；分类：`worldBackground,gender,ageGroup,species,bodyType,heightClass,hairLength,hairColor,temperament`。`uiType=TAB|COLOR|DROPDOWN`。`all`、空值和重复option不提交；keyword去首尾空格，300ms防抖。清空筛选可以命中前端缓存，不能因此认定原站无查询API。源码识别错误 `103`登录、`1970`角色不存在、`1971`图片无效、`1972`筛选无效。

## 3. 个人资产库与上传

| 按钮 | 路径 | payload | response.data / 消费字段 | 证据 |
|---|---|---|---|---|
| 分类 | `/canvas/asset/type/list` | `{category:"USER"}`；初始化也发COMMON；可选teamId | `[{code,name,nameEn}]` | 实测 |
| 根目录/分类过滤/翻页 | `/canvas/asset/user/folder/first-level/list` | `{page:1,size:40,code?,keyword?,afterTime?,beforeTime?,teamId?,productType?}`；ALL省略code | `P<Folder>` | page/size/code实测，其余源码 |
| 打开文件夹 | `/canvas/asset/user/folder/second-level/list` | `{parentGroupId,page:1,size:40,code?,nodeType?,nodeKind?,keyword?,afterTime?,beforeTime?,teamId?,productType?}` | `P<FolderOrItem>`；本次空 | 基本字段实测，其余源码 |
| 二级目录内容 | `/canvas/asset/user/folder/second-level/item/list` | `{groupId,page,size,nodeType?,keyword?,afterTime?,beforeTime?,teamId?,productType?}` | 分页条目 | 源码 |
| 全库搜索 | `/canvas/asset/user/folder/item/search` | `{keyword,page?,size?,nodeTypes?,afterTime?,beforeTime?,teamId?}` | 分页条目 | 源码 |
| 旧目录列表（剪辑复用） | `/canvas/asset/user/group/list` | `{code:"ALL",page:1,size:200,keyword?}` | `P<Folder>` | 基本字段实测 |
| 旧目录内容（剪辑复用） | `/canvas/asset/user/group/item/list` | `{groupId,page:1,size:200,keyword?}` | 分页条目 | 源码 |
| 新建文件夹 | `/canvas/asset/user/folder/create` | `{name,parentCode,teamId?}`；parentCode为分类code或父目录ID | data未知，成功刷新目录 | 源码；表单已查看，未创建 |
| 保存到资产/批量入库 | `/canvas/asset/user/folder/item/batch-add` | `{folderId,nodes:[{itemName,content,nodeType,thumbnail}],teamId?}` | data未知，成功刷新 | 源码 |
| 删除目录/资产 | `/canvas/asset/user/folder/batch-delete` | `{groupIds:[],itemIds:[],teamId?}` | 消费失败项`reason`；兼容`failedItems/failedList` | 源码 |
| 移动 | `/canvas/asset/user/folder/move` | `{targetCode,groupIds:[],itemIds:[],teamId?,productType?}` | 同批量删除；确切返回待核对 | 源码 |
| 文件夹改名 | `/canvas/asset/user/group/rename` | `{groupId,name,teamId?}` | 检查code | 源码 |
| 资产改名 | `/canvas/asset/user/group/item/rename` | `{itemId,itemName,teamId?}` | 检查code | 源码 |
| 目录封面 | `/canvas/asset/user/folder/thumbnail/update` | `{groupId,thumbnails:[],teamId?}` | 检查code | 源码 |
| 下载前文件大小 | `/canvas/cos/fileSizes` | `{urls:[]}` | 源码消费`{files:[{url,size}]}`，未实测 | 源码 |

实测 `Folder={id,teamId:null,name,code,thumbnail,thumbnails:null,itemCount:null}`。USER分类：`ALL,USER_CHARACTER,USER_SCENE,USER_THING,USER_STYLE,USER_PRODUCT,USER_OTHER`。资产行源码消费 `id,name/itemName,nodeType,content,thumbnail,itemCount`；`content`是可复用节点数据，不只是URL，空列表未核对其真实完整条目。

上传源码链路：`/api/storage/getCredentials {scene:"canvas"}` → 临时 `{accessKey,secretKey,sessionToken,bucket,region,endpoint,type,expiredTime,cdnDomain}` → S3/MinIO PUT对象 → 媒体URL。对象通常 `identify/uploads/<hash>.<ext>`；`ACL=public-read`、`ContentType`、`Metadata:{contentType,contentLength}`；minio用forcePathStyle；cdnDomain可替换最终Location。上传到画布更新节点；保存到库另发batch-add。下载直接Fetch媒体URL，批量ZIP在前端做。

Studio TV可继续现有预签名上传，只需兼容最终媒体/asset引用；无需复刻向前端下发永久存储密钥。此处只记录字段名，未执行上传。

## 4. 工作流

| 按钮 | 路径 | payload | response.data | 证据 |
|---|---|---|---|---|
| 公共分类 | `/canvas/common-workflow/type/list` | `{}` | `[{id,code,name}]` | 实测 |
| 灵感库/推荐/分类/搜索/翻页 | `/canvas/common-workflow/list` | `{page,size:30,recommended:true,code?,keyword?}` | `P<Workflow>` | page2和搜索实测；code源码 |
| 我的收藏 | `/canvas/common-workflow/favorite/list` | `{page:1,size:30,keyword?}` | P，本次空 | 实测；keyword源码 |
| 我的工作流 | `/canvas/workflow/list` | `{page:1,size:30,keyword?,teamId?}` | P，本次空 | 实测；可选项源码 |
| 收藏/取消 | `/canvas/common-workflow/favorite` | `{commonWorkflowId,action:"ADD"或"REMOVE"}` | 源码读favorited，data待核对 | 源码 |
| 我的详情 | `/canvas/workflow/detail` | `{id}` | 工作流对象 | 源码 |
| 保存/更新 | `/canvas/workflow/save` | `{id:""或已有ID,name,description:"",workflowContent,thumbnail?,teamId?}` | 工作流对象，完整shape待核对 | 源码 |
| 删除 | `/canvas/workflow/delete` | `{id,teamId?}` | 检查code | 源码 |
| 应用公共工作流 | `/canvas/common-workflow/apply` | `{commonWorkflowId,canvasId}` | 检查code；插入图谱 | 源码 |
| 投稿 | `/canvas/common-workflow/submit` | `{workflowId,name,code,description?,thumbnail}` | 检查code | 源码；内部版隐藏 |

公共行实测：`id,code,name,description,workflowContent,thumbnail,updateTime,userId,nickName,headPic,isOwn,favorited`；workflowContent含节点和边。首屏有10分钟缓存；只观察“打开无XHR”不足以否定分页。

## 5. 常规生成任务

请求字段已由当前源码核对；**本次未提交任务，成功response和任务status枚举均待核对**。

| 按钮 | 路径 | payload | response.data（源码消费） |
|---|---|---|---|
| 单节点生成/重试、图像/视频工具、文本LLM、脚本/分镜、AI应用运行 | `/canvas/task/run` | `{canvasId,targetType:"NODE",targetId:nodeId,canvas:{nodes,edges},name?,execution_key?}` | `{taskId}`，未实测 |
| 组一键生成 | 同run | targetType="GROUP"、targetId=groupId，裁剪组图谱 | 同上 |
| 整画布执行（源码支持） | 同run | targetType="CANVAS"，targetId具体约定待核对 | 同上；目标页面按钮未实测 |
| 查询进度/结果 | `/canvas/task/batchStatus` | `{taskIds:[],includeResults?:true}` | `{tasks:[{taskId,status,errorMessage?,plans:[{nodeId,status,errorMessage?,outputs}]}]}` |
| 停止 | `/canvas/task/cancel` | `{taskId}` | 检查code，data未知 |

图谱是提交协议：上游文字合并进prompt，图片/视频/音频有效URL按选中模型config填进`data.params`；保留依赖边`source,target`。不能只传一个prompt。canvas消费者兼容对象或JSON字符串；实际提交的序列化方式随handler核对。节点`modelCode/subType`、`generateNum`决定执行与输出数量；modelType随handler可能省略或删除，不是每次必须发送。编辑元素和深度转换的额外链路见下。

```json
{"canvasId":"<canvasId>","targetType":"NODE","targetId":"n1","canvas":{"nodes":[{"id":"n1","type":"rh-image","position":{"x":0,"y":0},"data":{"subType":"text-image","modelCode":"<selectedModelCode>","modelType":"OPENAPI","generateNum":1,"params":{"prompt":"<prompt>","resolution":"1k","aspectRatio":"16:9"}}}],"edges":[]},"name":"<canvasName>"}
```

上面是源码结构示例，参数必须以选中模型config为准。成功最小包推测 `{code:0,msg:"success",data:{taskId:"…"}}`。polling消费plans，但常规节点结果还通过Yjs回推；源码容忍task顶层output/outputs，这些别名不是必须同时返回。

| 输出类别 | 最小兼容输出推测，待真实执行 |
|---|---|
| 图片/视频/音频 | `outputs:[{url,outputType,width?,height?,durationMs?,thumbnail?}]` |
| 文本/歌词 | `outputs:[{text}]`，实际嵌套结构待核对 |
| 3D模型/世界 | GLB/SPZ等资源URL和元信息，具体字段待核对 |
| 脚本/分镜 | 结构化表格、角色/场景/引用信息，不能仅用图片URL |

本地UI状态可见 `idle,uploading,upload_error,ready,running,processing,finished,success,failed`；**不能据此给后端任务status定同样枚举/大小写**。分镜消费者列含 `shot,duration,color_tone,character_blocking,scene,description,storyboard_prompt,video_prompt,lighting,dialogue,sound_effect,acting_tone`，顶层生成返回尚未知。脚本引用图有 `[{url,image_id:"IMG_001"}]`转换，需保留对应引用ID。

### 模型目录与参数

`/canvas/model/list {types:string[]}` 实测 → `[{type,modelList:Model[]}]`。两批合并42个非空type、302个按type计数的模型条目、1799个顶层config；同一功能的不同模型参数不相同。`/canvas/model/group/list {}` 实测 → 家族树，15父级、55子级。

`Model={id:number,modelCode:string,modelType:"LLM"|"OPENAPI",modelName,modelNameEn,description:null|string,descriptionEn:null|string,icon:null|string,generateNum:number[],skuId:string,config:Field[],available:boolean,existVolcengineAssetEntry:boolean}`。

`Field`用`paramName`作为params键，`paramDataType=string|int|float|boolean|arrayString|arrayObject`。字段包括 `type,required,display,paramValue,optionValue,title,titleEn,description,advanced,min,max,step,minLength,maxLength,maxNum,maxSize,maxConnectImageNum,paramExt,paramList,paramNames,hide,switchFlag,descriptionEn,unit,unitEn,fileType,placeholderCn,placeholderEn,precision,promptEnhanceModelCodes,free,teamMember,personalMember,useStartTime,useEndTime,switchGroup,durationTotal,durationSingleMax,durationSingleMin,subType`；并非每项都有。`type`是UI控件语义，不能当提交值类型。display可为boolean或条件object，hide是条件object，optionValue可为标量或对象数组，paramList可嵌套。min/max/step/长度/大小限制实际可能是字符串；不得强制number丢值。skuId也是string。原站会员/时间/免费项仅属原站UI能力配置，不直接转为Studio TV权限。

家族父节点 `{modelGroupId:number,modelGroupName,modelGroupNameEn,icon,nodeTypeList,modelGroupList}`；子节点含`nodeModelList:[{nodeType,modelList}]`。模型家族不等于单一model/type。

下表全部来自本次真实目录；每类只展示第一个模型以说明参数。`!`=required true，`?`=false，`~`=未提供。默认值仅列短值；最终按选中模型完整config执行。

| type | 功能 | 示例 modelCode | 该模型 config 参数（类型/必填/关键默认值） |
|---|---|---|---|
| `TEXT_IMAGE` | 文生图 | `text-image-rhart-image-g-2.5-official-token-sunburst` | `prompt:string!`, `aspectRatio:string?`, `resolution:string! = "1k"`, `background:string? = "auto"`, `quality:string? = "auto"`, `outputFormat:string?` |
| `IMAGE_IMAGE` | 图生图/参考图 | `image-image-rhart-image-g-2.5-official-token-sunburst-edit` | `prompt:string!`, `imageUrls:arrayString!`, `aspectRatio:string?`, `resolution:string! = "1k"`, `background:string? = "auto"`, `quality:string? = "auto"`, `outputFormat:string?` |
| `TEXT_VIDEO` | 文生视频 | `text-video-bytedance-seedance-2.0-global` | `prompt:string!`, `resolution:string! = "720p"`, `duration:string! = "5"`, `generateAudio:boolean? = true`, `ratio:string?` |
| `IMAGE_VIDEO` | 图生视频 | `imag-video-alibaba-happyhorse-1.0` | `prompt:string!`, `resolution:string! = "720p"`, `imageUrls:arrayString!`, `duration:string! = "6"`, `aspectRatio:string?`, `seed:int?` |
| `MULTIMODAL_VIDEO` | 全能参考视频 | `multimodal-video-seedance-2.5-global-token` | `prompt:string!`, `resolution:string! = "720p"`, `duration:string! = "5"`, `imageUrls:arrayString? = []`, `videoUrls:arrayString? = []`, `audioUrls:arrayString? = []`, `generateAudio:boolean? = true`, `ratio:string? = "16:9"`, `realPersonMode:boolean? = true`, `conversionSlots:arrayString? = ["all"]`, `returnLastFrame:boolean? = false`, `bitrateMode:string?`, `draft:boolean! = false` |
| `START_END_VIDEO` | 首尾帧视频 | `start-end-video-alibaba-wan-3.0-prime-image-to-video` | `prompt:string!`, `firstFrameUrl:string!`, `lastFrameUrl:string?`, `resolution:string! = "1080P"`, `duration:string! = "auto"`, `aspectRatio:string? = "adaptive"`, `audio:boolean? = true`, `seed:int?` |
| `START_VIDEO` | 首帧视频 | `start-video-video-alibaba-wan-3.0-prime-image-to-video` | `prompt:string!`, `firstFrameUrl:string!`, `resolution:string! = "1080P"`, `duration:string! = "auto"`, `aspectRatio:string? = "adaptive"`, `audio:boolean? = true`, `seed:int?` |
| `VIDEO_VIDEO` | 视频生视频 | `video-video-alibaba-wan-2.7-video-extend` | `prompt:string?`, `videoUrl:string!`, `audioUrl:string?`, `negativePrompt:string?`, `resolution:string! = "720P"`, `duration:string! = "5"` |
| `VIDEO_EDIT` | 视频编辑生成 | `video-edit-seedance-2.5-global-token` | `prompt:string!`, `resolution:string! = "720p"`, `duration:string! = "-1"`, `imageUrls:arrayString? = []`, `videoUrls:arrayString! = []`, `audioUrls:arrayString? = []`, `generateAudio:boolean? = true`, `ratio:string? = "adaptive"`, `realPersonMode:boolean? = true`, `conversionSlots:arrayString? = ["all"]`, `returnLastFrame:boolean? = false`, `bitrateMode:string?`, `draft:boolean! = false` |
| `VIDEO_EXTEND` | 视频续写 | `video-extend-seedance-2.5-global-token` | `prompt:string!`, `resolution:string! = "720p"`, `duration:string! = "5"`, `imageUrls:arrayString? = []`, `videoUrls:arrayString! = []`, `audioUrls:arrayString? = []`, `generateAudio:boolean? = true`, `ratio:string? = "adaptive"`, `realPersonMode:boolean? = true`, `conversionSlots:arrayString? = ["all"]`, `returnLastFrame:boolean? = false`, `bitrateMode:string?`, `draft:boolean! = false` |
| `VIDEO_HD` | 视频高清修复 | `video-hd-rhart-video-rh-upscale-enhance-frame` | `fileUrl:string!`, `model:string! = "max"`, `resolution:string! = "1080p"`, `outputFps:string! = "1x"` |
| `VIDEO_MOTION_TRANSFER` | 动作迁移 | `video-motion-transfer-rhart-video-wan2.2` | `imageUrl:string!`, `videoUrl:string!` |
| `VIDEO_CLIP_RESHOOT` | 片段重拍 | `video-clip-reshoot-seedance-2.5-global-token` | `prompt:string!`, `resolution:string! = "720p"`, `duration:string! = "-1"`, `imageUrls:arrayString? = []`, `videoUrls:arrayString! = []`, `audioUrls:arrayString? = []`, `generateAudio:boolean? = true`, `ratio:string? = "adaptive"`, `realPersonMode:boolean? = true`, `conversionSlots:arrayString? = ["all"]`, `returnLastFrame:boolean? = false`, `bitrateMode:string?`, `draft:boolean! = false` |
| `VIDEO_REMOVE_WATERMARK` | 视频去水印 | `video-remove-watermark-rhart-video-ltx-2.3` | `videoUrl:string!`, `numFrames:int?`, `frameRate:int?` |
| `VIDEO_REMOVE_SUBTITLES` | 视频去字幕 | `video-remove-subtitles-volc-subtitle-erase-video` | `videoUrl:string!` |
| `VIDEO_REMOVE_BLUR` | 视频去模糊 | `video-remove-blur-rhart-video-ltx-2.3-edit` | `videoUrl:string!`, `numFrames:int!`, `frameRate:int!` |
| `VIDEO_DEPTH_CONVERTER` | 视频深度转换 | `rhart-video-video-depth-converter` | `video:string!`, `resolution:string! = "480P"`, `colorMapping:string! = "grey"` |
| `VIDEO_ANALYSIS` | 视频分析 | `llm-video-analysis-alibaba-qwen3.8-max` | `prompt:string!`, `imageUrls:arrayString?`, `videoUrls:arrayString?`, `reasoning_effort:string! = "low"` |
| `TEXT_AUDIO` | 文本转语音 | `bytedance-doubao-seed-audio-1.0` | `text_prompt:string!`, `speaker:string?`, `format:string? = "wav"`, `sample_rate:int? = 44100`, `speech_rate:int! = 0`, `loudness_rate:int? = 0`, `pitch_rate:int? = 0` |
| `TEXT_MUSIC` | 音乐生成 | `text-music-rhart-audio-music-2.5` | `prompt:string!`, `lyrics:string!`, `bitrate:string? = 64000`, `sampleRate:string? = 32000` |
| `AUDIO_AUDIO` | 参考音频生成 | `audio-audio-bytedance-doubao-seed-audio-1.0` | `text_prompt:string?`, `format:string? = "wav"`, `sample_rate:int?`, `speech_rate:int?`, `loudness_rate:int?`, `pitch_rate:int?`, `audioUrls:arrayString!` |
| `VIDEO_AUDIO` | 分离音频 | `rhart-audio-source-separation` | `videoUrl:string!` |
| `MULTIMODAL_TEXT` | 全能语言模型 | `llm-gemini36flash-multimadal-text` | `prompt:string!`, `imageUrls:arrayString?`, `videoUrls:arrayString?`, `reasoning_effort:string! = "low"` |
| `TEXT_LYRICS` | 歌词生成 | `text-lyrics-rhart-audio-suno-lyrics` | `prompt:string!` |
| `TEXT_TO_W3D` | 文本生成3D世界 | `text-to-w3d-marble-1.1` | `prompt:string?`, `disableRecaption:boolean?`, `displayName:string?`, `seed:int?`, `permissionPublic:boolean? = false`, `permissionAllowIdAccess:boolean?`, `tags:string?`, `permissionAllowedReaders:string?`, `permissionAllowedWriters:string?` |
| `IMAGE_TO_W3D` | 图片生成3D世界 | `image-to-w3d-marble-1.0` | `imageUrl:string?`, `textPrompt:string?`, `disableRecaption:boolean?`, `displayName:string?`, `seed:int?`, `permissionPublic:boolean? = false`, `permissionAllowIdAccess:boolean?`, `tags:string?`, `permissionAllowedReaders:string?`, `permissionAllowedWriters:string?`, `isPano:boolean! = false` |
| `VIDEO_TO_W3D` | 视频生成3D世界 | `video-to-w3d-marble-1.1` | `videoUrl:string?`, `textPrompt:string?`, `disableRecaption:boolean?`, `displayName:string?`, `seed:int?`, `permissionPublic:boolean? = false`, `permissionAllowIdAccess:boolean?`, `tags:string?`, `permissionAllowedReaders:string?`, `permissionAllowedWriters:string?` |
| `TEXT_TO_3D` | 文本生成3D模型 | `text-to-3d-hunyuan3d-v3.1` | `prompt:string!`, `faceCount:int?`, `enablePbr:boolean! = false`, `generateType:string! = "Normal"` |
| `IMAGE_TO_3D` | 图片生成3D模型 | `image-to-w3d-hunyuan3d-v3.1-image-to-3d` | `faceCount:int?`, `enablePbr:boolean! = false`, `generateType:string! = "Normal"`, `imageUrl:string!`, `leftImageUrl:string?`, `rightImageUrl:string?`, `backImageUrl:string?`, `topImageUrl:string?`, `bottomImageUrl:string?`, `leftFrontImageUrl:string?`, `rightFrontImageUrl:string?` |
| `MULTIMODAL_STORYBOARD` | 脚本/分镜规划 | `llm-gemini35flash-multimadal-storyboard` | `prompt:string!`, `imageUrls:arrayString?`, `videoUrls:arrayString?`, `max_tokens:int? = 70000`, `reasoning_effort:string! = "low"` |
| `IMAGE_RECOGNITION` | 图片识别 | `llm-gemini35flash-image-regecognition2000` | `prompt:string!`, `max_tokens:int? = 2000`, `imageUrls:arrayString?`, `videoUrls:arrayString?`, `reasoning_effort:string! = "low"` |
| `IMAGE_LAYER_DECOMPOSITION` | 图层拆分 | `image-layer-decomposition-dola-Seedream-5.0-pro` | `imageUrl:string!` |
| `VIDEO_EXPAND` | 视频放大 | `video-expand-topazlabs-upscal` | `videoUrl:string!`, `targetFps:string! = "30"`, `targetResolution:string! = "720p"` |
| `VIDEO_ENHANCE` | 视频增强 | `video-enhance-volc-enhance-generative-video` | `videoUrl:string!`, `resolution:string?`, `fps:float?`, `bitrateLevel:string? = "medium"`, `bitrate:int?` |
| `IMAGE_ENHANCE` | 图像高清增强 | `image-enhance-topazlabs-upscale-standard-v2` | `imageUrl:string!`, `scale:string! = "2x"`, `subjectDetection:string? = "All"`, `faceEnhancement:boolean? = false`, `faceEnhancementCreativity:float? = 0`, `faceEnhancementStrength:float? = 0` |
| `IMAGE_CUTOUT` | 智能抠图 | `image-cutout-rhart-image-v1` | `prompt:string!`, `imageUrls:arrayString!`, `aspectRatio:string! = "auto"` |
| `IMAGE_CUTOUT_TEXT` | 智能擦除文字 | `image-cutout-text-rhart-image-f-1` | `imageUrl:string!` |
| `IMAGE_MULTIANGLE` | 多角度相机 | `image-multiangle-rhart-image-qwen-camera` | `url:string!`, `horizontal_angle:int! = 0`, `vertical_angle:int! = 0`, `zoom:float! = 5` |
| `IMAGE_LIGHT` | 多角度照明 | `image-multiangle-rhart-image-qwen-lighting` | `url:string!`, `light_azimuth:int! = 0`, `light_elevation:int! = 0`, `light_intensity:float! = 3`, `light_color_hex:string!` |
| `IMAGE_REDRAW` | 局部重绘 | `image-redraw-rhart-image-n-pro-official` | `prompt:string!`, `imageUrls:arrayString!`, `resolution:string! = "1k"` |
| `IMAGE_ERASE` | 图像擦除 | `image-erase-rhart-image-n-pro-official` | `prompt:string!`, `imageUrls:arrayString!`, `resolution:string! = "1k"` |
| `IMAGE_EXPAND` | 图像扩图 | `image-expand-rhart-image-n-pro-official` | `prompt:string!`, `imageUrls:arrayString!`, `resolution:string! = "1k"` |



本次请求还包含下列type但响应未返回对应项：`CONTEXT_IR`, `CONTEXT_IR_MULTIMODAL`, `IMAGE_ANNOTATE`, `IMAGE_GIGAPIXEL`, `IMAGE_HD`, `IMAGE_STORYBOARD`, `IMAGE_TEXT`, `PROMPT_ENHANCE`, `TEXT_STORYBOARD`, `TEXT_TEXT`, `VIDEO_DENOISE`, `VIDEO_FRAME_INTERPOLATION`, `VIDEO_STORYBOARD`, `VIDEO_TEXT`。这不等于已确认返回空数组，也不能为它们编造config；对应按钮可能不可用。

## 6. 提示词优化、识别与价格预估

均为源码确认，未调用模型。价格用于还原原站逻辑；Studio TV内部版继续隐藏充值/计费展示。

| 按钮 | 路径 | payload | response.data消费 |
|---|---|---|---|
| 智能优化提示词 | `/canvas/prompt/enhance` | `{prompt,scene,nodeCategory,refImageCount,modelCode,nodeId,canvasId,videoParams?}`；scene=`T2I/I2I/T2V/I2V_SINGLE/I2V_MULTI` | `{enhancedPrompt}`；撤销优化只回填原文本 |
| 图片提取风格 | `/canvas/invoke/api/llm` | `{modelCode:"canvas_prompt_user_style_extract",params:{messages:[{role:"user",content:[{type:"text",text:"user_style_extract_prompt"},{type:"image_url",image_url:{url}}]}]}}` | `choices[0].message.content` |
| 一键复刻的参考视频分析 | 同invoke | modelCode=`google-gemini-3.5-flash`，messages content含text和`{type:"video_url",video_url:{url}}`，可附image_url | 同上；媒体尺寸/时长另读`GET <videoUrl>?ci-process=videoinfo` XML |
| 普通图片/视频工具“分析” | `/canvas/task/run` | 新增保留的rh-text分析结果节点；图片用`llm-haimaflash-multimadal-text`和prompt/imageUrls；视频用VIDEO_ANALYSIS目录首模型，初始params仅videoUrls，提示由sceneCode预设 | 复用task/plan输出，未运行 |
| 参数预估价格 | `/canvas/price/calculate` | `{skuId,priceFactors:[{fieldKey,fieldValue,type?,title?,titleEn?}]}`；常附rhModel=modelCode | 金额/免费额度/提示，当前精确shape待核对 |
| SKU价格因子 | `/api/area/price/factor/detail` | `{skuId}` | 因子数组，条目待核对 |
| 区域价格 | `/api/area/price/calculate` | 同calculate | 当前精确shape待核对 |
| 组运行估算 | `/canvas/price/estimate` | 组task/run同类图谱body | `{nodeCount,taskCount,estimatePrice}`；301提示缺必填项 |
| LLM单价 | `/canvas/price/llm-sku-price` | `{skuCodes:[]}` | 数组，条目待核对 |

### 工具按钮的例外与本地处理（均为当前源码，未执行）

### 图片工具

| 按钮 | 分流 / 提交特征 |
|---|---|
| 分析图片 / 反推提示词 | `_Er → editor Ia/jr → /canvas/task/run`；新建 rh-text，固定 `modelCode=llm-haimaflash-multimadal-text`、`subType=multimodal-text`、`params={prompt:<反推模板>,imageUrls:[url]}`；并非 `invoke/api/llm` |
| 高清增强、放大、高清修复 | IMAGE_ENHANCE / IMAGE_GIGAPIXEL / IMAGE_HD 模型节点；最终通用 task/run。后两类在当前两批目录未返回，按钮可禁用；不能编造模型参数 |
| 多角度相机、多角度照明 | task/run，模型 config 提交字段分别如 `url,horizontal_angle,vertical_angle,zoom` / `url,light_azimuth,light_elevation,light_intensity,light_color_hex` |
| 情绪/姿态/外貌/妆容调节 | 读 portrait 预设 tree + batchList，选项变 `presetSelections,promptCodes`，task/run；当前固定 `seedream-v5-pro-image-to-image`。姿态先上传poseFile，引用 `[原图,姿态图]`、mentionAssets和两条依赖边；自定义妆容可另带封面参考 |
| 分镜大师各预设 | task/run；当前固定优先 `image-imagerhart-image-g-2-official-image-to-image`，`sceneCode=canvas-image-quick-create-…`；9宫格、4/25分镜、电影灯光、三视图、预判3秒后/5秒前、运镜、情绪重塑、深度视差、天气特效均复用这条链路 |
| 全景生成 | task/run；优先 `image-image-rhart-image-n-g31-flash-official`，`sceneCode=canvas-image-panorama-image`、`resolution=2k`，保留 panorama 元信息 |
| 全景进入/退出、镜像、视角/FOV、重置、构图线、全屏 | 浏览器WebGL和节点data；无独立业务HTTP。截当前/四方位/12方位：WebGL截图→上传→添加图像节点/组；导入导演为本地图谱/弹窗桥接 |
| 网格切图，切图后“创建分镜” | 浏览器Canvas按 rows/cols切片→逐张上传→rh-image或grid-preview图谱；没有AI生成请求 |
| 图片编辑：裁剪/旋转/镜像/画笔/标注/调色 | 编辑器本地像素/滤镜；保存图片时上传Blob并更新/添加图像节点，imageAdjustments也可直接写data；无专用图片处理REST |
| 局部重绘、擦除、扩图 | 蒙版/扩展后的图片先上传，再task/run；params按相应模型config。擦除 `sceneCode=canvas-image-erase`，扩图 `sceneCode=canvas-image-expand`；重绘合并“白色遮罩内填充”提示词 |
| 抠图 / 去文字 | task/run；抠图可有 `sceneCode=canvas-image-cutout`，去文字使用IMAGE_CUTOUT_TEXT；不是前端Canvas抠图 |
| 编辑元素 | **两条链路**，见下，默认方案包含独立 OpenAPI |
| 预览/历史切换、复制、下载、加入Agent | 本地/媒体URL；历史请求复用node-history；加入Agent写消息附件，点击本身不发聊天生成 |

编辑元素选定 IMAGE_LAYER_DECOMPOSITION 模型：task/run临时rh-image，`subType=image-layer-decomposition`、params按config（常为imageUrl）。源码消费者按输出顺序取第1张背景，其余为图层；真实返回待核对。

编辑元素“默认”：IMAGE_RECOGNITION临时rh-text task/run（优先 `llm-haimaflash-image-regecognition`，`sceneCode=canvas-selection-split-layers`，输入图和空prompt，服务器预设）；文本结果解析JSON `elements`，含 `z_index,name,matting_prompt` 等 → 每元素调用下列抠图 → 必要时task/run修复背景 → 浏览器合成/透明边界裁切，裁切图上传，写图谱。保存处理中间状态用于恢复；不得把它归为一个简单layer API。

POST `/openapi/v2/rhart-image/qwen-vl/prompt-matte`，body：

```json
{"imageUrl":"<sourceUrl>","prompt":"<element.matting_prompt>","skuId":"2043991611295436801"}
```

POST `/openapi/v2/query {taskId}`；请求头Authorization为Bearer（只记字段，不记凭据），提交端另有client=WEB。源码消费 `taskId,status,results:[{url}],errorCode,errorMessage`，轮询识别 `SUCCESS/FAILED/ERROR/CANCELLED/CANCELED/TIMEOUT`，不是 canvas/task 的已知status。Studio TV需在后端做模型适配，不照搬前端密钥获取。

### 视频工具

| 按钮 | 分流 / 提交特征 |
|---|---|
| 分析视频 | task/run；新建保留的rh-text分析结果节点，modelCode来自VIDEO_ANALYSIS目录首模型，`sceneCode=canvas-video-analyze-storyboard-3.8`、初始`params={videoUrls:[url]}`，提示由预设提供。普通分析不同于复刻链路中的固定Gemini invoke |
| 一键复刻 | 分析阶段 `invoke/api/llm`，后续分镜/参考图/视频生成仍task/run；不是独立remake REST |
| 高清/放大/增强/降噪/补帧、修复去水印/字幕/模糊、动作迁移 | 模型 task/run；降噪/补帧当前目录未返回，不推测其可运行参数。修复先读媒体 `?ci-process=videoinfo` 的XML，按config注入numFrames/frameRate |
| 分离全部音频/人声/环境音 | task/run；rh-audio节点 `params={...modelParams,videoUrl,audioSeparationMode:"all"或"vocal"或"ambient"}`，modelCode按分离模式选；不能只支持目录首例的videoUrl而忽略模式 |
| 深度抓取 | VIDEO_DEPTH_CONVERTER task/run，`params={video:url,resolution:<选项>,colorMapping:"grey"}`；最长180秒。超100MiB先压缩，见下；超500MiB拒绝 |
| 抓帧/关键帧 | 浏览器video/Canvas截图，帧图上传后进图谱；无专用extract-frame接口 |
| 视频编辑 | 打开同一OpenCut桥接，project为 `video-edit-<nodeId>`；导出在浏览器，文件上传回画布；不是VIDEO_EDIT模型按钮 |
| 裁剪/变速/倒放/旋转/镜像 | `/canvas/media/task/run`：`bizId,nodeId,operateType,spec,bizType=CANVAS,executor=FFMPEG`，取消复用media/task/cancel |
| 片段重拍 | 先新建配置节点；实际生成：media/task/run `operateType=CROP_DURATION` 切出选段→task/run重拍→media/task/run `operateType=COMPOSE` 接回原片。节点保存 `clipReshootClips,clipReshootFreeText,clipReshootDurationSec,clipReshootJob`；任务字段是多阶段，不仅一个prompt |
| 重拍价格预处理 | 有 `/media/jobs/submit` 截段缓存路径，`tracks.type=split` + trim/startMs/endMs，waitMs=60000；不能将点击价格都假定纯只读；请求含dryRun=false、priority=normal |
| 视频拼接节点 | `/media/jobs/submit`（不是一律canvas/media/task/run），多inputs + video clips有序拼接；GET jobs轮询。重拍内部COMPOSE则走canvas/media/task/run |
| 预览、播放、音量、全屏、下载、加入Agent | 本地/媒体URL；无独立生成HTTP |

深度压缩先 `/canvas/cos/fileSizes {urls:[url]}`，消费 `files:[{url,size}]`，无法确认大小时可直接进入模型。精确提交为 POST `/media/jobs/submit`：

```json
{"spec":{"version":1,"output":{"container":"mp4","bucket":"canvas","maxBytes":104857600,"preset":"veryfast"},"inputs":[{"id":"v","url":"<videoUrl>"}],"tracks":[{"type":"compress","clips":[{"input":"v"}]}]},"dryRun":false,"waitMs":0,"priority":"normal"}
```

GET `/media/jobs/{jobId}` 无body。源码消费 `jobId,status,outputs:[{url或originalUrl,durationMs?,width?,height?,sizeBytes?}],errorMsg,errorCode`；DONE或得到URL结束，FAILED/CANCELED/CANCELLED/ERROR终止。真实响应和status仍未实测。拼接同入口body顶层相同，spec改为 `output:{container:"mp4",videoCodec:"h264",audioCodec:"aac",bucket:"canvas",fps,width?,height?},inputs:[{id:"c0",url},{id:"c1",url}],tracks:[{type:"video",clips:[{input:"c0"},{input:"c1"}]}]`。


重拍内部CROP_DURATION的spec源码仅`{inputs:[{id:"c0",url}],tracks:[{type:"split",clips:[{input:"c0",trim:{startMs,endMs?}}]}]}`，没有version/output；价格预截段则POST `/media/jobs/submit`：

```json
{"spec":{"version":1,"output":{"container":"mp4","bucket":"canvas"},"inputs":[{"id":"c0","url":"<videoUrl>"}],"tracks":[{"type":"split","clips":[{"input":"c0","trim":{"startMs":1000,"endMs":5000}}]}]},"dryRun":false,"waitMs":60000,"priority":"normal"}
```

这些是不同handler的请求示例，不应强制每个spec必有version/output。

### 3D世界 / 3D模型

| 按钮 | 分流 |
|---|---|
| 文/图/视频生成3D世界，文/图生成3D模型，重试 | task/run，model config按 TEXT_TO_W3D / IMAGE_TO_W3D / VIDEO_TO_W3D / TEXT_TO_3D / IMAGE_TO_3D；不新增3D专用submit |
| 上传/重新上传SPZ/PLY/SPLAT、GLB/GLTF | 普通存储上传，结果引用进入节点data；生成后的纹理/白模封面也是浏览器WebGL截图→上传→图谱 |
| 进入世界/3D预览、旋转/缩放、重置、全屏、纹理/白模/法线、材质颜色/环境/灯光/背景、历史结果切换、复制提示词 | 本地WebGL/节点data，历史读取可复用node-history；不能据控件编造编辑模型REST |
| 下载原始文件/各分辨率/全部、导出预览材质GLB、截图 | 媒体URL下载，预览GLB/PNG由浏览器导出；没有后台3D导出任务 |
| 加入导演（新建或已有） | 本地图谱修改/导演桥接；后续图谱同步，按钮无独立import API |


## 7. 历史与节点标签

| 按钮 | 路径 | payload | response.data | 证据 |
|---|---|---|---|---|
| 全局历史/媒体tab/下一页 | `/canvas/his/list` | `{page:1,size:20,type:"IMAGE"}`；VIDEO/AUDIO/SPZ/TDM；剪辑另带canvasId | P，本次均空；条目源码读`id,resultUrl,createTime,resultType,taskId,taskPlanId` | 分页与5类type实测；条目源码 |
| 生成参数详情/复用 | `/canvas/his/generate/param/detail` | `{taskId,taskPlanId}` | 消费`snapshot:{nodes,edges},nodeId`，完整shape未知 | 源码 |
| 批量删除历史 | `/canvas/his/deleteBatch` | `{ids:[]}` | 消费`successList,failList`，元素兼容ID或对象 | 源码 |
| 从作品导入 | `/api/output/v2/history` | 见下 | 本次data是空数组`[]`；非空条目/分页包装待核对 | 实测 |
| 单节点历史/翻页 | `/canvas/node-history/page` | `{canvasId,nodeId,historyId?,pageNum:1,pageSize:10,knownRevision?}`；pageSize≤20 | `{batches,revision,resultCount,pageNum,hasNext}` | 源码 |
| 删除单节点输出 | `/canvas/node-history/delete-output` | `{canvasId,nodeId,historyId?,outputId,expectedRevision}` | `{revision,resultCount,fallback?:{batch,outputId}}` | 源码 |
| 标签列表 | `/canvas/node/tag/list` | `{}` | `[{id:string,name,color,sortOrder:number,status:number}]` | 实测 |
| 新建标签 | `/canvas/node/tag/create` | `{name,color}` | 标签对象 | 源码 |
| 改标签名/颜色 | `/canvas/node/tag/update` | `{id,name?,color?}` | 检查code | 源码 |
| 删除标签 | `/canvas/node/tag/delete` | `{id}` | 检查code | 源码 |
| 排序 | `/canvas/node/tag/sort` | `{ids:[]}` | 检查code | 源码 |
| 标签显隐 | `/canvas/node/tag/status` | `{id,status:1或0}` | 检查code | 源码 |
| 恢复预设 | `/canvas/node/tag/initPreset` | `{preset:"content"或"ecommerce",replace:false}` | 标签数组 | 源码 |

```json
{"size":30,"current":1,"status":["SUCCESS"],"taskType":["API","WEBAPP","WORKFLOW","ExclAPI","CORPAPI","FAST_WEBAPP","SKU_WEBAPP_API","SKU_WORKFLOW_API","FAST_WEBAPP_V2"],"hasOutput":true,"fastCreation":null,"fromId":"","onlyImageVideo":true}
```

作品导入是游标翻页：`fromId=上批最后taskId`，current固定1。源码消费`taskId,fileUrl,outputType,outputName,fileName,id?`；加入画布是本地节点创建。下载直接取媒体URL。

单节点远端历史仅当 `node.data.historyStorage.source="remote"`启用；旧节点可内嵌nodeOutputHistory。batch源码结构：`{batchId,taskId,createdAt,outputs:[{outputId,mediaId?,url,originalUrl?,thumbnailUrl?,outputType,width?,height?,durationMs?}],paramsSnapshot?,nodeConfigSnapshot,size?}`。revision处理分页/删除并发，1915冲突后重拉第一页；删除当前输出要同步fallback到节点和所选历史，不能只移除缩略图。给节点分配标签修改图谱，标签定义CRUD才请求上述接口。

## 8. 视频工具、画板、剪辑

### 节点视频工具（源码，未编辑媒体）

节点裁剪/速度/倒放/旋转/镜像以及重拍内部切段/拼回用 `/canvas/media/task/run`；独立拼接及部分压缩/截段走上文`/media/jobs/submit`。取消 `/canvas/media/task/cancel {taskId}`。这是FFmpeg任务，与AI模型task/run、OpenCut导出有区别。

```json
{"bizId":"<canvasId>","nodeId":"<nodeId>","operateType":"CROP","bizType":"CANVAS","executor":"FFMPEG","spec":{"version":1,"output":{"container":"mp4","videoCodec":"h264","audioCodec":"aac","bucket":"canvas","fps":24,"width":1280,"height":720},"inputs":[{"id":"a","url":"<videoUrl>"}],"tracks":[{"type":"video","clips":[{"input":"a","crop":{"x":0,"y":0,"width":1280,"height":720}}]}]}}
```

operateType已见`CROP,SPEED,REVERSE,ROTATE,MIRROR,ROTATE_MIRROR,CROP_DURATION,COMPOSE`；CROP_DURATION当前handler的split-spec只有inputs/tracks，不带version/output；clip对应`crop/speed/reverse/rotate/mirror`，mirror取horizontal/vertical。分割用`trim:{startMs,endMs?}`，拼接多个inputs及有序clips。响应消费兼容`taskId/jobId,status,videoUrl/outputUrl,errorMsg`与`outputs:[{url,objectKey?,durationMs?,width?,height?,taskId?,jobId?}]`；真实同步/异步返回形状待核对。

### 画板（当前SketchStudio模块）

| 按钮 | 请求 / 返回 | 证据 |
|---|---|---|
| 打开画板 | 原URL追加`/sketchboard`；读getCanvasDetail、getDictConfig `{dictTypes:["sketchboard_style_live"]}` | 实测 |
| 历史 | `/canvas/sketchboard/his/list {canvasId,page:1,size:50}` → P，本次空；条目源码读`id,resultUrl,generationMode` | 请求/分页实测，条目源码 |
| 实时绘制/手动生成/重新生成 | `/canvas/sketchboard/realtime/generate {canvasId,prompt,image,styleCode?,generationMode:"live"或"manual"}`；image为1024×1024 PNG data URL | 源码，未绘图/生成 |
| 进度 | `/canvas/sketchboard/realtime/status {taskId}` → 消费`status,taskId,imageUrl,errorMessage,chargeMessage`；1秒间隔、最多130次，SUCCESS/FAILED结束 | 源码 |
| 移动/画笔/橡皮/背景/形状/图层/撤销/重做/删除图层/替换到左侧 | 画板本地编辑；实时模式会进一步触发上述generate | 本地/源码 |
| 暂停实时生成、实时/手动切换、风格与描述 | 本地控制调度和生成参数 | 本地/源码 |
| 保存到资产/下载 | 复用资产入库或媒体下载 | 源码；未保存 |

### 剪辑（当前OpenCut模块）

入口iframe：`/opencut/index.html?project=<canvasId>&canvasId=<canvasId>&embedded=1&lang=zh&parentOrigin=<origin>`。

- 实测历史：`/canvas/his/list {canvasId,page:1,size:20,type:"IMAGE"}`；VIDEO同结构。我的资产：`/canvas/asset/user/group/list {code:"ALL",page:1,size:200}`；内容源码调用group/item/list `{groupId,page:1,size:200}`。画布素材来自getCanvasDetail/父页传入。
- 工程加载/创建/自动保存是浏览器IndexedDB `video-editor-projects/projects`，800ms防抖；媒体元信息存在`video-editor-media-<project>`，文件存在OPFS `media-files-<project>`。当前源码没有OpenCut工程服务端CRUD。
- 导入、拖轨道、分割、时间轴缩放、文本、属性、播放、比例、撤销/重做是本地编辑。导出由浏览器renderer生成视频ArrayBuffer/音频Blob，再下载或`postMessage {type:"opencut-export-to-canvas",data:{files:File[]}}`；父页上传文件并插入节点。
- Studio TV若要跨电脑继续剪辑，需额外工程存储；这是Studio TV后续扩展，不能宣称原站已有相同REST接口。不得把OpenCut导出直接映射成media/task/run。

## 9. 音色、自有角色/场景图库

均为当前源码，未创建或调用音频模型。

| 按钮 | 路径 | payload | response.data消费 |
|---|---|---|---|
| 音色语言/方言 | `/canvas/model/voice/lang/list` | `{queryTargetType,modelCode}` | `[{id,name,nameEn,dialectList:[{id,name,nameEn}]}]` |
| 音色场景 | `/canvas/model/voice/scene/list` | 同上 | `[{id,name,nameEn}]` |
| 音色库/我的收藏/搜索/筛选/翻页 | `/canvas/model/voice/record/list` | `{page:1,size:20,queryTargetType,modelCode,voiceName?,langId?,dialectId?,sceneIdList?:[],gender?}` | P；条目见下 |
| 收藏/取消音色 | `/canvas/model/voice/record/collect`或`uncollect` | `{voiceId}` | 检查code |
| 自有角色/场景列表 | `/canvas/{role或scene}/list` | `{page:1,size:20,keyword?,teamId?}` | 分页 |
| 图库详情 | 同前缀`/detail` | `{id}` | `{images:[{id,imageUrl,…}],…}` |
| 图库新建/更新/删除 | `/create`、`/update`、`/delete` | create完整body待核对；update `{id,…}`；delete `{id}` | 未核对 |
| 图库添图/删图/主图/排序 | `/image/add`、`delete`、`setMain`、`sort` | add `{galleryId,…}`待补；delete `{galleryId,imageIds:[]}`；setMain `{galleryId,imageId,…}`；sort `{galleryId,items:[{imageId,sortOrder}]}` | 检查code，完整data待核对 |

queryTargetType=`VOICE_LIBRARY|VOICE_USER_COLLECT`，gender=`FEMALE|MALE|UNKNOWN`；默认音色查page1/size1。条目消费`voiceId,voiceName,voiceNameEn,voiceType,description,coverUrl,isCollect,currentVoiceExampleUrl,currentLangName,currentDialectName,gender,specialLabel[],voiceLabel[]`；试听直接播放currentVoiceExampleUrl，选用只写入节点params。自有图库与公共character-library是两套资源，不能合并语义。

## 10. 提示词预设、风格与收藏（源码）

分类缓存5分钟，应用预设更新节点参数，不自动生成。原站可带teamId，Studio TV内部版不新增工作空间UI。

| 按钮 | POST path | payload | data消费 |
|---|---|---|---|
| 图片/视频预设分类 | `/canvas/prompt/category/tree` | `{scope:"IMAGE"或"VIDEO",menuType?:"portrait"或"role_design",teamId?}` | 树`[{id,name,children,isLeaf?,prop?}]` |
| 分类列表/搜索/分页 | `/canvas/prompt/system/list` | `{categoryId,keyword?,page,size,teamId?}` | 分页记录 |
| 多分类 | `/canvas/prompt/system/batchList` | `{categoryIds:number[],keyword?,page,size,teamId?}` | 分页记录 |
| 我的提示词 | `/canvas/prompt/user/list` | 分页参数，完整body待具体面板核对 | 记录列表 |
| 保存提示词 | `/canvas/prompt/create` | `{name,prefixPrompt,suffixPrompt,teamId?}`；妆容另用`categoryId,coverUrl` | 检查code |
| 编辑/删除自定义提示词 | `/canvas/prompt/user/update`、`delete` | update `{id,name,prefixPrompt,coverUrl,teamId?}`；delete `{id,teamId?}` | 检查code |
| 我的风格 | `/canvas/prompt/user/style/list` | `{page,size:10,name?,teamId?}` | 分页记录 |
| 新建/编辑风格 | `/canvas/prompt/user/style/create`、`update` | `{name,suffixPrompt,coverUrl,referenceImageUrl?,teamId?}`；update加id | 检查code |
| 删除风格 | `/canvas/prompt/user/style/delete` | `{id,teamId?}` | 检查code |
| 收藏列表 | `/canvas/prompt/favorite/list` | `{page,size:20,keyword?,categoryIdList?:number[],teamId?}`；风格size10；收藏标识预取size9999 | 分页记录 |
| 收藏/取消 | `/canvas/prompt/favorite/add`、`cancel` | `{promptId,teamId?}` | 检查code |
| 最近使用 | `/canvas/prompt/use/record/list` | `{page,size:10,name?,teamId?}` | 分页记录 |
| 使用记录 | `/canvas/prompt/use/record/add` | `{id,teamId?}` | 检查code |

预设行消费`id,name,prefixPrompt,suffixPrompt,coverUrl,referenceImageUrl,categoryId,promptCode,promptHidden,promptType,description,favorited,useRecordId`，各类不全具备；promptCode可能代表服务器隐藏预设，不能认为所有提示词都在前端明文。普通列表size20，人像首屏批量size999，角色设计size100。

## 11. AI 应用

| 按钮 | POST path | payload | data | 证据 |
|---|---|---|---|---|
| 广场/搜索/排序/分类/时间/翻页 | `/api/webapp/list` | `{size:30,current,search?,sort:"RECOMMEND"或"REPUTATION"或"HOTTEST"或"NEWEST",tags?:[],days?:1或7或30或90}` | 扩展分页，见下 | 推荐首屏实测，其余源码 |
| 分类 | `/api/portal/tag/tree` | `{rang:"WEBAPP"}`；字段确为rang | 分类树，选父类将childTags的id数组提交tags | 实测 |
| 我的收藏 | `/api/likeOrCollect/webapp/list` | `{operateType:2,size:30,current:1,search?}` | 同分页，本次空 | 基本字段实测 |
| 我的发布 | `/api/webapp/user/list` | `{size:30,current:1,userId?,search?}` | 同分页，本次空 | 含userId实测 |
| 应用详情/创建节点 | `/api/webapp/detail` | `{webappId}` | `name,workflowId,inputNodes,covers,instanceType,priceInfo`等 | 源码；未创建节点 |
| 平均费用 | `/api/cost/average` | `{dataId:webappId,dataType:"WEBAPP",instanceType:"default"}` | 当前完整shape待核对 | 源码 |
| 查看作品/翻页 | `/api/portal/creation/list` | `{webappId,current:1,size:20}` | 分页，条目消费`id,creationShowreelInfo.fileUrl` | 源码 |
| 当前收藏态 | `/api/likeOrCollect/status2` | `{dataId:webappId,type:2}` | 消费boolean或status/collected，确切shape待核对 | 源码 |
| 收藏/取消应用 | `/api/likeOrCollect/create`、`cancel` | `{dataId:webappId,dataType:"WEBAPP",type:2}` | 检查code | 源码 |
| 工作流节点定义 | `/api/workflow/getDetail` | `{workflowId}` | customNodes，过滤RH_前缀 | 源码 |
| 表单参数估价 | `/api/workflow/webapp-price-estimate` | `{webappId,inputs:[]}`；原站可带userId header | 待核对 | 源码 |

实测分页 `{records,size:string,current:string,total:string,pages:string,hasNext:boolean,hasPrevious:boolean,nextCursor:null}`；广场记录字段`id,name,intro,carefullyChosen,systemWorkflow,publishTime,timestamp,preview,owner,statisticsInfo,nodeCount,liked,covers,tags,labels,seq,appCatalogId,collect,homeShow`。发布记录源码映射`webappId,webappName,thumbnailUrl,thumbnailSize,useCount,collectCount`，本次空未核对完整条目。

应用节点`type="rh-ai"`，详情inputNodes是表单定义`nodeId,fieldName,fieldValue,fieldType,description/descriptionCn/descriptionEn`，不同于Model.config。运行前将binding.sourceNodeId的文本/媒体填fieldValue，保留apiKeyMode（standard/enterprise），然后同样task/run。Studio TV的供应商密钥由后端配置，不采用浏览器表单注入。`/api/user/task/work/valid`与`/task/third-party/config`仅定位到wrapper，按钮body待生成阶段核对。

## 12. Skill Hub 与 Agent

### Skill

| 按钮 | POST path | payload | data | 证据 |
|---|---|---|---|---|
| 首页推荐/换一批 | `/canvas/skill/list` | `{page:1,size:4,category:"CANVAS_AGENT",type:"COMMON",code:"CODE_DEFAULT_RECOMMENDED"}`；换批page递增 | P<Skill> | 首屏实测；换批源码 |
| 全部/搜索/排序/翻页 | 同list | `{page:1,size:10,category:"CANVAS_AGENT",type:"COMMON",querySortBy:"HOTTEST",code?,name?}` | P<Skill> | 基本字段实测 |
| 我的技能 | 同list | type="USER"，分页参数同上 | 分页 | 源码 |
| 技能分类 | `/canvas/skill/type/list` | `{category:"CANVAS_AGENT",type}` | 数组，条目待核对 | 源码 |
| 喜欢 | `/canvas/skill/collect/list` | `{page,size,category:"CANVAS_AGENT",name?}` | 分页 | 源码 |
| 详情 | `/canvas/skill/detail` | `{skillId}` | Skill加content和outputContentSample | 实测 |
| 收藏/取消/删除 | `/canvas/skill/collect`、`uncollect`、`delete` | `{skillId}` | 检查code | 源码 |
| 保存/编辑 | `/canvas/skill/save` | 见下 | 消费ID标量或对象skillId/id，实际shape待核对 | 源码 |
| 发布 | `/canvas/skill/publish` | `{publishSkillId,name,thumbnail,outputContentSample:[],isPublicContent}` | 检查code | 源码；内部版隐藏 |
| 添加到对话/使用记录 | `/canvas/skill/use/record/add` | `{canvasId,skillIds:[]}`；代码只提交纯数字ID | 检查code；选择本身更新对话上下文 | 源码 |
| Agent能力列表 | `/canvas/api/skill/list/agent` | 无body | `[{skillId,name,intro,presetPrompt}]`，本次127项 | 实测 |
| Markdown优化 | `/canvas/agent/skill/file/content/optimize` | `{message}`，内含path与Markdown | `{output:string}`，JSON解析optimized_content/summary/warnings | 源码，未运行 |
| 从对话创建技能 | `/canvas/agent/skill/chat/generate` | `{sessionId,instruction,maxTurns:20}` | data数组，元素未知 | 源码，未运行 |

Skill列表实测字段：`skillId,nickName,headPic,name,intro,useScenario,useGuide,outputContentDesc,presetPrompt,outputType,thumbnail,category,type,code,useCount,collectCount,createTime,updateTime,isCollect,isPlatform,isRecommend`。详情增加`content,outputContentSample`，详情不保证返回isPlatform/isRecommend。

```json
{"name":"<name>","intro":"<intro>","useScenario":"…","useGuide":"…","outputContentDesc":"…","presetPrompt":"…","outputType":"TEXT","content":[{"path":"SKILL.md","url":"<uploaded-url>","type":"md","primary":true}],"category":"CANVAS_AGENT","type":"USER"}
```

编辑加skillId，可选code/thumbnail。outputType=`IMAGE|VIDEO|AUDIO|SPZ|TEXT`；主要Markdown、name、intro为前端必填；name≤255、intro≤500、场景/说明/预设≤600；封面限图片10MB。Markdown、本地附件和封面先统一上传，再将URL放入content；已有远端URL不用重传。文件/文件夹选择是本地读取，没有独立skill/upload接口。

### Agent对话（源码，未发送消息）

| 动作 | method / path | 参数 | 结果消费 |
|---|---|---|---|
| 历史对话 | `GET /canvas/agent/cac/api/v1/sessions` | query `page=1&page_size=50&canvas_id=<id>` | **实测HTTP200、code1888、msg调用失败、data:null**；成功列表只从源码推断records/total |
| 读/删对话 | `GET` / `DELETE /canvas/agent/cac/api/v1/sessions/{sessionId}` | sessionId路径 | 待核对 |
| 发送 | `POST /canvas/agent/cac/api/v1/chat/stream` | 见下 | 流式文本/reasoning/工具事件，不是一次JSON结果 |
| 待执行客户端工具 | `GET /canvas/agent/cac/api/v1/chat/client-tools/pending` | query session_id | `session_id,status,call,resume_command,active_resume,host_events,terminal_recovered` |
| 停止复刻任务 | `POST /canvas/agent/cac/api/v1/chat/tasks/{taskId}/cancel` | `{mode:"immediate",reason:"user_requested_stop"}` | 待核对 |
| 备用Gateway聊天 | `POST /canvas/openclaw/chat` | 聊天上下文+toolOutputs；完整body未知 | stream/工具结果 |
| Gateway会话创建/列表/删除 | `POST /canvas/openclaw/sessions/create`、`list`、`delete` | list `{pageNum,pageSize,canvasId?}`；delete `{sessionId}`；create待补 | 待核对 |

chat body消费：`{message,session_id,agent_id:"canvas-main",stream:true,image_attachments?,skill_ids?,interaction_response?,runtime_event?,metadata:{source:"canvas-new",canvas_id,chat_mode,rich_stream:true,agent_language,host_capabilities,…},skill_package_id?,skill_package_source_scope?,skill_package_version_id?}`。会话成功条目源码读`session_id,title,updated_at,turn_count,created_at`；这次错误响应不能证明该schema。

Agent/生成偏好/先询问开关更新本地聊天上下文。不同配置可走HTTP流或WS；WS事件源码有`chat.start,chat.cancel,client_tool.resume,client_tool.cancel,session.attach,session.event`，接收`chat.started,chat.delta,chat.event`等。技能选择、上传附件后不等于已提交消息。流事件细节和工具回执需要真实对话验证。

### HyperFrames（当前子应用源码，未发聊天/渲染）

画布嵌`/labs/rhhyperframes?embedded=1&canvasId=<id>&lang=zh&parentOrigin=<origin>`，其内再嵌`/hyperframes-studio/index.html#project/<id>`。父弹窗sessionKey只是重挂载计数；服务器sessionId才是对话标识。

| 按钮 | method / path | 参数 | response消费 |
|---|---|---|---|
| 项目历史 | GET `/canvas/hf/projects` | query type=HYPER_FRAMES；Studio也可无type | `projects:[{id,title,…}]`，兼容data数组 |
| 工程对话列表 | GET `/canvas/hf/projects/session/list` | query projectId | `records:[{sessionId,title,updatedTime?,lastTurnTime?}]`；未见分页 |
| 绑定工程对话 | POST `/canvas/hf/projects/session/create` | `{projectId,sessionId}` | 只需成功 |
| 确认AI项目卡 | POST `/canvas/hf/projects/create` | `{projectId,type:"HYPER_FRAMES",title}`；projectId来自AI卡 | 只需成功 |
| 取消待创建工程 | DELETE `/canvas/hf/projects/:projectId` | 无body | 只需成功 |
| 新对话 | POST `/canvas/openclaw/business/sessions/create` | `{businessCode:"HYPER_FRAMES"}` | `{sessionId:string}` |
| 初始化HF Agent | POST `/canvas/openclaw/hf/agents/create` | `{sessionId}` | `{agentId:string}` |
| 历史对话内容 | POST `/canvas/openclaw/sessions/detail` | `{sessionId,pageNum:1,pageSize:50}` | `records,total`；行rawRequest/rawResponse，后者为SSE原文 |
| 删除对话 | POST `/canvas/openclaw/sessions/delete` | `{sessionId}` | 只需成功 |
| 发送/方案/表单提交 | POST `/canvas/openclaw/chat` | `{messages:[{role,content}],sessionId,stream:true,temperature:0.7,isNewSession,agentId,businessType:"HYPER_FRAMES",previousResponseId?}` | SSE，见下 |
| 文件树 | GET `/studio-api/projects/:id` | 无body | `{files:string[],dir?}` |
| 打开文件 | GET `/studio-api/projects/:id/files/:encodedPath` | 可加optional=1 | `{content:string}` |
| 保存/新建文件 | PUT / POST同files路径 | text/plain文件全文；目录创建`.gitkeep`空文件 | 只需HTTP成功 |
| 删除/改名 | DELETE / PATCH同files路径 | DELETE无body；PATCH `{newPath}` | 只需成功 |
| 复制文件 | POST `/studio-api/projects/:id/duplicate-file` | `{path}` | `{path}` |
| 上传素材/字体 | POST `/studio-api/projects/:id/upload` | multipart重复file字段，可带query dir | `{files,skipped?,invalid?:[{name,…}]}` |
| 预览/合成预览 | GET `/studio-api/projects/:id/preview`、`/preview/:path`、`/preview/comp/:path` | 无body | HTML/媒体 |
| 变更通知 | GET `/studio-api/events` | SSE | file-change事件，刷新预览 |
| 工程检查 | GET `/studio-api/projects/:id/lint` | 无body | `{findings:[{severity,message,file,fixHint}]}` |
| 组件列表/安装 | GET `/studio-api/registry/blocks`；POST `/studio-api/projects/:id/registry/install` | GET无body；POST `{blockName}` | 数组；安装`{written,block}` |
| 删除时间线元素 | POST `/studio-api/projects/:id/file-mutations/remove-element/:encodedFilePath` | `{target:{id?:DOM id,selector?,selectorIndex?}}`，id/selector至少一项 | `{content}`新文件正文 |
| 渲染历史 | GET `/studio-api/projects/:id/renders` | 无body | `{renders:[{id,status,filename,createdAt,durationMs}]}` |
| 导出 | POST `/studio-api/projects/:id/render` | `{fps:24或30或60,quality:"draft"或"standard"或"high",format:"mp4"或"webm"或"mov",resolution?:"1080p"或"4k",composition?}` | `{jobId}`；auto省略resolution，子合成传composition文件路径 |
| 导出进度 | GET `/studio-api/render/:jobId/progress` | SSE | progress事件`{progress,stage?,message?,status,error?}`，complete/failed结束 |
| 删除渲染记录 | DELETE `/studio-api/render/:jobId` | 无body | 只需成功 |
| 预览/下载/回画布 | GET `/studio-api/projects/:id/renders/file/:filename` | 下载加?download | 媒体/Blob；回画布转File并postMessage |

聊天附件上传后写进content中的Markdown链接。SSE消费`chat.delta/chat.final`的text、`chat.error`的error、`response.created`的response.id、`response.output_text.delta/response.text.delta`的delta、`response.completed`完整文本及兼容choices delta；`[DONE]`结束。消息中的creative-doc/form-fields/hf-project/html fenced内容转换成方案、表单、项目卡、HTML，不能把它们当一次POST的固定JSON对象。停止只abort当前流，未确认HF专属cancel接口。

回画布消息`hyperframes:import-to-canvas {files:File[]或Blob[]}`或`{url,filename}`，父页上传/插节点，回complete/error。字幕改动复用files PUT保存caption-overrides.json；导出前等待文件保存。渲染偏好localStorage `hf-studio-render-settings`，默认30/standard/mp4。HF是服务器文件工程和渲染任务，不能仿照OpenCut只做浏览器本地合成，也不能直接替换为canvas/media/task/run。

## 13. 导演台（当前源码，未发写请求）

两种存储路径需分开：从rh-director节点打开为`nodeStorageMode:true`，关闭时回写`node.data.schema/directorThumbnail`，随画布保存；不显示独立工程列表，快捷键独立工程保存也禁用。截图/视频上传后可新增画布节点及连线。工具栏2D/世界3D独立入口为false，才使用下表独立工程CRUD。

| 功能 | POST path | payload | data消费 |
|---|---|---|---|
| 独立工程列表 | `/canvas/director/project/list` | 当前UI `{page:1,size:50,type:"2D"或"3D"}`；wrapper默认20 | 分页 |
| 创建 | `/canvas/director/project/create` | `{type,name,thumbnail:null,content:null或工程object}` | `{id}` |
| 打开 | `/canvas/director/project/detail` | `{id}` | `{id,content,…}` |
| 保存/改名 | `/canvas/director/project/update` | `{id,name?,thumbnail?,content:object}`；字符串输入发出前JSON.parse | 检查code |
| 删除 | `/canvas/director/project/delete` | `{id}` | 检查code |
| 平台模型库 | `/canvas/director/model/list` | `{}`或`{keys:string[]}`，不是分页 | `[{key,label,description,models:[]}]` |
| 个人模型库 | `/canvas/director/model/user/list` | 当前UI `{page:1,size:100,keyword?,teamId?}`；wrapper默认20 | 分页 |
| 上传模型入库/删除 | `/canvas/director/model/user/create`、`delete` | create `{name,url,previewImage?,teamId?}`；delete `{id}` | ID或成功码 |
| 动作分类 | `/canvas/animation/category/list` | `{}` | `[{code,name,nameEn}]` |
| 动作搜索/分类/分页 | `/canvas/animation/resource/list` | 当前UI `{page,size:24,categoryCode?或keyword?}` | `records:[{id,name,nameEn,cosUrl}],pages` |

3D编辑、相机、动作和预览为本地状态；独立模式保存content才走工程持久化，节点模式只更新图谱schema。glb/gltf/obj/fbx先统一canvas上传（preventDuplicate=true）得到URL，可选PNG封面也先上传，再创建模型记录。不能因显示“工程”就强制为所有导演节点创建另一条服务端工程。

## 14. 用户设置、消息、批注

| 按钮 | POST path / payload | data / 行为 | 证据 |
|---|---|---|---|
| 快捷键/缩放灵敏度/交互模式保存 | `/canvas/user/update/shortcutKeyConfig {shortcutKeyConfig:{zoomSensitivity,submitTask,newline,interactionMode}}` | 检查调用结果；300ms防抖 | 源码 |
| 常用参数设置 | 复用model/list、group/list；无独立保存HTTP | localStorage `rh-node-parameter-presets:v1`存`{version:1,byMode:{[mode]:{modelCode,params,generateNum}},enabledByCategory:{[category]:boolean}}` | 源码 |
| 更新记录分页 | `/canvas/notice/page {current:1,size:10,noticeType:"UPDATE_RECORD"}` | 扩展P，行见下 | 实测 |
| 更新记录已读 | `/canvas/notice/read {noticeId}` | 检查code；详情直接用列表行 | 源码 |
| 官方消息分页 | `/api/message/list/v2 {size:20,current:1,tabType:"TAB_OFFICIAL_MESSAGE"}` | 扩展P，本次空；分页数字为string | 实测 |
| 官方消息已读 | `/api/message/updateReadStatus {msgId:[]}` | 检查code；详情复用列表行 | 源码 |
| 未读红点 | `/api/message/user/unreadCount {}` | `{officialMessageCount:string,interactionMessageCount:string,versionNotifyCount:string}` | 实测 |
| 通知/声音开关 | 无HTTP | localStorage `rh_canvas_notify_settings`存`{notificationsDisabled,soundDisabled}` | 本地/源码 |
| 教程/快捷键/反馈入口 | 教程和反馈跳转链接；快捷键本地弹窗 | 不创建业务任务 | 本地/实测入口 |
| 内嵌反馈提交（源码支持） | `/canvas/feedback {canvasId,feedbackContent,imageUrl?:[]}` | 检查code，文本≤512 | 源码 |
| 批注创建/列表 | `/canvas/team/comment/create {canvasId,content,groupId?}`；`list {canvasId,groupId,page:1,size:100}` | create消费groupId；list分页条目`commentId,content,nickName,headPic` | 源码 |
| 批注更新/删除 | `/canvas/team/comment/update {commentId,content}`；`delete {commentId}` | 成功后重读 | 源码 |

偏好枚举：zoomSensitivity=10..100（默认25），submitTask=`enter|shift-enter|none`，newline=`enter|shift-enter`，interactionMode=`rhtv|comfyui`。更新记录实测行：`id:number,noticeId:string,noticeType,title,coverImageUrl:null|string,jumpUrl:null|string,content,popupEnabled:boolean,publishTime:number,hasRead:boolean`；分页另有hasNext/hasPrevious/nextCursor。官方消息空列表的行仅源码消费`id,messageType,title,content,sendTime,hasRead`，title/content可为cn/en JSON。

## 15. Studio TV当前缺口及最小落库范围

核对位置：`apps/web/src/service/runtime.ts`、`service/storage.ts`、`runtime/native-bootstrap.js`及Go的`internal/core`。当前“预留路由”与“已实现服务”分开列。

| 功能 | Studio TV当前 | 必要改造 |
|---|---|---|
| 登录/工具权限 | IPAC、tv.access已接通 | 保持头像姓名；不新增工作空间感知 |
| 项目/画布 | 真实项目CRUD/pin；GET/PUT快照、ETag/412冲突保护 | 保留；当前是HTTP快照，不是原站多人Yjs服务 |
| 上传/基础文件资产 | 真实asset-uploads预签名PUT+complete；assets分页/详情/删除 | 保留并连接个人素材库；补文件夹/分类/节点content语义 |
| 角色库/筛选/收藏 | list/filter来自fixture、浏览器分页；service写操作501 | 真实角色分页、属性过滤、收藏关系；fixture只作种子 |
| 模型/家族 | 旧响应静态快照 | 配置目录/版本；表单读config，实际模型调用由后端适配 |
| 我的/公共工作流、提示词、Skill、AI应用 | 多数读fixture；写501，部分我的列表显式空 | 真实目录、个人资源、收藏、使用记录、分页详情 |
| 标签/单节点历史 | tag/list空；node-history/page空batches/revision0 | 标签排序/状态、历史分页/并发版本 |
| 全局历史、音色、自有图库、独立导演工程 | 目录/独立工程读写通常501；导演节点schema可随现有图谱保存 | 补目录与独立模式CRUD，节点模式沿用快照 |
| 生成、优化、识别、价格 | 未接模型；501/MODEL_PROVIDER_NOT_CONFIGURED | 通用任务、节点计划、输出、模型适配；特殊OpenAPI/压缩链路另接 |
| Agent/HyperFrames | 会话/流未接；HF项目空；WS/EventSource为断开模拟器 | 真实会话、流、工具回执与渲染状态 |
| 剪辑 | 原站本地工程逻辑 | 可先保留；跨电脑工程另增持久化，不能伪装原站接口 |
| 充值/社区/公开发布/分享 | 内部版入口隐藏；相关API禁用或未实现 | 本轮不接公开服务功能 |

继续使用现有PostgreSQL 17，无需因角色库分页换数据库。最小资源：角色+筛选属性、用户收藏；资产目录+资源条目；工作流/提示词/Skill/应用目录；标签；任务+节点计划+输出+历史revision；Agent/HF会话与独立导演工程。按用户/类型/目录、keyword/属性、创建时间建立查询索引；模型config与图谱/工程content用JSONB，媒体放现有文件服务/对象存储。模型任务异步状态和输出历史不能仅写进前端文件。

现有`contracts/openapi.json`与`contracts/canvas-extension.json`中的冻结基础契约不在本轮改动。已有models/model-groups/workflows/skills/generations可由兼容层适配；角色/目录/历史等缺口补独立扩展。外观和交互继续使用原结构，兼容层负责将原payload转换到Go服务；不再让生产模式静默落回fixture或localStorage模拟写成功。

## 16. 后续真请求核对点

1. 按本表42类的核心场景逐个生成：保存最终task/run图谱、成功/失败包、taskId、原始status、计划和outputs；先LLM、文生图、图生图、图生视频、首尾帧、全能参考，再音频/3D/脚本等。
2. 核对取消、失败恢复、组执行、重复提交execution_key与原站实时回推；确认任务如何关联全局历史、node-history与revision。
3. 编辑元素的识别/抠图/图层输出、视频深度转换前的压缩链路、媒体工具和画板分别实测，不能用通用模型结果替代。
4. 补非空历史/资产条目、自有图库create/image-add、我的提示词完整body和批量删除部分失败包；导演台独立工程写请求及返回需实测。
5. Agent业务1888解决后再核对流事件/会话/工具回执；HyperFrames真实聊天和渲染返回需独立验证。

导演台证据模块：`CanvasLocalDirectorModal-B4xwTpGE.js`、`DirectorModal-hHdaqKx5.js`。

HyperFrames证据模块：Nuxt `DnrBWGn2.js/CTdN3t-M.js/BIQB8jbe.js/DU-34EBO.js`、Studio `index-BwvD1qfL.js`。

原始采集与当前JS保存在本机忽略目录`.local/api-audit/`，未入Git；此文只保留参数、结构和证据等级。当前页面证据模块：`index-DKBxKApn.js`、`CanvasEditorShell-Y7-TSLFr.js`、`SketchStudioPage-Bn4inzwl.js`、OpenCut `index-CTfB2_56.js`、SkillCreate `SkillCreatePage-D8X4yAXh.js`。
