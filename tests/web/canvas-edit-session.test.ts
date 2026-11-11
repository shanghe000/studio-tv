// @vitest-environment happy-dom
import {afterEach,expect,it,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {URL as NodeURL} from 'node:url';
import {runInNewContext} from 'node:vm';
import {ApiError} from '../../apps/web/src/api/client';
import {CanvasEditSessionClient,installCanvasEditSession} from '../../apps/web/src/service/canvas-edit-session';
const cleanups:(()=>void)[]=[];
afterEach(()=>{for(const dispose of cleanups.splice(0))dispose();vi.useRealTimers();vi.restoreAllMocks();document.body.innerHTML='';});
const gate=<T>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>resolve=done);return{promise,resolve};};
const receipt=(client:any)=>({projectId:client.projectId,clientId:client.clientId,expiresAt:new Date(Date.now()+30000).toISOString(),ttlSeconds:30});
function fixture(){
 let current=true,identity=true,editable=true,fail:unknown,waiting:Promise<any>|undefined;const request=vi.fn(async(_path:string,options:any)=>{if(options.method==='DELETE')return{data:{released:true}};if(waiting)return waiting;if(fail)throw fail;return{data:receipt(client)};}),api:any={requestV2:request},client=new CanvasEditSessionClient(api,'project','user',()=>current,()=>editable,()=>identity);cleanups.push(()=>client.stop());
 return{client,request,setFailure:(error:unknown)=>fail=error,setWait:(value?:Promise<any>)=>waiting=value,leave:()=>current=false,changeIdentity:()=>identity=false,permission:(value:boolean)=>editable=value};
}
it('joins once, shares in-flight admission and leaves normal held-session writes free of network calls',async()=>{
 const f=fixture(),wait=gate<any>();f.setWait(wait.promise);const first=f.client.start(),second=f.client.ensure();expect(f.request).toHaveBeenCalledTimes(1);expect(f.client.holds()).toBe(false);wait.resolve({data:receipt(f.client)});await Promise.all([first,second]);expect(f.client.holds()).toBe(true);await f.client.ensure();expect(f.request).toHaveBeenCalledTimes(1);expect(f.request.mock.calls[0][1].body).toEqual({clientId:f.client.clientId});
});
it('renews every ten seconds and fails closed immediately on a missed renewal before recovering',async()=>{
 vi.useFakeTimers();const f=fixture();await f.client.start();await vi.advanceTimersByTimeAsync(10000);expect(f.request).toHaveBeenCalledTimes(2);f.setFailure(new TypeError('offline'));await vi.advanceTimersByTimeAsync(10000);expect(f.client.holds()).toBe(false);expect(f.client.state().status).toBe('offline');f.setFailure(undefined);await vi.advanceTimersByTimeAsync(2000);expect(f.client.holds()).toBe(true);
});
it('keeps another page occupied until the server grants this independent page identity',async()=>{
 vi.useFakeTimers();const f=fixture();f.setFailure(new ApiError(409,'PROJECT_EDIT_OCCUPIED','同事正在另一页面编辑此画布。'));await expect(f.client.start()).rejects.toMatchObject({code:'PROJECT_EDIT_OCCUPIED'});expect(f.client.state()).toMatchObject({status:'occupied',message:'同事正在另一页面编辑此画布。'});await vi.advanceTimersByTimeAsync(1999);expect(f.request).toHaveBeenCalledTimes(1);f.setFailure(undefined);await vi.advanceTimersByTimeAsync(1);expect(f.client.holds()).toBe(true);
});
it.each(['project','client','ttl','expiry'])('rejects an invalid %s admission receipt without enabling editing',async field=>{
 const f=fixture(),value:any=receipt(f.client);if(field==='project')value.projectId='other';if(field==='client')value.clientId='other';if(field==='ttl')value.ttlSeconds=31;if(field==='expiry')value.expiresAt='unknown';f.setWait(Promise.resolve({data:value}));await expect(f.client.start()).rejects.toMatchObject({code:'INVALID_EDIT_SESSION'});expect(f.client.holds()).toBe(false);
});
it('does not extend ownership by the round trip time of a delayed admission',async()=>{
 vi.useFakeTimers();const f=fixture(),wait=gate<any>();f.setWait(wait.promise);const pending=f.client.start(),rejected=expect(pending).rejects.toMatchObject({code:'INVALID_EDIT_SESSION'});await vi.advanceTimersByTimeAsync(30000);wait.resolve({data:receipt(f.client)});await rejected;expect(f.client.holds()).toBe(false);
});
it('discards late admission on offline and reacquires instead of falsely retaining the old lease',async()=>{
 const f=fixture(),wait=gate<any>();f.setWait(wait.promise);const first=f.client.start(),rejected=expect(first).rejects.toMatchObject({code:'STALE_CANVAS_SESSION'});f.client.offline();wait.resolve({data:receipt(f.client)});await rejected;expect(f.client.holds()).toBe(false);f.setWait();f.client.online();await vi.waitFor(()=>expect(f.client.holds()).toBe(true));expect(f.request).toHaveBeenCalledTimes(2);
});
it('releases the old page on route leave using keepalive but never after an identity change',async()=>{
 const f=fixture();await f.client.start();f.leave();f.client.stop();expect(f.request).toHaveBeenLastCalledWith('/projects/project/edit-session',expect.objectContaining({method:'DELETE',keepalive:true,body:{clientId:f.client.clientId}}));const other=fixture();await other.client.start();other.changeIdentity();other.client.stop();expect(other.request).toHaveBeenCalledTimes(1);
});
it('does not keep retrying after access is denied',async()=>{
 vi.useFakeTimers();const f=fixture();f.setFailure(new ApiError(403,'READ_ONLY','只读'));await expect(f.client.start()).rejects.toMatchObject({status:403});await vi.advanceTimersByTimeAsync(60000);expect(f.request).toHaveBeenCalledTimes(1);expect(f.client.state().status).toBe('readonly');
});
function nativeFixture(holder='other',outgoing?:{requestId:string;state:string;sameAccount:boolean},canApprove=true,prepareManager?:(manager:any)=>void){
 vi.spyOn(document,'hasFocus').mockReturnValue(true);
 history.replaceState({},'', '/project/canvas/project');document.body.innerHTML='<div class="react-flow"><div class="react-flow__node"><textarea>Retained text</textarea></div></div>';
 const wait=gate<any>();let permission=true,user:any={id:'user'},attachment:any,access=()=>{},auth=()=>{},owner:any,waiting=true,occupied=false;const readListeners=new Set<()=>void>(),read={isRead:false,setIsRead(value:boolean){read.isRead=value;for(const listener of readListeners)listener();}};
 const manager:any={enqueue:vi.fn(()=>true),addEdge:vi.fn(()=>true),applyHistoryTransition:vi.fn(()=>true),appendNodeOutputHistoryEntry:vi.fn(()=> 'appended'),removeNodeOutputHistoryItem:vi.fn(()=>({status:'deleted'}))};prepareManager?.(manager);attachment={id:'project',client:manager};
 const serverReceipt=()=>({...receipt(owner),leaseId:'lease-for-test',state:'HELD'});let admitted=false;
 const request=vi.fn(async(_path:string,options:any)=>{
  if(options.method==='DELETE')return{data:{released:true}};
  if(options.method==='GET')return{data:{projectId:'project',state:occupied?'OCCUPIED':admitted?'HELD':'FREE',leaseId:'lease-for-test',incoming:[],...(occupied?{holder:{userId:holder,displayName:'另一个人',canApprove},outgoing}:{})}};
  if(waiting)return wait.promise;
  if(occupied)throw new ApiError(409,'PROJECT_EDIT_OCCUPIED','另一页面正在编辑。');
  admitted=true;return{data:serverReceipt()};
 });
 const runtime:any={prepareCanvasHandoff:async()=>{},syncCanvasHandoff:async()=>1,finishCanvasHandoff:async()=>{},api:{requestV2:request},auth:{get user(){return user;},onClear:(callback:any)=>{auth=callback;return()=>{};}},storage:{canEdit:()=>permission,subscribeAccess:(callback:any)=>{access=callback;return()=>{};}},canvasAttachment:()=>attachment,setCanvasEditSession:(value:any)=>{owner=value;}};
 const notice=vi.fn(),native:any={r:{useCallback:(fn:Function)=>fn},bt:()=>runtime.canvasAttachment()?.client,bq:{getState:()=>read,subscribe:(listener:()=>void)=>{readListeners.add(listener);return()=>readListeners.delete(listener);}},j:{jsx:(_type:any,props:any)=>props,jsxs:(_type:any,props:any)=>props}},original=manager.enqueue,dispose=installCanvasEditSession(runtime,native,window,document,notice);cleanups.push(dispose);
 return{runtime,native,manager,original,read,request,dispose,notice,grant:()=>{waiting=false;admitted=true;wait.resolve({data:serverReceipt()});},occupied:()=>{waiting=false;occupied=true;wait.resolve(Promise.reject(new ApiError(409,'PROJECT_EDIT_OCCUPIED','另一页面正在编辑。')));},user:(value:any)=>{user=value;auth();},permission:(value:boolean)=>{permission=value;access();},attachment:(value:any)=>{attachment=value;window.dispatchEvent(new Event('rhtv:canvas-attachment'));}};
}
it('locks native controls before admission and preserves ordinary held-session pointer and input events unchanged',async()=>{
 const f=nativeFixture(),input=document.querySelector('textarea')!,node=input.parentElement!,pointer=vi.fn();node.addEventListener('pointerdown',pointer);expect(f.read.isRead).toBe(true);expect(f.manager.enqueue({kind:'addNode'})).toBe(false);expect(f.original).not.toHaveBeenCalled();expect(node.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,cancelable:true}))).toBe(false);expect(pointer).not.toHaveBeenCalled();f.grant();await vi.waitFor(()=>expect(f.read.isRead).toBe(false));expect(node.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,cancelable:true}))).toBe(true);expect(pointer).toHaveBeenCalledTimes(1);expect(f.manager.enqueue({kind:'patchNodeData'})).toBe(true);expect(f.original).toHaveBeenCalledTimes(1);expect(document.querySelector('[data-studio-presence]')).toBeNull();
});
it('locks offline edits immediately, retains input and restores the native page after reacquisition',async()=>{
 const f=nativeFixture();f.grant();await vi.waitFor(()=>expect(f.read.isRead).toBe(false));window.dispatchEvent(new Event('offline'));expect(f.read.isRead).toBe(true);const input=document.querySelector('textarea')!;expect(input.dispatchEvent(new InputEvent('beforeinput',{bubbles:true,cancelable:true,data:'lost'}))).toBe(false);expect(input.value).toBe('Retained text');expect(document.querySelector('[data-studio-canvas-edit-session]')?.textContent).toContain('网络已断开');window.dispatchEvent(new Event('online'));await vi.waitFor(()=>expect(f.read.isRead).toBe(false));expect(input.value).toBe('Retained text');
});
it('does not override native temporary read-only modes after a session is already held',async()=>{
 const f=nativeFixture();f.grant();await vi.waitFor(()=>expect(f.read.isRead).toBe(false));f.read.setIsRead(true);await f.runtime.canvasAttachment();window.dispatchEvent(new Event('rhtv:canvas-attachment'));expect(f.read.isRead).toBe(true);
});
it('restores only its own manager wrappers and locks on permission revocation',async()=>{
 const f=nativeFixture();f.grant();await vi.waitFor(()=>expect(f.read.isRead).toBe(false));f.permission(false);expect(f.read.isRead).toBe(true);expect(f.manager.addEdge({id:'edge'})).toBe(false);f.permission(true);await vi.waitFor(()=>expect(f.read.isRead).toBe(false));const later=vi.fn();f.manager.enqueue=later;f.dispose();expect(f.manager.enqueue).toBe(later);
});

it('invalidates a cached writer immediately after an expired operation response and confirms fresh ownership',async()=>{
 const f=fixture();await f.client.start();const wait=gate<any>();f.setWait(wait.promise);f.client.invalidate(new ApiError(409,'EDIT_SESSION_EXPIRED','重新连接'));expect(f.client.holds()).toBe(false);expect(f.client.state().status).toBe('offline');wait.resolve({data:receipt(f.client)});await vi.waitFor(()=>expect(f.client.holds()).toBe(true));f.client.invalidate(new ApiError(409,'PROJECT_EDIT_OCCUPIED','另一页面编辑'));expect(f.client.holds()).toBe(false);expect(f.client.state()).toMatchObject({status:'occupied',message:'另一页面编辑'});
});

it('resumes retained operations once when reconnecting actually regains the writer',async()=>{
 const f=nativeFixture();let pending=false;f.runtime.storage.hasDraft=()=>pending;f.runtime.resumeCanvasOperations=vi.fn();f.grant();await vi.waitFor(()=>expect(f.read.isRead).toBe(false));expect(f.runtime.resumeCanvasOperations).not.toHaveBeenCalled();window.dispatchEvent(new Event('offline'));pending=true;expect(f.runtime.resumeCanvasOperations).not.toHaveBeenCalled();window.dispatchEvent(new Event('online'));await vi.waitFor(()=>expect(f.runtime.resumeCanvasOperations).toHaveBeenCalledExactlyOnceWith('project'));window.dispatchEvent(new Event('rhtv:canvas-attachment'));expect(f.runtime.resumeCanvasOperations).toHaveBeenCalledTimes(1);
});

it('blocks offline Delete before the native window-capture shortcut can consume it',async()=>{
 const f=nativeFixture();f.grant();await vi.waitFor(()=>expect(f.read.isRead).toBe(false));const shortcut=vi.fn();window.addEventListener('keydown',shortcut,true);cleanups.push(()=>window.removeEventListener('keydown',shortcut,true));window.dispatchEvent(new Event('offline'));const event=new KeyboardEvent('keydown',{key:'Delete',bubbles:true,cancelable:true});document.body.dispatchEvent(event);expect(event.defaultPrevented).toBe(true);expect(shortcut).not.toHaveBeenCalled();window.dispatchEvent(new Event('online'));await vi.waitFor(()=>expect(f.read.isRead).toBe(false));document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'Delete',bubbles:true,cancelable:true}));expect(shortcut).toHaveBeenCalledTimes(1);
});

const frozen=readFileSync(new NodeURL('../../apps/web/public/project/assets/index-DeyN_Phq.js',import.meta.url),'utf8');
function seam(start:string,end:string){const from=frozen.indexOf(start),to=frozen.indexOf(end,from+start.length);if(from<0||to<0)throw Error('Frozen deletion seam changed');return frozen.slice(from,to);}
it.each(['before-adapter','after-adapter'])('protects the real frozen deleteElements even if its stale native window capture was registered %s',async order=>{
 let remove:(()=>void)|undefined;const handler=runInNewContext('('+seam('L=F=>{const V=F.metaKey||F.ctrlKey;if(!AWe',',D=F=>{AWe').slice(2)+')',{AWe:()=>false,LGr:()=>false,a:()=>remove?.()});const key=(event:KeyboardEvent)=>handler(event);if(order==='before-adapter')window.addEventListener('keydown',key,true);const f=nativeFixture();if(order==='after-adapter')window.addEventListener('keydown',key,true);cleanups.push(()=>window.removeEventListener('keydown',key,true));f.grant();await vi.waitFor(()=>expect(f.read.isRead).toBe(false));
 const view:any={nodes:[{id:'a'},{id:'b'}],edges:[{id:'ab',source:'a',target:'b'}]},changedNodes=vi.fn(),changedEdges=vi.fn();const props=f.native.j.jsx('flow',{...view,onNodesChange:changedNodes,onEdgesChange:changedEdges});const before=props.onBeforeDelete;
 const NHn=runInNewContext(seam('async function NHn(','const fR=')+';NHn',{_Hn:(nodes:any[],edges:any[])=>edges.filter(edge=>nodes.some(node=>edge.source===node.id||edge.target===node.id))});
 const store={getState:()=>({...view,onBeforeDelete:before,onNodesDelete:vi.fn(),onEdgesDelete:vi.fn(),triggerNodeChanges:(rows:any[])=>{changedNodes(rows);view.nodes=view.nodes.filter((node:any)=>!rows.some(row=>row.id===node.id));},triggerEdgeChanges:(rows:any[])=>{changedEdges(rows);view.edges=view.edges.filter((edge:any)=>!rows.some(row=>row.id===edge.id));}})};
 const deletion=runInNewContext('('+seam('deleteElements:async({nodes:p=[],edges:m=[]})=>{','},getIntersectingNodes:').slice('deleteElements:'.length)+'})',{t:store,NHn,G8e:(row:any)=>({id:row.id,type:'remove'})});let work:Promise<any>|undefined;remove=()=>{work=deletion({nodes:[{id:'b'}],edges:[]});};
 window.dispatchEvent(new Event('offline'));document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'Delete',bubbles:true,cancelable:true}));await work;expect(view.nodes.map((node:any)=>node.id)).toEqual(['a','b']);expect(view.edges).toHaveLength(1);expect(changedNodes).not.toHaveBeenCalled();expect(changedEdges).not.toHaveBeenCalled();expect(f.original).not.toHaveBeenCalled();
 window.dispatchEvent(new Event('online'));await vi.waitFor(()=>expect(f.read.isRead).toBe(false));document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'Delete',bubbles:true,cancelable:true}));await work;expect(view.nodes.map((node:any)=>node.id)).toEqual(['a']);expect(view.edges).toEqual([]);expect(changedNodes).toHaveBeenCalledTimes(1);expect(changedEdges).toHaveBeenCalledTimes(1);
});

it('describes a same-account reader as an automatic foreground switch even if an old request has expired',async()=>{
 const f=nativeFixture('user',{requestId:'old',state:'EXPIRED',sameAccount:true});
 await vi.waitFor(()=>expect(f.request).toHaveBeenCalled());
 vi.mocked(document.hasFocus).mockReturnValue(false);window.dispatchEvent(new Event('blur'));f.occupied();await vi.waitFor(()=>expect(document.querySelector('.studio-canvas-edit-session p')?.textContent).toContain('切回此页会自动接手'));
 expect(document.querySelector('.studio-canvas-edit-session p')?.textContent).not.toMatch(/申请|过期/);
});

it('explains why an older page owned by another account cannot approve an edit request',async()=>{
 const f=nativeFixture('other',undefined,false);await vi.waitFor(()=>expect(f.request).toHaveBeenCalled());f.occupied();
 await vi.waitFor(()=>expect(document.querySelector('.studio-canvas-edit-session p')?.textContent).toContain('旧版画布，请对方刷新或退出'));
});

it('opens quietly, shows only passive progress on a slow first load, and removes it when editing is ready',async()=>{
 vi.useFakeTimers();const f=nativeFixture(),panel=document.querySelector<HTMLElement>('[data-studio-canvas-edit-session]')!;
 expect(panel.hidden).toBe(true);await vi.advanceTimersByTimeAsync(1100);expect(panel.hidden).toBe(true);
 await vi.advanceTimersByTimeAsync(110);expect(panel.hidden).toBe(false);expect(panel.hasAttribute('data-quiet')).toBe(true);
 expect(panel.querySelector('button:not([hidden])')).toBeNull();
 expect(panel.querySelector('p')!.textContent).not.toMatch(/交接|保留|验证/);
 f.grant();await vi.advanceTimersByTimeAsync(10);expect(f.read.isRead).toBe(false);expect(panel.hidden).toBe(true);
});

const shell=readFileSync(new NodeURL('../../apps/web/public/project/assets/CanvasEditorShell-Dt_89lTt.js',import.meta.url),'utf8');
function shellSeam(start:string,end:string){const from=shell.indexOf(start),to=shell.indexOf(end,from+start.length);if(from<0||to<0)throw Error('Frozen history use seam changed');return shell.slice(from,to);}
function historyFixture(){
 const graph:any={nodes:[],edges:[]},view:any={nodes:[],edges:[]},optimistic=vi.fn((nodes:any[],edges:any[])=>{view.nodes.push(...nodes);view.edges.push(...edges);}),close=vi.fn(),failed=vi.fn();
 const f=nativeFixture('other',undefined,true,manager=>{
  // Use the actual frozen paste contract, including its missing success return.
  manager.pasteGraph=runInNewContext('({'+seam('pasteGraph(t,n,r){','applyHistoryTransition(')+'}).pasteGraph');
  manager.enqueue.mockImplementation((operation:any)=>{graph.nodes.push(...operation.nodes);graph.edges.push(...operation.edges);return true;});
  manager.getRemoteData=()=>graph;manager.flushOperationQueue=vi.fn();manager.setRemoteSyncPaused=vi.fn();manager.isWriteBlocked=vi.fn(()=>false);
 });
 const restored={id:'restored',type:'rh-video',position:{x:1,y:2},data:{output:[{url:'rhtv-asset:video'}]}},Ln=()=>f.manager;
 const mc=runInNewContext(seam('function mc(e){','function SHe(')+';mc',{Ln,queueMicrotask});
 const callbackBody=seam('A=d.useCallback((F,V,$)=>{const B=h(),j=ter(', ',L=d.useCallback(F=>{if(!F.length').slice(2);
 const makeRestore=(react:any)=>runInNewContext(callbackBody,{d:react,h:()=>graph,ter:()=>({nodes:[restored],edges:[]}),o:undefined,n:undefined,r:optimistic,fa:()=>{},mc,Ln,Rx:()=>{}});
 const restore=makeRestore(f.native.r);let load:()=>Promise<any>=async()=>({nodeId:'original'});
 const Jr=runInNewContext(shellSeam('Jr=p.useCallback(async(F,ge,ke)=>{',',Ad=p.useCallback(').slice(3),{p:{useCallback:(fn:Function)=>fn},qr:restore,o:(key:string)=>key,tk:()=>load(),Jo:()=>({x:1,y:2}),Ie:{error:failed}});
 const take=runInNewContext(shellSeam('xa=p.useCallback(async(F,ge)=>{const ke=await Jr(', ',Fl=p.useCallback(').slice(3),{p:{useCallback:(fn:Function)=>fn},Jr,me:close});
 const item={url:'rhtv-asset:video',canvasHistoryTaskId:'task',canvasHistoryTaskPlanId:'plan'};
 return{...f,graph,view,optimistic,close,failed,restored,restore,rerender:()=>makeRestore(f.native.r),bare:()=>makeRestore({useCallback:(fn:Function)=>fn}),take:()=>take(item,'video'),load:(value:()=>Promise<any>)=>{load=value;}};
}
it('reproduces the frozen false-success boundary without the exact history admission guard',()=>{
 const f=historyFixture();const result=f.bare()({}, {}, {});expect(result).toBe(f.restored);expect(f.view.nodes).toEqual([f.restored]);expect(f.graph.nodes).toEqual([]);expect(f.original).not.toHaveBeenCalled();
});
it('keeps history open while admission is pending, then uses the same empty canvas successfully',async()=>{
 const f=historyFixture();expect(await f.take()).toBe(false);expect(f.close).not.toHaveBeenCalled();expect(f.optimistic).not.toHaveBeenCalled();expect(f.graph.nodes).toEqual([]);expect(f.notice).toHaveBeenCalledWith(expect.stringContaining('历史内容尚未加入'));
 f.grant();await vi.waitFor(()=>expect(f.read.isRead).toBe(false));expect(await f.take()).toBe(true);expect(f.close).toHaveBeenCalledExactlyOnceWith(false);expect(f.graph.nodes).toEqual([f.restored]);expect(f.view.nodes).toEqual([f.restored]);expect(f.original).toHaveBeenCalledOnce();expect(f.failed).not.toHaveBeenCalled();
});
it('rejects a late history detail read after disconnect and succeeds after reconnect on the same page',async()=>{
 const f=historyFixture();f.grant();await vi.waitFor(()=>expect(f.read.isRead).toBe(false));const wait=gate<any>();f.load(()=>wait.promise);const take=f.take();window.dispatchEvent(new Event('offline'));wait.resolve({nodeId:'original'});
 expect(await take).toBe(false);expect(f.close).not.toHaveBeenCalled();expect(f.optimistic).not.toHaveBeenCalled();expect(f.graph.nodes).toEqual([]);expect(f.notice).toHaveBeenCalledWith(expect.stringContaining('历史内容尚未加入'));
 window.dispatchEvent(new Event('online'));await vi.waitFor(()=>expect(f.read.isRead).toBe(false));expect(await f.take()).toBe(true);expect(f.graph.nodes).toEqual([f.restored]);expect(f.view.nodes).toEqual([f.restored]);
});
it.each(['readonly','native-blocked','temporary-readonly'])('does not show an optimistic history node when %s',async reason=>{
 const f=historyFixture();f.grant();await vi.waitFor(()=>expect(f.read.isRead).toBe(false));if(reason==='readonly')f.permission(false);else if(reason==='native-blocked')f.manager.isWriteBlocked.mockReturnValue(true);else f.read.setIsRead(true);
 expect(await f.take()).toBe(false);expect(f.graph.nodes).toEqual([]);expect(f.view.nodes).toEqual([]);expect(f.close).not.toHaveBeenCalled();expect(f.notice).toHaveBeenCalled();
});
it.each(['project','identity','manager','disposed'])('rejects a late history use for an obsolete %s',async reason=>{
 const f=historyFixture();f.grant();await vi.waitFor(()=>expect(f.read.isRead).toBe(false));const wait=gate<any>();f.load(()=>wait.promise);const take=f.take();
 if(reason==='project')history.replaceState({},'', '/project/canvas/other');else if(reason==='identity')f.user({id:'different-user'});else if(reason==='manager')f.attachment({id:'project',client:{...f.manager}});else f.dispose();
 wait.resolve({nodeId:'original'});expect(await take).toBe(false);expect(f.graph.nodes).toEqual([]);expect(f.view.nodes).toEqual([]);expect(f.close).not.toHaveBeenCalled();if(reason!=='disposed')expect(f.notice).toHaveBeenCalledWith(expect.stringContaining('画布或账号已切换'));
});
it('leaves unrelated native callbacks alone and restores the callback hook on disposal',()=>{
 const f=historyFixture(),unrelated=vi.fn(()=>true);expect(f.native.r.useCallback(unrelated,[undefined,undefined,undefined,()=>{}])).toBe(unrelated);f.dispose();expect(f.restore({}, {}, {})).toBeNull();expect(f.native.r.useCallback(unrelated,[])).toBe(unrelated);expect(f.notice).not.toHaveBeenCalled();
});
it.each(['same-account-login','project-roundtrip','project-roundtrip-before-attachment'])('does not revive a late history use after %s reuses the same native manager',async reason=>{
 const f=historyFixture();f.grant();await vi.waitFor(()=>expect(f.read.isRead).toBe(false));const wait=gate<any>();f.load(()=>wait.promise);const take=f.take();
 if(reason==='same-account-login'){f.user({id:'user'});f.attachment({id:'project',client:f.manager});}
 else if(reason==='project-roundtrip-before-attachment'){history.replaceState({},'', '/project/canvas/other');window.dispatchEvent(new PopStateEvent('popstate'));history.replaceState({},'', '/project/canvas/project');window.dispatchEvent(new PopStateEvent('popstate'));}
 else {history.replaceState({},'', '/project/canvas/other');f.attachment(null);history.replaceState({},'', '/project/canvas/project');f.attachment({id:'project',client:f.manager});}
 await vi.waitFor(()=>expect(f.read.isRead).toBe(false));wait.resolve({nodeId:'original'});expect(await take).toBe(false);expect(f.graph.nodes).toEqual([]);expect(f.view.nodes).toEqual([]);expect(f.close).not.toHaveBeenCalled();expect(f.notice).toHaveBeenCalledWith(expect.stringContaining('画布或账号已切换'));
 expect(f.rerender()({}, {}, {})).toBe(f.restored);expect(f.graph.nodes).toEqual([f.restored]);expect(f.view.nodes).toEqual([f.restored]);
});
it('retains the same history callback through a same-manager BFCache suspension and re-admission',async()=>{
 const f=historyFixture();f.grant();await vi.waitFor(()=>expect(f.read.isRead).toBe(false));window.dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true}));expect(f.restore({}, {}, {})).toBeNull();expect(f.optimistic).not.toHaveBeenCalled();window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}));await vi.waitFor(()=>expect(f.read.isRead).toBe(false));expect(await f.take()).toBe(true);expect(f.graph.nodes).toEqual([f.restored]);expect(f.view.nodes).toEqual([f.restored]);
});
it('does not mistake a different paste callback containing filter() for the exact ter() history restore',()=>{
 const f=historyFixture(),rows:any[]=[],manager=f.manager,unrelated=()=>{const filtered=rows.filter(()=>true);manager.pasteGraph(filtered,[]);manager.flushOperationQueue();return 'unrelated';};expect(f.native.r.useCallback(unrelated,[undefined,undefined,undefined,()=>{}])).toBe(unrelated);
});
