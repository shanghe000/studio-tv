from pathlib import Path
from copy import deepcopy
import json
ROOT=Path(__file__).resolve().parents[2]
examples=[]
def add(name,schema,value,valid=True,domain='canvas',semantic=None,context=None):
    examples.append({'name':name,'domain':domain,'schema':schema,'value':value,'valid':valid,**({'semantic':semantic,'context':context} if semantic else {})})
add('root-text-folder','FolderCreate',{'parentId':None,'name':'剧本','kind':'TEXT'})
add('folder-name-required','FolderCreate',{'parentId':None,'kind':'TEXT'},False)
add('text-item','LibraryItemCreate',{'folderId':'folder_1','name':'旁白','kind':'TEXT','content':{'text':'清晨的城市。'}})
add('media-item','LibraryItemCreate',{'folderId':'folder_2','name':'参考图','kind':'IMAGE','content':{'assetId':'asset_ready_1'}})
add('3d-item-separate-id','LibraryItemCreate',{'folderId':None,'name':'角色模型','kind':'MODEL_3D','content':{'modelAssetId':'model_asset_1'}})
add('text-not-media','LibraryItemCreate',{'folderId':None,'name':'文本','kind':'TEXT','content':{'assetId':'asset_1'}},False)
add('remote-media-forbidden','LibraryItemCreate',{'folderId':None,'name':'图片','kind':'IMAGE','content':{'url':'https://elsewhere.invalid/a.jpg'}},False)
add('empty-move-rejected','LibraryMove',{'targetFolderId':None,'folders':[],'items':[]},False)
add('move-with-revisions','LibraryMove',{'targetFolderId':'folder_3','folders':[{'id':'folder_2','expectedRevision':4}],'items':[]})
add('manifest-glb','ModelAssetUploadRequest',{'projectId':'project_1','format':'GLB','entrypoint':'character.glb','files':[{'path':'character.glb','mimeType':'model/gltf-binary','byteSize':20,'checksumSha256':'a'*64}]},semantic='modelManifest',context={})
add('gltf-ready-file-resources','ModelAsset',{'id':'model_asset_1','projectId':'project_1','format':'GLTF','entrypoint':'scene.gltf','state':'READY','byteSize':40,'downloadUrl':'https://media.example.invalid/scene.gltf','urlsExpireAt':'2026-10-04T01:00:00Z','files':[{'path':'scene.gltf','mimeType':'model/gltf+json','byteSize':20,'checksumSha256':'a'*64,'downloadUrl':'https://media.example.invalid/scene.gltf'},{'path':'buffer.bin','mimeType':'application/octet-stream','byteSize':20,'checksumSha256':'b'*64,'downloadUrl':'https://media.example.invalid/buffer.bin'}],'createdAt':'2026-10-04T00:00:00Z'})
add('manifest-traversal-rejected','ModelAssetUploadRequest',{'projectId':'project_1','format':'GLTF','entrypoint':'../secret.gltf','files':[{'path':'../secret.gltf','mimeType':'model/gltf+json','byteSize':20,'checksumSha256':'a'*64}]},False)
add('manifest-empty-rejected','ModelAssetUploadRequest',{'projectId':'project_1','format':'GLB','entrypoint':'character.glb','files':[]},False)
add('manifest-entrypoint-missing','ModelAssetUploadRequest',{'projectId':'project_1','format':'GLTF','entrypoint':'scene.gltf','files':[{'path':'buffer.bin','mimeType':'application/octet-stream','byteSize':20,'checksumSha256':'a'*64}]},False,semantic='modelManifest',context={})
input_={'id':'input_scale','nodeId':'source_12','fieldName':'scale','label':{'en':'Scale'},'description':{'en':'Size'},'required':True,'type':'INT','defaultValue':2,'constraints':{'minimum':1,'maximum':4}}
add('typed-app-input','AppInput',input_,semantic='appInput',context={})
bad=deepcopy(input_);bad['defaultValue']='2';add('typed-app-input-string-rejected','AppInput',bad,False)
bad=deepcopy(input_);bad['defaultValue']=5;add('typed-app-default-bounds','AppInput',bad,False,semantic='appInput',context={})
ctx={'app':{'id':'app_1','version':'7','inputs':[{'id':'input_image','type':'IMAGE','required':True}]},'nodes':{'node_image':{'kind':'IMAGE','assetId':'asset_ready_1'}},'assets':{'asset_ready_1':{'state':'READY','authorized':True,'kind':'IMAGE'}}}
app={'projectId':'project_1','appNodeId':'node_app','appId':'app_1','appVersion':'7','values':[],'bindings':[{'appNodeId':'node_app','inputId':'input_image','sourceNodeId':'node_image'}]}
add('app-media-binding','AppInvocationInput',app,semantic='appInvocation',context=ctx)
bad=deepcopy(app);bad['appVersion']='6';add('app-stale-version','AppInvocationInput',bad,False,semantic='appInvocation',context=ctx)
bad=deepcopy(app);bad['bindings'][0]['sourceNodeId']='missing';add('app-dangling-source','AppInvocationInput',bad,False,semantic='appInvocation',context=ctx)
badctx=deepcopy(ctx);badctx['assets']['asset_ready_1']['authorized']=False;add('app-cross-tenant-asset','AppInvocationInput',app,False,semantic='appInvocation',context=badctx)
bad=deepcopy(app);bad['values']=[{'inputId':'input_image','value':'asset_ready_1'}];add('app-conflicting-value-binding','AppInvocationInput',bad,False,semantic='appInvocation',context=ctx)
bad=deepcopy(app);del bad['appVersion'];add('app-version-required','AppInvocationInput',bad,False)
scalar_ctx=deepcopy(ctx);scalar_ctx['app']['inputs']=[{'id':'input_scale','type':'INT','required':True,'constraints':{'minimum':1,'maximum':4}}]
scalar_app=deepcopy(app);scalar_app['bindings']=[];scalar_app['values']=[{'inputId':'input_scale','value':2}]
add('app-typed-submitted-value','AppInvocationInput',scalar_app,semantic='appInvocation',context=scalar_ctx)
for name,value in [('string-rejected','2'),('bounds-rejected',5),('null-required-rejected',None)]:
    bad=deepcopy(scalar_app);bad['values'][0]['value']=value;add('app-submitted-'+name,'AppInvocationInput',bad,False,semantic='appInvocation',context=scalar_ctx)
bad=deepcopy(app);bad['bindings']=[];add('app-required-input-missing','AppInvocationInput',bad,False,semantic='appInvocation',context=ctx)
text_ctx=deepcopy(ctx);text_ctx['app']['inputs']=[{'id':'input_image','type':'STRING','required':True}];text_ctx['nodes']['node_image']={'kind':'TEXT'}
add('app-text-node-binding','AppInvocationInput',app,semantic='appInvocation',context=text_ctx)
metadata={'id':'rhtv_meta_v1','type':'__rhtv_meta','position':{'x':0,'y':0},'data':{'version':'1','meta':{},'edges':{}}}
empty={'schemaVersion':'1','nodes':[metadata],'edges':[],'viewport':{'x':0,'y':0,'zoom':1}}
add('compatible-empty-graph','CompatibleProjectGraph',empty,semantic='graph',context={'authorizedAssets':[]})
bad=deepcopy(empty);bad['nodes']*=2;add('duplicate-metadata-node','CompatibleProjectGraph',bad,False)
bad=deepcopy(empty);bad['nodes'][0]['data']['meta']['__proto__']={'polluted':True};add('prototype-meta-rejected','CompatibleProjectGraph',bad,False,semantic='graph',context={'authorizedAssets':[]})
source={'nodes':[{'id':'group_1','type':'group','position':{'x':2,'y':3},'data':{'title':'组'},'style':{'width':640,'height':480}},{'id':'node_1','type':'rh-image','position':{'x':20,'y':40},'data':{'assetId':'asset_ready_1'},'parentId':'group_1','extent':'parent','style':{'borderRadius':8}}],'edges':[{'id':'edge_1','source':'group_1','target':'node_1','sourceHandle':None,'targetHandle':'input','style':{'stroke':'#8b8'},'animated':False}],'meta':{'id':'project_1','name':'分组项目'},'viewport':{'x':5,'y':-10,'zoom':0.8}}
encoded=deepcopy(source);encoded['schemaVersion']='1';meta=encoded.pop('meta');edge_meta={}
for n in encoded['nodes']:
    extra={k:n.pop(k) for k in list(n) if k not in ['id','type','position','data']}
    if extra:n['data']['__rhtv']={'native':extra}
for e in encoded['edges']:
    edge_meta[e['id']]={k:e.pop(k) for k in list(e) if k not in ['id','source','target','sourceHandle','targetHandle']}
m=deepcopy(metadata);m['data']['meta']=meta;m['data']['edges']=edge_meta;encoded['nodes'].append(m)
add('compatible-group-style-graph','CompatibleProjectGraph',encoded,semantic='graph',context={'authorizedAssets':['asset_ready_1']})
bad=deepcopy(encoded);bad['nodes'][1]['data']['assetId']='other_tenant_asset';add('graph-asset-authority','CompatibleProjectGraph',bad,False,semantic='graph',context={'authorizedAssets':['asset_ready_1']})
bad=deepcopy(encoded);bad['nodes'][1]['data']['__rhtv']['native']['parentId']='node_1';add('graph-group-cycle','CompatibleProjectGraph',bad,False,semantic='graph',context={'authorizedAssets':['asset_ready_1']})
bad=deepcopy(encoded);bad['nodes'][1]['data']['modelAssetId']='other_tenant_model';add('graph-model-asset-authority','CompatibleProjectGraph',bad,False,semantic='graph',context={'authorizedAssets':['asset_ready_1'],'authorizedModelAssets':[]})
add('hf-workspace-file','HFFileWrite',{'path':'scenes/intro.html','mimeType':'text/html','content':'<div>Opening</div>'})
add('hf-absolute-path-rejected','HFFileWrite',{'path':'/etc/passwd','mimeType':'text/plain','content':'a'},False)
add('hf-render-revision','HFRenderRequest',{'entrypointFileId':'hf_file_1','workspaceRevision':3,'width':1920,'height':1080,'fps':30,'durationSeconds':10})
add('hf-render-too-long','HFRenderRequest',{'entrypointFileId':'hf_file_1','workspaceRevision':3,'width':1920,'height':1080,'fps':30,'durationSeconds':601},False)
cap={'stage':'RESERVED','connected':False,'capabilities':[{'capability':k,'connected':False,'stage':'RESERVED','adapterId':None,'inputContract':s,'transports':trans,'nativeSchemaVersion':None} for k,s,trans in [('LLM','LLMInput',['HTTP_JSON','SSE']),('TEXT_TO_IMAGE','TextToImageInput',['HTTP_JSON','POLLING']),('IMAGE_TO_VIDEO','ImageToVideoInput',['POLLING','ASYNC_CALLBACK']),('OMNI_REFERENCE','OmniReferenceInput',['HTTP_JSON','ASYNC_CALLBACK'])]]}
add('all-four-capabilities-reserved','root',cap,domain='model')
bad=deepcopy(cap);bad['connected']=True;add('provider-not-falsely-connected','root',bad,False,domain='model')
for kind,inputvalue in [('LLM',{'messages':[{'role':'USER','parts':[{'type':'TEXT','text':'Describe the scene.'}]}],'parameters':{}}),('TEXT_TO_IMAGE',{'prompt':'Mountain','outputCount':1,'parameters':{'aspectRatio':'16:9'}}),('IMAGE_TO_VIDEO',{'sourceAssetId':'asset_ready_1','prompt':'Slow pan','parameters':{'durationSeconds':5}}),('OMNI_REFERENCE',{'prompt':'Same characters','references':[{'assetId':'asset_ready_1','role':'CHARACTER'}],'parameters':{}})]:
    value={'requestId':'request_1','capability':kind,'modelId':'model_reserved_1','capabilityVersion':'1','invocationType':kind,'input':inputvalue,'nativeRequest':None}
    add('provider-neutral-'+kind,'AdapterInvocation',value,domain='model')
bad={'requestId':'request_1','capability':'IMAGE_TO_VIDEO','modelId':'model_reserved_1','capabilityVersion':'1','invocationType':'IMAGE_TO_VIDEO','input':{'prompt':'Pan','messages':[]},'nativeRequest':None};add('video-not-forced-into-chat-shape','AdapterInvocation',bad,False,domain='model')
(ROOT/'contracts/canvas-extension-examples.json').write_text(json.dumps({'examples':examples,'roundtrips':[{'name':'groups-and-edge-ui','sourceGraph':source,'projectGraph':encoded},{'name':'empty-graph','sourceGraph':{'nodes':[],'edges':[],'meta':{},'viewport':{'x':0,'y':0,'zoom':1}},'projectGraph':empty}]},ensure_ascii=False,indent=2)+'\n')
print(f'Created {len(examples)} schema+semantic examples and 2 graph roundtrip fixtures.')
