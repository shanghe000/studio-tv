# Studio TV 表关系模型

上一版按完整功能范围展开为 **57张新增表**，包含版本、关联、引用、历史、任务和消息基础设施；不是57个业务聚合，也不是DDD要求的最小表数。现有10张表另计（其中ipac_workspaces为已停用历史表）。

第1轮实际004只新增GLOBAL/CANVAS会话与消息两表；Router另有独立库。本页及DBML继续作为全量蓝图，当前实施范围见[会话接口](assistant-api.md)，后续迁移需与蓝图逐项合并。

| 模块 | 新增表数 | 内容 |
|---|---:|---|
| catalog | 21 | 角色/模型目录、筛选、收藏、Workflow/Prompt/Skill/App/Voice版本 |
| execution | 8 | 任务、节点计划、依赖、尝试、输出、历史、事件 |
| studio | 8 | HF文件工程/快照/渲染/事件与独立导演 |
| media | 5 | 物理文件、3D bundle、多文件及附件上传 |
| library | 5 | 个人库、目录、封面、条目与引用 |
| assistant | 5 | 会话、消息、Agent运行、工具回执、流事件 |
| canvas | 3 | 标签集合、标签、图谱媒体引用 |
| platform | 2 | outbox/inbox |
| **合计** | **57** | **完整蓝图，不是首期迁移** |

例如一个“角色库”拆成7张表，是角色、三视图、属性选项、收藏、筛选字典和文件引用的关系；一个“生成”拆成8张表，是任务与每个节点计划、重试、输出、历史和事件的不同生命周期。

## 建议的首个上线切片：16张新增

先只接通角色库分页/筛选/收藏、个人素材库目录与封面、标签和精确媒体引用。保留现有登录、作品、快照、上传；其余41张新表延期。此处是从完整蓝图选出的MVP建议，尚未修改既有SQL/API或部署；原P1的其他目录能力排到后续切片。

| 模块 | 新表 |
|---|---|
| media：1 | blobs |
| catalog：7 | media、categories、filter_options、characters、character_attributes、character_images、character_favorites |
| canvas：3 | tag_sets、tags、media_refs |
| library：5 | collections、folders、folder_media_refs、items、item_media_refs |

首期应暂不加canvas.media_refs、library.items和library.item_media_refs的model_asset_id及MODEL_3D分支，避免依赖延期的media.model_assets。P3再补列、FK、CHECK；完整57表SQL不能按表名直接剪成首期迁移。画布节点/边仍存projects.graph JSONB，无逐节点表；IPAC只提供登录与tv.access，不新增业务RBAC或空间。

## 建模源文件与读图

- [完整DBML模型](design/database.dbml)：57新增+10现有，所有字段、PK、唯一键和真实FK；按schema分组，可在支持DBML的工具导入。
- [SQL蓝图](design/database.sql)：PostgreSQL约束的权威源；[表字典](database-design.md)解释业务含义。
- 下方Mermaid按模块展开。PK/FK字段为实际物理键；其他模块的锚点可重复出现，不重复计为新增表。为便于阅读，模块图省略重复的User所有权连线，完整DBML保留所有复合owner FK。
- 圆圈表示可选，竖线表示一个，三叉表示多；实线为标识关系，虚线为非标识关系。字段只展示键及少量业务列，全字段在DBML。NULL参与复合FK时按PostgreSQL MATCH SIMPLE/FULL规则处理，业务XOR/READY等仍见SQL/用例。
- DBML保留触发器/生成列/条件索引的说明，但不能用其导出SQL替代原蓝图；资源active_version指向不同typed版本表由延迟constraint trigger验证，图中不伪造6个同时成立的FK。

语法依据：[DBML官方](https://dbml.dbdiagram.io/docs/)、[Mermaid ER官方](https://mermaid.js.org/syntax/entityRelationshipDiagram.html)。模型由隔离PG17加载001/002/003+蓝图后反查元数据生成，未连接生产库。

## 现有基础表：10张（含1张已停用历史表）

```mermaid
erDiagram
  direction LR
  media_blobs["media.blobs"] {
    text id PK
    text owner_id FK
  }
  public_asset_uploads["public.asset_uploads"] {
    text id PK
    text asset_id FK
    text owner_id FK
    text grant_id
    timestamptz expires_at
  }
  public_assets["public.assets"] {
    text id PK
    text owner_id FK
    text project_id FK
    text blob_id FK
    text file_name
  }
  public_federated_identities["public.federated_identities"] {
    text issuer PK
    text subject_id PK
    text user_id FK
    text provider
  }
  public_idempotency_keys["public.idempotency_keys"] {
    text owner_id PK, FK
    text operation PK
    uuid key PK
    text request_hash
    integer response_status
  }
  public_ipac_workspaces["public.ipac_workspaces"] {
    text id PK
    text application_id
    text ipac_project_id
    text ipac_environment_id
    text project_code
  }
  public_oidc_login_transactions["public.oidc_login_transactions"] {
    text token_hash PK
    jsonb transaction
    timestamptz expires_at
  }
  public_projects["public.projects"] {
    text id PK
    text owner_id FK
    text workspace_id FK
    text name
    text cover_asset_id
  }
  public_refresh_tokens["public.refresh_tokens"] {
    text token_hash PK
    text session_id FK
    timestamptz expires_at
    timestamptz consumed_at
  }
  public_sessions["public.sessions"] {
    text id PK
    text user_id FK
    timestamptz expires_at
    timestamptz revoked_at
    text ipac_issuer
  }
  public_users["public.users"] {
    text id PK
    text email
    text password_hash
    text display_name
    text locale
  }
  public_assets ||..o| public_asset_uploads : "asset_id"
  public_users ||..o{ public_asset_uploads : "owner_id"
  public_assets ||..o| public_asset_uploads : "asset_id,owner_id"
  public_users ||..o{ public_assets : "owner_id"
  public_projects ||..o{ public_assets : "project_id"
  media_blobs |o..o{ public_assets : "blob_id,owner_id"
  public_projects ||..o{ public_assets : "project_id,owner_id"
  public_users ||..o{ public_federated_identities : "user_id"
  public_users ||--o{ public_idempotency_keys : "owner_id"
  public_users ||..o{ public_projects : "owner_id"
  public_ipac_workspaces |o..o{ public_projects : "workspace_id"
  public_sessions ||..o{ public_refresh_tokens : "session_id"
  public_users ||..o{ public_sessions : "user_id"
```

## 文件与上传：5张新增

```mermaid
erDiagram
  direction LR
  catalog_resources["catalog.resources"] {
    text id PK
    text owner_id FK
    text owner_key FK
    text cover_media_id FK
    text cover_asset_id FK
    text category_id FK
  }
  media_blob_uploads["media.blob_uploads"] {
    text id PK
    text owner_id FK
    text resource_id FK
    text resource_owner_key FK
    text resource_kind FK
    text hf_project_id FK
    text blob_id FK
  }
  media_blobs["media.blobs"] {
    text id PK
    text owner_id FK
    text owner_key
    text scope
    text backend
  }
  media_model_assets["media.model_assets"] {
    text id PK
    text owner_id FK
    text project_id FK
    text preview_asset_id FK
    text name
  }
  media_model_files["media.model_files"] {
    text model_asset_id PK, FK
    text owner_id FK
    text path PK
    text blob_id FK
    text mime_type
  }
  media_model_uploads["media.model_uploads"] {
    text id PK
    text model_asset_id FK
    text owner_id FK
    uuid grant_id
    timestamptz expires_at
  }
  public_assets["public.assets"] {
    text id PK
    text owner_id FK
    text project_id FK
    text blob_id FK
  }
  public_projects["public.projects"] {
    text id PK
    text owner_id FK
    text workspace_id FK
  }
  studio_hf_projects["studio.hf_projects"] {
    text id PK
    text owner_id FK
  }
  media_blobs ||..o{ media_blob_uploads : "blob_id,owner_id"
  studio_hf_projects |o..o{ media_blob_uploads : "hf_project_id,owner_id"
  catalog_resources |o..o{ media_blob_uploads : "resource_id,resource_owner_key,resource_kind"
  public_assets |o..o{ media_model_assets : "preview_asset_id,owner_id"
  public_projects |o..o{ media_model_assets : "project_id,owner_id"
  media_blobs |o..o{ media_model_files : "blob_id,owner_id"
  media_model_assets ||..o{ media_model_files : "model_asset_id,owner_id"
  media_model_assets ||..o| media_model_uploads : "model_asset_id,owner_id"
```

## 画布标签与引用：3张新增

```mermaid
erDiagram
  direction LR
  canvas_media_refs["canvas.media_refs"] {
    text id PK
    text project_id FK
    text owner_id FK
    text asset_id FK
    text model_asset_id FK
  }
  canvas_tag_sets["canvas.tag_sets"] {
    text owner_id PK, FK
    bigint revision
  }
  canvas_tags["canvas.tags"] {
    text id PK
    text owner_id FK
    text name
    text color
    integer sort_order
  }
  media_model_assets["media.model_assets"] {
    text id PK
    text owner_id FK
    text project_id FK
    text preview_asset_id FK
  }
  public_assets["public.assets"] {
    text id PK
    text owner_id FK
    text project_id FK
    text blob_id FK
  }
  public_projects["public.projects"] {
    text id PK
    text owner_id FK
    text workspace_id FK
  }
  public_assets |o..o{ canvas_media_refs : "asset_id,owner_id"
  media_model_assets |o..o{ canvas_media_refs : "model_asset_id,owner_id"
  public_projects ||..o{ canvas_media_refs : "project_id,owner_id"
  canvas_tag_sets ||..o{ canvas_tags : "owner_id"
```

## 角色目录：7张新增

```mermaid
erDiagram
  direction LR
  catalog_categories["catalog.categories"] {
    text id PK
    text namespace FK
    text parent_id FK
    text node_role
    text code
  }
  catalog_character_attributes["catalog.character_attributes"] {
    text character_id PK, FK
    text character_owner_key FK
    text category_id PK, FK
    text option_code PK, FK
  }
  catalog_character_favorites["catalog.character_favorites"] {
    text owner_id PK, FK
    text character_id PK, FK
    text character_owner_key FK
  }
  catalog_character_images["catalog.character_images"] {
    text id PK
    text character_id FK
    text character_owner_key FK
    text catalog_media_id FK
    text asset_id FK
  }
  catalog_characters["catalog.characters"] {
    text id PK
    text owner_id FK
    text owner_key
    text scope
    jsonb name_localized
  }
  catalog_filter_options["catalog.filter_options"] {
    text category_id PK, FK
    text category_namespace FK
    text category_node_role FK
    text code PK
    jsonb name_localized
  }
  catalog_media["catalog.media"] {
    text id PK
    text blob_id FK
    text blob_owner_key FK
    text kind
    text title
  }
  media_blobs["media.blobs"] {
    text id PK
    text owner_id FK
  }
  public_assets["public.assets"] {
    text id PK
    text owner_id FK
    text project_id FK
    text blob_id FK
  }
  catalog_categories |o..o{ catalog_categories : "parent_id,namespace"
  catalog_filter_options ||--o{ catalog_character_attributes : "category_id,option_code"
  catalog_characters ||..o{ catalog_character_attributes : "character_id,character_owner_key"
  catalog_characters ||..o{ catalog_character_favorites : "character_id,character_owner_key"
  public_assets |o..o{ catalog_character_images : "asset_id,character_owner_key"
  catalog_media |o..o{ catalog_character_images : "catalog_media_id"
  catalog_characters ||..o{ catalog_character_images : "character_id,character_owner_key"
  catalog_categories ||..o{ catalog_filter_options : "category_id,category_namespace,category_node_role"
  media_blobs ||..o{ catalog_media : "blob_id,blob_owner_key"
```

## 模型能力：5张新增

```mermaid
erDiagram
  direction LR
  catalog_media["catalog.media"] {
    text id PK
    text blob_id FK
    text blob_owner_key FK
  }
  catalog_model_capabilities["catalog.model_capabilities"] {
    text id PK, FK
    text model_id FK
    text active_version FK
    text node_type
    boolean available
  }
  catalog_model_group_members["catalog.model_group_members"] {
    text group_id PK, FK
    text capability_id PK, FK
    integer sort_order
  }
  catalog_model_groups["catalog.model_groups"] {
    text id PK
    text parent_id FK
    text icon_media_id FK
    text code
    jsonb name_localized
  }
  catalog_model_versions["catalog.model_versions"] {
    text capability_id PK, FK
    text version PK
    jsonb parameter_schema
    jsonb ui_config
    jsonb default_params
  }
  catalog_models["catalog.models"] {
    text id PK
    text icon_media_id FK
    text code
    jsonb name_localized
    jsonb description_localized
  }
  catalog_model_versions ||..o| catalog_model_capabilities : "id,active_version"
  catalog_models ||..o{ catalog_model_capabilities : "model_id"
  catalog_model_capabilities ||--o{ catalog_model_group_members : "capability_id"
  catalog_model_groups ||--o{ catalog_model_group_members : "group_id"
  catalog_media |o..o{ catalog_model_groups : "icon_media_id"
  catalog_model_groups |o..o{ catalog_model_groups : "parent_id"
  catalog_model_capabilities ||--o{ catalog_model_versions : "capability_id"
  catalog_media |o..o{ catalog_models : "icon_media_id"
```

## 版本化内容目录：9张新增

```mermaid
erDiagram
  direction LR
  catalog_app_versions["catalog.app_versions"] {
    text resource_id PK, FK
    text owner_key FK
    text resource_kind FK
    text version PK
    text workflow_id FK
    text workflow_version FK
    text workflow_owner_key FK
  }
  catalog_categories["catalog.categories"] {
    text id PK
    text namespace FK
    text parent_id FK
  }
  catalog_media["catalog.media"] {
    text id PK
    text blob_id FK
    text blob_owner_key FK
  }
  catalog_model_capabilities["catalog.model_capabilities"] {
    text id PK, FK
    text model_id FK
    text active_version FK
  }
  catalog_prompt_versions["catalog.prompt_versions"] {
    text resource_id PK, FK
    text owner_key FK
    text resource_kind FK
    text version PK
    text reference_media_id FK
    text reference_asset_id FK
  }
  catalog_resource_category_links["catalog.resource_category_links"] {
    text resource_id PK, FK
    text category_id PK, FK
  }
  catalog_resource_user_states["catalog.resource_user_states"] {
    text owner_id PK, FK
    text resource_id PK, FK
    text resource_owner_key FK
    boolean favorited
    timestamptz favorited_at
  }
  catalog_resources["catalog.resources"] {
    text id PK
    text owner_id FK
    text owner_key FK
    text cover_media_id FK
    text cover_asset_id FK
    text category_id FK
  }
  catalog_skill_files["catalog.skill_files"] {
    text skill_id PK, FK
    text skill_version PK, FK
    text owner_key FK
    text path PK
    text blob_id FK
    text upload_id FK
  }
  catalog_skill_versions["catalog.skill_versions"] {
    text resource_id PK, FK
    text owner_key FK
    text resource_kind FK
    text version PK
    text scenario
  }
  catalog_voice_versions["catalog.voice_versions"] {
    text resource_id PK, FK
    text owner_key FK
    text resource_kind FK
    text version PK
    text capability_id FK
    text preview_media_id FK
  }
  catalog_workflow_versions["catalog.workflow_versions"] {
    text resource_id PK, FK
    text owner_key FK
    text resource_kind FK
    text version PK
    jsonb graph
  }
  media_blob_uploads["media.blob_uploads"] {
    text id PK
    text owner_id FK
    text resource_id FK
    text resource_owner_key FK
    text resource_kind FK
    text hf_project_id FK
    text blob_id FK
  }
  media_blobs["media.blobs"] {
    text id PK
    text owner_id FK
  }
  public_assets["public.assets"] {
    text id PK
    text owner_id FK
    text project_id FK
    text blob_id FK
  }
  catalog_resources ||..o{ catalog_app_versions : "resource_id,owner_key,resource_kind"
  catalog_workflow_versions ||..o{ catalog_app_versions : "workflow_id,workflow_version,workflow_owner_key"
  public_assets |o..o{ catalog_prompt_versions : "reference_asset_id,owner_key"
  catalog_media |o..o{ catalog_prompt_versions : "reference_media_id"
  catalog_resources ||..o{ catalog_prompt_versions : "resource_id,owner_key,resource_kind"
  catalog_categories ||--o{ catalog_resource_category_links : "category_id"
  catalog_resources ||--o{ catalog_resource_category_links : "resource_id"
  catalog_resources ||..o{ catalog_resource_user_states : "resource_id,resource_owner_key"
  catalog_categories |o..o{ catalog_resources : "category_id"
  public_assets |o..o{ catalog_resources : "cover_asset_id,owner_key"
  catalog_media |o..o{ catalog_resources : "cover_media_id"
  media_blobs ||..o{ catalog_skill_files : "blob_id,owner_key"
  catalog_skill_versions ||..o{ catalog_skill_files : "skill_id,skill_version,owner_key"
  media_blob_uploads |o..o{ catalog_skill_files : "upload_id,owner_key,blob_id"
  catalog_resources ||..o{ catalog_skill_versions : "resource_id,owner_key,resource_kind"
  catalog_model_capabilities |o..o{ catalog_voice_versions : "capability_id"
  catalog_media |o..o{ catalog_voice_versions : "preview_media_id"
  catalog_resources ||..o{ catalog_voice_versions : "resource_id,owner_key,resource_kind"
  catalog_resources ||..o{ catalog_workflow_versions : "resource_id,owner_key,resource_kind"
```

## 个人素材库：5张新增

```mermaid
erDiagram
  direction LR
  library_collections["library.collections"] {
    text owner_id PK, FK
    bigint revision
  }
  library_folder_media_refs["library.folder_media_refs"] {
    text folder_id PK, FK
    text owner_id FK
    text asset_id FK
    smallint sort_order PK
  }
  library_folders["library.folders"] {
    text id PK
    text owner_id FK
    text parent_id FK
    text category_code
    text kind
  }
  library_item_media_refs["library.item_media_refs"] {
    text id PK
    text item_id FK
    text owner_id FK
    text asset_id FK
    text model_asset_id FK
  }
  library_items["library.items"] {
    text id PK
    text owner_id FK
    text folder_id FK
    text asset_id FK
    text model_asset_id FK
  }
  media_model_assets["media.model_assets"] {
    text id PK
    text owner_id FK
    text project_id FK
    text preview_asset_id FK
  }
  public_assets["public.assets"] {
    text id PK
    text owner_id FK
    text project_id FK
    text blob_id FK
  }
  public_assets ||..o{ library_folder_media_refs : "asset_id,owner_id"
  library_folders ||..o{ library_folder_media_refs : "folder_id,owner_id"
  library_collections ||..o{ library_folders : "owner_id"
  library_folders |o..o{ library_folders : "parent_id,owner_id"
  public_assets |o..o{ library_item_media_refs : "asset_id,owner_id"
  library_items ||..o{ library_item_media_refs : "item_id,owner_id"
  media_model_assets |o..o{ library_item_media_refs : "model_asset_id,owner_id"
  public_assets |o..o{ library_items : "asset_id,owner_id"
  library_folders |o..o{ library_items : "folder_id,owner_id"
  media_model_assets |o..o{ library_items : "model_asset_id,owner_id"
  library_collections ||..o{ library_items : "owner_id"
```

## 生成与历史：8张新增

```mermaid
erDiagram
  direction LR
  catalog_app_versions["catalog.app_versions"] {
    text resource_id PK, FK
    text owner_key FK
    text resource_kind FK
    text version PK
    text workflow_id FK
    text workflow_version FK
    text workflow_owner_key FK
  }
  catalog_model_versions["catalog.model_versions"] {
    text capability_id PK, FK
    text version PK
  }
  execution_attempts["execution.attempts"] {
    text id PK
    text plan_id FK
    text task_id FK
    text owner_id FK
    integer attempt_no
  }
  execution_dependencies["execution.dependencies"] {
    text task_id FK
    text owner_id FK
    text plan_id PK, FK
    text depends_on_plan_id PK, FK
  }
  execution_events["execution.events"] {
    text task_id PK, FK
    text owner_id FK
    bigint sequence PK
    text event_type
    integer schema_version
  }
  execution_history_entries["execution.history_entries"] {
    text id PK
    text head_id FK
    text owner_id FK
    text project_id FK
    text output_id FK
    text plan_id FK
  }
  execution_history_heads["execution.history_heads"] {
    text id PK
    text owner_id FK
    text project_id FK
    text node_id
    bigint revision
  }
  execution_outputs["execution.outputs"] {
    text id PK
    text task_id FK
    text plan_id FK
    text attempt_id FK
    text owner_id FK
    text project_id FK
    text asset_id FK
    text model_asset_id FK
    text blob_id FK
  }
  execution_plans["execution.plans"] {
    text id PK
    text task_id FK
    text owner_id FK
    text project_id FK
    text capability_id FK
    text capability_version FK
  }
  execution_tasks["execution.tasks"] {
    text id PK
    text owner_id FK
    text project_id FK
    text source_app_id FK
    text source_app_version FK
    text source_app_owner_key FK
  }
  media_blobs["media.blobs"] {
    text id PK
    text owner_id FK
  }
  media_model_assets["media.model_assets"] {
    text id PK
    text owner_id FK
    text project_id FK
    text preview_asset_id FK
  }
  public_assets["public.assets"] {
    text id PK
    text owner_id FK
    text project_id FK
    text blob_id FK
  }
  public_projects["public.projects"] {
    text id PK
    text owner_id FK
    text workspace_id FK
  }
  execution_plans ||..o{ execution_attempts : "plan_id,task_id,owner_id"
  execution_plans ||..o{ execution_dependencies : "depends_on_plan_id,task_id,owner_id"
  execution_plans ||..o{ execution_dependencies : "plan_id,task_id,owner_id"
  execution_tasks ||..o{ execution_events : "task_id,owner_id"
  execution_history_heads ||..o{ execution_history_entries : "head_id,owner_id,project_id"
  execution_outputs ||..o{ execution_history_entries : "output_id,owner_id,project_id,plan_id"
  public_projects ||..o{ execution_history_heads : "project_id,owner_id"
  public_assets |o..o{ execution_outputs : "asset_id,owner_id"
  execution_attempts |o..o{ execution_outputs : "attempt_id,plan_id,task_id,owner_id"
  media_blobs |o..o{ execution_outputs : "blob_id,owner_id"
  media_model_assets |o..o{ execution_outputs : "model_asset_id,owner_id"
  execution_plans ||..o{ execution_outputs : "plan_id,task_id,owner_id,project_id"
  catalog_model_versions |o..o{ execution_plans : "capability_id,capability_version"
  execution_tasks ||..o{ execution_plans : "task_id,owner_id,project_id"
  public_projects ||..o{ execution_tasks : "project_id,owner_id"
  catalog_app_versions |o..o{ execution_tasks : "source_app_id,source_app_version,source_app_owner_key"
```

## Agent：5张新增

```mermaid
erDiagram
  direction LR
  assistant_conversations["assistant.conversations"] {
    text id PK
    text owner_id FK
    text canvas_project_id FK
    text hf_project_id FK
    text business
  }
  assistant_events["assistant.events"] {
    text run_id PK, FK
    text conversation_id FK
    text owner_id FK
    bigint sequence PK
    text event_type
  }
  assistant_messages["assistant.messages"] {
    text id PK
    text conversation_id FK
    text owner_id FK
    text run_id FK
    bigint sequence
  }
  assistant_runs["assistant.runs"] {
    text id PK
    text conversation_id FK
    text owner_id FK
    text input_message_id FK
    text capability_id FK
    text capability_version FK
  }
  assistant_tool_calls["assistant.tool_calls"] {
    text id PK
    text run_id FK
    text conversation_id FK
    text owner_id FK
    text call_id
  }
  catalog_model_versions["catalog.model_versions"] {
    text capability_id PK, FK
    text version PK
  }
  public_projects["public.projects"] {
    text id PK
    text owner_id FK
    text workspace_id FK
  }
  studio_hf_projects["studio.hf_projects"] {
    text id PK
    text owner_id FK
  }
  public_projects |o..o{ assistant_conversations : "canvas_project_id,owner_id"
  studio_hf_projects |o..o{ assistant_conversations : "hf_project_id,owner_id"
  assistant_runs ||..o{ assistant_events : "run_id,conversation_id,owner_id"
  assistant_conversations ||..o{ assistant_messages : "conversation_id,owner_id"
  assistant_runs |o..o{ assistant_messages : "run_id,conversation_id,owner_id"
  catalog_model_versions ||..o{ assistant_runs : "capability_id,capability_version"
  assistant_conversations ||..o{ assistant_runs : "conversation_id,owner_id"
  assistant_messages ||..o{ assistant_runs : "input_message_id,conversation_id,owner_id"
  assistant_runs ||..o{ assistant_tool_calls : "run_id,conversation_id,owner_id"
```

## HF与独立导演：8张新增

```mermaid
erDiagram
  direction LR
  catalog_categories["catalog.categories"] {
    text id PK
    text namespace FK
    text parent_id FK
  }
  catalog_media["catalog.media"] {
    text id PK
    text blob_id FK
    text blob_owner_key FK
  }
  media_blob_uploads["media.blob_uploads"] {
    text id PK
    text owner_id FK
    text resource_id FK
    text resource_owner_key FK
    text resource_kind FK
    text hf_project_id FK
    text blob_id FK
  }
  media_blobs["media.blobs"] {
    text id PK
    text owner_id FK
  }
  media_model_assets["media.model_assets"] {
    text id PK
    text owner_id FK
    text project_id FK
    text preview_asset_id FK
  }
  public_assets["public.assets"] {
    text id PK
    text owner_id FK
    text project_id FK
    text blob_id FK
  }
  studio_director_models["studio.director_models"] {
    text id PK
    text owner_id FK
    text owner_key FK
    text category_id FK
    text model_asset_id FK
    text catalog_media_id FK
    text preview_media_id FK
    text preview_asset_id FK
  }
  studio_director_projects["studio.director_projects"] {
    text id PK
    text owner_id FK
    text thumbnail_asset_id FK
    text kind
    text name
  }
  studio_hf_events["studio.hf_events"] {
    text project_id PK, FK
    text owner_id FK
    bigint sequence PK
    bigint project_revision
    text event_type
  }
  studio_hf_files["studio.hf_files"] {
    text id PK
    text project_id FK
    text owner_id FK
    text blob_id FK
    text upload_id FK
  }
  studio_hf_projects["studio.hf_projects"] {
    text id PK
    text owner_id FK
    text name
    bigint revision
  }
  studio_hf_renders["studio.hf_renders"] {
    text id PK
    text project_id FK
    bigint project_revision FK
    text owner_id FK
    text output_blob_id FK
    text imported_asset_id FK
  }
  studio_hf_revision_files["studio.hf_revision_files"] {
    text project_id PK, FK
    bigint project_revision PK, FK
    text owner_id FK
    text path PK
    text blob_id FK
  }
  studio_hf_revisions["studio.hf_revisions"] {
    text project_id PK, FK
    text owner_id FK
    bigint revision PK
    text manifest_sha256
  }
  catalog_media |o..o{ studio_director_models : "catalog_media_id"
  catalog_categories |o..o{ studio_director_models : "category_id"
  media_model_assets |o..o{ studio_director_models : "model_asset_id,owner_key"
  public_assets |o..o{ studio_director_models : "preview_asset_id,owner_key"
  catalog_media |o..o{ studio_director_models : "preview_media_id"
  public_assets |o..o{ studio_director_projects : "thumbnail_asset_id,owner_id"
  studio_hf_projects ||..o{ studio_hf_events : "project_id,owner_id"
  media_blobs |o..o{ studio_hf_files : "blob_id,owner_id"
  studio_hf_projects ||..o{ studio_hf_files : "project_id,owner_id"
  media_blob_uploads |o..o{ studio_hf_files : "upload_id,owner_id,blob_id"
  public_assets |o..o{ studio_hf_renders : "imported_asset_id,owner_id"
  media_blobs |o..o{ studio_hf_renders : "output_blob_id,owner_id"
  studio_hf_revisions ||..o{ studio_hf_renders : "project_id,project_revision,owner_id"
  media_blobs |o..o{ studio_hf_revision_files : "blob_id,owner_id"
  studio_hf_revisions ||..o{ studio_hf_revision_files : "project_id,project_revision,owner_id"
  studio_hf_projects ||..o{ studio_hf_revisions : "project_id,owner_id"
```

## 可靠投递：2张新增

```mermaid
erDiagram
  direction LR
  platform_inbox["platform.inbox"] {
    text source PK
    text event_id PK
    text payload_hash
    text state
    timestamptz received_at
  }
  platform_outbox["platform.outbox"] {
    text id PK
    text aggregate_type
    text aggregate_id
    text event_type
    jsonb payload
  }
```
