# 原复刻接口到新后端协议的迁移映射

**这里只是迁移设计，兼容层尚未实现。** 当前预览仍由mock/cached响应驱动；写下70条映射不代表旧组件可立即连接新REST服务。新协议入口 `/api/v1`，结构以 `openapi.json` 为准。

原审计原样保存在 `legacy-inventory.json`；本文与 `legacy-mapping.json` 逐条覆盖70个 method/path。`MAPPED_DESIGN`表示已定义迁移规则，`DEFERRED`表示返回501直到协议扩展，`RETIRED`表示旧调用须重写/退出。

## 一致规则

- **idRule**：所有服务实体ID必须从新服务权威字符串ID和显式legacy别名注册表取得；禁止用已有fixture中超2^53 rounded数字字符串化恢复。未知别名返回404；客户端原userId不能决定主体；安全小整数也不能仅因存在缓存就作权威关联。
- **paginationRule**：new.data.items逐条转换成records；current=new.data.page，size=pageSize，total保留服务端total，pages=ceil(total/pageSize)，hasNext=hasMore。不可把total重置为已加载条数；不可通过过滤第一页伪造服务器分页。
- **envelopeRule**：新成功{code:0,message,requestId,data}→旧成功{code:0,msg:message,errorMessages:null,data:转换结果}；保存requestId用于排错。非2xx必须reject，禁止success({})通用兜底。
- **errorRule**：HTTP401/UNAUTHENTICATED可触发旧登录UI；业务HTTP412/VERSION_CONFLICT必须显示版本冲突且保留当前数据，绝不能变成旧code412登录失效。DEFERRED=501 NOT_IMPLEMENTED，RETIRED=410 LEGACY_ENDPOINT_RETIRED。
- **authenticationRule**：删除预览unsigned JWT和localStorage模拟身份；短期access token内存管理；刷新cookie HttpOnly；refresh/logout使用CSRF。旧MD5/Firebase ID token不冒充新password/code grant。
- **mutationRule**：按新operation要求补Idempotency-Key/If-Match/CSRF；同一用户操作重试用相同幂等键与desired状态；无合法ETag不覆盖更新。
- **reactionRule**：PUT=active true、DELETE=active false；旧toggle必须在UI确定一次desiredActive并固定，不能重试反转。
- **localeRule**：中文/English/日本語/한국어映射zh-CN/en/ja/ko；LocalizedText按当前locale→同语言字段，缺语言按明确fallback。Currency/region不用于权限判断。
- **uploadRule**：必须createAssetUpload→预签名PUT→completeAssetUpload，READY后引用assetId；不暴露永久云密钥、不使用原站密钥、不将任意远端URL/blob URL作生成输入。
- **graphExecutionRule**：canvas/task/run、canvas/price/estimate和task batch/cancel属原图节点+Yjs编辑器协议，当前501；不属于首页GenerationInput。

- **invocationTypeRule**：直接模式GenerationInput.invocationType必填非空，旧prefs.directSubType明确映射且属于所选Model.invocationTypes，服务端报价/执行均校验并绑定。AGENT输入可省略或null，服务端计划每个PlanStep必须有权威模型支持的invocationType。

## 首页创作迁移

原 `/canvas/create` 的空请求只创建画布；创作输入在launch payload，通过 `agentLaunchKey` 交给原编辑器。新首页必须用明确GenerationInput完成报价、生成与结果状态。

- 旧create {}只创建项目；从launch payload.text/prefs/skillIds/activeSkillTag/motionTransfer读取明确输入。
- mode由prefs.directMode或motionTransfer映射AGENT/IMAGE/VIDEO/MOTION_TRANSFER；modelId、capabilityVersion与invocationType必须来自新服务权威模型目录；旧prefs.directSubType→GenerationInput.invocationType，须严格属于所选Model.invocationTypes，不能只凭modelId猜调用能力。直接IMAGE/VIDEO/MOTION_TRANSFER模式invocationType必填且非空，绑定报价inputHash与执行校验。AGENT输入可省略或为null，由服务端规划；计划每个PlanStep.invocationType必填并经对应模型目录校验。
- prompt=text；params为模型schema验证后的directModelParams/agent偏好；generateNum→outputCount；旧directSubType转换成已验证invocationType而非混进params。IMAGE/VIDEO/MOTION_TRANSFER要求executionPolicy=AUTO；AGENT agentAutoRun=false→ASK、true→AUTO。prefsAutoRun只是自动参数选择，不是收费授权。
- 附件必须READY本服务assetId，并赋予受支持role。motionTransfer.imageUrl/videoUrl先经授权上传资产导入/绑定，禁止把URL直接送入GenerationInput。
- 旧skillIds[]→skillSelections[{skillId:权威ID,subOptionId:null}]。activeSkillTag.parentSkillId/agentSkill映射skillId，activeSkillTag.subOptionId/agentSubSkill必须保留为权威subOptionId；是父选项本身才为null。对同一技能去重时保留明确子选项，冲突子选项拒绝而非静默丢弃；服务端核验子选项归属。
- 旧skipPromptExpand/agentSkipExpand以及subOption.noExpand不能作执行权威；后端从技能目录subOptions.skipPromptExpansion解算。模板/workflow来自明确权威templateId/workflowId和source。
- quoteGeneration(input)返回INITIAL报价；createGeneration body={quoteId,input}，同一完整输入绑定inputHash及模型能力、资产校验和、费用快照；带稳定Idempotency-Key。
- ASK仅运行已授权规划阶段，进入AWAITING_CONFIRMATION后使用confirmationQuote；confirmGeneration body={quoteId,expectedRevision}并绑定服务端planRevision。
- 待确认计划报价过期用refreshGenerationQuote(generationId,{expectedRevision})，只重报价已保存计划，不重新规划/收费；取得新Generation.confirmationQuote后再次显示并确认；getGenerationQuote可读报价详情。
- 状态用getGeneration/streamGenerationEvents，恢复用generationId；不要从createProject成功假装生成成功。

**原 `/canvas/task/run`、图估价、task批量状态与取消都返回501。** 它们是图节点执行/Yjs编辑器协议，不属于首页GenerationInput。

## 逐路径决策

| 旧接口 | 状态 | 新 operationId | 关键转换 / 暂缓原因 |
|---|---|---|---|
| `POST /uc/getUserInfo` | MAPPED_DESIGN | `getMe`, `getWallet`, `getMembership` | 忽略旧body.userId作为身份来源；使用已验证会话。团队范围仅用已授权X-Team-Id。；id/userId=User.id，nickName/userName=displayName，headIcon/avatar=avatarUrl；walletInfo.balance=wallet.amount十进制字符串且currency=wallet.currency；memberInfo从MembershipStatus.activePlan或User.memberships按明确范围适配；userRegion仅作界面地区映射，不作权限依据。；限制：原组件使用的会员限制字段须按新memberships/features改写；不输出normalApiKey/sharedApi/exclusiveApi等密钥。 |
| `POST /uc/sendEmailCode` | MAPPED_DESIGN | `createSignInChallenge` | email→{channel:EMAIL,identifier:email,purpose:SIGN_IN}；在适配器会话上下文保存返回challenge.id；旧captcha token不能冒充身份或新challengeId。；将挑战结果转换成发送成功提示；不泄漏账号是否存在。；限制：不重复传出原站captcha provider；需要修改登录UI保存challengeId；channel/inviteCode如需归因须另建协议。 |
| `POST /uc/emailLogin` | MAPPED_DESIGN | `createSession` | email用于关联当前挑战，code→{grantType:OTP,challengeId:已存挑战ID,code}；缺challengeId拒绝。；保留新的短期accessToken于内存和HttpOnly刷新cookie机制；重写旧T5，而非照搬refresh_token到localStorage；expiresIn为秒，若旧显示需要绝对时间则Date.now()+expiresIn*1000。；限制：登录用户来自Session.user；不伪造旧identify；移除预览unsigned JWT注入。 |
| `POST /uc/googleLogin` | RETIRED |  | 旧Firebase idToken交换不能当成新Google OAuth authorization code；删除原Firebase redirect调用与原站配置，用PKCE授权→code交换。； |
| `POST /uc/abroad/pwdLogin` | RETIRED |  | 旧浏览器MD5密码摘要不能作为新PASSWORD明文输入；替换密码表单提交点，HTTPS下提交原密码，服务端使用安全哈希验证。； |
| `POST /uc/pwdLogin` | RETIRED |  | 旧手机号+MD5登录不等于新邮箱PASSWORD或OTP授权；手机号密码登录未定义，改写UI或扩展认证协议。； |
| `POST /uc/logout` | MAPPED_DESIGN | `getCsrfToken`, `deleteSession` | 无body；同源CSRF token→X-CSRF-Token；携带HttpOnly刷新cookie。；仅服务端会话撤销成功后清除本地登录状态；401按已登出处理策略，网络失败不能声称服务端已撤销。 |
| `POST /canvas/model/list` | MAPPED_DESIGN | `listModels` | types[]按invocationType白名单逐项查询/合并去重；可按mode IMAGE/VIDEO/MOTION_TRANSFER先查询完整候选集再按types过滤，不能把全类型数组传入单值参数。；将Model按invocationTypes聚合为{type,modelList}；modelCode=code，modelName/nameEn=name语言，description/name同理，icon=iconUrl；id使用权威字符串。parameterSchema/defaultParams/inputs编译成旧config和generateNum。；限制：skuId只作为本服务权威modelId的适配别名；不回传原站sku/API URL；参数控件若无法无损编译必须改成新schema渲染。不可从捕获数字修复ID。 |
| `POST /canvas/model/group/list` | MAPPED_DESIGN | `listModelGroups`, `listModels` | {}→查询组树与模型目录，同一capability版本组合。；id→modelGroupId、name→modelGroupName/modelGroupNameEn、children→modelGroupList；modelIds通过权威Model目录展开为nodeModelList[{nodeType,modelList}]，nodeTypeList由invocationTypes去重。；限制：不得展平组树。原modelCode/type参数关系仍由服务端校验。 |
| `POST /canvas/config/query` | MAPPED_DESIGN | `getHome` | 仅支持明确迁移的配置type：CANVAS_HOME_CAROUSEL从home.banners取值；其他旧type需配置映射表，未知type返回501。；CAROUSEL转换成{type,content:[{mediaUrl,mediaType:IMAGE→image/VIDEO→video,titleZh:title[zh-CN],titleEn:title.en,linkUrl:action.url,sort:实际顺序}]}；新CREATE_PROJECT动作需新UI处理，不伪造链接。；限制：CANVAS_NEW_AGENT、白名单/Yjs历史等非新HomeBootstrap字段，不能从features任意猜同名配置。 |
| `POST /canvas/config/queryByTypes` | MAPPED_DESIGN | `getHome` | types[]逐项经过获支持的配置表；功能开关引用home.features，上传限制引用uploadLimits。；仅返回已定义语义的{type,content}；未知type整项显式unsupported，由新UI按home字段消费。；限制：这是启动配置迁移设计，非原站完整配置API；不能所有type回复null并称兼容。 |
| `POST /api/portal/v2/getDictConfig` | RETIRED |  | 新首页改用getHome.links/features；旧任意dictTypes和system_contact_way二维码对象没有新字典服务。固定能对应的链接可由UI读取home.links，不能对任何dictTypes回放同一缓存。； |
| `POST /canvas/home/highlight/query` | DEFERRED |  | HomeBootstrap尚未定义原highlight字段、CLONE_CANVAS与shareId组合；不能把Banner.CREATE_PROJECT.sourceId当成shareId。新首页可按Banner逻辑实现，原highlight透明兼容暂缓。； |
| `POST /canvas/home/hot-skill/query` | MAPPED_DESIGN | `listSkills` | {}→page1,pageSize6,sortHOT；范围遵守公开内容可见性。；取items最多6，按Skill规则输出{skillId,name,thumbnail,...}。；限制：原热技能排序服务若不同于HOT，需进一步定义，不能假装相同排名。 |
| `POST /canvas/list` | MAPPED_DESIGN | `listProjects` | page→page；size→pageSize；keyword→q；querySortBy=UPDATE_TIME且DESC→sort=UPDATED_DESC；CREATE_TIME/DESC→CREATED_DESC；NAME/ASC→NAME_ASC；personal不带X-Team-Id，team由权威teamId映射并发送X-Team-Id。；new.data.items逐条转换成records；current=new.data.page，size=pageSize，total保留服务端total，pages=ceil(total/pageSize)，hasNext=hasMore。不可把total重置为已加载条数；不可通过过滤第一页伪造服务器分页。；记录id/name/revision/createdAt/updatedAt保留；ownerId/teamId保持字符串；coverAssetId如需thumbnail先读getAsset解析受权URL。；Project.pinned→旧置顶状态；保留服务端先pinned后sort的排序，不能客户端丢弃分页范围后重排。；限制：folderId、非CANVAS queryScope及未列排序返回501；团队由服务端校验，不能混入其他主体项目。 |
| `POST /canvas/create` | MAPPED_DESIGN | `createProject` | 旧{}→{name:按当前locale的默认项目名}，只创建项目；传Idempotency-Key并为同次操作重试复用。新来源由明确source{kind,id}指定。；new Project.id→旧{ id:string }；创建成功只代表项目存在，未执行生成。；限制：创作payload不在旧请求里；按homepageLaunch单独quoteGeneration→createGeneration，不能让canvas/create隐式收费。 |
| `POST /canvas/rename` | MAPPED_DESIGN | `getProject`, `updateProject` | id→projectId，name→PATCH body.name；先用已保存当前ETag/读取getProject，If-Match必须与用户看到的版本一致；冲突拒绝。；持久化Project.id/name/revision→旧成功对象并刷新项目列表。；限制：不能在冲突后静默获取新ETag覆盖别人修改。 |
| `POST /canvas/delete` | MAPPED_DESIGN | `getProject`, `deleteProject` | id→projectId；带If-Match和Idempotency-Key；同操作重试复用。；Deleted.id/deleted→旧成功确认；按服务端结果更新UI。；限制：删除失败不得先永久移除本地项目；412 VERSION_CONFLICT不能变成登录失效。 |
| `POST /canvas/pin` | MAPPED_DESIGN | `setProjectPin` | id→projectId；PUT设置pinned=true，非toggle；团队使用授权X-Team-Id；该接口不需要If-Match且不能覆盖项目名称/画布。；Project.pinned/updatedAt/revision真实返回，UI同步新revision；重试PUT保持true。 |
| `POST /canvas/unpin` | MAPPED_DESIGN | `removeProjectPin` | id→projectId；DELETE设置pinned=false；团队使用授权X-Team-Id；不覆盖其他项目字段。；Project.pinned/updatedAt/revision真实返回；重试DELETE保持false。 |
| `POST /canvas/share/link` | MAPPED_DESIGN | `createProjectShareLink` | canvasId→projectId；分享请求body={allowClone:用户明确设置,expiresInSeconds:明确期限或服务端默认7日}；带用户当前If-Match与Idempotency-Key；服务端限制最长30日及拥有者/团队管理员。；ProjectShare.url→shareUrl，ProjectShare.id→shareId并保存，expiresAt/allowClone真实返回；分享的是冻结revision且已移除私有输入/密钥的快照。 |
| `POST /canvas/share/clone` | MAPPED_DESIGN | `getProjectShare`, `cloneProjectShare` | shareId通过getProjectShare验证未过期/未撤销且allowClone=true；POST cloneProjectShare没有body，带Idempotency-Key和目标授权X-Team-Id；不把compositionId当shareId。；新Project.id→{canvasId:id}；创建副本不执行图也不扣费；服务端只复制合法可分享的资产。 |
| `POST /canvas/skill/list` | MAPPED_DESIGN | `listSkills` | page/size→page/pageSize；name→q；categoryCANVAS_AGENT按Skill.category映射；querySortByHOTTEST→sortHOT；typeCOMMON→scopePUBLIC，typeUSER→scopeOWNED（须已认证）；未知type拒绝400。；new.data.items逐条转换成records；current=new.data.page，size=pageSize，total保留服务端total，pages=ceil(total/pageSize)，hasNext=hasMore。不可把total重置为已加载条数；不可通过过滤第一页伪造服务器分页。；skillId=id，name=localize(title)，intro=localize(description)，thumbnail=coverUrl，nickName=author.displayName，headPic=author.avatarUrl，useScenario=localize(scenario)，useGuide=localize(guide)，isCollect=collected，category=category。未提供的计数、presetPrompt、outputContentDesc等不得伪造，UI改为用新结构/隐去未支持内容。；限制：code与其他未列排序返回501；原使用/收藏计数不在Skill定义，相关UI要改用新结构。 |
| `POST /canvas/skill/type/list` | MAPPED_DESIGN | `listContentCategories` | categoryCANVAS_AGENT/typeCOMMON→kindSKILLS。；Category.id,label→旧类别对象字段；类别code必须使用权威ID/注册code，不从标签生成。；限制：USER私有技能类型尚未支持，返回501。 |
| `POST /canvas/skill/collect/list` | MAPPED_DESIGN | `listSkills` | page/size→page/pageSize；name→q；scope=COLLECTED，必须Bearer认证；服务器先按收藏者筛选再分页。；new.data.items逐条转换成records；current=new.data.page，size=pageSize，total保留服务端total，pages=ceil(total/pageSize)，hasNext=hasMore。不可把total重置为已加载条数；不可通过过滤第一页伪造服务器分页。；skillId=id，name=localize(title)，intro=localize(description)，thumbnail=coverUrl，nickName=author.displayName，headPic=author.avatarUrl，useScenario=localize(scenario)，useGuide=localize(guide)，isCollect=collected，category=category。未提供的计数、presetPrompt、outputContentDesc等不得伪造，UI改为用新结构/隐去未支持内容。 |
| `POST /canvas/skill/detail` | MAPPED_DESIGN | `getSkill` | skillId→contentId，查权威ID注册表。；skillId=id，name=localize(title)，intro=localize(description)，thumbnail=coverUrl，nickName=author.displayName，headPic=author.avatarUrl，useScenario=localize(scenario)，useGuide=localize(guide)，isCollect=collected，category=category。未提供的计数、presetPrompt、outputContentDesc等不得伪造，UI改为用新结构/隐去未支持内容。；旧detail必有skillId；不存在返回404，不返回null成功。 |
| `POST /canvas/skill/collect` | MAPPED_DESIGN | `setCollection` | skillId→contentId；PUT设置active=true；同次请求重试保持true。；Reaction.active→isCollect；count仅在确需旧显示时映射为collectCount。 |
| `POST /canvas/skill/uncollect` | MAPPED_DESIGN | `removeCollection` | skillId→contentId；DELETE设置active=false。；Reaction.active→isCollect；保留真实count。 |
| `POST /canvas/common-workflow/list` | MAPPED_DESIGN | `listWorkflows`, `getWorkflow` | 带id的详情请求→getWorkflow(contentId=id)，组装单条分页；普通page/size→page/pageSize，搜索显式q。；new.data.items逐条转换成records；current=new.data.page，size=pageSize，total保留服务端total，pages=ceil(total/pageSize)，hasNext=hasMore。不可把total重置为已加载条数；不可通过过滤第一页伪造服务器分页。；id=id，name=localize(title)，description=localize(description)，thumbnail=coverUrl，userId=author.id，nickName=author.displayName，headPic=author.avatarUrl，favorited=favorited，workflowContent=graph。图节点格式如果与原ReactFlow不兼容必须通过显式图编译器，不能直接运行。；限制：原code/其他筛选语义未审计/未声明，不透传；工作流图执行兼容不是首页协议范围。 |
| `POST /canvas/common-workflow/type/list` | MAPPED_DESIGN | `listContentCategories` | {}→kindWORKFLOWS。；Category[]逐条id/label到旧类别字段；服务端真实类别列表。 |
| `POST /canvas/common-workflow/favorite/list` | MAPPED_DESIGN | `listWorkflows` | page/size→page/pageSize；搜索→q；favoritesOnly=true，必须Bearer认证；服务端先筛选收藏再分页。；new.data.items逐条转换成records；current=new.data.page，size=pageSize，total保留服务端total，pages=ceil(total/pageSize)，hasNext=hasMore。不可把total重置为已加载条数；不可通过过滤第一页伪造服务器分页。；id=id，name=localize(title)，description=localize(description)，thumbnail=coverUrl，userId=author.id，nickName=author.displayName，headPic=author.avatarUrl，favorited=favorited，workflowContent=graph。图节点格式如果与原ReactFlow不兼容必须通过显式图编译器，不能直接运行。 |
| `POST /canvas/common-workflow/favorite` | MAPPED_DESIGN | `setFavorite`, `removeFavorite` | commonWorkflowId→contentId；action经明确映射为desiredActive，true用PUT setFavorite，false用DELETE removeFavorite；禁止toggle。；Reaction.active→favorited，count仅真实返回。；限制：原action枚举未通过真实写入验证；UI必须传显式desiredActive，不猜action=1/0之外的值。 |
| `POST /canvas/admin/common-workflow/detail` | RETIRED |  | 公开首页不能访问admin命名/后台管理接口。公开详情改走getWorkflow并受公开可见性校验；旧admin响应未完整抓取。； |
| `POST /canvas/community/composition/list` | MAPPED_DESIGN | `listCompositions` | page/size→page/pageSize；sortTypeEDITOR_PICK→sortEDITOR_PICK；keyword/name/明确搜索框→q；categoryCode→category；HOT/NEW仅按明确对应值转换。；new.data.items逐条转换成records；current=new.data.page，size=pageSize，total保留服务端total，pages=ceil(total/pageSize)，hasNext=hasMore。不可把total重置为已加载条数；不可通过过滤第一页伪造服务器分页。；id保持权威字符串；name=localize(title)，description=localize(description)，thumbnail=coverUrl，compositionUrl=videoUrl，compositionDuration=durationSeconds，categoryCode=category，authorId=author.id，authorName=author.displayName，authorAvatar=author.avatarUrl；likeCount/playCount/liked/allowClone/allowPublic使用真实值。；限制：不要在按服务端分页的结果上再次全量JSON字符串搜索；不支持筛选需501。 |
| `POST /canvas/community/category/list` | MAPPED_DESIGN | `listContentCategories` | {}→kindCOMPOSITIONS。；Category.id→categoryCode注册映射，label→categoryName；返回数组。 |
| `POST /canvas/community/config` | RETIRED |  | 原community任意配置未定义；新首页读取getHome.features/galleryTabs；不要虚构旧配置形状。； |
| `POST /canvas/community/composition/detail` | MAPPED_DESIGN | `getComposition` | compositionId→contentId。；id保持权威字符串；name=localize(title)，description=localize(description)，thumbnail=coverUrl，compositionUrl=videoUrl，compositionDuration=durationSeconds，categoryCode=category，authorId=author.id，authorName=author.displayName，authorAvatar=author.avatarUrl；likeCount/playCount/liked/allowClone/allowPublic使用真实值。；返回FLAT data对象；publishedAt按展示格式→publishTime；compositionPlay以可播放videoUrl及服务端可见性决定。禁止{detail,canvasContent}嵌套，它是另一条admin helper的产物。；限制：cloneCount等未定义字段移除相关UI；不存在/受限为404/403。 |
| `POST /canvas/community/composition/recommended/list` | MAPPED_DESIGN | `listRecommendations` | 原请求只有recommendedSize（默认20），没有compositionId。适配器必须从当前detail上下文获取权威contentId，recommendedSize→pageSize，page=1；缺上下文拒绝400。；将新Page.items转换为原Composition[]数组，即success.data是数组；不能返回records/current对象。；id保持权威字符串；name=localize(title)，description=localize(description)，thumbnail=coverUrl，compositionUrl=videoUrl，compositionDuration=durationSeconds，categoryCode=category，authorId=author.id，authorName=author.displayName，authorAvatar=author.avatarUrl；likeCount/playCount/liked/allowClone/allowPublic使用真实值。；限制：推荐分页若展示更多，则按新page/hasMore在UI推进，原单次返回数组不伪造分页。 |
| `POST /canvas/community/composition/simpleDetail` | MAPPED_DESIGN | `getComposition` | compositionId→contentId。；按公共Composition投影最小详情，FLAT对象；具体旧simpleDetail字段未抓取，UI应改用新Composition结构。；限制：原simpleDetail完整输出未验证，不宣称字节级兼容。 |
| `POST /canvas/community/composition/play` | MAPPED_DESIGN | `recordCompositionPlayback` | compositionId→contentId；playDuration→playDurationSeconds；为一次播放事件生成稳定eventId并在重试复用，occurredAt为实际发生的UTC RFC3339 Z时间；合理播放时长上限86400秒。；202 accepted仅表示事件已接受；后台按24小时eventId去重、限流与时长校验，UI不得立即随意加playCount。；限制：浏览器统计不能作为计费依据；旧play没有eventId/time，必须改写处理器提供，不能每次重试生成新ID。 |
| `POST /canvas/community/composition/like` | MAPPED_DESIGN | `setLike`, `removeLike` | 旧请求compositionId没有desired状态，不能作为toggle转发。改写点赞处理器，从当前持久liked状态计算一次desiredActive并固定；true→PUT，false→DELETE；重试使用同一desired状态。；Reaction.active→liked，count→likeCount，使用服务端真实结果。；限制：缺desiredActive时拒绝400 ADAPTER_CONTEXT_REQUIRED；重试不能重新读取状态再反转。 |
| `POST /canvas/community/composition/clone` | MAPPED_DESIGN | `createProject` | compositionId→source.id，source.kindCOMPOSITION，name为用户输入或本locale明确默认名；带Idempotency-Key。；Project.id→旧canvasId/id按实际调用方约定；仅创建来源项目，不自动生成；服务端allowClone与内容权限复核。 |
| `POST /task/quick-creation/inspiration/templates` | MAPPED_DESIGN | `listTemplates` | page/size→page/pageSize，keyword→q；tagId使用权威标签字符串ID→tagId，category独立映射，不混用；标签筛选必须在服务端分页前执行。；new.data.items逐条转换成records；current=new.data.page，size=pageSize，total保留服务端total，pages=ceil(total/pageSize)，hasNext=hasMore。不可把total重置为已加载条数；不可通过过滤第一页伪造服务器分页。；templateId=id（不能用旧row.id）；nameCn=title[zh-CN]，nameAi=title.en，description/descriptionAi按语言，coverUrl=coverUrl，videoUrl=previewVideoUrl，categoryId=category。；限制：标签目录获取仍DEFERRED；未知tagId返回可处理错误，不能自动当category。 |
| `POST /task/quick-creation/inspiration/tags` | DEFERRED |  | 原tags返回tagId/nameCn/nameAi/sortOrder，而新content/categories是类别，不是标签；模板标签目录/过滤未定义。； |
| `POST /task/quick-creation/inspiration/template/detail` | MAPPED_DESIGN | `getTemplate` | templateId→contentId，按权威字符串ID查找。；templateId=id（不能用旧row.id）；nameCn=title[zh-CN]，nameAi=title.en，description/descriptionAi按语言，coverUrl=coverUrl，videoUrl=previewVideoUrl，categoryId=category。；snapshot从受校验的defaultInput做显式映射：presetParams/apiRequestParamsRaw仅取支持的参数；新modelId映射成旧bindingId需要权威关联。；限制：不得沿用原mock row.id错误；不能把任意defaultInput变成可执行原API请求；没有binding映射时详情展示可用而生成入口501。 |
| `POST /api/message/user/unreadCount` | MAPPED_DESIGN | `getUnreadCounts` | {}→查询当前会话。；officialMessageCount=officialMessages；其余count仅按新可展示类型对应；返回整数。 |
| `POST /canvas/notice/page` | MAPPED_DESIGN | `listNotifications` | current→page（不是page字段）；size→pageSize；noticeTypeUPDATE_RECORD→typeUPDATE_RECORD。；new.data.items逐条转换成records；current=new.data.page，size=pageSize，total保留服务端total，pages=ceil(total/pageSize)，hasNext=hasMore。不可把total重置为已加载条数；不可通过过滤第一页伪造服务器分页。；Notification.id→noticeId；title/body按locale→title/content；read→hasRead；createdAt按展示格式。；限制：原notice额外富文本字段未定义；渲染新文本应避免任意HTML。 |
| `POST /canvas/notice/read` | MAPPED_DESIGN | `markNotificationsRead` | noticeId→ids:[id]；使用Idempotency-Key。；新UnreadCounts返回真实已读后的计数；旧显示通过id更新hasRead，并按计数更新角标。 |
| `POST /api/message/list/v2` | MAPPED_DESIGN | `listNotifications` | current→page，size→pageSize；tabTypeTAB_OFFICIAL_MESSAGE→typeOFFICIAL_MESSAGE。；new.data.items逐条转换成records；current=new.data.page，size=pageSize，total保留服务端total，pages=ceil(total/pageSize)，hasNext=hasMore。不可把total重置为已加载条数；不可通过过滤第一页伪造服务器分页。；id→id，type→messageType（业务通知只映射已定义的类型），title/body→title/content语言文本，read→hasRead。 |
| `POST /api/message/updateReadStatus` | MAPPED_DESIGN | `markNotificationsRead` | msgId:string[]→ids:string[]；100个内批次，按同次操作稳定Idempotency-Key，非法ID拒绝。；UnreadCounts→官方消息角标计数；已读状态使用服务端结果，失败不永久更新。 |
| `POST /api/product/v2/list` | MAPPED_DESIGN | `listCatalogProducts` | productType 1→CREDITS、2→MEMBERSHIP、3→WALLET、4→TEAM_MEMBERSHIP；locale/currency按当前有效上下文；旧接口要求数组，若需要完整目录显式逐页获取并去重，不默默截到第一页。；CatalogProduct.id/code/name→id/productCode/productName；price.amount/currency保留十进制字符串；billingPeriod→旧serviceUnit；benefits映射展示；响应data为Product[]。；限制：不再发送thirdProductId、原Stripe price等提供商私有映射；rightConfigList/packageList无完全等价，会员UI改用新benefits和billingPeriod，不伪造完整原套餐。 |
| `POST /canvas/price/calculate` | MAPPED_DESIGN | `quoteGeneration` | 原skuId仅通过权威SkuAlias→modelId注册表解析；priceFactors[].fieldKey/fieldValue→params并按parameterSchema验证；从当前launch上下文补齐projectId/mode/prompt/READY附件assetId/outputCount/executionPolicy/capabilityVersion/invocationType；directSubType→invocationType且须属于所选Model.invocationTypes。直接模式缺任一必填字段时400，报价绑定invocationType及完整输入。；首页报价是新GenerationInput整单价，原单份报价乘generateNum逻辑须移除；单价显示如需要必须引用新报价lineItems，不再自行推导扣费。；新GenerationQuote.id/inputHash/pricingVersion/expiresAt保留在适配上下文；maximumCost.amount/currency可显示为totalPrice/currency，但此处是整单最大金额，不是原单份价。；旧freeLimit/freeLimitCount/tokenUnitPrice/discountTotalPrice并非新Quote必有字段；不得从最大金额0推导无限免费额度或伪造折扣。UI改用maximumCost和lineItems。；限制：仅完整首页GenerationInput可映射；旧编辑器priceFactors-only调用缺上下文不能直接适配。 |
| `POST /api/area/price/calculate` | RETIRED |  | 旧免费额度下再查付费单价的旁路从新报价流程移除；不得绕过优惠/计费快照用另一报价覆盖。； |
| `POST /api/area/price/factor/detail` | RETIRED |  | 新parameterSchema/defaultParams是参数来源；计费因素查询不再独立暴露。； |
| `POST /canvas/price/estimate` | DEFERRED |  | 该请求含targetType/targetId/canvas图，是原编辑器GROUP/NODE执行估价；不属于首页GenerationInput。需独立编辑器图执行与价格协议，当前501。； |
| `POST /canvas/price/llm-sku-price` | RETIRED |  | 新报价绑定完整已验证输入；不复刻原SKU裸费率表，显示需求应扩展公开报价目录字段。； |
| `POST /api/storage/getCredentials` | MAPPED_DESIGN | `createAssetUpload`, `renewAssetUpload`, `completeAssetUpload` | 不返回旧credentials对象；重写ri/cg上传实现。以projectId/fileName/mimeType/byteSize/checksumSha256申请预签名PUT；执行PUT给新UploadSession.url，并按headers；完成后POST uploadId/complete {etag}。；有效期不足仅renewAssetUpload；服务端核验大小、SHA256、MIME/元数据，Asset只有READY才允许生成。；上传组件获得权威assetId与READY状态，展示用本服务授权asset URL；旧cg若暂保留URL返回签名预览URL，同时维护URL→assetId上下文；生成只发送assetId。禁止把blob:作为持久资源。；限制：原场景只有scene而缺文件信息，无法透明HTTP形状转换；必须改上传调用点；不返回云永久密钥，也不复用原站STS。 |
| `POST /canvas/task/run` | DEFERRED |  | 原targetType NODE/GROUP/CANVAS + targetId + canvas节点图 + Yjs generation上下文是编辑器执行协议。不能将graph猜成首页GenerationInput。当前HTTP501，待明确编辑器节点、依赖、运行状态、Yjs版本/权限及graph报价扩展。； |
| `POST /canvas/task/batchStatus` | DEFERRED |  | taskIds是旧编辑器任务，不是新generationId；未建立权威任务/运行映射且TaskStatus形状未抓取。当前501；首页改用getGeneration/listGenerations/SSE。； |
| `POST /canvas/task/cancel` | DEFERRED |  | 旧taskId所属编辑器协议未定义。不能将taskId强转generationId；当前501。首页取消直接使用cancelGeneration。； |
| `POST /canvas/logs/reportEvent` | MAPPED_DESIGN | `recordTelemetry` | 旧eventName不允许任意透传；显式事件字典映射到home.opened/gallery.changed/composer.mode.changed/creation.started，未知事件停用或返回410。；eventBody投影为properties最多20项，仅JSON原始值；生成稳定eventId并在重试复用，occurredAt=实际UTC Z时间；不得上传密钥、原用户个人信息或完整prompt。；仅服务端accepted确认可回旧成功；日志上报失败按非阻断策略，但不得影响主功能成功/失败判断。 |
| `POST /pay/order/create` | MAPPED_DESIGN | `listCatalogProducts`, `createOrder` | 普通商品productId通过权威目录映射，读取当前catalogVersion→{kind:PRODUCT,productId,catalogVersion,quantity:1}；丢弃client price/thirdProductId/exclusiveParams。；自定义旧money是整数分字符串；以十进制精确算术除100→{kind:CUSTOM_TOP_UP,amount:{amount:十进制金额字符串,currency}}；币种/精度/上限由服务端校验；订单创建带Idempotency-Key。；Order.id→orderNo；保留order.state/total/expiresAt；不伪造prePayId，支付方式只在checkout选择。；限制：旧teamMembershipOrderInfo/packageRightsId/升级套餐规则尚无新字段，遇到需返回501而非忽略后收费。 |
| `POST /pay/order/pay` | MAPPED_DESIGN | `createCheckout` | orderNo→orderId，payChannel经提供商白名单映射→provider；returnUrl必须来自本站允许列表；丢弃thirdProductId/prePayId/clientType作为价格/身份来源；带幂等键。；checkoutUrl→payUrl；expiresAt→max(0,floor((expiresAt-serverNow)/1000))作为expireSeconds；orderMoney从权威Order.total取，不采信浏览器金额。；限制：旧ANTOM paymentMethodType / WeChat JSbridge未在新Checkout中声明，需要扩展或停用；不能自动当成新provider。 |
| `POST /pay/order/query` | MAPPED_DESIGN | `getOrder` | orderNo→orderId，读取当前会话可见订单。；将Order.state明确映射UI付款/待付/失败/退款状态；PAID仅来自服务端webhook核验后的状态。；限制：旧支付status数值枚举未抓取，须改写状态机消费新enum；回跳s=s不能标记已付款。 |
| `POST /api/system/getConfig` | RETIRED |  | 旧h5payEnable控制原渠道SDK；新checkout流程返回受控checkoutUrl，不复刻旧全局支付SDK配置。； |
| `POST /api/product/display/cancelSubButton` | MAPPED_DESIGN | `getMembership` | {}→查询当前个人范围，若明确团队则合法X-Team-Id。；data.canCancelSubscription→旧boolean或{displayCancelSub:boolean}；值由服务端确定。；限制：这里只映射入口可见性；真正取消订阅调用/续费变更协议尚未定义，不声称已实现。 |
| `GET /uc/team/membership/products` | MAPPED_DESIGN | `listCatalogProducts` | 旧GET teamId必须是已授权团队；kindTEAM_MEMBERSHIP查询通用公开目录；当前团队有效计划读取getMembership。；目录items转换成旧数组；精确团队报价/续费/升级产品筛选新目录未声明，需额外协议。；限制：如果旧页面要求团队专属价而非通用目录，返回501，不能展示未授权套餐购买。 |
| `GET /uc/team/membership/plan` | MAPPED_DESIGN | `getMembership` | 旧GET teamId→已授权X-Team-Id或新操作声明的team范围；会话校验团队成员。；MembershipStatus.activePlan→旧plan；activePlan=null→无当前有效会员，canCancelSubscription只作入口可见性；teamId须与已授权请求范围一致。；限制：不虚构旧plan的专属价格/成员数/升级字段；按新Membership结构改会员UI。 |
| `POST /canvas/asset/type/list` | DEFERRED |  | 旧COMMON/USER资产类型是内容/资产库taxonomy；新listAssets.kind是媒体MIME类别IMAGE/VIDEO/AUDIO，不能把两者直接等同。； |
| `POST /canvas/asset/user/group/list` | DEFERRED |  | 旧个人/团队资产文件组/folder结构与新平面AssetPage不同；新契约无groupId或目录语义。当前501；平面资产列表可直接改用listAssets。； |

## 原路径之外的新流程

- **Google OAuth替换原Firebase认证**：`startGoogleAuthorization`, `exchangeGoogleCode`。前端生成codeVerifier并以S256生成codeChallenge；startGoogleAuthorization({redirectUri,codeChallenge,codeChallengeMethod:S256})返回服务端一次state/授权URL，并绑定HttpOnly事务cookie，10分钟过期。；回跳后exchangeGoogleCode({code,codeVerifier,redirectUri,state})，不能使用原Firebase idToken；服务端验证state与redirectUri白名单。
- **项目分享撤销（原70路径无对应入口）**：`revokeProjectShareLink`。projectId/shareId来自权威ProjectShare，DELETE撤销，带Idempotency-Key与授权X-Team-Id；后续getProjectShare读取与clone须404。

## 尚待扩展

- 原图编辑器、图估价与Yjs/task协议，project folderId与完整资产文件组。
- 模板标签目录（tagId筛选已定义）、原highlight结构、原专属会员升级/续费规则与真正取消订阅操作。
- 原Firebase/MD5登录与支付SDK分支须换为新认证/checkout；不提供透明凭证转换。

缺功能必须可见失败；不得用空数组、零价格或成功对象掩盖。

## 校验

已通过：70/70旧method/path完整且唯一，61个引用operationId均存在于当前71个OpenAPI操作；原审计副本逐字节一致。所有映射implemented=false，适配器尚未实现。
