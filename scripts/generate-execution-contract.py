#!/usr/bin/env python3
"""Generate the independent implemented product execution protocol."""
import json,re
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
text={'type':'string','minLength':1,'maxLength':200};rev={'type':'integer','minimum':1};timestamp={'type':'string','format':'date-time'};bools={'type':'boolean'};nullable={'anyOf':[text,{'type':'null'}]};state={'enum':['QUEUED','RUNNING','WAITING_TOOL','SUCCEEDED','FAILED','CANCELED']}
def obj(props,required=None):return {'type':'object','additionalProperties':False,'properties':props,'required':required or list(props)}
def ref(name):return {'$ref':'#/components/schemas/'+name}
def array(schema,max=None):return {'type':'array','items':schema,**({'maxItems':max} if max else {})}
base={'id':text,'type':{'enum':['TEXT','ASSET','STRUCTURED']},'testMode':bools,'deletedAt':timestamp}
output=obj({**base,'text':{'type':'string'},'assetId':text,'mimeType':text,'width':rev,'height':rev,'durationMs':rev,'schemaVersion':text,'data':{}},['id','type','testMode'])
output['allOf']=[{'if':{'properties':{'type':{'const':kind}}},'then':{'required':fields}}for kind,fields in [('TEXT',['text']),('ASSET',['assetId','mimeType']),('STRUCTURED',['schemaVersion','data'])]]
binding=obj({'applicationState':{'enum':['PENDING','APPLIED','DETACHED']},'reason':text},['applicationState'])
binding['description']='Server-owned application receipt. PENDING awaits application, APPLIED includes terminal failure/cancellation state application, and DETACHED preserves execution history without overwriting current canvas content. No input guard, node version, owner or provider evidence is public.'
plan=obj({'nodeId':text,'executionId':text,'state':state,'capabilityRef':text,'capabilityVersion':text,'parameters':{'type':'object'},'outputs':array(ref('Output')),'errorCode':text,'nodeSnapshot':{'type':'object'},'testMode':bools,'historyDeletedAt':timestamp,'canvasBinding':{**ref('CanvasBinding'),'readOnly':True}},['nodeId','executionId','state','capabilityRef','capabilityVersion','parameters','outputs','testMode'])
task=obj({'id':text,'projectId':nullable,'conversationId':text,'messageId':text,'kind':{'enum':['CANVAS','ASSISTANT','MEDIA','SKETCH','STUDIO']},'targetType':text,'targetId':text,'name':{'type':'string'},'state':state,'revision':rev,'plans':array(ref('Plan'),500),'testMode':bools,'snapshot':{'type':'object'},'runtimeMetadata':{'type':'object'},'errorCode':text,'createdAt':timestamp,'updatedAt':timestamp,'canvasManaged':{**bools,'readOnly':True,'description':'True only for server-accepted opt-in single basic-node canvas writeback. Absent or false identifies the existing execution path; graph display fields do not supply this authority.'}},['id','projectId','kind','targetType','targetId','name','state','revision','plans','testMode','createdAt','updatedAt'])
for view in (plan,task):view['properties']['errorMessage']={'type':'string','minLength':1,'maxLength':4096,'readOnly':True,'description':'Optional server-authored media specification error with actual limits and recovery guidance. Never contains a prompt, signed URL, credential or raw provider response.'}
task['allOf']=[{'if':{'properties':{'canvasManaged':{'const':True}},'required':['canvasManaged']},'then':{'properties':{'kind':{'const':'CANVAS'},'targetType':{'const':'NODE'},'projectId':text,'plans':{'minItems':1,'maxItems':1,'items':{'required':['canvasBinding'],'properties':{'state':{'enum':['QUEUED','RUNNING','SUCCEEDED','FAILED','CANCELED']}}}}}},'else':{'properties':{'plans':{'items':{'not':{'required':['canvasBinding']}}}}}}]
history=obj({'id':text,'taskId':text,'executionId':text,'nodeId':text,'projectId':nullable,'outputs':array(ref('Output')),'paramsSnapshot':{'type':'object'},'nodeConfigSnapshot':{'anyOf':[{'type':'object'},{'type':'null'}]},'createdAt':timestamp,'testMode':bools,'revision':rev})
event=obj({'sequence':rev,'type':text,'data':{'type':'object'},'observedAt':timestamp,'testMode':bools})
schemas={'Output':output,'CanvasBinding':binding,'Plan':plan,'Task':task,'History':history,'Event':event,'EventPage':obj({'items':array(ref('Event'),100),'nextCursor':{'anyOf':[{'type':'string','pattern':'^[0-9]+$'},{'type':'null'}]},'terminal':bools,'schemaVersion':{'const':'1'}}),'HistoryPage':obj({'records':array(ref('History'),100),'page':rev,'size':{'type':'integer','minimum':1,'maximum':100},'total':{'type':'integer','minimum':0},'hasNext':bools,'revision':{'type':'integer','minimum':0}})}
paths={}
error=obj({'code':text,'message':{'type':'string'},'requestId':{'type':'string'},'retryable':bools,'details':array({})},['code','message','requestId','retryable','details']);schemas['Error']=error
counter=0
def operation(method,path,body=None,response=None,status='200',key=False,etag=False,query=()):
 global counter
 counter+=1;params=[{'name':name,'in':'path','required':True,'schema':text}for name in re.findall(r'{([^}]+)}',path)]
 params +=[{'name':name,'in':'query','required':False,'schema':schema}for name,schema in query]
 if key:params.append({'name':'Idempotency-Key','in':'header','required':True,'schema':{'type':'string','format':'uuid'}})
 if etag:params.append({'name':'If-Match','in':'header','required':True,'schema':{'type':'string','pattern':'^"[1-9][0-9]*"$'}})
 envelope=obj({'code':{'const':0},'message':{'const':'OK'},'requestId':{'type':'string'},'data':response or {}},['code','message','requestId','data'])
 responses={status:{'description':'Actual persisted product result','headers':{'ETag':{'schema':{'type':'string'}}},'content':{'application/json':{'schema':envelope}}}}
 for code in ['400','401','403','404','409','412','413','415','422','428','501','503']:responses[code]={'description':'Typed failure; no fake product success','content':{'application/json':{'schema':ref('Error')}}}
 op={'operationId':'productExecution'+str(counter),'x-implementation-status':'IMPLEMENTED','x-required-capability':'tv.access','security':[{'bearerAuth':[]}],'parameters':params,'responses':responses}
 if body is not None:op['requestBody']={'required':True,'content':{'application/json':{'schema':body}}}
 paths.setdefault(path,{})[method]=op
canvas=obj({'projectId':text,'targetType':{'enum':['NODE','GROUP','CANVAS']},'targetId':{'type':'string','maxLength':200},'graph':obj({'nodes':array({'type':'object'},500),'edges':array(obj({'source':text,'target':text}),2000)}),'name':{'type':'string','maxLength':400},'executionKey':{'type':'string'},'expectedRevision':{'type':'integer','minimum':1,'maximum':9223372036854775807,'description':'Optional opt-in to server writeback. Must equal the owner-scoped persisted project revision whose target/input closure matches this frozen graph. Valid only for targetType NODE with one selected rh-text/rh-image/rh-video/rh-audio plan; upstream nodes may still be present. Missing, changed or recreated inputs are rejected. Omit for existing group/canvas/script/storyboard/APP execution paths.'}},['projectId','targetType','targetId','graph'])
canvas['allOf']=[{'if':{'required':['expectedRevision']},'then':{'properties':{'targetType':{'const':'NODE'},'targetId':text}}}]
operation('post','/api/v2/canvas-runs',canvas,ref('Task'),'202',key=True)
paths['/api/v2/canvas-runs']['post']['description']='expectedRevision opts one basic NODE run into an atomic server-owned binding, task state and result-writeback decision. The project revision and event cursor advance in the same transaction, so execution survives page closure; a changed, deleted, recreated or superseded node cannot be overwritten by an old result. Successful task completion and result application are distinct: inspect canvasBinding.applicationState, then refresh the consistent live-snapshot. Existing requests without expectedRevision retain their established execution path. This does not enable an Agent tool loop or arbitrary group/APP/script/storyboard result mutation.'
paths['/api/v2/canvas-runs']['post']['responses']['409']['description']='VERSION_OR_IDEMPOTENCY_CONFLICT: expectedRevision or the frozen input closure differs from the current project, or the idempotency key belongs to a different request. No new binding or canvas overwrite is committed.'
app=obj({'projectId':text,'nodeId':text,'appId':text,'appRevision':rev,'inputNodes':array(obj({'nodeId':text,'fieldName':text,'fieldValue':{}}),200),'capabilityRef':text,'capabilityVersion':text,'parameters':{'type':'object'}})
operation('post','/api/v2/app-runs',app,ref('Task'),'202',key=True)
for prefix in ['/api/v2/tasks','/api/v2/assistant-runs','/api/v2/assistant/conversations/{cid}/runs']:
 operation('get',prefix+'/{id}',response=ref('Task'));operation('get',prefix+'/{id}/events',response=ref('EventPage'),query=[('after',{'type':'string','pattern':'^[0-9]+$'})]);operation('post',prefix+'/{id}/cancel',obj({}),ref('Task'),'202')
operation('get','/api/v2/assistant/conversations/{cid}/runs',response=obj({'records':array(ref('Task'),2)}),query=[('state',{'const':'active'})])
paths['/api/v2/assistant/conversations/{cid}/runs']['get']['parameters'][-1]['required']=True
run=obj({'capabilityRef':text,'capabilityVersion':text,'messageId':text,'parameters':{'type':'object'}})
for path in ['/api/v2/conversations/{cid}/runs','/api/v2/assistant/conversations/{cid}/runs']:operation('post',path,run,ref('Task'),'202',key=True)
operation('post','/api/v2/tasks/batch-status',obj({'ids':array(text,100),'includeResults':bools},['ids']),obj({'tasks':array(ref('Task'),100)}))
operation('get','/api/v2/history',response=ref('HistoryPage'),query=[(k,text)for k in ['projectId','nodeId','type']]+[(k,rev)for k in ['page','size']])
operation('get','/api/v2/history/{eid}',response=ref('History'))
operation('post','/api/v2/history/delete',obj({'ids':{**array(text,100),'minItems':1,'uniqueItems':True}}),obj({'deletedIds':array(text,100)}),key=True)
operation('delete','/api/v2/history/{eid}/outputs/{oid}',response=ref('Task'),etag=True)
operation('post','/api/v2/hf/conversations/{cid}/agent',obj({}),obj({'agentId':text}),'201',key=True)
operation('post','/api/v2/hf/conversations/{cid}/runs',obj({'agentId':text,'message':{'type':'string','minLength':1,'maxLength':200000},'previousResponseId':text},['agentId','message']),ref('Task'),'202',key=True)
doc={'openapi':'3.1.0','info':{'title':'Studio TV Product Execution Extension','version':'1.1.0','description':'Durable product tasks and private history, with opt-in server writeback for one basic canvas NODE. Model execution requires an explicitly enabled configured capability; TEST MODE remains explicit. Media jobs and actual Studio rendering use media-extension. Credentials/native Router IDs and private node guards are not public. Task receipts survive restarts; owner derives from IPAC login + tv.access. Full Agent tool execution remains unavailable.'},'paths':paths,'components':{'securitySchemes':{'bearerAuth':{'type':'http','scheme':'bearer'}},'schemas':schemas}}
raw=json.dumps(doc,ensure_ascii=False,indent=2)+'\n'
for suffix in ['json','yaml']:(ROOT/'contracts'/('execution-extension.'+suffix)).write_text(raw)
print(counter,'implemented execution operations')
