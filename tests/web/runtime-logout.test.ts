import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {encodeGraph} from '../../apps/web/src/service/graph';
import {verifiedAccess} from './collaboration-fixtures';

const {signOut}=vi.hoisted(()=>({signOut:vi.fn()}));
vi.mock('../../apps/web/src/config',()=>({config:{apiBase:'/api/v1'}}));
vi.mock('../../apps/web/src/api/auth',()=>({
 AuthSession:class {user=null;handlers:Array<()=>void>=[];restore=async()=>false;onClear=(handler:()=>void)=>{this.handlers.push(handler);};clear=()=>{this.user=null;for(const handler of this.handlers)handler();};signOut=signOut;},
 installNativeSessionBridge:()=>{},
}));
vi.mock('../../apps/web/src/api/feishu-ui',()=>({installFeishuLogin:()=>({open:async()=>{}})}));

function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>resolve=done);return{promise,resolve};}
const json=(status:number,data:any)=>new Response(JSON.stringify(data),{status,headers:{ETag:'"2"'}});
const savedSnapshot={projectId:'p',revision:2,graph:encodeGraph({nodes:[],edges:[],meta:{name:'Last edit'}}),updatedAt:'2026-10-04T00:00:00Z'};

beforeEach(()=>{vi.resetModules();vi.useFakeTimers();signOut.mockReset().mockResolvedValue(undefined);});
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();});

async function canvas(){
 const save=deferred<Response>(),started=deferred<void>();
 const transport=vi.fn().mockImplementation(()=>{started.resolve();return save.promise;});
 const replace=vi.fn();
 vi.stubGlobal('location',{pathname:'/projects/',search:'',hash:'',replace});
 vi.stubGlobal('window',{fetch:transport,setTimeout,addEventListener:vi.fn()});
 vi.stubGlobal('document',{addEventListener:vi.fn()});
 const {serviceRuntime:runtime}=await import('../../apps/web/src/service/runtime');
 runtime.auth.user={id:'owner'} as any;location.pathname='/project/canvas/p';
 runtime.storage.rememberAccess(verifiedAccess());runtime.storage.rememberAccess(verifiedAccess('q'));
 let notify!:()=>void;
 const graph={nodes:[],edges:[],meta:{name:'Before'}};
 runtime.storage.etags.set('p','"1"');
 runtime.attachCanvas('p',{getRemoteData:()=>graph,subscribe:(callback:()=>void)=>{notify=callback;return()=>{};}});
 graph.meta.name='Last edit';notify();
 return{runtime,save,started,replace,graph,notify,transport};
}

it('flushes the last edit before the autosave delay and waits before explicit logout',async()=>{
 const {runtime,save,started,replace,transport}=await canvas();
 const logout=runtime.handle('/uc/logout',{});
 await started.promise;
 expect(transport.mock.calls[0][0]).toBe('/api/v1/projects/p/snapshot');
 expect(signOut).not.toHaveBeenCalled();expect(replace).not.toHaveBeenCalled();
 save.resolve(json(200,{code:0,data:savedSnapshot}));
 await logout;
 expect(signOut).toHaveBeenCalledOnce();
});

it('keeps the session and canvas when logout encounters a save conflict',async()=>{
 const {runtime,save,started,replace}=await canvas();
 const logout=runtime.handle('/uc/logout',{});
 const rejected=expect(logout).rejects.toMatchObject({status:412});
 await started.promise;
 save.resolve(json(412,{error:{code:'VERSION_CONFLICT',message:'画布版本冲突'}}));
 await rejected;
 expect(runtime.storage.isBlocked('p')).toBe(true);
 expect(runtime.inspect().id).toBe('p');expect(signOut).not.toHaveBeenCalled();expect(replace).not.toHaveBeenCalled();
});

it('does not discard edits made while an explicit logout waits for a save',async()=>{
 const {runtime,save,started,replace,graph,notify}=await canvas();
 const logout=runtime.handle('/uc/logout',{});
 const rejected=expect(logout).rejects.toThrow('当前画布尚未保存');
 await started.promise;
 graph.meta.name='Edited while saving';notify();
 save.resolve(json(200,{code:0,data:savedSnapshot}));
 await rejected;
 expect(signOut).not.toHaveBeenCalled();expect(replace).not.toHaveBeenCalled();
});

it('continues local editing after the same user identity object is replaced during credential refresh',async()=>{
 const {runtime,graph,notify,save,started}=await canvas();runtime.auth.clear();runtime.auth.user={id:'owner'} as any;
 runtime.storage.rememberAccess(verifiedAccess());
 runtime.storage.etags.set('p','"1"');runtime.attachCanvas('p',{getRemoteData:()=>graph,subscribe:(callback:()=>void)=>{(notify as any).current=callback;return()=>{};}});
 runtime.auth.user={id:'owner'} as any;graph.meta.name='After token refresh';(notify as any).current();runtime.flush();await started.promise;save.resolve(json(200,{code:0,data:{...savedSnapshot,graph:encodeGraph(graph)}}));await runtime.storage.wait('p');expect(runtime.inspect().graph.meta.name).toBe('After token refresh');
});

it('saves the old observed draft when the same native manager has already changed rooms before attach',async()=>{
 const {runtime,save,started,transport}=await canvas();runtime.auth.clear();let graph:any={nodes:[],edges:[],meta:{id:'p',name:'Old original'}},notify!:()=>void;
 runtime.auth.user={id:'owner'} as any;
 runtime.storage.rememberAccess(verifiedAccess());runtime.storage.rememberAccess(verifiedAccess('q'));
 const oldDoc={on:vi.fn(),off:vi.fn()},newDoc={on:vi.fn(),off:vi.fn()},client={roomId:'p',ydoc:oldDoc,getRemoteData:()=>graph,subscribe:(callback:()=>void)=>{notify=callback;return()=>{};}};
 runtime.storage.etags.set('p','"1"');runtime.attachCanvas('p',client);graph.meta.name='Old unsaved';notify();
 client.roomId='q';client.ydoc=newDoc;graph={nodes:[],edges:[],meta:{id:'q',name:'New room'}};notify();runtime.storage.etags.set('q','"1"');location.pathname='/project/canvas/q';runtime.attachCanvas('q',client);await started.promise;
 const sent=JSON.parse(transport.mock.calls[0][1].body).graph;expect(sent.nodes.find((node:any)=>node.id==='rhtv_meta_v1').data.meta).toMatchObject({id:'p',name:'Old unsaved'});expect(oldDoc.off).toHaveBeenCalledWith('update',expect.any(Function));expect(newDoc.off).not.toHaveBeenCalled();
 save.resolve(json(200,{code:0,data:{...savedSnapshot,graph:sent}}));await runtime.storage.wait('p');expect(runtime.inspect().id).toBe('q');expect(runtime.inspect().graph.meta.name).toBe('New room');expect(transport).toHaveBeenCalledOnce();
});

it('routes native Studio source writes before JSON stream decoding',async()=>{
 const {runtime}=await canvas();vi.stubGlobal('location',{origin:'https://studio.invalid',href:'https://studio.invalid/projects/',pathname:'/projects/'});
 const source='<html><body>source with no JSON envelope</body></html>',response=new Response('saved');
 const studio=vi.spyOn(runtime.studio,'fetch').mockResolvedValue(response),assistant=vi.spyOn(runtime.assistant,'stream');
 expect(await runtime.fetch('/studio-api/projects/p/files/index.html',{method:'PUT',body:source,headers:{'Content-Type':'text/plain'}})).toBe(response);
 expect(studio).toHaveBeenCalledWith('/studio-api/projects/p/files/index.html',expect.objectContaining({body:source}));expect(assistant).not.toHaveBeenCalled();
});

it('leaves unrelated native text fetches alone without decoding them as product requests',async()=>{
 const {runtime}=await canvas();vi.stubGlobal('location',{origin:'https://studio.invalid',href:'https://studio.invalid/projects/',pathname:'/projects/'});
 const assistant=vi.spyOn(runtime.assistant,'stream');expect(await runtime.fetch('/opencut/assets/source.txt',{method:'POST',body:'local editor text'})).toBeUndefined();expect(assistant).not.toHaveBeenCalled();
});

it('does not mark a same-ID replacement canvas dirty when the old identity save rejects late',async()=>{
 const {runtime,save,started}=await canvas();runtime.flush();await started.promise;
 const old=runtime.storage.wait('p'),rejected=expect(old).rejects.toMatchObject({code:'SESSION_CHANGED'});runtime.auth.clear();
 runtime.auth.user={id:'owner'} as any;
 runtime.storage.rememberAccess(verifiedAccess());
 runtime.storage.etags.set('p','"5"');runtime.attachCanvas('p',{getRemoteData:()=>({nodes:[],edges:[],meta:{name:'Current'}}),subscribe:()=>()=>{}});
 save.resolve(json(200,{code:0,data:savedSnapshot}));await rejected;await Promise.resolve();await Promise.resolve();
 const beforeUnload=(window.addEventListener as any).mock.calls.find(([name]:any[])=>name==='beforeunload')[1],event=new Event('beforeunload',{cancelable:true});beforeUnload(event);expect(event.defaultPrevented).toBe(false);expect(runtime.storage.hasPending()).toBe(false);expect(runtime.storage.etags.get('p')).toBe('"5"');
});

it('routes project folder list and creation to the real organization adapter',async()=>{
 const {runtime}=await canvas();runtime.auth.user={id:'owner'} as any;const page={records:[{id:'f',type:'FOLDER'}],total:1},project={id:'created'};
 const list=vi.spyOn(runtime.organization,'list').mockResolvedValue(page as any),create=vi.spyOn(runtime.organization,'create').mockResolvedValue(project as any),legacy=vi.spyOn(runtime.storage,'list');
 expect(await runtime.handle('/canvas/list',{folderId:'f',queryScope:'ALL'})).toMatchObject({code:0,data:page});expect(list).toHaveBeenCalledWith({folderId:'f',queryScope:'ALL'});expect(legacy).not.toHaveBeenCalled();
 expect(await runtime.handle('/canvas/create',{folderId:'f',name:'New'})).toMatchObject({code:0,data:{id:'created'}});expect(create).toHaveBeenCalledWith({folderId:'f',name:'New'});
});

it('waits for the actual last save before deleting project folders',async()=>{
 const {runtime,save,started}=await canvas();runtime.auth.user={id:'owner'} as any;const remove=vi.spyOn(runtime.organization,'handle').mockResolvedValue({id:'f',deletedProjectIds:[],deletedFolderIds:['f']});
 const deletion=runtime.handle('/canvas/folder/delete',{folderId:'f'});await started.promise;expect(remove).not.toHaveBeenCalled();save.resolve(json(200,{code:0,data:savedSnapshot}));await deletion;expect(remove).toHaveBeenCalledWith('/canvas/folder/delete',{folderId:'f'},'POST');
});
