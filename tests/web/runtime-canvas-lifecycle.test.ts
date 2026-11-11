import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {encodeGraph} from '../../apps/web/src/service/graph';
import {verifiedAccess} from './collaboration-fixtures';

const {syncs}=vi.hoisted(()=>({syncs:[] as any[]}));
vi.mock('../../apps/web/src/config',()=>({config:{apiBase:'/api/v1'}}));
vi.mock('../../apps/web/src/api/auth',()=>({
 AuthSession:class {user:any=null;restore=async()=>false;onClear=()=>{};clear=vi.fn();},installNativeSessionBridge:()=>{},
}));
vi.mock('../../apps/web/src/api/feishu-ui',()=>({installFeishuLogin:()=>({open:async()=>{}})}));
vi.mock('../../apps/web/src/service/native-canvas-sync',()=>({REMOTE_CANVAS_ORIGIN:'remote',nativeCanvasSyncPort:()=>({available:()=>true,ready:()=>true,apply:()=>true})}));
vi.mock('../../apps/web/src/service/canvas-sync',()=>({CanvasSync:class {view:any;start=vi.fn();stop=vi.fn();constructor(_api:any,_storage:any,_id:string,view:any){this.view=view;syncs.push(this);}}}));

beforeEach(()=>{vi.resetModules();syncs.length=0;vi.useFakeTimers();});
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();});
async function setup(){
 const transport=vi.fn(async()=>new Response(JSON.stringify({error:{code:'TEMPORARY',message:'save unavailable'}}),{status:503}));
 const path={pathname:'/projects/',search:'',hash:'',replace:vi.fn()};vi.stubGlobal('location',path);
 vi.stubGlobal('window',{fetch:transport,setTimeout,addEventListener:vi.fn(),dispatchEvent:vi.fn()});vi.stubGlobal('document',{addEventListener:vi.fn()});
 const {serviceRuntime:runtime}=await import('../../apps/web/src/service/runtime');runtime.auth.user={id:'owner'} as any;path.pathname='/project/canvas/p';
 const graph={nodes:[{id:'n',type:'rh-text',position:{x:0,y:0},data:{text:'Original'}}],edges:[],meta:{id:'p'}};
 runtime.storage.projects.set('p',{id:'p',ownerId:'owner',name:'Fixture'} as any);runtime.storage.rememberAccess(verifiedAccess());runtime.storage.acceptRemoteSnapshot('p',{projectId:'p',revision:1,graph:encodeGraph(graph),updatedAt:'2026-10-07T00:00:00Z'},'"1"');
 let update!:()=>void;const off=vi.fn(),unsubscribe=vi.fn(),client={roomId:'p',ydoc:{on:vi.fn(),off},getRemoteData:()=>graph,subscribe:(callback:()=>void)=>{update=callback;return unsubscribe;},flushOperationQueue:vi.fn()};runtime.attachCanvas('p',client);
 return{runtime,graph,client,path,transport,off,unsubscribe,update:()=>update()};
}

it('captures native debounced edits and retains a failed draft while releasing stream, listeners and local watchers',async()=>{
 const s=await setup(),detach=vi.spyOn(s.runtime.execution,'detach');s.client.flushOperationQueue.mockImplementation(()=>{s.graph.nodes[0].data.text='Last unsaved input';});
 s.runtime.detachCanvas();expect(syncs[0].stop).toHaveBeenCalledOnce();expect(syncs[0].view.current()).toBe(false);expect(s.unsubscribe).toHaveBeenCalledOnce();expect(s.off).toHaveBeenCalledWith('update',expect.any(Function));expect(detach).toHaveBeenCalledOnce();expect(s.runtime.inspect().id).toBeNull();
 await expect(s.runtime.storage.wait('p')).rejects.toMatchObject({status:503});expect(s.runtime.auth.user?.id).toBe('owner');expect(s.runtime.storage.hasDraft('p')).toBe(true);expect(s.runtime.storage.draft('p')?.nodes[0].data.text).toBe('Last unsaved input');
 s.update();await vi.advanceTimersByTimeAsync(1000);expect(s.transport).toHaveBeenCalledOnce();expect(s.transport.mock.calls[0][0]).toBe('/api/v1/projects/p/snapshot');
});

it('guards late callbacks and rejects reattachment after SPA exit or page suspension',async()=>{
 const s=await setup();s.path.pathname='/projects/canvas/me/';expect(syncs[0].view.current()).toBe(false);s.graph.nodes[0].data.text='Exit edit';s.update();s.runtime.attachCanvas('p',s.client);expect(syncs).toHaveLength(1);
 s.runtime.setCanvasPageActive(false);await expect(s.runtime.storage.wait('p')).rejects.toMatchObject({status:503});s.path.pathname='/project/canvas/p';s.runtime.attachCanvas('p',s.client);expect(s.runtime.inspect().id).toBeNull();expect(syncs).toHaveLength(1);
 s.runtime.setCanvasPageActive(true);s.runtime.attachCanvas('p',s.client);expect(syncs).toHaveLength(2);expect(syncs[1].start).toHaveBeenCalledOnce();expect(syncs[1].view.current()).toBe(true);expect(s.runtime.storage.hasDraft('p')).toBe(true);s.runtime.detachCanvas();
});

it('does not attach a different native room or a cleared login on resume',async()=>{
 const s=await setup();s.runtime.detachCanvas();s.client.roomId='q';s.runtime.attachCanvas('p',s.client);expect(syncs).toHaveLength(1);s.client.roomId='p';s.runtime.auth.user=null;s.runtime.attachCanvas('p',s.client);expect(syncs).toHaveLength(1);expect(s.runtime.inspect().id).toBeNull();
});

it('does not adopt the previous account canvas after an identity switch in bfcache',async()=>{
 const s=await setup(),previous=s.runtime.canvasAttachment()!;s.runtime.setCanvasPageActive(false);s.runtime.auth.user={id:'other-owner'} as any;s.runtime.setCanvasPageActive(true);s.runtime.attachCanvas(previous.id,previous.client,previous.identityId);
 expect(syncs).toHaveLength(1);expect(s.runtime.inspect().id).toBeNull();expect(s.runtime.auth.user.id).toBe('other-owner');
});
