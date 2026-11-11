import {afterEach,describe,expect,it,vi} from 'vitest';
import {AssistantAdapter,assistantNativeConfig} from '../../apps/web/src/service/assistant';
import {ProductClient} from '../../apps/web/src/service/product-client';
import {modelSelections} from '../../apps/web/src/service/model-catalog';

const at='2026-10-05T08:00:00.000Z';
const conversation=(id='cnv_real',projectId:string|null='project_real')=>({id,revision:1,kind:projectId?'CANVAS':'GLOBAL',projectId,hfProjectId:null,title:'Stored title',createdAt:at,updatedAt:at});
const message=(id:string,seq:number,role='USER',text='Stored text')=>({id,conversationId:'cnv_real',seq,role,content:[{type:'TEXT',text}],createdAt:at});
function response(data:any,status=200,etag?:string){return new Response(JSON.stringify({code:0,data}),{status,headers:{'Content-Type':'application/json',...(etag?{ETag:etag}:{})}});}
function failure(status:number,code:string,message:string){return new Response(JSON.stringify({code,message}),{status});}
function setup(handler:(url:URL,init:RequestInit,body:any)=>Response|Promise<Response>){
 const transport=vi.fn(async(input:any,init:RequestInit={})=>handler(new URL(String(input),'https://studio.invalid'),init,init.body?JSON.parse(String(init.body)):undefined));
 const api=new ProductClient('/api/v1',transport as typeof fetch);api.setAccessToken('owner-a-session');return{api,transport,adapter:new AssistantAdapter(api)};
}
const flush=async()=>{for(let i=0;i<15;i++)await Promise.resolve();};
afterEach(()=>{vi.useRealTimers();modelSelections.clear();});
it('blocks canvas model submission until the current unsaved draft is safely saved',async()=>{
 const {api,transport}=setup(()=>response(conversation()));
 const beforeCanvasRun=vi.fn(async()=>{throw new Error('unsaved canvas conflict');});
 const adapter=new AssistantAdapter(api,{beforeCanvasRun});
 await expect(adapter.start({session_id:'cnv_real',message:'继续当前画布'})).rejects.toThrow('unsaved canvas conflict');
 expect(beforeCanvasRun).toHaveBeenCalledWith('project_real',expect.any(AbortSignal));
 expect(transport).toHaveBeenCalledTimes(1);expect(transport.mock.calls[0][0]).toBe('/api/v2/conversations/cnv_real');
});
it('does not append a turn if the user cancels while waiting for the canvas save',async()=>{
 const {api,transport}=setup(()=>response(conversation()));const controller=new AbortController();
 const adapter=new AssistantAdapter(api,{beforeCanvasRun:async()=>{controller.abort();}});
 await expect(adapter.start({session_id:'cnv_real',message:'继续'},controller.signal)).rejects.toMatchObject({name:'AbortError'});
 expect(transport).toHaveBeenCalledTimes(1);
});
it('submits the exact selected real model and preserves vision selection for text after image history',async()=>{
 const text={capabilityRef:'text-5.6',version:'1',kind:'LLM',available:true,testMode:false,inputKinds:['TEXT','STRUCTURED'],outputKinds:['TEXT'],model:{providerRef:'supplier',modelRef:'5.6',title:'Model 5.6',version:'5.6'}},vision={...text,capabilityRef:'vision-6',kind:'IMAGE_UNDERSTANDING',inputKinds:['TEXT','STRUCTURED','IMAGE'],model:{...text.model,modelRef:'6',title:'Model 6',version:'6'}};
 const prior=[{...message('prior-image',1),content:[{type:'ASSET',assetId:'owned'}]},message('prior-answer',2,'ASSISTANT')];
 const {adapter,transport}=setup((url,init,body)=>{
  if(url.pathname==='/api/v2/conversations/cnv_real')return response(conversation(),200,'"3"');
  if(url.pathname==='/api/v2/model-capabilities')return response({items:url.searchParams.get('kind')==='LLM'?[text]:[vision],nextCursor:null});
  if(url.pathname==='/api/v1/assets/owned')return response({id:'owned',kind:'IMAGE',state:'READY'});
  if(url.pathname==='/api/v2/conversations/cnv_real/messages')return init.method==='POST'?response({...message('new-user',3),content:body.content},201):response({records:prior,page:1,size:100,total:2,hasNext:false});
  expect(body).toEqual({capabilityRef:'vision-6',capabilityVersion:'1',messageId:'new-user',parameters:{}});return response({id:'accepted-real',state:'QUEUED',testMode:false},202);
 });
 modelSelections.set('assistant:IMAGE_UNDERSTANDING',{capabilityRef:vision.capabilityRef,capabilityVersion:'1',explicit:true});
 const started=await adapter.start({session_id:'cnv_real',message:'continue without another attachment'});expect(started.run.testMode).toBe(false);expect(adapter.modelInputKinds('cnv_real')).toContain('IMAGE');expect(transport.mock.calls.some(([path])=>String(path).includes('/messages?page='))).toBe(true);
 await expect(adapter.start({session_id:'cnv_real',message:'new request',capabilityRef:'text-5.6'})).rejects.toMatchObject({code:'MODEL_INPUT_UNSUPPORTED'});expect(transport.mock.calls.filter(([path,init])=>String(path).endsWith('/messages')&&init.method==='POST')).toHaveLength(1);
});

describe('persisted native assistant conversations',()=>{
 it('creates a real Canvas conversation and projects a bare gateway string without browser or SDK IDs',async()=>{
  const {adapter,transport}=setup((url,init,body)=>{
   expect(url.pathname).toBe('/api/v2/conversations');expect(init.method).toBe('POST');
   expect(body).toEqual({kind:'CANVAS',projectId:'project_real',title:'新对话'});
   const headers=new Headers(init.headers);expect(headers.get('Authorization')).toBe('Bearer owner-a-session');expect(headers.get('Idempotency-Key')).toMatch(/^[a-f0-9-]{36}$/);
   expect(headers.get('X-Router-Subject-Ref')).toBeNull();expect(init.credentials).toBe('same-origin');return response(conversation(),201,'"1"');
  });
  expect(await adapter.handle('/canvas/openclaw/sessions/create',{canvasId:'project_real'})).toBe('cnv_real');expect(transport).toHaveBeenCalledTimes(1);
  expect(assistantNativeConfig).toEqual({type:'CANVAS_NEW_AGENT',content:{transport:'http'}});
 });
 it('restores stable server message IDs, sequence order and timestamps across new adapter instances and all pages',async()=>{
  const stored=Array.from({length:102},(_,index)=>message('msg_'+index,index+1,index%2?'ASSISTANT':'USER','Saved '+index));
  const {api,adapter,transport}=setup(url=>{
   if(url.pathname==='/api/v2/conversations/cnv_real')return response(conversation(),200,'"17"');
   expect(url.pathname).toBe('/api/v2/conversations/cnv_real/messages');const page=Number(url.searchParams.get('page'));
   return response({records:stored.slice((page-1)*100,page*100),page,size:100,total:102,hasNext:page===1});
  });
  const first=await adapter.handle('/canvas/agent/cac/api/v1/sessions/cnv_real',{},'GET');adapter.clear();
  const restored=await new AssistantAdapter(api).handle('/canvas/agent/cac/api/v1/sessions/cnv_real',{},'GET');
  expect(restored).toEqual(first);expect(first.envelopes).toHaveLength(102);expect(first.protocol).toBe('runninghub.message-envelope.v1');
  expect(first.envelopes.at(-1)).toEqual({schema:'runninghub.message-envelope.v1',id:'msg_101',role:'assistant',created_at:Date.parse(at),parts:[{type:'text',text:'Saved 101'}]});
  expect(transport.mock.calls.filter(([path])=>String(path).includes('messages?page=2'))).toHaveLength(2);
 });
 it('uses real owner-scoped conversation pages and actual USER message counts for the history list',async()=>{
  const {adapter}=setup(url=>{
   if(url.pathname==='/api/v2/conversations'){expect(Object.fromEntries(url.searchParams)).toEqual({page:'2',size:'5',kind:'CANVAS',projectId:'project_real'});return response({records:[conversation()],page:2,size:5,total:9,hasNext:false});}
   return response({records:[message('u1',1),message('a1',2,'ASSISTANT'),message('u2',3)],page:1,size:100,total:3,hasNext:false});
  });
  expect(await adapter.handle('/canvas/openclaw/sessions/list',{pageNum:2,pageSize:5,canvasId:'project_real'})).toEqual({records:[{sessionId:'cnv_real',title:'Stored title',lastTurnTime:Date.parse(at),turnCount:2,createdAt:Date.parse(at)}],total:9,size:5,current:2,pages:2,hasNext:false});
 });
 it('reloads the current strong ETag before real deletion and exposes a concurrent conflict without retry',async()=>{
  const {adapter,transport}=setup((url,init)=>{expect(url.pathname).toBe('/api/v2/conversations/cnv_real');if(init.method!=='DELETE')return response({...conversation(),revision:7},200,'"7"');expect(new Headers(init.headers).get('If-Match')).toBe('"7"');return failure(412,'VERSION_CONFLICT','Changed elsewhere');});
  await expect(adapter.handle('/canvas/openclaw/sessions/delete',{sessionId:'cnv_real'})).rejects.toMatchObject({status:412,code:'VERSION_CONFLICT'});expect(transport).toHaveBeenCalledTimes(2);
 });
 it('writes only the requested user content with UUID idempotency and current If-Match, preserving backend receipt fields',async()=>{
  const persisted={...message('server_user_9',9),conversationRevision:12};
  const {adapter,transport}=setup((url,init,body)=>{if(!init.method)return response({...conversation(),revision:11},200,'"11"');expect(url.pathname).toBe('/api/v2/conversations/cnv_real/messages');expect(body).toEqual({content:[{type:'TEXT',text:'  Saved unchanged  '}]});expect(new Headers(init.headers).get('If-Match')).toBe('"11"');expect(new Headers(init.headers).get('Idempotency-Key')).toMatch(/^[a-f0-9-]{36}$/);return response(persisted,201,'"12"');});
  expect(await adapter.handle('/canvas/api/message/send',{sessionId:'cnv_real',message:'  Saved unchanged  ',ownerId:'forged',role:'ASSISTANT'})).toEqual(persisted);expect(transport).toHaveBeenCalledTimes(2);
 });
 it('does not probe catalog or execute a model when the conversation is inaccessible',async()=>{
  const {adapter,transport}=setup(()=>failure(404,'CONVERSATION_NOT_FOUND','Conversation unavailable'));
  await expect(adapter.start({session_id:'foreign',message:'Hello'})).rejects.toMatchObject({status:404});expect(transport).toHaveBeenCalledTimes(1);expect(transport.mock.calls[0][0]).toBe('/api/v2/conversations/foreign');
 });
 it('rejects message deletion without its real conversation and unsupported tool interactions before sending',async()=>{
  const {adapter,transport}=setup(()=>response({}));
  await expect(adapter.handle('/canvas/openclaw/turns/delete',{id:'message_real'})).rejects.toMatchObject({status:400});
  await expect(adapter.start({session_id:'cnv_real',message:'Hello',runtime_event:{type:'workflow.completed'}})).rejects.toMatchObject({status:501});expect(transport).not.toHaveBeenCalled();
 });
 it('resolves native image attachment URLs to fresh owned READY ASSET parts and actual selected skill snapshots',async()=>{
  const asset={id:'ast_real',state:'READY',kind:'IMAGE',fileName:'reference.png'};
  const skill={resource:{id:'skill_real',revision:7,version:'2'},content:{markdown:'# Real instructions',files:[{path:'SKILL.md',content:'Saved skill file'}]}};
  const {api,transport}=setup(url=>{if(url.pathname==='/api/v1/assets/ast_real')return response(asset);if(url.pathname==='/api/v2/skills/skill_real')return response(skill);throw new Error('Unexpected '+url.pathname);});
  const resolver=vi.fn(async(ref:string)=>ref==='/api/v1/media/reference'?asset as any:null),adapter=new AssistantAdapter(api,{resolveAsset:resolver});
  expect(await adapter.validatedInput({message:'Analyze reference',image_attachments:[{url:'/api/v1/media/reference',name:'Uploaded'}],skill_ids:['skill_real']})).toEqual([{type:'TEXT',text:'Analyze reference'},{type:'ASSET',assetId:'ast_real'},{type:'STRUCTURED',schemaCode:'ASSISTANT_SKILL_V1',value:{skillId:'skill_real',revision:7,version:'2',markdown:'# Real instructions',files:[{path:'SKILL.md',content:'Saved skill file'}]}}]);
  expect(resolver).toHaveBeenCalledWith('/api/v1/media/reference',expect.any(AbortSignal));expect(transport.mock.calls.map(([path])=>path)).toEqual(['/api/v1/assets/ast_real','/api/v2/skills/skill_real']);
 });
 it('validates explicit rhtv-asset IDs without truncation and rejects unknown external URLs without fetching them',async()=>{
  const {adapter,transport}=setup(url=>{expect(url.pathname).toBe('/api/v1/assets/ast_real');return response({id:'ast_real',state:'READY',kind:'IMAGE'});});
  expect(await adapter.validatedInput({message:'Use image',attachments:['rhtv-asset:ast_real']})).toEqual([{type:'TEXT',text:'Use image'},{type:'ASSET',assetId:'ast_real'}]);
  await expect(adapter.validatedInput({message:'Use image',image_attachments:[{url:'https://vendor.invalid/private.png'}]})).rejects.toMatchObject({code:'ASSET_REFERENCE_REQUIRED'});expect(transport).toHaveBeenCalledTimes(1);
 });
 it('submits the strict skill file projection from actual rich saved metadata without changing text or binary content',async()=>{
  const files=[{path:'SKILL.md',content:'# Saved instructions',encoding:'utf8',mimeType:'text/markdown',type:'md',primary:true},{path:'assets/icon.png',content:'iVBORw0KGgo=',encoding:'base64',mimeType:'image/png',type:'file',primary:false}];
  const skill={resource:{id:'skill_real',revision:9,version:'3'},content:{markdown:'# Saved instructions',files}},expected={skillId:'skill_real',revision:9,version:'3',markdown:'# Saved instructions',files:files.map(({path,content})=>({path,content}))};
  const {adapter,transport}=setup((url,init,body)=>{
   if(url.pathname==='/api/v2/conversations/cnv_real')return response(conversation(),200,'"1"');
   if(url.pathname==='/api/v2/skills/skill_real')return response(skill);
   expect(url.pathname).toBe('/api/v2/conversations/cnv_real/messages');expect(init.method).toBe('POST');
   expect(body.content).toEqual([{type:'TEXT',text:'Use saved skill'},{type:'STRUCTURED',schemaCode:'ASSISTANT_SKILL_V1',value:expected}]);
   for(const file of body.content[1].value.files)expect(Object.keys(file)).toEqual(['path','content']);
   return response({...message('saved_skill_turn',1),content:body.content},201);
  });
  const receipt=await adapter.handle('/canvas/api/message/send',{sessionId:'cnv_real',message:'Use saved skill',skill_ids:['skill_real']});expect(receipt.content[1].value).toEqual(expected);
  expect(skill.content.files[1]).toMatchObject({encoding:'base64',mimeType:'image/png',type:'file',primary:false,content:'iVBORw0KGgo='});expect(transport).toHaveBeenCalledTimes(3);
 });
 it('exposes attachment and selected skill authorization failures before writing a user message or running a model',async()=>{
  const {adapter,transport}=setup(url=>{if(url.pathname.endsWith('/cnv_real'))return response(conversation(),200,'"1"');return failure(404,'RESOURCE_NOT_FOUND','Not owned');});
  await expect(adapter.start({session_id:'cnv_real',message:'Use selected',skill_ids:['foreign']})).rejects.toMatchObject({status:404});expect(transport.mock.calls.map(([path])=>String(path))).toEqual(['/api/v2/conversations/cnv_real','/api/v2/skills/foreign']);
 });
 it('rejects malformed multimodal input before resolving assets or contacting the API',async()=>{
  const {adapter,transport}=setup(()=>response({}));for(const input of [{content:[null]},{content:[{type:'TEXT',text:'bad\0text'}]},{message:'Hello',skill_ids:'not-array'}])await expect(adapter.validatedInput(input)).rejects.toMatchObject({status:400});expect(transport).not.toHaveBeenCalled();
 });
});

describe('real assistant runs and protocol projection',()=>{
 it('classifies only native assistant streams before inspecting unrelated fetch bodies',async()=>{
  const {adapter,transport}=setup(()=>response({}));
  for(const path of ['/canvas/openclaw/chat','/canvas/agent/chat/stream','/canvas/agent/cac/api/v1/chat/stream','/agent-platform/api/v1/chat/stream','/api/v1/chat/stream?rich=1'])expect(adapter.supportsStream(path)).toBe(true);
  const body=new Proxy({},{get:()=>{throw new Error('Unrelated body was inspected');}});
  for(const path of ['/project/assets/index.js','/assets/readme.txt','/canvas/openclaw/chat/history','/canvas/openclaw/sessions/detail','https://external.invalid/chat/stream','//external.invalid/chat/stream']){expect(adapter.supportsStream(path)).toBe(false);expect(await adapter.stream(path,body)).toBeUndefined();}
  expect(transport).not.toHaveBeenCalled();
 });
 function execution(options:{persistOutput?:boolean;state?:string;blocked?:boolean}={}){
  const stored=[message('old_u',1),message('old_a',2,'ASSISTANT','Old reply')];let user:any=null,cancelled=false;
  const {api,adapter,transport}=setup((url,init,body)=>{
   if(url.pathname==='/api/v2/conversations/cnv_real')return response({...conversation(),revision:3},200,'"3"');
   if(url.pathname==='/api/v2/model-capabilities'){expect(url.searchParams.get('kind')).toBe('LLM');return response({items:[{capabilityRef:'mock-llm',version:'1',kind:'LLM',title:'LLM TEST MODE',testMode:true,available:true}],nextCursor:null});}
   if(url.pathname==='/api/v2/conversations/cnv_real/messages'&&init.method==='POST'){user={...message('new_user',3,'USER',body.content[0].text),conversationRevision:4};stored.push(user);return response(user,201,'"4"');}
   if(url.pathname==='/api/v2/assistant/conversations/cnv_real/runs'){expect(body).toEqual({capabilityRef:'mock-llm',capabilityVersion:'1',messageId:'new_user',parameters:{}});expect(new Headers(init.headers).get('Idempotency-Key')).toMatch(/^[a-f0-9-]{36}$/);return response({id:'run_real',state:'RUNNING',testMode:true},202);}
   if(url.pathname.endsWith('/cancel')){cancelled=true;return response({id:'run_real',state:'CANCELLED',testMode:true});}
   if(url.pathname.endsWith('/events'))return response({items:url.searchParams.get('after')==='0'?[{sequence:1,type:'text.delta',data:{delta:'Preview only'}}]:[],state:'RUNNING'});
   if(url.pathname.endsWith('/runs/run_real')){const state=cancelled?'CANCELLED':options.blocked?'RUNNING':options.state||'SUCCEEDED';if(state==='SUCCEEDED'&&options.persistOutput!==false&&!stored.some(item=>item.id==='new_reply'))stored.push(message('new_reply',4,'ASSISTANT','Persisted authoritative reply'));return response({id:'run_real',state,testMode:true,assistantMessageId:'new_reply',errorMessage:'Real failure'});}
   if(url.pathname==='/api/v2/conversations/cnv_real/messages')return response({records:stored,page:1,size:100,total:stored.length,hasNext:false});
   throw new Error('Unexpected '+url.pathname);
  });return{api,adapter,transport,stored,isCancelled:()=>cancelled};
 }
 it('submits an actual catalog ref and server USER message, then emits TEST MODE SSE from real events and persisted final history',async()=>{
  const {adapter,transport}=execution();const stream=await adapter.stream('/canvas/openclaw/chat',{sessionId:'cnv_real',messages:[{role:'assistant',content:'Ignored context copy'},{role:'user',content:'Current turn'}]});
  const text=await stream!.text();expect(text).toContain('event: chat.delta\ndata: {"text":"[TEST MODE]\\nPreview only"}');expect(text).toContain('event: chat.final\ndata: {"text":"[TEST MODE]\\nPersisted authoritative reply"}');expect(text).toContain('data: [DONE]');
  expect(transport.mock.calls.map(([path])=>String(path))).toContain('/api/v2/assistant/conversations/cnv_real/runs/run_real/events?after=0');
  expect(transport.mock.calls.find(([path,init])=>String(path).endsWith('/messages')&&init?.method==='POST')?.[1].body).toBe('{"content":[{"type":"TEXT","text":"Current turn"}]}');
 });
 it('does not turn a terminal run with no saved assistant message into generated success',async()=>{
  const {adapter}=execution({persistOutput:false});const stream=await adapter.stream('/canvas/agent/cac/api/v1/chat/stream',{session_id:'cnv_real',message:'Current turn'}),text=await stream!.text();
  expect(text).toContain('[error]');expect(text).toContain('尚未保存对应回复');expect(text).not.toContain('event: chat.final');
 });
 it('reports a persisted failed run and does not reuse an earlier assistant reply',async()=>{
  const {adapter}=execution({state:'FAILED'});const stream=await adapter.stream('/canvas/openclaw/chat',{sessionId:'cnv_real',message:'Current turn'}),text=await stream!.text();expect(text).toContain('Real failure');expect(text).not.toContain('Old reply');expect(text).not.toContain('event: chat.final');
 });
 it('adapts WebSocket deltas as incremental text and preserves the real run ID and event sequence',async()=>{
  const {adapter}=execution(),socket=adapter.socket('wss://studio.example/agent-platform/api/v1/chat/stream')!,frames:any[]=[];socket.onmessage=event=>frames.push(JSON.parse(event.data));await flush();socket.send(JSON.stringify({type:'chat.start',request_id:'req_native',payload:{session_id:'cnv_real',message:'Current turn',client_command_id:'native_cmd'}}));
  for(let i=0;i<20&&!frames.some(frame=>frame.type==='chat.completed');i++)await flush();
  expect(frames.find(frame=>frame.type==='run.accepted')).toMatchObject({request_id:'req_native',run_id:'run_real',payload:{run_id:'run_real',client_command_id:'native_cmd'}});
  expect(frames.find(frame=>frame.type==='chat.delta')).toMatchObject({seq:1,run_id:'run_real',payload:{text:'[TEST MODE]\nPreview only'}});expect(frames.find(frame=>frame.type==='chat.completed').payload.output).toBe('[TEST MODE]\nPersisted authoritative reply');socket.close();
 });
 it('cancels the real run when the consumer stops the SSE stream',async()=>{
  vi.useFakeTimers();const {adapter,isCancelled}=execution({blocked:true});const stream=await adapter.stream('/canvas/openclaw/chat',{sessionId:'cnv_real',message:'Current turn'});await stream!.body!.cancel();await flush();expect(isCancelled()).toBe(true);adapter.clear();
 });
 it('does not cancel an old identity run when its stream is disposed after clear and a new identity is accepted',async()=>{
  vi.useFakeTimers();const {adapter,api,isCancelled,transport}=execution({blocked:true}),stream=await adapter.stream('/canvas/openclaw/chat',{sessionId:'cnv_real',message:'Current turn'});
  adapter.clear();api.setAccessToken('owner-b-session');await stream!.body!.cancel();await flush();
  expect(isCancelled()).toBe(false);expect(transport.mock.calls.filter(([path])=>String(path).endsWith('/cancel'))).toHaveLength(0);
 });
 it('rejects discontinuous persisted event sequence instead of displaying invented continuity',async()=>{
  const {adapter}=setup((url,init)=>{
   if(url.pathname.includes('/events'))return response({items:[{sequence:2,type:'text.delta',data:{text:'Skipped seq'}}]});
   if(url.pathname==='/api/v2/conversations/cnv_real')return response(conversation(),200,'"1"');
   if(url.pathname.includes('model-capabilities'))return response({items:[{capabilityRef:'real-llm',version:'3',kind:'LLM',available:true,testMode:true}]});
   if(url.pathname.endsWith('/messages')&&init.method==='POST')return response(message('new_user',1),201);
   return response({id:'run_real',state:'RUNNING'},202);
  });
  const started=await adapter.start({session_id:'cnv_real',message:'Current turn'});await expect(adapter.watch(started,()=>{})).rejects.toMatchObject({code:'EVENT_SEQUENCE_GAP'});
 });
 it('defers HyperFrames streaming to its real studio adapter',async()=>{const {adapter,transport}=execution();expect(await adapter.stream('/canvas/openclaw/chat',{businessType:'HYPER_FRAMES'})).toBeUndefined();expect(transport).not.toHaveBeenCalled();});
 it('does not choose an unselected real provider as the native assistant default',async()=>{
  const {adapter,transport}=setup(url=>{if(url.pathname.endsWith('/cnv_real'))return response(conversation(),200,'"1"');return response({items:[{capabilityRef:'live-provider',version:'1',kind:'LLM',available:true,testMode:false}],nextCursor:null});});
  await expect(adapter.start({session_id:'cnv_real',message:'Current turn'})).rejects.toMatchObject({status:501,code:'MODEL_UNAVAILABLE'});expect(transport.mock.calls.every(([,init])=>!init?.method)).toBe(true);
 });
 it('returns committed plain text for the SDK AD parser, without SSE syntax or speculative deltas',async()=>{
  const {adapter}=execution();const stream=await adapter.stream('/canvas/agent/cac/api/v1/chat/stream',{session_id:'cnv_real',message:'Current turn'});expect(stream!.headers.get('Content-Type')).toBe('text/plain;charset=utf-8');expect(await stream!.text()).toBe('[TEST MODE]\nPersisted authoritative reply');
 });
 it('resumes a stored task from its server input message and event output ID without appending or creating a run',async()=>{
  const {adapter,transport}=setup(url=>{
   if(url.pathname==='/api/v2/conversations/cnv_real')return response(conversation(),200,'"5"');
   if(url.pathname.endsWith('/events'))return response({items:url.searchParams.get('after')==='0'?[{sequence:1,type:'chat.delta',data:{text:'Stored reply',messageId:'reply_for_run'}}]:[],terminal:true});
   if(url.pathname.endsWith('/runs/run_real'))return response({id:'run_real',conversationId:'cnv_real',messageId:'original_user',state:'SUCCEEDED',testMode:true});
   if(url.pathname.endsWith('/messages'))return response({records:[message('original_user',1),message('later_user',2),message('reply_for_run',3,'ASSISTANT','Stored reply')],hasNext:false});
   throw new Error('Unexpected '+url.pathname);
  });
  const started=await adapter.resume('cnv_real','run_real'),updates:any[]=[];await adapter.watch(started,update=>updates.push(update),undefined,1);
  expect(updates.at(-1)).toMatchObject({type:'completed',text:'[TEST MODE]\nStored reply'});expect(transport.mock.calls.every(([,init])=>!init?.method||init.method==='GET')).toBe(true);
 });
 it('resolves run ownership from the server when cancelling after adapter recreation',async()=>{
  const {adapter,transport}=setup((url,init)=>{
   if(url.pathname==='/api/v2/assistant-runs/run_real')return response({id:'run_real',conversationId:'cnv_real',state:'RUNNING'});
   if(url.pathname==='/api/v2/conversations/cnv_real')return response(conversation(),200,'"5"');
   expect(url.pathname).toBe('/api/v2/assistant/conversations/cnv_real/runs/run_real/cancel');expect(init.method).toBe('POST');return response({id:'run_real',state:'CANCELED'});
  });
  expect(await adapter.handle('/canvas/agent/cac/api/v1/chat/tasks/run_real/cancel',{mode:'immediate'})).toMatchObject({id:'run_real',state:'CANCELED'});expect(transport).toHaveBeenCalledTimes(3);
 });
});

describe('precise native assistant callback integration',()=>{
 function nativeStore(canvasId='project_real'){
  const state:any={activeCanvasId:canvasId,gatewaySessionId:null,messages:[],addMessage:vi.fn(),setError:vi.fn((error:string|null)=>state.error=error)};
  state.setLoading=vi.fn((loading:boolean)=>state.isLoading=loading);state.setStreaming=vi.fn((streaming:boolean)=>state.isStreaming=streaming);
  state.resetConversationState=vi.fn(()=>state.messages=[]);state.setGatewaySessionId=vi.fn((id:string)=>state.gatewaySessionId=id);state.setMessages=vi.fn((messages:any[])=>state.messages=messages);return state;
 }
 function callbacks(adapter:AssistantAdapter,state:any){
  const useCallback=vi.fn((callback:any)=>callback),native={r:{useCallback}};adapter.installNative(native);
  const originalCreate=async()=>{if(true)throw new Error('createSession 需要画布 ID');state.setGatewaySessionId('canvas-sdk-local');};
  const fz=vi.fn();const originalHistory=async(id:string)=>await fz({sessionId:id,canvasId:state.activeCanvasId,shouldCommit:()=>true});
  const ensure=native.r.useCallback(originalCreate,[state,state.activeCanvasId]),load=native.r.useCallback(originalHistory,[vi.fn(),state,state.activeCanvasId,null,null,null,null]);
  const originalStopCalls=vi.fn();const originalStop=function(){originalStopCalls();return '_remakeBackgroundTaskId canvas.agent.session.cancelled';};
  const stop=native.r.useCallback(originalStop,[vi.fn(),state,vi.fn()]);
  state.setAgentIdOverride=vi.fn();const skills={setSkillPackageState:vi.fn()};
  const originalNew=async()=>{state.resetConversationState();state.setGatewaySessionId(null);state.setAgentIdOverride(null);skills.setSkillPackageState(null);return ensure();};
  const fresh=native.r.useCallback(originalNew,[state.activeCanvasId,state,ensure]);return{native,useCallback,originalCreate,ensure,load,stop,originalStop,originalStopCalls,fresh};
 }
 it('replaces only the two inspected callbacks, creates a persisted ID and restores actual history into existing native store',async()=>{
  const {adapter,transport}=setup((url,init)=>{
   if(url.pathname==='/api/v2/conversations'&&init.method==='POST')return response(conversation(),201,'"1"');
   if(url.pathname==='/api/v2/conversations/cnv_real')return response(conversation(),200,'"2"');
   if(url.pathname==='/api/v2/assistant/conversations/cnv_real/runs')return response({records:[]});
   if(url.pathname.endsWith('/messages'))return response({records:[message('persisted_u',1,'USER','Hello'),message('persisted_a',2,'ASSISTANT','Saved reply')],hasNext:false});throw new Error('Unexpected '+url.pathname);
  });
  const state=nativeStore(),{native,ensure,load}=callbacks(adapter,state),unrelated=()=>123;
  expect(native.r.useCallback(unrelated,[])).toBe(unrelated);expect(native.r.useCallback(unrelated,[state,'project_real'])).toBe(unrelated);
  expect(await ensure()).toBe('cnv_real');expect(state.gatewaySessionId).toBe('cnv_real');expect(await load('cnv_real')).toBe(true);
  expect(state.messages.map((item:any)=>item.id)).toEqual(['persisted_u','persisted_a']);expect(state.messages[1]).toMatchObject({role:'assistant',content:'Saved reply',timestamp:Date.parse(at),isStreaming:false});
  expect(transport.mock.calls.filter(([,init])=>init?.method==='POST')).toHaveLength(1);adapter.clear();expect(state.messages).toEqual([]);expect(state.gatewaySessionId).toBeNull();
 });
 it('does not commit a late history response to the native store after switching canvas',async()=>{
  let finish!:(value:Response)=>void;const {adapter}=setup(url=>{if(url.pathname.endsWith('/cnv_real'))return response(conversation(),200,'"1"');return new Promise(resolve=>finish=resolve);});
  const state=nativeStore(),{native,load}=callbacks(adapter,state),loading=load('cnv_real'),rejected=expect(loading).rejects.toMatchObject({name:'AbortError'});await flush();
  const other=nativeStore('project_other');const changed=async()=>{throw new Error('createSession 需要画布 ID');other.setGatewaySessionId('never');};native.r.useCallback(changed,[other,'project_other']);
  finish(response({records:[message('late',1)],hasNext:false}));await rejected;expect(state.setMessages).not.toHaveBeenCalled();expect(other.setMessages).not.toHaveBeenCalled();
 });
 it('keeps the latest selected persisted history when older requests resolve last on the same canvas',async()=>{
  const finish=new Map<string,(value:Response)=>void>(),reads=new Map<string,number>();
  const {adapter}=setup(url=>{
   if(url.pathname.includes('/assistant/conversations/'))return response({records:[]});
   const id=url.pathname.split('/')[4];
   if(!url.pathname.endsWith('/messages'))return response(conversation(id),200,'"1"');
   reads.set(id,(reads.get(id)||0)+1);if((reads.get(id)||0)>1)return response({records:[{...message(id==='cnv_b'?'b_saved':'a_saved',1),conversationId:id}],hasNext:false});
   return new Promise(resolve=>finish.set(id,resolve));
  });
  const state=nativeStore(),{load}=callbacks(adapter,state),older=load('cnv_a');await flush();const latest=load('cnv_b');await flush();
  finish.get('cnv_b')!(response({records:[{...message('b_saved',1),conversationId:'cnv_b'}],hasNext:false}));expect(await latest).toBe(true);
  finish.get('cnv_a')!(response({records:[{...message('a_saved',1),conversationId:'cnv_a'}],hasNext:false}));expect(await older).toBe(false);
  await vi.waitFor(()=>expect(state.setMessages).toHaveBeenCalledTimes(2));
  expect(state.gatewaySessionId).toBe('cnv_b');expect(state.messages.map((item:any)=>item.id)).toEqual(['b_saved']);expect(state.resetConversationState).toHaveBeenCalledTimes(1);expect(state.setMessages).toHaveBeenCalledTimes(2);adapter.clear();
 });
 it('discovers the actual active task on HTTP history load and restores its committed reply without writing or restarting a model',async()=>{
  const stored=[message('original_user',1)],task={id:'run_real',kind:'ASSISTANT',conversationId:'cnv_real',messageId:'original_user',state:'RUNNING',testMode:true};let taskReads=0;
  const {adapter,transport}=setup((url,init)=>{
   expect(init.method??'GET').toBe('GET');
   if(url.pathname==='/api/v2/conversations/cnv_real')return response(conversation());
   if(url.pathname.endsWith('/messages'))return response({records:stored,hasNext:false});
   if(url.pathname==='/api/v2/assistant/conversations/cnv_real/runs'){expect([...url.searchParams]).toEqual([['state','active']]);return response({records:[task]});}
   if(url.pathname.endsWith('/events'))return response({items:[{sequence:1,type:'chat.delta',data:{text:'Persisted reply',messageId:'reply_real'}}],terminal:true});
   if(url.pathname.endsWith('/runs/run_real')){taskReads++;if(taskReads===1)return response(task);if(stored.length===1)stored.push(message('reply_real',2,'ASSISTANT','[TEST MODE]\nPersisted reply'));return response({...task,state:'SUCCEEDED'});}
   throw new Error('Unexpected '+url.pathname);
  });
  const state=nativeStore(),{load}=callbacks(adapter,state);expect(await load('cnv_real')).toBe(true);
  for(let i=0;i<40&&(state.messages.length!==2||state.isStreaming||state.isLoading);i++)await flush();
  expect(state.messages.map((item:any)=>item.id)).toEqual(['original_user','reply_real']);expect(state.messages[1].content).toBe('[TEST MODE]\nPersisted reply');
  expect(state).toMatchObject({gatewaySessionId:'cnv_real',isLoading:false,isStreaming:false});expect(state.setError).not.toHaveBeenCalled();expect(taskReads).toBe(2);
  expect(transport.mock.calls.every(([path,init])=>!init?.method&&!String(path).includes('model-capabilities'))).toBe(true);adapter.clear();
 });
 it('reloads the committed reply when the task finishes between the first history read and active discovery',async()=>{
  const stored=[message('original_user',1)];let reads=0;
  const {adapter,transport}=setup(url=>{
   if(url.pathname==='/api/v2/conversations/cnv_real')return response(conversation());
   if(url.pathname.endsWith('/messages')){reads++;return response({records:stored,hasNext:false});}
   expect(url.pathname).toBe('/api/v2/assistant/conversations/cnv_real/runs');expect(url.searchParams.get('state')).toBe('active');
   stored.push(message('committed_between_reads',2,'ASSISTANT','[TEST MODE]\nSaved just now'));return response({records:[]});
  });
  const state=nativeStore(),{load}=callbacks(adapter,state);await load('cnv_real');for(let i=0;i<20&&(state.messages.length!==2||state.isLoading);i++)await flush();
  expect(state.messages.map((item:any)=>item.id)).toEqual(['original_user','committed_between_reads']);expect(state.messages[1].content).toBe('[TEST MODE]\nSaved just now');expect(reads).toBe(2);
  expect(state.setError).not.toHaveBeenCalled();expect(transport.mock.calls.every(([,init])=>!init?.method)).toBe(true);adapter.clear();
 });
 it('exposes tool waits and contradictory multiple active tasks rather than inventing an idle session',async()=>{
  const task={id:'run_real',kind:'ASSISTANT',conversationId:'cnv_real',messageId:'original_user',state:'WAITING_TOOL',testMode:true};
  for(const records of [[task],[{...task,state:'RUNNING'},{...task,id:'run_second',state:'RUNNING'}]]){
   const {adapter,transport}=setup(url=>{
    if(url.pathname==='/api/v2/conversations/cnv_real')return response(conversation());
    if(url.pathname.endsWith('/messages'))return response({records:[message('original_user',1)],hasNext:false});
    return response({records});
   });
   const state=nativeStore(),{load}=callbacks(adapter,state);await load('cnv_real');for(let i=0;i<10&&!state.error;i++)await flush();
   expect(state.error).toContain(records.length===1?'工具恢复协议尚未接入':'多个活动运行');expect(state).toMatchObject({isLoading:false,isStreaming:false});
   expect(transport.mock.calls.map(([path])=>String(path))).not.toContain('/api/v2/assistant/conversations/cnv_real/runs/run_real');adapter.clear();
  }
 });
 it('rejects a discovery task for a different conversation without reading its input or events',async()=>{
  const {adapter,transport}=setup(url=>{
   if(url.pathname==='/api/v2/conversations/cnv_real')return response(conversation());
   if(url.pathname.endsWith('/messages'))return response({records:[message('original_user',1)],hasNext:false});
   return response({records:[{id:'foreign_run',kind:'ASSISTANT',conversationId:'foreign',messageId:'original_user',state:'RUNNING'}]});
  });
  const state=nativeStore(),{load}=callbacks(adapter,state);await load('cnv_real');for(let i=0;i<10&&!state.error;i++)await flush();
  expect(state.error).toContain('不属于当前会话');expect(transport).toHaveBeenCalledTimes(3);adapter.clear();
 });
 it('discards late active-task discovery after selecting another session and never resumes or cancels that old task',async()=>{
  let finish!:(value:Response)=>void,pendingSignal:AbortSignal|null=null;
  const {adapter,transport}=setup((url,init)=>{
   if(url.pathname.startsWith('/api/v2/conversations/')){const id=url.pathname.split('/')[4];return url.pathname.endsWith('/messages')?response({records:[{...message(id+'_saved',1),conversationId:id}],hasNext:false}):response(conversation(id));}
   if(url.pathname==='/api/v2/assistant/conversations/cnv_a/runs'){pendingSignal=init.signal!;return new Promise(resolve=>finish=resolve);}
   if(url.pathname==='/api/v2/assistant/conversations/cnv_b/runs')return response({records:[]});
   throw new Error('Unexpected '+url.pathname);
  });
  const state=nativeStore(),{load}=callbacks(adapter,state);await load('cnv_a');await flush();expect(pendingSignal).not.toBeNull();await load('cnv_b');await flush();expect(pendingSignal!.aborted).toBe(true);
  finish(response({records:[{id:'run_old',kind:'ASSISTANT',conversationId:'cnv_a',messageId:'cnv_a_saved',state:'RUNNING'}]}));await flush();
  expect(state.gatewaySessionId).toBe('cnv_b');expect(state.messages.map((item:any)=>item.id)).toEqual(['cnv_b_saved']);expect(state.setError).not.toHaveBeenCalled();
  expect(transport.mock.calls.every(([path,init])=>!String(path).includes('run_old')&&!init?.method)).toBe(true);adapter.clear();
 });
 it('aborts a recovered event body on logout and does not mutate native state after a new identity is accepted',async()=>{
  let finish!:(value:any)=>void,canceled=false;const task={id:'run_real',kind:'ASSISTANT',conversationId:'cnv_real',messageId:'original_user',state:'RUNNING'};
  const {adapter,api,transport}=setup((url,init)=>{
   if(url.pathname==='/api/v2/conversations/cnv_real')return response(conversation());
   if(url.pathname.endsWith('/messages'))return response({records:[message('original_user',1)],hasNext:false});
   if(url.pathname.endsWith('/runs'))return response({records:[task]});
   if(url.pathname.endsWith('/runs/run_real'))return response(task);
   if(url.pathname.endsWith('/events'))return new Response(new ReadableStream({
    start(controller){controller.enqueue(new TextEncoder().encode('{'));},
    pull(controller){finish=value=>{if(!canceled){controller.enqueue(new TextEncoder().encode(JSON.stringify(value).slice(1)));controller.close();}};},
    cancel(){canceled=true;},
   }));
   throw new Error('Unexpected '+url.pathname);
  });
  const state=nativeStore(),{load}=callbacks(adapter,state);await load('cnv_real');for(let i=0;i<20&&!finish;i++)await flush();expect(finish).toBeTypeOf('function');
  expect(state.isStreaming).toBe(true);adapter.clear();api.setAccessToken('owner-b-session');const calls=transport.mock.calls.length;
  finish({code:0,data:{items:[{sequence:1,type:'chat.delta',data:{text:'Late owner A reply',messageId:'reply_a'}}]}});await flush();
  expect(canceled).toBe(true);expect(state.messages).toEqual([]);expect(state.gatewaySessionId).toBeNull();expect(state.setMessages).toHaveBeenCalledTimes(1);expect(state.setError).not.toHaveBeenCalled();expect(transport).toHaveBeenCalledTimes(calls);
 });
 it('uses the inspected native stop callback to cancel a recovered task and reloads actual cancelled history without adding a local reply',async()=>{
  vi.useFakeTimers();let cancelled=false;const task={id:'run_real',kind:'ASSISTANT',conversationId:'cnv_real',messageId:'original_user',state:'RUNNING'};
  const {adapter,transport}=setup((url,init)=>{
   if(url.pathname==='/api/v2/conversations/cnv_real')return response(conversation());
   if(url.pathname.endsWith('/messages'))return response({records:[message('original_user',1)],hasNext:false});
   if(url.pathname.endsWith('/runs'))return response({records:[task]});
   if(url.pathname.endsWith('/cancel')){expect(init.method).toBe('POST');cancelled=true;return response({...task,state:'CANCELED'});}
   if(url.pathname.endsWith('/runs/run_real'))return response({...task,state:cancelled?'CANCELED':'RUNNING'});
   if(url.pathname.endsWith('/events'))return response({items:[]});
   throw new Error('Unexpected '+url.pathname);
  });
  const state=nativeStore(),{load,stop,originalStopCalls}=callbacks(adapter,state);await load('cnv_real');for(let i=0;i<20&&!state.isStreaming;i++)await flush();await stop();await vi.advanceTimersByTimeAsync(400);await flush();
  expect(cancelled).toBe(true);expect(originalStopCalls).not.toHaveBeenCalled();expect(state.addMessage).not.toHaveBeenCalled();expect(state.messages.map((item:any)=>item.id)).toEqual(['original_user']);expect(state).toMatchObject({isLoading:false,isStreaming:false});
  expect(transport.mock.calls.filter(([,init])=>init?.method==='POST').map(([path])=>String(path))).toEqual(['/api/v2/assistant/conversations/cnv_real/runs/run_real/cancel']);adapter.clear();
 });
 it('preserves new-conversation native resets and creates a fresh persisted ID even with a stale React state snapshot',async()=>{
  const {adapter,transport}=setup((url,init)=>{expect(url.pathname).toBe('/api/v2/conversations');expect(init.method).toBe('POST');return response(conversation('cnv_new'),201);});
  const state=nativeStore();state.gatewaySessionId='cnv_old';const actual={gatewaySessionId:'cnv_old'};
  state.setGatewaySessionId=vi.fn((id:string|null)=>actual.gatewaySessionId=id as string);const {fresh,stop,originalStopCalls}=callbacks(adapter,state);
  expect(await fresh()).toBe('cnv_new');expect(actual.gatewaySessionId).toBe('cnv_new');expect(state.gatewaySessionId).toBe('cnv_old');expect(state.setAgentIdOverride).toHaveBeenCalledWith(null);expect(transport).toHaveBeenCalledTimes(1);
  stop();expect(originalStopCalls).toHaveBeenCalledTimes(1);adapter.clear();
 });
 it('honors native stop while discovery is pending by cancelling only the actual task ID returned by the server',async()=>{
  let finish!:(value:Response)=>void,cancelled=false;const task={id:'run_real',kind:'ASSISTANT',conversationId:'cnv_real',messageId:'original_user',state:'RUNNING'};
  const {adapter,transport}=setup((url,init)=>{
   if(url.pathname==='/api/v2/conversations/cnv_real')return response(conversation());
   if(url.pathname.endsWith('/messages'))return response({records:[message('original_user',1)],hasNext:false});
   if(url.pathname.endsWith('/runs'))return new Promise(resolve=>finish=resolve);
   if(url.pathname.endsWith('/cancel')){expect(init.method).toBe('POST');cancelled=true;return response({...task,state:'CANCELED'});}
   if(url.pathname.endsWith('/runs/run_real'))return response({...task,state:cancelled?'CANCELED':'RUNNING'});
   if(url.pathname.endsWith('/events'))return response({items:[]});throw new Error('Unexpected '+url.pathname);
  });
  const state=nativeStore(),{load,stop,originalStopCalls}=callbacks(adapter,state);await load('cnv_real');await flush();await stop();expect(cancelled).toBe(false);
  finish(response({records:[task]}));for(let i=0;i<30&&(state.isLoading||state.isStreaming);i++)await flush();
  expect(cancelled).toBe(true);expect(originalStopCalls).not.toHaveBeenCalled();expect(state.addMessage).not.toHaveBeenCalled();expect(state).toMatchObject({isLoading:false,isStreaming:false});
  expect(transport.mock.calls.filter(([,init])=>init?.method==='POST')).toHaveLength(1);adapter.clear();
 });
});

describe('assistant logout boundary',()=>{
 it('discards an event body decoded after clear even when headers already arrived and the shared client stays alive',async()=>{
  let finish!:(value:any)=>void,reading=false,canceled=false;
  const {adapter}=setup(url=>{
   expect(url.pathname).toBe('/api/v2/assistant/conversations/cnv_real/runs/run_real/events');
   return new Response(new ReadableStream({
    start(controller){controller.enqueue(new TextEncoder().encode('{'));},
    pull(controller){reading=true;finish=value=>{if(!canceled){controller.enqueue(new TextEncoder().encode(JSON.stringify(value).slice(1)));controller.close();}};},
    cancel(){canceled=true;},
   }));
  });
  const updates:any[]=[],watching=adapter.watch({conversationId:'cnv_real',message:message('original_user',1),run:{id:'run_real',state:'RUNNING'}},update=>updates.push(update)),rejected=expect(watching).rejects.toMatchObject({name:'AbortError'});await flush();expect(reading).toBe(true);
  adapter.clear();finish({code:0,data:{items:[{sequence:1,type:'chat.delta',data:{text:'Late body'}}]}});await rejected;expect(canceled).toBe(true);expect(updates).toEqual([]);
 });
 it('aborts pending history and rejects late data after clear even when the transport resolves it',async()=>{
  let finish!:(response:Response)=>void;let pendingSignal:AbortSignal|undefined;
  const {adapter,api}=setup((_url,init)=>{pendingSignal=init.signal!;return new Promise(resolve=>finish=resolve);});
  const request=adapter.handle('/canvas/agent/cac/api/v1/sessions/cnv_real',{},'GET'),rejected=expect(request).rejects.toBeDefined();await flush();api.setAccessToken(null);adapter.clear();expect(pendingSignal!.aborted).toBe(true);finish(response(conversation(),200,'"1"'));await rejected;
 });
 it('closes native sockets, discards run ownership lookup and stops future calls after logout',async()=>{
  const {adapter,api,transport}=setup(()=>response({})),socket=adapter.socket('/agent-platform/api/v1/chat/stream')!;await flush();api.setAccessToken(null);adapter.clear();expect(socket.readyState).toBe(socket.CLOSED);
  await expect(adapter.handle('/canvas/openclaw/sessions/list',{})).rejects.toMatchObject({status:401});expect(transport).not.toHaveBeenCalled();
 });
});


describe('actual assistant lifecycle projection',()=>{
 it('deletes an actual entire turn with the current strong version and returns persisted deleted IDs',async()=>{
  const receipt={conversationId:'cnv_real',deletedMessageIds:['user_real','assistant_real'],conversationRevision:8,deletedAt:at};
  const {adapter,transport}=setup((url,init)=>{
   if(!init.method){expect(url.pathname).toBe('/api/v2/conversations/cnv_real');return response({...conversation(),revision:7},200,'"7"');}
   expect(url.pathname).toBe('/api/v2/conversations/cnv_real/turns/user_real');expect(init.method).toBe('DELETE');
   expect(new Headers(init.headers).get('If-Match')).toBe('"7"');expect(new Headers(init.headers).get('Idempotency-Key')).toMatch(/^[a-f0-9-]{36}$/);return response(receipt,200,'"8"');
  });
  expect(await adapter.handle('/canvas/openclaw/turns/delete',{sessionId:'cnv_real',turnId:'user_real'})).toEqual(receipt);expect(transport).toHaveBeenCalledTimes(2);
 });
 it('maps native single-message deletion and exposes current task conflicts without retries or fake deletion',async()=>{
  const {adapter,transport}=setup((url,init)=>{if(!init.method)return response(conversation(),200,'"1"');expect(url.pathname).toBe('/api/v2/conversations/cnv_real/messages/assistant_real');return failure(409,'ASSISTANT_TASK_ACTIVE','Turn is running');});
  await expect(adapter.handle('/canvas/api/message/delete',{sessionId:'cnv_real',messageId:'assistant_real'})).rejects.toMatchObject({status:409});expect(transport).toHaveBeenCalledTimes(2);
 });
 it('projects SQL absence for the actual session rather than making up a pending tool response',async()=>{
  const data={session_id:'cnv_real',status:'none',call:null,resume_command:null,active_resume:null,host_events:[],terminal_recovered:false};
  const {adapter,transport}=setup((url,init)=>{expect(url.pathname).toBe('/api/v2/conversations/cnv_real/client-tools/pending');expect(init.method).toBeUndefined();return response(data);});
  expect(await adapter.handle('/canvas/agent/cac/api/v1/chat/client-tools/pending?session_id=cnv_real',{},'GET')).toEqual(data);expect(transport).toHaveBeenCalledTimes(1);
 });
 it('preserves persisted unsupported tool evidence and foreign session failures',async()=>{
  const {adapter}=setup(()=>failure(501,'CLIENT_TOOLS_UNAVAILABLE','Actual tool evidence needs a provider adapter'));
  await expect(adapter.handle('/canvas/agent/cac/api/v1/chat/client-tools/pending',{session_id:'cnv_real'},'GET')).rejects.toMatchObject({status:501,code:'CLIENT_TOOLS_UNAVAILABLE'});
  const other=setup(()=>response({session_id:'foreign',status:'none',call:null,resume_command:null,active_resume:null,host_events:[],terminal_recovered:false}));
  await expect(other.adapter.handle('/canvas/agent/cac/api/v1/chat/client-tools/pending',{session_id:'cnv_real'},'GET')).rejects.toMatchObject({status:502});
 });
});

it('prefers a real LLM across pages and keeps the stored USER and requested capability version intact',async()=>{
 const real={capabilityRef:'codex-text-v1',kind:'LLM',executionKind:'AGENT',version:'1',available:true,testMode:false};
 const {adapter,transport}=setup((url,init,body)=>{
  if(url.pathname==='/api/v2/conversations/cnv_real')return response(conversation(),200,'"1"');
  if(url.pathname==='/api/v2/model-capabilities')return response(url.searchParams.has('cursor')?{items:[real],nextCursor:null}:{items:[{...real,capabilityRef:'mock-llm',testMode:true}],nextCursor:'page2'});
  if(url.pathname.endsWith('/messages')){expect(body).toEqual({content:[{type:'TEXT',text:' 保留原文 '}]});return response(message('stored-u',1,'USER',' 保留原文 '),201,'"2"');}
  expect(body).toEqual({capabilityRef:'codex-text-v1',capabilityVersion:'1',messageId:'stored-u',parameters:{}});return response({id:'task-real',kind:'ASSISTANT',state:'QUEUED',testMode:false,conversationId:'cnv_real'});
 });
 const run=await adapter.start({sessionId:'cnv_real',message:' 保留原文 '});expect(run.run.testMode).toBe(false);expect(transport.mock.calls.filter(([url])=>String(url).includes('model-capabilities'))).toHaveLength(2);adapter.clear();
});
