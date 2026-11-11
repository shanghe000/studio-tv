#!/usr/bin/env python3
"""Build ER sources from real PostgreSQL metadata in an isolated temporary DB.

Never reads production data. The original SQL remains the migration authority;
DBML cannot encode every PG trigger/generated/partial-index feature.
"""
from __future__ import annotations
from collections import Counter
import hashlib
import json
from pathlib import Path
import re
import time
import uuid

from validate_database import ROOT, remote, checked

SCHEMAS = ('public','media','canvas','catalog','library','execution','assistant','studio','platform')
MVP = {
 'media.blobs',
 'catalog.media','catalog.categories','catalog.filter_options','catalog.characters',
 'catalog.character_attributes','catalog.character_images','catalog.character_favorites',
 'canvas.tag_sets','canvas.tags','canvas.media_refs',
 'library.collections','library.folders','library.folder_media_refs','library.items','library.item_media_refs',
}
GROUPS = [
 ('现有基础表：10张（含1张已停用历史表）','public',None),
 ('文件与上传：5张新增','media',None),
 ('画布标签与引用：3张新增','canvas',None),
 ('角色目录：7张新增','catalog',['media','categories','filter_options','characters','character_attributes','character_images','character_favorites']),
 ('模型能力：5张新增','catalog',['models','model_groups','model_capabilities','model_versions','model_group_members']),
 ('版本化内容目录：9张新增','catalog',['resources','resource_category_links','resource_user_states','workflow_versions','prompt_versions','skill_versions','skill_files','app_versions','voice_versions']),
 ('个人素材库：5张新增','library',None),
 ('生成与历史：8张新增','execution',None),
 ('Agent：5张新增','assistant',None),
 ('HF与独立导演：8张新增','studio',None),
 ('可靠投递：2张新增','platform',None),
]

CATALOG_SQL = r"""
WITH tabs AS (
 SELECT c.oid,n.nspname AS schema,c.relname AS name
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE c.relkind='r' AND n.nspname IN
 ('public','media','canvas','catalog','library','execution','assistant','studio','platform')
)
SELECT jsonb_build_object(
 'tables', (SELECT jsonb_agg(jsonb_build_object(
   'schema',t.schema,'name',t.name,
   'columns',(SELECT jsonb_agg(jsonb_build_object(
      'name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'notNull',a.attnotnull,
      'generated',a.attgenerated,'identity',a.attidentity,'expression',pg_get_expr(d.adbin,d.adrelid)
    ) ORDER BY a.attnum) FROM pg_attribute a LEFT JOIN pg_attrdef d
      ON d.adrelid=a.attrelid AND d.adnum=a.attnum
      WHERE a.attrelid=t.oid AND a.attnum>0 AND NOT a.attisdropped),
   'constraints',coalesce((SELECT jsonb_agg(jsonb_build_object(
      'name',k.conname,'type',k.contype,'definition',pg_get_constraintdef(k.oid,true),
      'columns',coalesce((SELECT jsonb_agg(a.attname ORDER BY u.ord)
          FROM unnest(k.conkey) WITH ORDINALITY u(num,ord)
          JOIN pg_attribute a ON a.attrelid=k.conrelid AND a.attnum=u.num),'[]'::jsonb)
    ) ORDER BY k.conname) FROM pg_constraint k WHERE k.conrelid=t.oid AND k.contype IN ('p','u','c')),'[]'::jsonb),
   'indexes',coalesce((SELECT jsonb_agg(jsonb_build_object(
      'name',ic.relname,'primary',ix.indisprimary,'unique',ix.indisunique,
      'method',am.amname,'where',pg_get_expr(ix.indpred,ix.indrelid),
      'expression',ix.indexprs IS NOT NULL,'definition',pg_get_indexdef(ix.indexrelid),
      'columns',(SELECT jsonb_agg(pg_get_indexdef(ix.indexrelid,pos,true) ORDER BY pos)
                 FROM generate_series(1,ix.indnkeyatts) pos)
    ) ORDER BY ic.relname) FROM pg_index ix JOIN pg_class ic ON ic.oid=ix.indexrelid
      JOIN pg_am am ON am.oid=ic.relam WHERE ix.indrelid=t.oid),'[]'::jsonb),
   'triggers',coalesce((SELECT jsonb_agg(pg_get_triggerdef(tr.oid,true) ORDER BY tr.tgname)
      FROM pg_trigger tr WHERE tr.tgrelid=t.oid AND NOT tr.tgisinternal),'[]'::jsonb)
 ) ORDER BY t.schema,t.name) FROM tabs t),
 'foreignKeys',(SELECT jsonb_agg(jsonb_build_object(
   'name',k.conname,'child',tn.nspname||'.'||tc.relname,'parent',pn.nspname||'.'||pc.relname,
   'columns',(SELECT jsonb_agg(a.attname ORDER BY u.ord) FROM unnest(k.conkey) WITH ORDINALITY u(num,ord)
              JOIN pg_attribute a ON a.attrelid=k.conrelid AND a.attnum=u.num),
   'parentColumns',(SELECT jsonb_agg(a.attname ORDER BY u.ord) FROM unnest(k.confkey) WITH ORDINALITY u(num,ord)
              JOIN pg_attribute a ON a.attrelid=k.confrelid AND a.attnum=u.num),
   'delete',k.confdeltype,'update',k.confupdtype,'definition',pg_get_constraintdef(k.oid,true)
 ) ORDER BY tn.nspname,tc.relname,k.conname)
 FROM pg_constraint k JOIN pg_class tc ON tc.oid=k.conrelid JOIN pg_namespace tn ON tn.oid=tc.relnamespace
   JOIN pg_class pc ON pc.oid=k.confrelid JOIN pg_namespace pn ON pn.oid=pc.relnamespace
 WHERE k.contype='f' AND k.conrelid IN (SELECT oid FROM tabs))
);
"""

def snapshot():
    migrations = [ROOT/'apps/api-go/migrations'/n for n in
                  ('001_core.sql','002_ipac_auth.sql','003_ipac_workspaces.sql')]
    blueprint=ROOT/'docs/design/database.sql'
    sql=b'\\set ON_ERROR_STOP on\n'+b'\n'.join(p.read_bytes() for p in migrations+[blueprint])+CATALOG_SQL.encode()
    container=None
    try:
        container=checked(remote('deployment-host',['docker','create','--pull=never','--name','studio-tv-er-'+uuid.uuid4().hex,
           '--label','com.studio.purpose=isolated-er-model','--network','none',
           '--tmpfs','/var/lib/postgresql/data:rw,nosuid,nodev,size=512m',
           '--env','POSTGRES_HOST_AUTH_METHOD=trust','postgres:17-alpine']), 'create ER metadata container')
        if not re.fullmatch('[a-f0-9]{64}',container):
            container=None
            raise RuntimeError('unexpected container ID')
        checked(remote('deployment-host',['docker','start',container]),'start ER metadata container')
        deadline=time.monotonic()+45
        while time.monotonic()<deadline:
            if remote('deployment-host',['docker','exec',container,'pg_isready','-U','postgres']).returncode==0:break
            time.sleep(.5)
        else:raise RuntimeError('temporary PG did not become ready')
        result=checked(remote('deployment-host',['docker','exec','-i',container,'psql','-X','-q','-A','-t',
                   '-v','ON_ERROR_STOP=1','-U','postgres'],data=sql.encode() if isinstance(sql,str) else sql,timeout=60),
                   'load design and introspect metadata')
        model=json.loads(result)
        model['sources']={str(p.relative_to(ROOT)):hashlib.sha256(p.read_bytes()).hexdigest()
                          for p in migrations+[blueprint]}
        return model
    finally:
        if container:
            checked(remote('deployment-host',['docker','rm','-f',container]),'destroy temporary ER database')
            print('Temporary ER metadata database destroyed')

def q(text):
    return "'"+str(text).replace('\\','\\\\').replace("'","\\'").replace('\n','\\n')+"'"

def key(table):return table['schema']+'.'+table['name']

def descriptions():
    return {m[0]:m[1].strip() for m in re.findall(r'\| `([^`]+)`[^|]* \| ([^|]+) \|',
                                               (ROOT/'docs/database-design.md').read_text())}

def column_ref(name,columns):
    return name+'.'+(columns[0] if len(columns)==1 else '('+', '.join(columns)+')')

def is_unique(table,columns):
    return any(c['type'] in ('p','u') and set(c['columns'])<=set(columns) for c in table['constraints'])

def dbml(model):
    tables={key(t):t for t in model['tables']}
    notes=descriptions()
    lines=['// GENERATED from isolated PostgreSQL 17 metadata; do not use as a migration.',
           '// 57 proposed tables + 10 existing tables. SQL remains authoritative.',
           '// Source sha256: '+model['sources']['docs/design/database.sql'],
           "Project StudioTV {", "  database_type: 'PostgreSQL'",
           "  Note: '完整规划：57新增+10现有。MVP建议16新增。列/PK/FK来自实际DDL；触发器、生成列和条件索引以database.sql为准。'",'}','']
    for schema in SCHEMAS:
        for t in model['tables']:
            if t['schema']!=schema:continue
            name=key(t)
            purpose=notes.get(name,'既有服务表，复用不重建')
            status='建议首期新增' if name in MVP else ('现有复用' if schema=='public' else '完整蓝图，建议后续')
            if name=='public.ipac_workspaces': status='现有历史表，已停用；不参与业务权限'
            lines.append('Table '+name+' {')
            pk=next((c['columns'] for c in t['constraints'] if c['type']=='p'),[])
            for c in t['columns']:
                settings=[]
                if c['name'] in pk and len(pk)==1: settings.append('pk')
                settings.append('not null' if c['notNull'] else 'null')
                if c['identity']: settings.append('increment')
                if c['expression']:
                    if c['generated']:settings.append('note: '+q('GENERATED ALWAYS AS ('+c['expression']+') STORED'))
                    else:settings.append('default: `'+c['expression']+'`')
                dtype=c['type']
                if re.search(r'\s|\[',dtype):dtype='"'+dtype+'"'
                lines.append('  '+c['name']+' '+dtype+' ['+', '.join(settings)+']')
            lines.append('  Note: '+q(status+'；'+purpose))
            valid_indexes=[i for i in t['indexes'] if not i['expression'] and not i['where']
                           and not (i['primary'] and len(pk)==1)]
            if valid_indexes:
                lines.append('  indexes {')
                for i in valid_indexes:
                    cols='('+', '.join(i['columns'])+')'
                    settings=['name: '+q(i['name'])]
                    if i['primary']:settings.append('pk')
                    elif i['unique']:settings.append('unique')
                    if i['method'] in ('btree','hash'):settings.append('type: '+i['method'])
                    settings.append('note: '+q(i['definition']))
                    lines.append('    '+cols+' ['+', '.join(settings)+']')
                lines.append('  }')
            for i in t['indexes']:
                if i['expression'] or i['where']:lines.append('  // Conditional/expression index: '+i['definition'])
            for c in t['constraints']:
                if c['type']=='c':lines.append('  // '+c['name']+': '+c['definition'])
            for tr in t['triggers']:lines.append('  // SQL trigger: '+tr)
            lines+=['}','']
    actions={'a':'no action','r':'restrict','c':'cascade','n':'set null','d':'set default'}
    for index,fk in enumerate(model['foreignKeys']):
        child=column_ref(fk['child'],fk['columns']); parent=column_ref(fk['parent'],fk['parentColumns'])
        # For one-to-one DBML short form, the right side is the FK side.
        relation=parent+' - '+child if is_unique(tables[fk['child']],fk['columns']) else child+' > '+parent
        lines.append('// '+fk['definition'])
        lines.append(f'Ref fk_{index+1}: '+relation+' [delete: '+actions[fk['delete']]+', update: '+actions[fk['update']]+']')
    lines.append('')
    for schema in SCHEMAS:
        lines.append('TableGroup '+schema+'_tables {')
        lines+=['  '+key(t) for t in model['tables'] if t['schema']==schema]
        lines+=['}','']
    return '\n'.join(lines)

def alias(name):return name.replace('.','_')

def mermaid(model,selected):
    tables={key(t):t for t in model['tables']}
    selected=set(selected)
    # Keep all outgoing business FK edges. Owner edges appear in full DBML;
    # hiding repeated User spokes keeps module diagrams readable.
    edges=[f for f in model['foreignKeys'] if f['child'] in selected and
           (f['parent']!='public.users' or 'public.users' in selected)]
    anchors={f['parent'] for f in edges}-selected
    lines=['erDiagram','  direction LR']
    for name in sorted(selected|anchors):
        t=tables[name]
        lines.append('  '+alias(name)+'["'+name+'"] {')
        pk=set(next((c['columns'] for c in t['constraints'] if c['type']=='p'),[]))
        fk_cols={c for f in model['foreignKeys'] if f['child']==name for c in f['columns']}
        cols=[c for c in t['columns'] if c['name'] in pk|fk_cols]
        if name in selected:
            extra=[c for c in t['columns'] if c not in cols and c['name'] not in ['created_at','updated_at','deleted_at']]
            cols+=extra[:max(0,5-len(cols))]
        for c in cols:
            marks=[]
            if c['name'] in pk:marks.append('PK')
            if c['name'] in fk_cols:marks.append('FK')
            dtype=re.sub(r'\([^)]*\)','',c['type']).replace('timestamp with time zone','timestamptz').replace('double precision','float8').replace(' ','_')
            lines.append('    '+dtype+' '+c['name']+(' '+', '.join(marks) if marks else ''))
        lines.append('  }')
    for f in edges:
        t=tables[f['child']]
        nullable=any(not c['notNull'] for c in t['columns'] if c['name'] in f['columns'])
        left='|o' if nullable else '||'
        right='o|' if is_unique(t,f['columns']) else 'o{'
        pk=set(next((c['columns'] for c in t['constraints'] if c['type']=='p'),[]))
        connector='--' if set(f['columns'])<=pk else '..'
        lines.append('  '+alias(f['parent'])+' '+left+connector+right+' '+alias(f['child'])+' : "'+','.join(f['columns'])+'"')
    return '\n'.join(lines)

INTRO='''# Studio TV 表关系模型

上一版按完整功能范围展开为 **57张新增表**，包含版本、关联、引用、历史、任务和消息基础设施；不是57个业务聚合，也不是DDD要求的最小表数。现有10张表另计（其中ipac_workspaces为已停用历史表）。

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
'''

def main():
    model=snapshot()
    counts=Counter(t['schema'] for t in model['tables'])
    assert counts['public']==10 and len(model['tables'])==67,counts
    assert sum(counts[s] for s in SCHEMAS if s!='public')==57
    names={key(t) for t in model['tables']}
    assert len(MVP)==16 and MVP<=names
    out=ROOT/'docs/design'
    (out/'database-model.json').write_text(json.dumps(model,ensure_ascii=False,indent=2)+'\n')
    (out/'database.dbml').write_text(dbml(model)+'\n')
    blocks=[]
    for title,schema,items in GROUPS:
        selected=[key(t) for t in model['tables'] if t['schema']==schema and (items is None or t['name'] in items)]
        blocks.append('## '+title+'\n\n```mermaid\n'+mermaid(model,selected)+'\n```\n')
    (ROOT/'docs/database-er.md').write_text(INTRO+'\n'+ '\n'.join(blocks))
    print(f'Generated full DBML: 57 new + 10 existing; {len(model["foreignKeys"])} real FKs; 11 module ER diagrams')

if __name__=='__main__':main()
