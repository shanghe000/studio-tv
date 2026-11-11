import {CanvasPageOutbox} from './canvas-page-outbox';
import {legacyRecoveryOrder,recoverLegacyEdit} from './legacy-canvas-edits';
import {canvasOperationReceipt} from './canvas-operation-receipt';
import {ApiClient,ApiError,type ApiResult} from '../api/client';
import type {Project,Snapshot,Asset,Page} from '../api/types';
import {encodeGraph,decodeGraph,cleanJson,META_NODE,type NativeGraph} from './graph';
import {sha256Hex,randomUuid} from '../browser-compat';
import {optimizeCanvasImage} from './optimize-canvas-image';
import {uploadMimeType} from './upload-mime';
import type {ProductClient} from './product-client';
import type {Capability} from './model-catalog';
import {withPreflightContext} from './preflight';
import {projectAccessDenied,validateProjectAccess,type ProjectAccess,type ProjectAction} from './project-access';
import {remapAssetValues} from './asset-remap';
import {ModelBindings,type NativeModelBindingPort} from './model-bindings';
import {builtinStyleMedia} from './style-media';
import {mergeCanvasDraft,equalDraftValue,type DraftConflict,type DraftMerge} from './canvas-draft';
import {projectPreviewIds,projectPreviewPage,nativeProjectPreview,type ProjectPreview} from './project-previews';
import {imageBatchNodeId} from './image-batch-output';
import {persistentRegionGraph} from './native-region-transient';
import {restoreNativeH3InputSerialization} from './native-h3-input-serialization';
import {DraftJournal,browserDraftJournal,journalGraph,parseDraftEnvelope,type DraftEnvelope,type DraftJournalRecord} from './draft-journal';
import {draftConflictDetails as conflictDetails,draftPathValue,sameConflictValues,resolveDraftGraph,type DraftChoice,type DraftConflictDetail} from './draft-resolution';
import {CanvasOperationSession} from './canvas-operations';
import {transientCanvasSaveFailure} from './canvas-save-retry';
import {canvasRequestDeadline} from './canvas-request-deadline';
const leaseRepair=(error:unknown)=>error instanceof ApiError&&['CANVAS_SESSION_PENDING','EDIT_SESSION_EXPIRED','PROJECT_EDIT_OCCUPIED'].includes(error.code);
export interface CanvasOperationPort {tenure?:()=>string|undefined;permitsObservedRevision?:()=>boolean;userId:string;clientId:string;ensure:()=>Promise<void>;invalidate?:(error?:unknown)=>void}
export interface CatalogMediaReference {family:string;resourceId:string;revision:number;path:string}
// Immutable Tme() produces nodeId::URL for media reorder keys. Only a whole
// valid node key and an exact registered asset reference may be translated.
const nativeMediaKey=(value:string)=>value.match(/^([A-Za-z0-9][A-Za-z0-9_-]{0,63})::(.+)$/);
const assetReferences=(value:any)=>{
 const references=new Set<string>();
 const inspect=(item:any)=>{if(typeof item==='string'&&item.startsWith('rhtv-asset:'))references.add(item.slice(11));else if(Array.isArray(item))item.forEach(inspect);else if(item&&typeof item==='object')Object.values(item).forEach(inspect);};
 inspect(value);return references;
};
interface AcknowledgedCanvas {graph:NativeGraph;etag:string;revision:number}
interface PendingSave {base:NativeGraph;local:NativeGraph;initialEtag:string;unknownBase:boolean;requiresBaseDecision?:boolean;phase:'DRAFT'|'QUEUED'|'IN_FLIGHT'|'FAILED'}
interface CanvasDraft {displayedRevision?:number;ack?:AcknowledgedCanvas;observed?:NativeGraph;viewport?:NativeGraph['viewport'];pending:PendingSave[];unqueued?:PendingSave;coalesced?:PendingSave;graph?:NativeGraph;conflicts:DraftConflict[]}
interface ExecutionSave {current:()=>NativeGraph;check:(allowSaveCatchUp?:boolean)=>void;receipt:(snapshot:Snapshot)=>void;projectionBase?:(base:NativeGraph,ack:NativeGraph)=>NativeGraph}
export type DraftBlockedReason='MERGE_CONFLICT'|'BASE_UNKNOWN'|'CAS_UNCERTAIN';
interface DraftBlock {graph:NativeGraph;reason:DraftBlockedReason;proof?:{revision:number;strict:boolean;definitiveRefusal?:boolean}}
class HistoricalModelMismatch extends ApiError {
 constructor(message:string){super(502,'INVALID_RESPONSE',message);}
}
export interface DraftRecoveryState {projectId:string;blocked:boolean;blockedReason?:DraftBlockedReason;retryableError?:{code:'NODE_EDIT_OCCUPIED';message:string};busy:boolean;persistence:'none'|'saved'|'memory-only';error?:string;generation:number;conflicts:DraftConflict[];backups:{id:string;updatedAt:string;nodeCount:number;unknownBase:boolean;currentPage:boolean}[]}
export class ServiceStorage {
 private readonly operationSessions=new Map<string,CanvasOperationSession>();
 private readonly operationPorts=new Map<string,CanvasOperationPort>();
 private readonly canvasSaveControllers=new Map<string,AbortController>();
 private readonly operationErrors=new Map<string,string>();
 private readonly saveProgress=new Map<string,Set<()=>void>>();
 private noteSaveProgress(id:string){for(const callback of this.saveProgress.get(id)??[])callback();}
 subscribeSaveProgress(id:string,callback:()=>void){
  let listeners=this.saveProgress.get(id);if(!listeners){listeners=new Set();this.saveProgress.set(id,listeners);}listeners.add(callback);
  return()=>{listeners.delete(callback);if(!listeners.size&&this.saveProgress.get(id)===listeners)this.saveProgress.delete(id);};
 }
 private requestOperation(id:string,body:unknown,headers:Record<string,string>|undefined,signal?:AbortSignal,onProgress?:()=>void){
  return canvasRequestDeadline(signal,(request,progress)=>(this.api as ProductClient).requestV2<any>('/projects/'+encodeURIComponent(id)+'/canvas-operations',{method:'POST',signal:request,onReadProgress:progress,body,headers}),()=>{
   onProgress?.();this.noteSaveProgress(id);
  });
 }
 private readonly operationJournals=new Set<string>();
 /** Live editing has one server document and a durable outbox, never a local
  * graph branch. Legacy snapshot helpers remain only for bootstrap/maintenance. */
 enableCanvasOperations(id:string,port:CanvasOperationPort,native?:NativeGraph){
  this.requirePermission(id);if(this.identity&&this.identity()!==port.userId)throw new ApiError(401,'SESSION_CHANGED','账号已变更，请重新打开画布。');
  this.operationPorts.set(id,port);this.beginCanvasOperations(id,port.userId,native,port.clientId);
 }
 // Mount a local operation journal independently of edit-session admission.
 // The authenticated controller is the only component allowed to send it.
 beginCanvasOperations(id:string,userId:string,native?:NativeGraph,clientId?:string){
  this.requirePermission(id);if(this.identity&&this.identity()!==userId)throw new ApiError(401,'SESSION_CHANGED','账号已变更，请重新打开画布。');
  let session=this.operationSessions.get(id);
  if(!session){
   const owner=clientId??randomUuid();
   let outbox:Storage|undefined;try{outbox=globalThis.localStorage;}catch{}
   if(outbox)this.operationJournals.add(id);
   let locks:LockManager|undefined;try{locks=globalThis.navigator?.locks;}catch{/* Sandboxed documents can deny the Web Locks getter. */}
   const journal=outbox&&typeof window!=='undefined'&&typeof navigator!=='undefined'?new CanvasPageOutbox(outbox,userId,id,owner,locks,window):outbox;
   session=new CanvasOperationSession({userId,projectId:id,clientId:owner,permitsObservedRevision:()=>{const page=this.operationPorts.get(id);return page?page.permitsObservedRevision?.()??true:undefined;},storage:journal});this.operationSessions.set(id,session);
   const snapshot=this.snapshots.get(id);if(snapshot)session.acceptSnapshot(snapshot);
   const state=this.canvas(id);state.pending=[];state.conflicts=[];state.unqueued=undefined;state.coalesced=undefined;this.blocked.delete(id);
   const view=native??state.observed??state.ack?.graph;if(view)session.reobserve(encodeGraph(this.canonical(this.restoreModelBindings(id,view))),state.displayedRevision);
   this.rebuildDraft(id,state);
  }
  this.notifyDraft(id);
 }
 fenceCanvasSaves(id:string){
  this.canvasSaveControllers.get(id)?.abort();
  this.canvasSaveControllers.delete(id);
 }
 suspendCanvasOperations(id:string){this.operationPorts.delete(id);this.fenceCanvasSaves(id);}
 usesCanvasOperations(id:string){return this.operationSessions.has(id);}
 private operationGraph(id:string,session:CanvasOperationSession){return this.nativeView(id,decodeGraph(session.projected()));}
 private operationNeedsPreparation(id:string,native:NativeGraph){
  let catalog=false;const scan=(value:any,key='')=>{if(key==='presetSelections')return;if(typeof value==='string'){if(this.catalogMedia.has(value))catalog=true;}else if(Array.isArray(value))value.forEach(item=>scan(item,key));else if(value&&typeof value==='object')for(const [name,item]of Object.entries(value))scan(item,name);};scan(native);if(catalog)return true;
  if(!this.identity)return false;
  const known=assetReferences(this.snapshots.get(id)?.graph??{}),references=assetReferences(encodeGraph(this.remapProjectAssets(id,native),this.encodeAsset));
  return[...references].some(assetId=>!known.has(assetId)&&this.assets.get(assetId)?.projectId!==id);
 }
 private observeOperationGraph(id:string,native:NativeGraph){
  const session=this.operationSessions.get(id)!;
  const graph=this.canonical(this.restoreModelBindings(id,this.remapProjectAssets(id,native))),batch=session.observe(encodeGraph(graph));
  const state=this.canvas(id);state.observed=structuredClone(graph);state.graph=this.canonical(decodeGraph(session.projected()));this.notifyDraft(id);return!!batch;
 }
 /** Drain an immutable batch only against the proof read for this ownership
  * change. Replaying a known batch returns its original receipt even if the
  * graph moved on. Conflicting offline changes stay on this device.
  */
 async recoverHandoffOperations(id:string,clientId:string,guard:()=>void,signal?:AbortSignal,onProgress?:()=>void) {
  const session=this.operationSessions.get(id);
  if(!session)throw new ApiError(409,'CANVAS_NOT_READY','画布编辑连接尚未就绪。');
  const epoch=this.epoch;
  const check=()=>{
   guard();
   this.requireEpoch(epoch);
   this.requirePermission(id);
   if(this.operationSessions.get(id)!==session||this.operationPorts.get(id)?.clientId!==clientId)
    throw new DOMException('画布已切换','AbortError');
  };
  let retained=false,changed=false;
  await this.serialize(id,epoch,async()=>{
   check();await session.prepareRecovery();check();session.refreshOutbox();
   while(session.hasPending()){
    check();
    const options=session.recoveryOptions();
    changed=true;
    await this.operationPorts.get(id)!.ensure();
    check();
    const batch=session.headForTransport(this.operationPorts.get(id)?.permitsObservedRevision?.()??true)!;
    try{
     const base=this.operationPorts.get(id)?.permitsObservedRevision?.()?this.snapshots.get(id):undefined;
     const response=await canvasOperationReceipt(id,{...batch,clientId,...options},base,(body,headers)=>this.requestOperation(id,body,headers,signal,onProgress),check);
     check();
     if(response.data.projectId!==id||response.data.batchId!==batch.batchId)throw new ApiError(502,'INVALID_OPERATION_RECEIPT','服务器尚未确认此操作。');
     this.acceptSnapshot(id,response.data,response.etag,false);
     session.acknowledge(batch.batchId,response.data);
    }catch(error){
     check();
     if(!(error instanceof ApiError)||error.code!=='CANVAS_BATCH_NOT_APPLIED'||!options.receiptOnly)throw error;
     session.preserveHead(batch.batchId);retained=true;
    }
   }
   session.releaseRecovered();
   // Read predecessor journals only *after* a fresh page has proved write
   // authority and drained its own queue. A stored v1 graph is never itself a
   // write. Its original bytes remain until an exact receipt/field proof.
   if(this.journal&&this.identity?.()&&this.operationPorts.get(id)?.permitsObservedRevision?.()){
    const journal=this.journal,uid=this.identity()!;
    let rows:ReturnType<typeof legacyRecoveryOrder>=[];
    const unreadable=()=>this.legacyRecoveryNotice(id,'unreadable');
    try{rows=legacyRecoveryOrder(journal.list(uid,id,true,unreadable),row=>journal.isResolved(row));}catch{unreadable();}
    for(const candidate of rows){
     check();const snap=this.snapshots.get(id);if(!snap)break;
     try{
      const result=candidate.ambiguous?'retained':await recoverLegacyEdit({...candidate.row,baseRevision:candidate.baseRevision},snap,clientId,g=>encodeGraph(this.canonical(g),this.encodeAsset),async body=>{
       check();await this.operationPorts.get(id)!.ensure();check();
       const response=await canvasOperationReceipt(id,body,snap,(request,headers)=>this.requestOperation(id,request,headers,signal,onProgress),check);
       check();return response.data;
      },s=>{check();this.acceptSnapshot(id,s,'"'+s.revision+'"',false);});
      if(result!=='retained'){journal.markResolved(candidate.row);changed||=result==='saved';}
      else this.legacyRecoveryNotice(id,candidate.row.id+':'+candidate.row.updatedAt);
     }catch(e){
      check();
      if(e instanceof ApiError&&(['CANVAS_RECOVERY_RECHECK','EDIT_SESSION_EXPIRED','PROJECT_EDIT_OCCUPIED','UNAUTHENTICATED','SESSION_CHANGED'].includes(e.code)||e.status===401||e.status===403||e.status===408||e.status===429||e.status>=500||e.status===0))throw e;
      if(e instanceof TypeError||e instanceof DOMException&&e.name==='AbortError')throw e;
      this.legacyRecoveryNotice(id,candidate.row.id+':'+candidate.row.updatedAt); // don't disable the current authorized document
     }
    }
   }
   this.rebuildDraft(id,this.canvas(id));
   this.operationErrors.delete(id);
   this.notifyDraft(id);
  });
  if(retained)this.notice('已打开最新画布。与后来编辑重叠的未同步操作已单独保留在本机。');
  return changed;
 }
 private readonly legacyNotices=new Set<string>();
 private legacyRecoveryNotice(id:string,recordKey:string){
  const key=id+':'+recordKey;if(this.legacyNotices.has(key))return;
  this.legacyNotices.add(key);this.notice('旧页面有未能自动恢复的修改，原内容仍保留在此浏览器。当前画布可以继续编辑。');
 }
 private saveOperations(id:string,native:NativeGraph,execution?:ExecutionSave):Promise<void>{
  const epoch=this.epoch,state=this.canvas(id),session=this.operationSessions.get(id)!;
  const controller=this.canvasSaveControllers.get(id)??new AbortController();
  this.canvasSaveControllers.set(id,controller);
  if(!execution&&!this.operationNeedsPreparation(id,native))this.observeOperationGraph(id,native);
  return this.serialize(id,epoch,async()=>{
   let sending:CanvasOperationPort|undefined,tenure:string|undefined;
   const check=()=>{if(controller.signal.aborted)throw new DOMException('编辑页面已切换','AbortError');this.requireEpoch(epoch);this.requireCanvas(id,state);this.requirePermission(id);if(this.operationSessions.get(id)!==session)throw new ApiError(409,'STALE_CANVAS_SESSION','画布已切换，请重新打开。');execution?.check();};
   const drain=async()=>{
    while(session.hasPending()){
     check();const port=this.operationPorts.get(id);if(!port)throw new ApiError(409,'CANVAS_SESSION_PENDING','画布编辑连接正在恢复，当前操作已保留。');await port.ensure();check();
     const batch=session.headForTransport(port.permitsObservedRevision?.()??true)!;
     // Retries send the immutable operation ID and payload. A timeout never
     // triggers a new write identity or a fallback whole-graph snapshot PUT.
     sending=port;tenure=port.tenure?.();
     const base=port.permitsObservedRevision?.()?this.snapshots.get(id):undefined;
     const response=await canvasOperationReceipt(id,{...batch,clientId:port.clientId},base,(body,headers)=>this.requestOperation(id,body,headers,controller.signal),check);check();
     if(response.data.batchId!==batch.batchId||response.data.projectId!==id)throw new ApiError(502,'INVALID_OPERATION_RECEIPT','保存确认不完整，当前操作仍保留，请重试同步。');
     // Validate the canonical receipt before deleting anything from the outbox.
     this.acceptSnapshot(id,response.data,response.etag,false);session.acknowledge(batch.batchId,response.data);this.operationErrors.delete(id);this.rebuildDraft(id,state);
    }
   };
   try{
    if(!execution&&this.operationNeedsPreparation(id,native)){
     const original=structuredClone(native),prepared=structuredClone(native);await this.prepareGraph(prepared,()=>this.noteSaveProgress(id));check();
     const entry:PendingSave={base:state.ack?.graph??prepared,local:prepared,initialEtag:state.ack?.etag??'',unknownBase:false,phase:'DRAFT'};
     await this.prepareProjectAssets(id,state,entry,epoch,controller.signal,()=>this.noteSaveProgress(id));check();this.observeOperationGraph(id,this.remapProjectAssets(id,prepared));
     const emergency=this.emergencyDrafts.get(id);if(emergency&&equalDraftValue(emergency.graph,original))this.emergencyDrafts.delete(id);
    }
    await drain();
    if(execution){
     check();const exact=structuredClone(native);await this.prepareGraph(exact,()=>this.noteSaveProgress(id));check();
     const before=state.observed&&structuredClone(state.observed);
     session.observe(encodeGraph(this.canonical(this.restoreModelBindings(id,this.remapProjectAssets(id,exact)))));
     // Frozen request fields are server metadata, not edits authored in the
     // native controls. Preserve the actual rendered observation separately.
     const displayed=this.canonical(this.restoreModelBindings(id,execution.current()));session.reobserve(encodeGraph(displayed));state.observed=displayed;
     try{await drain();}catch(error){if(before)state.observed=before;throw error;}
     const receipt=this.snapshots.get(id);if(!receipt)throw new ApiError(502,'INVALID_OPERATION_RECEIPT','保存确认尚未完成。');execution.receipt(receipt);
    }
    if(!execution){const staged=this.emergencyDrafts.get(id);if(staged&&!this.operationNeedsPreparation(id,staged.graph)&&equalDraftValue(this.canonical(this.remapProjectAssets(id,staged.graph)),this.canonical(this.remapProjectAssets(id,native))))this.emergencyDrafts.delete(id);}
    this.operationErrors.delete(id);this.notifyDraft(id);
   }catch(error){if(!controller.signal.aborted&&epoch===this.epoch&&this.operationSessions.get(id)===session){if(leaseRepair(error)){if(sending&&sending===this.operationPorts.get(id)&&sending.tenure?.()===tenure&&error instanceof ApiError&&error.code!=='CANVAS_SESSION_PENDING')sending.invalidate?.(error);}
    else if(!transientCanvasSaveFailure(error))this.operationErrors.set(id,'部分修改尚未同步，当前操作已保留，请重试同步。');this.notifyDraft(id);}throw error;}
  });
 }
 readonly projects=new Map<string,Project>();
 readonly snapshots=new Map<string,Snapshot>();
 readonly assets=new Map<string,Asset>();
 readonly etags=new Map<string,string>();
 private readonly canvasMediaScopes=new Map<string,string>();
 private reverseUrls=new Map<string,string>();
 private catalogMedia=new Map<string,CatalogMediaReference>();
 private materializing=new Map<string,Promise<Asset>>();
 private resolvingAssets=new Map<string,Promise<Asset>>();
 private readonly assetProgress=new Map<string,Set<()=>void>>();
 private assetProgressKey(reference:string){return this.catalogMedia.has(reference)&&!this.reverseUrls.has(reference)?'catalog:'+reference:'asset:'+this.encodeAsset(reference).replace(/^rhtv-asset:/,'');}
 private readonly assetRequestKeys=new Map<string,string>();
 private assetRequestKey(key:string){let id=this.assetRequestKeys.get(key);if(!id){id=randomUuid();this.assetRequestKeys.set(key,id);}return id;}
 private loadingProjects=new Map<string,Promise<Project>>();
 private readonly projectReadControllers=new Set<AbortController>();
 private projectPreviews=new Map<string,ProjectPreview>();
 private previewGenerations=new Map<string,number>();
 private previewRequests=new Set<AbortController>();
 private queues=new Map<string,Promise<void>>();
 private blocked=new Map<string,DraftBlock>();
 private readonly retryableErrors=new Map<string,{code:'NODE_EDIT_OCCUPIED';message:string}>();
 private drafts=new Map<string,CanvasDraft>();
 private readonly draftOwners=new Map<string,string>();
 private epoch=0;
 private readonly modelBindings=new ModelBindings();
 private readonly historicalChecks=new WeakMap<Snapshot,Map<string,Promise<Capability|undefined>>>();
 private readonly localModelSelections=new Map<string,Map<string,any>>();
 private readonly modelPorts=new Map<string,NativeModelBindingPort>();
 readonly accessMap=new Map<string,ProjectAccess>();
 private readonly unconfirmedAccess=new Set<string>();
 private readonly accessIdentities=new Map<string,string>();
 private readonly accessListeners=new Set<(id:string)=>void>();
 private readonly accessLoads=new Map<string,{controller:AbortController;promise:Promise<ProjectAccess>}>();
 private readonly projectAssetCopies=new Map<string,Map<string,string>>();
 private readonly draftListeners=new Set<(id:string)=>void>();
 private readonly recoveryBusy=new Set<string>();
 private readonly recoveryStatus=new Map<string,{persistence:DraftRecoveryState['persistence'];error?:string;generation:number}>();
 private readonly journalRecords=new Map<string,DraftJournalRecord[]>();
 private readonly ownJournalIDs=new Map<string,string>();
 private readonly journalFingerprints=new Map<string,string>();
 private readonly draftFingerprints=new Map<string,string>();
 private readonly recoveredJournalVersions=new Map<string,DraftJournalRecord[]>();
 private readonly emergencyDrafts=new Map<string,{userId:string;graph:NativeGraph}>();
 private readonly exportedFingerprints=new Map<string,string>();
 private readonly journal:DraftJournal|undefined;
 constructor(readonly api:ApiClient,readonly notice:(message:string)=>void,private readonly identity?:()=>string|null,journal?:DraftJournal|null){this.journal=journal===null?undefined:journal??(identity?browserDraftJournal():undefined);this.registerBuiltinStyleMedia();}
 private registerBuiltinStyleMedia(){for(const entry of builtinStyleMedia)this.registerCatalogMedia(entry.url,entry.reference);}
 subscribeAccess(listener:(id:string)=>void){this.accessListeners.add(listener);return()=>{this.accessListeners.delete(listener);};}
 access(id:string){const value=this.accessMap.get(id);return value&&(!this.identity||this.identity()===this.accessIdentities.get(id))?value:undefined;}
 canRead(id:string){return this.access(id)?.canRead===true;}
 canEdit(id:string){return this.access(id)?.canEdit===true;}
 accessNeedsConfirmation(id:string){return this.unconfirmedAccess.has(id)&&!!this.access(id);}
 requirePermission(id:string,action:ProjectAction='canEdit'){
  // Pure storage ports have no identity. The production runtime supplies it;
  // no owner/role inference can grant an unverified production attachment.
  if(this.identity&&!this.access(id)?.[action])throw new ApiError(403,action==='canRead'?'PROJECT_ACCESS_REQUIRED':'READ_ONLY',action==='canRead'?'当前身份不能访问此项目。':'当前项目为只读，不能提交修改。');
  if(action!=='canRead'&&this.accessNeedsConfirmation(id))throw new ApiError(503,'PROJECT_ACCESS_RECHECK','正在重新确认画布连接，请稍后提交。');
 }
 rememberAccess(value:ProjectAccess,identityId=this.identity?.()??''){
  const access=validateProjectAccess(value,value.projectId);
  if(this.identity&&(!identityId||this.identity()!==identityId))throw new ApiError(401,'SESSION_CHANGED','登录状态已变更。');
  const previous=this.access(value.projectId);if(previous&&previous.revision>access.revision)throw new ApiError(409,'STALE_PROJECT_ACCESS','项目权限已更新，请重新加载。');
  const id=access.projectId,wasUnconfirmed=this.unconfirmedAccess.delete(id);
  this.accessMap.set(id,access);this.accessIdentities.set(id,identityId);
  if(wasUnconfirmed||!previous||previous.revision!==access.revision||previous.ownerId!==access.ownerId||previous.role!==access.role){
   for(const listener of this.accessListeners)listener(id);
  }
  return access;
 }
 invalidateAccess(id:string){
  this.accessLoads.get(id)?.controller.abort();this.accessLoads.delete(id);
  this.unconfirmedAccess.delete(id);this.accessMap.delete(id);this.accessIdentities.delete(id);
  for(const listener of this.accessListeners)listener(id);
 }
 refreshAccess(id:string,force=false):Promise<ProjectAccess>{
  const prior=this.accessLoads.get(id);
  if(prior&&!force)return prior.promise;
  prior?.controller.abort();
  const epoch=this.epoch,identityId=this.identity?.()??'',controller=new AbortController();let operation!:{controller:AbortController;promise:Promise<ProjectAccess>};
  const timeout=new ApiError(504,'PROJECT_ACCESS_TIMEOUT','画布权限确认超时。');
  let timer:ReturnType<typeof setTimeout>;
  const deadline=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{reject(timeout);controller.abort(timeout);},8000);});
  const promise=(async()=>{try{
   const result=await Promise.race([deadline,(this.api as ProductClient).requestV2<ProjectAccess>('/collaboration/projects/'+encodeURIComponent(id)+'/access',{signal:controller.signal})]);this.requireEpoch(epoch);
   if(controller.signal.aborted||this.accessLoads.get(id)!==operation||this.identity&&this.identity()!==identityId)throw new ApiError(401,'SESSION_CHANGED','项目权限请求已取消。');
   return this.rememberAccess(validateProjectAccess(result.data,id),identityId);
  }catch(error){
   if((!controller.signal.aborted||error===timeout)&&epoch===this.epoch&&this.accessLoads.get(id)===operation&&(!this.identity||identityId===this.identity())){
    if(projectAccessDenied(error))this.invalidateAccess(id);
    else if(!(error instanceof ApiError&&error.code==='STALE_PROJECT_ACCESS')&&this.access(id)&&!this.unconfirmedAccess.has(id)){
     this.unconfirmedAccess.add(id);
     for(const listener of this.accessListeners)listener(id);
    }
   }
   throw error;
  }
  finally{clearTimeout(timer!);if(this.accessLoads.get(id)===operation)this.accessLoads.delete(id);}})();
  operation={controller,promise};this.accessLoads.set(id,operation);return promise;
 }
 clear(){
  this.epoch++;
  for(const controller of this.canvasSaveControllers.values())controller.abort(new ApiError(401,'SESSION_CHANGED','登录状态已变更，本次操作已取消。'));this.canvasSaveControllers.clear();
  for(const session of this.operationSessions.values())session.dispose();
  this.operationSessions.clear();this.operationPorts.clear();this.operationErrors.clear();this.operationJournals.clear();this.saveProgress.clear();
  for(const load of this.accessLoads.values())load.controller.abort();this.accessLoads.clear();this.unconfirmedAccess.clear();this.accessMap.clear();this.accessIdentities.clear();for(const listener of this.accessListeners)listener('');
  this.projects.clear();this.snapshots.clear();this.assets.clear();this.etags.clear();
  for(const request of this.projectReadControllers)request.abort(new ApiError(401,'SESSION_CHANGED','登录状态已变更。'));this.projectReadControllers.clear();
  for(const request of this.previewRequests)request.abort();this.previewRequests.clear();this.projectPreviews.clear();this.previewGenerations.clear();
  this.canvasMediaScopes.clear();this.reverseUrls.clear();this.catalogMedia.clear();this.materializing.clear();this.resolvingAssets.clear();this.assetProgress.clear();this.assetRequestKeys.clear();this.loadingProjects.clear();this.blocked.clear();this.retryableErrors.clear();this.queues.clear();this.drafts.clear();this.draftOwners.clear();
  this.modelBindings.clear();this.modelPorts.clear();this.localModelSelections.clear();this.projectAssetCopies.clear();
  this.recoveryStatus.clear();this.journalRecords.clear();this.ownJournalIDs.clear();this.journalFingerprints.clear();this.draftFingerprints.clear();this.recoveredJournalVersions.clear();this.emergencyDrafts.clear();this.exportedFingerprints.clear();this.recoveryBusy.clear();this.notifyDraft('');
  this.registerBuiltinStyleMedia();
 }
 private requireEpoch(epoch:number){
  if(epoch!==this.epoch)throw new ApiError(401,'SESSION_CHANGED','登录状态已变更，本次操作已取消，请重新打开作品。');
 }
 private requireCanvas(id:string,state:CanvasDraft){if(this.drafts.get(id)!==state)throw new ApiError(409,'STALE_CANVAS_SESSION','画布已关闭或删除，本次操作已取消。');}
 restoreModelBindings(id:string,graph:NativeGraph){return Array.isArray(graph?.nodes)?this.modelBindings.graph(id,graph):graph;}
 /** Restore omitted configuration before assigning a new copy identity. */
 copySourceGraph(id:string,graph:NativeGraph){const state=this.drafts.get(id);return state?this.bindLocalGraph(id,graph,state):this.restoreModelBindings(id,graph);}
 rememberModelBinding(id:string,node:any,patch:any){this.modelBindings.record(id,node,patch);const updated={...node,data:{...node.data,...patch}};if(updated.data.capabilityVersion!==undefined){let rows=this.localModelSelections.get(id);if(!rows){rows=new Map();this.localModelSelections.set(id,rows);}rows.set(node.id,updated);}}
 private bindLocalGraph(id:string,graph:NativeGraph,state:CanvasDraft,remoteProgress=false):NativeGraph {
  const viewport=graph.viewport??graph.meta?.viewport;
  if(viewport&&[viewport.x,viewport.y,viewport.zoom].every(Number.isFinite)&&viewport.zoom>0)state.viewport=structuredClone(viewport);
  if(state.ack)graph=this.canvasContentProjection(graph,state.ack.graph);
  graph=this.remapProjectAssets(id,graph);
  // saveForExecution can acknowledge its freeze before a local preflight
  // aborts without a task. Keep that same native projection in the base too.
  if(state.observed&&state.ack)state.observed=this.restoreUnsubmittedMotionGraph(state.observed,state.ack.graph);
  if(state.observed&&state.ack)state.observed=this.restoreFailedEstimateGraph(state.observed,state.ack.graph);
  // fixture()/nativeView() display authoritative project metadata over a raw
  // snapshot. That display projection is not a deletion/edit of graph meta.
  const project=this.projects.get(id);if(project&&state.ack&&graph.meta){const meta={...graph.meta};for(const key of ['id','name']as const)if(meta[key]===project[key]){if(Object.hasOwn(state.ack.graph.meta??{},key))meta[key]=state.ack.graph.meta![key];else delete meta[key];}graph={...graph,meta};}
  const bindingKeys=['capabilityRef','capabilityVersion','parameterSchemaVersion'];
  const bound={...graph,nodes:graph.nodes.map(node=>{
   // D1n/wct omits these server presentation fields. Restore only the same
   // task's displayed observations; omitted keys are not an autosave deletion.
   const progressBase=remoteProgress?state.graph??state.ack?.graph:state.observed??state.graph??state.ack?.graph;
   const observation=progressBase?.nodes.find(value=>value.id===node.id&&value.type===node.type&&value.data?.taskId===node.data?.taskId);
   if(node.data?.taskId&&observation){const values=Object.fromEntries(['progress','progressDetail'].filter(key=>Object.hasOwn(observation.data??{},key)).map(key=>[key,observation.data[key]]));if(Object.keys(values).length)node={...node,data:{...node.data,...structuredClone(values)}};}
   if(node.data?.capabilityVersion===undefined){
    const ref=node.data?.modelCode??node.data?.capabilityRef;
    const prior=this.localModelSelections.get(id)?.get(node.id)||state.observed?.nodes.find(value=>value.id===node.id);
    node=prior?.type===node.type&&(prior.data?.modelCode??prior.data?.capabilityRef)===ref&&prior.data?.capabilityVersion!==undefined?{...node,data:{...node.data,...Object.fromEntries(bindingKeys.filter(key=>prior.data[key]!==undefined).map(key=>[key,prior.data[key]]))}}:this.modelBindings.node(id,node);
   }
   node=restoreNativeH3InputSerialization(node,state.ack?.graph.nodes.find(value=>value.id===node.id),this.encodeAsset);
   return this.restoreDisplayedReceipt(this.restoreDisplayedBatchMetadata(node,observation),observation);
  })};
  return state.ack?this.restoreFailedEstimateGraph(this.restoreUnsubmittedMotionGraph(bound,state.ack.graph),state.ack.graph):bound;
 }
 /** Removing an input resets the native failed Wan card to idle and omits
  * taskId, while retaining its exact failed estimate and request parameters.
  * Its old receipt is still the baseline, not a concurrent parameter edit. */
 private restoreFailedEstimateGraph(graph:NativeGraph,ack:NativeGraph):NativeGraph {
  return{...graph,nodes:graph.nodes.map(node=>{
   const prior=ack.nodes.find(value=>value.id===node.id&&value.type===node.type),data=node.data??{},receipt=prior?.data,ref='wan-animate2-motion-transfer-v1';
   if(node.type!=='rh-video'||!receipt||data.status!=='idle'||receipt.status!=='idle'
    ||typeof data.estimateTaskId!=='string'||!data.estimateTaskId||data.estimateTaskId!==receipt.estimateTaskId
    ||!Number.isSafeInteger(data.generationStartedAt)||data.generationStartedAt<=0||data.generationStartedAt!==receipt.generationStartedAt
    ||data.errorMsg!=='COMFY_GENERATION_FAILED'||data.errorMsg!==receipt.errorMsg
    ||[data,receipt].some(value=>['taskId','executionId','historyStorage','output'].some(key=>Object.hasOwn(value,key)))
    ||[data,receipt].some(value=>value.modelCode!==ref||value.capabilityRef!==ref||value.capabilityVersion!=='1'||value.parameterSchemaVersion!=='1'))return node;
   const current=cleanJson(data,this.encodeAsset),previous=cleanJson(receipt,this.encodeAsset),preset=previous.params?.outputPreset;
   if(typeof preset!=='string'||!/^(landscape|portrait|square|standard|standard-portrait|ultrawide)-(480p|768p)-5s$/.test(preset)
    ||typeof previous.prompt!=='string'||!previous.prompt.trim()||previous.params?.prompt!==previous.prompt||previous.params?.text!==previous.prompt
    ||!equalDraftValue(previous.routerParameters,{outputPreset:preset})
    ||!equalDraftValue(previous.userPromptSnapshot,{paramName:'prompt',value:previous.prompt}))return node;
   const image=previous.params.imageUrls,video=previous.params.videoUrls;
   if(!Array.isArray(image)||image.length!==1||!Array.isArray(video)||video.length!==1
    ||[...image,...video].some(value=>typeof value!=='string'||!/^rhtv-asset:[A-Za-z0-9_-]+$/.test(value))
    ||!equalDraftValue(previous.promptSelection,{schemaVersion:'1',referenceBindings:[{role:'REFERENCE_IMAGE',assetId:image[0].slice(11)},{role:'SOURCE_VIDEO',assetId:video[0].slice(11)}]}))return node;
   const patch:Record<string,any>={};
   for(const key of ['routerParameters','userPromptSnapshot','promptSelection'])if(!Object.hasOwn(current,key)&&Object.hasOwn(previous,key)){current[key]=previous[key];patch[key]=structuredClone(receipt[key]);}
   for(const key of ['progress','progressDetail'])if(!Object.hasOwn(current,key)&&previous[key]===null)current[key]=null;
   if(!Object.hasOwn(current,'testMode')&&previous.testMode===false)current.testMode=false;
   for(const key of ['label','title']){delete current[key];delete previous[key];}
   if(!equalDraftValue(current,previous))return node;
   return Object.keys(patch).length?{...node,data:{...data,...patch}}:node;
  })};
 }
 /** The promptless H3 form omits its own just-saved execution metadata even
  * when no task was submitted. Restore only that exact idle input, including
  * its unchanged direct media sources; a later model choice must drop it. */
 private restoreUnsubmittedMotionGraph(graph:NativeGraph,ack:NativeGraph):NativeGraph {
  return{...graph,nodes:graph.nodes.map(node=>{
   const prior=ack.nodes.find(value=>value.id===node.id&&value.type===node.type),data=node.data??{},receipt=prior?.data;
   const ref='h3-motion-transfer-v1',keys=['routerParameters','userPromptSnapshot','promptSelection'];
   if(node.type!=='rh-video'||!receipt||data.status!=='idle'||receipt.status!=='idle'
    ||[data,receipt].some(value=>['taskId','estimateTaskId','executionId','historyStorage','output'].some(key=>Object.hasOwn(value,key)))
    ||[data,receipt].some(value=>value.modelCode!==ref||value.capabilityRef!==ref||value.capabilityVersion!=='1'||value.parameterSchemaVersion!=='1'))return node;
   const current=cleanJson(data,this.encodeAsset),previous=cleanJson(receipt,this.encodeAsset),preset=previous.params?.outputPreset;
   if(typeof preset!=='string'||!/^(landscape|portrait|square|standard|standard-portrait|ultrawide)-(480p|768p)-5s$/.test(preset)
    ||previous.prompt!==''||previous.params?.prompt!==''||previous.params?.text!==''
    ||!equalDraftValue(previous.routerParameters,{outputPreset:preset})
    ||!equalDraftValue(previous.userPromptSnapshot,{paramName:'prompt',value:''}))return node;
   const image=previous.params.imageUrls,video=previous.params.videoUrls;
   if(!Array.isArray(image)||image.length!==1||!Array.isArray(video)||video.length!==1
    ||[...image,...video].some(value=>typeof value!=='string'||!/^rhtv-asset:[A-Za-z0-9_-]+$/.test(value))
    ||!equalDraftValue(previous.promptSelection,{schemaVersion:'1',referenceBindings:[{role:'REFERENCE_IMAGE',assetId:image[0].slice(11)},{role:'SOURCE_VIDEO',assetId:video[0].slice(11)}]}))return node;
   const incoming=(value:NativeGraph)=>value.edges.filter(edge=>edge.target===node.id);
   const edges=incoming(graph);if(edges.length!==2||!equalDraftValue(cleanJson(edges,this.encodeAsset),cleanJson(incoming(ack),this.encodeAsset)))return node;
   if(edges.some(edge=>{const source=graph.nodes.find(value=>value.id===edge.source),before=ack.nodes.find(value=>value.id===edge.source);return!source||!before||source.type!==before.type||!equalDraftValue(cleanJson(source.data,this.encodeAsset),cleanJson(before.data,this.encodeAsset));}))return node;
   const sources=edges.map(edge=>graph.nodes.find(value=>value.id===edge.source)!);
   if(!(['rh-image','rh-video']as const).every((type,index)=>{const matches=sources.filter(source=>source.type===type);return matches.length===1&&equalDraftValue(cleanJson(matches[0].data?.sourceObjects,this.encodeAsset),index===0?image:video);}))return node;
   const patch:Record<string,any>={};
   for(const key of keys){if(!Object.hasOwn(current,key)&&Object.hasOwn(previous,key)){current[key]=previous[key];patch[key]=structuredClone(receipt[key]);}}
   // The native form also omits the false presentation flag. Unknown fields,
   // explicit metadata values, parameters and prompt edits remain semantic.
   if(!Object.hasOwn(current,'testMode')&&previous.testMode===false)current.testMode=false;
   for(const key of ['label','title']){delete current[key];delete previous[key];}
   if(!equalDraftValue(current,previous))return node;
   return Object.keys(patch).length?{...node,data:{...data,...patch}}:node;
  })};
 }
 /** D1n omits descriptive batch fields even on a freshly mounted result. Keep
  * their baseline only for the exact displayed batch image, so deleting it is
  * not mistaken for deleting a concurrently edited server node. */
 private restoreDisplayedBatchMetadata(node:any,prior:any){
  const data=node.data??{},receipt=prior?.data,origin=receipt?.historyStorage?.imageBatchOrigin;
  if(node.type!=='rh-image'||prior?.id!==node.id||prior.type!==node.type||!origin
   ||['taskId','executionId','sourceNodeId','outputId'].some(key=>typeof origin[key]!=='string'||!origin[key])
   ||!Number.isInteger(origin.index)||!Number.isInteger(origin.count)||origin.count<1||origin.count>8||origin.index<0||origin.index>=origin.count
   ||node.id!==(origin.index===0?origin.sourceNodeId:imageBatchNodeId(origin.taskId,origin.executionId,origin.outputId))
   ||!equalDraftValue(data.historyStorage?.imageBatchOrigin,origin)||!equalDraftValue(receipt.batchOrigin,origin)
   ||Object.hasOwn(data,'batchOrigin')&&!equalDraftValue(data.batchOrigin,origin))return node;
  const current=cleanJson(data,this.encodeAsset),previous=cleanJson(receipt,this.encodeAsset),output=previous.output;
  if(!Array.isArray(output)||output.length!==1||typeof output[0]?.assetId!=='string'||!output[0].assetId
   ||!equalDraftValue(previous.assetIds,[output[0].assetId])
   ||!['output','sourceObjects','imageUrl','historyStorage'].every(key=>equalDraftValue(current[key],previous[key])))return node;
  const patch=Object.fromEntries(['assetIds','batchOrigin','isUpload','testMode'].filter(key=>!Object.hasOwn(data,key)&&Object.hasOwn(receipt,key)
   &&(!['isUpload','testMode'].includes(key)||typeof receipt[key]==='boolean')).map(key=>[key,structuredClone(receipt[key])]));
  return Object.keys(patch).length?{...node,data:{...data,...patch}}:node;
 }
 /** The native result view omits these execution receipt fields. Include them
  * in its observed baseline so an unrelated later model selection is not
  * mistaken for a concurrent server parameter edit. A local input/selection
  * change must never inherit the preceding execution's frozen parameters. */
 private restoreDisplayedReceipt(node:any,prior:any){
  const data=node.data??{},receipt=prior?.data,ref=data.modelCode??data.capabilityRef;
  if(!receipt||prior.id!==node.id||prior.type!==node.type||typeof ref!=='string'||!ref||!data.capabilityVersion)return node;
  const sameTask=!!data.taskId&&data.taskId===receipt.taskId;
  // A detached idle result keeps durable history but no running task identity.
  // D1n omits its frozen receipt too. Recover that observation only while the
  // exact model, input and displayed result below still match the receipt.
  const idleHistory=data.status==='idle'&&receipt.status==='idle'&&!Object.hasOwn(data,'taskId')&&!Object.hasOwn(receipt,'taskId')
   &&receipt.historyStorage?.source==='remote'&&receipt.historyStorage.schemaVersion===1&&typeof receipt.historyStorage.historyId==='string'&&!!receipt.historyStorage.historyId;
  // A native idle form also omits an unsubmitted request's frozen fields.
  // Keep that projection in its observed baseline even without a result; a
  // later local model choice must not see their omission as a remote edit.
  const idleEmpty=[data,receipt].every(value=>value.status==='idle'&&['taskId','executionId','historyStorage'].every(key=>!Object.hasOwn(value,key))
   &&(value.output===undefined||Array.isArray(value.output)&&value.output.length===0));
  if(!sameTask&&!idleHistory&&!idleEmpty)return node;
  const displayedOutput=data.historyStorage?.source==='remote'&&data.historyStorage.historyId&&Array.isArray(data.output)&&data.output.length;
  // Failed attempts have no output/history receipt, but D1n still omits the
  // frozen request fields. Restore only an unchanged, same-task failed view
  // before it becomes the merge base; never apply them to a new selection.
  const emptyFailure=data.status==='failed'&&receipt.status==='failed'
   &&[data.output,receipt.output].every(value=>value===undefined||Array.isArray(value)&&value.length===0)
   &&data.historyStorage===undefined&&receipt.historyStorage===undefined;
  if(!displayedOutput&&!emptyFailure&&!idleEmpty)return node;
  const identity=['modelCode','capabilityRef','capabilityVersion','parameterSchemaVersion','historyStorage','output','imageUrl','videoUrl','audioUrl','sourceObjects','selectedHistoryBatchId','selectedHistoryOutputId','selectedOutputHistoryId','selectedOutputHistoryIndex','params','prompt'];
  // Native media uses download URLs while the stored baseline uses asset IDs.
  // Compare their owned-asset form, rather than signed download URL strings.
  const current=cleanJson(data,this.encodeAsset),previous=cleanJson(receipt,this.encodeAsset);
  if(idleEmpty){
   const projected={...current},expected={...previous};
   for(const key of ['routerParameters','userPromptSnapshot'])if(!Object.hasOwn(projected,key)&&Object.hasOwn(expected,key))projected[key]=expected[key];
   if(!Object.hasOwn(projected,'testMode')&&expected.testMode===false)projected.testMode=false;
   for(const key of ['label','title']){delete projected[key];delete expected[key];}
   // Empty cards have no immutable result identity. Require every remaining
   // input, estimate, cached selection and unknown field to match; this also
   // leaves the stricter frozen reference-binding projections in control.
   if(!equalDraftValue(projected,expected))return node;
  }
  // D1n truncates only data.prompt at 4000 characters. SGUN's complete prompt
  // remains in both native parameter aliases; accept that exact projection
  // only for the same completed, owned video receipt and unchanged inputs.
  const output=previous.output?.[0],longPrompt=node.type==='rh-video'&&ref==='h3-sgun-long-reference-v1'&&data.capabilityRef===ref&&['1','2'].includes(data.capabilityVersion)&&data.parameterSchemaVersion===data.capabilityVersion
   &&data.status==='finished'&&receipt.status==='finished'&&previous.historyStorage?.schemaVersion===1&&previous.historyStorage.resultCount===1
   &&typeof previous.prompt==='string'&&previous.prompt.length>4000&&current.prompt===previous.prompt.slice(0,4000)
   &&current.params?.prompt===previous.prompt&&current.params?.text===previous.prompt&&previous.params?.prompt===previous.prompt&&previous.params?.text===previous.prompt
   &&previous.userPromptSnapshot?.paramName==='prompt'&&previous.userPromptSnapshot.value===previous.prompt
   &&Array.isArray(previous.output)&&previous.output.length===1&&typeof output?.assetId==='string'&&!!output.assetId&&typeof output.outputId==='string'&&!!output.outputId
   &&output.url==='rhtv-asset:'+output.assetId&&previous.videoUrl===output.url&&output.mimeType==='video/mp4'
   &&identity.filter(key=>key!=='prompt').every(key=>equalDraftValue(current[key],previous[key]));
  if(longPrompt)current.prompt=previous.prompt;
  if(!identity.every(key=>equalDraftValue(current[key],previous[key])))return node;
  const patch=Object.fromEntries(['routerParameters','userPromptSnapshot'].filter(key=>!Object.hasOwn(data,key)&&Object.hasOwn(receipt,key)).map(key=>[key,structuredClone(receipt[key])]));
  if(longPrompt){patch.prompt=receipt.prompt;if(!Object.hasOwn(data,'testMode')&&typeof receipt.testMode==='boolean')patch.testMode=receipt.testMode;}
  return Object.keys(patch).length?{...node,data:{...data,...patch}}:node;
 }
 private remapProjectAssets<T>(id:string,value:T):T {const mapping=this.projectAssetCopies.get(id);return mapping?.size?remapAssetValues(value,mapping,this.encodeAsset,this.decodeAsset):value;}
 remapGraphForProject<T>(id:string,value:T):T{return this.remapProjectAssets(id,value);}
 async prepareExecutionGraph(id:string,graph:NativeGraph){this.requirePermission(id,'canRun');await this.prepareGraph(graph);const epoch=this.epoch,state=this.canvas(id),entry:PendingSave={base:state.ack?.graph??graph,local:graph,initialEtag:state.ack?.etag??'',unknownBase:!state.ack,phase:'DRAFT'};await this.prepareProjectAssets(id,state,entry,epoch);this.requirePermission(id,'canRun');return this.remapProjectAssets(id,graph);}
 private async prepareProjectAssets(id:string,state:CanvasDraft,entry:PendingSave,epoch:number,signal?:AbortSignal,onProgress?:()=>void){
  if(!this.identity)return;
  this.requirePermission(id);const known=assetReferences(encodeGraph(state.ack?.graph??{nodes:[],edges:[]},this.encodeAsset)),references=assetReferences(encodeGraph(this.remapProjectAssets(id,entry.local),this.encodeAsset)),added=[...references].filter(assetId=>!known.has(assetId));
  if(added.length){
   // Keep the same import key until a complete response has been applied. A
   // timed-out response can already have copied these assets on the server.
   added.sort();const key='import:'+id+':'+JSON.stringify(added),idempotencyKey=this.assetRequestKey(key);
   const result=(await canvasRequestDeadline(signal,(request,progress)=>(this.api as ProductClient).requestRawJsonV2<{targetProjectId:string;assetIdMap:Record<string,string>;assets:Asset[]}>('/collaboration/projects/'+encodeURIComponent(id)+'/assets/import',{method:'POST',body:{assetIds:added},idempotencyKey,signal:request,onReadProgress:progress}),onProgress,60000)).data;this.requireEpoch(epoch);this.requireCanvas(id,state);this.requirePermission(id);
   if(result.targetProjectId!==id||!result.assetIdMap||added.some(assetId=>typeof result.assetIdMap[assetId]!=='string'||!result.assetIdMap[assetId]))throw new ApiError(502,'INVALID_ASSET_IMPORT','项目素材导入响应不完整。');
   await Promise.all([...new Set(added.map(assetId=>result.assetIdMap[assetId]))].map(assetId=>this.resolveAsset(assetId,onProgress)));this.requireEpoch(epoch);this.requireCanvas(id,state);this.requirePermission(id);signal?.throwIfAborted();
   let mapping=this.projectAssetCopies.get(id);if(!mapping){mapping=new Map();this.projectAssetCopies.set(id,mapping);}for(const assetId of added)if(result.assetIdMap[assetId]!==assetId)mapping.set(assetId,result.assetIdMap[assetId]);
   this.assetRequestKeys.delete(key);
  }
  for(const pending of state.pending){pending.base=this.remapProjectAssets(id,pending.base);pending.local=this.remapProjectAssets(id,pending.local);}if(state.observed)state.observed=this.remapProjectAssets(id,state.observed);
 }
 reconcileModelBindings(id:string,graph:NativeGraph){
  if(!Array.isArray(graph?.nodes))return;
  const state=this.drafts.get(id);
  // A native view can still lack remote-created nodes. Only its actual local
  // deletions invalidate sidecars; do not interpret an unseen node as deleted.
  const effective=!this.operationSessions.has(id)&&state?.observed&&state.ack?mergeCanvasDraft(state.observed,this.canonical(graph),state.graph||state.ack.graph).graph:graph;
  this.modelBindings.reconcile(id,effective);const ids=new Set(effective.nodes.map(node=>node.id));for(const nodeId of this.localModelSelections.get(id)?.keys()||[])if(!ids.has(nodeId))this.localModelSelections.get(id)?.delete(nodeId);
 }
 private canonical(graph:NativeGraph){return decodeGraph(encodeGraph(persistentRegionGraph(graph),this.encodeAsset));}
 private canvasContentProjection(graph:NativeGraph,reference:NativeGraph):NativeGraph {
  // Pan/zoom belongs to the mounted page. Retain the first stored viewport
  // for legacy reopen behavior, without making later viewing gestures shared
  // authored changes or conflicts with another editor's node inputs.
  const viewport=structuredClone(reference.viewport??reference.meta?.viewport??{x:0,y:0,zoom:1});
  return{...graph,viewport,meta:{...graph.meta,viewport}};
 }
 private mergePending(entry:PendingSave,remote:NativeGraph){
  // A native omission may already have been captured before a later model
  // switch. Normalize that local projection against its own immutable base,
  // so replay cannot mistake it for deleting the prior failed receipt.
  const local=this.restoreFailedEstimateGraph(entry.local,entry.base);
  const merged=mergeCanvasDraft(this.canvasContentProjection(this.canonical(entry.requiresBaseDecision?{nodes:[],edges:[]}:entry.base),remote),this.canvasContentProjection(this.canonical(local),remote),remote);
  if(entry.requiresBaseDecision)merged.conflicts.unshift({path:'/',reason:'BASE_UNKNOWN'});
  return merged;
 }
 private compactDraftPrefix(state:CanvasDraft,phases:PendingSave['phase'][]){
  const first=state.pending[0];if(!first||!phases.includes(first.phase)||first.unknownBase||first.requiresBaseDecision)return;
  let count=1,combined=this.mergePending(first,this.canonical(first.base)).graph;
  while(state.pending[count]&&phases.includes(state.pending[count].phase)){
   const entry=state.pending[count];if(entry.unknownBase||entry.requiresBaseDecision)break;
   const next=this.mergePending(entry,combined);
   // A later observed base may include a remote-created node or a newer field
   // the user subsequently edits. Flattening across that boundary would lose
   // its real baseline and invent a create/create or same-field conflict.
   if(next.conflicts.length)break;combined=next.graph;count++;
  }
  if(count<2)return;
  const entries=state.pending.splice(0,count,{...first,local:combined});
  if(state.coalesced&&entries.includes(state.coalesced))state.coalesced=undefined;
  if(state.unqueued&&entries.includes(state.unqueued))state.unqueued=undefined;
 }
 private canvas(id:string):CanvasDraft {
  let state=this.drafts.get(id);const userId=this.identity?.();if(state&&this.identity&&this.draftOwners.get(id)!==userId)throw new ApiError(401,'SESSION_CHANGED','账号已变更，请重新打开作品。');if(!state){state={pending:[],conflicts:[]};const snapshot=this.snapshots.get(id);if(snapshot)state.ack={graph:this.canonical(decodeGraph(snapshot.graph)),revision:snapshot.revision,etag:'"'+snapshot.revision+'"'};this.drafts.set(id,state);if(userId)this.draftOwners.set(id,userId);}return state;
 }
 private nativeView(id:string,graph:NativeGraph){const native=decodeGraph(encodeGraph(persistentRegionGraph(graph)),value=>this.displayCanvasAsset(id,value)),state=this.drafts.get(id),viewport=state?.viewport??state?.observed?.viewport,project=this.projects.get(id);if(project)native.meta={...native.meta,id,name:project.name};if(viewport){native.viewport=structuredClone(viewport);native.meta={...native.meta,viewport:native.viewport};}return native;}
 private replayDraft(entries:PendingSave[],ack?:AcknowledgedCanvas):DraftMerge {
  let graph=ack?.graph;const origins:{conflict:DraftConflict;base:NativeGraph}[]=[];
  for(const entry of entries){
   if(!graph){graph=this.canonical(entry.local);continue;}
   if(entry.unknownBase&&!entry.requiresBaseDecision){if(entry.initialEtag!==ack?.etag)origins.push({conflict:{path:'/',reason:'BASE_UNKNOWN'},base:entry.base});graph=this.canonical(entry.local);continue;}
   const merged=this.mergePending(entry,graph);graph=merged.graph;for(const conflict of merged.conflicts)origins.push({conflict,base:this.canonical(entry.base)});
  }
  graph=structuredClone(graph??{nodes:[],edges:[]});const conflicts:DraftConflict[]=[];
  for(const {conflict,base} of origins){
   // A later local descendant can undo an earlier edit or converge with the
   // server. Keep its immutable base; never flatten remote-only additions into
   // a replacement graph just to discard an obsolete conflict.
   let resolved=false;
   if(ack&&conflict.reason!=='BASE_UNKNOWN'&&conflict.reason!=='DANGLING_REFERENCE'){
    // Group conflicts couple a child's coordinates to another node's group
    // transform. Equality of just the child is insufficient proof.
    const path=conflict.reason==='GROUP_POSITION'?'/':conflict.path;
    const own=draftPathValue(graph,path),theirs=draftPathValue(ack.graph,path),before=draftPathValue(base,path);
    if(equalDraftValue(own,theirs))resolved=true;
    else if(equalDraftValue(own,before)){
     try{graph=resolveDraftGraph(graph,ack.graph,[conflict],{[conflict.path]:'server'});resolved=true;}catch{/* A dangling local connection still needs an explicit decision. */}
    }
   }
   if(!resolved&&!conflicts.some(value=>value.path===conflict.path&&value.reason===conflict.reason))conflicts.push(conflict);
  }
  return{graph,conflicts};
 }
 private blockUncertain(id:string,state:CanvasDraft,revision=state.ack?.revision??0,strict=true){
  const prior=this.blocked.get(id)?.proof;
  // A subsequent, weaker failure cannot lower the proof needed to safely
  // release an earlier uncertain write.
  if(prior&&(prior.revision>revision||prior.revision===revision&&prior.strict)){revision=prior.revision;strict=prior.strict;}
  this.blocked.set(id,{graph:structuredClone(state.graph??state.ack?.graph??{nodes:[],edges:[]}),reason:'CAS_UNCERTAIN',proof:{revision,strict}});
 }
 private blockRefusedSave(id:string,state:CanvasDraft,revision:number){
  const prior=this.blocked.get(id),known=!prior||prior.reason==='CAS_UNCERTAIN'&&prior.proof?.definitiveRefusal===true;
  this.blockUncertain(id,state,revision,true);
  // A 412 definitively did not apply this PUT. A live snapshot can already
  // have provided its newer proof before the HTTP refusal reached this page.
  // Never reuse that earlier proof for a preceding unknown write outcome.
  const proof=this.blocked.get(id)?.proof;if(known&&proof)proof.definitiveRefusal=true;
  if(proof?.definitiveRefusal&&state.ack&&state.ack.revision>proof.revision&&!state.conflicts.length)this.blocked.delete(id);
 }
 private responseProofRevision(id:string,result:ApiResult<Snapshot>){
  let revision=result.data?.projectId===id&&Number.isSafeInteger(result.data.revision)&&result.data.revision>0?result.data.revision:undefined;
  const etag=result.etag?.match(/^"([1-9][0-9]*)"$/);if(etag&&Number.isSafeInteger(Number(etag[1])))revision=Math.max(revision??0,Number(etag[1]));
  return revision;
 }
 private rebuildDraft(id:string,state:CanvasDraft):DraftMerge {
  const operations=this.operationSessions.get(id);if(operations){state.graph=this.canonical(decodeGraph(operations.projected()));state.conflicts=[];return{graph:structuredClone(state.graph),conflicts:[]};}
  const {graph,conflicts}=this.replayDraft(state.pending,state.ack);
  state.graph=graph;state.conflicts=conflicts;
  const lock=this.blocked.get(id);
  if(lock?.reason==='CAS_UNCERTAIN'){
   if(lock.proof?.definitiveRefusal&&state.ack&&state.ack.revision>lock.proof.revision&&!conflicts.length)this.blocked.delete(id);
   else lock.graph=structuredClone(graph);
  }
  else if(conflicts.length)this.blocked.set(id,{graph:structuredClone(graph),reason:conflicts.some(value=>value.reason==='BASE_UNKNOWN')?'BASE_UNKNOWN':'MERGE_CONFLICT'});
  else if(!state.pending.some(entry=>entry.unknownBase||entry.requiresBaseDecision)||lock?.reason!=='BASE_UNKNOWN')this.blocked.delete(id);
  this.persistDraftState(id,state);
  return{graph:structuredClone(graph||{nodes:[],edges:[]}),conflicts:structuredClone(conflicts)};
 }
 /** Accept a coherent server snapshot. This advances the acknowledged base,
  * never just the ETag, and leaves the last observed native view unchanged. */
 acceptRemoteSnapshot(id:string,snapshot:Snapshot,etag?:string|null):DraftMerge {return this.acceptSnapshot(id,snapshot,etag,true);}
 /** Capture edits still inside the native autosave delay before changing the
  * server base. This records a draft without issuing a network mutation. */
 observeNativeDraft(id:string,native:NativeGraph){
  if(this.operationSessions.has(id))return this.observeOperationGraph(id,native);
  const state=this.canvas(id),local=this.canonical(this.bindLocalGraph(id,native,state));
  if(equalDraftValue(local,state.observed))return false;
  const initialEtag=state.ack?.etag||this.etags.get(id);if(!initialEtag)throw new ApiError(409,'BASE_UNKNOWN','画布还在加载，请稍后继续编辑。');
  if(state.unqueued)state.unqueued.local=local;
  else{
   // Compact only settled local differences; replay against their original
   // base so previously displayed remote additions never become local edits.
   this.compactDraftPrefix(state,['DRAFT','FAILED']);
   state.unqueued={base:structuredClone(state.observed||state.ack?.graph||local),local,initialEtag,unknownBase:!state.ack,phase:'DRAFT'};state.pending.push(state.unqueued);
  }
  state.observed=structuredClone(local);this.rebuildDraft(id,state);
  return true;
 }
 /** Called only after a remote merge was applied to the existing manager. */
 remoteNativeViewApplied(id:string,native:NativeGraph,displayedRevision?:number){const state=this.canvas(id),operations=this.operationSessions.get(id);if(displayedRevision!==undefined)state.displayedRevision=displayedRevision;if(operations){state.observed=this.canonical(this.restoreModelBindings(id,native));operations.reobserve(encodeGraph(state.observed),displayedRevision);return;}state.observed=this.canonical(this.bindLocalGraph(id,native,state,true));state.unqueued=undefined;state.coalesced=undefined;}
 mergedNativeView(id:string){const state=this.canvas(id),result=this.rebuildDraft(id,state);return{graph:this.restoreModelBindings(id,this.nativeView(id,result.graph)),conflicts:result.conflicts};}
 hasDraft(id:string){const emergency=this.emergencyDrafts.get(id);return!!this.operationSessions.get(id)?.hasPending()||!!this.drafts.get(id)?.pending.length||this.blocked.has(id)||!!emergency&&emergency.userId===this.identity?.();}
 canvasReadGuard(id:string){const epoch=this.epoch,state=this.canvas(id);return()=>{this.requireEpoch(epoch);this.requireCanvas(id,state);this.requirePermission(id,'canRead');};}
 canReuseMoveProjection(id:string){
  return this.operationSessions.has(id)&&this.canvasMediaScopes.has(id)&&!this.localModelSelections.get(id)?.size&&!this.hasDraft(id)&&!this.isSaveCatchingUp(id);
 }
 async receiveLiveSnapshot(id:string,snapshot:Snapshot,etag:string|null,readNative:()=>NativeGraph|null,isCurrent:()=>boolean,signal:AbortSignal,readOnly=false,accepted?:(view:DraftMerge)=>void,onProgress?:()=>void){
  const epoch=this.epoch,state=this.canvas(id);
  const check=()=>{this.requireEpoch(epoch);this.requireCanvas(id,state);if(signal.aborted||!isCurrent())throw new ApiError(409,'STALE_CANVAS_SESSION','画布已切换，本次同步已取消。');};
  if(!this.canvasMediaScopes.has(id)){
   // Compatible with older services during a rolling upgrade.
   const ids=[...assetReferences(snapshot.graph)],resolved=new Map<string,Asset>();let offset=0;
   await Promise.all(Array.from({length:Math.min(4,Math.ceil(ids.length/100))},async()=>{while(offset<ids.length){
    const chunk=ids.slice(offset,offset+=100),result=await(this.api as ProductClient).requestV2<{assets:Asset[]}>('/assets/resolve-batch',{method:'POST',body:{assetIds:chunk},signal,onReadProgress:onProgress});check();onProgress?.();
    if(!Array.isArray(result.data?.assets)||result.data.assets.length!==chunk.length)throw new ApiError(502,'INVALID_RESPONSE','远端画布素材校验结果不完整。');
    const requested=new Set(chunk);for(const asset of result.data.assets){if(!requested.delete(asset?.id)||asset.state!=='READY'||!(asset.downloadUrl||asset.previewUrl))throw new ApiError(502,'INVALID_RESPONSE','远端画布素材尚未就绪。');resolved.set(asset.id,asset);}
   }}));
   check();for(const asset of resolved.values())this.registerAsset(asset);
  }
  check();const native=readNative();if(!native)throw new ApiError(409,'CANVAS_NOT_READY','原生画布尚未就绪。');if(!readOnly)this.observeNativeDraft(id,native);
  const merged=this.acceptRemoteSnapshot(id,snapshot,etag);
  accepted?.(merged);
  return merged;
 }
 readOnlyNativeView(id:string){const snapshot=this.snapshots.get(id);if(!snapshot)throw new ApiError(409,'CANVAS_NOT_READY','画布尚未加载。');return this.restoreModelBindings(id,this.nativeView(id,decodeGraph(snapshot.graph)));}
 private acceptSnapshot(id:string,snapshot:Snapshot,etag:string|null|undefined,remote:boolean):DraftMerge {
  if(snapshot.projectId!==id||!Number.isSafeInteger(snapshot.revision)||snapshot.revision<1)throw new ApiError(502,'INVALID_RESPONSE','画布同步数据无效，请重试同步。');
  if(etag&&etag!=='"'+snapshot.revision+'"')throw new ApiError(502,'SNAPSHOT_REVISION_MISMATCH','画布同步内容尚未确认，请重试同步。');
  const state=this.canvas(id),graph=this.canonical(decodeGraph(snapshot.graph));
  if(state.ack&&snapshot.revision<state.ack.revision){const result=this.rebuildDraft(id,state);return{graph:this.nativeView(id,result.graph),conflicts:result.conflicts};}
  const rawPrior=this.snapshots.get(id);if(rawPrior?.revision===snapshot.revision&&!equalDraftValue(rawPrior.graph,snapshot.graph))throw new ApiError(502,'SNAPSHOT_REVISION_MISMATCH','画布同步内容尚未确认，请重试同步。');
  if(state.ack&&snapshot.revision===state.ack.revision&&!equalDraftValue(graph,state.ack.graph))throw new ApiError(502,'SNAPSHOT_REVISION_MISMATCH','画布同步内容尚未确认，请重试同步。');
  state.ack={graph:structuredClone(graph),revision:snapshot.revision,etag:etag||'"'+snapshot.revision+'"'};
  this.operationSessions.get(id)?.acceptSnapshot(snapshot);
  if(!state.observed)state.observed=structuredClone(graph);
  this.snapshots.set(id,structuredClone(snapshot));this.etags.set(id,state.ack.etag);
  const lock=this.blocked.get(id);if(lock?.reason==='CAS_UNCERTAIN'&&lock.proof&&(snapshot.revision>lock.proof.revision||snapshot.revision===lock.proof.revision&&!lock.proof.strict))this.blocked.delete(id);
  const project=this.projects.get(id);if(project){project.revision=snapshot.revision;project.updatedAt=snapshot.updatedAt;}
  const result=this.rebuildDraft(id,state);if(result.conflicts.length)this.notice('部分修改尚未同步，内容已保留，请重试同步。');
  if(remote)for(const node of result.graph.nodes)if(node.data?.capabilityVersion!==undefined&&!this.localModelSelections.get(id)?.has(node.id))this.modelBindings.record(id,node,{});
  return{graph:this.nativeView(id,result.graph),conflicts:result.conflicts};
 }
 subscribeDrafts(listener:(id:string)=>void){this.draftListeners.add(listener);return()=>{this.draftListeners.delete(listener);};}
 private notifyDraft(id:string){for(const listener of this.draftListeners)listener(id);}
 private draftEnvelope(id:string,state:CanvasDraft):DraftEnvelope {
  const userId=this.identity?.();if(!userId||this.draftOwners.get(id)!==userId)throw new ApiError(401,'SESSION_CHANGED','请先登录原账号，再处理本地草稿。');
  const first=state.pending[0],base=first?.base??state.ack?.graph,match=first?.initialEtag.match(/^"([0-9]+)"$/),revision=match?Number(match[1]):state.ack?.revision;
  const own=this.journalRecords.get(id)?.find(row=>row.id===this.ownJournalIDs.get(id)),now=new Date().toISOString();
  let graph=journalGraph(this.canonical(state.graph??state.observed??state.ack?.graph??{nodes:[],edges:[]}));
  const pending=state.pending.map(entry=>({base:journalGraph(this.canonical(entry.base)),local:journalGraph(this.canonical(entry.local)),initialEtag:entry.initialEtag,unknownBase:entry.unknownBase,...(entry.requiresBaseDecision?{requiresBaseDecision:true}:{})}));
  const emergency=this.emergencyDrafts.get(id);let unresolvedMedia=0;
  if(emergency?.userId===userId){
   const media=new Map<string,string>();
   const safe=cleanJson(this.restoreModelBindings(id,emergency.graph),value=>{
    const mapped=this.encodeAsset(value);if(mapped.startsWith('blob:')||mapped.includes('/__rhtv_media/')){let replacement=media.get(mapped);if(!replacement){replacement='studiotv-unuploaded:'+String(media.size+1);media.set(mapped,replacement);}return replacement;}return mapped;
   });
   graph=journalGraph(safe);unresolvedMedia=media.size;
   pending.push({base:journalGraph(this.canonical(state.observed??state.ack?.graph??{nodes:[],edges:[]})),local:graph,initialEtag:state.ack?.etag??'unknown',unknownBase:false,...(!state.ack?{requiresBaseDecision:true}:{})});
  }
  unresolvedMedia=Math.max(unresolvedMedia,this.unresolvedMediaCount(graph));
  return{format:'STUDIOTV_CANVAS_DRAFT',schemaVersion:'1',userId,projectId:id,createdAt:own?.createdAt??now,updatedAt:now,...(revision?{baseRevision:revision}:{}),...(base?{base:journalGraph(this.canonical(base))}:{}),graph,pending,...(unresolvedMedia?{unresolvedMedia}:{})};
 }
 private unresolvedMediaCount(graph:NativeGraph){const refs=new Set<string>();const visit=(value:any)=>{if(typeof value==='string'&&value.startsWith('studiotv-unuploaded:'))refs.add(value);else if(Array.isArray(value))value.forEach(visit);else if(value&&typeof value==='object')Object.values(value).forEach(visit);};visit(graph);return refs.size;}
 private envelopeFingerprint(envelope:DraftEnvelope){return JSON.stringify({baseRevision:envelope.baseRevision,base:envelope.base,graph:envelope.graph,pending:envelope.pending});}
 private persistDraftState(id:string,state:CanvasDraft):boolean {
  if(this.operationSessions.has(id)){this.notifyDraft(id);return!this.operationSessions.get(id)!.storageError;}
  const userId=this.identity?.();if(!userId||!this.journal||this.draftOwners.get(id)!==userId){this.notifyDraft(id);return false;}
  const previous=this.recoveryStatus.get(id)??{persistence:'none' as const,generation:0};
  try{
   if(!state.pending.length&&!this.blocked.has(id)&&!this.emergencyDrafts.has(id)){
    const own=this.ownJournalIDs.get(id);if(own)this.journal.removeOwn(userId,id,own);
    const consumed=this.recoveredJournalVersions.get(id)??[];for(const record of consumed)this.journal.markResolved(record);this.recoveredJournalVersions.delete(id);
    this.journalRecords.set(id,(this.journalRecords.get(id)??[]).filter(row=>row.id!==own&&!consumed.some(record=>record.id===row.id&&this.envelopeFingerprint(record)===this.envelopeFingerprint(row))));
    this.journalFingerprints.delete(id);this.draftFingerprints.delete(id);this.exportedFingerprints.delete(id);this.recoveryStatus.set(id,{persistence:'none',generation:previous.generation});
   }else{
    const envelope=this.draftEnvelope(id,state),fingerprint=this.envelopeFingerprint(envelope),changed=this.draftFingerprints.get(id)!==fingerprint;
    if(changed){this.draftFingerprints.set(id,fingerprint);this.exportedFingerprints.delete(id);this.recoveryStatus.set(id,{...previous,generation:previous.generation+1});}
    if(this.journalFingerprints.get(id)!==fingerprint||previous.persistence!=='saved'){
     let key=this.ownJournalIDs.get(id);if(!key){key=randomUuid();this.ownJournalIDs.set(id,key);}
     const record=this.journal.write(envelope,key),rows=this.journalRecords.get(id)??[];this.journalRecords.set(id,[record,...rows.filter(row=>row.id!==key)]);this.journalFingerprints.set(id,fingerprint);
    }
    this.recoveryStatus.set(id,envelope.unresolvedMedia?{persistence:'memory-only',generation:this.recoveryStatus.get(id)?.generation??previous.generation,error:'文字和节点信息可恢复，但有尚未上传的本地素材仅在原页面可用。请先完成上传或下载草稿备份，不要刷新或关闭。'}:{persistence:'saved',generation:this.recoveryStatus.get(id)?.generation??previous.generation});
   }
   this.notifyDraft(id);return this.recoveryStatus.get(id)?.persistence!=='memory-only';
  }catch{
   this.recoveryStatus.set(id,{persistence:'memory-only',generation:this.recoveryStatus.get(id)?.generation??previous.generation,error:'本地备份未能保存（空间不足或浏览器禁止存储）。当前修改仍在本页，请先下载草稿备份，不要刷新或关闭。'});this.notifyDraft(id);return false;
  }
 }
 captureDraft(id:string,native:NativeGraph){
  if(this.operationSessions.has(id)){try{if(this.operationNeedsPreparation(id,native)){this.emergencyDrafts.set(id,{userId:this.identity?.()??'',graph:structuredClone(native)});this.notifyDraft(id);}else this.observeOperationGraph(id,native);}catch(error){this.operationErrors.set(id,error instanceof Error?error.message:'当前素材尚未完成上传。');this.emergencyDrafts.set(id,{userId:this.identity?.()??'',graph:structuredClone(native)});this.notifyDraft(id);}return;}
  try{const hadEmergency=this.emergencyDrafts.delete(id),changed=this.observeNativeDraft(id,native);const state=this.drafts.get(id);if(state&&(!changed||hadEmergency))this.persistDraftState(id,state);}
  catch{
   const userId=this.identity?.();if(!userId||this.draftOwners.get(id)!==userId)return;
   let retained=native;try{retained=structuredClone(native);}catch{try{retained=JSON.parse(JSON.stringify(native));}catch{/* The live graph remains the last recovery source. */}}
   this.emergencyDrafts.set(id,{userId,graph:retained});const state=this.drafts.get(id);if(state)this.persistDraftState(id,state);
   const prior=this.recoveryStatus.get(id);this.recoveryStatus.set(id,{persistence:'memory-only',generation:prior?.generation??0,error:'当前修改尚未完整备份，仍保留在本页。请完成素材上传或下载草稿备份，不要刷新、退出或关闭。'});this.notifyDraft(id);
  }
 }
 refreshDraftBackups(id:string){
  const userId=this.identity?.();if(!userId||!this.journal){this.journalRecords.delete(id);this.notifyDraft(id);return;}
  try{this.journalRecords.set(id,this.journal.list(userId,id));}
  catch{const prior=this.recoveryStatus.get(id);this.recoveryStatus.set(id,{persistence:'memory-only',generation:prior?.generation??0,error:'无法读取本地草稿备份，原记录未删除。请先下载仍在本页的草稿备份。'});}
  this.notifyDraft(id);
 }
 draftRecoveryState(id:string):DraftRecoveryState {
  const operations=this.operationSessions.get(id);if(operations){const status=operations.status();return{projectId:id,blocked:this.operationErrors.has(id),busy:this.queues.has(id),persistence:status.storageError||this.emergencyDrafts.has(id)||operations.hasPending()&&!this.operationJournals.has(id)?'memory-only':operations.hasPending()?'saved':'none',error:status.storageError||this.operationErrors.get(id),generation:status.generation,conflicts:[],backups:[]};}
  const userId=this.identity?.(),own=!this.identity||this.draftOwners.get(id)===userId,state=own?this.drafts.get(id):undefined,status=own?this.recoveryStatus.get(id):undefined;
  return{projectId:id,blocked:own&&this.blocked.has(id),...(own&&this.blocked.get(id)?{blockedReason:this.blocked.get(id)!.reason}:{}),...(own&&this.retryableErrors.has(id)?{retryableError:structuredClone(this.retryableErrors.get(id)!)}:{}),busy:own&&this.recoveryBusy.has(id),persistence:status?.persistence??'none',...(status?.error?{error:status.error}:{}),generation:status?.generation??0,conflicts:structuredClone(state?.conflicts??[]),backups:(this.journalRecords.get(id)??[]).filter(row=>row.userId===userId).map(row=>({id:row.id,updatedAt:row.updatedAt,nodeCount:row.graph.nodes.length,unknownBase:!row.base||row.pending?.some(entry=>entry.requiresBaseDecision||entry.unknownBase)===true,currentPage:row.id===this.ownJournalIDs.get(id)}))};
 }
 draftConflictDetails(id:string):DraftConflictDetail[]{if(this.identity&&this.draftOwners.get(id)!==this.identity())return[];const state=this.drafts.get(id);return state?.graph&&state.ack?conflictDetails(state.conflicts,state.graph,state.ack.graph):[];}
 exportDraft(id:string,backupId?:string):string {
  const userId=this.identity?.(),record=backupId?this.journalRecords.get(id)?.find(row=>row.id===backupId&&row.userId===userId):undefined;
  if(backupId){if(!record)throw new ApiError(404,'DRAFT_NOT_FOUND','该本地备份不可用。');return JSON.stringify(parseDraftEnvelope(record,userId!,id),null,2);}
  const state=this.drafts.get(id);if(!state||!state.ack&&!state.pending.length){const latest=this.journalRecords.get(id)?.find(row=>row.userId===userId);if(latest)return JSON.stringify(parseDraftEnvelope(latest,userId!,id),null,2);throw new ApiError(409,'DRAFT_NOT_FOUND','本页没有可导出的画布。');}
  const envelope=this.draftEnvelope(id,state);this.exportedFingerprints.set(id,this.envelopeFingerprint(envelope));return JSON.stringify(envelope,null,2);
 }
 private requireDraftBackup(id:string,state:CanvasDraft,exportedBackup=false){
  if(!state.pending.length&&!this.blocked.has(id)&&!this.emergencyDrafts.has(id))return;
  const envelope=this.draftEnvelope(id,state),exported=exportedBackup&&this.exportedFingerprints.get(id)===this.envelopeFingerprint(envelope);
  if(!this.persistDraftState(id,state)&&!exported)throw new ApiError(409,'DRAFT_BACKUP_UNAVAILABLE','本地备份尚未成功。请先下载当前草稿备份，再明确继续恢复。');
 }
 private archiveCurrentDraft(id:string,state:CanvasDraft){
  // Rotate the working key before any recovery mutation. Its preceding bytes
  // remain an immutable rescue point even if this page crashes during CAS.
  if(!state.pending.length&&!this.blocked.has(id)&&!this.emergencyDrafts.has(id))return;
  const own=this.ownJournalIDs.get(id),row=this.journalRecords.get(id)?.find(record=>record.id===own);
  if(row&&this.envelopeFingerprint(row)===this.envelopeFingerprint(this.draftEnvelope(id,state))){
   this.recoveredJournalVersions.set(id,[...this.recoveredJournalVersions.get(id)??[],row]);this.ownJournalIDs.delete(id);this.journalFingerprints.delete(id);
  }
 }
 private async latestDraftSnapshot(id:string,epoch:number,state:CanvasDraft){
  if(this.identity)await this.refreshAccess(id,true);this.requireEpoch(epoch);this.requireCanvas(id,state);this.requirePermission(id);
  const response=await this.api.request<Snapshot>('/projects/'+encodeURIComponent(id)+'/snapshot');this.requireEpoch(epoch);this.requireCanvas(id,state);this.requirePermission(id);
  this.acceptRemoteSnapshot(id,response.data,response.etag);return response;
 }
 private recoverEntries(envelope:DraftEnvelope):PendingSave[]{
  if(envelope.pending?.length)return envelope.pending.map(entry=>({...structuredClone(entry),unknownBase:false,...(entry.unknownBase||entry.requiresBaseDecision?{requiresBaseDecision:true}:{}),phase:'DRAFT'}));
  const unknown=!envelope.base;return[{base:envelope.base??{nodes:[],edges:[]},local:envelope.graph,initialEtag:envelope.baseRevision?'"'+envelope.baseRevision+'"':'unknown',unknownBase:false,...(unknown?{requiresBaseDecision:true}:{}),phase:'DRAFT'}];
 }
 private async restoreEnvelope(id:string,envelope:DraftEnvelope,options:{exportedBackup?:boolean}={}):Promise<{graph:NativeGraph;conflicts:DraftConflict[]}>{
  const epoch=this.epoch,state=this.canvas(id);if(this.emergencyDrafts.has(id))throw new ApiError(409,'DRAFT_MEDIA_PENDING','当前页面还有尚未上传的素材，请先完成上传或替换；当前文字和节点仍保留。');this.requireDraftBackup(id,state,options.exportedBackup);this.archiveCurrentDraft(id,state);
  let answer:DraftMerge|undefined;
  await this.serialize(id,epoch,async()=>{
   this.recoveryBusy.add(id);this.notifyDraft(id);
   try{
    const incoming=this.recoverEntries(envelope);await this.latestDraftSnapshot(id,epoch,state);
    // Keep edits made in this page while the snapshot was loading. Incoming
    // differences replay first; existing current-page differences replay last.
    state.pending=[...incoming,...state.pending];state.unqueued=undefined;state.coalesced=undefined;
    answer=this.rebuildDraft(id,state);
    this.persistDraftState(id,state);
   }finally{this.recoveryBusy.delete(id);this.notifyDraft(id);}
  });
  const result=answer!;return{graph:this.restoreModelBindings(id,this.nativeView(id,result.graph)),conflicts:result.conflicts};
 }
 async restoreDraft(id:string,backupId:string,options:{exportedBackup?:boolean}={}){
  const userId=this.identity?.();if(!userId)throw new ApiError(401,'SESSION_CHANGED','请先登录原账号。');
  const shown=this.journalRecords.get(id)?.find(row=>row.id===backupId);this.refreshDraftBackups(id);
  const record=this.journalRecords.get(id)?.find(row=>row.id===backupId&&row.userId===userId);
  if(!record)throw new ApiError(404,'DRAFT_NOT_FOUND','该备份已不可用，其他备份和当前草稿未删除。');
  if(shown&&this.envelopeFingerprint(shown)!==this.envelopeFingerprint(record))throw new ApiError(409,'DRAFT_BACKUP_CHANGED','备份来源页面仍在修改，请重新查看备份后再选择。');
  const result=await this.restoreEnvelope(id,record,options);this.recoveredJournalVersions.set(id,[...this.recoveredJournalVersions.get(id)??[],record]);return result;
 }
 async importDraft(id:string,text:string,options:{exportedBackup?:boolean}={}){
  const userId=this.identity?.();if(!userId)throw new ApiError(401,'SESSION_CHANGED','请先登录原账号。');
  let envelope:DraftEnvelope;try{if(text.length>32*1024*1024)throw new Error();envelope=parseDraftEnvelope(text,userId,id);}catch{throw new ApiError(422,'DRAFT_IMPORT_INVALID','备份格式、账号或项目不匹配。当前草稿和服务器内容均未改变。');}
  // Keep the imported file as a separate immutable backup before rebasing it.
  let imported:DraftJournalRecord|undefined;
  if(this.journal){try{imported=this.journal.write(envelope,randomUuid());this.journalRecords.set(id,[imported,...this.journalRecords.get(id)??[]]);}catch{if(!options.exportedBackup)throw new ApiError(409,'DRAFT_BACKUP_UNAVAILABLE','无法保存导入备份。请保留原备份文件，再明确继续恢复。');}}
  const result=await this.restoreEnvelope(id,envelope,options);if(imported)this.recoveredJournalVersions.set(id,[...this.recoveredJournalVersions.get(id)??[],imported]);return result;
 }
 async resolveDraft(id:string,choices:Record<string,DraftChoice>,options:{exportedBackup?:boolean}={}):Promise<NativeGraph>{
  const epoch=this.epoch,state=this.canvas(id);if(this.emergencyDrafts.has(id)||state.graph&&this.unresolvedMediaCount(state.graph))throw new ApiError(409,'DRAFT_MEDIA_PENDING','草稿包含尚未上传的本地素材，请先上传或替换，再同步。');this.requireDraftBackup(id,state,options.exportedBackup);this.archiveCurrentDraft(id,state);let result:NativeGraph|undefined;
  await this.serialize(id,epoch,async()=>{
   this.recoveryBusy.add(id);this.notifyDraft(id);
   try{
    const shown=this.draftConflictDetails(id);
    await this.latestDraftSnapshot(id,epoch,state);const current=this.draftConflictDetails(id);
    if(this.blocked.get(id)?.reason==='CAS_UNCERTAIN')throw new ApiError(409,'DRAFT_REMOTE_CHANGED','服务器尚未返回可确认的最新版本。当前草稿和备份均保留，请等待同步后重试。');
    if(!sameConflictValues(shown,current))throw new ApiError(409,'DRAFT_REMOTE_CHANGED','服务器或本地内容刚有新变化，请查看更新后的冲突再选择。');
    this.requireDraftBackup(id,state,options.exportedBackup);this.archiveCurrentDraft(id,state);
    // A concurrent edit is retained as a pending descendant rather than being
    // replaced by choices made for the previous local graph.
    const target=this.canonical(resolveDraftGraph(state.graph??state.ack!.graph,state.ack!.graph,state.conflicts,choices));
    const prior=[...state.pending],resolved:PendingSave={base:structuredClone(state.ack!.graph),local:target,initialEtag:state.ack!.etag,unknownBase:false,phase:'IN_FLIGHT'};
    const basisRevision=state.ack!.revision;let responseRevision:number|undefined;this.retryableErrors.delete(id);
    state.pending=[resolved];state.unqueued=undefined;state.coalesced=undefined;this.blocked.delete(id);this.rebuildDraft(id,state);
    try{
     this.requirePermission(id);await this.prepareGraph(target);await this.prepareProjectAssets(id,state,resolved,epoch);this.requireEpoch(epoch);this.requireCanvas(id,state);this.requirePermission(id);
     const response=await this.api.request<Snapshot>('/projects/'+encodeURIComponent(id)+'/snapshot',{method:'PUT',body:{graph:encodeGraph(resolved.local,this.encodeAsset)},etag:resolved.initialEtag});this.requireEpoch(epoch);this.requireCanvas(id,state);
     responseRevision=this.responseProofRevision(id,response);
     state.pending=state.pending.filter(entry=>entry!==resolved);this.acceptSnapshot(id,response.data,response.etag,false);
     this.retryableErrors.delete(id);
     this.persistDraftState(id,state);result=state.graph??state.ack!.graph;
    }catch(error){
     const descendants=state.pending.filter(entry=>entry!==resolved);state.pending=[...prior,...descendants];state.unqueued=undefined;
     if(error instanceof ApiError&&error.code==='NODE_EDIT_OCCUPIED')this.retryableErrors.set(id,{code:'NODE_EDIT_OCCUPIED',message:error.message});
     else if(error instanceof ApiError&&error.code==='SNAPSHOT_REVISION_MISMATCH')this.blockUncertain(id,state,Math.max(basisRevision,responseRevision??0),responseRevision===undefined);
     else this.blockUncertain(id,state,basisRevision,error instanceof ApiError&&error.status===412);
     this.rebuildDraft(id,state);
     if(error instanceof ApiError&&error.status===412){await this.latestDraftSnapshot(id,epoch,state);throw new ApiError(409,'DRAFT_REMOTE_CHANGED','保存前服务器又有新修改。草稿和备份均保留，请查看更新后的冲突再确认。');}
     throw error;
    }
   }finally{this.recoveryBusy.delete(id);this.notifyDraft(id);}
  });
  return this.restoreModelBindings(id,this.nativeView(id,result!));
 }
 draft(id:string){if(this.identity&&this.draftOwners.get(id)!==this.identity())return;const emergency=this.emergencyDrafts.get(id);if(emergency&&emergency.userId===this.identity?.())return structuredClone(emergency.graph);const operations=this.operationSessions.get(id);if(operations)return operations.hasPending()?this.operationGraph(id,operations):undefined;const state=this.drafts.get(id);return state?.graph&&(state.pending.length||this.blocked.has(id))?this.nativeView(id,state.graph):undefined;}
 discardDraft(id:string){if(this.queues.has(id))throw new ApiError(409,'SAVE_PENDING','请等待当前保存结束后再舍弃草稿。');const state=this.drafts.get(id);if(state){state.pending=[];state.unqueued=undefined;state.coalesced=undefined;state.conflicts=[];state.graph=state.ack?.graph;state.observed=state.ack&&structuredClone(state.ack.graph);this.localModelSelections.delete(id);if(state.ack){this.modelBindings.reconcile(id,state.ack.graph);for(const node of state.ack.graph.nodes)if(node.data?.capabilityVersion!==undefined)this.modelBindings.record(id,node,{});}}this.blocked.delete(id);this.retryableErrors.delete(id);this.emergencyDrafts.delete(id);if(state)this.persistDraftState(id,state);this.notifyDraft(id);}
 modelBindingPort(id:string,isCurrent:()=>boolean):NativeModelBindingPort{
  let port=this.modelPorts.get(id);if(!port){const epoch=this.epoch;port={current:()=>epoch===this.epoch&&isCurrent(),node:node=>epoch===this.epoch?this.modelBindings.node(id,node):node,record:(node,patch)=>{this.requireEpoch(epoch);this.requirePermission(id);if(!isCurrent())throw new ApiError(409,'STALE_CANVAS_SESSION','画布已切换，请重新选择模型。');this.rememberModelBinding(id,node,patch);}};this.modelPorts.set(id,port);}return port;
 }
 private async historicalModel(id:string,node:any,read:(path:string)=>Promise<any>,check:()=>void):Promise<Capability|undefined>{
  const {taskId,modelCode}=node.data;
  const receipt=await read('/tasks/'+encodeURIComponent(taskId));check();
  if(!receipt)return;
  if(receipt.id!==taskId||receipt.projectId!==id||!Array.isArray(receipt.plans))throw new HistoricalModelMismatch('历史任务与当前作品不一致，不能确认模型版本。');
  const matches=receipt.plans.filter((plan:any)=>plan?.nodeId===node.id&&!plan.historyDeletedAt);
  if(matches.length>1)throw new HistoricalModelMismatch('历史任务包含重复的节点计划。');
  const plan=matches[0];
  if(!plan||plan.capabilityRef!==modelCode)return;
  if(typeof plan.capabilityVersion!=='string'||!plan.capabilityVersion.trim()||plan.capabilityVersion.length>100)throw new HistoricalModelMismatch('历史任务缺少可验证的模型版本。');
  const cap=await read('/model-capability-version?'+new URLSearchParams({ref:plan.capabilityRef,version:plan.capabilityVersion}));check();
  if(!cap||cap.capabilityRef!==plan.capabilityRef||cap.version!==plan.capabilityVersion||typeof cap.parameterSchemaVersion!=='string'||!cap.parameterSchemaVersion.trim())throw new HistoricalModelMismatch('历史模型版本响应不一致。');
  return cap;
 }
 private async recoverModelBindings(id:string,graph:NativeGraph,epoch:number,signal?:AbortSignal){
  const requests=new Map<string,Promise<any>>();
  const read=(path:string)=>{
   let pending=requests.get(path);
   if(!pending){
    pending=canvasRequestDeadline(signal,(request,onReadProgress)=>(this.api as ProductClient).requestV2(path,{signal:request,onReadProgress})).then(r=>r.data).catch(error=>{
     if(path.startsWith('/tasks/')&&error instanceof ApiError&&error.status===404)return null;
     throw error;
    });
    requests.set(path,pending);
   }
   return pending;
  };
  const nodes=await Promise.all(graph.nodes.map(async node=>{
   const data=node.data||{};if(data.capabilityVersion!==undefined||!data.taskId||!data.modelCode)return node;
   const cap=await this.historicalModel(id,node,read,()=>this.requireEpoch(epoch));
   return cap?{...node,data:{...data,capabilityRef:cap.capabilityRef,capabilityVersion:cap.version,parameterSchemaVersion:cap.parameterSchemaVersion}}:node;
  }));return{...graph,nodes};
 }
 async historicalGenerationModel(id:string,node:any):Promise<Capability|undefined>{
  const data=node.data||{},snapshot=this.snapshots.get(id);
  if(!this.canvasMediaScopes.has(id)||!snapshot||data.capabilityVersion!==undefined||data.params?.capabilityVersion!==undefined)return;
  const stored=snapshot.graph.nodes.find(item=>item.id===node.id&&item.type===node.type),receipt=stored?.data;
  if(!stored||!receipt?.modelCode||!receipt.taskId||receipt.capabilityVersion!==undefined||(data.capabilityRef??data.modelCode)!==receipt.modelCode||data.modelCode&&data.modelCode!==receipt.modelCode)return;
  const state=this.drafts.get(id),epoch=this.epoch,actor=this.identity?.(),selection=this.localModelSelections.get(id)?.get(node.id);
  const changed=()=>new ApiError(409,'STALE_EXECUTION_INPUT','此节点的模型选择已更新，请用当前选择重新生成。');
  if(data.taskId&&data.taskId!==receipt.taskId)throw changed();
  const check=()=>{
   this.requireEpoch(epoch);
   if(this.identity?.()!==actor||this.drafts.get(id)!==state)throw new ApiError(409,'STALE_CANVAS_SESSION','画布已切换，请在当前画布继续。');
   const current=this.snapshots.get(id)?.graph.nodes.find(item=>item.id===node.id&&item.type===node.type)?.data;
   if(!current||current.taskId!==receipt.taskId||current.modelCode!==receipt.modelCode||current.capabilityVersion!==receipt.capabilityVersion||this.localModelSelections.get(id)?.get(node.id)!==selection)throw changed();
  };
  let cache=this.historicalChecks.get(snapshot);
  if(!cache){cache=new Map();this.historicalChecks.set(snapshot,cache);}
  let pending=cache.get(node.id);
  if(!pending){
   const ctl=new AbortController();this.projectReadControllers.add(ctl);
   pending=this.historicalModel(id,stored,path=>canvasRequestDeadline(ctl.signal,(signal,onReadProgress)=>(this.api as ProductClient).requestV2(path,{signal,onReadProgress})).then(r=>r.data),check).finally(()=>this.projectReadControllers.delete(ctl));
   cache.set(node.id,pending);
  }
  try{
   const cap=await pending;check();
   if(!cap||typeof cap.available!=='boolean'||!cap.kind||!cap.parameterSchema||typeof cap.parameterSchema!=='object'||Array.isArray(cap.parameterSchema))throw new Error('incomplete historical capability');
   return cap;
  }catch(error){
   if(cache.get(node.id)===pending)cache.delete(node.id);
   check();
   if(error instanceof ApiError&&[401,403].includes(error.status))throw error;
   if(!(error instanceof HistoricalModelMismatch)&&transientCanvasSaveFailure(error))throw withPreflightContext(error instanceof ApiError?error:new ApiError(503,'GENERATION_PREFLIGHT_UNAVAILABLE','模型信息暂时无法读取，恢复连接后将自动重新检查。'),{capabilityRef:String(receipt.modelCode),issues:[{field:'model.kind',reason:'METADATA_MISSING',component:'MODEL',sourceNodeId:node.id}]});
   throw withPreflightContext(new ApiError(422,'MODEL_VERSION_UNVERIFIED','无法确认此节点上次生成使用的模型版本，请重试，或在此节点重新选择模型。',error instanceof ApiError?error.requestId:undefined),{capabilityRef:String(receipt.modelCode),issues:[{field:'model.kind',reason:'MODEL_VERSION_CHANGED',sourceNodeId:node.id}]});
  }
 }
 private registerAsset(asset:Asset):Asset {
  const prior=this.assets.get(asset.id),checksum=asset.checksumSha256;
  // Every caller has fetched fresh authorized metadata. Keep a still-valid
  // grant for unchanged bytes so canvas sync does not restart the player.
  const reusable=prior?.state==='READY'&&asset.state==='READY'&&prior.kind===asset.kind&&prior.mimeType===asset.mimeType&&typeof checksum==='string'&&/^[a-f0-9]{64}$/.test(checksum)&&checksum===prior.checksumSha256&&!!(prior.downloadUrl||prior.previewUrl)&&Date.parse(prior.urlsExpireAt??'')>Date.now()+60000;
  const registered=reusable?{...asset,downloadUrl:prior.downloadUrl,previewUrl:prior.previewUrl,urlsExpireAt:prior.urlsExpireAt}:asset;
  this.assets.set(asset.id,registered);for(const url of [registered.downloadUrl,registered.previewUrl])if(url){this.reverseUrls.set(url,asset.id);try{this.reverseUrls.set(new URL(url,globalThis.location?.origin||'http://localhost').href,asset.id);}catch{}}
  return registered;
 }
 encodeAsset=(value:string)=>{
  const direct=this.reverseUrls.get(value);if(direct)return'rhtv-asset:'+direct;
  const key=nativeMediaKey(value),assetId=key&&this.reverseUrls.get(key[2]);return key&&assetId?key[1]+'::rhtv-asset:'+assetId:value;
 };
 // Stable, same-origin media addresses are projected only into the native
 // view. The operation journal, history selection and generation still use IDs.
 private displayCanvasAsset(projectId:string,value:string):string {
  const scope=this.canvasMediaScopes.get(projectId);if(!scope)return this.decodeAsset(value);
  const key=nativeMediaKey(value),ref=key?key[2]:value;
  if(!ref.startsWith('rhtv-asset:'))return value;
  const id=ref.slice(11);if(!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id))return value;
  const path='/storage/canvas-media/'+scope+'/'+id,url=new URL(path,globalThis.location?.origin||'http://localhost').href;
  this.reverseUrls.set(path,id);this.reverseUrls.set(url,id);
  return key?key[1]+'::'+url:url;
 }
 decodeAsset=(value:string)=>{
  if(value.startsWith('rhtv-asset:'))return this.assets.get(value.slice(11))?.downloadUrl||this.assets.get(value.slice(11))?.previewUrl||'';
  const key=nativeMediaKey(value);if(!key||!/^rhtv-asset:[A-Za-z0-9_-]{1,200}$/.test(key[2]))return value;
  const asset=this.assets.get(key[2].slice(11)),url=asset?.downloadUrl||asset?.previewUrl;return url?key[1]+'::'+url:value;
 };
 registerCatalogMedia=(url:string,reference:CatalogMediaReference)=>{if(url&&Number.isSafeInteger(reference.revision)&&reference.revision>0)this.catalogMedia.set(url,{...reference});};
 async prepareGraph(graph:NativeGraph,onProgress?:()=>void){const urls=new Set<string>();const inspect=(value:any)=>{if(typeof value==='string'&&this.catalogMedia.has(value)&&!this.reverseUrls.has(value))urls.add(value);else if(Array.isArray(value))value.forEach(inspect);else if(value&&typeof value==='object')for(const[key,item]of Object.entries(value))if(key!=='presetSelections')inspect(item);};inspect(graph);await Promise.all([...urls].map(value=>this.resolveAsset(value,onProgress)));}
 async resolveAsset(reference:string,onProgress?:()=>void):Promise<Asset>{
  if(!onProgress)return this.resolveAssetNow(reference);
  const key=this.assetProgressKey(reference);let listeners=this.assetProgress.get(key);if(!listeners){listeners=new Set();this.assetProgress.set(key,listeners);}listeners.add(onProgress);
  try{return await this.resolveAssetNow(reference);}finally{listeners.delete(onProgress);if(!listeners.size&&this.assetProgress.get(key)===listeners)this.assetProgress.delete(key);}
 }
 private async resolveAssetNow(reference:string):Promise<Asset>{
  const epoch=this.epoch;
  const key=this.assetProgressKey(reference),progress=()=>{for(const callback of this.assetProgress.get(key)??[])callback();};
  if(this.catalogMedia.has(reference)&&!this.reverseUrls.has(reference)){
   let pending=this.materializing.get(reference);if(!pending){pending=(async()=>{
    const key='catalog:'+reference,idempotencyKey=this.assetRequestKey(key);
    const result=(await canvasRequestDeadline(undefined,(signal,onReadProgress)=>(this.api as ProductClient).requestV2<{asset:Asset}>('/catalog/media/materialize',{method:'POST',body:this.catalogMedia.get(reference),idempotencyKey,signal,onReadProgress}),progress,60000)).data;
    this.requireEpoch(epoch);if(result.asset?.state!=='READY')throw new ApiError(409,'ASSET_NOT_READY','目录素材尚未就绪。');this.registerAsset(result.asset);this.reverseUrls.set(reference,result.asset.id);this.assetRequestKeys.delete(key);return result.asset;
   })();this.materializing.set(reference,pending);pending.finally(()=>{if(this.materializing.get(reference)===pending)this.materializing.delete(reference);}).catch(()=>{});}
   await pending;this.requireEpoch(epoch);
  }
  const canonical=this.encodeAsset(reference);
  const assetId=canonical.startsWith('rhtv-asset:')?canonical.slice(11):/^[A-Za-z0-9_-]{1,200}$/.test(canonical)?canonical:null;
  if(!assetId)throw new ApiError(422,'ASSET_REFERENCE_REQUIRED','请先上传或选择 STUDIO 素材，再执行此操作。');
  const lookupProgress=()=>{progress();if(key!=='asset:'+assetId)for(const callback of this.assetProgress.get('asset:'+assetId)??[])callback();};
  this.requireEpoch(epoch);
  let pending=this.resolvingAssets.get(assetId);
  if(!pending){
   pending=(async()=>{try{
    const asset=(await canvasRequestDeadline(undefined,(signal,onReadProgress)=>this.api.request<Asset>('/assets/'+encodeURIComponent(assetId),{signal,onReadProgress}),lookupProgress)).data;this.requireEpoch(epoch);
    if(asset.id!==assetId)throw new ApiError(502,'INVALID_RESPONSE','服务器返回了不一致的素材标识。');
    if(asset.state!=='READY')throw new ApiError(409,'ASSET_NOT_READY','素材尚未就绪。');
    return this.registerAsset(asset);
   }catch(error){this.requireEpoch(epoch);throw error;}})();
   this.resolvingAssets.set(assetId,pending);
   const current=pending;void current.finally(()=>{if(this.resolvingAssets.get(assetId)===current)this.resolvingAssets.delete(assetId);}).catch(()=>{});
  }
  const asset=await pending;this.requireEpoch(epoch);return asset;
 }
 private waitForProject<T>(loading:Promise<T>,signal?:AbortSignal):Promise<T>{
  if(!signal)return loading;
  if(signal.aborted)return Promise.reject(new DOMException('项目请求已取消。','AbortError'));
  return new Promise<T>((resolve,reject)=>{
   const aborted=()=>{signal.removeEventListener('abort',aborted);reject(new DOMException('项目请求已取消。','AbortError'));};
   signal.addEventListener('abort',aborted,{once:true});
   loading.then(value=>{signal.removeEventListener('abort',aborted);resolve(value);},error=>{signal.removeEventListener('abort',aborted);reject(error);});
  });
 }
 loadProject(id:string,options:{signal?:AbortSignal}={}):Promise<Project>{
  if(options.signal?.aborted)return Promise.reject(new DOMException('项目请求已取消。','AbortError'));
  let loading=this.loadingProjects.get(id);
  if(!loading){
   // Navigation shares a same-identity fill; canceling one route only cancels
   // its waiter. Identity cleanup still fences every late server response.
   loading=this.loadProjectFresh(id);this.loadingProjects.set(id,loading);
   const current=loading;void current.finally(()=>{if(this.loadingProjects.get(id)===current)this.loadingProjects.delete(id);}).catch(()=>{});
  }
  return this.waitForProject(loading,options.signal);
 }
 forgetProjectPreview(id:string){this.projectPreviews.delete(id);this.previewGenerations.set(id,(this.previewGenerations.get(id)??0)+1);}
 async loadProjectPreviews(ids:string[],options:{signal?:AbortSignal}={}):Promise<Map<string,ProjectPreview>>{
  projectPreviewIds(ids);if(!ids.length)return new Map();
  const epoch=this.epoch,identityId=this.identity?.()??'',generations=ids.map(id=>this.previewGenerations.get(id)??0),controller=new AbortController(),abort=()=>controller.abort();
  if(options.signal?.aborted)abort();else options.signal?.addEventListener('abort',abort,{once:true});this.previewRequests.add(controller);
  try{
   if(controller.signal.aborted)throw new DOMException('项目预览已取消。','AbortError');
   const result=await(this.api as ProductClient).requestV2('/project-previews/query',{method:'POST',body:{projectIds:ids},signal:controller.signal});
   this.requireEpoch(epoch);if(controller.signal.aborted)throw new DOMException('项目预览已取消。','AbortError');
   if(this.identity&&(!identityId||this.identity()!==identityId))throw new ApiError(401,'SESSION_CHANGED','登录状态已变更。');
   const previews=projectPreviewPage(result.data,ids);
   if(ids.some((id,index)=>(this.previewGenerations.get(id)??0)!==generations[index]))throw new ApiError(409,'PROJECT_PREVIEW_CHANGED','项目已更新，请重新加载列表。');
   for(const preview of previews){const prior=this.projectPreviews.get(preview.project.id);if(prior&&prior.project.revision>preview.project.revision)throw new ApiError(409,'PROJECT_PREVIEW_CHANGED','项目预览版本已更新，请重新加载列表。');}
   for(const preview of previews)this.projectPreviews.set(preview.project.id,preview);
   return new Map(previews.map(value=>[value.project.id,value]));
  }catch(error){this.requireEpoch(epoch);throw error;}
  finally{options.signal?.removeEventListener('abort',abort);this.previewRequests.delete(controller);}
 }
 // The shared read owns an inactivity deadline. A large snapshot that keeps
 // delivering bytes must not restart at a fixed wall-clock limit. Navigation
 // cancels one waiter; logout or inactivity cancels the actual body reads.
 private async readProjectEnvelope(id:string){
  const controller=new AbortController();
  this.projectReadControllers.add(controller);
  const path='/projects/'+encodeURIComponent(id);
  try{
   return await canvasRequestDeadline(controller.signal,(signal,onReadProgress)=>Promise.all([
    this.api.request<Project>(path,{signal,onReadProgress}),
    this.api.request<Snapshot>(path+'/snapshot',{signal,onReadProgress,headers:{'X-STUDIO-Canvas-Media':'lazy-v1'}}),
    this.identity?this.refreshAccess(id):Promise.resolve(undefined),
   ]).catch(error=>{controller.abort(error);throw error;}),undefined,20_000);
  }catch(error){
   const failure=error instanceof ApiError&&error.code==='CANVAS_REQUEST_TIMEOUT'?new ApiError(504,'CANVAS_OPEN_TIMEOUT','读取画布超时，请稍后重试。'):error;
   controller.abort(failure);throw failure;
  }finally{this.projectReadControllers.delete(controller);}
 }
 private async loadProjectFresh(id:string){
  const epoch=this.epoch,state=this.canvas(id);
  const [project,snapshot,access]=await this.readProjectEnvelope(id);
  this.requireEpoch(epoch);this.requireCanvas(id,state);
  if(access&&access.ownerId!==project.data.ownerId){this.invalidateAccess(id);throw new ApiError(502,'INVALID_PROJECT_ACCESS','项目归属与权限响应不一致。');}
  const savedGraph=decodeGraph(snapshot.data.graph);
  let recovered=savedGraph;
  if(snapshot.canvasMediaScope)this.canvasMediaScopes.set(id,snapshot.canvasMediaScope);
  else {
   this.canvasMediaScopes.delete(id);
   // Old services resolve media and model bindings after the initial envelope.
   // They need their own cancellable, progressing reads too; otherwise the
   // shared load promise can stay pending forever and prevent every retry.
   const controller=new AbortController();this.projectReadControllers.add(controller);
   try{
    recovered=await this.recoverModelBindings(id,savedGraph,epoch,controller.signal);this.requireEpoch(epoch);this.requireCanvas(id,state);
    const references=assetReferences(snapshot.data.graph);
    if(project.data.coverAssetId)references.add(project.data.coverAssetId);
    await Promise.all([...references].map(async assetId=>{
     const asset=(await canvasRequestDeadline(controller.signal,(signal,onReadProgress)=>this.api.request<Asset>('/assets/'+encodeURIComponent(assetId),{signal,onReadProgress}))).data;
     this.requireEpoch(epoch);this.requireCanvas(id,state);this.registerAsset(asset);
    }));
   }catch(error){controller.abort(error);this.requireEpoch(epoch);throw error;}
   finally{this.projectReadControllers.delete(controller);}
  }
  this.requireEpoch(epoch);this.requireCanvas(id,state);
  // Verified legacy bindings stay in sidecars. Raw receipts remain unchanged
  // in snapshots; draft comparison excludes only reviewed local region tools.
  const previous=this.drafts.get(id);if(!previous?.observed)this.modelBindings.seed(id,recovered);
  const current=this.projects.get(id);if(!current||current.revision<=project.data.revision)this.projects.set(id,project.data);
  this.acceptRemoteSnapshot(id,snapshot.data,snapshot.etag);
  return this.projects.get(id)!;
 }
 async list(query:Record<string,any>){
  const epoch=this.epoch;
  if(query.folderId||query.queryScope==='FOLDER')throw new ApiError(501,'PROJECT_FOLDERS_UNAVAILABLE','项目文件夹服务尚未接入。');
  const nativeSort=query.querySortBy?String(query.querySortBy)+'_'+String(query.querySortOrder||'DESC'):undefined;
  const sort=nativeSort?({UPDATE_TIME_DESC:'UPDATED_DESC',CREATE_TIME_DESC:'CREATED_DESC',NAME_ASC:'NAME_ASC'} as Record<string,string>)[nativeSort]:query.sort||'UPDATED_DESC';
  if(!sort)throw new ApiError(501,'PROJECT_SORT_UNAVAILABLE','此项目排序尚未接入。');
  const search=new URLSearchParams({page:String(query.page||query.current||1),pageSize:String(query.size||20),sort});if(query.keyword)search.set('q',String(query.keyword));
  const result=(await this.api.request<Page<Project>>('/projects?'+search)).data;
  this.requireEpoch(epoch);
  const previews=await this.loadProjectPreviews(result.items.map(project=>project.id));
  this.requireEpoch(epoch);
  return{records:result.items.map(project=>nativeProjectPreview(previews.get(project.id)!)),current:result.page,size:result.pageSize,total:result.total,pages:Math.ceil(result.total/result.pageSize),hasNext:result.hasMore};
 }
 nativeRow(project:Project){
  const preview=this.projectPreviews.get(project.id);if(preview&&!this.snapshots.has(project.id))return nativeProjectPreview(preview);
  const nodes=(this.snapshots.get(project.id)?.graph.nodes||[]).filter(node=>node.id!==META_NODE),createdTime=Date.parse(project.createdAt),updatedTime=Date.parse(project.updatedAt);
  let asset=project.coverAssetId?this.assets.get(project.coverAssetId):undefined;
  // A stored cover always wins. The fallback is presentation only and uses
  // actual saved image assets, never unsaved nodes or arbitrary remote URLs.
  if(!project.coverAssetId)for(const id of assetReferences(nodes)){
   const candidate=this.assets.get(id);
   if(candidate?.state==='READY'&&candidate.kind==='IMAGE'&&candidate.mimeType.startsWith('image/')&&(candidate.previewUrl||candidate.downloadUrl)){asset=candidate;break;}
  }
  const thumbnail=asset?.state==='READY'?(asset.previewUrl||asset.downloadUrl||''):(project.coverAssetId&&this.canvasMediaScopes.has(project.id)?this.displayCanvasAsset(project.id,'rhtv-asset:'+project.coverAssetId):preview?.thumbnail?.url??'');
  return{...project,...(this.access(project.id)?{role:this.access(project.id)!.role}:{}),canvasId:project.id,type:'CANVAS',createdTime,updatedTime,createTime:createdTime,updateTime:updatedTime,thumbnail,cover:thumbnail,nodesCount:nodes.length};
 }
 fixture(id:string){const project=this.projects.get(id),snapshot=this.snapshots.get(id);if(!project||!snapshot)throw new Error('项目尚未从服务器加载，不能创建本地替代画布。');const state=this.canvas(id),graph=this.restoreModelBindings(id,this.nativeView(id,state.graph||state.ack?.graph||decodeGraph(snapshot.graph)));graph.meta={...graph.meta,id,name:project.name};return graph;}
 /** Call only when a new native view is actually mounted. Reading a fixture
  * must not change the baseline of an older manager that is still on screen. */
 attachNativeView(id:string,graph:NativeGraph){const state=this.canvas(id);this.localModelSelections.delete(id);if(state.ack){const authoritative=state.graph||state.ack.graph;for(const node of authoritative.nodes)if(node.data?.capabilityVersion!==undefined)this.modelBindings.record(id,node,{});}const bound=this.operationSessions.has(id)?this.restoreModelBindings(id,graph):this.bindLocalGraph(id,this.restoreModelBindings(id,graph),state,true);state.observed=this.canonical(bound);this.operationSessions.get(id)?.reobserve(encodeGraph(state.observed));this.modelBindings.reconcile(id,bound);}
 async create(name='Untitled',graph?:NativeGraph){
  const epoch=this.epoch;
  const project=(await this.api.mutation<Project>('/projects',{name:name||'Untitled'})).data;
  this.requireEpoch(epoch);
  await this.loadProject(project.id);this.requireEpoch(epoch);
  if(graph){this.modelBindings.seed(project.id,graph);await this.save(project.id,{...graph,meta:{...graph.meta,id:project.id,name:project.name}});this.requireEpoch(epoch);}
  return project;
 }
 private serialize(id:string,epoch:number,operation:()=>Promise<void>){const previous=this.queues.get(id)||Promise.resolve();const next=previous.catch(()=>{}).then(()=>{this.requireEpoch(epoch);return operation();});this.queues.set(id,next);next.finally(()=>{if(this.queues.get(id)===next)this.queues.delete(id);}).catch(()=>{});return next;}
 private rememberProjectMetadata(project:Project){
  const current=this.projects.get(project.id);if(current&&current.revision<=project.revision)this.projects.set(project.id,project);
  const preview=this.projectPreviews.get(project.id);this.forgetProjectPreview(project.id);
  if(preview&&preview.project.coverAssetId===project.coverAssetId){
   const role=this.access(project.id)?.role??preview.role;
   this.projectPreviews.set(project.id,{...preview,project:{...project,role},role});
  }
 }
 /** A list mutation needs current metadata, never a fabricated canvas base.
  * Existing acknowledged graphs still receive their matching fresh snapshot. */
 async refreshProjectMetadata(id:string){
  const epoch=this.epoch,project=(await this.api.request<Project>('/projects/'+encodeURIComponent(id))).data;this.requireEpoch(epoch);
  if(project.id!==id||!Number.isSafeInteger(project.revision)||project.revision<1)throw new ApiError(502,'INVALID_PROJECT_METADATA','画布同步数据无效，请重试同步。');
  this.rememberProjectMetadata(project);
  const state=this.drafts.get(id);
  if(state?.ack||this.snapshots.has(id)){const snapshot=await this.api.request<Snapshot>('/projects/'+encodeURIComponent(id)+'/snapshot');this.requireEpoch(epoch);if(state)this.requireCanvas(id,state);this.acceptRemoteSnapshot(id,snapshot.data,snapshot.etag);}
  return project;
 }
 private async metadataContext(id:string,epoch:number,action:ProjectAction){
  if(this.identity)await this.refreshAccess(id);this.requireEpoch(epoch);this.requirePermission(id,action);
  const state=this.drafts.get(id),preview=this.projectPreviews.get(id),cached=this.projects.get(id);
  let revision=Math.max(state?.ack?.revision??0,this.snapshots.get(id)?.revision??0,preview?.project.revision??0,cached?.revision??0);
  if(!Number.isSafeInteger(revision)||revision<1){
   const project=(await this.api.request<Project>('/projects/'+encodeURIComponent(id))).data;this.requireEpoch(epoch);this.requirePermission(id,action);
   if(project.id!==id||!Number.isSafeInteger(project.revision)||project.revision<1)throw new ApiError(502,'INVALID_PROJECT_METADATA','画布同步数据无效，请重试同步。');revision=project.revision;
  }
  if(state)this.requireCanvas(id,state);
  return{state,etag:state?.ack?.revision===revision?state.ack.etag:'"'+revision+'"'};
 }
 private async metadata(id:string,body:any,method:'PATCH'|'PUT'|'DELETE',suffix=''){
  const epoch=this.epoch;
  return this.serialize(id,epoch,async()=>{
   const {state,etag}=await this.metadataContext(id,epoch,'canEdit');
   if(this.blocked.has(id))throw new Error('部分修改尚未同步，内容已保留，请重试同步。');
   const result=await this.api.request<Project>('/projects/'+encodeURIComponent(id)+suffix,{method,body,etag});
   this.requireEpoch(epoch);if(state)this.requireCanvas(id,state);
   if(result.data.id!==id||!Number.isSafeInteger(result.data.revision)||result.data.revision<1)throw new ApiError(502,'INVALID_PROJECT_METADATA','画布同步数据无效，请重试同步。');
   this.rememberProjectMetadata(result.data);
   // Metadata responses do not carry a graph and some endpoints do not CAS.
   // A loaded canvas needs a matching graph; a list-only card needs none.
   const acknowledged=this.drafts.get(id);
   if(acknowledged?.ack||this.snapshots.has(id)){const snapshot=await this.api.request<Snapshot>('/projects/'+encodeURIComponent(id)+'/snapshot');this.requireEpoch(epoch);if(acknowledged)this.requireCanvas(id,acknowledged);this.acceptRemoteSnapshot(id,snapshot.data,snapshot.etag);}
  });
 }
 rename(id:string,name:string){return this.metadata(id,{name},'PATCH');}
 pin(id:string,pinned:boolean){return this.metadata(id,undefined,pinned?'PUT':'DELETE','/pin');}
 delete(id:string){const epoch=this.epoch;return this.serialize(id,epoch,async()=>{
  const {state,etag}=await this.metadataContext(id,epoch,'canManageMembers');
  await this.api.request('/projects/'+encodeURIComponent(id),{method:'DELETE',etag});
  this.requireEpoch(epoch);if(state)this.requireCanvas(id,state);
  this.projects.delete(id);this.snapshots.delete(id);this.etags.delete(id);this.drafts.delete(id);this.blocked.delete(id);this.retryableErrors.delete(id);this.loadingProjects.delete(id);
  this.forgetProjectPreview(id);
  this.invalidateAccess(id);
  this.modelBindings.delete(id);this.modelPorts.delete(id);this.localModelSelections.delete(id);this.projectAssetCopies.delete(id);
 });}
 async saveForExecution(id:string,native:NativeGraph,current:()=>NativeGraph,check:(allowSaveCatchUp?:boolean)=>void,projectionBase?:ExecutionSave['projectionBase']):Promise<Snapshot>{
  check();let receipt:Snapshot|undefined;
  await this.save(id,native,true,{current,check,projectionBase,receipt:value=>{receipt=structuredClone(value);}});
  check();if(!receipt)throw new ApiError(502,'INVALID_RESPONSE','执行输入缺少实际保存回执。');
  return receipt;
 }
 save(id:string,native:NativeGraph,captureBindings=true,execution?:ExecutionSave){
  try{this.requirePermission(id);}catch(error){return Promise.reject(error);}
  if(this.operationSessions.has(id))return this.saveOperations(id,native,execution);
  const epoch=this.epoch,state=this.canvas(id);
  try{
   this.retryableErrors.delete(id);
   const initialEtag=state.ack?.etag||this.etags.get(id);if(!initialEtag)throw new Error('画布还在加载，请稍后继续编辑。');
   if(captureBindings)this.modelBindings.capture(id,native);
   const local=structuredClone(persistentRegionGraph(this.bindLocalGraph(id,native,state))),observedBase=structuredClone(state.observed||state.ack?.graph||local);let base=execution?.projectionBase&&state.ack?execution.projectionBase(observedBase,structuredClone(state.ack.graph)):observedBase;
   if(!execution&&state.ack&&!state.pending.length&&!this.blocked.has(id)&&!this.localModelSelections.get(id)?.size&&equalDraftValue(this.canonical(local),state.ack.graph)){
    state.observed=this.canonical(local);return this.serialize(id,epoch,async()=>{this.requireCanvas(id,state);this.requirePermission(id);});
   }
   if(this.blocked.has(id)&&!(this.blocked.get(id)?.reason==='CAS_UNCERTAIN'&&this.queues.has(id))){
    if(state.coalesced)state.coalesced.local=local;
    else{state.coalesced={base,local,initialEtag,unknownBase:false,phase:'FAILED'};state.pending.push(state.coalesced);}
    state.observed=this.canonical(local);this.rebuildDraft(id,state);
    if(this.blocked.has(id))return this.serialize(id,epoch,async()=>{throw new ApiError(409,'LOCAL_DRAFT_CONFLICT',this.isSaveCatchingUp(id)?'画布正在同步，当前修改已保留，请稍后重试。':'部分修改尚未同步，内容已保留，请重试同步。');});
    state.coalesced=undefined;
    // This native change is already retained in the former blocked draft.
    // The queued barrier must not replay the same undo a second time.
    base=this.canonical(local);
   }
   // Failed writes can be retried by a later autosave with the original CAS.
   // Collapse their settled prefix so repeated temporary failures stay bounded.
   this.compactDraftPrefix(state,['FAILED']);
   const entry:PendingSave={base,local,initialEtag,unknownBase:!state.ack&&state.pending.length===0,phase:'QUEUED'};
   // Execution freezes can add fields the immutable native manager omits.
   // Observe the actual UI, so their absence is not mistaken for a user edit.
   state.observed=this.canonical(execution?execution.current():local);state.pending.push(entry);this.rebuildDraft(id,state);
   return this.serialize(id,epoch,async()=>{
    this.requirePermission(id);
    this.requireCanvas(id,state);
    if(this.blocked.has(id)){entry.phase='FAILED';this.rebuildDraft(id,state);throw new ApiError(409,'LOCAL_DRAFT_CONFLICT',this.isSaveCatchingUp(id)?'画布正在同步，当前修改已保留，请稍后重试。':'部分修改尚未同步，内容已保留，请重试同步。');}
    entry.phase='IN_FLIGHT';let originalPending:PendingSave[]|undefined,committing:PendingSave[]=[];let writeStarted=false,responseRevision:number|undefined;
    try{
     await this.prepareGraph(entry.local);this.requireEpoch(epoch);this.requireCanvas(id,state);
     await this.prepareProjectAssets(id,state,entry,epoch);this.requireEpoch(epoch);this.requireCanvas(id,state);
     execution?.check();
     this.requirePermission(id);
     // Media preparation can await while a remote snapshot arrives. Bind both
     // graph and ETag only after it finishes, and never consult shared etags.
     if(this.blocked.has(id))throw new ApiError(409,'LOCAL_DRAFT_CONFLICT','部分修改尚未同步，内容已保留，请重试同步。');
     committing=state.pending.slice(0,state.pending.indexOf(entry)+1);
     const buildWrite=()=>{
      const acknowledged=state.ack,{graph:merged,conflicts}=this.replayDraft(committing,acknowledged);
      if(conflicts.length){state.conflicts=conflicts;throw new ApiError(409,'LOCAL_DRAFT_CONFLICT','部分修改尚未同步，内容已保留，请重试同步。');}
      return{acknowledged,merged,etag:acknowledged?.etag||committing[0].initialEtag};
     };
     let write=buildWrite(),result:ApiResult<Snapshot>;
     if(state.unqueued&&committing.includes(state.unqueued))state.unqueued=undefined;for(const pending of committing)pending.phase='IN_FLIGHT';
     for(let attempt=0;;attempt++){
      try{
       this.requirePermission(id);
       writeStarted=true;result=await this.api.request<Snapshot>('/projects/'+encodeURIComponent(id)+'/snapshot',{method:'PUT',body:{graph:encodeGraph(write.merged,this.encodeAsset)},etag:write.etag});this.requireEpoch(epoch);this.requireCanvas(id,state);break;
      }catch(error){
       this.requireEpoch(epoch);this.requireCanvas(id,state);
       if(error instanceof ApiError&&error.status===412)this.blockRefusedSave(id,state,write.acknowledged?.revision??0);
       if(!(error instanceof ApiError)||error.status!==412||attempt>=2||!write.acknowledged||committing.some(value=>value.unknownBase||value.requiresBaseDecision)){execution?.check();throw error;}
       execution?.check(true);
       // Another editor or an execution writeback can win the CAS before live
       // sync arrives. Each bounded retry requires a complete newer snapshot
       // and replays the original differences, never an old whole write graph.
       // A definitive CAS refusal has not submitted a task. First replace the
       // temporary uncertainty marker with a coherent newer base; checking the
       // execution while that marker is set would reject every safe retry.
       // The captured input/identity check still runs before the next write.
       const latest=await this.api.request<Snapshot>('/projects/'+encodeURIComponent(id)+'/snapshot');this.requireEpoch(epoch);this.requireCanvas(id,state);execution?.check(true);
       const accepted=this.acceptSnapshot(id,latest.data,latest.etag,true);
       if(latest.data.revision<=write.acknowledged.revision)throw error;
       if(accepted.conflicts.length||this.blocked.has(id))throw new ApiError(409,'LOCAL_DRAFT_CONFLICT','部分修改尚未同步，内容已保留，请重试同步。');
       execution?.check();write=buildWrite();
      }
     }
     // Remove the acknowledged local edit before replaying its descendants.
     originalPending=state.pending;state.pending=state.pending.filter(value=>!committing.includes(value));if(state.unqueued&&committing.includes(state.unqueued))state.unqueued=undefined;
     responseRevision=this.responseProofRevision(id,result);
     this.acceptSnapshot(id,result.data,result.etag,false);
     this.retryableErrors.delete(id);
     execution?.receipt(result.data);
     for(const node of write.merged.nodes){const selection=this.localModelSelections.get(id)?.get(node.id);if(selection?.type===node.type&&['modelCode','capabilityRef','capabilityVersion','parameterSchemaVersion'].every(key=>selection.data[key]===node.data?.[key]))this.localModelSelections.get(id)?.delete(node.id);}
     if(state.ack&&state.ack.revision>result.data.revision)for(const node of (state.graph||state.ack.graph).nodes)if(node.data?.capabilityVersion!==undefined&&!this.localModelSelections.get(id)?.has(node.id))this.modelBindings.record(id,node,{});
    }catch(error){
     if(execution&&!writeStarted&&error instanceof ApiError&&error.code==='STALE_EXECUTION_INPUT'){
      this.requireEpoch(epoch);this.requireCanvas(id,state);state.pending=state.pending.filter(value=>value!==entry);if(state.unqueued===entry)state.unqueued=undefined;this.rebuildDraft(id,state);throw error;
     }
     this.requireEpoch(epoch);this.requireCanvas(id,state);if(originalPending)state.pending=originalPending;for(const pending of committing)pending.phase='FAILED';entry.phase='FAILED';
     if(error instanceof ApiError&&error.code==='NODE_EDIT_OCCUPIED')this.retryableErrors.set(id,{code:'NODE_EDIT_OCCUPIED',message:error.message});
     if(error instanceof ApiError&&error.code==='SNAPSHOT_REVISION_MISMATCH')this.blockUncertain(id,state,Math.max(responseRevision??0,state.ack?.revision??0),responseRevision===undefined);
     this.rebuildDraft(id,state);
     if(error instanceof ApiError&&error.status===412&&this.isBlocked(id)&&!this.isSaveCatchingUp(id))this.notice('部分修改尚未同步，内容已保留，请重试同步。');
     throw error;
    }
   });
  }catch(error){return this.serialize(id,epoch,async()=>{throw error;});}
 }
 queueSave(id:string,graph:NativeGraph){const epoch=this.epoch;let next:Promise<void>;try{this.reconcileModelBindings(id,graph);next=this.save(id,graph);}catch(error){next=this.serialize(id,epoch,async()=>{throw error;});}next.catch(error=>{if(epoch===this.epoch&&!(this.usesCanvasOperations(id)&&(leaseRepair(error)||transientCanvasSaveFailure(error)))&&!(error instanceof ApiError&&error.status===412))this.notice(error instanceof Error?error.message:'画布未能保存。');});return next;}
 wait(id:string){return this.queues.get(id)||Promise.resolve();}
 isBlocked(id:string){return this.blocked.has(id);}
 isSaveCatchingUp(id:string){return this.blocked.get(id)?.reason==='CAS_UNCERTAIN';}
 hasPending(id?:string){return id?this.queues.has(id):this.queues.size>0;}
 async upload(file:File,projectId:string,onProgress?:(value:number)=>void,options:{signal?:AbortSignal;check?:()=>void;validate?:(file:File)=>void}={}){
  const epoch=this.epoch;
  const check=()=>{
   this.requireEpoch(epoch);
   if(options.signal?.aborted)throw new DOMException('上传已取消','AbortError');
   options.check?.();
   this.requirePermission(projectId);
  };
  check();
  if(/\.(?:glb|gltf|obj|fbx|ply|spz|splat|md|markdown)$/i.test(file.name)){
   options.validate?.(file);
   const body=new FormData();body.set('file',file);body.set('projectId',projectId);
   const asset=(await(this.api as ProductClient).multipartV2<Asset>('/file-assets',body,randomUuid(),options.signal)).data;
   check();if(asset.state!=='READY'||!(asset.downloadUrl||asset.previewUrl))throw new ApiError(409,'ASSET_NOT_READY','文件素材尚未就绪。');
   this.registerAsset(asset);onProgress?.(100);return asset.downloadUrl||asset.previewUrl!;
  }
  // AssetUploadRequest limits a single media object to 512 MiB. Reject it
  // before hashing allocates the full buffer. Model limits are checked separately.
  if(file.size>512*1024*1024)throw new ApiError(413,'PAYLOAD_TOO_LARGE','单个画布素材不能超过 512 MiB。');
  const prepared=await optimizeCanvasImage(file);
  check();options.validate?.(prepared);
  const bytes=await prepared.arrayBuffer();check();
  const checksumSha256=await sha256Hex(bytes);check();
  const mimeType=uploadMimeType(prepared.type);
  const body={projectId,fileName:prepared.name,mimeType,byteSize:prepared.size,checksumSha256};
  const session=(await this.api.request<any>('/asset-uploads',{method:'POST',body,idempotencyKey:randomUuid(),signal:options.signal})).data;
  check();
  const response=await this.api.transport(session.url,{method:'PUT',headers:session.headers,body:prepared,credentials:'omit',signal:options.signal});
  check();
  if(!response.ok)throw new ApiError(response.status,'UPLOAD_FAILED','素材上传失败。');
  const etag=response.headers.get('ETag');if(!etag)throw new Error('上传服务未返回文件校验标识。');
  onProgress?.(95);check();
  const asset=(await this.api.request<Asset>('/asset-uploads/'+encodeURIComponent(session.id)+'/complete',{method:'POST',body:{etag},idempotencyKey:randomUuid(),signal:options.signal})).data;
  check();
  if(asset.state!=='READY'||!(asset.downloadUrl||asset.previewUrl))throw new Error('素材尚未处理完成，请稍后重试。');
  this.registerAsset(asset);onProgress?.(100);check();return asset.downloadUrl||asset.previewUrl!;
 }
}
