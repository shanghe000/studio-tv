import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {encodeGraph,type NativeGraph} from '../../apps/web/src/service/graph';
import {verifiedAccess} from './collaboration-fixtures';
const bridge=vi.hoisted(()=>({ready:true,apply:true,applied:vi.fn()}));
vi.mock('../../apps/web/src/config',()=>({config:{apiBase:'/api/v1',mode:'service'}}));
vi.mock('../../apps/web/src/api/auth',()=>({AuthSession:class {user:any=null;restore=async()=>false;onClear=()=>{};clear=vi.fn();},installNativeSessionBridge:()=>{}}));
vi.mock('../../apps/web/src/api/feishu-ui',()=>({installFeishuLogin:()=>({open:async()=>{}})}));
vi.mock('../../apps/web/src/service/native-canvas-sync',()=>({REMOTE_CANVAS_ORIGIN:'remote',nativeCanvasSyncPort:(client:any)=>({available:()=>true,ready:()=>bridge.ready,apply:(graph:NativeGraph)=>{bridge.applied(graph);if(!bridge.apply)return false;client.graph=structuredClone(graph);return true;}})}));
vi.mock('../../apps/web/src/service/canvas-sync',()=>({CanvasSync:class {start=vi.fn();stop=vi.fn();}}));
beforeEach(()=>{vi.resetModules();vi.useFakeTimers();bridge.ready=true;bridge.apply=true;bridge.applied.mockClear();});
afterEach(()=>{vi.clearAllTimers();vi.useRealTimers();vi.unstubAllGlobals();vi.restoreAllMocks();});

async function setup(beforePut?:()=>Promise<void>){
 const original:NativeGraph={nodes:[{id:'n',type:'rh-text',position:{x:0,y:0},data:{text:'Original'}}],edges:[],meta:{id:'p'}},rows=new Map<string,string>();
 const journal={get length(){return rows.size;},key:(i:number)=>[...rows.keys()][i]??null,getItem:(key:string)=>rows.get(key)??null,setItem:(key:string,value:string)=>{rows.set(key,value);},removeItem:(key:string)=>rows.delete(key)};
 let remote=structuredClone(original),revision=1;
 const transport=vi.fn(async(path:string,init:any={})=>{
  if(path==='/api/v2/collaboration/projects/p/access')return new Response(JSON.stringify({code:0,data:verifiedAccess()}));
  if(path==='/api/v1/projects/p/snapshot'){
   if(init.method==='PUT'){await beforePut?.();revision++;return new Response(JSON.stringify({code:0,data:{projectId:'p',revision,graph:JSON.parse(init.body).graph,updatedAt:'2026-11-02T00:00:00Z'}}),{headers:{ETag:'"'+revision+'"'}});}
   return new Response(JSON.stringify({code:0,data:{projectId:'p',revision,graph:encodeGraph(remote),updatedAt:'2026-11-02T00:00:00Z'}}),{headers:{ETag:'"'+revision+'"'}});
  }throw new Error('Unexpected review request '+path);
 });
 vi.stubGlobal('location',{pathname:'/projects/',search:'',hash:'',replace:vi.fn()});vi.stubGlobal('document',{addEventListener:vi.fn()});
 vi.stubGlobal('window',{fetch:transport,setTimeout,localStorage:journal,addEventListener:vi.fn(),dispatchEvent:vi.fn(),__RHTV_PREVIEW__:{notice:vi.fn()}});
 const {serviceRuntime:runtime}=await import('../../apps/web/src/service/runtime');runtime.auth.user={id:'owner'} as any;runtime.api.setAccessToken('fixture-only');location.pathname='/project/canvas/p';
 runtime.storage.projects.set('p',{id:'p',ownerId:'owner',name:'Fixture'} as any);runtime.storage.rememberAccess(verifiedAccess());runtime.storage.acceptRemoteSnapshot('p',{projectId:'p',revision,graph:encodeGraph(original),updatedAt:'2026-11-02T00:00:00Z'},'"1"');
 let update=()=>{};const client={roomId:'p',graph:structuredClone(original),ydoc:{on:vi.fn(),off:vi.fn()},getRemoteData(){return this.graph;},subscribe:(callback:()=>void)=>{update=callback;return()=>{};},flushOperationQueue:vi.fn()};runtime.attachCanvas('p',client);
 return{runtime,client,transport,update:()=>update(),converge:()=>{client.graph.nodes[0].data.text='Local';update();remote.nodes[0].data.text='Remote';revision=2;runtime.storage.acceptRemoteSnapshot('p',{projectId:'p',revision,graph:encodeGraph(remote),updatedAt:'2026-11-02T00:00:00Z'},'"2"');client.graph.nodes[0].data.text='Original';update();}};
}

it('settles a converged retained draft even when native undo equals the last successful native serialization',async()=>{
 const {runtime,client,converge}=await setup();converge();
 expect(runtime.storage.isBlocked('p')).toBe(false);expect(runtime.storage.draft('p')!.nodes[0].data.text).toBe('Remote');
 await runtime.waitForSave();
 expect(runtime.storage.hasDraft('p')).toBe(false);
 expect(client.graph.nodes[0].data.text).toBe('Remote');
});

it('keeps a new edit made while the save response is pending instead of applying the previous saved merge',async()=>{
 let finish!:()=>void,started!:()=>void;const begin=new Promise<void>(resolve=>started=resolve),completion=new Promise<void>(resolve=>finish=resolve);
 const {runtime,client,update}=await setup(async()=>{started();await completion;});client.graph.nodes[0].data.text='First edit';update();
 const saving=runtime.waitForSave();await begin;client.graph.nodes[0].data.text='New input during save';update();finish();await saving;
 expect(client.graph.nodes[0].data.text).toBe('New input during save');expect(runtime.storage.draft('p')!.nodes[0].data.text).toBe('New input during save');expect(runtime.storage.hasDraft('p')).toBe(true);expect(bridge.applied).not.toHaveBeenCalled();
});

it.each(['not ready','apply deferred'])('keeps the acknowledged graph retryable when the native bridge is %s',async mode=>{
 const {runtime,client,converge,transport}=await setup();converge();if(mode==='not ready')bridge.ready=false;else bridge.apply=false;
 await runtime.waitForSave();expect(runtime.storage.hasDraft('p')).toBe(false);expect(client.graph.nodes[0].data.text).toBe('Original');
 expect(runtime.storage.snapshots.get('p')!.graph.nodes[0].data.text).toBe('Remote');
 bridge.ready=true;bridge.apply=true;await runtime.waitForSave();expect(client.graph.nodes[0].data.text).toBe('Remote');expect(runtime.storage.hasDraft('p')).toBe(false);
 expect(transport.mock.calls.filter(([path,init])=>path.endsWith('/snapshot')&&init?.method==='PUT')).toHaveLength(1);
});
