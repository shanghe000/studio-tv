import {afterEach,expect,it,vi} from 'vitest';
import {ServiceStorage} from '../../apps/web/src/service/storage';
import {ProductClient} from '../../apps/web/src/service/product-client';
import {applyCanvasOperations,type CanvasOperationBatch} from '../../apps/web/src/service/canvas-operations';
import {decodeGraph,encodeGraph,type NativeGraph} from '../../apps/web/src/service/graph';
import type {Asset,Snapshot} from '../../apps/web/src/api/types';
import {verifiedAccess} from './collaboration-fixtures';

const initial=():NativeGraph=>({nodes:[{id:'source',type:'rh-image',position:{x:0,y:0},data:{label:'Synthetic source'}},{id:'target',type:'rh-video',position:{x:400,y:0},data:{label:'Synthetic video',status:'idle',subType:'multimodal-video',modelCode:'h3-video-reference-v1',capabilityRef:'h3-video-reference-v1',capabilityVersion:'4',parameterSchemaVersion:'4',prompt:'Synthetic initial input.',params:{prompt:'Synthetic initial input.',imageUrls:[],outputPreset:'landscape-480p-5s'}}}],edges:[]});
const reply=(data:any,revision?:number,status=200,code='SYNTHETIC_REFUSAL')=>new Response(JSON.stringify({code:status<400?0:code,message:status<400?'OK':'Synthetic refusal',data}),{status,headers:revision?{ETag:'"'+revision+'"'}:{}});
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return{promise,resolve};}
function localStore(){const rows=new Map<string,string>();return{rows,get length(){return rows.size;},key:(index:number)=>[...rows.keys()][index]??null,getItem:(key:string)=>rows.get(key)??null,setItem:(key:string,value:string)=>{rows.set(key,value);},removeItem:(key:string)=>{rows.delete(key);}};}
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();vi.restoreAllMocks();});
function fixture(options:{acknowledged?:NativeGraph;mounted?:NativeGraph;strictAssets?:boolean;withoutMetadata?:boolean;strictNodePatches?:boolean;materialize?:()=>Promise<Response>}={}){
 const journal=localStore();vi.stubGlobal('localStorage',journal);let actor='owner',revision=1,server=encodeGraph(options.acknowledged??initial()),effects=0;
 if(options.withoutMetadata)server.nodes=server.nodes.filter(node=>node.id!=='rhtv_meta_v1');
 let hook:((receipt:Snapshot&{batchId:string;clientId:string},batch:CanvasOperationBatch)=>Promise<Response>|Response|undefined)|undefined;
 const asset=(id:string):Asset=>({id,projectId:id==='foreign'?'foreign_project':'p',fileName:'synthetic.png',state:'READY',kind:'IMAGE',mimeType:'image/png',byteSize:100,width:32,height:32,previewUrl:null,downloadUrl:'https://fixture.invalid/assets/'+id});
 const snapshot=():Snapshot=>({projectId:'p',revision,graph:structuredClone(server),updatedAt:'2026-11-04T07:00:00Z'}),receipts=new Map<string,Snapshot&{batchId:string;clientId:string}>();
 const transport=vi.fn(async(path:string,init:any={})=>{
  if(path==='/api/v2/catalog/media/materialize')return options.materialize?.()??reply({asset:asset('materialized')});
  if(path==='/api/v2/collaboration/projects/p/assets/import'){
   const ids=JSON.parse(init.body).assetIds as string[],assetIdMap=Object.fromEntries(ids.map(id=>[id,id==='foreign'?'copied':id]));return new Response(JSON.stringify({targetProjectId:'p',assetIdMap,assets:[...new Set(Object.values(assetIdMap))].map(asset)}),{headers:{'Content-Type':'application/json'}});
  }
  if(path.startsWith('/api/v1/assets/'))return reply(asset(path.split('/').at(-1)!));
  if(path==='/api/v2/projects/p/canvas-operations'){
   expect(init.method).toBe('POST');expect(new Headers(init.headers).get('Authorization')).toBe('Bearer synthetic-access');expect(new Headers(init.headers).get('X-STUDIO-Canvas-Session')).toBe('edit_page');const batch=JSON.parse(init.body) as CanvasOperationBatch;
   if(options.strictAssets&&/fixture\.invalid\/catalog|rhtv-asset:foreign/.test(JSON.stringify(batch.operations)))return reply(null,undefined,422,'ASSET_REFERENCE_REQUIRED');
   if(options.strictNodePatches){const ids=new Set(server.nodes.map(node=>node.id));for(const operation of batch.operations){if(operation.type==='node.create')ids.add(operation.node.id);if(operation.type==='node.delete')ids.delete(operation.nodeId);if(operation.type==='node.patch'&&!ids.has(operation.nodeId))return reply(null,undefined,409,'CANVAS_NODE_MISSING');}}
   const recovery=batch as CanvasOperationBatch & {receiptOnly?:boolean;baseRevision?:number};
   if(!receipts.has(batch.batchId)&&recovery.receiptOnly)return reply(null,undefined,409,'CANVAS_BATCH_NOT_APPLIED');
   if(!receipts.has(batch.batchId)&&recovery.baseRevision!==undefined&&recovery.baseRevision!==revision)return reply(null,undefined,412,'CANVAS_RECOVERY_RECHECK');
   let receipt=receipts.get(batch.batchId);if(!receipt){server=applyCanvasOperations(server,batch.operations);revision++;effects++;receipt={...snapshot(),batchId:batch.batchId,clientId:batch.clientId};receipts.set(batch.batchId,receipt);}
   const result=hook?.(structuredClone(receipt),batch);return result??reply(receipt,receipt.revision);
  }
  throw Error('Unexpected operation integration request '+path);
 });
 const api=new ProductClient('/api/v1',transport);api.setAccessToken('synthetic-access');api.setCanvasSession('p','edit_page');const notice=vi.fn(),storage=new ServiceStorage(api,notice,()=>actor,null);storage.rememberAccess(verifiedAccess('p','OWNER','owner',1));storage.acceptRemoteSnapshot('p',snapshot(),'"1"');const mounted=structuredClone(options.mounted??options.acknowledged??initial()),ensure=vi.fn(async()=>{});storage.enableCanvasOperations('p',{userId:'owner',clientId:'edit_page',ensure},mounted);storage.attachNativeView('p',mounted);
 return{api,storage,transport,notice,ensure,journal,mounted,snapshot,effects:()=>effects,server:()=>decodeGraph(server),hook:(next:typeof hook)=>{hook=next;},actor:(value:string)=>{actor=value;},remote:(change:(graph:NativeGraph)=>void)=>{const graph=decodeGraph(server);change(graph);server=encodeGraph(graph);revision++;return storage.acceptRemoteSnapshot('p',snapshot(),'"'+revision+'"');},posts:()=>transport.mock.calls.filter(([path])=>path==='/api/v2/projects/p/canvas-operations').map(([,init])=>JSON.parse(init.body) as CanvasOperationBatch)};
}
const connectNew=(graph:NativeGraph,type:'rh-image'|'rh-video')=>{graph.nodes.push({id:'new_target',type,position:{x:800,y:0},data:{status:'idle',subType:type==='rh-image'?'text-image':'multimodal-video'}});graph.edges.push({id:'new_edge',source:'source',target:'new_target',sourceHandle:'output',targetHandle:'input'});};

it('saves a quick-template connection from a new canonical canvas that has no synthetic metadata row',async()=>{
 const f=fixture({acknowledged:{nodes:[],edges:[]},withoutMetadata:true,strictNodePatches:true});f.mounted.nodes.push({id:'quick_text',type:'rh-text',position:{x:0,y:0},data:{text:'A woman returns to a hotel.'}},{id:'quick_video',type:'rh-video',position:{x:400,y:0},data:{status:'idle',subType:'text-video',params:{prompt:'Rainy night.'}}});f.storage.captureDraft('p',f.mounted);await f.storage.queueSave('p',f.mounted);
 const nativeEdgeId='xy-edge__quick_text-output-quick_video-input:template';f.mounted.edges.push({id:nativeEdgeId,source:'quick_text',target:'quick_video',sourceHandle:'output',targetHandle:'input'});f.storage.captureDraft('p',f.mounted);await f.storage.queueSave('p',f.mounted);
 expect(f.server().nodes.map(node=>node.id)).toEqual(['quick_text','quick_video']);expect(f.server().edges).toEqual(f.mounted.edges);expect(f.posts().flatMap(batch=>batch.operations).filter(op=>op.type==='node.create'&&op.node.id==='rhtv_meta_v1')).toHaveLength(1);expect(f.storage.hasDraft('p')).toBe(false);expect(f.journal.rows.size).toBe(0);
});

it.each(['rh-image','rh-video'] as const)('captures and saves a newly connected %s through operations only',async type=>{
 const f=fixture(),legacy=vi.spyOn(f.storage as any,'replayDraft');connectNew(f.mounted,type);f.storage.captureDraft('p',f.mounted);await f.storage.queueSave('p',f.mounted);
 expect(f.posts()).toHaveLength(1);expect(f.posts()[0].operations.map(op=>op.type)).toEqual(['node.create','edge.create','nodes.order']);expect(f.posts()[0].operations.at(-1)).toEqual({type:'nodes.order',nodeIds:['source','target','new_target','rhtv_meta_v1']});expect(f.effects()).toBe(1);expect(f.server().edges).toEqual(f.mounted.edges);expect(f.storage.hasDraft('p')).toBe(false);expect(f.storage.draftRecoveryState('p')).toMatchObject({blocked:false,conflicts:[],backups:[]});expect(legacy).not.toHaveBeenCalled();expect(f.transport.mock.calls.some(([,init])=>init.method==='PUT')).toBe(false);expect(f.ensure).toHaveBeenCalledOnce();
});

it('treats an idle old receipt projection, model change and another new connection as ordered edits without a whole-canvas merge',async()=>{
 const acknowledged=initial(),data=acknowledged.nodes[1].data;data.modelCode=data.capabilityRef='h3-reference-v1';data.routerParameters={outputPreset:'landscape-480p-5s'};data.userPromptSnapshot={paramName:'prompt',value:'Synthetic initial input.'};data.nodeOutputHistory=[];const mounted=structuredClone(acknowledged);for(const key of ['routerParameters','userPromptSnapshot','capabilityRef','capabilityVersion','parameterSchemaVersion'])delete mounted.nodes[1].data[key];
 const f=fixture({acknowledged,mounted});f.mounted.nodes[1].data.modelCode='h3-video-reference-v1';f.storage.rememberModelBinding('p',f.mounted.nodes[1],{capabilityRef:'h3-video-reference-v1',capabilityVersion:'4',parameterSchemaVersion:'4'});connectNew(f.mounted,'rh-video');f.storage.captureDraft('p',f.mounted);await f.storage.queueSave('p',f.mounted);
 expect(f.storage.mergedNativeView('p').conflicts).toEqual([]);expect(f.server().nodes[1].data.modelCode).toBe('h3-video-reference-v1');expect(f.server().nodes.some(node=>node.id==='new_target')).toBe(true);expect(f.server().edges).toEqual(f.mounted.edges);expect(f.posts().flatMap(batch=>batch.operations).filter(op=>op.type==='node.patch').flatMap(op=>op.unset)).not.toContainEqual(['data','routerParameters']);
});

it('keeps task progress and later local input when its live snapshot arrives before an older own HTTP receipt',async()=>{
 const f=fixture(),started=deferred<void>(),late=deferred<Response>();let first=true;f.hook(receipt=>{if(first){first=false;started.resolve();return late.promise;}});f.mounted.nodes[1].data.prompt='First retained input';f.storage.captureDraft('p',f.mounted);const saving=f.storage.queueSave('p',f.mounted);await started.promise;
 const ownReceipt={...f.snapshot(),batchId:f.posts()[0].batchId,clientId:'edit_page'};f.remote(graph=>{graph.nodes[0].data.progress=75;graph.nodes.push({id:'task_result',type:'rh-image',position:{x:0,y:500},data:{status:'finished'}});});f.mounted.nodes[1].data.prompt='Later retained input';f.storage.captureDraft('p',f.mounted);late.resolve(reply(ownReceipt,ownReceipt.revision));await saving;
 expect(f.posts()).toHaveLength(2);expect(f.server().nodes[1].data.prompt).toBe('Later retained input');expect(f.server().nodes[0].data.progress).toBe(75);expect(f.server().nodes.some(node=>node.id==='task_result')).toBe(true);expect(f.storage.snapshots.get('p')!.revision).toBe(4);expect(f.storage.hasDraft('p')).toBe(false);
});

it('retries a server-accepted timeout with the same batch and applies it only once',async()=>{
 const f=fixture();let fail=true;f.hook(()=>{if(fail){fail=false;return Promise.reject(new TypeError('Synthetic connection lost after acceptance'));}});connectNew(f.mounted,'rh-image');f.storage.captureDraft('p',f.mounted);await expect(f.storage.queueSave('p',f.mounted)).rejects.toThrow('Synthetic connection lost');expect(f.storage.hasDraft('p')).toBe(true);const first=f.posts()[0];await f.storage.queueSave('p',f.mounted);
 expect(f.posts()).toHaveLength(2);expect(f.posts()[1]).toEqual(first);expect(f.effects()).toBe(1);expect(f.server().nodes.filter(node=>node.id==='new_target')).toHaveLength(1);expect(f.storage.hasDraft('p')).toBe(false);expect(f.journal.rows.size).toBe(0);
});

it('does not emit inverse metadata operations when a frozen execution receipt is omitted by the native view',async()=>{
 const f=fixture(),exact=structuredClone(f.mounted),check=vi.fn();exact.nodes[1].data.routerParameters={outputPreset:'landscape-480p-5s'};exact.nodes[1].data.userPromptSnapshot={paramName:'prompt',value:'Synthetic initial input.'};const receipt=await f.storage.saveForExecution('p',exact,()=>f.mounted,check);expect(receipt.revision).toBe(2);
 f.storage.captureDraft('p',f.mounted);expect(f.storage.hasDraft('p')).toBe(false);f.mounted.nodes[1].position.x=450;await f.storage.queueSave('p',f.mounted);expect(f.posts()).toHaveLength(2);expect(f.posts()[1].operations).toEqual([{type:'node.patch',nodeId:'target',set:[{path:['position','x'],value:450}],unset:[]}]);expect(f.server().nodes[1].data.routerParameters).toEqual(exact.nodes[1].data.routerParameters);expect(f.server().nodes[1].data.userPromptSnapshot).toEqual(exact.nodes[1].data.userPromptSnapshot);expect(check).toHaveBeenCalled();
});

it('does not turn a remote task receipt and its native omissions into shadow writeback operations',async()=>{
 const f=fixture();f.remote(graph=>{Object.assign(graph.nodes[1].data,{status:'finished',taskId:'synthetic_task',progress:100,historyStorage:{source:'remote',schemaVersion:1,historyId:'synthetic_history',revision:'8',resultCount:1},output:[{outputId:'synthetic_output',text:'Synthetic result'}],routerParameters:{outputPreset:'landscape-480p-5s'},userPromptSnapshot:{paramName:'prompt',value:'Synthetic initial input.'}});});
 const rendered=f.server();for(const key of ['routerParameters','userPromptSnapshot','capabilityRef','capabilityVersion','parameterSchemaVersion'])delete rendered.nodes[1].data[key];f.storage.remoteNativeViewApplied('p',rendered);f.storage.captureDraft('p',rendered);await f.storage.queueSave('p',rendered);
 expect(f.posts()).toHaveLength(0);expect(f.storage.hasDraft('p')).toBe(false);expect(f.storage.snapshots.get('p')!.revision).toBe(2);expect(f.server().nodes[1].data.historyStorage).toMatchObject({revision:'8',resultCount:1});expect(f.server().nodes[1].data.routerParameters).toEqual({outputPreset:'landscape-480p-5s'});expect(f.server().nodes[1].data.output).toHaveLength(1);
});

it('replaces an unseen old model receipt when a newly frozen parameter object is introduced',async()=>{
 const acknowledged=initial();acknowledged.nodes[1].data.routerParameters={oldModelOnly:'old',outputPreset:'old-spec'};acknowledged.nodes[1].data.userPromptSnapshot={paramName:'text',value:'Old snapshot',oldMetadata:true};
 const mounted=structuredClone(acknowledged);delete mounted.nodes[1].data.routerParameters;delete mounted.nodes[1].data.userPromptSnapshot;const f=fixture({acknowledged,mounted}),exact=structuredClone(f.mounted);
 exact.nodes[1].data.routerParameters={outputPreset:'landscape-768p-5s'};exact.nodes[1].data.userPromptSnapshot={paramName:'prompt',value:'Synthetic initial input.'};await f.storage.saveForExecution('p',exact,()=>f.mounted,vi.fn());
 expect(f.server().nodes[1].data.routerParameters).toEqual(exact.nodes[1].data.routerParameters);expect(f.server().nodes[1].data.userPromptSnapshot).toEqual(exact.nodes[1].data.userPromptSnapshot);f.storage.captureDraft('p',f.mounted);expect(f.storage.hasDraft('p')).toBe(false);
});

it('fences an already accepted old-user response and never replays its journal into a new account',async()=>{
 const f=fixture(),started=deferred<void>(),late=deferred<Response>();f.hook(()=>{started.resolve();return late.promise;});f.mounted.nodes[1].data.prompt='Old account retained operation';const saving=f.storage.queueSave('p',f.mounted),rejected=expect(saving).rejects.toMatchObject({code:'SESSION_CHANGED'});await started.promise;const old={...f.snapshot(),batchId:f.posts()[0].batchId,clientId:'edit_page'};f.api.clearRequests();f.storage.clear();f.actor('new_user');f.storage.rememberAccess(verifiedAccess('p','EDITOR','owner',2));f.storage.acceptRemoteSnapshot('p',{projectId:'p',revision:50,graph:encodeGraph(initial()),updatedAt:'2026-11-04T07:00:01Z'},'"50"');f.storage.enableCanvasOperations('p',{userId:'new_user',clientId:'new_page',ensure:async()=>{}},initial());late.resolve(reply(old,old.revision));await rejected;
 expect(f.posts()).toHaveLength(1);expect(f.storage.snapshots.get('p')!.revision).toBe(50);expect(f.storage.hasDraft('p')).toBe(false);expect(f.storage.draftRecoveryState('p')).toMatchObject({blocked:false,persistence:'none',conflicts:[]});expect(f.journal.rows.size).toBe(1);
});

it('materializes catalog references before creating immutable media operations',async()=>{
 const f=fixture({strictAssets:true}),reference='https://fixture.invalid/catalog/reference.png';f.storage.registerCatalogMedia(reference,{family:'style',resourceId:'synthetic',revision:1,path:'reference'});f.mounted.nodes[0].data.sourceObjects=[reference];f.storage.captureDraft('p',f.mounted);await f.storage.queueSave('p',f.mounted);
 const paths=f.transport.mock.calls.map(([path])=>path);expect(paths.indexOf('/api/v2/catalog/media/materialize')).toBeGreaterThanOrEqual(0);expect(paths.indexOf('/api/v2/catalog/media/materialize')).toBeLessThan(paths.indexOf('/api/v2/projects/p/canvas-operations'));expect(JSON.stringify(f.posts())).not.toContain(reference);expect(f.server().nodes[0].data.sourceObjects).toEqual(['rhtv-asset:materialized']);
});

it('imports a foreign project asset before recording the immutable target-project reference',async()=>{
 const f=fixture({strictAssets:true});await f.storage.resolveAsset('foreign');f.mounted.nodes[0].data.sourceObjects=['rhtv-asset:foreign'];f.storage.captureDraft('p',f.mounted);await f.storage.queueSave('p',f.mounted);
 const paths=f.transport.mock.calls.map(([path])=>path);expect(paths.indexOf('/api/v2/collaboration/projects/p/assets/import')).toBeGreaterThanOrEqual(0);expect(paths.indexOf('/api/v2/collaboration/projects/p/assets/import')).toBeLessThan(paths.indexOf('/api/v2/projects/p/canvas-operations'));expect(JSON.stringify(f.posts())).not.toContain('rhtv-asset:foreign');expect(f.server().nodes[0].data.sourceObjects).toEqual(['rhtv-asset:copied']);
});

it.each(['catalog','import'])('releases a stalled %s preparation and retries the original idempotency key before saving',async stage=>{
 vi.useFakeTimers();const f=fixture({strictAssets:true}),original=f.transport.getMockImplementation()!,late=deferred<Response>();
 const path=stage==='catalog'?'/api/v2/catalog/media/materialize':'/api/v2/collaboration/projects/p/assets/import';
 let first=true;
 f.transport.mockImplementation(async(target:string,init:any={})=>{if(target===path&&first){first=false;return late.promise;}return original(target,init);});
 if(stage==='catalog'){
  const ref='https://fixture.invalid/catalog/timeout.png';f.storage.registerCatalogMedia(ref,{family:'style',resourceId:'synthetic',revision:1,path:'timeout'});f.mounted.nodes[0].data.sourceObjects=[ref];
 }else{await f.storage.resolveAsset('foreign');f.mounted.nodes[0].data.sourceObjects=['rhtv-asset:foreign'];}
 f.storage.captureDraft('p',f.mounted);
 const saving=f.storage.queueSave('p',structuredClone(f.mounted)),rejected=expect(saving).rejects.toMatchObject({code:'CANVAS_REQUEST_TIMEOUT'});
 await vi.advanceTimersByTimeAsync(60001);await rejected;
 expect(f.storage.hasDraft('p')).toBe(true);expect(f.posts()).toHaveLength(0);
 f.mounted.nodes[1].data.prompt='Latest edit while assets were stalled';f.storage.captureDraft('p',f.mounted);await f.storage.queueSave('p',structuredClone(f.mounted));
 const calls=f.transport.mock.calls.filter(([target])=>target===path);expect(calls).toHaveLength(2);
 expect(new Headers(calls[1][1].headers).get('Idempotency-Key')).toBe(new Headers(calls[0][1].headers).get('Idempotency-Key'));
 expect(f.server().nodes[1].data.prompt).toBe('Latest edit while assets were stalled');expect(f.storage.hasDraft('p')).toBe(false);
 // The obsolete request is canceled even if its transport resolves late.
 expect(calls[0][1].signal.aborted).toBe(true);
});

it('evicts a stalled asset lookup so the next lookup can recover without reloading',async()=>{
 vi.useFakeTimers();const f=fixture(),original=f.transport.getMockImplementation()!,path='/api/v1/assets/foreign';let first=true;
 f.transport.mockImplementation(async(target:string,init:any={})=>{if(target===path&&first){first=false;return new Promise(()=>{});}return original(target,init);});
 const rejected=expect(f.storage.resolveAsset('foreign')).rejects.toMatchObject({code:'CANVAS_REQUEST_TIMEOUT'});
 await vi.advanceTimersByTimeAsync(15001);await rejected;
 expect((await f.storage.resolveAsset('foreign')).id).toBe('foreign');expect(f.transport.mock.calls.filter(([target])=>target===path)).toHaveLength(2);
});

it('retains later text while materialization waits and clears only the staged input successfully drained by both saves',async()=>{
 const started=deferred<void>(),materialized=deferred<Response>(),f=fixture({strictAssets:true,materialize:()=>{started.resolve();return materialized.promise;}}),reference='https://fixture.invalid/catalog/late-reference.png';f.storage.registerCatalogMedia(reference,{family:'style',resourceId:'synthetic',revision:1,path:'late-reference'});f.mounted.nodes[0].data.sourceObjects=[reference];f.mounted.nodes[1].data.prompt='Before materialization';f.storage.captureDraft('p',f.mounted);const first=f.storage.queueSave('p',structuredClone(f.mounted));await started.promise;
 f.mounted.nodes[1].data.prompt='Edited while materialization waits';f.storage.captureDraft('p',f.mounted);f.mounted.nodes[1].data.prompt='Latest text before asset confirmation';f.storage.captureDraft('p',f.mounted);const second=f.storage.queueSave('p',structuredClone(f.mounted));expect(f.storage.hasDraft('p')).toBe(true);expect(f.posts()).toHaveLength(0);
 materialized.resolve(reply({asset:{id:'materialized',projectId:'p',fileName:'synthetic.png',state:'READY',kind:'IMAGE',mimeType:'image/png',byteSize:100,width:32,height:32,downloadUrl:'https://fixture.invalid/assets/materialized',previewUrl:null}}));await Promise.all([first,second]);
 expect(f.posts()).toHaveLength(2);expect(f.server().nodes[1].data.prompt).toBe('Latest text before asset confirmation');expect(f.server().nodes[0].data.sourceObjects).toEqual(['rhtv-asset:materialized']);expect(f.storage.hasDraft('p')).toBe(false);expect(f.storage.draft('p')).toBeUndefined();expect(f.storage.draftRecoveryState('p')).toMatchObject({blocked:false,persistence:'none'});expect(JSON.stringify(f.posts())).not.toContain(reference);expect((f.storage as any).emergencyDrafts.has('p')).toBe(false);
});

it('opens the canonical canvas and retains a conflicting offline edit without overwriting a newer tab',async()=>{
 const f=fixture();
 const old=f.mounted.nodes[0];
 old.data.label='Unconfirmed offline title';
 f.storage.captureDraft('p',f.mounted);
 f.remote(graph=>{graph.nodes[0].data.label='Later title from the editing device';});
 const current=f.snapshot();
 f.storage.acceptRemoteSnapshot('p',current,'"'+current.revision+'"');
 expect(f.storage.readOnlyNativeView('p').nodes[0].data.label).toBe('Later title from the editing device');
 await f.storage.recoverHandoffOperations('p','edit_page',()=>{});
 expect(f.effects()).toBe(0);
 expect(f.storage.hasDraft('p')).toBe(false);
 expect([...f.journal.rows].some(([key,data])=>key.startsWith('studiotv:retained-operations:')&&data.includes('Unconfirmed offline title'))).toBe(true);
 expect(f.server().nodes[0].data.label).toBe('Later title from the editing device');
});
it('recovers an unconfirmed edit once while retaining unrelated remote changes',async()=>{
 const f=fixture();
 f.mounted.nodes[0].data.label='Unsaved title';
 f.storage.captureDraft('p',f.mounted);
 f.remote(graph=>{graph.nodes[1].position.x+=60;});
 const current=f.snapshot();
 f.storage.acceptRemoteSnapshot('p',current,'"'+current.revision+'"');
 await f.storage.recoverHandoffOperations('p','edit_page',()=>{});
 expect(f.server().nodes[0].data.label).toBe('Unsaved title');
 expect(f.server().nodes[1].position).toEqual(current.graph.nodes[1].position);
 expect(f.effects()).toBe(1);
 expect(f.journal.rows.size).toBe(0);
});
