import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {decodeGraph,encodeGraph,type NativeGraph} from '../../apps/web/src/service/graph';
import {verifiedAccess} from './collaboration-fixtures';
import {MemoryDraftStorage} from './draft-journal-fixture';
import {applyCanvasOperations,type CanvasOperationBatch} from '../../apps/web/src/service/canvas-operations';

const {syncs}=vi.hoisted(()=>({syncs:[] as any[]}));
vi.mock('../../apps/web/src/config',()=>({config:{apiBase:'/api/v1',mode:'service'}}));
vi.mock('../../apps/web/src/api/auth',()=>({AuthSession:class {user:any=null;restore=async()=>false;onClear=()=>{};clear=vi.fn();},installNativeSessionBridge:()=>{}}));
vi.mock('../../apps/web/src/api/feishu-ui',()=>({installFeishuLogin:()=>({open:async()=>{}})}));
// Keep the existing lifecycle seams mocked; the scheduler, storage, draft
// journal, CAS requests and their API response decoding remain real.
vi.mock('../../apps/web/src/service/native-canvas-sync',()=>({REMOTE_CANVAS_ORIGIN:'remote',nativeCanvasSyncPort:(client:any)=>({available:()=>true,ready:()=>true,apply:(graph:NativeGraph)=>{client.graph=structuredClone(graph);return true;}})}));
vi.mock('../../apps/web/src/service/canvas-sync',()=>({CanvasSync:class {view:any;start=vi.fn();stop=vi.fn();constructor(_api:any,_storage:any,_id:string,view:any){this.view=view;syncs.push(this);}}}));

let cleanup:(()=>void)|undefined;
beforeEach(()=>{vi.resetModules();vi.useFakeTimers();syncs.length=0;});
afterEach(()=>{cleanup?.();cleanup=undefined;vi.clearAllTimers();vi.useRealTimers();vi.unstubAllGlobals();vi.restoreAllMocks();});
const reply=(data:any,status=200,etag?:string)=>new Response(JSON.stringify(status<400?{code:0,data}:{code:'SAVE_REJECTED',message:'保存暂不可用。'}),{status,headers:etag?{ETag:etag}:{}});
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return{promise,resolve};}
interface Put {projectId:string;graph:ReturnType<typeof encodeGraph>;etag:string|null;at:number}
async function setup(modern=false){
 const disk=new MemoryDraftStorage(),path={pathname:'/projects/',search:'',hash:'',replace:vi.fn()},notice=vi.fn(),puts:Put[]=[],servers=new Map<string,{revision:number;graph:ReturnType<typeof encodeGraph>}>();
 const surface=new EventTarget(),connection={onLine:true},posts:CanvasOperationBatch[]=[],receipts=new Map<string,any>();
 let operationHandler:((batch:CanvasOperationBatch)=>Response|Promise<Response>|undefined)|undefined;
 let putHandler:((put:Put)=>Response|Promise<Response>|undefined)|undefined;
 const snapshot=(id:string)=>{const server=servers.get(id)!;return{projectId:id,revision:server.revision,graph:structuredClone(server.graph),updatedAt:'2026-11-03T00:00:00Z'};};
 const operationReceipt=(id:string,batch:CanvasOperationBatch)=>{let receipt=receipts.get(batch.batchId);if(!receipt){const server=servers.get(id)!;server.graph=applyCanvasOperations(server.graph,batch.operations);server.revision++;receipt={...snapshot(id),batchId:batch.batchId,clientId:batch.clientId};receipts.set(batch.batchId,receipt);}return reply(receipt,200,'"'+receipt.revision+'"');};
 const commit=(put:Put)=>{const server=servers.get(put.projectId)!;if(put.etag!=='"'+server.revision+'"')return reply({},412);server.graph=structuredClone(put.graph);server.revision++;return reply(snapshot(put.projectId),200,'"'+server.revision+'"');};
 const transport=vi.fn(async(target:string,options:any={})=>{
  const operations=target.match(/^\/api\/v2\/projects\/([^/]+)\/canvas-operations$/);
  if(operations){const id=operations[1],batch=JSON.parse(options.body) as CanvasOperationBatch;posts.push(batch);const rejected=await operationHandler?.(batch);if(rejected)return rejected;return operationReceipt(id,batch);}
  const project=target.match(/^\/api\/v1\/projects\/([^/]+)\/snapshot$/);
  if(project){const id=project[1];if(options.method==='PUT'){const put={projectId:id,graph:JSON.parse(options.body).graph,etag:new Headers(options.headers).get('If-Match'),at:Date.now()};puts.push(put);return await putHandler?.(put)??commit(put);}const server=servers.get(id)!;return reply(snapshot(id),200,'"'+server.revision+'"');}
  const access=target.match(/^\/api\/v2\/collaboration\/projects\/([^/]+)\/access$/);if(access)return reply(verifiedAccess(access[1]));
  throw new Error('Unexpected protocol fixture request '+target);
 });
 vi.stubGlobal('location',path);vi.stubGlobal('window',Object.assign(surface,{fetch:transport,setTimeout,localStorage:disk,__RHTV_PREVIEW__:{notice}}));vi.stubGlobal('document',{addEventListener:vi.fn()});vi.stubGlobal('navigator',connection);vi.stubGlobal('localStorage',disk);
 const {serviceRuntime:runtime}=await import('../../apps/web/src/service/runtime');runtime.auth.user={id:'owner'} as any;runtime.api.setAccessToken('fixture-session-only');
 const clients=new Map<string,any>(),updates=new Map<string,()=>void>();
 for(const id of ['p','q']){
  const graph:NativeGraph={nodes:[{id:'n_'+id,type:'rh-text',position:{x:0,y:0},data:{text:'Original '+id}}],edges:[],meta:{id}};servers.set(id,{revision:1,graph:encodeGraph(graph)});runtime.storage.projects.set(id,{id,ownerId:'owner',name:'Fixture '+id,revision:1} as any);runtime.storage.rememberAccess(verifiedAccess(id));runtime.storage.acceptRemoteSnapshot(id,snapshot(id),'"1"');
  const client={roomId:id,graph:structuredClone(graph),ydoc:{on:vi.fn(),off:vi.fn()},getRemoteData(){return this.graph;},subscribe:vi.fn((callback:()=>void)=>{updates.set(id,callback);return()=>{updates.delete(id);};}),flushOperationQueue:vi.fn()};clients.set(id,client);
 }
 path.pathname='/project/canvas/p';runtime.attachCanvas('p',clients.get('p'));
 if(modern)runtime.setCanvasEditSession({projectId:'p',userId:'owner',clientId:'page',current:()=>true,holds:()=>true,ownsLease:()=>true,ensure:async()=>{}});
 cleanup=()=>{for(const id of clients.keys())runtime.storage.invalidateAccess(id);runtime.detachCanvas();};
 return{runtime,disk,path,puts,posts,surface,connection,transport,notice,commit,operationReceipt,client:(id='p')=>clients.get(id),server:(id='p')=>decodeGraph(servers.get(id)!.graph),setHandler:(handler:typeof putHandler)=>{putHandler=handler;},setOperationHandler:(handler:typeof operationHandler)=>{operationHandler=handler;},edit:(text:string,id='p')=>{clients.get(id).graph.nodes[0].data.text=text;updates.get(id)?.();},switchProject:(id:string)=>{path.pathname='/project/canvas/'+id;runtime.attachCanvas(id,clients.get(id));}};
}
const tick=async(milliseconds=0)=>{await vi.advanceTimersByTimeAsync(milliseconds);};

it.each(['headers','body'])('recovers a committed operation whose %s stalled, preserving its identity and later edits',async phase=>{
 const s=await setup(true),first=deferred<Response>(),cancel=vi.fn();let original!:Response;
 s.setOperationHandler(batch=>{
  if(s.posts.length!==1)return;
  original=s.operationReceipt('p',batch);
  if(phase==='headers')return first.promise;
  return new Response(new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new TextEncoder().encode('{"code":0,'));},cancel}));
 });
 s.edit('Already committed but response lost');await tick();s.edit('Latest text behind the lost receipt');await tick(15000);
 expect(s.runtime.storage.hasDraft('p')).toBe(true);expect(s.posts).toHaveLength(1);
 if(phase==='body')expect(cancel).toHaveBeenCalledOnce();
 await tick(1000);await s.runtime.waitForSave();
 expect(s.posts.length).toBeGreaterThanOrEqual(3);expect(s.posts[1]).toEqual(s.posts[0]);expect(s.posts[2].batchId).not.toBe(s.posts[0].batchId);
 expect(s.server().nodes[0].data.text).toBe('Latest text behind the lost receipt');expect(s.runtime.storage.hasDraft('p')).toBe(false);expect(s.puts).toHaveLength(0);
 if(phase==='headers'){first.resolve(original);await tick();expect(s.server().nodes[0].data.text).toBe('Latest text behind the lost receipt');}
});

it('does not cancel a slowly progressing 35-second operation receipt or duplicate its batch',async()=>{
 const s=await setup(true),encoder=new TextEncoder();
 s.setOperationHandler(async batch=>{
  const accepted=s.operationReceipt('p',batch),bytes=encoder.encode(await accepted.text());
  return new Response(new ReadableStream<Uint8Array>({start(controller){
   for(let index=0;index<8;index++)setTimeout(()=>{
    controller.enqueue(bytes.subarray(Math.floor(index*bytes.length/8),Math.floor((index+1)*bytes.length/8)));
    if(index===7)controller.close();
   },index*5000);
  }}),{headers:accepted.headers});
 });
 s.edit('Slow progressing response');await tick(35001);await s.runtime.waitForSave();
 expect(s.posts).toHaveLength(1);expect(s.runtime.storage.hasDraft('p')).toBe(false);expect(s.notice).not.toHaveBeenCalled();
});

it('fences a hung operation on leaving the canvas and does not retry from its old attachment',async()=>{
 const s=await setup(true);s.setOperationHandler(()=>new Promise(()=>{}));s.edit('Old page retains its input');await tick();
 s.runtime.setCanvasEditSession(null);s.switchProject('q');await tick(60000);
 expect(s.posts).toHaveLength(1);expect(s.runtime.storage.hasDraft('p')).toBe(true);expect(s.runtime.canvasAttachment()?.id).toBe('q');
});

it('saves an idle edit after 150ms while immediately retaining its recoverable local draft',async()=>{
 const s=await setup();s.edit('Idle edit');expect(s.runtime.storage.hasDraft('p')).toBe(true);expect(s.runtime.storage.draftRecoveryState('p').persistence).toBe('saved');expect(JSON.parse(s.runtime.storage.exportDraft('p')).graph.nodes[0].data.text).toBe('Idle edit');await tick(149);expect(s.puts).toHaveLength(0);await tick(1);expect(s.puts).toHaveLength(1);expect(s.puts[0].etag).toBe('"1"');expect(s.server().nodes[0].data.text).toBe('Idle edit');expect(s.runtime.storage.hasDraft('p')).toBe(false);
});
it('does not starve collaborators while edits arrive every 100ms for longer than the idle delay',async()=>{
 const s=await setup(),start=Date.now();for(let index=0;index<8;index++){s.edit('Continuous '+index);await tick(100);}expect(s.puts).toHaveLength(1);expect(s.puts[0].at-start).toBeLessThanOrEqual(800);expect(s.server().nodes[0].data.text).toBe('Continuous 7');expect(s.runtime.storage.hasDraft('p')).toBe(false);
});
it('retains ten edits behind a slow first PUT and sends only their latest graph next',async()=>{
 const s=await setup(),first=deferred<Response>();s.setHandler(()=>s.puts.length===1?first.promise:undefined);s.edit('First request');await tick(150);expect(s.puts).toHaveLength(1);for(let index=0;index<10;index++){s.edit('Latest '+index);await tick(100);}expect(s.puts).toHaveLength(1);expect(s.runtime.storage.draftRecoveryState('p').persistence).toBe('saved');expect(JSON.parse(s.runtime.storage.exportDraft('p')).graph.nodes[0].data.text).toBe('Latest 9');expect([...s.disk.rows.values()].some(value=>value.includes('Latest 9'))).toBe(true);
 first.resolve(s.commit(s.puts[0]));await tick();expect(s.puts).toHaveLength(1);await tick(149);expect(s.puts).toHaveLength(1);await tick(1);expect(s.puts).toHaveLength(2);expect(s.puts.map(put=>put.etag)).toEqual(['"1"','"2"']);expect(decodeGraph(s.puts[1].graph).nodes[0].data.text).toBe('Latest 9');expect(s.server().nodes[0].data.text).toBe('Latest 9');expect(s.runtime.storage.hasDraft('p')).toBe(false);await tick(1000);expect(s.puts).toHaveLength(2);
});
it('recovers from one 503 after one second without requiring another edit',async()=>{
 const s=await setup();s.setHandler(()=>s.puts.length===1?reply({},503):undefined);s.edit('Retry this draft');await tick(150);expect(s.puts).toHaveLength(1);expect(s.runtime.storage.hasDraft('p')).toBe(true);expect(s.runtime.storage.draftRecoveryState('p').persistence).toBe('saved');await tick(999);expect(s.puts).toHaveLength(1);await tick(1);expect(s.puts).toHaveLength(2);expect(s.puts.map(put=>put.etag)).toEqual(['"1"','"1"']);expect(s.server().nodes[0].data.text).toBe('Retry this draft');expect(s.runtime.storage.hasDraft('p')).toBe(false);
});
it('limits automatic 503 retries to three attempts at one, two and five second intervals',async()=>{
 const s=await setup(),start=Date.now();s.setHandler(()=>reply({},503));s.edit('Retain after exhaustion');await tick(150);for(const delay of [1000,2000,5000]){const prior=s.puts.length;await tick(delay-1);expect(s.puts).toHaveLength(prior);await tick(1);expect(s.puts).toHaveLength(prior+1);}expect(s.puts.map(put=>put.at-start)).toEqual([150,1150,3150,8150]);await tick(10000);expect(s.puts).toHaveLength(4);expect(s.runtime.storage.draftRecoveryState('p').persistence).toBe('saved');expect(JSON.parse(s.runtime.storage.exportDraft('p')).graph.nodes[0].data.text).toBe('Retain after exhaustion');expect(s.server().nodes[0].data.text).toBe('Original p');
});
it.each([408,429,500,502,504])('retries a temporary %s response while preserving the original CAS base',async status=>{
 const s=await setup();s.setHandler(()=>s.puts.length===1?reply({},status):undefined);s.edit('Temporary '+status);await tick(150);await tick(1000);expect(s.puts).toHaveLength(2);expect(s.puts.map(put=>put.etag)).toEqual(['"1"','"1"']);expect(s.server().nodes[0].data.text).toBe('Temporary '+status);expect(s.runtime.storage.hasDraft('p')).toBe(false);
});
it('retries a transport TypeError without losing its durable draft',async()=>{
 const s=await setup();s.setHandler(()=>{if(s.puts.length===1)throw new TypeError('fixture network unavailable');});s.edit('Network retry');await tick(150);expect(s.runtime.storage.draftRecoveryState('p').persistence).toBe('saved');await tick(1000);expect(s.puts).toHaveLength(2);expect(s.server().nodes[0].data.text).toBe('Network retry');expect(s.runtime.storage.hasDraft('p')).toBe(false);
});
it.each([403,409,422,501,507])('does not repeatedly submit an unresolved %s response',async status=>{
 const s=await setup();s.setHandler(()=>reply({},status));s.edit('Needs user decision '+status);await tick(150);await tick(10000);expect(s.puts).toHaveLength(1);expect(s.runtime.storage.draftRecoveryState('p').persistence).toBe('saved');expect(JSON.parse(s.runtime.storage.exportDraft('p')).graph.nodes[0].data.text).toBe('Needs user decision '+status);
});
it('cancels retries for the departed project after its final detach save barrier',async()=>{
 const s=await setup();s.setHandler(put=>put.projectId==='p'?reply({},503):undefined);s.edit('Old project draft');await tick(150);expect(s.puts).toHaveLength(1);s.switchProject('q');await tick();expect(s.puts.filter(put=>put.projectId==='p')).toHaveLength(2);s.edit('New project edit','q');await tick(150);await tick(10000);expect(s.puts.filter(put=>put.projectId==='p')).toHaveLength(2);expect(s.puts.filter(put=>put.projectId==='q')).toHaveLength(1);expect(s.server('q').nodes[0].data.text).toBe('New project edit');expect(s.runtime.canvasAttachment()?.id).toBe('q');expect(s.runtime.storage.draft('p')!.nodes[0].data.text).toBe('Old project draft');
});
it('cancels a scheduled retry when editing permission is revoked and retains the local draft',async()=>{
 const s=await setup();s.setHandler(()=>reply({},503));s.edit('Draft before revoke');await tick(150);s.runtime.storage.rememberAccess(verifiedAccess('p','VIEWER','owner',2));await tick(10000);expect(s.puts).toHaveLength(1);expect(s.runtime.storage.canEdit('p')).toBe(false);expect(s.runtime.storage.draftRecoveryState('p').persistence).toBe('saved');expect(JSON.parse(s.runtime.storage.exportDraft('p')).graph.nodes[0].data.text).toBe('Draft before revoke');
});
it('waitForSave includes the latest edit made behind an in-flight autosave',async()=>{
 const s=await setup(),first=deferred<Response>();s.setHandler(()=>s.puts.length===1?first.promise:undefined);s.edit('In flight');await tick(150);s.edit('Latest explicit barrier');let finished=false;const saving=s.runtime.waitForSave().then(()=>{finished=true;});await tick();expect(finished).toBe(false);expect(s.puts).toHaveLength(1);first.resolve(s.commit(s.puts[0]));await saving;expect(finished).toBe(true);expect(s.puts).toHaveLength(2);expect(s.puts.map(put=>put.etag)).toEqual(['"1"','"2"']);expect(s.server().nodes[0].data.text).toBe('Latest explicit barrier');expect(s.runtime.storage.hasDraft('p')).toBe(false);await tick(1000);expect(s.puts).toHaveLength(2);
});
it('detaches with a forced latest-edit barrier behind the in-flight save and never schedules further retries',async()=>{
 const s=await setup(),first=deferred<Response>();s.setHandler(()=>s.puts.length===1?first.promise:undefined);s.edit('First request');await tick(150);s.edit('Last edit before exit');s.runtime.detachCanvas();expect(s.runtime.canvasAttachment()).toBeNull();expect(s.runtime.storage.hasDraft('p')).toBe(true);first.resolve(s.commit(s.puts[0]));await s.runtime.storage.wait('p');expect(s.puts).toHaveLength(2);expect(s.server().nodes[0].data.text).toBe('Last edit before exit');expect(s.runtime.storage.hasDraft('p')).toBe(false);await tick(10000);expect(s.puts).toHaveLength(2);
});

it('keeps retrying a transient operation save after the initial burst and drains without another edit',async()=>{
 const s=await setup(true);let available=false;s.setOperationHandler(()=>available?undefined:reply({},503));s.edit('Survives an extended write outage');await tick();
 for(const delay of [1000,2000,5000])await tick(delay);
 expect(s.posts).toHaveLength(4);expect(s.runtime.storage.draftRecoveryState('p')).toMatchObject({blocked:false,persistence:'saved'});expect(s.notice).not.toHaveBeenCalled();
 // Permission and read traffic are deliberately not used to wake this save.
 vi.spyOn(s.runtime.storage,'refreshAccess').mockImplementation(async()=>verifiedAccess('p'));
 available=true;await tick(10000);expect(s.posts).toHaveLength(5);
 expect(new Set(s.posts.map(batch=>batch.batchId)).size).toBe(1);expect(s.posts.every(batch=>JSON.stringify(batch)===JSON.stringify(s.posts[0]))).toBe(true);
 expect(s.server().nodes[0].data.text).toBe('Survives an extended write outage');expect(s.runtime.storage.hasDraft('p')).toBe(false);expect(s.puts).toHaveLength(0);
 expect(s.notice).not.toHaveBeenCalled();
});

it('keeps offline edits on device without requests or repeated errors, then sends once when online returns',async()=>{
 const s=await setup(true);s.connection.onLine=false;s.surface.dispatchEvent(new Event('offline'));s.edit('Offline retained input');await tick(10000);
 expect(s.posts).toHaveLength(0);expect(s.runtime.storage.hasDraft('p')).toBe(true);expect(s.notice).not.toHaveBeenCalled();
 s.connection.onLine=true;s.surface.dispatchEvent(new Event('online'));s.surface.dispatchEvent(new Event('online'));await tick();
 expect(s.posts).toHaveLength(1);expect(s.server().nodes[0].data.text).toBe('Offline retained input');expect(s.runtime.storage.hasDraft('p')).toBe(false);
});

it('cancels an operation retry after the canvas becomes read-only',async()=>{
 const s=await setup(true);s.setOperationHandler(()=>reply({},503));s.edit('Protected on revocation');await tick();expect(s.posts).toHaveLength(1);
 s.runtime.storage.rememberAccess(verifiedAccess('p','VIEWER','owner',2));await tick(10000);expect(s.posts).toHaveLength(1);expect(s.runtime.storage.hasDraft('p')).toBe(true);
});

it.each([403,409,422])('does not resubmit a refused operation during healthy permission polling (%s)',async status=>{
 const s=await setup(true);s.setOperationHandler(()=>reply({},status));s.edit('Original refused input');await tick();expect(s.posts).toHaveLength(1);
 const original=structuredClone(s.posts[0]);await tick(45000);expect(s.posts).toHaveLength(1);expect(s.runtime.storage.hasDraft('p')).toBe(true);
 // Another edit may request one retry, but it cannot rewrite or skip a sealed
 // batch whose original receipt identity must remain recoverable.
 s.edit('Later authored input');await tick();expect(s.posts).toHaveLength(2);expect(s.posts[1]).toEqual(original);await tick(45000);expect(s.posts).toHaveLength(2);
 await expect(s.runtime.retryCanvasSync()).rejects.toMatchObject({code:'CANVAS_SYNC_PENDING'});expect(s.posts).toHaveLength(3);expect(s.posts[2]).toEqual(original);await tick(45000);expect(s.posts).toHaveLength(3);
 expect(s.server().nodes[0].data.text).toBe('Original p');expect(s.runtime.storage.draft('p')?.nodes[0].data.text).toBe('Later authored input');
});

it.each([
 [200,'<html>Temporary proxy page</html>'],
 [200,'{"code":0,"data":'],
 [403,'<html>Proxy access page without a service denial</html>'],
])('retries a malformed operation response with HTTP %s using the original queued batch',async(status,body)=>{
 const s=await setup(true);s.setOperationHandler(()=>s.posts.length===1?new Response(body,{status}):undefined);s.edit('Retained through malformed proxy response');await tick();
 expect(s.posts).toHaveLength(1);expect(s.runtime.storage.draftRecoveryState('p')).toMatchObject({blocked:false,persistence:'saved'});expect(s.notice).not.toHaveBeenCalled();
 await tick(1000);expect(s.posts).toHaveLength(2);expect(s.posts[1]).toEqual(s.posts[0]);expect(s.runtime.storage.hasDraft('p')).toBe(false);
 expect(s.server().nodes[0].data.text).toBe('Retained through malformed proxy response');expect(s.puts).toHaveLength(0);
});

it('announces a prolonged write-only outage once, keeps retrying, and resets that notice after saving',async()=>{
 const s=await setup(true);let available=false;s.setOperationHandler(()=>available?undefined:reply({},503));s.edit('First prolonged outage');await tick(65000);
 expect(s.notice.mock.calls).toEqual([['修改已保留，正在等待连接恢复后自动保存。']]);expect(s.posts.length).toBeGreaterThan(5);expect(s.runtime.storage.draftRecoveryState('p')).toMatchObject({blocked:false,persistence:'saved'});
 const firstBatch=s.posts[0].batchId;expect(s.posts.every(batch=>batch.batchId===firstBatch)).toBe(true);
 available=true;await tick(15000);expect(s.runtime.storage.hasDraft('p')).toBe(false);expect(s.server().nodes[0].data.text).toBe('First prolonged outage');expect(s.notice).toHaveBeenCalledOnce();
 available=false;s.edit('Second prolonged outage');await tick(65000);
 expect(s.notice.mock.calls).toEqual([['修改已保留，正在等待连接恢复后自动保存。'],['修改已保留，正在等待连接恢复后自动保存。']]);expect(s.posts.at(-1)!.batchId).not.toBe(firstBatch);expect(s.runtime.storage.hasDraft('p')).toBe(true);
});
