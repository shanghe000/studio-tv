"""Rebuild additive contracts only; never writes the frozen v1 files."""
from pathlib import Path
import json
import hashlib
import yaml
ROOT = Path(__file__).resolve().parents[2]
CONTRACTS = ROOT / 'contracts'
V1 = './openapi.json#/components/'

def ref(name): return {'$ref': '#/components/schemas/' + name}
def base(name): return {'$ref': V1 + 'schemas/' + name}
def text(maximum=32000): return {'type':'string','maxLength':maximum}
def enum(*values): return {'type':'string','enum':list(values)}
def array(items, maximum=100): return {'type':'array','items':items,'maxItems':maximum}
def nullable(schema): return {'anyOf':[schema,{'type':'null'}]}
def obj(properties, required=None, **extra):
    return {'type':'object','properties':properties,'required':list(properties) if required is None else required,'additionalProperties':False,**extra}
ID=base('Id'); TIME=base('Project')['$ref']
DATE={'type':'string','format':'date-time','pattern':'Z$'}
REV={'type':'integer','minimum':0}; BOOL={'type':'boolean'}
REL={'type':'string','minLength':1,'maxLength':1024,'pattern':r'^(?!/)(?!.*(?:^|/)\.\.(?:/|$))(?!.*\\)(?!.*:)[A-Za-z0-9._ /-]+$'}
S={}
S['Folder']=obj({'id':ID,'parentId':nullable(ID),'name':{'type':'string','minLength':1,'maxLength':120},'kind':enum('IMAGE','VIDEO','AUDIO','TEXT','MODEL_3D'),'revision':REV,'createdAt':DATE,'updatedAt':DATE})
S['FolderCreate']=obj({'parentId':nullable(ID),'name':{'type':'string','minLength':1,'maxLength':120},'kind':enum('IMAGE','VIDEO','AUDIO','TEXT','MODEL_3D')})
S['FolderUpdate']=obj({'name':{'type':'string','minLength':1,'maxLength':120}})
S['MediaItemContent']=obj({'assetId':ID})
S['TextItemContent']=obj({'text':text(1000000)})
S['ModelItemContent']=obj({'modelAssetId':ID})
def library_schema(full):
    p={'folderId':nullable(ID),'name':{'type':'string','minLength':1,'maxLength':255},'kind':enum('IMAGE','VIDEO','AUDIO','TEXT','MODEL_3D'),'content':{'type':'object'}}
    if full:p.update({'id':ID,'revision':REV,'createdAt':DATE,'updatedAt':DATE})
    return obj(p,allOf=[{'if':{'properties':{'kind':{'const':kind}},'required':['kind']},'then':{'properties':{'content':ref(schema)}}} for kind,schema in [('IMAGE','MediaItemContent'),('VIDEO','MediaItemContent'),('AUDIO','MediaItemContent'),('TEXT','TextItemContent'),('MODEL_3D','ModelItemContent')]])
S['LibraryItem']=library_schema(True);S['LibraryItemCreate']=library_schema(False)
S['LibraryItemUpdate']=obj({'name':{'type':'string','minLength':1,'maxLength':255}})
S['ResourceRevision']=obj({'id':ID,'expectedRevision':REV})
S['LibraryMove']=obj({'targetFolderId':nullable(ID),'folders':array(ref('ResourceRevision')),'items':array(ref('ResourceRevision'))},anyOf=[{'properties':{'folders':{'minItems':1}}},{'properties':{'items':{'minItems':1}}}])
S['LibraryDeletion']=obj({'folders':array(ref('ResourceRevision')),'items':array(ref('ResourceRevision')),'recursive':BOOL},anyOf=[{'properties':{'folders':{'minItems':1}}},{'properties':{'items':{'minItems':1}}}])
S['LibraryBatchResult']=obj({'affectedIds':array(ID,10000),'revision':REV})
S['Character']=obj({'id':ID,'version':{'type':'string','minLength':1},'name':base('LocalizedText'),'description':base('LocalizedText'),'images':array({'type':'string','format':'uri','pattern':'^https://'},20),'attributes':{'type':'object','additionalProperties':text(128)},'favorited':BOOL})
S['CharacterFilter']=obj({'id':ID,'label':base('LocalizedText'),'options':array(obj({'id':ID,'label':base('LocalizedText')}))})
S['AppInputBinding']=obj({'appNodeId':ID,'inputId':ID,'sourceNodeId':ID})
# Discriminated field schemas retain stable input identifiers and input type.
common={'id':ID,'nodeId':ID,'fieldName':{'type':'string','minLength':1},'label':base('LocalizedText'),'description':base('LocalizedText'),'required':BOOL}
variants=[]
for kind,value_schema in [('STRING',text()),('INT',{'type':'integer'}),('FLOAT',{'type':'number'}),('BOOLEAN',BOOL),('SWITCH',BOOL),('LIST',text(1024)),('IMAGE',nullable(ID)),('VIDEO',nullable(ID)),('AUDIO',nullable(ID))]:
    p={**common,'type':{'const':kind},'defaultValue':nullable(value_schema),'constraints':{'type':'object','additionalProperties':True,'description':'JSON Schema 2020-12 fragment; enum/minimum/maximum/length limits only, no script or provider credentials.'}}
    variants.append(obj(p))
S['AppInput']={'oneOf':variants}
S['AIApplication']=obj({'id':ID,'version':{'type':'string','minLength':1},'workflowId':ID,'name':base('LocalizedText'),'description':base('LocalizedText'),'coverUrl':nullable({'type':'string','format':'uri','pattern':'^https://'}),'tagIds':array(ID),'inputs':array(ref('AppInput'),200),'favorited':BOOL,'executionStage':{'const':'RESERVED'}})
S['AppInputValue']=obj({'inputId':ID,'value':{'type':['string','integer','number','boolean','null']}})
S['AppInvocationInput']=obj({'projectId':ID,'appNodeId':ID,'appId':ID,'appVersion':{'type':'string','minLength':1},'values':array(ref('AppInputValue'),200),'bindings':array(ref('AppInputBinding'),200)})
S['AppTag']=obj({'id':ID,'parentId':nullable(ID),'label':base('LocalizedText')})
# Editor details use only already allowed GraphNode.data. No new v1 graph fields.
S['NativeNodeProperties']={'type':'object','properties':{'parentId':ID,'extent':enum('parent'),'style':{'type':'object','additionalProperties':{'type':['string','number','boolean','null']}},'width':{'type':'number','minimum':0},'height':{'type':'number','minimum':0},'zIndex':{'type':'number'}},'additionalProperties':True,'description':'Sanitized JSON UI properties; no credentials, scripts, prototype keys, signed/blob URLs or executable authority.'}
S['EditorNodeMetadata']=obj({'native':ref('NativeNodeProperties')})
S['CanvasMetadata']=obj({'version':{'const':'1'},'meta':{'type':'object','additionalProperties':True},'edges':{'type':'object','additionalProperties':{'type':'object','additionalProperties':True}}})
meta={'allOf':[base('GraphNode'),{'properties':{'id':{'const':'rhtv_meta_v1'},'type':{'const':'__rhtv_meta'},'data':ref('CanvasMetadata')}}]}
node={'allOf':[base('GraphNode'),{'not':{'anyOf':[{'properties':{'id':{'const':'rhtv_meta_v1'}},'required':['id']},{'properties':{'type':{'const':'__rhtv_meta'}},'required':['type']}]}},{'properties':{'data':{'type':'object','properties':{'__rhtv':ref('EditorNodeMetadata')},'additionalProperties':True}}}]}
S['CompatibleProjectGraph']={'allOf':[base('ProjectGraph'),{'properties':{'nodes':{'type':'array','items':{'oneOf':[meta,node]},'contains':meta,'minContains':1,'maxContains':1}}}],'description':'Exactly one reserved metadata node; decoded away before rendering/execution. Validate unique IDs, group/edge endpoints, prototype keys and authorized asset references separately.'}
S['CanvasCapabilities']=obj({'snapshotFormat':{'const':'__rhtv/1'},'collaboration':{'const':'RESERVED'},'graphExecution':{'const':'RESERVED'},'library':{'const':'RESERVED'},'appExecution':{'const':'RESERVED'},'modelProvidersConnected':{'const':False}})
S['ModelBundleFile']=obj({'path':REL,'mimeType':enum('model/gltf-binary','model/gltf+json','application/octet-stream','image/png','image/jpeg','image/webp'),'byteSize':{'type':'integer','minimum':1,'maximum':536870912},'checksumSha256':{'type':'string','pattern':'^[a-f0-9]{64}$'}})
S['ModelAssetUploadRequest']=obj({'projectId':ID,'format':enum('GLB','GLTF'),'entrypoint':REL,'files':{**array(ref('ModelBundleFile'),256),'minItems':1}},allOf=[{'if':{'properties':{'format':{'const':'GLB'}}},'then':{'properties':{'files':{'maxItems':1},'entrypoint':{'pattern':r'\.glb$'}}}},{'if':{'properties':{'format':{'const':'GLTF'}}},'then':{'properties':{'entrypoint':{'pattern':r'\.gltf$'}}}}])
S['ModelUploadFile']=obj({'path':REL,'method':{'const':'PUT'},'url':{'type':'string','format':'uri','pattern':'^https://'},'headers':{'type':'object','additionalProperties':{'type':'string'}}})
S['ModelBundleUpload']=obj({'id':ID,'modelAssetId':ID,'files':array(ref('ModelUploadFile'),256),'expiresAt':DATE,'completeDeadlineAt':DATE})
S['ModelBundleComplete']=obj({'files':{**array(obj({'path':REL,'etag':{'type':'string','minLength':1}}),256),'minItems':1}})
S['ModelAssetFile']=obj({'path':REL,'mimeType':text(128),'byteSize':{'type':'integer','minimum':1},'checksumSha256':{'type':'string','pattern':'^[a-f0-9]{64}$'},'downloadUrl':nullable({'type':'string','format':'uri','pattern':'^https://'})})
S['ModelAsset']=obj({'id':ID,'projectId':ID,'format':enum('GLB','GLTF'),'entrypoint':REL,'state':enum('UPLOADING','PROCESSING','READY','REJECTED','DELETED'),'byteSize':{'type':'integer','minimum':0},'downloadUrl':nullable({'type':'string','format':'uri','pattern':'^https://'}),'urlsExpireAt':nullable(DATE),'files':{**array(ref('ModelAssetFile'),256),'minItems':1},'createdAt':DATE})
S['HFWorkspaceCreate']=obj({'name':{'type':'string','minLength':1,'maxLength':120}})
S['HFWorkspace']=obj({'id':ID,'name':text(120),'revision':REV,'createdAt':DATE,'updatedAt':DATE})
S['HFFileWrite']=obj({'path':REL,'mimeType':enum('text/html','text/plain','application/json','text/css','text/javascript'),'content':text(1000000)})
S['HFFile']=obj({'id':ID,'workspaceId':ID,'path':REL,'mimeType':text(128),'content':text(1000000),'revision':REV,'updatedAt':DATE})
S['HFSessionCreate']=obj({'title':{'type':'string','minLength':1,'maxLength':120}})
S['HFSession']=obj({'id':ID,'workspaceId':ID,'title':text(120),'state':enum('STORED','RUNNING','COMPLETE','FAILED'),'revision':REV,'createdAt':DATE,'updatedAt':DATE})
S['HFMessage']=obj({'text':{'type':'string','minLength':1,'maxLength':32000}})
S['HFRenderRequest']=obj({'entrypointFileId':ID,'workspaceRevision':REV,'width':{'type':'integer','minimum':16,'maximum':4096},'height':{'type':'integer','minimum':16,'maximum':4096},'fps':{'type':'integer','minimum':1,'maximum':60},'durationSeconds':{'type':'number','exclusiveMinimum':0,'maximum':600}})
S['HFRender']=obj({'id':ID,'workspaceId':ID,'workspaceRevision':REV,'state':enum('QUEUED','RUNNING','SUCCEEDED','FAILED','CANCEL_REQUESTED','CANCELED'),'revision':REV,'progress':nullable({'type':'number','minimum':0,'maximum':1}),'outputAssetId':nullable(ID),'error':nullable(base('Error')),'createdAt':DATE,'updatedAt':DATE})
S['HFRenderEvent']=obj({'id':ID,'renderId':ID,'revision':REV,'occurredAt':DATE,'snapshot':ref('HFRender')})
for name in ['Folder','LibraryItem','Character','AIApplication','HFWorkspace','HFFile','HFSession']:
    S[name+'Page']=obj({'items':array(ref(name)),'page':{'type':'integer','minimum':1},'pageSize':{'type':'integer','minimum':1,'maximum':100},'total':REV,'hasMore':BOOL})
S['ModelCapabilityList']={'$ref':'./model-capabilities.json'}
for name in list(S):
    S[name+'Response']=obj({'code':{'const':0},'message':text(200),'requestId':ID,'data':ref(name)})
paths={}
def param(name,where='path',schema=ID,required=True):return {'name':name,'in':where,'required':required,'schema':schema}
def bp(name):return {'$ref':V1+'parameters/'+name}
def operation(path,method,op,response,request=None,params=None,public=False,status='200',description=''):
    parameters=list(params or [])
    if not public:parameters.append(bp('TeamId'))
    if method in ['post','delete'] and 'Favorite' not in op:parameters.append(bp('IdempotencyKey'))
    if method in ['patch','put','delete'] and 'Favorite' not in op and 'favorite' not in op and not path.startswith('/model-assets'):parameters.append(bp('IfMatch'))
    o={'operationId':op,'summary':op,'description':'RESERVED: not deployed; returns 501 NOT_IMPLEMENTED until capability explicitly enabled. '+description,'x-implementation-stage':'RESERVED','security':[{}, {'BearerAuth':[]}] if public else [{'BearerAuth':[]}], 'parameters':parameters,'responses':{status:{'description':'Future successful response; not evidence of implementation.','headers':{'X-Request-Id':{'schema':text(200),'description':'Same as body.requestId.'}},'content':{'application/json':{'schema':ref(response+'Response')}}},'501':{'$ref':V1+'responses/ErrorResponse'},'default':{'$ref':V1+'responses/ErrorResponse'}}}
    if response in ['Folder','LibraryItem','HFWorkspace','HFFile','HFSession','HFRender']:
        o['responses'][status]['headers']['ETag']={'schema':{'type':'string','pattern':'^"[0-9]+"$'},'description':'Strong ETag: quoted resource revision. Lists expose each resource revision; If-Match must match the selected resource.'}
    if request:o['requestBody']={'required':True,'content':{'application/json':{'schema':ref(request)}}}
    paths.setdefault(path,{})[method]=o
paging=[bp('Page'),bp('PageSize'),bp('Search')]
kind=param('kind','query',enum('IMAGE','VIDEO','AUDIO','TEXT','MODEL_3D'),False)
operation('/library/folders','get','listLibraryFolders','FolderPage',params=paging+[param('parentId','query',ID,False),kind],description='Omitted parentId selects root children. Does not recursively list descendants.')
operation('/library/folders','post','createLibraryFolder','Folder','FolderCreate',status='201')
operation('/library/folders/{folderId}','patch','updateLibraryFolder','Folder','FolderUpdate',[param('folderId')])
operation('/library/folders/{folderId}','delete','deleteLibraryFolder','Deleted',params=[param('folderId')],description='Only empty folders; use atomic deletion batch with recursive=true for explicit cascade.')
operation('/library/items','get','listLibraryItems','LibraryItemPage',params=paging+[param('folderId','query',ID,False),kind],description='Omitted folderId selects root items. Does not recursively list descendants.')
operation('/library/items','post','createLibraryItem','LibraryItem','LibraryItemCreate',status='201')
operation('/library/items/{itemId}','patch','updateLibraryItem','LibraryItem','LibraryItemUpdate',[param('itemId')])
operation('/library/items/{itemId}','delete','deleteLibraryItem','Deleted',params=[param('itemId')],description='Removes library reference, never deletes referenced media object.')
operation('/library/moves','post','moveLibraryResources','LibraryBatchResult','LibraryMove',description='Atomic; expected revisions, same authorized scope, no cycles, no partial success.')
operation('/library/deletions','post','deleteLibraryResources','LibraryBatchResult','LibraryDeletion',description='Atomic; recursive explicit. Removing items never cascades into v1 media deletion.')
operation('/characters','get','listCharacters','CharacterPage',params=paging+[param('favoriteOnly','query',BOOL,False),{**param('filterOptionIds','query',{**array(ID),'uniqueItems':True},False),'style':'form','explode':True}],public=True)
operation('/characters/{characterId}','get','getCharacter','Character',params=[param('characterId')],public=True)
operation('/character-filters','get','listCharacterFilters','CharacterFilterList',public=True)
operation('/ai-apps','get','listAIApplications','AIApplicationPage',params=paging+[param('tagId','query',ID,False),param('scope','query',enum('PUBLIC','OWNED','FAVORITED'),False)],public=True)
operation('/ai-apps/{appId}','get','getAIApplication','AIApplication',params=[param('appId')],public=True)
operation('/ai-app-tags','get','listAIApplicationTags','AppTagList',public=True)
for path,entity,name in [('/characters/{characterId}/favorite','characterId','Character'),('/ai-apps/{appId}/favorite','appId','AIApplication')]:
    for method,verb in [('put','set'),('delete','remove')]:operation(path,method,verb+name+'Favorite','Reaction',params=[param(entity)],description='Desired state, never toggle. Repeating PUT stays true; DELETE stays false.')
operation('/ai-app-invocations','post','createAIApplicationInvocation','Acknowledgement','AppInvocationInput',status='202',description='No graph execution in v1. App version and typed bindings validated before any future quote/run; reserved, no fee or fabricated output.')
operation('/canvas/capabilities','get','getCanvasCapabilities','CanvasCapabilities')
operation('/model-assets/uploads','post','createModelAssetUpload','ModelBundleUpload','ModelAssetUploadRequest',status='201',description='GLB one file; GLTF manifest entrypoint + textures/buffers. Reject remote URIs, traversal, missing refs, archives and all executable content. Total <=512 MiB.')
operation('/model-assets/uploads/{uploadId}/complete','post','completeModelAssetUpload','ModelAsset','ModelBundleComplete',[param('uploadId')],status='202',description='Verify all manifest files, hashes, MIME and internal references. ETag alone is not integrity proof.')
operation('/model-assets/{modelAssetId}','get','getModelAsset','ModelAsset',params=[param('modelAssetId')])
operation('/model-assets/{modelAssetId}','delete','deleteModelAsset','Deleted',params=[param('modelAssetId')],description='Reference safety and permissions; active references return409.')
operation('/model-capabilities','get','listReservedModelCapabilities','ModelCapabilityList',public=True)
operation('/hyperframes/workspaces','get','listHFWorkspaces','HFWorkspacePage',params=paging)
operation('/hyperframes/workspaces','post','createHFWorkspace','HFWorkspace','HFWorkspaceCreate',status='201')
operation('/hyperframes/workspaces/{workspaceId}','get','getHFWorkspace','HFWorkspace',params=[param('workspaceId')])
operation('/hyperframes/workspaces/{workspaceId}','delete','deleteHFWorkspace','Deleted',params=[param('workspaceId')],description='Independent workspace; never interprets id as core projectId.')
operation('/hyperframes/workspaces/{workspaceId}/files','get','listHFFiles','HFFilePage',params=[param('workspaceId')]+paging)
operation('/hyperframes/workspaces/{workspaceId}/files','post','createHFFile','HFFile','HFFileWrite',[param('workspaceId')],status='201')
operation('/hyperframes/workspaces/{workspaceId}/files/{fileId}','get','getHFFile','HFFile',params=[param('workspaceId'),param('fileId')])
operation('/hyperframes/workspaces/{workspaceId}/files/{fileId}','put','replaceHFFile','HFFile','HFFileWrite',[param('workspaceId'),param('fileId')])
operation('/hyperframes/workspaces/{workspaceId}/files/{fileId}','delete','deleteHFFile','Deleted',params=[param('workspaceId'),param('fileId')])
operation('/hyperframes/workspaces/{workspaceId}/sessions','get','listHFSessions','HFSessionPage',params=[param('workspaceId')]+paging)
operation('/hyperframes/workspaces/{workspaceId}/sessions','post','createHFSession','HFSession','HFSessionCreate',[param('workspaceId')],status='201')
operation('/hyperframes/workspaces/{workspaceId}/sessions/{sessionId}','get','getHFSession','HFSession',params=[param('workspaceId'),param('sessionId')])
operation('/hyperframes/workspaces/{workspaceId}/sessions/{sessionId}/messages','post','createHFMessage','Acknowledgement','HFMessage',[param('workspaceId'),param('sessionId')],status='202',description='Agent execution/SSE is reserved; stored session is not a connected agent.')
operation('/hyperframes/workspaces/{workspaceId}/renders','post','createHFRender','HFRender','HFRenderRequest',[param('workspaceId')],status='202',description='Server render needs sandbox worker with fixed revision, resource/time bounds, no arbitrary network or host filesystem access.')
operation('/hyperframes/workspaces/{workspaceId}/renders/{renderId}','get','getHFRender','HFRender',params=[param('workspaceId'),param('renderId')])
operation('/hyperframes/workspaces/{workspaceId}/renders/{renderId}/cancel','post','cancelHFRender','HFRender',params=[param('workspaceId'),param('renderId')],status='202')
# Shared v1 types are external refs, without altering their enum or fields.
for name in ['Acknowledgement','Deleted','Reaction']:S[name]=base(name);S[name+'Response']=obj({'code':{'const':0},'message':text(200),'requestId':ID,'data':ref(name)})
for name,item in [('CharacterFilterList','CharacterFilter'),('AppTagList','AppTag')]:S[name]=array(ref(item));S[name+'Response']=obj({'code':{'const':0},'message':text(200),'requestId':ID,'data':ref(name)})
spec={'openapi':'3.1.1','info':{'title':'RHTV additive canvas boundaries','version':'0.1.0','description':'Additive contracts. All extension HTTP operations RESERVED and must return501 NOT_IMPLEMENTED until deployed. Frozen v1.0.0 is unchanged.'},'servers':[{'url':'/api/v1'}],'x-frozen-core-version':'1.0.0','x-frozen-core-sha256':{name:hashlib.sha256((CONTRACTS/name).read_bytes()).hexdigest() for name in ['openapi.json','openapi.yaml']},'x-implementation-stage':'RESERVED','paths':paths,'components':{'securitySchemes':{'BearerAuth':{'type':'http','scheme':'bearer'}},'schemas':S}}
(CONTRACTS/'canvas-extension.json').write_text(json.dumps(spec,ensure_ascii=False,indent=2)+'\n')
(CONTRACTS/'canvas-extension.yaml').write_text(yaml.safe_dump(spec,allow_unicode=True,sort_keys=False))
# Internal provider-neutral schemas; not a public provider proxy or connected adapter.
cap_enum=enum('LLM','TEXT_TO_IMAGE','IMAGE_TO_VIDEO','OMNI_REFERENCE')
cap={'$schema':'https://json-schema.org/draft/2020-12/schema','$id':'https://contracts.rhtv.local/model-capabilities.json','title':'Reserved model capability descriptors','type':'object','properties':{'stage':{'const':'RESERVED'},'connected':{'const':False},'capabilities':array({'$ref':'#/$defs/CapabilityDescriptor'},4)},'required':['stage','connected','capabilities'],'additionalProperties':False,'$defs':{}}
D=cap['$defs']
D['CapabilityDescriptor']=obj({'capability':cap_enum,'connected':{'const':False},'stage':{'const':'RESERVED'},'adapterId':nullable({'type':'string','minLength':1}),'inputContract':{'type':'string','minLength':1},'transports':array(enum('HTTP_JSON','SSE','ASYNC_CALLBACK','POLLING'),4),'nativeSchemaVersion':nullable({'type':'string','minLength':1})})
D['AssetReference']=obj({'assetId':{'type':'string','minLength':1},'role':{'type':'string','minLength':1}})
D['TextPart']=obj({'type':{'const':'TEXT'},'text':text()})
D['AssetPart']=obj({'type':{'const':'ASSET'},'assetId':{'type':'string','minLength':1},'role':text(128)})
D['Message']=obj({'role':enum('SYSTEM','USER','ASSISTANT','TOOL'),'parts':array({'oneOf':[{'$ref':'#/$defs/TextPart'},{'$ref':'#/$defs/AssetPart'}]},100)})
D['LLMInput']=obj({'messages':array({'$ref':'#/$defs/Message'},1000),'parameters':{'type':'object','additionalProperties':True}})
D['TextToImageInput']=obj({'prompt':text(),'outputCount':{'type':'integer','minimum':1,'maximum':16},'parameters':{'type':'object','additionalProperties':True}})
D['ImageToVideoInput']=obj({'sourceAssetId':{'type':'string','minLength':1},'prompt':text(),'parameters':{'type':'object','additionalProperties':True}})
D['OmniReferenceInput']=obj({'prompt':text(),'references':array({'$ref':'#/$defs/AssetReference'},32),'parameters':{'type':'object','additionalProperties':True}})
D['NativeRequest']=obj({'schemaVersion':{'type':'string','minLength':1},'body':{'type':'object','additionalProperties':True}})
D['AdapterInvocation']=obj({'requestId':{'type':'string','minLength':1},'capability':cap_enum,'modelId':{'type':'string','minLength':1},'capabilityVersion':{'type':'string','minLength':1},'invocationType':{'type':'string','minLength':1},'input':{'type':'object'},'nativeRequest':nullable({'$ref':'#/$defs/NativeRequest'})},allOf=[{'if':{'properties':{'capability':{'const':kind}}},'then':{'properties':{'input':{'$ref':'#/$defs/'+name}}}} for kind,name in [('LLM','LLMInput'),('TEXT_TO_IMAGE','TextToImageInput'),('IMAGE_TO_VIDEO','ImageToVideoInput'),('OMNI_REFERENCE','OmniReferenceInput')]])
(CONTRACTS/'model-capabilities.json').write_text(json.dumps(cap,ensure_ascii=False,indent=2)+'\n')
(CONTRACTS/'model-capabilities.yaml').write_text(yaml.safe_dump(cap,allow_unicode=True,sort_keys=False))
print(f'Built {sum(len(x) for x in paths.values())} reserved operations, {len(paths)} additive paths.')
