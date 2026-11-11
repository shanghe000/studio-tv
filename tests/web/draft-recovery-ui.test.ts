// @vitest-environment happy-dom
import {afterEach,expect,it,vi} from 'vitest';
import {installDraftRecoveryUi} from '../../apps/web/src/service/draft-recovery-ui';

let dispose:(()=>void)|undefined;
afterEach(()=>{dispose?.();dispose=undefined;document.body.replaceChildren();window.history.replaceState(null,'','/');vi.restoreAllMocks();});
const paint=()=>new Promise(resolve=>setTimeout(resolve,0));
const status=()=>document.querySelector<HTMLElement>('[data-studio-canvas-sync-status]')!;
const retry=()=>document.querySelector<HTMLButtonElement>('[data-sync-retry]')!;
function deferred(){let resolve!:()=>void,reject!:(error:unknown)=>void;const promise=new Promise<void>((done,fail)=>{resolve=done;reject=fail;});return{promise,resolve,reject};}
function fixture(){
 let projectId='p',hasDraft=true,canEdit=true;
 const listeners=new Set<()=>void>(),clearListeners=new Set<()=>void>();
 const view:any={projectId:'p',blocked:true,blockedReason:'MERGE_CONFLICT',busy:false,persistence:'saved',conflicts:[{path:'/nodes/n/data/params/prompt',reason:'FIELD_CHANGED',localValue:'Never display this retained text',serverValue:'Never display the remote text'}],backups:[]};
 const storage={subscribeDrafts:(fn:()=>void)=>{listeners.add(fn);return()=>listeners.delete(fn);},refreshDraftBackups:vi.fn(),draftRecoveryState:()=>view,draftConflictDetails:vi.fn(()=>view.conflicts),canEdit:()=>canEdit,hasDraft:()=>hasDraft};
 const runtime:any={auth:{user:{id:'u'},onClear:(fn:()=>void)=>{clearListeners.add(fn);return()=>clearListeners.delete(fn);}},storage,canvasAttachment:()=>({id:projectId}),exportCanvasDraft:vi.fn(),restoreCanvasDraft:vi.fn(),importCanvasDraft:vi.fn(),recoverCanvasDraft:vi.fn(),retryCanvasSync:vi.fn(async()=>{view.blocked=false;view.conflicts=[];hasDraft=false;})};
 dispose=installDraftRecoveryUi(runtime);return{runtime,view,changed:()=>{for(const fn of listeners)fn();},setDraft:(value:boolean)=>{hasDraft=value;},setEditable:(value:boolean)=>{canEdit=value;},switchProject:()=>{projectId='q';for(const fn of listeners)fn();},clear:()=>{runtime.auth.user=null;for(const fn of clearListeners)fn();},listenerCount:()=>listeners.size+clearListeners.size};
}

it('shows only interrupted-sync status and retry without any version or draft-management flow',async()=>{
 const f=fixture();await paint();expect(status().hidden).toBe(false);expect(status().textContent).toContain('部分修改尚未同步');expect(retry().textContent).toBe('重试同步');
 expect(document.querySelector('dialog,input,select,pre,a')).toBeNull();expect(document.body.textContent).not.toMatch(/草稿|备份|版本|服务器|导入|导出|Never display/);expect(f.runtime.storage.draftConflictDetails).not.toHaveBeenCalled();expect(f.runtime.storage.refreshDraftBackups).not.toHaveBeenCalled();
});

it.each(['normal','prior backups','old query switch','memory-only with no retained edits'])('keeps a normal canvas quiet despite %s',async variant=>{
 if(variant==='old query switch')window.history.replaceState(null,'','/?draftRecovery=1');const f=fixture();Object.assign(f.view,{blocked:false,conflicts:[],persistence:variant==='memory-only with no retained edits'?'memory-only':'none'});f.setDraft(false);
 if(variant==='prior backups')f.view.backups=[{id:'prior-page',currentPage:false,nodeCount:5}];f.changed();await paint();expect(status().hidden).toBe(true);expect(document.querySelector('dialog,input,select,a')).toBeNull();expect(f.runtime.retryCanvasSync).not.toHaveBeenCalled();
});

it('calls only the technical-free retry port once while its request is pending',async()=>{
 const f=fixture(),pending=deferred();f.runtime.retryCanvasSync.mockImplementationOnce(()=>pending.promise);await paint();retry().click();retry().click();await paint();expect(f.runtime.retryCanvasSync).toHaveBeenCalledExactlyOnceWith();expect(retry().disabled).toBe(true);expect(retry().textContent).toBe('正在同步…');expect(status().textContent).toContain('正在重新连接');
 pending.resolve();await paint();expect(status().hidden).toBe(false);expect(retry().disabled).toBe(false);expect(f.runtime.recoverCanvasDraft).not.toHaveBeenCalled();expect(f.runtime.exportCanvasDraft).not.toHaveBeenCalled();expect(f.runtime.importCanvasDraft).not.toHaveBeenCalled();
});

it('does not invent a successful save when a retry resolves but retained edits are still blocked',async()=>{
 const f=fixture();f.runtime.retryCanvasSync.mockResolvedValueOnce(undefined);await paint();retry().click();await paint();expect(status().hidden).toBe(false);expect(status().textContent).toContain('尚未同步');expect(status().textContent).not.toContain('已保存');
});

it('hides the interruption once storage confirms the retained edits have synced',async()=>{
 const f=fixture();await paint();retry().click();await paint();expect(status().hidden).toBe(true);expect(f.runtime.retryCanvasSync).toHaveBeenCalledExactlyOnceWith();
});

it('keeps a real overlap private and renders only a valid support log number after refusal',async()=>{
 const f=fixture(),requestId='96a1c0c3-2042-46ed-a96a-2cc455e1fee8';f.runtime.retryCanvasSync.mockRejectedValueOnce({message:'Choose a local/server version: private conflict text',requestId});await paint();retry().click();await paint();expect(status().hidden).toBe(false);expect(status().textContent).toContain('日志编号：'+requestId);expect(status().textContent).not.toMatch(/Choose|local\/server|private conflict|版本/);expect(retry().disabled).toBe(false);
});

it('never displays arbitrary response IDs or raw recovery errors',async()=>{
 const f=fixture();f.runtime.retryCanvasSync.mockRejectedValueOnce({message:'Export a draft, choose local or server',requestId:'https://private.invalid/?token=do-not-render'});await paint();retry().click();await paint();expect(document.body.textContent).not.toMatch(/Export|local|server|private.invalid|do-not-render/);expect(document.querySelector<HTMLElement>('[data-sync-log]')!.hidden).toBe(true);
});

it('describes memory-only protection accurately and waits for editor permission',async()=>{
 const f=fixture();f.view.persistence='memory-only';f.setEditable(false);f.changed();await paint();expect(status().textContent).toContain('内容保留在当前页面');expect(status().textContent).toContain('恢复编辑权限');expect(retry().disabled).toBe(true);retry().click();expect(f.runtime.retryCanvasSync).not.toHaveBeenCalled();
});

it('does not carry an old project request failure or busy state into the next canvas',async()=>{
 const f=fixture(),pending=deferred();f.runtime.retryCanvasSync.mockImplementationOnce(()=>pending.promise);await paint();retry().click();f.switchProject();await paint();expect(retry().disabled).toBe(false);pending.reject({requestId:'96a1c0c3-2042-46ed-a96a-2cc455e1fee8'});await paint();expect(document.querySelector<HTMLElement>('[data-sync-log]')!.hidden).toBe(true);expect(status().textContent).not.toContain('96a1c0c3');
});

it('removes private status on sign-out and releases every subscription on disposal',async()=>{
 const f=fixture();await paint();f.clear();await paint();expect(status().hidden).toBe(true);dispose!();dispose=undefined;expect(f.listenerCount()).toBe(0);expect(document.querySelector('[data-studio-canvas-sync-status]')).toBeNull();expect(document.getElementById('studio-canvas-sync-styles')).toBeNull();
});
