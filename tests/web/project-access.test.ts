import {expect,it,vi} from 'vitest';
import {ProductClient} from '../../apps/web/src/service/product-client';
import {ServiceStorage} from '../../apps/web/src/service/storage';
import {ExecutionAdapter} from '../../apps/web/src/service/execution';
import {validateProjectAccess} from '../../apps/web/src/service/project-access';
import {encodeGraph} from '../../apps/web/src/service/graph';
import {CanvasSync} from '../../apps/web/src/service/canvas-sync';
import {verifiedAccess} from './collaboration-fixtures';
const response=(data:any,etag='"1"')=>new Response(JSON.stringify({code:0,data}),{status:200,headers:{ETag:etag}});
const graph=()=>({nodes:[{id:'n',type:'rh-text',position:{x:0,y:0},data:{text:'Saved'}}],edges:[],meta:{id:'p'}});
function setup(handler:(path:string,options:any)=>Response|Promise<Response>=()=>response({})){let actor:string|null='actor';const transport=vi.fn(handler),api=new ProductClient('/api/v1',transport as any);api.setAccessToken('actual-actor-session');const storage=new ServiceStorage(api,vi.fn(),()=>actor);return{api,storage,transport,identity:(value:string|null)=>actor=value};}

it.each(['OWNER','EDITOR','VIEWER']as const)('accepts the authoritative %s capabilities independently of storage ownership',role=>{const access=verifiedAccess('p',role,'different-owner',3);expect(validateProjectAccess(access,'p')).toEqual(access);});
it.each([{role:'ADMIN'},{projectId:'other'},{revision:0},{storageOwnerId:'other'},{canRead:false},{role:'VIEWER',canEdit:true},{role:'EDITOR',canManageMembers:true},{canRun:false}])('rejects an inconsistent or missing permission response %j',patch=>{expect(()=>validateProjectAccess({...verifiedAccess(),...patch},'p')).toThrow('有效的项目权限');});

it('loads an editor project using the caller token without rewriting the actual owner',async()=>{
 const s=setup(path=>path.endsWith('/access')?response(verifiedAccess('p','EDITOR','other-owner',7),'"7"'):path.endsWith('/snapshot')?response({projectId:'p',revision:2,graph:encodeGraph(graph()),updatedAt:'2026-10-07T00:00:00Z'},'"2"'):response({id:'p',ownerId:'other-owner',name:'Shared',revision:2,coverAssetId:null}));
 const project=await s.storage.loadProject('p');expect(project.ownerId).toBe('other-owner');expect(s.storage.access('p')).toMatchObject({role:'EDITOR',revision:7,canManageMembers:false});expect(s.storage.canEdit('p')).toBe(true);expect(s.transport.mock.calls.map(call=>new Headers(call[1].headers).get('Authorization'))).toEqual(['Bearer actual-actor-session','Bearer actual-actor-session','Bearer actual-actor-session']);expect(s.storage.etags.get('p')).toBe('"2"');
});
it('does not infer grants from ownership and rejects viewer writes, with only live metadata permission reads',async()=>{
 const s=setup(()=>response(verifiedAccess('p','VIEWER','different-owner')));s.storage.projects.set('p',{id:'p',ownerId:'actor'}as any);expect(s.storage.canRead('p')).toBe(false);await expect(s.storage.save('p',graph())).rejects.toMatchObject({code:'READ_ONLY'});
 s.storage.rememberAccess(verifiedAccess('p','VIEWER','different-owner'));s.storage.acceptRemoteSnapshot('p',{projectId:'p',revision:1,graph:encodeGraph(graph()),updatedAt:''});expect(s.storage.canRead('p')).toBe(true);await expect(s.storage.save('p',graph())).rejects.toMatchObject({status:403});await expect(s.storage.upload(new File(['x'],'x.png',{type:'image/png'}),'p')).rejects.toMatchObject({status:403});await expect(s.storage.rename('p','Rename')).rejects.toMatchObject({status:403});await expect(s.storage.delete('p')).rejects.toMatchObject({status:403});const execution=new ExecutionAdapter(s.api,s.storage,async()=>{},vi.fn());await expect(execution.run({canvasId:'p',canvas:graph(),targetId:'n'})).rejects.toMatchObject({status:403});expect(s.transport.mock.calls).toHaveLength(2);expect(s.transport.mock.calls.every(call=>call[0]==='/api/v2/collaboration/projects/p/access'&&(call[1].method??'GET')==='GET')).toBe(true);
});
it('permits editor metadata but keeps project deletion owner-only after live permission verification',async()=>{const s=setup(()=>response(verifiedAccess('p','EDITOR','foreign')));s.storage.rememberAccess(verifiedAccess('p','EDITOR','foreign'));expect(()=>s.storage.requirePermission('p')).not.toThrow();await expect(s.storage.delete('p')).rejects.toMatchObject({status:403});expect(s.transport).toHaveBeenCalledOnce();expect(s.transport.mock.calls[0][0]).toBe('/api/v2/collaboration/projects/p/access');});
it('binds access to identity and clears it after a same-document account switch',()=>{const s=setup();s.storage.rememberAccess(verifiedAccess());expect(s.storage.canEdit('p')).toBe(true);s.identity('different-account');expect(s.storage.canRead('p')).toBe(false);expect(()=>s.storage.requirePermission('p','canRead')).toThrow('不能访问');s.storage.clear();expect(s.storage.accessMap.size).toBe(0);});
it('rejects an older ignored-abort fill after explicit invalidation',async()=>{let finish!:(response:Response)=>void;const s=setup(()=>new Promise(resolve=>finish=resolve));const pending=s.storage.refreshAccess('p'),rejected=expect(pending).rejects.toMatchObject({code:'SESSION_CHANGED'});await Promise.resolve();s.storage.invalidateAccess('p');finish(response(verifiedAccess()));await rejected;expect(s.storage.accessMap.size).toBe(0);expect((s.transport.mock.calls[0][1].signal as AbortSignal).aborted).toBe(true);});
it('coalesces access reads while preventing another identity from adopting a late grant',async()=>{let finish!:(response:Response)=>void;const s=setup(()=>new Promise(resolve=>finish=resolve)),first=s.storage.refreshAccess('p'),second=s.storage.refreshAccess('p');expect(second).toBe(first);const rejected=expect(first).rejects.toMatchObject({code:'SESSION_CHANGED'});s.identity('other');finish(response(verifiedAccess()));await rejected;expect(s.storage.canRead('p')).toBe(false);expect(s.transport).toHaveBeenCalledOnce();});

it('copies newly introduced personal references once per project and preserves the personal source',async()=>{
 const copied={id:'copy',projectId:'p',kind:'IMAGE',mimeType:'image/png',state:'READY',fileName:'copy.png',previewUrl:'https://studio.test/copy',downloadUrl:'https://studio.test/copy',byteSize:1};let revision=1;
 const s=setup((path,options)=>{if(path.endsWith('/assets/import')){expect(JSON.parse(options.body)).toEqual({assetIds:['source']});expect(new Headers(options.headers).get('Idempotency-Key')).toMatch(/^[a-f0-9-]{36}$/);return new Response(JSON.stringify({targetProjectId:'p',assetIdMap:{source:'copy'},assets:[copied]}),{status:201});}if(path.endsWith('/assets/copy'))return response(copied);if(path.endsWith('/snapshot'))return response({projectId:'p',revision:++revision,graph:JSON.parse(options.body).graph,updatedAt:''},'"'+revision+'"');throw new Error(path);});
 s.storage.rememberAccess(verifiedAccess('p','EDITOR','owner'));s.storage.acceptRemoteSnapshot('p',{projectId:'p',revision:1,graph:encodeGraph(graph()),updatedAt:''},'"1"');const source={...copied,id:'source',projectId:'personal',previewUrl:'https://studio.test/source',downloadUrl:'https://studio.test/source'};s.storage.registerAsset(source as any);const native=graph();native.nodes[0].data={text:'Added',imageUrl:source.previewUrl}as any;s.storage.attachNativeView('p',graph());
 await s.storage.save('p',native);expect(native.nodes[0].data).toHaveProperty('imageUrl','https://studio.test/source');expect(s.storage.snapshots.get('p')!.graph.nodes[0].data).toHaveProperty('imageUrl','rhtv-asset:copy');native.nodes[0].data.text='Another edit';await s.storage.save('p',native);expect(s.transport.mock.calls.filter(call=>call[0].endsWith('/assets/import'))).toHaveLength(1);expect(s.storage.snapshots.get('p')!.graph.nodes[0].data).toHaveProperty('imageUrl','rhtv-asset:copy');
});

it('applies viewer snapshots without turning native perturbations into an editable draft and stops applying after revocation',async()=>{
 const remote=graph();remote.nodes[0].data.text='Remote editor update';const s=setup(()=>response({schemaVersion:'1',projectId:'p',graph:encodeGraph(remote),graphRevision:2,eventCursor:'1',updatedAt:'',nodeStates:[],nodeExecutionAvailable:false},'"2"'));s.storage.rememberAccess(verifiedAccess('p','VIEWER'));s.storage.projects.set('p',{id:'p',ownerId:'owner'}as any);s.storage.acceptRemoteSnapshot('p',{projectId:'p',revision:1,graph:encodeGraph(graph()),updatedAt:''},'"1"');let view=graph();s.storage.attachNativeView('p',view);view.nodes[0].data.text='Attempted local input';const apply=vi.fn((next:any)=>{view=next;return true;}),sync=new CanvasSync(s.api,s.storage,'p',{current:()=>true,read:()=>view,readOnly:()=>!s.storage.canEdit('p'),apply,applied:vi.fn(),error:vi.fn()});await sync.catchUp();expect(view.nodes[0].data.text).toBe('Remote editor update');expect(s.storage.hasDraft('p')).toBe(false);expect(sync.eventCursor).toBe('1');s.storage.invalidateAccess('p');await expect(sync.catchUp()).rejects.toMatchObject({status:403});expect(apply).toHaveBeenCalledOnce();expect(s.transport).toHaveBeenCalledOnce();
});
it('rejects direct viewer media and cancellation commands before catalog materialization or any transport',async()=>{
 const s=setup();s.storage.rememberAccess(verifiedAccess('p','VIEWER'));const execution=new ExecutionAdapter(s.api,s.storage,async()=>{},vi.fn());(execution as any).projectId='p';
 for(const path of ['/canvas/media/task/run','/media/jobs/submit','/canvas/task/cancel','/canvas/media/task/cancel'])await expect(execution.handle(path,{projectId:'p',taskId:'task',spec:{tracks:[{source:'https://catalog.invalid/new'}]}})).rejects.toMatchObject({status:403});expect(s.transport).not.toHaveBeenCalled();
});

it('treats an unrecognized permission response as unconfirmed and a service denial as a revocation',async()=>{
 const s=setup();s.storage.rememberAccess(verifiedAccess());
 s.transport.mockResolvedValueOnce(new Response('proxy denied',{status:403}));await expect(s.storage.refreshAccess('p')).rejects.toMatchObject({code:'INVALID_RESPONSE'});
 expect(s.storage.canRead('p')).toBe(true);expect(s.storage.canEdit('p')).toBe(true);
 for(const action of ['canEdit','canRun','canManageMembers'] as const)expect(()=>s.storage.requirePermission('p',action)).toThrow('正在重新确认');
 s.transport.mockResolvedValueOnce(response(verifiedAccess('p','VIEWER','owner',2)));await s.storage.refreshAccess('p');
 expect(s.storage.canRead('p')).toBe(true);expect(s.storage.canEdit('p')).toBe(false);expect(s.storage.accessNeedsConfirmation('p')).toBe(false);
 s.transport.mockResolvedValueOnce(new Response(JSON.stringify({error:{code:'PROJECT_NOT_FOUND'}}),{status:404}));await expect(s.storage.refreshAccess('p')).rejects.toMatchObject({status:404});
 expect(s.storage.canRead('p')).toBe(false);expect(s.storage.access('p')).toBeUndefined();
});

it('bounds a stalled access check and ignores its late grant after a newer denial',async()=>{
 vi.useFakeTimers();
 try{
  let late!:(value:Response)=>void;const s=setup(()=>new Promise(resolve=>{late=resolve;}));s.storage.rememberAccess(verifiedAccess());
  const stalled=s.storage.refreshAccess('p'),timeout=expect(stalled).rejects.toMatchObject({code:'PROJECT_ACCESS_TIMEOUT'});
  await vi.advanceTimersByTimeAsync(8000);await timeout;
  expect(s.storage.accessNeedsConfirmation('p')).toBe(true);
  expect(s.transport.mock.calls[0][1].signal.aborted).toBe(true);
  s.transport.mockResolvedValueOnce(new Response(JSON.stringify({error:{code:'PROJECT_NOT_FOUND'}}),{status:404}));
  await expect(s.storage.refreshAccess('p')).rejects.toMatchObject({status:404});
  late(response(verifiedAccess()));await vi.advanceTimersByTimeAsync(0);
  expect(s.storage.canRead('p')).toBe(false);
 }finally{vi.useRealTimers();}
});
