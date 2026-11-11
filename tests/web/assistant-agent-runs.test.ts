import {afterEach,expect,it,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {AssistantAdapter,type AssistantRun} from '../../apps/web/src/service/assistant';
import {ProductClient} from '../../apps/web/src/service/product-client';
import {modelSelections} from '../../apps/web/src/service/model-catalog';

const at='2026-10-06T08:00:00.000Z';
const conversation=(kind='CANVAS')=>({id:'cnv',revision:3,kind,projectId:kind==='CANVAS'?'project':null,title:'Saved conversation',createdAt:at,updatedAt:at});
const message=(id:string,role='USER',text='Persisted request')=>({id,conversationId:'cnv',seq:id==='user'?1:2,role,content:[{type:'TEXT',text}],createdAt:at});
const capability={capabilityRef:'codex-6-1-text-v1',version:'2',kind:'LLM',executionKind:'AGENT',available:true,testMode:false,inputKinds:['TEXT','STRUCTURED'],outputKinds:['TEXT'],model:{providerRef:'codex',modelRef:'gpt-6.1-sol',title:'Codex',version:'6.1'}};
const discovery=(enabled=true)=>({enabled,version:'1',toolExecutionAvailable:enabled,capabilities:enabled?[{capabilityRef:capability.capabilityRef,capabilityVersion:capability.version,version:capability.version,parameterSchemaVersion:'2',parameterSchema:{type:'object',properties:{reasoningEffort:{type:'string',enum:['low','high'],default:'low'}},additionalProperties:false},inputKinds:['TEXT'],historyTextOnly:true}]:[]});
const run=(state='RUNNING',extra:any={}):AssistantRun=>({id:'agr',kind:'AGENT',conversationId:'cnv',projectId:'project',messageId:'user',state,credentialEpoch:'1',assistantMessageId:state==='SUCCEEDED'?'reply':null,...extra});
const reply=message('reply','ASSISTANT','Verified saved reply');
const response=(data:any,status=200,etag?:string)=>new Response(JSON.stringify({code:0,data}),{status,headers:etag?{ETag:etag}:{}});
const error=(status:number,code:string)=>new Response(JSON.stringify({code,message:code}),{status});
function setup(handler:(url:URL,init:RequestInit,body:any)=>Response|Promise<Response>){
 const transport=vi.fn(async(input:any,init:RequestInit={})=>handler(new URL(String(input),'https://studio.invalid'),init,init.body?JSON.parse(String(init.body)):undefined));
 const api=new ProductClient('/api/v1',transport);api.setAccessToken('same-session-token');return{api,transport,adapter:new AssistantAdapter(api)};
}
const input={session_id:'cnv',message:'Arrange this canvas',metadata:{chat_mode:'agent'}};
const flush=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};
afterEach(()=>{vi.useRealTimers();modelSelections.clear();});

it('starts only the enabled original CANVAS Agent from a persisted message and saved server revision',async()=>{
 const writes:string[]=[],barrier=vi.fn(async()=>()=>{});
 const {api,transport}=setup((url,init,body)=>{
  if(url.pathname==='/api/v2/conversations/cnv')return response(conversation(),200,'"3"');
  if(url.pathname==='/api/v2/agent-capabilities')return response(discovery());
  if(url.pathname==='/api/v2/model-capabilities')return response({items:[capability]});
  if(url.pathname==='/api/v2/projects/project/live-snapshot')return response({projectId:'project',graphRevision:7});
  if(url.pathname.endsWith('/messages')){if(!init.method)return response({records:[],hasNext:false});writes.push(url.pathname);expect(body).toEqual({content:[{type:'TEXT',text:'Arrange this canvas'}]});expect(new Headers(init.headers).get('If-Match')).toBe('"3"');return response(message('user'),201);}
  expect(url.pathname).toBe('/api/v2/conversations/cnv/agent-runs');writes.push(url.pathname);expect(body).toEqual({messageId:'user',capabilityRef:capability.capabilityRef,capabilityVersion:'2',parameters:{reasoningEffort:'high'},expectedRevision:7});expect(new Headers(init.headers).get('Authorization')).toBe('Bearer same-session-token');return response(run('QUEUED'),202);
 });
 const adapter=new AssistantAdapter(api,{beforeCanvasRun:barrier});expect(await adapter.start({...input,parameters:{reasoningEffort:'high'}})).toMatchObject({message:{id:'user'},run:{kind:'AGENT',id:'agr'}});
 expect(barrier).toHaveBeenCalledWith('project',expect.any(AbortSignal));expect(writes).toEqual(['/api/v2/conversations/cnv/messages','/api/v2/conversations/cnv/agent-runs']);expect(transport.mock.calls.some(([path])=>String(path).includes('/assistant/'))).toBe(false);
});

it('uses enabled direct discovery for the native Agent default even when the Router catalog is unavailable',async()=>{
 const {adapter,transport}=setup((url,init,body)=>{
  if(url.pathname==='/api/v2/conversations/cnv')return response(conversation());
  if(url.pathname==='/api/v2/agent-capabilities')return response(discovery());
  if(url.pathname.includes('model-capabilit'))return error(503,'MODEL_GATEWAY_UNAVAILABLE');
  if(url.pathname.endsWith('live-snapshot'))return response({projectId:'project',graphRevision:7});
  if(url.pathname.endsWith('/messages'))return response(init.method?message('user'):{records:[message('older')],hasNext:false});
  expect(url.pathname).toBe('/api/v2/conversations/cnv/agent-runs');expect(body).toEqual({messageId:'user',capabilityRef:'codex-6-1-text-v1',capabilityVersion:'2',parameters:{reasoningEffort:'low'},expectedRevision:7});return response(run('QUEUED'),202);
 });
 modelSelections.set('assistant:LLM',{capabilityRef:'old-router-model',capabilityVersion:'1',explicit:true});
 nativeCallbacks(adapter,nativeStore());
 await expect(adapter.start({session_id:'cnv',message:'Arrange this canvas',model:'original-vendor-label'})).resolves.toMatchObject({run:{kind:'AGENT',state:'QUEUED'}});
 expect(transport.mock.calls.some(([path])=>String(path).includes('model-capabilit')||String(path).includes('/assistant/'))).toBe(false);adapter.clear();
});

it('rejects unsupported exact direct choices and parameters before persisting a turn without Router fallback',async()=>{
 for(const [extra,code] of [[{capabilityRef:'old-router-model'},'MODEL_AGENT_UNSUPPORTED'],[{capabilityRef:capability.capabilityRef,capabilityVersion:'1'},'MODEL_VERSION_CHANGED'],[{parameters:{reasoningEffort:'ultra'}},'MODEL_PARAMETERS_INVALID'],[{parameters:{reasoning_effort:'high'}},'MODEL_PARAMETERS_INVALID'],[{parameters:{reasoningEffort:null}},'MODEL_PARAMETERS_INVALID'],[{parameters:[]},'MODEL_PARAMETERS_INVALID']] as const){
  const {adapter,transport}=setup(url=>{
   if(url.pathname==='/api/v2/conversations/cnv')return response(conversation());
   expect(url.pathname).toBe('/api/v2/agent-capabilities');return response(discovery());
  });
  await expect(adapter.start({...input,...extra})).rejects.toMatchObject({code});expect(transport.mock.calls.every(([,init])=>!init.method)).toBe(true);
 }
});

it('rejects an unrecognized enabled parameter protocol without persisting a turn or falling back',async()=>{
 const {adapter,transport}=setup(url=>{
  if(url.pathname==='/api/v2/conversations/cnv')return response(conversation());
  expect(url.pathname).toBe('/api/v2/agent-capabilities');const data=discovery();data.capabilities[0].parameterSchema.properties.reasoningEffort.default='high';return response(data);
 });
 await expect(adapter.start(input)).rejects.toMatchObject({code:'INVALID_RESPONSE'});expect(transport.mock.calls.every(([,init])=>!init.method)).toBe(true);
});

it('honors the discovered text-only input contract before writing a direct turn',async()=>{
 const {adapter,transport}=setup(url=>{
  if(url.pathname==='/api/v2/conversations/cnv')return response(conversation());
  if(url.pathname==='/api/v1/assets/saved-image')return response({id:'saved-image',state:'READY',kind:'IMAGE'});
  if(url.pathname==='/api/v2/agent-capabilities')return response(discovery());
  throw new Error('Unexpected request: '+url.pathname);
 });
 await expect(adapter.start({...input,content:[{type:'ASSET',assetId:'saved-image'}]})).rejects.toMatchObject({code:'MODEL_INPUT_UNSUPPORTED'});expect(transport.mock.calls.every(([,init])=>!init.method)).toBe(true);
});

it('reports direct acceptance failures without submitting a legacy model request',async()=>{
 const {adapter,transport}=setup((url,init)=>{
  if(url.pathname==='/api/v2/conversations/cnv')return response(conversation());
  if(url.pathname.endsWith('agent-capabilities'))return response(discovery());
  if(url.pathname.endsWith('model-capabilities'))return response({items:[capability]});
  if(url.pathname.endsWith('live-snapshot'))return response({projectId:'project',graphRevision:7});
  if(url.pathname.endsWith('/messages'))return response(init.method?message('user'):{records:[],hasNext:false});
  expect(url.pathname).toBe('/api/v2/conversations/cnv/agent-runs');return error(503,'AGENT_RUNTIME_UNAVAILABLE');
 });
 await expect(adapter.start(input)).rejects.toMatchObject({status:503,code:'AGENT_RUNTIME_UNAVAILABLE'});expect(transport.mock.calls.some(([path])=>String(path).includes('/assistant/'))).toBe(false);
});

it('projects direct failure, timeout and unknown states as native errors without a successful final reply',async()=>{
 for(const route of ['/api/v1/chat/stream','/canvas/openclaw/chat'])for(const state of ['FAILED','TIMED_OUT','UNKNOWN']){
  const {adapter}=setup((url,init)=>{
   if(url.pathname==='/api/v2/conversations/cnv')return response(conversation());
   if(url.pathname.endsWith('agent-capabilities'))return response(discovery());
   if(url.pathname.endsWith('live-snapshot'))return response({projectId:'project',graphRevision:7});
   if(url.pathname.endsWith('/messages')){expect(init.method).toBe('POST');return response(message('user'));}
   if(url.pathname.endsWith('/agent-runs'))return response(run('RUNNING'),202);
   if(url.pathname.endsWith('/auth-context'))return response(run('RUNNING'));
   if(url.pathname.endsWith('/events'))return response({items:[{runId:'agr',sequence:'1',type:'tool.failed',data:{callId:'operation',toolName:'studio_canvas_patch',success:false}}],nextCursor:'1',terminal:true});
   expect(url.pathname).toBe('/api/v2/agent-runs/agr');return response(run(state,{errorCode:'REAL_'+state,errorMessage:'Actual '+state}));
  });
  const text=await (await adapter.stream(route,input))!.text();
  const expected=state==='UNKNOWN'?'本次执行结果尚未确认，请先核对画布和任务状态。':'Actual '+state;
  expect(text).toContain(expected);expect(text).not.toContain('Verified saved reply');expect(text).not.toContain('event: chat.final');expect(text).not.toContain('[DONE]');
  if(route==='/api/v1/chat/stream')expect(text.replace(/\u001e[^\n]*\n/g,'').trim()).toBe('[error] '+expected);else expect(text).toContain('event: chat.error');
 }
});

it('keeps unverified execution results as failures without advising a blind retry',async()=>{
 for(const [state,errorCode] of [['UNKNOWN','AGENT_RUNTIME_FAILURE'],['FAILED','RUNTIME_RESULT_UNVERIFIED']]){
  const {adapter,transport}=setup(url=>{expect(url.pathname).toBe('/api/v2/agent-runs/agr/events');return response({items:[],terminal:true});}),updates:any[]=[];
  await expect(adapter.watch({conversationId:'cnv',message:message('user'),run:run(state,{errorCode,errorMessage:'Agent 服务处理失败，请重试当前步骤。'})},update=>updates.push(update))).rejects.toMatchObject({status:502,code:errorCode,message:'本次执行结果尚未确认，请先核对画布和任务状态。'});
  expect(updates).toEqual([]);expect(transport).toHaveBeenCalledOnce();expect(transport.mock.calls.every(([,init])=>!init.method)).toBe(true);
 }
});

it('keeps media modes and GLOBAL conversations on their existing protocol without Agent discovery',async()=>{
 for(const [kind,mode] of [['CANVAS','image'],['CANVAS','video'],['CANVAS','motion'],['GLOBAL','agent']]){
  const {adapter,transport}=setup((url,init)=>{
   if(url.pathname==='/api/v2/conversations/cnv')return response(conversation(kind));
   if(url.pathname.endsWith('model-capabilities'))return response({items:[capability]});
   if(url.pathname.endsWith('/messages'))return response(init.method?message('user'):{records:[],hasNext:false});
   expect(url.pathname).toBe('/api/v2/assistant/conversations/cnv/runs');return response({id:'legacy',state:'RUNNING'},202);
  });
  await adapter.start({...input,metadata:{chat_mode:mode}});expect(transport.mock.calls.some(([path])=>String(path).includes('agent-capabilities'))).toBe(false);
 }
});

it('projects only real tool notices and the persisted verified reply into the existing native rich stream',async()=>{
 const actual=run('RUNNING'),events=[{runId:'agr',sequence:'1',type:'tool.started',data:{callId:'operation',toolName:'studio_canvas_patch'}},{runId:'agr',sequence:'2',type:'tool.completed',data:{callId:'operation',toolName:'studio_canvas_patch',success:true}},{runId:'agr',sequence:'3',type:'message.delta',data:{text:'Verified saved reply',snapshot:true,messageId:'reply'}}];
 const {adapter,transport}=setup((url,init)=>{
  if(url.pathname==='/api/v2/conversations/cnv')return response(conversation());
  if(url.pathname.endsWith('agent-capabilities'))return response(discovery());
  if(url.pathname.endsWith('model-capabilities'))return response({items:[capability]});
  if(url.pathname.endsWith('live-snapshot'))return response({projectId:'project',graphRevision:7});
  if(url.pathname.endsWith('/messages'))return response(init.method?message('user'):{records:[message('user'),reply],hasNext:false});
  if(url.pathname.endsWith('/agent-runs'))return response(actual,202);
  if(url.pathname.endsWith('/auth-context')){expect(init.body).toBe('{}');return response(actual);}
  if(url.pathname.endsWith('/events'))return response({items:events,nextCursor:'3',terminal:true});
  expect(url.pathname).toBe('/api/v2/agent-runs/agr');return response(run('SUCCEEDED'));
 });
 const stream=await adapter.stream('/api/v1/chat/stream',input),text=await stream!.text();
 expect(text).toContain('\u001e'+JSON.stringify({type:'agent_activity',activity:{schema:'runninghub.agent-activity.v1',id:'operation',tool_name:'studio_canvas_patch',kind:'canvas',label:'更新画布',status:'running'}})+'\n');expect(text).toContain('"status":"completed"');expect(text.endsWith('Verified saved reply')).toBe(true);
 expect(transport.mock.calls.filter(([,init])=>init.method).map(([path])=>String(path))).toEqual(['/api/v2/conversations/cnv/messages','/api/v2/conversations/cnv/agent-runs','/api/v2/agent-runs/agr/auth-context']);
});

it('drains final tool records when a direct run ends between its event page and detail read',async()=>{
 for(const state of ['UNKNOWN','SUCCEEDED']){
  const calls=[['read-one','studio_canvas_read'],['models','studio_model_list'],['read-two','studio_canvas_read'],['patch','studio_canvas_patch']],event=(sequence:number,type:string,call:number)=>({runId:'agr',sequence:String(sequence),type,data:{callId:calls[call][0],toolName:calls[call][1],...(type==='tool.completed'?{success:true}:{})}});
  const first=[event(1,'tool.started',0),event(2,'tool.completed',0),event(3,'tool.started',1),event(4,'tool.completed',1)],last=[event(5,'tool.started',2),event(6,'tool.completed',2),event(7,'tool.started',3),...(state==='SUCCEEDED'?[{runId:'agr',sequence:'8',type:'message.delta',data:{text:'Verified saved reply',snapshot:true,messageId:'reply'}}]:[]),{runId:'agr',sequence:state==='SUCCEEDED'?'9':'8',type:'run.state.changed',data:{state}}];
  let pages=0,details=0;
  const {adapter}=setup((url,init)=>{
   if(url.pathname==='/api/v2/conversations/cnv')return response(conversation());
   if(url.pathname.endsWith('agent-capabilities'))return response(discovery());
   if(url.pathname.endsWith('live-snapshot'))return response({projectId:'project',graphRevision:7});
   if(url.pathname.endsWith('/messages')){if(init.method)return response(message('user'));expect(pages).toBe(2);return response({records:[message('user'),reply],hasNext:false});}
   if(url.pathname.endsWith('/agent-runs'))return response(run('RUNNING'),202);
   if(url.pathname.endsWith('/auth-context'))return response(run('RUNNING'));
   if(url.pathname.endsWith('/events')){pages++;expect(url.searchParams.get('after')).toBe(pages===1?'0':'4');return response({items:pages===1?first:last,nextCursor:pages===1?'4':state==='SUCCEEDED'?'9':'8',terminal:pages===2});}
   expect(url.pathname).toBe('/api/v2/agent-runs/agr');details++;return response(run(state,{errorCode:'REAL_'+state}));
  });
  const text=await (await adapter.stream('/api/v1/chat/stream',input))!.text(),activities=[...text.matchAll(/\u001e([^\n]+)\n/g)].map(match=>JSON.parse(match[1]).activity),latest=new Map(activities.map(activity=>[activity.id,activity]));
  expect(pages).toBe(2);expect(details).toBe(1);expect([...latest.keys()]).toEqual(['read-one','models','read-two','patch']);expect(latest.get('read-two')).toMatchObject({label:'读取画布',status:'completed'});expect(latest.get('patch')).toMatchObject({label:'更新画布',status:'running'});
  if(state==='UNKNOWN'){expect(text).toContain('[error]');expect(text).not.toContain('Verified saved reply');}else expect(text.endsWith('Verified saved reply')).toBe(true);
 }
});

it('automatically recovers WAITING_FOR_AUTH through the shared login refresh and current credential CAS',async()=>{
 const {api,adapter,transport}=setup((url,init,body)=>{
  if(url.pathname.endsWith('/auth-context')){expect(init.method).toBe('PUT');expect(body).toEqual({});const headers=new Headers(init.headers);expect(headers.get('Authorization')).toBe('Bearer refreshed-same-session');expect(headers.get('If-Match')).toBe('"1"');return response(run('RUNNING',{credentialEpoch:'2'}));}
  if(url.pathname.endsWith('/events'))return response({items:[],terminal:true});
  if(url.pathname.endsWith('/messages'))return response({records:[message('user'),reply],hasNext:false});
  expect(url.pathname).toBe('/api/v2/agent-runs/agr');return response(run('SUCCEEDED',{credentialEpoch:'2'}));
 });
 const refresh=vi.fn(async()=>{api.setAccessToken('refreshed-same-session');return true;});api.onRefresh(refresh);const updates:any[]=[];
 await adapter.watch({conversationId:'cnv',message:message('user'),run:run('WAITING_FOR_AUTH')},update=>updates.push(update));expect(refresh).toHaveBeenCalledOnce();expect(updates.at(-1)).toMatchObject({type:'completed',text:'Verified saved reply'});expect(transport.mock.calls.every(([,init])=>!String(init.body||'').includes('token'))).toBe(true);
});

it('rereads a conflicting credential epoch only after a unified refresh and never replays the old credential',async()=>{
 let puts=0;
 const {api,adapter,transport}=setup((url,init)=>{
  if(url.pathname.endsWith('/auth-context')){
   if(init.method==='PUT'){puts++;const headers=new Headers(init.headers);expect(headers.get('Authorization')).toBe(puts===1?'Bearer same-session-token':'Bearer refreshed-same-session');expect(headers.get('If-Match')).toBe(puts===1?'"1"':'"3"');return puts===1?error(412,'VERSION_CONFLICT'):response(run('RUNNING',{credentialEpoch:'4'}));}
   expect(new Headers(init.headers).get('Authorization')).toBe('Bearer refreshed-same-session');return response(run('RUNNING',{credentialEpoch:'3'}));
  }
  if(url.pathname.endsWith('/events'))return response({items:[]});
  if(url.pathname.endsWith('/messages'))return response({records:[message('user'),reply],hasNext:false});
  return response(run('SUCCEEDED',{credentialEpoch:'4'}));
 });
 const refresh=vi.fn(async()=>{api.setAccessToken('refreshed-same-session');return true;});api.onRefresh(refresh);
 await adapter.watch({conversationId:'cnv',message:message('user'),run:run()},()=>{});expect(refresh).toHaveBeenCalledOnce();expect(puts).toBe(2);expect(transport.mock.calls.filter(([,init])=>init.method==='PUT')).toHaveLength(2);
});

it('resumes the exact direct run and preserves decimal event cursors beyond JavaScript integer precision',async()=>{
 const cursor='9007199254740993';let first=true;
 const {adapter,transport}=setup(url=>{
  if(url.pathname==='/api/v2/conversations/cnv')return response(conversation());
  if(url.pathname.endsWith('/messages'))return response({records:[message('user'),reply],hasNext:false});
  if(url.pathname.endsWith('/events')){expect(url.searchParams.get('after')).toBe(cursor);return response({items:[{runId:'agr',sequence:'9007199254740994',type:'message.delta',data:{text:'Verified saved reply',snapshot:true,messageId:'reply'}}],terminal:true});}
  if(url.pathname.endsWith('/auth-context'))return response(run());
  expect(url.pathname).toBe('/api/v2/agent-runs/agr');const current=first?run():run('SUCCEEDED');first=false;return response(current);
 });
 const started=await adapter.resume('cnv','agr',undefined,'AGENT'),updates:any[]=[];await adapter.watch(started,update=>updates.push(update),undefined,cursor);
 expect(updates[0]).toMatchObject({type:'delta',event:{sequence:'9007199254740994'}});expect(updates.at(-1)).toMatchObject({type:'completed',text:'Verified saved reply'});expect(transport.mock.calls.some(([,init])=>init.method==='POST')).toBe(false);
});

function nativeStore(sessionId='cnv'){
 const state:any={activeCanvasId:'project',gatewaySessionId:sessionId,currentChatMode:'agent',messages:[],addMessage:vi.fn(),setError:vi.fn(),setOrchestrationStep:vi.fn()};
 state.setLoading=vi.fn((value:boolean)=>state.isLoading=value);state.setStreaming=vi.fn((value:boolean)=>state.isStreaming=value);state.resetConversationState=vi.fn(()=>state.messages=[]);state.setGatewaySessionId=vi.fn((value:string)=>state.gatewaySessionId=value);state.setMessages=vi.fn((value:any[])=>state.messages=value);return state;
}
function nativeCallbacks(adapter:AssistantAdapter,state:any){
 const native={r:{useCallback:(callback:any,_dependencies:any[])=>callback}};adapter.installNative(native);
 const create=async()=>{throw new Error('createSession 需要画布 ID');state.setGatewaySessionId('never');};
 native.r.useCallback(create,[state,'project']);
 const fz=vi.fn(),load=native.r.useCallback(async(id:string)=>await fz({sessionId:id,shouldCommit:()=>true}),[vi.fn(),state,'project',null,null,null,null]);
 const stop=native.r.useCallback(()=>{return '_remakeBackgroundTaskId canvas.agent.session.cancelled';},[vi.fn(),state,vi.fn()]);
 return{native,load,stop};
}

// Exercise the pinned native parser and its outer error-key mapping, whose
// serviceFailed translation used to overwrite the bridge's UNKNOWN message.
function nativeErrorProtocol(){
 const source=readFileSync(new URL('../../apps/web/public/project/assets/CanvasEditorShell-Dt_89lTt.js',import.meta.url),'utf8'),functions=source.slice(source.indexOf('function RD('),source.indexOf('async function AD(')),projection=source.slice(source.indexOf('function Fp('),source.indexOf('const Yd=')),parser=source.slice(source.indexOf('async function AD('),source.indexOf('async function MD(')),start=source.indexOf('re=p.useCallback(async U=>')+'re=p.useCallback('.length,callback=source.slice(start,source.indexOf(',[i,e,r,A,j,n,H,T,E])',start));
 return runInNewContext(`${functions}${projection}${parser};({parse:AD,errorKey:Fp,callback:(${callback})})`,{TextDecoder,nr:'\0runninghub.invalid-client-tool-call.v1',Xc:()=>false});
}

it('preserves UNKNOWN through the actual frozen SDK parser and native service-failure projection',async()=>{
 const protocol=nativeErrorProtocol(),{adapter}=setup((url,init)=>{
  if(url.pathname==='/api/v2/conversations/cnv')return response(conversation());
  if(url.pathname.endsWith('agent-capabilities'))return response(discovery());
  if(url.pathname.endsWith('live-snapshot'))return response({projectId:'project',graphRevision:7});
  if(url.pathname.endsWith('/messages'))return response(message('user'));
  if(url.pathname.endsWith('/agent-runs'))return response(run('RUNNING'),202);
  if(url.pathname.endsWith('/auth-context'))return response(run('RUNNING'));
  if(url.pathname.endsWith('/events'))return response({items:[],terminal:true});
  return response(run('UNKNOWN',{errorCode:'RUNTIME_RESULT_UNVERIFIED'}));
 });
 const state=nativeStore(),added=state.addMessage,error=state.setError,{native}=nativeCallbacks(adapter,state);native.r.useCallback(protocol.callback,[state,'project',vi.fn(),null,null,null,null,null,null]);
 const stream=await adapter.stream('/api/v1/chat/stream',input);let failure:any;
 try{await protocol.parse(stream!.body!.getReader(),{onContent:vi.fn(),onStreamError:vi.fn()});}catch(caught){failure=caught;}
 expect(protocol.errorKey(failure)).toBe('canvas.agent.toast.serviceFailed');
 const generic='Agent 服务处理失败，请重试当前步骤。';state.setError(generic);state.addMessage({role:'assistant',content:generic,_local:true,_canRetry:true});
 expect(error).toHaveBeenLastCalledWith('本次执行结果尚未确认，请先核对画布和任务状态。');expect(added).toHaveBeenLastCalledWith({role:'assistant',content:'本次执行结果尚未确认，请先核对画布和任务状态。',_local:true,_canRetry:false});
 // The override is consumed by that error projection; another failure remains native.
 state.setError(generic);expect(error).toHaveBeenLastCalledWith(generic);adapter.clear();
});

it('does not carry an UNKNOWN native hint across conversation, canvas, login or turn changes',async()=>{
 for(const change of ['conversation','canvas','login','turn']){
  const protocol=nativeErrorProtocol(),{adapter}=setup((url,init)=>{
   if(url.pathname==='/api/v2/conversations/cnv')return response(conversation());
   if(url.pathname.endsWith('agent-capabilities'))return response(discovery());
   if(url.pathname.endsWith('live-snapshot'))return response({projectId:'project',graphRevision:7});
   if(url.pathname.endsWith('/messages'))return response(message('user'));
   if(url.pathname.endsWith('/agent-runs'))return response(run('RUNNING'),202);
   if(url.pathname.endsWith('/auth-context'))return response(run('RUNNING'));
   if(url.pathname.endsWith('/events'))return response({items:[],terminal:true});
   return response(run('UNKNOWN',{errorCode:'RUNTIME_RESULT_UNVERIFIED'}));
  });
  const state=nativeStore(),added=state.addMessage,error=state.setError,{native}=nativeCallbacks(adapter,state);native.r.useCallback(protocol.callback,[state,'project',vi.fn(),null,null,null,null,null,null]);
  await (await adapter.stream('/api/v1/chat/stream',input))!.text();
  if(change==='login')adapter.clear();else if(change==='turn')await adapter.start(input);else{
   const other=nativeStore(change==='conversation'?'other':'cnv');if(change==='canvas')other.activeCanvasId='other-project';
   const create=()=>{throw new Error('createSession 需要画布 ID');other.setGatewaySessionId('never');};native.r.useCallback(create,[other,other.activeCanvasId]);
  }
  const generic='Agent 服务处理失败，请重试当前步骤。';state.setError(generic);state.addMessage({role:'assistant',content:generic,_local:true,_canRetry:true});expect(error).toHaveBeenLastCalledWith(generic);expect(added).toHaveBeenLastCalledWith({role:'assistant',content:generic,_local:true,_canRetry:true});adapter.clear();
 }
});

it('discovers and recovers the actual active Agent on native reload without restarting a model or adding a local reply',async()=>{
 let reads=0,finished=false;
 const {adapter,transport}=setup((url,init)=>{
  if(url.pathname==='/api/v2/conversations/cnv')return response(conversation());
  if(url.pathname.endsWith('/messages'))return response({records:finished?[message('user'),reply]:[message('user')],hasNext:false});
  if(url.pathname.endsWith('agent-capabilities'))return response(discovery());
  if(url.pathname==='/api/v2/conversations/cnv/agent-runs'){expect(url.searchParams.get('state')).toBe('active');return response({records:[run()]});}
  if(url.pathname==='/api/v2/assistant/conversations/cnv/runs')return response({records:[]});
  if(url.pathname.endsWith('/auth-context')){expect(init.method).toBe('PUT');return response(run());}
  if(url.pathname.endsWith('/events'))return response({items:[{runId:'agr',sequence:'1',type:'tool.started',data:{callId:'call',toolName:'studio_canvas_read'}},{runId:'agr',sequence:'2',type:'message.delta',data:{text:'Verified saved reply',messageId:'reply',snapshot:true}}]});
  expect(url.pathname).toBe('/api/v2/agent-runs/agr');reads++;if(reads>1)finished=true;return response(finished?run('SUCCEEDED'):run());
 });
 const state=nativeStore(),{load}=nativeCallbacks(adapter,state);expect(await load('cnv')).toBe(true);
 for(let i=0;i<40&&(state.messages.length<2||state.isStreaming||state.isLoading);i++)await flush();
 expect(state.messages.map((item:any)=>item.id)).toEqual(['user','reply']);expect(state.setOrchestrationStep).toHaveBeenCalledWith({phase:'building',preview:'读取画布'});expect(state.addMessage).not.toHaveBeenCalled();expect(state.setError).not.toHaveBeenCalled();expect(state).toMatchObject({isLoading:false,isStreaming:false});expect(transport.mock.calls.some(([,init])=>init.method==='POST')).toBe(false);adapter.clear();
});

it('cancels the actual direct run discovered during native reload and preserves already saved history',async()=>{
 let finish!:(value:Response)=>void,canceled=false;
 const {adapter,transport}=setup((url,init)=>{
  if(url.pathname==='/api/v2/conversations/cnv')return response(conversation());
  if(url.pathname.endsWith('/messages'))return response({records:[message('user')],hasNext:false});
  if(url.pathname.endsWith('agent-capabilities'))return response(discovery());
  if(url.pathname==='/api/v2/conversations/cnv/agent-runs')return new Promise(resolve=>finish=resolve);
  if(url.pathname==='/api/v2/assistant/conversations/cnv/runs')return response({records:[]});
  if(url.pathname.endsWith('/cancel')){expect(init.method).toBe('POST');canceled=true;return response(run('CANCELED'));}
  if(url.pathname.endsWith('/events'))return response({items:[]});
  expect(url.pathname).toBe('/api/v2/agent-runs/agr');return response(run(canceled?'CANCELED':'RUNNING'));
 });
 const state=nativeStore(),{load,stop}=nativeCallbacks(adapter,state);await load('cnv');for(let i=0;i<20&&!finish;i++)await flush();await stop();expect(canceled).toBe(false);finish(response({records:[run()]}));
 for(let i=0;i<40&&(state.isLoading||state.isStreaming);i++)await flush();
 expect(canceled).toBe(true);expect(state.messages.map((item:any)=>item.id)).toEqual(['user']);expect(state.addMessage).not.toHaveBeenCalled();expect(state.setError).not.toHaveBeenCalled();expect(transport.mock.calls.filter(([,init])=>init.method==='POST').map(([path])=>String(path))).toEqual(['/api/v2/agent-runs/agr/cancel']);adapter.clear();
});

it('rejects late event projection after the native conversation changes without cancelling accepted work',async()=>{
 let finish!:(value:any)=>void,canceled=false;
 const {adapter,transport}=setup(url=>{
  if(url.pathname.endsWith('/auth-context'))return response(run());
  expect(url.pathname.endsWith('/events')).toBe(true);return new Response(new ReadableStream({
   start(controller){controller.enqueue(new TextEncoder().encode('{'));},
   pull(controller){finish=value=>{if(!canceled){controller.enqueue(new TextEncoder().encode(JSON.stringify(value).slice(1)));controller.close();}};},
   cancel(){canceled=true;},
  }));
 });
 const state=nativeStore(),{native}=nativeCallbacks(adapter,state),updates:any[]=[],watching=adapter.watch({conversationId:'cnv',message:message('user'),run:run()},update=>updates.push(update)),rejected=expect(watching).rejects.toMatchObject({name:'AbortError'});
 for(let i=0;i<20&&!finish;i++)await flush();
 const other=nativeStore('other'),change=async()=>{throw new Error('createSession 需要画布 ID');other.setGatewaySessionId('never');};native.r.useCallback(change,[other,'project']);
 finish({code:0,data:{items:[{runId:'agr',sequence:'1',type:'message.delta',data:{text:'Late reply',snapshot:true,messageId:'reply'}}]}});await rejected;expect(updates).toEqual([]);expect(transport).toHaveBeenCalledTimes(2);expect(transport.mock.calls.some(([path])=>String(path).includes('cancel'))).toBe(false);adapter.clear();
});

it('does not use a new parent login to take over a waiting Agent or fall back to a new run',async()=>{
 const {api,adapter,transport}=setup((url,init)=>{expect(url.pathname).toBe('/api/v2/agent-runs/agr/auth-context');expect(new Headers(init.headers).get('Authorization')).toBe('Bearer different-parent-session');return error(409,'AGENT_PARENT_SESSION_MISMATCH');});
 api.onRefresh(async()=>{api.setAccessToken('different-parent-session');return true;});
 await expect(adapter.watch({conversationId:'cnv',message:message('user'),run:run('WAITING_FOR_AUTH')},()=>{})).rejects.toMatchObject({code:'AGENT_PARENT_SESSION_MISMATCH'});expect(transport).toHaveBeenCalledOnce();
});

it('resolves a persisted direct run cancellation after adapter recreation using the reserved server run ID',async()=>{
 const id='agr_'+'a'.repeat(32),stored=run('RUNNING',{id});
 const {adapter,transport}=setup((url,init)=>{
  if(url.pathname==='/api/v2/conversations/cnv')return response(conversation());
  if(url.pathname===`/api/v2/agent-runs/${id}`)return response(stored);
  expect(url.pathname).toBe(`/api/v2/agent-runs/${id}/cancel`);expect(init.method).toBe('POST');return response({...stored,state:'CANCELED'});
 });
 expect(await adapter.handle(`/canvas/agent/cac/api/v1/chat/tasks/${id}/cancel`,{})).toMatchObject({id,state:'CANCELED'});expect(transport.mock.calls.some(([path])=>String(path).includes('/assistant'))).toBe(false);
});

it('rejects foreign run events, discontinuous event sequences and a terminal run without its saved output',async()=>{
 for(const [items,code] of [[[{runId:'other',sequence:'1',type:'message.delta',data:{text:'Foreign'}}],'INVALID_RESPONSE'],[[{runId:'agr',sequence:'2',type:'message.delta',data:{text:'Skipped'}}],'EVENT_SEQUENCE_GAP'],[[],'ASSISTANT_OUTPUT_NOT_PERSISTED']] as const){
  const {adapter}=setup(url=>{
   if(url.pathname.endsWith('/events'))return response({items});
   if(url.pathname.endsWith('/messages'))return response({records:[message('user')],hasNext:false});
   expect(url.pathname).toBe('/api/v2/agent-runs/agr');return response(run('SUCCEEDED'));
  });
  const updates:any[]=[];await expect(adapter.watch({conversationId:'cnv',message:message('user'),run:run('SUCCEEDED')},update=>updates.push(update))).rejects.toMatchObject({code});expect(updates.some(update=>update.type==='completed')).toBe(false);
 }
});

it('delivers real tool activity and lossless native WebSocket sequence frames without invoking browser tools',async()=>{
 let details=0;const {adapter}=setup(url=>{
  if(url.pathname==='/api/v2/conversations/cnv')return response(conversation());
  if(url.pathname.endsWith('/messages'))return response({records:[message('user'),reply],hasNext:false});
  if(url.pathname.endsWith('/auth-context'))return response(run());
  if(url.pathname.endsWith('/events'))return response({items:[{runId:'agr',sequence:'1',type:'tool.completed',data:{callId:'operation',toolName:'studio_task_read',success:true}},{runId:'agr',sequence:'2',type:'message.delta',data:{text:'Verified saved reply',snapshot:true,messageId:'reply'}}]});
  expect(url.pathname).toBe('/api/v2/agent-runs/agr');return response(run(++details===1?'RUNNING':'SUCCEEDED'));
 });
 const socket=adapter.socket('/agent-platform/api/v1/chat/stream')!,frames:any[]=[];socket.onmessage=event=>frames.push(JSON.parse(event.data));await flush();socket.send(JSON.stringify({request_id:'attach',type:'session.attach',payload:{session_id:'cnv',run_id:'agr',run_kind:'AGENT',after_seq:'0'}}));
 for(let i=0;i<40&&!frames.some(frame=>frame.type==='chat.completed');i++)await flush();
 expect(frames.find(frame=>frame.type==='chat.event')).toMatchObject({seq:1,payload:{type:'agent_activity',activity:{schema:'runninghub.agent-activity.v1',status:'completed',label:'查看任务进度'}}});expect(frames.find(frame=>frame.type==='chat.delta')).toMatchObject({seq:2,payload:{text:'Verified saved reply'}});expect(frames.at(-1)).toMatchObject({type:'chat.completed',payload:{output:'Verified saved reply'}});socket.close();
});
