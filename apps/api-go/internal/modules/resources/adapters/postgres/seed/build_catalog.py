#!/usr/bin/env python3
"""Offline explicit catalog importer input builder. Never reads environment or fetches media.
Run from repository root: python3 .../seed/build_catalog.py. Sources are committed captured fixtures+media-map.
Only server catalogs are selected; owner data, costs, model directories, billing/community are excluded.
"""
import json,hashlib,pathlib,urllib.parse,re,datetime
# Determine repo root by an existing captured source, without machine paths.
root=next(p for p in pathlib.Path(__file__).resolve().parents if (p/'apps/web/public/fixtures.json').exists())
src=root/'apps/web/public/fixtures.json'; media_src=root/'apps/web/public/media-map.json'
raw=src.read_bytes();fixtures=json.loads(raw);media=json.loads(media_src.read_bytes());media_rows={};items={};categories={};values={}
def internal_description(value):
 text=str(value or '')
 billing=re.compile(r'RH[币幣]|充值|邀请码|邀請碼|会员|会员资格|福利|免费额度|充值|Invitation Code|RH coins|Fan Benefits|top[ -]?up|membership',re.I)
 if '<' not in text:return '' if billing.search(text) else text
 return re.sub(r'<p(?:\s[^>]*)?>.*?</p>',lambda match: '' if billing.search(match.group(0)) else match.group(0),text,flags=re.I|re.S)
def clean(v,k=''):
 if isinstance(v,str) and k.lower() in ['description','intro','presetprompt']:return internal_description(v)
 if isinstance(v,dict):return {key:clean(val,key) for key,val in v.items() if key.lower() not in ['favorited','favorite','collect','iscollect','isown','liked','userecordid'] and not any(s in key.lower() for s in ['price','coin','amount','balance','wallet','skuid','apikey','secret','token','available','accesskey','publishaccess','canmodifypublish','modelcode'])}
 if isinstance(v,list):return [clean(x,k) for x in v]
 if isinstance(v,str) and v.startswith(('http://','https://','/project/assets/')):
  local=v if v.startswith('/project/assets/') else media.get(v) or media.get(v.split('?')[0])
  if local and local.startswith('/project/assets/') and '..' not in local and pathlib.Path(local).suffix.lower() in ['.png','.jpg','.jpeg','.webp','.gif','.mp4','.webm','.mp3','.wav','.ogg','.glb','.fbx'] and pathlib.Path(root/'apps/web/public'/local.lstrip('/')).is_file():
   ident='catmedia_'+hashlib.sha256(local.encode()).hexdigest()[:24];media_rows[ident]={'id':ident,'path':local};return local
  return ''
 return v
def add(family,rows,idkey='id',namekey='name'):
 for row in rows:
  if not isinstance(row,dict) or row.get(idkey) is None:continue
  r=clean(row)
  if isinstance(r.get('workflowContent'),str):
   try:r['workflowContent']=clean(json.loads(r['workflowContent']))
   except (ValueError,TypeError):pass
  ident=str(row[idkey]);name=str(row.get(namekey) or row.get('nameCn') or ident).strip()[:120]
  cats=[]
  if row.get('categoryId') is not None:cats.append(str(row['categoryId']))
  if row.get('code'):cats.append(str(row['code']))
  cats += [str(t['id']) for t in row.get('tags',[]) if isinstance(t,dict) and 'id' in t]
  if family=='WORKFLOW':r['recommended']=True # explicit STUDIO curated-template recommendation policy
  entry={'id':ident,'family':family,'name':name,'description':internal_description(r.get('intro') or r.get('description') or '')[:4000],'content':r,'categoryIds':list(dict.fromkeys(cats)),'coverUrl':r.get('coverUrl') or r.get('thumbnail') or ''}
  if (family,ident) in items:
   prior=items[(family,ident)];prior['content'].update(entry['content']);entry['content']=prior['content'];entry['description']=entry['description'] or prior['description'];entry['categoryIds']=entry['categoryIds'] or prior['categoryIds'];entry['coverUrl']=entry['coverUrl'] or prior['coverUrl']
  date=row.get('publishTime') or row.get('createTime') or row.get('createdAt')
  if isinstance(date,str):
   try:
    parsed=datetime.datetime.fromisoformat(date.replace('Z','+00:00'))
    if parsed.tzinfo is not None:entry['createdAt']=parsed.astimezone(datetime.timezone.utc).isoformat()
   except ValueError:pass
  items[(family,ident)]=entry
for f in fixtures:
 p=urllib.parse.urlparse(f['url']).path;b=f.get('body') or {};d=b.get('data');req=f.get('requestBody');req=json.loads(req) if isinstance(req,str) and req else (req or {})
 if b.get('code')!=0:continue
 records=d.get('records',[]) if isinstance(d,dict) else d if isinstance(d,list) else []
 if p=='/canvas/character-library/list':add('CHARACTER',records)
 elif p in ['/canvas/skill/list','/canvas/api/skill/list/agent']:add('SKILL',records,'skillId')
 elif p=='/canvas/common-workflow/list':add('WORKFLOW',records)
 elif p in ['/api/webapp/list','/api/webapp/detail']:add('APP',records if isinstance(d,list) or 'records' in d else [d])
 elif p=='/task/quick-creation/inspiration/templates':add('INSPIRATION_TEMPLATE',records,'templateId','nameCn')
 elif p=='/canvas/character-library/filter/options':values[('CHARACTER_FILTERS','groups')]={'namespace':'CHARACTER_FILTERS','key':'groups','content':clean(d)}
 elif p.startswith('/canvas/config/query'):
  for row in d if isinstance(d,list) else [d]:
   if isinstance(row,dict) and row.get('type'):values[('CONFIG',row['type'])]={'namespace':'CONFIG','key':row['type'],'content':clean(row)}
 elif p=='/api/portal/v2/getDictConfig':
  for row in records:values[('DICTIONARY',str(row.get('detailName')))]={'namespace':'DICTIONARY','key':str(row.get('detailName')),'content':clean(row)}
 elif p=='/canvas/asset/type/list':
  for n,row in enumerate(records):categories[('ASSET_USER',row['code'])]={'namespace':'ASSET_USER','id':row['code'],'name':row['name'],'sortOrder':n,'context':{},'content':clean(row)}
 elif p=='/api/portal/tag/tree':
  def tree(rows,parent=None):
   for n,row in enumerate(rows):
    ident=str(row['id']);categories[('APP',ident)]={'namespace':'APP','id':ident,'parentId':parent,'name':row['name'],'sortOrder':n,'context':{},'content':clean(row)}
    tree(row.get('childTags') or [],ident)
  tree(records)
# Native immutable tag name presets are source evidence; colors are explicit STUDIO-owned presentation policy.
native_source=root/'apps/web/public/project/assets/index-DeyN_Phq.js';native_bytes=native_source.read_bytes()
match=re.search(r'rXn=(\{content:.*?\});function oXn',native_bytes.decode())
if not match:raise ValueError('native tag preset evidence changed')
presets=json.loads(re.sub(r'([{,])([a-zA-Z_]+):',r'\1"\2":',match.group(1)))
for key,names in presets.items():values[('TAG_PRESET',key)]={'namespace':'TAG_PRESET','key':key,'content':[{'name':name,'color':'#9B87C4','visible':True} for name in names]}
# Service owns its assistant configuration; never serve the preview platform marker.
if ('CONFIG','CANVAS_NEW_AGENT') in values:values[('CONFIG','CANVAS_NEW_AGENT')]['content']['content']={'platformKey':'studio-service','mode':'gateway'}
# Item IDs must stay unique across families in normalized backing storage.
ids={}
for (family,ident),row in items.items():
 if ident in ids and ids[ident]!=family:row['id']=family.lower()+'_'+ident
 ids[ident]=family
out={'version':'captured-2026-10-05-v2','sourceHash':hashlib.sha256(raw+media_src.read_bytes()+native_bytes+pathlib.Path(__file__).read_bytes()).hexdigest(),'sourceName':'captured fixtures.json + media-map.json + native tag preset evidence index-DeyN_Phq.js; STUDIO purple colors, internal descriptions, curated workflow recommendation and gateway projection v2','items':list(items.values()),'categories':list(categories.values()),'values':list(values.values()),'media':list(media_rows.values())}
target=pathlib.Path(__file__).with_name('catalog.json');target.write_text(json.dumps(out,ensure_ascii=False,sort_keys=True,separators=(',',':'))+'\n');print('catalog',len(out['items']),'items',len(out['categories']),'categories',len(out['values']),'values',len(out['media']),'bounded media sources',target.stat().st_size,'bytes')
