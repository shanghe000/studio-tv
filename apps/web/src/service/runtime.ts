import {unsupportedNativeOperation} from './unsupported-operation';
import {config} from '../config';
import type {Snapshot} from '../api/types';
import {ApiError} from '../api/client';
import {INTERNAL_FEATURE_MESSAGE} from '../features/policy';
import {ProductClient} from './product-client';
import {ExecutionAdapter} from './execution';
import {ResourceAdapter} from './resources';
import {AssistantAdapter,assistantNativeConfig} from './assistant';
import {StudioAdapter} from './studio';
import {NotificationAdapter} from './notifications';
import {OrganizationAdapter} from './organization';
import {CollaborationAdapter} from './collaboration';
import {installNativeIntegration} from './native-integration';
import {AuthSession,installNativeSessionBridge} from '../api/auth';
import {ServiceStorage} from './storage';
import {installFeishuLogin} from '../api/feishu-ui';
import {CanvasSync} from './canvas-sync';
import {projectAccessDenied,retryableCanvasRead} from './project-access';
import {CanvasSaveScheduler} from './canvas-save-scheduler';
import {canvasSaveRetryDelay,transientCanvasSaveFailure} from './canvas-save-retry';
import {nativeCanvasSyncPort,REMOTE_CANVAS_ORIGIN} from './native-canvas-sync';
import {canvasProjectFromPath} from './canvas-lifecycle';
import type {ServiceLoginGate} from '../api/login-gate';
const nativeFetch=window.fetch.bind(window);
const notice=(text:string)=>window.__RHTV_PREVIEW__?.notice(text);
const api=new ProductClient(config.apiBase,nativeFetch,config.features),auth=new AuthSession(api),storage=new ServiceStorage(api,notice,()=>auth.user?.id??null);
const execution:ExecutionAdapter=new ExecutionAdapter(api,storage,async():Promise<void>=>{await serviceRuntime.waitForSave();},notice,{allowTestMode:config.mode!=='service'});
execution.setCanvasLeasePort({flushPending:id=>serviceRuntime.flushCanvasMutations(id),acquire:(id,nodes)=>serviceRuntime.acquireCanvasNodes(id,nodes)});
const resources=new ResourceAdapter(api,{encodeAsset:storage.encodeAsset,resolveAsset:(reference:string)=>storage.resolveAsset(reference),registerCatalogMedia:storage.registerCatalogMedia,nativeConfigs:{CANVAS_NEW_AGENT:assistantNativeConfig.content}});
const assistant=new AssistantAdapter(api,{resolveAsset:(reference:string)=>storage.resolveAsset(reference),beforeCanvasRun:async(projectId,signal)=>{
 storage.requirePermission(projectId,'canRun');
 const epoch=attachmentEpoch;
 if(signal.aborted)throw new DOMException('Assistant request cancelled','AbortError');
 if(managerId&&managerId!==projectId)throw new ApiError(409,'STALE_CANVAS_SESSION','画布已切换，请重新打开会话。');
 await ensureCanvasSaved('继续创作');
 const check=()=>{
  if(signal.aborted)throw new DOMException('Assistant request cancelled','AbortError');
  if(epoch!==attachmentEpoch||(managerId&&managerId!==projectId))throw new ApiError(409,'STALE_CANVAS_SESSION','画布已切换，请重新打开会话。');
  storage.requirePermission(projectId,'canRun');
  if(dirty||storage.hasPending()||(managerId&&storage.isBlocked(managerId)))throw new Error('当前画布尚未保存，请处理后再继续创作。');
 };
 check();return check;
}});
const studio=new StudioAdapter(api,()=>{if(managerId)storage.requirePermission(managerId);});
const notifications=new NotificationAdapter(api);
const organization=new OrganizationAdapter(api,storage);
const collaboration=new CollaborationAdapter(api,storage,()=>auth.user?.id??null);
let loginGate:ServiceLoginGate|null=null;
api.onRevoked(error=>{loginGate?.denied(error);auth.clear();});
installNativeSessionBridge(auth);
const requestedReturnTo=location.pathname+location.search+location.hash;
const feishuLogin=installFeishuLogin(api,()=>/^\/project\/canvas\//.test(requestedReturnTo)?requestedReturnTo:location.pathname+location.search+location.hash,{restore:()=>auth.restore(),recovered:()=>{const retry=document.querySelector<HTMLButtonElement>('.route-status-page button');if(/^\/project\/canvas\//.test(location.pathname)&&retry&&/^(?:重新加载|Reload)$/.test(retry.textContent?.trim()??''))retry.click();}});
let manager:any=null,managerDoc:any=null,managerId:string|null=null,unsubscribe:(()=>void)|null=null,updateListener:(()=>void)|null=null;
const autosave=new CanvasSaveScheduler(()=>serviceRuntime.flush()),saving=new Map<string,Promise<void>>();let saveRetries=0;
let transientSaveSince:number|undefined,transientSaveNotified=false;
function resetTransientSave(){transientSaveSince=undefined;transientSaveNotified=false;}
function scheduleCanvasSave(projectId:string){
 if(storage.usesCanvasOperations(projectId))autosave.queueCommitted();
 else autosave.queue();
}
let dirty=false,lastSaved='',attachmentEpoch=0,canvasPageActive=true,managerIdentityId:string|null=null;
let canvasSync:CanvasSync|null=null,applyingRemote=false,lastObserved='',permissionTimer:number|undefined;
let resumeCanvasSync:(()=>void)|null=null,recoveringDraft=false,draftRecoveryOwner:symbol|null=null;
interface CanvasPresencePort {projectId:string;userId:string;clientId:string;acquire:(ids:string[])=>Promise<void>;flushPending?:()=>Promise<void>;hasPending?:()=>boolean;stop?:()=>void}
let canvasPresence:CanvasPresencePort|null=null;
export interface CanvasEditSessionPort {projectId:string;userId:string;clientId:string;pageProof?:string;current:()=>boolean;ensure:()=>Promise<void>;holds?:()=>boolean;editTenure?:()=>string|undefined;permitsObservedRevision?:()=>boolean;ownsLease?:()=>boolean;ensureForSave?:()=>Promise<void>;invalidate?:(error?:unknown)=>void;stop?:()=>void}
let canvasEditSession:CanvasEditSessionPort|null=null;
// Authenticated native startup enters operation-only mode before the first
// document mounts. Maintenance callers can initialize unmounted projects.
let nativeCanvasStartup=false;
const canvasWritable=(id:string)=>storage.canEdit(id)&&!(canvasEditSession?.projectId===id&&canvasEditSession.holds?.()===false);
function enableCanvasOperationPort(owned:CanvasEditSessionPort){
 storage.enableCanvasOperations(owned.projectId,{userId:owned.userId,clientId:owned.clientId,tenure:()=>owned.editTenure?.(),permitsObservedRevision:owned.permitsObservedRevision,invalidate:error=>owned.invalidate?.(error),ensure:async()=>{
  if(canvasEditSession!==owned||!owned.current())throw new ApiError(409,'CANVAS_SESSION_PENDING','画布编辑连接正在恢复，当前操作已保留。');
  await (owned.ensureForSave?.()??owned.ensure());
 }},manager?.getRemoteData());
}
// Lease transitions are scoped to this document and manager. A pending response
// from a different login/page/transition may never overwrite the new display.
function handoffContext(id:string,clientId:string,signal?:AbortSignal){
 const page=canvasEditSession,client=manager,epoch=attachmentEpoch;
 const check=()=>{
  if(signal?.aborted||!page||page!==canvasEditSession||!page.current()||page.clientId!==clientId||
     page.projectId!==id||id!==managerId||!client||client!==manager||epoch!==attachmentEpoch||page.userId!==auth.user?.id){
   throw new DOMException('画布交接已取消','AbortError');
  }
 };
 check();
 return {client,check};
}
// Several phases can overlap (finish may take another snapshot). A missing
// stream alone never means the native document needs to be mounted again.
const syncPauses=new Set<symbol>();
function pauseHandoffSync(){
 const token=Symbol(),resume=resumeCanvasSync;syncPauses.add(token);
 canvasSync?.stop();canvasSync=null;
 return ()=>{syncPauses.delete(token);resume?.();};
}
function showHandoffSnapshot(id:string,client:any){
 const view=storage.readOnlyNativeView(id),displayedRevision=storage.snapshots.get(id)?.revision;
 const bridge=nativeCanvasSyncPort(client);
 applyingRemote=true;
 try{
  if(!bridge.available()||!bridge.apply(view))throw new ApiError(409,'CANVAS_VIEW_BUSY','请结束当前输入或拖动，画布会继续同步。');
 }finally{applyingRemote=false;}
 const current=client.getRemoteData();
 storage.remoteNativeViewApplied(id,current,displayedRevision);
 lastObserved=JSON.stringify(current);
 lastSaved=lastObserved;
 dirty=false;
}
function settleSavedCanvas(id:string,client:any,epoch:number,submitted:string){
 if(epoch!==attachmentEpoch||managerId!==id||manager!==client||dirty||recoveringDraft||storage.hasDraft(id)||storage.isBlocked(id)||JSON.stringify(client.getRemoteData())!==submitted)return;
 const merged=storage.mergedNativeView(id),displayedRevision=storage.snapshots.get(id)?.revision;if(merged.conflicts.length)return;
 const bridge=nativeCanvasSyncPort(client);if(!bridge.available()||!bridge.ready())return;
 applyingRemote=true;let applied=false;try{applied=bridge.apply(merged.graph);}finally{applyingRemote=false;}
 if(applied){storage.remoteNativeViewApplied(id,client.getRemoteData(),displayedRevision);lastObserved=JSON.stringify(client.getRemoteData());lastSaved=lastObserved;}
}
storage.subscribeAccess(id=>{
 if(!managerId||(id&&id!==managerId))return;
 if(!storage.canEdit(managerId)){autosave.cancel();dirty=false;}
 if(!storage.canRead(managerId)){canvasSync?.stop();canvasSync=null;return;}
 resumeCanvasSync?.();
 // During a failed access check local edits may enter the outbox; its immutable
 // IDs and the writer proof still apply when the service confirms the grant.
 if(dirty&&!storage.accessNeedsConfirmation(managerId)&&canvasWritable(managerId)&&!syncPauses.size&&!recoveringDraft)scheduleCanvasSave(managerId);
});
async function ensureCanvasSaved(action:string){
 const pending=managerId?serviceRuntime.flushCanvasMutations(managerId):undefined;if(pending)await pending;
 await serviceRuntime.waitForSave();
 if(dirty||storage.hasPending()||(managerId&&storage.isBlocked(managerId)))throw new Error(`当前画布尚未保存，请处理后再${action}。`);
}
async function signOut(){await ensureCanvasSaved('退出');if(loginGate)await loginGate.signOut(()=>auth.signOut());else await auth.signOut();}
async function changeCanvasDraft(action:(id:string)=>Promise<any>,commit=false){
 requireAccess();const id=managerId,client=manager,user=auth.user!.id,epoch=attachmentEpoch;
 if(!id||!client)throw new ApiError(409,'CANVAS_REQUIRED','请先打开需要恢复的画布。');
 if(recoveringDraft)throw new ApiError(409,'DRAFT_RECOVERY_BUSY','正在处理草稿，请稍候。');
 const current=()=>epoch===attachmentEpoch&&manager===client&&managerId===id&&auth.user?.id===user;
 storage.requirePermission(id,'canEdit');const bridge=nativeCanvasSyncPort(client);
 if(!bridge.available()||!bridge.ready())throw new ApiError(409,'CANVAS_NOT_READY','请结束画布中的输入或拖动，再恢复同步。');
 client.flushOperationQueue?.(true);storage.captureDraft(id,client.getRemoteData());autosave.cancel();
 const owner=Symbol('draft-recovery');draftRecoveryOwner=owner;recoveringDraft=true;canvasSync?.stop();canvasSync=null;
 try{
  try{await storage.wait(id);}catch(error){if(!(error instanceof ApiError&&['LOCAL_DRAFT_CONFLICT','VERSION_CONFLICT','SNAPSHOT_REVISION_MISMATCH'].includes(error.code)))throw error;}
  if(!current())throw new ApiError(409,'STALE_CANVAS_SESSION','画布已切换，草稿备份仍保留在原项目。');
  const result=await action(id);if(!current())throw new ApiError(409,'STALE_CANVAS_SESSION','画布已切换，请重新打开项目检查同步结果。');
  const graph=result.graph??result;
  applyingRemote=true;let applied=false;try{applied=bridge.apply(graph);}finally{applyingRemote=false;}
  // If the native view briefly defers a remote batch, acknowledge only its
  // current display baseline. The restarted sync will apply the saved draft.
  storage.remoteNativeViewApplied(id,client.getRemoteData());lastObserved=JSON.stringify(client.getRemoteData());
  if(commit){dirty=storage.hasDraft(id);lastSaved=applied&&!dirty?lastObserved:'';}else dirty=storage.hasDraft(id);
  return result;
 }finally{if(draftRecoveryOwner===owner){recoveringDraft=false;draftRecoveryOwner=null;if(!current()&&dirty)queueMicrotask(()=>serviceRuntime.flush());}if(current())resumeCanvasSync?.();}
}
auth.onClear(()=>{
 const leaveCanvas=managerId!==null;
 resetTransientSave();
 attachmentEpoch++;
 resumeCanvasSync=null;syncPauses.clear();recoveringDraft=false;draftRecoveryOwner=null;
 if(canvasEditSession){storage.suspendCanvasOperations(canvasEditSession.projectId);canvasEditSession=null;}
 if(canvasPresence){api.setCanvasSession(canvasPresence.projectId,null);canvasPresence=null;}
 clearTimeout(permissionTimer);
 canvasSync?.stop();canvasSync=null;
 if(manager&&updateListener)managerDoc?.off('update',updateListener);
 unsubscribe?.();autosave.cancel();manager=null;managerDoc=null;managerId=null;managerIdentityId=null;unsubscribe=null;updateListener=null;dirty=false;saveRetries=0;lastSaved='';lastObserved='';
 saving.clear();api.clearRequests();execution.clear();resources.clear();assistant.clear();studio.clear();notifications.clear();organization.clear();collaboration.clear();storage.clear();
 if(leaveCanvas&&!loginGate)location.replace('/projects/');
});
// Product access is checked live by the API. No IPAC scope or role is a TV UI concept.
function requireAccess(){if(!auth.user)throw new ApiError(401,'UNAUTHORIZED','请先使用飞书登录。');}
const success=(data:any)=>({code:0,msg:'success',errorMessages:null,data});
const userView=()=>auth.user?{id:auth.user.id,userId:auth.user.id,nickName:auth.user.displayName,nickname:auth.user.displayName,name:auth.user.displayName,userName:auth.user.displayName,headIcon:auth.user.avatarUrl,avatar:auth.user.avatarUrl,headImg:auth.user.avatarUrl,userRegion:'en_US'}:null;
const modelProjectId=()=>canvasProjectFromPath(location.pathname);
function idFrom(b:any){return String(b.id||b.canvasId||'');}
export const serviceRuntime={
 mode:'service',api,auth,storage,execution,resources,assistant,studio,notifications,organization,collaboration,
 setCanvasEditSession(port:CanvasEditSessionPort|null){
  if(canvasEditSession&&canvasEditSession!==port){storage.suspendCanvasOperations(canvasEditSession.projectId);api.setCanvasSession(canvasEditSession.projectId,null);}
  canvasEditSession=port&&port.userId===auth.user?.id&&port.projectId===managerId?port:null;
  if(canvasEditSession){const owned=canvasEditSession;api.setCanvasSession(owned.projectId,owned.clientId,owned.pageProof);if(storage.canEdit(owned.projectId)&&!storage.accessNeedsConfirmation(owned.projectId))enableCanvasOperationPort(owned);}
 },
 async prepareCanvasHandoff(id:string,clientId:string,signal?:AbortSignal,onProgress?:()=>void){
  const {client,check}=handoffContext(id,clientId,signal);
  if(!canvasEditSession?.ownsLease?.())throw new ApiError(409,'EDIT_SESSION_EXPIRED','请先重新连接编辑页面。');
  const resume=pauseHandoffSync(),releaseProgress=onProgress?storage.subscribeSaveProgress(id,onProgress):()=>{};
  try{
   // The UI commits its focused control and freezes authoring before entering
   // here. Capture any synchronous final native operation, even if autosave was
   // already in flight. A successful transfer requires its server receipt.
   client.flushOperationQueue?.(true);
   const graph=client.getRemoteData();
   storage.captureDraft(id,graph);
   dirty=storage.hasDraft(id)||dirty;
   await serviceRuntime.waitForSave();
   check();
   if(dirty||storage.hasDraft(id)||storage.isBlocked(id)||storage.hasPending(id))throw new ApiError(409,'CANVAS_SAVE_PENDING','最后的修改尚未保存，请稍后重试交接。');
  }finally{releaseProgress();resume();}
 },
 async syncCanvasHandoff(id:string,clientId:string,signal?:AbortSignal,onProgress?:()=>void):Promise<number>{
  const {client,check}=handoffContext(id,clientId,signal);
  autosave.cancel();
  storage.fenceCanvasSaves(id);
  const resume=pauseHandoffSync();
  try{
   const response=await api.request<Snapshot>('/projects/'+encodeURIComponent(id)+'/snapshot',{signal,onReadProgress:onProgress});
   check();
   await storage.receiveLiveSnapshot(id,response.data,response.etag,()=>client.getRemoteData(),
    ()=>{try{check();return true;}catch{return false;}},signal??new AbortController().signal,true,undefined,onProgress);
   check();
   showHandoffSnapshot(id,client);
   return storage.snapshots.get(id)!.revision;
  }catch(error){check();throw error;}finally{resume();}
 },
 async finishCanvasHandoff(id:string,clientId:string,signal?:AbortSignal,onProgress?:()=>void){
  const {client,check}=handoffContext(id,clientId,signal);
  // A prior ownership/access transition can fence the local operation port
  // while retaining its immutable outbox. Rebind only this current page after
  // /ready has established its usable writer term. Do not reset the API's
  // newly installed proof/lease or replace the existing operation session.
  if(!canvasEditSession?.ownsLease?.())throw new ApiError(409,'CANVAS_SESSION_PENDING','画布编辑连接正在恢复，当前操作已保留。');
  if(storage.accessNeedsConfirmation(id)){await storage.refreshAccess(id);check();}
  enableCanvasOperationPort(canvasEditSession);
  const resume=pauseHandoffSync();
  try{
   for(let attempt=0;;attempt++){
    try{
     const changed=await storage.recoverHandoffOperations(id,clientId,check,signal,onProgress);
     check();
     if(changed)await serviceRuntime.syncCanvasHandoff(id,clientId,signal,onProgress);
     return;
    }catch(error){
     check();
     // A worker may have completed between reading the graph and replaying.
     if(!(error instanceof ApiError)||error.code!=='CANVAS_RECOVERY_RECHECK'||attempt>=2)throw error;
     await serviceRuntime.syncCanvasHandoff(id,clientId,signal,onProgress);
    }
   }
  }finally{resume();}
 },
 setCanvasPresence(port:CanvasPresencePort|null){
  if(canvasPresence&&canvasPresence!==port)api.setCanvasSession(canvasPresence.projectId,null);
  canvasPresence=port&&auth.user?.id===port.userId&&managerId===port.projectId?port:null;
  if(canvasPresence)api.setCanvasSession(canvasPresence.projectId,canvasPresence.clientId);
 },
 flushCanvasMutations(id:string){if(canvasEditSession?.projectId===id)return canvasEditSession.ensure();if(nativeCanvasStartup&&managerId===id)return Promise.reject(new ApiError(409,'CANVAS_SESSION_PENDING','画布正在连接，连接后即可继续。'));return canvasPresence?.projectId===id?canvasPresence.flushPending?.():undefined;},
 acquireCanvasNodes(id:string,ids:string[]){if(canvasEditSession?.projectId===id)return canvasEditSession.ensure();if(nativeCanvasStartup&&managerId===id)return Promise.reject(new ApiError(409,'CANVAS_SESSION_PENDING','画布正在连接，连接后即可继续。'));return canvasPresence?.projectId===id?canvasPresence.acquire(ids):undefined;},
 bindLoginGate(gate:ServiceLoginGate){loginGate=gate;},
 modelBindingPort(){const id=modelProjectId();return auth.user&&id&&storage.canRead(id)?storage.modelBindingPort(id,()=>!!auth.user&&modelProjectId()===id&&storage.canEdit(id)):undefined;},
 installNative:():Promise<()=>void>=>installNativeIntegration(serviceRuntime,notice,config.features),
 async fetch(input:RequestInfo|URL,options:RequestInit={}):Promise<Response|undefined>{
  // Studio receives native source bytes and multipart bodies before any JSON decoding.
  const frame=await studio.fetch(input,options);if(frame!==undefined)return frame;
  const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url,location.href);
  if(!assistant.supportsStream(url.pathname))return undefined;
  const method=String(options.method||(!(input instanceof URL)&&typeof input==='object'?input.method:'GET')||'GET').toUpperCase();
  const source=options.body??(typeof Request!=='undefined'&&input instanceof Request&&!['GET','HEAD'].includes(method)?await input.clone().text():undefined);
  const body=typeof source==='string'?JSON.parse(source):source;
  return assistant.stream(url.pathname,body||{},options.signal||undefined);
 },
 socket:(url:string)=>assistant.socket(url),
 async ready(){
  nativeCanvasStartup=true;
  try{if(!auth.user)await auth.restore();}catch(error){if(!auth.user){if(error instanceof ApiError&&error.status===403)throw error;throw new ApiError(503,'SESSION_RECOVERY_UNAVAILABLE','暂时无法恢复登录，请稍后重试。');}notice(error instanceof Error?error.message:'身份服务暂时不可用。');}
  const match=location.pathname.match(/^\/project\/canvas\/([^/]+)/);
  if(match&&auth.user){
   const id=decodeURIComponent(match[1]),user=auth.user.id;
   for(let attempt=0;;attempt++){
    if(auth.user?.id!==user||canvasProjectFromPath(location.pathname)!==id)return;
    try{requireAccess();await storage.loadProject(id);return;}
    catch(error){
     if(auth.user?.id!==user||canvasProjectFromPath(location.pathname)!==id)throw error;
     if(projectAccessDenied(error)){
      history.replaceState({},'', '/projects/');window.addEventListener('rhtv:native-ready',()=>notice('当前账号无法访问此画布。'),{once:true});return;
     }
     if(attempt>=2||!retryableCanvasRead(error))throw error;
     await new Promise(resolve=>setTimeout(resolve,500*(attempt+1)));
    }
   }
  }
 },
 canvasFixture(id:string){requireAccess();storage.requirePermission(String(id),'canRead');return storage.fixture(String(id));},
 canvasAttachment(){return manager&&managerId&&managerIdentityId?{id:managerId,client:manager,identityId:managerIdentityId}:null;},
 captureCanvasFileIntent(){
  const page=canvasEditSession,client=manager,id=managerId,epoch=attachmentEpoch,term=page?.editTenure?.();
  if(!client||!id||!term||!page||page.projectId!==id||page.userId!==auth.user?.id)return;
  return ()=>canvasPageActive&&attachmentEpoch===epoch&&manager===client&&managerId===id&&
   canvasEditSession===page&&auth.user?.id===page.userId&&page.editTenure?.()===term;
 },
 setCanvasPageActive(active:boolean){canvasPageActive=active;if(!active)serviceRuntime.detachCanvas();},
 resumeCanvasOperations(id:string){if(managerId===id&&manager&&canvasWritable(id)&&storage.usesCanvasOperations(id)&&storage.hasDraft(id)){dirty=true;saveRetries=0;serviceRuntime.flush();}},
 detachCanvas(){
  if(!manager&&!canvasSync)return;
  resetTransientSave();
  // Native operations may still be inside their own debounce. Capture them
  // before releasing the view; storage keeps queued/failed drafts and auth.
  try{
   if(managerId&&!canvasWritable(managerId))throw new ApiError(403,'READ_ONLY','只读项目不提交本地修改。');
   manager?.flushOperationQueue?.(true);
   const graph=manager?.roomId!==undefined&&manager.roomId!==managerId?JSON.parse(lastObserved||'null'):manager?.getRemoteData();
   if(graph&&managerId)storage.captureDraft(managerId,graph);
   if(graph&&JSON.stringify(graph)!==lastSaved){lastObserved=JSON.stringify(graph);dirty=true;}
   serviceRuntime.flush(true);
  }catch(error){if(!(error instanceof ApiError&&error.code==='READ_ONLY'))notice(error instanceof Error?error.message:'画布草稿暂时无法保存。');}
  clearTimeout(permissionTimer);
  attachmentEpoch++;canvasSync?.stop();canvasSync=null;
  resumeCanvasSync=null;syncPauses.clear();
  if(manager&&updateListener)managerDoc?.off('update',updateListener);
  unsubscribe?.();autosave.cancel();execution.detach();
  if(canvasPresence){api.setCanvasSession(canvasPresence.projectId,null);canvasPresence=null;}
  manager=null;managerDoc=null;managerId=null;managerIdentityId=null;unsubscribe=null;updateListener=null;dirty=false;saveRetries=0;lastSaved='';lastObserved='';
 },
 attachCanvas(id:string,client:any,resumeIdentityId?:string){
  if(!auth.user||!canvasPageActive||canvasProjectFromPath(location.pathname)!==String(id)||(client.roomId!==undefined&&client.roomId!==String(id)))return;
  if(!storage.canRead(String(id))||resumeIdentityId!==undefined&&auth.user.id!==resumeIdentityId)return;
  if(manager===client&&managerId===String(id)&&managerDoc===client.ydoc&&managerIdentityId===auth.user.id&&resumeCanvasSync){resumeCanvasSync();return;}
  serviceRuntime.detachCanvas();
  resetTransientSave();
  attachmentEpoch++;
  manager=client;managerDoc=client.ydoc;managerId=String(id);managerIdentityId=auth.user.id;execution.attach(String(id),client);dirty=false;saveRetries=0;lastSaved=JSON.stringify(client.getRemoteData());lastObserved=lastSaved;
  const mounted=client.getRemoteData();
  if(mounted){
   if(nativeCanvasStartup&&storage.canEdit(String(id)))storage.beginCanvasOperations(String(id),auth.user.id,mounted);
   storage.attachNativeView(String(id),mounted);
  }
  const epoch=attachmentEpoch,identityId=auth.user?.id,current=()=>canvasPageActive&&canvasProjectFromPath(location.pathname)===String(id)&&epoch===attachmentEpoch&&manager===client&&managerId===String(id)&&auth.user?.id===identityId&&(client.roomId===undefined||client.roomId===String(id));
  const queue=()=>{if(!current()||applyingRemote||!canvasWritable(String(id)))return;const graph=client.getRemoteData(),serialized=JSON.stringify(graph);if(serialized===lastObserved)return;lastObserved=serialized;dirty=true;if(graph){try{storage.reconcileModelBindings(String(id),graph);storage.captureDraft(String(id),graph);}catch(error){notice(error instanceof Error?error.message:'当前修改尚未记录，请保持此页面打开。');}}if(!recoveringDraft)scheduleCanvasSave(String(id));};
  const onUpdate=(_update?:unknown,origin?:unknown)=>{if(origin!==REMOTE_CANVAS_ORIGIN)queue();};
  unsubscribe=client.subscribe(queue);updateListener=onUpdate;client.ydoc?.on('update',onUpdate);
  const bridge=nativeCanvasSyncPort(client);
  if(auth.user&&storage.canRead(String(id))){
   if(!bridge.available()){notice('当前画布尚未具备安全同步接口，请重新打开作品。');return;}
   resumeCanvasSync=()=>{if(!current()||canvasSync||!storage.canRead(String(id))||recoveringDraft||syncPauses.size)return;
    canvasSync=new CanvasSync(api,storage,String(id),{current,readOnly:()=>!canvasWritable(String(id)),read:()=>{if(canvasWritable(String(id)))client.flushOperationQueue?.(true);return client.getRemoteData();},apply:graph=>{applyingRemote=true;try{return bridge.apply(graph);}finally{applyingRemote=false;}},applied:snapshot=>{lastObserved=JSON.stringify(client.getRemoteData());if(!canvasWritable(String(id))||!dirty&&!storage.hasDraft(String(id)))lastSaved=lastObserved;execution.syncApplied(String(id),client,snapshot.nodeStates,snapshot.graphRevision);if(canvasWritable(String(id))&&storage.hasDraft(String(id))&&!storage.isBlocked(String(id))){dirty=true;scheduleCanvasSave(String(id));}},error:error=>{if(projectAccessDenied(error)){storage.invalidateAccess(String(id));}notice(retryableCanvasRead(error)?'画布更新暂时延迟，连接恢复后会自动同步。':error instanceof Error?error.message:'画布同步暂时不可用。');}});
    void canvasSync.start();
   };resumeCanvasSync();storage.refreshDraftBackups(String(id));window.dispatchEvent(new Event('rhtv:canvas-attachment'));
   let retry=1000,reported=false;
   const refresh=(delay:number)=>{permissionTimer=window.setTimeout(async()=>{
    if(!current())return;
    try{await storage.refreshAccess(String(id));retry=1000;reported=false;}
    catch(error){
     if(!current())return;
     if(projectAccessDenied(error)){
      if(!reported)notice('当前账号已无法访问此画布。');
      reported=true;
     }else{
      if(!reported&&retry>=8000&&storage.hasDraft(String(id))){notice('画布修改正在等待连接恢复后保存。');reported=true;}
      const next=retry;retry=Math.min(15000,retry*2);refresh(next);return;
     }
    }
    if(current())refresh(15000);
   },delay);};refresh(15000);
  }
 },
 async uploadFile(file:File,options?:{onProgress?:(value:number)=>void;signal?:AbortSignal;validate?:(prepared:File)=>void}){
  requireAccess();const id=managerId;
  if(!id)throw new Error('请先打开项目再上传素材。');
  const current=serviceRuntime.captureCanvasFileIntent();
  return storage.upload(file,id,options?.onProgress,{signal:options?.signal,validate:options?.validate,check:()=>{
   if(!current?.())throw new ApiError(409,'STALE_CANVAS_SESSION','当前页面的画布编辑权已变更，上传已取消。');
  }});
 },
 flush(force=false){
  autosave.cancel();if(nativeCanvasStartup&&managerId&&(!canvasEditSession||canvasEditSession.projectId!==managerId))return;
  if(recoveringDraft||!dirty||!manager||!managerId||!storage.canEdit(managerId)||storage.accessNeedsConfirmation(managerId)||canvasEditSession?.projectId===managerId&&!canvasWritable(managerId)&&!canvasEditSession.ownsLease?.())return;
  const savingId=managerId,client=manager,epoch=attachmentEpoch,saveKey=epoch+':'+savingId;
  // Preserve all edits in the synchronous journal, but keep at most one
  // ordinary network save active. Explicit generation/exit barriers still queue.
  if(!force&&saving.has(saveKey))return;
  const graph=manager.roomId!==undefined&&manager.roomId!==managerId?JSON.parse(lastObserved||'null'):manager.getRemoteData();if(!graph)return;
  storage.captureDraft(savingId,graph);const serialized=JSON.stringify(graph);if(serialized===lastSaved&&!storage.hasDraft(savingId)){dirty=false;return;}
  // The edits have already been captured. An offline browser cannot complete an
  // autosave; wake it on online instead of retrying and showing network errors.
  // Explicit generation/exit barriers still receive a real save result.
  if(!force&&storage.usesCanvasOperations(savingId)&&globalThis.navigator?.onLine===false)return;
  dirty=false;
  const pending=storage.queueSave(savingId,graph);saving.set(saveKey,pending);let retryDelay:number|undefined,completed=false;
  void pending.then(()=>{completed=true;if(epoch===attachmentEpoch&&managerId===savingId&&manager===client){saveRetries=0;resetTransientSave();lastSaved=serialized;settleSavedCanvas(savingId,client,epoch,serialized);}}).catch(error=>{
   if(epoch!==attachmentEpoch||managerId!==savingId||manager!==client)return;
   dirty=storage.canEdit(savingId);if(error instanceof ApiError&&[403,404].includes(error.status))void storage.refreshAccess(savingId).catch(()=>{});
   const retryable=transientCanvasSaveFailure(error)||error instanceof ApiError&&error.status===412&&!storage.isBlocked(savingId);
   if(storage.usesCanvasOperations(savingId)&&transientCanvasSaveFailure(error)){
    transientSaveSince??=Date.now();
    // Brief failures recover quietly. A prolonged write-only outage still
    // needs one non-blocking indication that another device may be behind.
    // Memory-only edits have their own persistence warning instead.
    if(!transientSaveNotified&&Date.now()-transientSaveSince>=30000&&storage.draftRecoveryState(savingId).persistence==='saved'){
     transientSaveNotified=true;notice('修改已保留，正在等待连接恢复后自动保存。');
    }
   }else resetTransientSave();
   if(dirty&&!storage.isBlocked(savingId)&&retryable&&(storage.usesCanvasOperations(savingId)||saveRetries<3)){
    retryDelay=canvasSaveRetryDelay(saveRetries);saveRetries=Math.min(saveRetries+1,4);
   }
  }).finally(()=>{
   if(saving.get(saveKey)!==pending)return;saving.delete(saveKey);
   if(epoch===attachmentEpoch&&managerId===savingId&&manager===client&&dirty&&storage.canEdit(savingId)&&!storage.isBlocked(savingId)){
    if(retryDelay!==undefined)autosave.retry(retryDelay);else if(completed)scheduleCanvasSave(savingId);
   }
  });
 },
 inspect(){return{id:managerId,graph:manager?.getRemoteData()||null,projects:[...storage.projects.values()],assets:storage.assets.size,mode:'service',conflict:managerId?storage.isBlocked(managerId):false,sync:{eventCursor:canvasSync?.eventCursor??null,awaitingApply:canvasSync?.awaitingApply??false}};},
 async waitForSave(){if(managerId&&manager&&storage.canEdit(managerId))manager.flushOperationQueue?.(true);const id=managerId,client=manager,epoch=attachmentEpoch,submitted=client?JSON.stringify(client.getRemoteData()):'';serviceRuntime.flush(true);if(id){await storage.wait(id);if(client)settleSavedCanvas(id,client,epoch,submitted);}},
 exportCanvasDraft(backupId?:string){requireAccess();if(!managerId||!manager)throw new ApiError(409,'CANVAS_REQUIRED','请先打开画布。');if(!backupId&&storage.canEdit(managerId)){manager.flushOperationQueue?.(true);storage.captureDraft(managerId,manager.getRemoteData());}return storage.exportDraft(managerId,backupId);},
 restoreCanvasDraft(backupId:string,options?:{exportedBackup?:boolean}){return changeCanvasDraft(id=>storage.restoreDraft(id,backupId,options));},
 importCanvasDraft(text:string,options?:{exportedBackup?:boolean}){return changeCanvasDraft(id=>storage.importDraft(id,text,options));},
 recoverCanvasDraft(choices:Record<string,'local'|'server'>={},options?:{exportedBackup?:boolean}){return changeCanvasDraft(id=>storage.resolveDraft(id,choices,options),true);},
 async retryCanvasSync():Promise<void>{
  try{if(managerId&&storage.usesCanvasOperations(managerId)){await canvasEditSession?.ensure();dirty=true;await serviceRuntime.waitForSave();}else await serviceRuntime.recoverCanvasDraft({});}
  catch(error){
   const requestId=error instanceof ApiError?error.requestId:undefined;
   throw new ApiError(error instanceof ApiError?error.status:409,'CANVAS_SYNC_PENDING','部分修改尚未同步，内容已保留，请重试同步。',requestId);
  }
 },
 async handle(path:string,b:any,method='POST'){
  if(path==='/uc/team/my-teams'){requireAccess();await collaboration.loadTeams();return success(collaboration.nativeTeams());}
  if(path==='/uc/team/switch'){requireAccess();await collaboration.selectTeam(b.teamId&&String(b.teamId)!=='0'?String(b.teamId):null);return success({teamId:collaboration.currentTeamId});}
  if(config.edition==='internal'&&['/api/system/getConfig','/uc/client/ipAndCountry'].includes(path))throw new ApiError(403,'FEATURE_DISABLED',INTERNAL_FEATURE_MESSAGE);
  if(path==='/uc/getUserInfo'){if(!auth.user)throw new ApiError(401,'UNAUTHORIZED','请先登录。');return success(userView());}
  if(/\/uc\/(?:pwdLogin|abroad\/pwdLogin|smsLogin|emailLogin|googleLogin|sendEmailCode|sendSms)/.test(path)){void feishuLogin.open();throw new ApiError(501,'AUTH_METHOD_UNAVAILABLE','请使用公司飞书账号登录。');}
  if(path==='/uc/logout'){await signOut();storage.clear();return success(null);}
  const capability=['/canvas/delete','/canvas/list','/canvas/checkUserIdByCanvasId','/canvas/detail/byCanvasId','/canvas/getCanvasDetail','/canvas/create','/canvas/createFromCase','/canvas/saveLockedCopy','/canvas/rename','/canvas/pin','/canvas/unpin'].includes(path)?'tv.access':null;
  if(capability)requireAccess();
  if(path==='/canvas/list'){if(b.teamId)throw new ApiError(501,'TEAM_PROJECT_FOLDERS_RESERVED','团队共享项目请从“与我共享”打开。');return success(await organization.list(b));}
  if(path==='/canvas/create'){const project=await organization.create(b);return success({id:project.id});}
  if(path==='/canvas/createFromCase'||path==='/canvas/saveLockedCopy'){
   const input=b.canvasContent||b.canvas;const graph=typeof input==='string'?JSON.parse(input):input;
   const project=b.folderId?await organization.create(b):await storage.create(b.name,graph&&Array.isArray(graph.nodes)?graph:undefined);if(b.folderId&&graph&&Array.isArray(graph.nodes))await storage.save(project.id,{...graph,meta:{...graph.meta,id:project.id,name:project.name}});return success({id:project.id});
  }
  if(path==='/canvas/checkUserIdByCanvasId'){const id=String(b.canvasId);await storage.loadProject(id);return success({caseFlag:true,permission:storage.canEdit(id)?'read_write':'read_only',canvasLocked:false,yjsGeneration:null,yjsGenerationRequired:false});}
  if(path==='/canvas/detail/byCanvasId'||path==='/canvas/getCanvasDetail'){const id=idFrom(b);if(!storage.canRead(id)||!storage.snapshots.has(id))await storage.loadProject(id);storage.requirePermission(id,'canRead');const project=storage.projects.get(id)!,graph=storage.fixture(id);return success({...storage.nativeRow(project),canvas_content:{nodes:graph.nodes,edges:graph.edges}});}
  if(path==='/canvas/rename'){await storage.rename(idFrom(b),String(b.name));if(managerId===idFrom(b))manager?.ymap?.set('name',String(b.name));return success(null);}
  if(path==='/canvas/delete'){await storage.delete(idFrom(b));return success(null);}
  if(path==='/canvas/pin'||path==='/canvas/unpin'){await storage.pin(idFrom(b),path==='/canvas/pin');return success(null);}
  if(path==='/canvas/share/link'){await serviceRuntime.waitForSave();const id=String(b.canvasId),result=await api.mutation<any>('/projects/'+encodeURIComponent(id)+'/share-links',{allowClone:false},'POST',storage.etags.get(id));return success({shareUrl:result.data.url});}
  requireAccess();
  if(path==='/canvas/folder/delete'||path==='/canvas/move/v1/submit')await ensureCanvasSaved(path.endsWith('/delete')?'删除文件夹':'移动作品');
  for(const adapter of [execution,studio,assistant,resources,notifications,organization]){const data=await adapter.handle(path,b,method);if(data!==undefined)return success(data);}
  if(/reportEvent|\/logs\//.test(path))return success(null);
  throw unsupportedNativeOperation(path);
 },
};
window.__RHTV_SERVICE__=serviceRuntime;
function checkpointCanvasDraft(){if(managerId&&manager&&auth.user&&canvasWritable(managerId)&&(manager.roomId===undefined||manager.roomId===managerId)){try{manager.flushOperationQueue?.(true);storage.captureDraft(managerId,manager.getRemoteData());}catch(error){dirty=true;notice(error instanceof Error?error.message:'草稿尚未备份，请保持此页面打开。');}}}
window.addEventListener('beforeunload',event=>{try{checkpointCanvasDraft();serviceRuntime.flush(true);}finally{if(dirty||storage.hasPending()||canvasPresence?.hasPending?.()||(managerId&&storage.hasDraft(managerId))){event.preventDefault();event.returnValue='';}}});
window.addEventListener('pagehide',checkpointCanvasDraft);
window.addEventListener('online',()=>{if(managerId)serviceRuntime.resumeCanvasOperations(managerId);});
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden'){checkpointCanvasDraft();serviceRuntime.flush();}});
// bootstrap admits the service identity before feature policy or native UI.
// Importing adapters alone must never rewrite an anonymous return location.
