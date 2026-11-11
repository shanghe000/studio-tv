"""Build the proposed v2 domain contract. Does not register or implement routes."""
from pathlib import Path
import hashlib
import json
import yaml

ROOT = Path(__file__).resolve().parents[2]
C = ROOT / 'contracts'

def ref(name): return {'$ref': '#/components/schemas/' + name}
def string(limit=1000, **kw): return {'type': 'string', 'maxLength': limit, **kw}
def enum(*values): return {'type': 'string', 'enum': list(values)}
def array(item, limit=100): return {'type': 'array', 'items': item, 'maxItems': limit}
def obj(props, required=None):
    return {'type': 'object', 'additionalProperties': False, 'properties': props,
            'required': list(props) if required is None else required}
def nullable(schema): return {'anyOf': [schema, {'type': 'null'}]}
def integer(minimum=0, **kw): return {'type': 'integer', 'minimum': minimum, **kw}
def number(minimum=0): return {'type': 'number', 'minimum': minimum}

ID = string(200, minLength=1)
TIME = string(40, format='date-time')
REV = integer(1)
BOOL = {'type': 'boolean'}
JSON = {'type': 'object', 'additionalProperties': True,
        'description': '仅用于版本化图谱/动态参数/工具JSON；服务端按对应固定版本schema再次校验；禁存密钥。'}
CORE_GRAPH = {'$ref': './openapi.json#/components/schemas/ProjectGraph'}
TASK_STATE = enum('QUEUED', 'PLANNING', 'AWAITING_CONFIRMATION', 'RUNNING', 'CANCEL_REQUESTED',
                  'SUCCEEDED', 'PARTIALLY_SUCCEEDED', 'FAILED', 'CANCELED')
RUN_STATE = enum('QUEUED', 'RUNNING', 'WAITING_TOOL', 'CANCEL_REQUESTED', 'SUCCEEDED', 'FAILED', 'CANCELED')
base = {'id': ID, 'revision': REV, 'createdAt': TIME, 'updatedAt': TIME}
S = {
 'Id': ID,
 'ModelVersionRef': obj({'capabilityId':ID,'version':string(200,minLength=1)}),
 'ResourceVersionRef': obj({'resourceId':ID,'version':string(200,minLength=1)}),
 'Error': {'$ref': './openapi.json#/components/schemas/Error'},
 'Acknowledgement': obj({'accepted': BOOL}),
 'Category': obj({'id': ID, 'namespace': string(60),'nodeRole':enum('GROUP','CATEGORY'), 'code': string(100), 'name': string(255),
                  'parentId': nullable(ID), 'seq': integer(), 'uiType': nullable(enum('TAB','COLOR','DROPDOWN'))}),
 'FilterOption': obj({'categoryCode': string(100), 'code': string(100), 'name': string(255),
                      'color': nullable(string(30)), 'seq': integer(), 'filterOnly': BOOL}),
 'CharacterFilters': obj({'categories': array(ref('Category'), 1000), 'options': array(ref('FilterOption'), 1000)}),
 'CharacterAttribute': obj({'categoryCode': string(100), 'optionCode': string(100),
                            'name': string(255), 'color': nullable(string(30))}),
 'CatalogImage': obj({'id': ID, 'name': string(255), 'viewType': string(60), 'mediaId': ID,
                      'url': string(8192, format='uri'), 'seq': integer()}),
 'Character': obj({**base, 'name': string(255), 'description': nullable(string(2000)), 'favorite': BOOL,
                   'attributes': array(ref('CharacterAttribute')), 'images': array(ref('CatalogImage'), 30)}),
 'MaterializeInput': obj({'projectId': ID, 'mediaIds': array(ID, 30)}),
 'MaterializeResult': obj({'assets': array({'$ref': './openapi.json#/components/schemas/Asset'}, 30)}),
 'FavoriteInput': obj({'favorited': BOOL}),
 'FavoriteState': obj({'id': ID, 'favorited': BOOL}),
 'ModelGroup': obj({'id': ID, 'parentId': nullable(ID), 'name': string(255), 'seq': integer(),
                    'nodeTypes': array(string(100))}),
 'Model': obj({'id': ID, 'code': string(200), 'name': string(255), 'description': nullable(string(2000)),
               'available': BOOL, 'capabilities': array(ref('Capability'), 100)}),
 'Capability': obj({'id': ID, 'modelId': ID, 'nodeType': string(100), 'currentVersion': string(200),
                    'enabled': BOOL, 'outputKinds': array(enum('TEXT','IMAGE','VIDEO','AUDIO','MODEL_3D','WORLD_3D','SCRIPT','STORYBOARD'), 8)}),
 'ModelVersion': obj({'capabilityId': ID, 'version': string(200), 'inputSchema': JSON,
                      'inputRequirements': array(JSON), 'outputKinds':array(string(100)), 'uiConfig': array(JSON, 200), 'defaults': JSON,
                      'generateCounts': array(integer(1, maximum=100)), 'createdAt': TIME}),
 'LibraryContent': obj({'nodeType': string(100), 'nodeContent': JSON,
                        'primaryAssetId':nullable(ID),'primaryModelAssetId':nullable(ID),'text':nullable(string(200000)),
                        'assetIds': array(ID), 'modelAssetIds': array(ID)}, ['nodeType','nodeContent','assetIds','modelAssetIds']),
 'LibraryItem': obj({**base, 'name': string(255), 'kind':enum('IMAGE','VIDEO','AUDIO','TEXT','MODEL_3D'), 'categoryCode': string(100), 'folderId': nullable(ID),
                     'itemType': enum('NODE','ROLE_GALLERY','SCENE_GALLERY'), 'content': ref('LibraryContent'),
                     'thumbnailAssetId': nullable(ID)}),
 'LibraryItemCreate': obj({'name': string(255, minLength=1), 'kind':enum('IMAGE','VIDEO','AUDIO','TEXT','MODEL_3D'), 'categoryCode': string(100),
                           'folderId': nullable(ID), 'itemType': enum('NODE','ROLE_GALLERY','SCENE_GALLERY'),
                           'content': ref('LibraryContent'), 'thumbnailAssetId': nullable(ID)},
                          ['name','kind','categoryCode','itemType','content']),
 'LibraryItemPatch': obj({'name': string(255, minLength=1), 'content': ref('LibraryContent'),
                          'thumbnailAssetId': nullable(ID)}, []),
 'Folder': obj({**base, 'name': string(120), 'kind':enum('MIXED','IMAGE','VIDEO','AUDIO','TEXT','MODEL_3D'), 'categoryCode': string(100), 'parentId': nullable(ID),
                'itemCount': integer(), 'thumbnailAssetIds': array(ID, 4)}),
 'FolderCreate': obj({'name': string(120, minLength=1), 'kind':enum('MIXED','IMAGE','VIDEO','AUDIO','TEXT','MODEL_3D'), 'categoryCode': string(100), 'parentId': nullable(ID)},
                     ['name','categoryCode']),
 'FolderPatch': obj({'name': string(120, minLength=1), 'thumbnailAssetIds': array(ID, 4)}, []),
 'LibrarySelection': obj({'itemIds': array(ID), 'folderIds': array(ID), 'expectedCollectionRevision': REV}),
 'LibraryMove': obj({'itemIds': array(ID), 'folderIds': array(ID), 'expectedCollectionRevision': REV,
                     'targetCategoryCode': string(100), 'targetFolderId': nullable(ID)}),
 'LibraryBatchCreate': obj({'items': array(ref('LibraryItemCreate')), 'expectedCollectionRevision': REV}),
 'CollectionState': obj({'revision': REV}),
 'LibraryMutation': obj({'revision': REV, 'changedIds': array(ID, 10000)}),
 'LibraryEntry': {'oneOf':[obj({'type':{'const':'FOLDER'},'folder':ref('Folder')}),
                          obj({'type':{'const':'ITEM'},'item':ref('LibraryItem')})]},
 'GalleryImage': obj({'id': ID, 'assetId': ID, 'name': string(255), 'seq': integer(), 'main': BOOL,
                      'url': string(8192, format='uri')}),
 'GalleryImageAdd': obj({'assetId': ID, 'name': string(255)}, ['assetId']),
 'GalleryImageOrder': obj({'imageIds': array(ID), 'mainImageId': nullable(ID)}),
 'Tag': obj({'id': ID, 'name': string(100), 'color': string(7,pattern='^#[a-fA-F0-9]{6}$'), 'seq': integer(), 'visible': BOOL}),
 'TagSet': obj({'revision': REV, 'tags': array(ref('Tag'), 200)}),
 'TagCreate': obj({'name': string(100, minLength=1), 'color': string(7,pattern='^#[a-fA-F0-9]{6}$')}),
 'TagPatch': obj({'name': string(100, minLength=1), 'color': string(7,pattern='^#[a-fA-F0-9]{6}$'), 'visible': BOOL}, []),
 'TagOrder': obj({'ids': array(ID, 200)}),
 'TagPreset': obj({'preset': enum('content','ecommerce'), 'replace': BOOL}),
 'ResourceBase': obj({**base, 'name': string(255), 'scope': enum('CURATED','PRIVATE'), 'version': string(200),
                      'description': string(2000), 'categoryIds': array(ID), 'favorited': BOOL,
                      'coverUrl': nullable(string(8192, format='uri'))}),
 'WorkflowContent': obj({'graph': CORE_GRAPH}),
 'PromptContent': obj({'promptType': enum('PRESET','STYLE'), 'prefixPrompt': string(20000),
                       'suffixPrompt': string(20000), 'targetType': enum('IMAGE','VIDEO','TEXT'),
                       'referenceAssetId': nullable(ID)}),
 'SkillFile': obj({'path': string(1024, minLength=1), 'blobId': ID, 'primary': BOOL}),
 'SkillFileWrite': obj({'path': string(1024,minLength=1),'uploadId':ID,'primary':BOOL}),
 'SkillContent': obj({'intro': string(500), 'useScenario': string(600), 'useGuide': string(600),
                      'outputContentDesc': string(600), 'presetPrompt': string(20000),
                      'outputType': enum('TEXT','IMAGE','VIDEO','AUDIO','MODEL_3D','STRUCTURED'),
                      'files': array(ref('SkillFile')), 'samples': array(ref('LibraryContent'), 20)}),
 'AppContent': obj({'workflow':ref('ResourceVersionRef'), 'inputs':array(JSON,200)}),
 'VoiceContent': obj({'providerVoiceRef': string(255), 'languages': array(string(60)), 'dialects': array(string(60)),
                      'gender': enum('FEMALE','MALE','UNKNOWN'), 'sceneCodes': array(string(100)),
                      'labels': array(string(100)), 'exampleMediaId': nullable(ID)}),
 'ResourceUse': obj({'projectId': nullable(ID), 'nodeId': nullable(ID)}, []),
 'HistoryEntry': obj({'id': ID, 'taskId': ID, 'planId': ID, 'nodeId': nullable(ID),
                      'projectId': nullable(ID), 'createdAt': TIME, 'output': ref('Output')}),
 'NodeHistory': obj({'revision': REV, 'resultCount': integer(), 'page': integer(1), 'hasNext': BOOL,
                     'entries': array(ref('HistoryEntry'), 20)}),
 'HistoryDelete': obj({'ids': array(ID)}),
 'HistoryMutation': obj({'revision': REV, 'resultCount': integer(), 'fallbackOutputId': nullable(ID)}),
 'RunInput': obj({'projectId': ID, 'baseRevision': REV, 'targetType': enum('NODE','GROUP','CANVAS'),
                  'targetId': nullable(ID), 'graph': CORE_GRAPH, 'executionKey': string(200)},
                 ['projectId','baseRevision','targetType','targetId','graph']),
 'Task': obj({'id': ID, 'projectId': ID, 'kind': string(100),
              'state': TASK_STATE, 'revision': REV, 'createdAt': TIME, 'updatedAt': TIME,
              'error': nullable(obj({'code': string(100), 'message': string(2000)})),
              'plans': array(ref('Plan'), 1000)}),
 'Plan': obj({'id': ID, 'nodeId': ID, 'state': enum('QUEUED','RUNNING','SUCCEEDED','FAILED','CANCELED','SKIPPED'),
              'modelVersion': nullable(ref('ModelVersionRef')), 'outputs': array(ref('Output')), 'errorCode': nullable(string(100))}),
 'CancelInput': obj({'reason': string(255)}, []),
 'TaskBatchInput': obj({'ids': array(ID), 'includeOutputs': BOOL}, ['ids']),
 'TaskBatch': obj({'tasks': array(ref('Task')), 'missingIds': array(ID)}),
 'TaskSnapshot': obj({'graph': CORE_GRAPH, 'nodeId': nullable(ID), 'modelVersions': array(ref('ModelVersionRef')),
                      'resolvedParams': JSON}),
 'MediaJobInput': obj({'projectId': ID, 'nodeId': nullable(ID),
                       'operation': enum('CROP','SPEED','REVERSE','ROTATE','MIRROR','ROTATE_MIRROR','TRIM','CONCAT','TRANSCODE'),
                       'spec': ref('MediaSpec')}, ['projectId','operation','spec']),
 'MediaSpec': obj({'version': {'const': 1}, 'inputs': array(obj({'id': ID, 'assetId': ID}), 30),
                   'tracks': array(ref('MediaTrack'), 30), 'output': ref('MediaOutput')}),
 'MediaTrack': obj({'type': enum('video','audio'), 'clips': array(ref('MediaClip'), 100)}),
 'MediaClip': obj({'input': ID, 'trim': obj({'startMs': integer(), 'endMs': integer()}, ['startMs']),
                   'crop': obj({'x': integer(), 'y': integer(), 'width': integer(1), 'height': integer(1)}),
                   'speed': {'type':'number','exclusiveMinimum':0,'maximum':100}, 'reverse': BOOL,
                   'rotate': enum('0','90','180','270'), 'mirror': enum('horizontal','vertical')}, ['input']),
 'MediaOutput': obj({'container': enum('mp4','webm','mov','wav'), 'fps': integer(1, maximum=120),
                     'width': integer(1, maximum=16384), 'height': integer(1, maximum=16384)}, ['container']),
 'SketchInput': obj({'projectId': ID, 'sourceAssetId': ID, 'prompt': string(20000),
                     'styleVersion': nullable(ref('ResourceVersionRef')), 'modelVersion':ref('ModelVersionRef'), 'mode': enum('LIVE','MANUAL')}),
 'Conversation': obj({**base, 'projectId': nullable(ID), 'hfProjectId': nullable(ID),
                      'kind': enum('CANVAS','HF'), 'title': string(120)}),
 'ConversationCreate': obj({'kind': enum('CANVAS','HF'), 'projectId': nullable(ID),
                            'hfProjectId': nullable(ID), 'title': string(120)}, ['kind','title']),
 'Message': obj({'id': ID, 'conversationId': ID, 'seq': integer(1), 'role': enum('USER','ASSISTANT','TOOL'),
                 'content': array(ref('MessagePart')), 'createdAt': TIME}),
 'MessagePart': {'oneOf': [obj({'type': {'const':'TEXT'}, 'text': string(200000)}),
                          obj({'type': {'const':'ASSET'}, 'assetId': ID}),
                          obj({'type': {'const':'STRUCTURED'}, 'schemaCode': string(100), 'value': JSON})]},
 'ChatInput': obj({'content': array(ref('MessagePart')), 'skillVersions': array(ref('ResourceVersionRef'),30),
                   'modelVersion':ref('ModelVersionRef'), 'interactionMode': enum('ASK','AUTO')}),
 'AssistantRun': obj({'id': ID, 'conversationId': ID, 'state': RUN_STATE, 'revision': REV,
                      'createdAt': TIME, 'updatedAt': TIME, 'toolCalls': array(ref('ToolCall'))}),
 'ToolCall': obj({'id': ID, 'name': string(100), 'state': enum('PENDING','RUNNING','SUCCEEDED','FAILED','CANCELED'),
                  'arguments': JSON, 'requiresConfirmation': BOOL, 'deadlineAt': nullable(TIME)}),
 'ToolResult': obj({'state': enum('SUCCEEDED','FAILED','CANCELED'), 'result': JSON}),
 'Event': obj({'seq': integer(1), 'type': string(100), 'schemaVersion': integer(1), 'createdAt': TIME, 'data': JSON}),
 'HfProject': obj({**base, 'name': string(120)}),
 'HfCreate': obj({'name': string(120, minLength=1)}),
 'HfPatch': obj({'name': string(120, minLength=1)}),
 'HfFile': obj({'path': string(1024), 'revision': REV, 'byteSize': integer(), 'mimeType': string(255),
                'updatedAt': TIME, 'blobId':nullable(ID)}),
 'HfFileWrite': obj({'content': string(2000000), 'mimeType': string(255)}),
 'HfRenderInput': obj({'fps': {'type':'integer','enum':[24,30,60]}, 'quality': enum('draft','standard','high'),
                       'format': enum('mp4','webm','mov'), 'resolution': enum('1080p','4k'),
                       'composition': string(1024)}, ['fps','quality','format']),
 'HfRender': obj({'id': ID, 'projectId': ID, 'projectRevision':REV,'revision':REV,
                  'state': enum('QUEUED','RUNNING','SUCCEEDED','FAILED','CANCEL_REQUESTED','CANCELED'),
                  'createdAt': TIME, 'outputAssetId': nullable(ID),'downloadUrl':nullable(string(8192,format='uri'))}),
 'DirectorProject': obj({**base, 'name': string(120), 'type': enum('2D','3D'), 'content': JSON,
                         'thumbnailAssetId': nullable(ID)}),
 'DirectorCreate': obj({'name': string(120, minLength=1), 'type': enum('2D','3D'), 'content': JSON,
                        'thumbnailAssetId': nullable(ID)}, ['name','type','content']),
 'DirectorPatch': obj({'name': string(120, minLength=1), 'content': JSON, 'thumbnailAssetId': nullable(ID)}, []),
 'ModelAsset': obj({**base, 'name': string(255), 'format': enum('GLB','GLTF','OBJ','FBX','SPZ','PLY','SPLAT'),
                    'state': enum('UPLOADING','PROCESSING','READY','REJECTED','DELETED'),
                    'entrypoint': string(1024), 'files': array(ref('ModelFile')), 'previewAssetId': nullable(ID)}),
 'ModelFile': obj({'path': string(1024), 'blobId': ID, 'mimeType': string(255), 'byteSize': integer(1)}),
 'ModelUploadInput': obj({'name': string(255), 'format': enum('GLB','GLTF','OBJ','FBX','SPZ','PLY','SPLAT'),
                         'entrypoint': string(1024), 'files': array(ref('UploadFile'), 100),
                         'previewAssetId': nullable(ID)}, ['name','format','entrypoint','files']),
 'UploadFile': obj({'path': string(1024), 'byteSize': integer(1, maximum=536870912),
                    'mimeType': string(255), 'sha256': string(64, pattern='^[a-f0-9]{64}$')}),
 'ModelUpload': obj({'id': ID, 'modelAssetId': ID, 'expiresAt': TIME, 'grants': array(ref('UploadGrant'))}),
 'UploadGrant': obj({'path': string(1024), 'putUrl': string(8192, format='uri'), 'headers': JSON}),
 'UploadComplete': obj({'files': array(obj({'path': string(1024), 'etag': string(255)}))}),
 'BlobUploadInput': obj({'purpose':enum('SKILL','HF'),'hfProjectId':nullable(ID),'file':ref('UploadFile')},['purpose','file']),
 'BlobUpload': obj({'id':ID,'blobId':ID,'expiresAt':TIME,'grant':ref('UploadGrant')}),
 'BlobReceipt': obj({'id':ID,'blobId':ID,'purpose':enum('SKILL','HF'),'state':{'const':'READY'}}),
 'Download': obj({'url':string(8192,format='uri'),'expiresAt':TIME}),
 'HfFileBinding': obj({'path':string(1024),'uploadId':ID,'expectedRevision':nullable(REV)},['path','uploadId']),
 'DirectorModel': obj({**base, 'name': string(255), 'modelAssetId': ID, 'categoryId': nullable(ID),
                       'previewAssetId': nullable(ID)}),
 'DirectorModelCreate': obj({'name': string(255), 'modelAssetId': ID, 'categoryId': nullable(ID),
                             'previewAssetId': nullable(ID)}, ['name','modelAssetId']),
}

S['Output'] = {'oneOf': [
 obj({'id':ID, 'kind':{'const':'TEXT'}, 'text':string(200000)}),
 obj({'id':ID, 'kind':enum('IMAGE','VIDEO','AUDIO'), 'assetId':ID, 'url':string(8192,format='uri'),
      'width':nullable(integer(1)), 'height':nullable(integer(1)), 'durationMs':nullable(integer())}),
 obj({'id':ID, 'kind':{'const':'MODEL_3D'}, 'modelAssetId':ID}),
 obj({'id':ID, 'kind':{'const':'WORLD_3D'}, 'url':string(8192,format='uri')}),
 obj({'id':ID, 'kind':enum('SCRIPT','STORYBOARD'), 'schemaCode':string(100), 'value':JSON})]}
S['SkillContentWrite']={**S['SkillContent'],'properties':{**S['SkillContent']['properties'],'files':array(ref('SkillFileWrite'))}}
S['RunInput']['allOf']=[{'if':{'properties':{'targetType':{'const':'CANVAS'}}},
                       'then':{'properties':{'targetId':{'type':'null'}}},
                       'else':{'properties':{'targetId':ID}}}]
S['BlobUploadInput']={'oneOf':[obj({'purpose':{'const':'SKILL'},'file':ref('UploadFile')}),
                              obj({'purpose':{'const':'HF'},'hfProjectId':ID,'file':ref('UploadFile')})]}
S['ConversationCreate']['allOf']=[{'if':{'properties':{'kind':{'const':'CANVAS'}}},
    'then':{'required':['projectId'],'properties':{'projectId':ID,'hfProjectId':{'type':'null'}}},
    'else':{'properties':{'projectId':{'type':'null'}}}}]
S['FolderCreate']['properties']['kind']['default']='MIXED'
for schema,key in [('MaterializeInput','mediaIds'),('LibraryBatchCreate','items'),('ModelUploadInput','files'),
                   ('UploadComplete','files'),('ChatInput','content')]:
    S[schema]['properties'][key]['minItems']=1
for kind in ['Workflow','Prompt','Skill','App','Voice']:
    S[kind] = obj({'resource':ref('ResourceBase'), 'content':ref(kind+'Content')})
    S[kind+'Write'] = obj({'name':string(255,minLength=1),'description':string(2000),
                           'categoryIds':array(ID),'coverAssetId':nullable(ID),'content':ref(kind+'ContentWrite' if kind=='Skill' else kind+'Content')},
                          ['name','content'])

PARAMS = {
 'Page': {'name':'page','in':'query','schema':integer(1,maximum=100000),'description':'默认1'},
 'Size': {'name':'size','in':'query','schema':integer(1,maximum=100),'description':'默认20；节点历史最大20'},
 'Search': {'name':'keyword','in':'query','schema':string(300)},
 'IfMatch': {'name':'If-Match','in':'header','required':True,'schema':string(32,pattern='^"[1-9][0-9]*"$')},
 'IdempotencyKey': {'name':'Idempotency-Key','in':'header','required':True,'schema':string(36,format='uuid')},
 'LastEventId': {'name':'Last-Event-ID','in':'header','schema':string(30,pattern='^[0-9]+$')},
}
P = {}
def query(name, schema, required=False): return {'name':name,'in':'query','required':required,'schema':schema}
def op(path, method, oid, summary, output=None, body=None, phase='P1', tables=(), page=False,
       params=(), etag=False, idem=False, status=None, stream=False, description=''):
    if output and page:
        pname = output+'Page'
        S.setdefault(pname,obj({'records':array(ref(output)), 'page':integer(1), 'size':integer(1),
                               'total':integer(), 'hasNext':BOOL}))
        output = pname
    parameters = list(params)
    if page: parameters += [{'$ref':'#/components/parameters/'+k} for k in ['Page','Size','Search']]
    for name in __import__('re').findall(r'\{(\w+)\}',path):
        parameters.append({'name':name,'in':'path','required':True,'schema':ID})
    if etag: parameters.append({'$ref':'#/components/parameters/IfMatch'})
    if idem: parameters.append({'$ref':'#/components/parameters/IdempotencyKey'})
    code = str(status or (201 if method=='post' and not stream else 200))
    response={'description':'设计中的成功返回；不代表已经实现。'}
    if output and not stream:
        ename=output+'Response'
        S.setdefault(ename,obj({'code':{'const':0},'message':string(2000),'data':ref(output),'requestId':string(200)}))
        response['content']={'application/json':{'schema':ref(ename)}}
    if stream:
        response['content']={'text/event-stream':{'schema':string(2000000),
            'example':'id: 1\nevent: task.state\ndata: {"seq":1,"type":"task.state","schemaVersion":1,"createdAt":"2026-10-05T00:00:00Z","data":{"state":"RUNNING"}}\n\n'}}
    if etag or (output and output in ['Folder','LibraryItem','TagSet','DirectorProject','HfProject','Task']):
        response['headers']={'ETag':{'schema':string(32),'description':'强ETag，引用本端点所指定的资源/集合revision'}}
    operation={'operationId':oid,'summary':summary,'tags':[path.strip('/').split('/')[0]],
               'x-design-status':'PROPOSED','x-implementation-stage':'RESERVED','x-phase':phase,
               'x-persistence':list(tables),'parameters':parameters,
               'description':description or '设计合同；注册RESERVED路由后501，当前未注册路径404。',
               'responses':{code:response,'501':{'$ref':'#/components/responses/Error'},
                            'default':{'$ref':'#/components/responses/Error'}}}
    if stream: operation['x-event-schema']=ref('Event')
    if body: operation['requestBody']={'required':True,'content':{'application/json':{'schema':ref(body)}}}
    P.setdefault(path,{})[method]=operation

op('/catalog/categories','get','domainCategories','目录分类','Category',page=True,tables=['catalog.categories'],
   params=[query('namespace',string(60),True)])
op('/characters/filters','get','domainCharacterFilters','角色筛选选项','CharacterFilters',tables=['catalog.categories','catalog.filter_options'])
op('/characters','get','domainCharacters','公共角色真实分页','Character',page=True,
   tables=['catalog.characters','catalog.character_attributes','catalog.character_images','catalog.character_favorites'],
   params=[query('favoriteOnly',BOOL), {'name':'filters','in':'query','content':{'application/json':{'schema':array(obj({'categoryCode':string(100),'optionCodes':array(string(100))}))}}}],
   description='filters是JSON编码query数组；分类间AND，同分类选项OR；返回签名媒体投影及当前用户收藏。')
op('/characters/{id}','get','domainCharacter','公共角色详情','Character',tables=['catalog.characters','catalog.character_images','catalog.character_attributes'])
op('/characters/{id}/favorite','put','domainCharacterFavorite','设置角色收藏','FavoriteState','FavoriteInput',tables=['catalog.character_favorites'])
op('/catalog/media/materialize','post','domainMaterialize','公共目录素材转为本人READY资产','MaterializeResult','MaterializeInput',
   tables=['catalog.media','media.blobs','public.assets'],idem=True,
   description='校验可见的catalog.media，只物化至本人非删除project；READY校验和物化幂等，不接受任意URL。返回后再保存图谱。')
op('/models','get','domainModels','模型与能力目录','Model',page=True,
   tables=['catalog.models','catalog.model_capabilities','catalog.model_versions'],params=[query('nodeType',string(100))])
op('/models/groups','get','domainModelGroups','模型家族','ModelGroup',page=True,tables=['catalog.model_groups','catalog.model_group_members'])
op('/model-capabilities/{id}/versions/{version}','get','domainModelVersion','固定模型能力版本','ModelVersion',tables=['catalog.model_versions'])
op('/library/state','get','domainLibraryState','本人资产库集合版本','CollectionState',tables=['library.collections'])
op('/library/entries','get','domainLibraryEntries','根目录和二级目录统一分页','LibraryEntry',page=True,
   tables=['library.folders','library.items'],params=[query('categoryCode',string(100)),query('parentId',ID),query('recursive',BOOL)],
   description='UNION读模型统一排序和count，省略parentId查根，recursive仅供全库搜索；禁止把两份独立分页结果拼成一页。')
op('/library/folders','get','domainLibraryFolders','本人文件夹分页','Folder',page=True,tables=['library.folders','library.folder_media_refs'],
   params=[query('categoryCode',string(100)),query('parentId',ID)])
op('/library/folders','post','domainCreateFolder','新建资产库文件夹','Folder','FolderCreate',tables=['library.collections','library.folders'],idem=True)
op('/library/folders/{id}','patch','domainUpdateFolder','改名和封面','Folder','FolderPatch',tables=['library.collections','library.folders','library.folder_media_refs'],etag=True)
op('/library/items','get','domainLibraryItems','本人库条目与图库分页','LibraryItem',page=True,
   tables=['library.items','library.item_media_refs'],params=[query('categoryCode',string(100)),query('folderId',ID),
          query('kind',enum('IMAGE','VIDEO','AUDIO','TEXT','MODEL_3D')),query('itemType',enum('NODE','ROLE_GALLERY','SCENE_GALLERY')),query('nodeType',string(100)),query('after',TIME),query('before',TIME)])
op('/library/items','post','domainCreateItem','保存节点或自有图库','LibraryItem','LibraryItemCreate',tables=['library.items','library.item_media_refs','library.collections'],idem=True)
op('/library/items/{id}','get','domainLibraryItem','库条目详情','LibraryItem',tables=['library.items','library.item_media_refs'])
op('/library/items/{id}','patch','domainUpdateItem','更新库条目','LibraryItem','LibraryItemPatch',tables=['library.items','library.item_media_refs','library.collections'],etag=True)
for action,body in [('batch-create','LibraryBatchCreate'),('batch-delete','LibrarySelection'),('move','LibraryMove')]:
    op('/library/'+action,'post','domainLibrary'+action.title().replace('-',''), '原子'+action,'LibraryMutation',body,
       tables=['library.collections','library.folders','library.items','library.item_media_refs'],idem=True,status=200,
       description='锁collection并比较expectedCollectionRevision；全部归属/类别/引用/循环校验通过才提交，失败全部回滚。与原站未知部分成功协议不同，兼容层显式转换。')
op('/library/items/{id}/images','get','domainGalleryImages','本人图库有序图片','GalleryImage',page=True,tables=['library.items','library.item_media_refs'])
op('/library/items/{id}/images','post','domainAddGalleryImage','图库添图','LibraryItem','GalleryImageAdd',tables=['library.items','library.item_media_refs'],etag=True,idem=True)
op('/library/items/{id}/images/order','put','domainOrderGalleryImages','主图和排序','LibraryItem','GalleryImageOrder',tables=['library.items','library.item_media_refs'],etag=True)
op('/library/items/{id}/images/{imageId}','delete','domainDeleteGalleryImage','图库删图','LibraryItem',tables=['library.items','library.item_media_refs'],etag=True)
op('/tags','get','domainTags','本人标签集合','TagSet',tables=['canvas.tag_sets','canvas.tags'])
op('/tags','post','domainCreateTag','创建标签','TagSet','TagCreate',tables=['canvas.tag_sets','canvas.tags'],etag=True,idem=True)
op('/tags/{id}','patch','domainUpdateTag','标签名称颜色显隐','TagSet','TagPatch',tables=['canvas.tag_sets','canvas.tags'],etag=True)
op('/tags/{id}','delete','domainDeleteTag','删除标签定义','TagSet',tables=['canvas.tag_sets','canvas.tags'],etag=True)
op('/tags/order','put','domainOrderTags','排序标签','TagSet','TagOrder',tables=['canvas.tag_sets','canvas.tags'],etag=True)
op('/tags/preset','post','domainTagPreset','恢复预设标签','TagSet','TagPreset',tables=['canvas.tag_sets','canvas.tags'],etag=True,idem=True,status=200)
for kind,table in [('Workflow','workflow'),('Prompt','prompt'),('Skill','skill'),('App','app'),('Voice','voice')]:
    route={'App':'apps','Voice':'voices'}.get(kind,kind.lower()+'s')
    tables=['catalog.resources','catalog.'+table+'_versions','catalog.resource_category_links','catalog.resource_user_states']
    op('/'+route,'get','domainList'+kind,'分页'+kind,kind,page=True,tables=tables,
       params=[query('scope',enum('CURATED','PRIVATE')),query('favoriteOnly',BOOL),query('categoryId',ID),query('recentOnly',BOOL)] +
              ([query('modelCode',string(200)),query('language',string(60)),query('dialect',string(60)),query('gender',enum('FEMALE','MALE','UNKNOWN')),query('sceneCode',string(100))] if kind=='Voice' else []))
    op('/'+route+'/{id}','get','domainRead'+kind,kind+'详情',kind,tables=tables,params=[query('version',string(200))])
    op('/'+route+'/{id}/favorite','put','domainFavorite'+kind,'设置收藏','FavoriteState','FavoriteInput',tables=['catalog.resources','catalog.resource_user_states'])
    op('/'+route+'/{id}/usage','post','domainUse'+kind,'记录使用','Acknowledgement','ResourceUse',tables=['catalog.resources','catalog.resource_user_states'],idem=True,status=200)
    if kind in ['Workflow','Prompt','Skill']:
        op('/'+route,'post','domainCreate'+kind,'新建本人'+kind,kind,kind+'Write',tables=tables,idem=True)
        op('/'+route+'/{id}','put','domainUpdate'+kind,'提交'+kind+'新版本',kind,kind+'Write',tables=tables,etag=True)
        op('/'+route+'/{id}','delete','domainDelete'+kind,'软删本人'+kind,'Acknowledgement',tables=tables,etag=True)
op('/canvas-runs','post','domainRunCanvas','冻结图谱并创建执行任务','Task','RunInput',phase='P2',
   tables=['execution.tasks','execution.plans','execution.dependencies','platform.outbox'],idem=True,status=202,
   description='验证owner、tv.access和baseRevision、目标存在及模型schema。冻结本次graph，不隐式覆盖保存快照。供应商未配置返回501 MODEL_PROVIDER_UNCONFIGURED，无假成功任务。')
op('/tasks/{id}','get','domainTask','查询任务与输出','Task',phase='P2',tables=['execution.tasks','execution.plans','execution.outputs'])
op('/tasks/batch-status','post','domainTaskBatch','批量轮询','TaskBatch','TaskBatchInput',phase='P2',tables=['execution.tasks','execution.plans','execution.outputs'],status=200)
op('/tasks/{id}/cancel','post','domainCancelTask','请求停止任务','Task','CancelInput',phase='P2',tables=['execution.tasks','execution.plans','platform.outbox'],idem=True,status=202)
op('/tasks/{id}/snapshot','get','domainTaskSnapshot','复用生成参数','TaskSnapshot',phase='P2',tables=['execution.tasks','execution.plans'])
op('/tasks/{id}/confirm','post','domainConfirmTask','确认已冻结的执行计划','Task',phase='P2',tables=['execution.tasks','execution.plans'],etag=True,idem=True,status=202)
op('/tasks/{id}/events','get','domainTaskEvents','任务状态持久事件流',phase='P2',tables=['execution.events'],stream=True,
   params=[{'$ref':'#/components/parameters/LastEventId'}])
op('/history','get','domainHistory','全局输出历史','HistoryEntry',phase='P2',page=True,tables=['execution.history_entries','execution.outputs'],
   params=[query('projectId',ID),query('kind',enum('TEXT','IMAGE','VIDEO','AUDIO','MODEL_3D','WORLD_3D','SCRIPT','STORYBOARD'))])
op('/outputs/{id}/download','get','domainOutputDownload','输出文件授权下载','Download',phase='P2',tables=['execution.outputs','media.blobs','public.assets','media.model_assets'])
op('/history/batch-delete','post','domainDeleteHistory','本人历史软隐藏','Acknowledgement','HistoryDelete',phase='P2',tables=['execution.history_entries','execution.history_heads'],idem=True,status=200)
op('/projects/{id}/nodes/{nodeId}/history','get','domainNodeHistory','节点历史与revision','NodeHistory',phase='P2',tables=['execution.history_heads','execution.history_entries','execution.outputs'],
   params=[query('page',integer(1)),query('size',integer(1,maximum=20)),query('knownRevision',REV)])
op('/projects/{id}/nodes/{nodeId}/history/{outputId}','delete','domainDeleteNodeOutput','删除输出并确定fallback','HistoryMutation',phase='P2',
   tables=['execution.history_heads','execution.history_entries'],etag=True,
   description='If-Match引用节点history_head.revision；冲突412，删除后返回fallbackOutputId，前端据此更新节点并通过原snapshot保存；不直接删除物理文件。')
op('/media-jobs','post','domainMediaJob','FFmpeg处理任务','Task','MediaJobInput',phase='P2',tables=['execution.tasks','execution.plans','execution.outputs'],idem=True,status=202)
op('/sketch-runs','post','domainSketchRun','画板固定源图生成','Task','SketchInput',phase='P2',tables=['execution.tasks','execution.plans','execution.outputs'],idem=True,status=202)
op('/conversations','get','domainConversations','真实对话列表','Conversation',phase='P2',page=True,tables=['assistant.conversations'],params=[query('projectId',ID),query('hfProjectId',ID)])
op('/conversations','post','domainCreateConversation','创建会话','Conversation','ConversationCreate',phase='P2',tables=['assistant.conversations'],idem=True)
op('/conversations/{id}','delete','domainDeleteConversation','软删除会话','Acknowledgement',phase='P2',tables=['assistant.conversations'],etag=True)
op('/conversations/{id}/messages','get','domainMessages','消息分页','Message',phase='P2',page=True,tables=['assistant.messages'])
op('/conversations/{id}/runs','post','domainChat','提交消息并创建Agent运行','AssistantRun','ChatInput',phase='P2',
   tables=['assistant.conversations','assistant.messages','assistant.runs','platform.outbox'],idem=True,status=202)
op('/assistant-runs/{id}','get','domainAssistantRun','Agent状态与待处理工具','AssistantRun',phase='P2',tables=['assistant.runs','assistant.tool_calls'])
op('/assistant-runs/{id}/events','get','domainAssistantEvents','可重连对话事件流',phase='P2',tables=['assistant.events'],stream=True,
   params=[{'$ref':'#/components/parameters/LastEventId'}])
op('/assistant-runs/{id}/cancel','post','domainCancelAssistant','停止Agent','AssistantRun','CancelInput',phase='P2',tables=['assistant.runs','assistant.tool_calls'],idem=True,status=202)
op('/assistant-runs/{id}/tool-calls/{callId}/result','post','domainToolResult','客户端工具回执','AssistantRun','ToolResult',phase='P2',
   tables=['assistant.runs','assistant.tool_calls'],idem=True,status=200,
   description='校验owner、run/call关联、当前PENDING状态和期限；重复同回执幂等，不允许客户端宣告任意服务端工具成功。')
op('/model-uploads','post','domainModelUpload','多文件3D上传授权','ModelUpload','ModelUploadInput',phase='P3',tables=['media.model_assets','media.model_files','media.model_uploads'],idem=True)
op('/model-uploads/{id}/complete','post','domainCompleteModelUpload','校验完整模型manifest','ModelAsset','UploadComplete',phase='P3',tables=['media.model_assets','media.model_files','media.model_uploads','media.blobs'],idem=True,status=202)
op('/model-uploads/{id}/renew','post','domainRenewModelUpload','续期模型上传授权','ModelUpload',phase='P3',tables=['media.model_uploads'],idem=True,status=200)
op('/model-assets','get','domainModelAssets','本人3D资产分页','ModelAsset',phase='P3',page=True,tables=['media.model_assets','media.model_files'])
op('/model-assets/{id}','get','domainModelAsset','本人3D资产详情','ModelAsset',phase='P3',tables=['media.model_assets','media.model_files'])
op('/model-assets/{id}','delete','domainDeleteModelAsset','无引用的模型资产软删','Acknowledgement',phase='P3',tables=['media.model_assets','canvas.media_refs','library.item_media_refs'],etag=True)
op('/model-assets/{id}/download','get','domainModelDownload','本人模型文件下载授权','Download',phase='P3',tables=['media.model_assets','media.model_files','media.blobs'],params=[query('path',string(1024),True)])
op('/blob-uploads','post','domainBlobUpload','Skill附件或HF文件上传授权','BlobUpload','BlobUploadInput',phase='P1',
   tables=['media.blob_uploads','media.blobs'],idem=True,
   description='HF必须提供本人hfProjectId；SKILL仅供本人的Skill写入。READY receipt与owner/purpose绑定，不以裸blobId或任意URL获得权限。')
op('/blob-uploads/{id}/complete','post','domainBlobUploadComplete','校验附件内容并完成','BlobReceipt','UploadComplete',phase='P1',tables=['media.blob_uploads','media.blobs'],idem=True,status=200)
op('/blob-uploads/{id}/renew','post','domainBlobUploadRenew','续期附件上传授权','BlobUpload',phase='P1',tables=['media.blob_uploads'],idem=True,status=200)
op('/skills/{id}/files/download','get','domainSkillFileDownload','可见技能文件下载','Download',phase='P1',tables=['catalog.resources','catalog.skill_files','media.blobs'],params=[query('path',string(1024),True),query('version',string(200))])
op('/hf-projects','get','domainHfProjects','HyperFrames工程分页','HfProject',phase='P3',page=True,tables=['studio.hf_projects'])
op('/hf-projects','post','domainCreateHf','新建HyperFrames工程','HfProject','HfCreate',phase='P3',tables=['studio.hf_projects'],idem=True)
op('/hf-projects/{id}','get','domainReadHf','HyperFrames工程','HfProject',phase='P3',tables=['studio.hf_projects'])
op('/hf-projects/{id}','patch','domainUpdateHf','HyperFrames改名','HfProject','HfPatch',phase='P3',tables=['studio.hf_projects'],etag=True)
op('/hf-projects/{id}','delete','domainDeleteHf','HyperFrames软删除','Acknowledgement',phase='P3',tables=['studio.hf_projects'],etag=True)
op('/hf-projects/{id}/files','get','domainHfFiles','服务器文件目录','HfFile',phase='P3',page=True,tables=['studio.hf_files'])
op('/hf-projects/{id}/files/content','get','domainHfFile','读取服务器文件','HfFile',phase='P3',tables=['studio.hf_files','media.blobs'],params=[query('path',string(1024),True)],
   description='返回文件元信息，正文/二进制通过专用鉴权下载投影；前端兼容studio-api GET files可返回文本，不能把blobId当下载权限。')
op('/hf-projects/{id}/files/content','put','domainWriteHfFile','保存文本文件','HfFile','HfFileWrite',phase='P3',tables=['studio.hf_files','media.blobs','platform.outbox'],params=[query('path',string(1024),True)],etag=True)
op('/hf-projects/{id}/files/content','delete','domainDeleteHfFile','删除文件','Acknowledgement',phase='P3',tables=['studio.hf_files'],params=[query('path',string(1024),True)],etag=True)
op('/hf-projects/{id}/files/bind','post','domainHfFileBinding','完成上传文件入HF目录','HfFile','HfFileBinding',phase='P3',tables=['studio.hf_files','studio.hf_events','media.blob_uploads','media.blobs'],idem=True,
   description='省略expectedRevision仅创建新路径；替换提供该文件revision，冲突412。校验uploadId属于本人、purpose=HF且hfProjectId相同，归一化相对路径并拒绝逃逸/大小写碰撞。')
op('/hf-projects/{id}/files/download','get','domainHfFileDownload','HF文件正文下载','Download',phase='P3',tables=['studio.hf_files','media.blobs'],params=[query('path',string(1024),True)])
op('/hf-projects/{id}/renders','get','domainHfRenders','渲染历史','HfRender',phase='P3',page=True,tables=['studio.hf_renders'])
op('/hf-projects/{id}/renders','post','domainRenderHf','冻结文件revision后渲染','HfRender','HfRenderInput',phase='P3',tables=['studio.hf_revisions','studio.hf_revision_files','studio.hf_renders'],etag=True,idem=True,status=202)
op('/hf-projects/{id}/renders/{renderId}','get','domainHfRender','渲染状态和授权下载','HfRender',phase='P3',tables=['studio.hf_renders','media.blobs'])
op('/hf-projects/{id}/renders/{renderId}/cancel','post','domainCancelHfRender','请求停止渲染','HfRender','CancelInput',phase='P3',tables=['studio.hf_renders'],idem=True,status=202)
op('/hf-projects/{id}/renders/{renderId}','delete','domainDeleteHfRender','软删除渲染历史','Acknowledgement',phase='P3',tables=['studio.hf_renders'],etag=True)
op('/hf-projects/{id}/events','get','domainHfEvents','工程文件与渲染事件',phase='P3',tables=['studio.hf_events'],stream=True,
   params=[{'$ref':'#/components/parameters/LastEventId'}],description='专用持久SSE；outbox不直接当客户端eventlog。Last-Event-ID只在本工程作用域重放；过期410 EVENT_CURSOR_EXPIRED。')
op('/director-projects','get','domainDirectorProjects','独立导演工程分页','DirectorProject',phase='P3',page=True,tables=['studio.director_projects'],params=[query('type',enum('2D','3D'))])
op('/director-projects','post','domainCreateDirector','创建独立导演工程','DirectorProject','DirectorCreate',phase='P3',tables=['studio.director_projects'],idem=True)
op('/director-projects/{id}','get','domainReadDirector','导演工程详情','DirectorProject',phase='P3',tables=['studio.director_projects'])
op('/director-projects/{id}','put','domainSaveDirector','保存导演工程','DirectorProject','DirectorPatch',phase='P3',tables=['studio.director_projects'],etag=True)
op('/director-projects/{id}','delete','domainDeleteDirector','软删除导演工程','Acknowledgement',phase='P3',tables=['studio.director_projects'],etag=True)
op('/director-models','get','domainDirectorModels','个人导演模型库','DirectorModel',phase='P3',page=True,tables=['studio.director_models'])
op('/director-models','post','domainCreateDirectorModel','模型资产入导演库','DirectorModel','DirectorModelCreate',phase='P3',tables=['studio.director_models','media.model_assets'],idem=True)
op('/director-models/{id}','delete','domainDeleteDirectorModel','导演模型库删除','Acknowledgement',phase='P3',tables=['studio.director_models'],etag=True)

DOC={'openapi':'3.1.1','jsonSchemaDialect':'https://json-schema.org/draft/2020-12/schema',
     'info':{'title':'Studio TV DDD domain extension (DESIGN)','version':'0.1.0',
             'description':'数据库蓝图后定义的独立v2设计合同。全部PROPOSED/RESERVED，未加载现有服务器；现未知路径404，注册后未实现501。沿用v1认证与tv.access，无工作空间。'},
     'servers':[{'url':'/api/v2'}], 'security':[{'BearerAuth':[]}],
     'x-design-status':'PROPOSED','x-implementation-stage':'RESERVED',
     'x-frozen-core-sha256':{f:hashlib.sha256((C/f).read_bytes()).hexdigest() for f in ['openapi.json','openapi.yaml']},
     'paths':P,'components':{'schemas':S,'parameters':PARAMS,
        'securitySchemes':{'BearerAuth':{'type':'http','scheme':'bearer','bearerFormat':'JWT'}},
        'responses':{'Error':{'description':'沿用v1错误包；所有访问校验owner和实时tv.access。',
          'content':{'application/json':{'schema':ref('Error')}}}}}}

if __name__ == '__main__':
    (C/'domain-extension.json').write_text(json.dumps(DOC,ensure_ascii=False,indent=2)+'\n')
    (C/'domain-extension.yaml').write_text(yaml.safe_dump(DOC,allow_unicode=True,sort_keys=False))
    print(f'{len(P)} paths, {sum(len(v) for v in P.values())} proposed operations, {len(S)} schemas')
