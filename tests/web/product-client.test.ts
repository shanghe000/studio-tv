import {expect,it,vi} from 'vitest';
import {ProductClient} from '../../apps/web/src/service/product-client';
const response=(data:any,status=200)=>new Response(JSON.stringify({code:0,data}),{status});
it('shares the memory token and raw transport across STUDIO API versions only',async()=>{
 const transport=vi.fn().mockResolvedValue(response({id:'persisted'}));const api=new ProductClient('/api/v1',transport);api.setAccessToken('session');
 await api.requestV2('/conversations',{method:'POST',body:{title:'own'},headers:{Authorization:'Bearer foreign','X-Router-Subject-Ref':'foreign','X-Workspace-Id':'other'},idempotencyKey:'uuid'});
 const [url,init]=transport.mock.calls[0];expect(url).toBe('/api/v2/conversations');expect(init.headers.get('Authorization')).toBe('Bearer session');expect(init.headers.has('X-Router-Subject-Ref')).toBe(false);expect(init.headers.has('X-Workspace-Id')).toBe(false);expect(init.redirect).toBe('error');
 await expect(api.requestV2('https://router.invalid/run')).rejects.toThrow('relative');await expect(api.rawV2('/../secrets')).rejects.toThrow('relative');expect(transport).toHaveBeenCalledOnce();
});
it('aborts pending requests and rejects late responses after logout',async()=>{
 let release!:(response:Response)=>void;const transport=vi.fn().mockImplementation(()=>new Promise(done=>release=done));const api=new ProductClient('/api/v1',transport);api.setAccessToken('owner');
 const pending=api.requestV2('/tasks/task');const rejected=expect(pending).rejects.toMatchObject({code:'SESSION_CHANGED'});api.setAccessToken(null);api.clearRequests();release(response({id:'late'}));await rejected;expect(transport.mock.calls[0][1].signal.aborted).toBe(true);await expect(api.rawV2('/tasks/task')).rejects.toMatchObject({status:401});
});
it('clears revoked sessions without retrying with a browser-supplied identity',async()=>{
 const transport=vi.fn().mockResolvedValue(new Response(JSON.stringify({error:{code:'UNAUTHORIZED',message:'revoked'}}),{status:401}));const api=new ProductClient('/api/v1',transport);api.setAccessToken('revoked');const revoke=vi.fn(()=>{api.setAccessToken(null);api.clearRequests();});api.onRevoked(revoke);
 await expect(api.requestV2('/tags')).rejects.toMatchObject({status:401});expect(revoke).toHaveBeenCalled();expect(transport).toHaveBeenCalledOnce();
});

it('does not refresh or revoke a replacement identity when an old v1 response completes late',async()=>{
 let release!:(value:Response)=>void;const transport=vi.fn().mockImplementation(()=>new Promise<Response>(done=>release=done)),api=new ProductClient('/api/v1',transport);api.setAccessToken('old');const revoke=vi.fn(),refresh=vi.fn().mockResolvedValue(true);api.onRevoked(revoke);api.onRefresh(refresh);
 const pending=api.request('/projects/p'),rejected=expect(pending).rejects.toMatchObject({code:'SESSION_CHANGED'});api.clearRequests();api.setAccessToken('new');release(new Response(JSON.stringify({error:{code:'UNAUTHORIZED',message:'old revoked'}}),{status:401}));await rejected;expect(refresh).not.toHaveBeenCalled();expect(revoke).not.toHaveBeenCalled();expect(api.getAccessToken()).toBe('new');
});

it('refreshes a current v1 session once and retries with the current memory token',async()=>{
 const transport=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({error:{code:'UNAUTHORIZED',message:'expired'}}),{status:401})).mockResolvedValueOnce(response({id:'p'})),api=new ProductClient('/api/v1',transport);api.setAccessToken('expired');const refresh=vi.fn(async()=>{api.setAccessToken('rotated');return true;}),revoke=vi.fn();api.onRefresh(refresh);api.onRevoked(revoke);
 expect((await api.request('/projects/p')).data).toEqual({id:'p'});expect(refresh).toHaveBeenCalledOnce();expect(revoke).not.toHaveBeenCalled();expect(transport.mock.calls[1][1].headers.get('Authorization')).toBe('Bearer rotated');
});

it('refreshes v2 through the shared login manager while preserving mutation body and idempotency',async()=>{
 const transport=vi.fn().mockResolvedValueOnce(new Response('{}',{status:401})).mockResolvedValueOnce(response({id:'receipt'}));
 const api=new ProductClient('/api/v1',transport);api.setAccessToken('expired');const revoke=vi.fn();api.onRevoked(revoke);
 const refresh=vi.fn(async()=>{api.setAccessToken('rotated');return true;});api.onRefresh(refresh);
 expect((await api.requestV2('/projects/p/canvas-commands',{method:'POST',body:{operations:[]},etag:'"4"',idempotencyKey:'same-key'})).data).toEqual({id:'receipt'});
 expect(refresh).toHaveBeenCalledOnce();expect(revoke).not.toHaveBeenCalled();expect(transport).toHaveBeenCalledTimes(2);
 const first=transport.mock.calls[0][1],second=transport.mock.calls[1][1];expect(second.body).toBe(first.body);expect(second.headers.get('If-Match')).toBe('"4"');expect(second.headers.get('Idempotency-Key')).toBe('same-key');expect(second.headers.get('Authorization')).toBe('Bearer rotated');
});
it('does not refresh or revoke a replacement user after a late v2 401',async()=>{
 let release!:(value:Response)=>void;const transport=vi.fn().mockImplementation(()=>new Promise<Response>(done=>release=done));
 const api=new ProductClient('/api/v1',transport);api.setAccessToken('old');const refresh=vi.fn().mockResolvedValue(true),revoke=vi.fn();api.onRefresh(refresh);api.onRevoked(revoke);
 const pending=api.requestV2('/projects/p/agent-context'),rejected=expect(pending).rejects.toMatchObject({code:'SESSION_CHANGED'});
 api.clearRequests();api.setAccessToken('new');release(new Response('{}',{status:401}));await rejected;expect(refresh).not.toHaveBeenCalled();expect(revoke).not.toHaveBeenCalled();
});
it('keeps a v2 mutation from being retried if the login changes during refresh',async()=>{
 const transport=vi.fn().mockResolvedValue(new Response('{}',{status:401})),api=new ProductClient('/api/v1',transport);api.setAccessToken('old');
 api.onRefresh(async()=>{api.clearRequests();api.setAccessToken('other-user');return true;});
 await expect(api.requestV2('/conversations',{method:'POST',body:{title:'new'}})).rejects.toMatchObject({code:'SESSION_CHANGED'});expect(transport).toHaveBeenCalledOnce();
});
it('does not retry v2 again after failed refresh or explicit retryAuth=false',async()=>{
 const transport=vi.fn().mockImplementation(()=>Promise.resolve(new Response('{}',{status:401}))),api=new ProductClient('/api/v1',transport);api.setAccessToken('expired');const refresh=vi.fn().mockResolvedValue(false);api.onRefresh(refresh);
 await expect(api.requestV2('/tags',{retryAuth:false})).rejects.toMatchObject({status:401});expect(refresh).not.toHaveBeenCalled();
 await expect(api.requestV2('/tags')).rejects.toMatchObject({status:401});expect(refresh).toHaveBeenCalledOnce();expect(transport).toHaveBeenCalledTimes(2);
});

it('uses the unified refresh manager for Agent auth recovery without returning credentials',async()=>{
 const api=new ProductClient('/api/v1',vi.fn());api.setAccessToken('owner');const refresh=vi.fn(async()=>{api.setAccessToken('current');return true;});api.onRefresh(refresh);
 expect(await api.refreshAccess()).toBe(true);expect(refresh).toHaveBeenCalledOnce();expect(api.getAccessToken()).toBe('current');
});
it('rejects Agent auth recovery if the login changes during the shared refresh',async()=>{
 const api=new ProductClient('/api/v1',vi.fn());api.setAccessToken('old');api.onRefresh(async()=>{api.clearRequests();api.setAccessToken('replacement');return true;});
 await expect(api.refreshAccess()).rejects.toMatchObject({code:'SESSION_CHANGED'});expect(api.getAccessToken()).toBe('replacement');
});

it.each(['v1','v2'])('retries a late old Bearer 401 once with an already rotated token without rotating the cookie again (%s)',async(version)=>{
 let release!:(value:Response)=>void;const transport=vi.fn().mockImplementationOnce(()=>new Promise<Response>(done=>release=done)).mockResolvedValueOnce(response({id:'same-project'})),api=new ProductClient('/api/v1',transport);api.setAccessToken('old-token');const refresh=vi.fn().mockResolvedValue(true),revoke=vi.fn();api.onRefresh(refresh);api.onRevoked(revoke);
 const oldProof='old-proof-'.repeat(4);api.setCanvasSession('p','original',oldProof,'first-term');
 const pending=version==='v1'?api.request('/projects/p',{method:'PATCH',body:{name:'Viewed name'},etag:'"8"',idempotencyKey:'same-logical-mutation'}):api.requestV2('/projects/p/canvas-commands',{method:'POST',body:{operations:[]},etag:'"8"',idempotencyKey:'same-logical-mutation'});api.setCanvasSession('p','original',oldProof,'later-term');api.setAccessToken('already-rotated-token');release(new Response(JSON.stringify({code:'UNAUTHORIZED',message:'old access expired'}),{status:401}));expect((await pending).data).toEqual({id:'same-project'});expect(refresh).not.toHaveBeenCalled();expect(revoke).not.toHaveBeenCalled();const first=transport.mock.calls[0][1],second=transport.mock.calls[1][1];expect(second.headers.get('X-STUDIO-Canvas-Session')).toBe('original');expect(second.headers.get('X-STUDIO-Canvas-Proof')).toBe(oldProof);expect(second.headers.get('X-STUDIO-Canvas-Lease')).toBe('first-term');expect(second.headers.get('Authorization')).toBe('Bearer already-rotated-token');expect(second.headers.get('If-Match')).toBe('"8"');expect(second.headers.get('Idempotency-Key')).toBe('same-logical-mutation');expect(second.body).toBe(first.body);expect(transport).toHaveBeenCalledTimes(2);
});

it.each(['cleared','replacement'])('retains an exact old edit-session release after the canvas session map is %s',async state=>{
 const transport=vi.fn(async()=>response({released:true})),api=new ProductClient('/api/v1',transport);api.setAccessToken('owner');api.setCanvasSession('p',state==='replacement'?'new-page':null);await api.requestV2('/projects/p/edit-session',{method:'DELETE',body:{clientId:'old-page'},headers:{'X-STUDIO-Canvas-Session':'old-page'},keepalive:true,retryAuth:false});expect(transport.mock.calls[0][1].headers.get('X-STUDIO-Canvas-Session')).toBe('old-page');expect(transport.mock.calls[0][1].keepalive).toBe(true);
});
it.each(['/projects/p/snapshot','/projects/p/canvas-operations','/projects/p/edit-session/other'])('does not preserve an explicit retired page header on another mutation route %s',async path=>{
 const transport=vi.fn(async()=>response({})),api=new ProductClient('/api/v1',transport);api.setAccessToken('owner');await api.requestV2(path,{method:'DELETE',body:{clientId:'old-page'},headers:{'X-STUDIO-Canvas-Session':'old-page'}});expect(transport.mock.calls[0][1].headers.has('X-STUDIO-Canvas-Session')).toBe(false);
});
it.each(['mismatch','invalid'])('drops an explicit edit-session cleanup identity when its body is %s',async kind=>{
 const transport=vi.fn(async()=>response({})),api=new ProductClient('/api/v1',transport);api.setAccessToken('owner');api.setCanvasSession('p','new-page');await api.requestV2('/projects/p/edit-session',{method:'DELETE',body:{clientId:kind==='invalid'?'bad page':'another-page'},headers:{'X-STUDIO-Canvas-Session':kind==='invalid'?'bad page':'old-page'}});expect(transport.mock.calls[0][1].headers.has('X-STUDIO-Canvas-Session')).toBe(false);
});

it.each([
 ['POST','/tasks/t/cancel'],['POST','/media-jobs/t/cancel'],['POST','/assistant-runs/t/cancel'],
 ['POST','/history/delete'],['DELETE','/history/e/outputs/o'],
 ['POST','/conversations/c/agent-runs'],['PUT','/agent-runs/r/auth-context'],['POST','/agent-runs/r/cancel'],
])('binds opaque canvas mutations to the single local page (%s %s)',async(method,path)=>{
 const transport=vi.fn(async()=>response({})),api=new ProductClient('/api/v1',transport);api.setAccessToken('owner');
 const send=()=>api.requestV2(path,{method,body:{},headers:{'X-STUDIO-Canvas-Session':'unrelated-page','X-STUDIO-Canvas-Proof':'not-current','X-STUDIO-Canvas-Lease':'retired'}});
 const proof='p'.repeat(43);api.setCanvasSession('p','local-page',proof,'held-term');await send();
 expect(transport.mock.calls.at(-1)![1].headers.get('X-STUDIO-Canvas-Proof')).toBe(proof);
 expect(transport.mock.calls.at(-1)![1].headers.get('X-STUDIO-Canvas-Lease')).toBe('held-term');
 expect(transport.mock.calls.at(-1)![1].headers.get('X-STUDIO-Canvas-Session')).toBe('local-page');
 api.setCanvasSession('another','other-project-page');await send();
 expect(transport.mock.calls.at(-1)![1].headers.has('X-STUDIO-Canvas-Session')).toBe(false);
 expect(transport.mock.calls.at(-1)![1].headers.has('X-STUDIO-Canvas-Proof')).toBe(false);
 expect(transport.mock.calls.at(-1)![1].headers.has('X-STUDIO-Canvas-Lease')).toBe(false);
});

it('preserves a matched control request before the page is registered and its own release after replacement',async()=>{
 const transport=vi.fn(async()=>response({})),api=new ProductClient('/api/v1',transport);api.setAccessToken('owner');
 const proof='old-proof-'.repeat(4),body={clientId:'old',pageProof:proof,leaseId:'original-term'},headers={'X-STUDIO-Canvas-Session':'old','X-STUDIO-Canvas-Proof':proof};
 await api.requestV2('/projects/p/edit-session',{method:'POST',body,headers});
 expect(transport.mock.calls.at(-1)![1].headers.get('X-STUDIO-Canvas-Proof')).toBe(proof);
 api.setCanvasSession('p','replacement','new-proof-'.repeat(4));
 await api.requestV2('/projects/p/edit-session',{method:'DELETE',body,headers});
 expect(transport.mock.calls.at(-1)![1].headers.get('X-STUDIO-Canvas-Lease')).toBe('original-term');
 expect(transport.mock.calls.at(-1)![1].headers.get('X-STUDIO-Canvas-Proof')).toBe(proof);
 await api.requestV2('/projects/p/edit-session',{method:'DELETE',body:{...body,pageProof:'other'},headers});
 expect(transport.mock.calls.at(-1)![1].headers.has('X-STUDIO-Canvas-Proof')).toBe(false);
});

function pausedJson(status=200){
 let started!:()=>void;
 const reading=new Promise<void>(resolve=>{started=resolve;}),cancel=vi.fn();
 const body=new ReadableStream<Uint8Array>({
  start(controller){controller.enqueue(new TextEncoder().encode(status===200?'{"code":0,"data":':'{"code":"ACCESS_REVOKED","message":"'));},
  pull(){started();},cancel,
 });
 return{response:new Response(body,{status,headers:{'Content-Type':'application/json'}}),reading,cancel};
}
const bodyMethods=['envelope','raw','multipart','decode'] as const;
function requestBody(api:ProductClient,method:typeof bodyMethods[number],signal?:AbortSignal){
 if(method==='raw')return api.requestRawJsonV2('/test',{signal});
 if(method==='multipart')return api.multipartV2('/test',new FormData(),'key',signal);
 if(method==='decode')return api.rawV2('/test',{signal}).then(response=>api.decodeV2Response(response));
 return api.requestV2('/test',{signal});
}

it.each(bodyMethods)('cancels an unfinished %s JSON body after headers when its caller aborts',async method=>{
 const source=pausedJson(),api=new ProductClient('/api/v1',vi.fn().mockResolvedValue(source.response)),controller=new AbortController();api.setAccessToken('owner');
 const rejected=expect(requestBody(api,method,controller.signal)).rejects.toMatchObject({name:'AbortError'});
 await source.reading;controller.abort();await rejected;expect(source.cancel).toHaveBeenCalledOnce();expect(source.response.body?.locked).toBe(false);
});
it.each(bodyMethods)('stops a stalled %s JSON body at the caller deadline without waiting for the server',async method=>{
 const source=pausedJson(),api=new ProductClient('/api/v1',vi.fn().mockResolvedValue(source.response)),controller=new AbortController();api.setAccessToken('owner');
 const rejected=expect(requestBody(api,method,controller.signal)).rejects.toMatchObject({name:'TimeoutError'});
 await source.reading;const timer=setTimeout(()=>controller.abort(new DOMException('Read timed out','TimeoutError')),1);
 try{await rejected;expect(source.cancel).toHaveBeenCalledOnce();}finally{clearTimeout(timer);}
});
it('does not await a stalled underlying stream cancel before releasing a canceled body read',async()=>{
 const source=pausedJson(),api=new ProductClient('/api/v1',vi.fn().mockResolvedValue(source.response)),controller=new AbortController();api.setAccessToken('owner');
 source.cancel.mockImplementation(()=>new Promise(()=>{}));
 const rejected=expect(api.requestV2('/test',{signal:controller.signal})).rejects.toMatchObject({name:'AbortError'});
 await source.reading;controller.abort();await rejected;expect(source.response.body?.locked).toBe(false);
});
it.each(bodyMethods)('cancels a late %s 403 body on account replacement and never revokes the new account',async method=>{
 const source=pausedJson(403),api=new ProductClient('/api/v1',vi.fn().mockResolvedValue(source.response)),revoke=vi.fn();api.setAccessToken('old');api.onRevoked(revoke);
 const rejected=expect(requestBody(api,method)).rejects.toMatchObject({code:'SESSION_CHANGED'});
 await source.reading;api.clearRequests();api.setAccessToken('replacement');await rejected;
 expect(source.cancel).toHaveBeenCalledOnce();expect(revoke).not.toHaveBeenCalled();expect(api.getAccessToken()).toBe('replacement');
});
it('retains the raw response identity even if decoding starts only after an account change',async()=>{
 const cancel=vi.fn(),oldResponse=new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('{"code":"ACCESS_REVOKED","message":"old"}'));},cancel}),{status:403});
 const api=new ProductClient('/api/v1',vi.fn().mockResolvedValue(oldResponse)),revoke=vi.fn();api.setAccessToken('old');api.onRevoked(revoke);
 const received=await api.rawV2('/test');api.clearRequests();api.setAccessToken('replacement');
 await expect(api.decodeV2Response(received)).rejects.toMatchObject({code:'SESSION_CHANGED'});expect(revoke).not.toHaveBeenCalled();expect(cancel).toHaveBeenCalledOnce();
});
it.each(['request','decoder'])('honors the %s abort signal when an external decoder adds its own deadline',async which=>{
 const source=pausedJson(),api=new ProductClient('/api/v1',vi.fn().mockResolvedValue(source.response)),request=new AbortController(),decoder=new AbortController();api.setAccessToken('owner');
 const received=await api.rawV2('/test',{signal:request.signal});const rejected=expect(api.decodeV2Response(received,decoder.signal)).rejects.toMatchObject({name:'AbortError'});
 await source.reading;(which==='request'?request:decoder).abort();await rejected;expect(source.cancel).toHaveBeenCalledOnce();
});
it('decodes full graph-sized bodies without the event-frame size limit and preserves split UTF-8 text',async()=>{
 const data={text:'节点'.repeat(1100000)},bytes=new TextEncoder().encode('\ufeff'+JSON.stringify({code:0,data}));
 const body=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(bytes.subarray(0,23));controller.enqueue(bytes.subarray(23));controller.close();}});
 const api=new ProductClient('/api/v1',vi.fn().mockResolvedValue(new Response(body,{headers:{ETag:'"9"','X-STUDIO-Canvas-Update':'delta-v1','X-STUDIO-Canvas-Room':'ws-v1'}})));api.setAccessToken('owner');
 expect(await api.requestV2('/projects/p/live-snapshot')).toEqual({data,etag:'"9"',status:200,canvasDelta:true,canvasRoom:true});
});
it.each(['request','decoder','v1'])('reports actual %s read progress for a thirty-second response without passing callbacks to fetch',async kind=>{
 vi.useFakeTimers();vi.setSystemTime(0);
 try{
  const arrivals:number[]=[],progress=vi.fn(()=>arrivals.push(Date.now())),encoder=new TextEncoder();
  const body=new ReadableStream<Uint8Array>({start(controller){
   for(const [at,chunk]of [[0,'{'],[10000,'"code":0,"data":'],[15000,''],[20000,'{'],[30000,'"n":"节点"}}']] as const)
    setTimeout(()=>{controller.enqueue(encoder.encode(chunk));if(at===30000)controller.close();},at);
  }});
  const transport=vi.fn().mockResolvedValue(new Response(body)),api=new ProductClient('/api/v1',transport);api.setAccessToken('owner');
  const pending=kind==='v1'?api.request('/test',{onReadProgress:progress}):kind==='request'?api.requestV2('/test',{onReadProgress:progress}):api.rawV2('/test').then(response=>api.decodeV2Response(response,undefined,progress));
  await vi.advanceTimersByTimeAsync(30000);
  expect((await pending).data).toEqual({n:'节点'});
  // Headers and the initial chunk both arrive at zero; an empty chunk at
  // fifteen seconds cannot masquerade as continuing body progress.
  expect(arrivals).toEqual([0,0,10000,20000,30000]);
  expect(transport.mock.calls[0][1]).not.toHaveProperty('onReadProgress');
 }finally{vi.useRealTimers();}
});
