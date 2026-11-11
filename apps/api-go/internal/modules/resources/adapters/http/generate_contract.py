#!/usr/bin/env python3
"""Generate independent resource contracts and update owned library extension (JSON is valid YAML1.2)."""
import json,pathlib
root=next(p for p in pathlib.Path(__file__).resolve().parents if (p/'contracts/library-extension.json').exists())
lib=json.loads((root/'contracts/library-extension.json').read_text());common=lib['components']['schemas'];schemas={'Error':common['Error']}
def ref(name):return {'$ref':'#/components/schemas/'+name}
def obj(properties,required=(),extra=False):return {'type':'object','properties':properties,'required':list(required),'additionalProperties':extra}
text={'type':'string'};ident={'type':'string','minLength':1,'maxLength':200};rev={'type':'integer','minimum':1};ids={'type':'array','items':ident,'maxItems':100,'uniqueItems':True};nullable={'oneOf':[ident,{'type':'null'}]}
schemas['ResourceMetadata']=obj({'id':ident,'name':{'type':'string','minLength':1,'maxLength':120},'description':text,'scope':{'enum':['USER','SYSTEM']},'revision':rev,'version':text,'categoryIds':ids,'coverAssetId':nullable,'coverUrl':text,'favorited':{'type':'boolean'},'createdAt':{'type':'string','format':'date-time'},'updatedAt':{'type':'string','format':'date-time'}},['id','name','scope','revision','version','categoryIds','favorited','createdAt','updatedAt'])
schemas['Resource']=obj({'resource':ref('ResourceMetadata'),'content':{'type':'object','additionalProperties':True}},['resource','content'])
schemas['ResourceInput']=obj({'name':{'type':'string','minLength':1,'maxLength':120},'description':{'type':'string','maxLength':4000},'categoryIds':ids,'coverAssetId':nullable,'content':{'type':'object','additionalProperties':True}},['name','categoryIds','content'])
schemas['PromptContent']=obj({'prefixPrompt':text,'suffixPrompt':text,'promptType':{'enum':['','PROMPT','STYLE']},'mediaScope':{'enum':['','IMAGE','VIDEO']},'menuType':{'enum':['','portrait','role_design']},'referenceAssetId':nullable})
schemas['SkillContent']=obj({'intro':text,'markdown':text,'files':{'type':'array','maxItems':100,'items':obj({'path':text,'content':text,'encoding':{'enum':['','utf8','base64']},'mimeType':text,'type':text,'primary':{'type':'boolean'}},['path','content'])},'category':{'enum':['','CANVAS_AGENT']},'presetPrompt':text,'useScenario':text,'useGuide':text,'outputContentDesc':text,'outputType':text,'code':text,'samples':{'type':'array'}})
schemas['WorkflowContent']=obj({'workflowContent':obj({'nodes':{'type':'array','maxItems':2000,'items':{'type':'object'}},'edges':{'type':'array','maxItems':10000,'items':{'type':'object'}}},['nodes','edges'],True),'customNodes':{}},['workflowContent'])
schemas['DirectorContent']=obj({'type':{'enum':['2D','3D']},'content':{'type':['object','null']}},['type','content'])
schemas['DirectorModelContent']=obj({'modelAssetId':ident,'previewAssetId':nullable,'categoryId':text},['modelAssetId'])
schemas['FavoriteInput']=obj({'favorited':{'type':'boolean'}},['favorited']);schemas['UsageInput']=obj({'projectId':nullable,'nodeId':nullable})
schemas['StudioInput']=obj({'id':ident,'title':{'type':'string','minLength':1,'maxLength':120},'projectId':nullable},['title']);schemas['StudioFileInput']=obj({'content':text,'encoding':{'enum':['utf8','base64','']},'mimeType':text},['content','mimeType']);schemas['StudioFile']=obj({'path':text,'content':text,'encoding':{'enum':['utf8','base64']},'mimeType':text,'revision':rev},['path','content','encoding','mimeType','revision'])
schemas['PreferenceInput']=obj({'shortcutKeyConfig':obj({'newline':text,'submitTask':text,'interactionMode':text,'zoomSensitivity':{'type':'number','minimum':10,'maximum':100}}),'buzzyPopFlag':{'type':'boolean'}})
schemas['TagInput']=obj({'name':{'type':'string','minLength':1,'maxLength':60},'color':{'type':'string','pattern':'^#[0-9a-fA-F]{6}$'},'visible':{'type':'boolean'}},['name','color'])
def envelope(data):return obj({'code':{'const':0},'message':text,'requestId':text,'data':data},['code','message','requestId','data'])
page=obj({'records':{'type':'array','items':ref('Resource')},'page':rev,'current':rev,'size':{'type':'integer','minimum':1,'maximum':100},'total':{'type':'integer','minimum':0},'pages':{'type':'integer','minimum':0},'hasNext':{'type':'boolean'}},['records','page','current','size','total','pages','hasNext'])
schemas['ResourceResponse']=envelope(ref('Resource'));schemas['ResourcePageResponse']=envelope(page)
paths={}
def operation(method,path,request=None,response=None,status=200,version=False,key=False,reserved=False,summary=''):
 op={'operationId':'resource_'+method+'_'+path.replace('/api/v2/','').replace('/','_').replace('{','').replace('}',''),'summary':summary or method.upper()+' '+path,'x-implementation-status':'RESERVED' if reserved else 'IMPLEMENTED','security':[{'LocalBearer':[]}],'x-capability':'tv.access','x-required-capability':'tv.access','parameters':[],'responses':{}}
 for name,where,required,schema in ([('If-Match','header',True,{'type':'string','pattern':'^"[1-9][0-9]*"$'})] if version else [])+([('Idempotency-Key','header',True,{'type':'string','format':'uuid'})] if key else []):op['parameters'].append({'name':name,'in':where,'required':required,'schema':schema})
 for part in path.split('/'):
  if part.startswith('{'):op['parameters'].append({'name':part[1:-1],'in':'path','required':True,'schema':ident})
 if request:op['requestBody']={'required':True,'content':{'application/json':{'schema':ref(request) if isinstance(request,str) else request}}}
 if not reserved:op['responses'][str(status)]={'description':'Actual committed/read persisted result','content':{'application/json':{'schema':response or envelope({})}}}
 for code in [400,401,403,404,409,412,428,503]+([501] if reserved or path.endswith('/sessions') else []):op['responses'][str(code)]={'description':{404:'Owner-scoped resource unavailable',412:'Current revision differs',501:'Required root/provider operation not implemented'}.get(code,'Explicit request failure'),'content':{'application/json':{'schema':ref('Error')}}}
 paths.setdefault(path,{})[method]=op;return op
family={'characters':None,'prompts':'PromptContent','skills':'SkillContent','workflows':'WorkflowContent','apps':None,'voices':None,'director-projects':'DirectorContent','director-models':'DirectorModelContent'}
for name,content in family.items():
 p='/api/v2/'+name;op=operation('get',p,response=ref('ResourcePageResponse'));op['x-query-fields']=['page','size','keyword','scope','categoryId','categoryIds','favoriteOnly','recentOnly']+{'characters':['filters'],'prompts':['promptType','mediaScope','menuType'],'skills':['type','category','code','sort'],'workflows':['recommended'],'apps':['sort','days'],'voices':['modelCode','langId','dialectId','sceneIdList','gender'],'director-projects':['type'],'director-models':['categoryCode']}[name]
 operation('get',p+'/{id}',response=ref('ResourceResponse'))
 operation('put',p+'/{id}/favorite','FavoriteInput',ref('ResourceResponse'),version=True)
 operation('post',p+'/{id}/usage','UsageInput',status=201,key=True)
 if content:
  input_name=name.title().replace('-','')+'Input';schemas[input_name]=json.loads(json.dumps(schemas['ResourceInput']));schemas[input_name]['properties']['content']=ref(content)
  operation('post',p,input_name,ref('ResourceResponse'),201,key=True);operation('put',p+'/{id}',input_name,ref('ResourceResponse'),version=True);operation('delete',p+'/{id}',version=True)
for p in ['/characters/filters','/catalog/categories','/catalog/configs','/catalog/dictionaries','/catalog/entries','/catalog/entries/{id}','/apps/{id}/usage-history']:operation('get','/api/v2'+p)
operation('get','/api/v2/apps/{id}/creations',summary='Actual own completed task/assets supplied by production CreationHistory; isolated module without port returns501')
operation('post','/api/v2/workflows/{id}/apply',obj({'projectId':ident},['projectId']),key=True)
operation('post','/api/v2/catalog/media/import',obj({'source':text,'projectId':ident},['source','projectId']),key=True,summary='Audited internal media source import through production MediaMaterializer; isolated module without port returns501')
operation('get','/api/v2/preferences');operation('patch','/api/v2/preferences','PreferenceInput',version=True)
operation('get','/api/v2/tags');operation('post','/api/v2/tags','TagInput',version=True,key=True);operation('patch','/api/v2/tags/{id}',obj({'name':text,'color':text,'visible':{'type':'boolean'}}),version=True);operation('delete','/api/v2/tags/{id}',version=True);operation('put','/api/v2/tags/order',obj({'ids':ids},['ids']),version=True);operation('post','/api/v2/tags/preset',obj({'preset':ident,'replace':{'type':'boolean'}},['preset']),version=True,key=True)
operation('get','/api/v2/hf/projects');operation('post','/api/v2/hf/projects','StudioInput',status=201,key=True);operation('get','/api/v2/hf/projects/{id}');operation('patch','/api/v2/hf/projects/{id}',obj({'title':text},['title']),version=True);operation('delete','/api/v2/hf/projects/{id}',version=True);operation('get','/api/v2/hf/projects/{id}/sessions');operation('post','/api/v2/hf/projects/{id}/sessions',obj({'sessionId':ident},['sessionId']),key=True)
operation('get','/api/v2/studio/projects/{id}')
p='/api/v2/studio/projects/{id}/files/{path}'
operation('get',p,response=envelope(ref('StudioFile')))
for m in ['post','put']:operation(m,p,'StudioFileInput',version=True,key=m=='post')
operation('delete',p,version=True);operation('patch',p,obj({'newPath':text},['newPath']),version=True)
operation('post','/api/v2/studio/projects/{id}/duplicate-file',obj({'path':text},['path']),version=True,key=True)
upload=operation('post','/api/v2/studio/projects/{id}/upload',version=True,key=True);upload['requestBody']={'required':True,'content':{'multipart/form-data':{'schema':obj({'file':{'type':'array','items':{'type':'string','format':'binary'},'maxItems':100}},['file'])}}}
for p in ['/studio/projects/{id}/lint','/studio/registry/blocks','/studio/events','/studio/fonts','/studio/fonts/google']:operation('get','/api/v2'+p)
operation('post','/api/v2/studio/projects/{id}/registry/install',obj({'blockName':ident},['blockName']),version=True,key=True)
for m,p in [('get','/studio/projects/{id}/renders'),('post','/studio/projects/{id}/render'),('get','/studio/render/{jobId}/progress'),('delete','/studio/render/{jobId}'),('get','/studio/projects/{id}/preview/{path}'),]:operation(m,'/api/v2'+p,reserved=True)
operation('post','/api/v2/studio/projects/{id}/file-mutations/remove-element/{path}',obj({'target':obj({'id':text,'selector':text,'selectorIndex':{'type':'integer','minimum':0}})},['target']),version=True)
doc={'openapi':'3.1.0','info':{'title':'STUDIO Product Resources API Extension','version':'2.0.0','description':'Real PostgreSQL resource/catalog/preference/library-adjacent/studio persistence; source catalogs are explicit imported captured subsets. Frozen core contract untouched. Model capabilities, execution, signed preview navigation and render lanes belong to product root.'},'x-default-unknown-path-status':404,'x-persistence':['resources.items','resources.catalog_imports','resources.categories','resources.catalog_values','resources.catalog_media','resources.asset_refs','resources.favorites','resources.usage_records','resources.preferences','resources.tags','resources.studio_projects','resources.studio_files','resources.studio_sessions','resources.studio_events'],'paths':paths,'components':{'securitySchemes':lib['components']['securitySchemes'],'schemas':schemas}}
for ext in ['json','yaml']:(root/f'contracts/resources-extension.{ext}').write_text(json.dumps(doc,ensure_ascii=False,indent=2)+'\n')
# Preserve existing validated gallery schemas and auth references, extending actual fields and operations.
lib['info']['version']='2.0.0';lib['info']['description']='Real private gallery/folder/node aggregates;21 implemented operations, explicit owner/READY assets, revisioned/idempotent transactions. Captured immutable public catalogs are resources extension.';lib['x-reserved-scope']=['Public publishing, team transfer and pricing'];lib['x-persistence']=list(dict.fromkeys(lib['x-persistence']+['library.folders','library.folder_media_refs','library.nodes','library.node_asset_refs']))
ls=lib['components']['schemas'];ls['LibraryImagesResponse']=envelope(obj({'assetIds':ids,'mainAssetId':nullable,'revision':rev},['assetIds','mainAssetId','revision']))
for name,v in list(ls.items()):
 if name in ['LibraryItem','LibraryItemData'] or ('properties' in v and 'itemType' in v.get('properties',{})):
  v['properties']['categoryCode']=text;v['properties']['folderId']=nullable
ls['FolderInput']=obj({'name':text,'categoryCode':{'enum':['USER_CHARACTER','USER_SCENE','USER_THING','USER_STYLE','USER_PRODUCT','USER_OTHER']},'parentId':nullable,'kind':{'const':'MIXED'}},['name','categoryCode'])
ls['FolderPatch']=obj({'name':text,'thumbnailAssetIds':ids});ls['NodeContent']=obj({'nodeType':text,'nodeContent':{'type':'object'},'assetIds':{'type':'array','maxItems':500,'items':ident},'modelAssetIds':{'type':'array','maxItems':500,'items':ident},'primaryAssetId':nullable,'text':nullable},['nodeType','nodeContent'])
ls['NodeInput']=obj({'name':text,'kind':text,'categoryCode':text,'folderId':nullable,'itemType':{'const':'NODE'},'content':ref('NodeContent'),'thumbnailAssetId':nullable},['name','kind','categoryCode','itemType','content'])
ls['BatchCreateInput']=obj({'items':{'type':'array','minItems':1,'maxItems':100,'items':ref('NodeInput')},'expectedCollectionRevision':rev},['items','expectedCollectionRevision'])
ls['BatchMutationInput']=obj({'itemIds':ids,'folderIds':ids,'expectedCollectionRevision':rev,'targetCategoryCode':text,'targetFolderId':nullable},['expectedCollectionRevision'])
# Existing reserved operations become implemented, with body/response shapes.
for p,ops in lib['paths'].items():
 for m,op in ops.items():
  if op['x-implementation-status']=='RESERVED':
   op['x-implementation-status']='IMPLEMENTED';op['responses'].pop('501',None);op['responses']['200']={'description':'Actual persisted result','content':{'application/json':{'schema':envelope({})}}}
  if p.endswith('/images') and m=='get':op['responses']['200']['content']['application/json']['schema']=ref('LibraryImagesResponse')
# Build independent new operations using same envelope and errors.
saved_paths=paths;paths={}
for m,p,body,version,keyed in [('get','/api/v2/library/folders/{id}',None,False,False),('get','/api/v2/library/nodes/{id}',None,False,False),('patch','/api/v2/library/nodes/{id}','NodeInput',True,False),('put','/api/v2/library/items/{id}/images/main',obj({'assetId':nullable}),True,False)]:operation(m,p,body,version=version,key=keyed)
for p,ops in paths.items():lib['paths'].setdefault(p,{}).update(ops)
for p,m,body in [('/api/v2/library/folders','post','FolderInput'),('/api/v2/library/folders/{id}','patch','FolderPatch'),('/api/v2/library/batch-create','post','BatchCreateInput'),('/api/v2/library/batch-delete','post','BatchMutationInput'),('/api/v2/library/move','post','BatchMutationInput'),('/api/v2/library/items/{id}/images','post',obj({'assetIds':ids},['assetIds'])),('/api/v2/library/items/{id}/images/order','put',obj({'assetIds':ids},['assetIds']))]:
 op=lib['paths'][p][m];op['requestBody']={'required':True,'content':{'application/json':{'schema':ref(body) if isinstance(body,str) else body}}};op['responses'].pop('501',None)
 # Replace planned fields/header references with actual version/key contract.
 op['parameters']=[v for v in op.get('parameters',[]) if v.get('in')=='path']
 for name in (['If-Match'] if (m=='patch' or '/images' in p) else ['Idempotency-Key']):op['parameters'].append({'name':name,'in':'header','required':True,'schema':{'type':'string'}})
 if p in ['/api/v2/library/folders','/api/v2/library/batch-create']:
  op['responses']['201']=op['responses'].pop('200',{'description':'Committed result','content':{'application/json':{'schema':envelope({})}}})
for methods in lib['paths'].values():
 for op in methods.values():op['x-required-capability']='tv.access'
for ext in ['json','yaml']:(root/f'contracts/library-extension.{ext}').write_text(json.dumps(lib,ensure_ascii=False,indent=2)+'\n')
print('resources',sum(len(p) for p in saved_paths.values()),'operations; library',sum(len(p) for p in lib['paths'].values()))
