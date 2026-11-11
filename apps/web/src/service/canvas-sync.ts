import {ApiError} from '../api/client';
import {equalDraftValue} from './canvas-draft';
import type {RoomEvent} from './canvas-room';
import {CanvasSyncTransport} from './canvas-sync-resume';
import {applyLiveGraphDelta} from './canvas-live-delta';
import {projectAccessDenied} from './project-access';
import type {Snapshot} from '../api/types';
import type {NativeGraph} from './graph';
import type {ProductClient} from './product-client';
import type {ServiceStorage} from './storage';

export interface NodeExecutionState {nodeId:string;taskId:string;executionId:string;state:'QUEUED'|'RUNNING'|'SUCCEEDED'|'FAILED'|'CANCELED';applicationState:'PENDING'|'APPLIED'|'DETACHED';reason?:string}
export interface LiveCanvasSnapshot {schemaVersion:'1';projectId:string;graph:Snapshot['graph'];graphRevision:number;eventCursor:string;updatedAt:string;nodeStates:NodeExecutionState[];nodeExecutionAvailable:boolean}
export interface CanvasSyncView {current:()=>boolean;read:()=>NativeGraph|null;readOnly?:()=>boolean;apply:(graph:NativeGraph)=>boolean;applied:(snapshot:LiveCanvasSnapshot)=>void;error:(error:unknown)=>void}
interface EventPage {projectId:string;events:any[];nextCursor:string;eventCursor:string;hasMore:boolean}
const maxCursor='9223372036854775807';
export function validCanvasCursor(value:unknown):value is string{return typeof value==='string'&&/^(0|[1-9][0-9]{0,18})$/.test(value)&&(value.length<maxCursor.length||value.length===maxCursor.length&&value<=maxCursor);}
export function compareCanvasCursor(a:string,b:string){return a.length===b.length?(a===b?0:a<b?-1:1):a.length<b.length?-1:1;}
const nextCursor=(cursor:string)=>(BigInt(cursor)+1n).toString();
const invalid=()=>new ApiError(502,'INVALID_CANVAS_SYNC','服务器返回了无效的画布同步数据。');
const revision=(value:any)=>Number.isSafeInteger(value)&&value>=1;
function validateSnapshot(value:any,id:string):asserts value is LiveCanvasSnapshot {
 if(value?.schemaVersion!=='1'||value.projectId!==id||!revision(value.graphRevision)||!validCanvasCursor(value.eventCursor)||typeof value.updatedAt!=='string'||value.graph?.schemaVersion!=='1'||!Array.isArray(value.graph.nodes)||!Array.isArray(value.graph.edges)||!Array.isArray(value.nodeStates)||value.nodeStates.length>10000||typeof value.nodeExecutionAvailable!=='boolean'||!value.nodeExecutionAvailable&&value.nodeStates.length)throw invalid();
 const nodes=new Set(value.graph.nodes.map((node:any)=>node.id)),seen=new Set<string>();
 for(const state of value.nodeStates){
  if(!state||Object.keys(state).some(key=>!['nodeId','taskId','executionId','state','applicationState','reason'].includes(key))||[state.nodeId,state.taskId,state.executionId].some(id=>typeof id!=='string'||!id.length||id.length>200)||!nodes.has(state.nodeId)||seen.has(state.nodeId)||!['QUEUED','RUNNING','SUCCEEDED','FAILED','CANCELED'].includes(state.state)||!['PENDING','APPLIED','DETACHED'].includes(state.applicationState)||state.reason!==undefined&&(typeof state.reason!=='string'||!state.reason.length||state.reason.length>200))throw invalid();
  seen.add(state.nodeId);
 }
}
function validateEvent(event:any,id:string){
 if(event?.schemaVersion!=='1'||event.projectId!==id||!validCanvasCursor(event.sequence)||event.sequence==='0'||typeof event.occurredAt!=='string'||!['canvas.changed','canvas.invalidated'].includes(event.type)||!revision(event.data?.baseRevision)||!revision(event.data?.graphRevision)||event.data.graphRevision!==event.data.baseRevision+1)throw invalid();
}
function validatePage(page:any,id:string,after:string):asserts page is EventPage {
 if(page?.projectId!==id||!Array.isArray(page.events)||page.events.length>100||typeof page.hasMore!=='boolean'||!validCanvasCursor(page.nextCursor)||!validCanvasCursor(page.eventCursor)||compareCanvasCursor(page.eventCursor,after)<0)throw invalid();
 let consumed=after;
 for(const event of page.events){validateEvent(event,id);if(event.sequence!==nextCursor(consumed))throw new ApiError(502,'CANVAS_EVENT_GAP','画布事件存在缺口，正在重新读取一致快照。');consumed=event.sequence;}
 if(page.nextCursor!==consumed||compareCanvasCursor(consumed,page.eventCursor)>0||page.hasMore!==(compareCanvasCursor(consumed,page.eventCursor)<0))throw invalid();
}
class StreamAuthExpired extends ApiError {}

/** A single project attachment owns its controller and applied cursor. Every
 * invalidation/changed event reads a coherent snapshot rather than pretending
 * its incomplete delta can replace native metadata. */
export class CanvasSync {
 private readonly controller=new CanvasSyncTransport();
 private cursor:string|null=null;
 private pendingCursor:string|null=null;
 private pendingSnapshot:LiveCanvasSnapshot|null=null;
 private lastApplied:LiveCanvasSnapshot|null=null;
 private deltaSupported=false;
 private running:Promise<void>|null=null;
 private retry=1000;
 private sse=true;
 private roomSupported=false;
 private roomRetryAt=0;
 private roomBackoff=2000;
 private quotaRetryAt:number|undefined;
 private quotaBackoff=2000;
 private lastError='';
 private proofRetryAt=0;
 private interruptStream:(()=>void)|null=null;
 private readonly stopWatchingDrafts:()=>void;
 private readonly stopWatchingWake:()=>void;
 private readonly requireCanvas:()=>void;
 constructor(private readonly api:ProductClient,private readonly storage:ServiceStorage,private readonly id:string,private readonly view:CanvasSyncView){
  this.stopWatchingWake=this.controller.onWake(()=>{
   // A real wake bypasses transient outage backoff. Preserve explicit SSE
   // capability refusals and every unacknowledged operation/cursor.
   this.roomRetryAt=0;this.roomBackoff=2000;this.retry=1000;this.lastError='';
   if(this.quotaRetryAt!==undefined){this.sse=true;this.quotaRetryAt=undefined;this.quotaBackoff=2000;}
  });
  this.requireCanvas=storage.canvasReadGuard(id);this.stopWatchingDrafts=storage.subscribeDrafts(changed=>{if(changed===id&&storage.isSaveCatchingUp(id))this.interruptStream?.();});}
 get eventCursor(){return this.cursor;}
 get awaitingApply(){return this.pendingCursor!==null;}
 stop(){this.stopWatchingDrafts();this.stopWatchingWake();this.controller.abort();}
 start(){if(!this.running){this.controller.listen();this.running=this.run();}return this.running;}
 private check(){if(this.controller.signal.aborted||!this.view.current())throw new DOMException('画布已切换','AbortError');this.requireCanvas();}
 private async pause(milliseconds:number){
  await this.controller.pause(milliseconds);
  if(this.controller.stopped||!this.view.current())throw new DOMException('同步已取消','AbortError');
 }
 private applyPending(){
  this.check();const native=this.view.read();if(!native)throw new ApiError(409,'CANVAS_NOT_READY','原生画布尚未就绪。');const readOnly=this.view.readOnly?.()===true;if(!readOnly)this.storage.observeNativeDraft(this.id,native);
  const merged=readOnly?{graph:this.storage.readOnlyNativeView(this.id)}:this.storage.mergedNativeView(this.id);
  return this.applyView(merged.graph);
 }
 private applyView(graph:NativeGraph){
  const displayedRevision=this.storage.snapshots.get(this.id)?.revision;
  if(!this.view.apply(graph))return false;
  this.check();const applied=this.view.read();if(!applied)throw new ApiError(409,'CANVAS_NOT_READY','原生画布尚未就绪。');this.storage.remoteNativeViewApplied(this.id,applied,displayedRevision);if(!this.pendingSnapshot)throw invalid();this.view.applied(this.pendingSnapshot);
  // Never acknowledge a cursor when the native view has deferred/failed.
  this.cursor=this.pendingCursor;this.lastApplied=this.pendingSnapshot;this.pendingCursor=null;this.pendingSnapshot=null;return true;
 }
 private materialize(v:any){
  const base=this.lastApplied;
  if(!base||this.cursor!==base.eventCursor||v?.kind!=='DELTA'||v.projectId!==this.id||v.fromRevision!==base.graphRevision||!revision(v.graphRevision)||v.graphRevision<base.graphRevision)return null;
  const graph=applyLiveGraphDelta(base.graph,v.delta);if(!graph)return null;
  const {kind:_,fromRevision:__,delta:___,...metadata}=v;
  const result={...metadata,graph};validateSnapshot(result,this.id);return result;
 }
 /** Bound transport reads independently from the attachment. A lost response
  * must not leave the canvas waiting forever or retire its confirmed cursor.
  * Reset on each response chunk so a large, progressing graph is not timed out. */
 private async readWithDeadline<T>(read:(signal:AbortSignal,progress:()=>void)=>Promise<T>,milliseconds=15000):Promise<T>{
  const parent=this.controller.signal,request=new AbortController();
  let expired=false;
  const abort=()=>request.abort(parent.reason);
  if(parent.aborted)abort();else parent.addEventListener('abort',abort,{once:true});
  let timer:ReturnType<typeof setTimeout>|undefined;
  const progress=()=>{clearTimeout(timer);if(!request.signal.aborted)timer=setTimeout(()=>{expired=true;request.abort();},milliseconds);};
  progress();
  try{return await read(request.signal,progress);}
  catch(error){if(expired&&!parent.aborted)throw new TypeError('Canvas sync read timed out');throw error;}
  finally{clearTimeout(timer);parent.removeEventListener('abort',abort);}
 }
 private async readUpdate(){
  const prefix='/projects/'+encodeURIComponent(this.id),base=this.lastApplied;
  if(this.deltaSupported&&base&&this.cursor===base.eventCursor&&!this.storage.isSaveCatchingUp(this.id)){
   try{
    const update=await this.readWithDeadline((signal,onReadProgress)=>this.api.requestV2<any>(prefix+'/live-update?fromRevision='+base.graphRevision,{signal,onReadProgress}));this.check();this.controller.markActivity();
    const v=update.data;
    if(v?.kind==='SNAPSHOT'){validateSnapshot(v,this.id);return {...update,data:v as LiveCanvasSnapshot};}
    const data=this.materialize(v);if(data)return {...update,data};
    // An unknown/invalid delta never mutates the graph. Read a full snapshot
    // from the same authenticated project before acknowledging this event.
   }catch(error){
    if(!(error instanceof ApiError)||![404,501].includes(error.status)&&error.code!=='INVALID_CANVAS_SYNC')throw error;
   }
  }
  const result=await this.readWithDeadline((signal,onReadProgress)=>this.api.requestV2<LiveCanvasSnapshot>(prefix+'/live-snapshot',{signal,onReadProgress}));this.check();validateSnapshot(result.data,this.id);this.controller.markActivity();this.deltaSupported=result.canvasDelta===true;this.roomSupported=this.deltaSupported&&result.canvasRoom===true;return result;
 }
 private async snapshot(result?:{data:LiveCanvasSnapshot;etag:string|null},positionsOnly=false){
  result??=await this.readUpdate();this.check();
  if(this.cursor!==null&&compareCanvasCursor(result.data.eventCursor,this.cursor)<0)throw invalid();
  // Without a microtask gap, a pure committed move can reuse the view
  // storage just prepared. Active sidecars, later input, and pending native
  // applications use the complete projection/observation path.
  const idle=()=>!this.view.readOnly?.()&&this.storage.canReuseMoveProjection(this.id);
  const revision=result.data.graphRevision;
  const reuse=positionsOnly&&this.storage.snapshots.get(this.id)?.revision===revision-1&&idle();
  let before:NativeGraph|null=null,applied:boolean|undefined;
  const read=reuse?()=>{const value=this.view.read();before=structuredClone(value);return value;}:this.view.read;
  const snapshot=result.data;
  await this.storage.receiveLiveSnapshot(this.id,{projectId:this.id,revision,graph:snapshot.graph,updatedAt:snapshot.updatedAt},result.etag,read,this.view.current,this.controller.signal,this.view.readOnly?.()===true,reuse?accepted=>{
   if(!before||!idle())return;
   const current=this.view.read();
   this.check();
   if(!equalDraftValue(before,current)||!idle()||this.storage.snapshots.get(this.id)?.revision!==revision)return;
   this.pendingCursor=snapshot.eventCursor;this.pendingSnapshot=snapshot;
   applied=this.applyView(this.storage.restoreModelBindings(this.id,accepted.graph));
  }:undefined);
  this.check();
  if(applied!==undefined)return applied;
  this.pendingCursor=snapshot.eventCursor;this.pendingSnapshot=snapshot;
  return this.applyPending();
 }
 async catchUp(){
  this.check();
  // A refusal marker can be installed after its newer live event was already
  // consumed. Read fresh proof independently of cursor changes and native
  // focus, without replaying an uncertain mutation or polling without a bound.
  if(this.storage.isSaveCatchingUp(this.id)){
   if(Date.now()>=this.proofRetryAt){this.proofRetryAt=Date.now()+1000;return this.snapshot();}
   return this.pendingCursor!==null?this.applyPending():false;
  }
  if(this.pendingCursor!==null)return this.applyPending();if(this.cursor===null)return this.snapshot();
  const after=this.cursor,result=await this.readWithDeadline((signal,onReadProgress)=>this.api.requestV2<EventPage>('/projects/'+encodeURIComponent(this.id)+'/events?'+new URLSearchParams({after,limit:'100'}),{headers:{Accept:'application/json'},signal,onReadProgress}));this.check();validatePage(result.data,this.id,after);this.controller.markActivity();
  if(result.data.events.length)return this.snapshot();return true;
 }
 // SSE and WebSocket share validation, cursor ordering, gap recovery and
 // native-view admission. Never advance on an unapplied frame.
 private eventConsumer(){
  let streamCursor=this.cursor!;
  return async ({event:type,id,data:untrusted}:RoomEvent) => {
   const payload:any=untrusted;
   this.check();
   if(type==='canvas.delta'){
    if(!this.deltaSupported||!validCanvasCursor(id)||payload?.eventCursor!==id||payload?.projectId!==this.id)throw invalid();
    if(compareCanvasCursor(id,streamCursor)<=0)return true;
    if(id!==nextCursor(streamCursor))throw new ApiError(502,'CANVAS_EVENT_GAP','画布事件存在缺口，正在重新读取一致快照。');
    streamCursor=id;if(compareCanvasCursor(id,this.cursor!)<=0)return true;
    let direct:LiveCanvasSnapshot|null=null;
    if(!this.storage.isSaveCatchingUp(this.id)&&payload.graphRevision===payload.fromRevision+1){try{direct=this.materialize(payload);}catch(error){if(!(error instanceof ApiError)||error.code!=='INVALID_CANVAS_SYNC')throw error;}}
    const delta=payload.delta;
    const positionsOnly=!!direct&&delta.positions.length>0&&!delta.upsertNodes.length&&!delta.removeNodeIds.length&&!delta.upsertEdges.length&&!delta.removeEdgeIds.length&&delta.nodeOrder===undefined&&delta.edgeOrder===undefined;
    return this.snapshot(direct?{data:direct,etag:'"'+direct.graphRevision+'"'}:undefined,positionsOnly);
   }
   if(type==='stream.error'){if(id||!Number.isInteger(payload?.status)||typeof payload.code!=='string'||typeof payload.message!=='string'||typeof payload.retryable!=='boolean')throw invalid();if(payload.status===401)throw new StreamAuthExpired(payload.status,payload.code,payload.message);const error=new ApiError(payload.status,payload.code,payload.message);this.api.reportV2Failure(error);throw error;}
   validateEvent(payload,this.id);if(type!==payload.type||id!==payload.sequence)throw invalid();
   if(compareCanvasCursor(payload.sequence,streamCursor)<=0)return true;
   if(payload.sequence!==nextCursor(streamCursor))throw new ApiError(502,'CANVAS_EVENT_GAP','画布事件存在缺口，正在重新读取一致快照。');streamCursor=payload.sequence;
   if(compareCanvasCursor(payload.sequence,this.cursor!)<=0)return true;
   // Keep the live connection when the view accepted its snapshot. Timers in
   // background tabs can be throttled for seconds, so reconnecting and sleeping
   // after every single edit would delay the next edit.
   // A snapshot may include later events: the cursor check above skips those.
   return this.snapshot();
  };
 }
 private async listen(){
  if(!this.roomSupported){await this.stream();return;}
  if(Date.now()>=this.roomRetryAt){
   const room=this.api.openCanvasRoom(this.id,this.cursor!,this.controller.signal);
   if(room){
    let interrupted=false;
    const interrupt=()=>{interrupted=true;room.close();};
    const consume=this.eventConsumer();
    const stopActivity=room.onActivity?.(this.controller.markActivity);
    this.interruptStream=interrupt;
    try{
     if(this.storage.isSaveCatchingUp(this.id))return;
     for(;;){
      const frame=await room.next();
      this.check();
      this.controller.markActivity();
      if(frame.type==='ready')continue;
      if(!await consume(frame.value))return;
      this.roomBackoff=2000;
     }
    }catch(error){
     this.check();
     if(interrupted)return;
     // On an expired stream token the existing HTTP path refreshes the
     // login, then resumes from the last actually rendered cursor.
     if(!(error instanceof TypeError)&&!(error instanceof ApiError&&(error.status===401||error.status===429||error.status>=500)))throw error;
    }finally{
     stopActivity?.();
     this.api.releaseCanvasRoom(this.id,room);
     if(this.interruptStream===interrupt)this.interruptStream=null;
    }
   }
   this.roomRetryAt=Date.now()+this.roomBackoff;
   this.roomBackoff=Math.min(60000,this.roomBackoff*2);
  }
  if(this.sse)await this.stream(this.roomRetryAt);
 }
 private async stream(roomRetryAt?:number){
  this.check();const response=await this.readWithDeadline(signal=>this.api.rawV2('/projects/'+encodeURIComponent(this.id)+'/events?'+new URLSearchParams({after:this.cursor!,limit:'100'}),{headers:{Accept:'text/event-stream',...(this.deltaSupported?{'X-STUDIO-Canvas-Update':'delta-v1'}:{})},signal}));try{this.check();}catch(error){await response.body?.cancel();throw error;}
  if(!response.ok){
   // Cover the body as well as headers. Keep its original response identity so
   // an old error cannot revoke a newer account while this read was waiting.
   await this.readWithDeadline((signal,onReadProgress)=>this.api.decodeV2Response(response,signal,onReadProgress));throw invalid();
  }
  if(!response.headers.get('Content-Type')?.toLowerCase().startsWith('text/event-stream')||!response.body){await response.body?.cancel();throw invalid();}
  const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='',data:string[]=[],dataBytes=0,eventType='',eventId='',changed=false;
  const onAbort=()=>{void reader.cancel();};this.controller.signal.addEventListener('abort',onAbort,{once:true});
  let proofInterrupted=false;
  // The server emits a comment at least every 10 seconds. A proxy can leave
  // a response open forever after dropping its upstream, without offline.
  // Discard only the partial frame and resume from the last applied cursor.
  let quietTimer:ReturnType<typeof setTimeout>|undefined;
  const renewRead=()=>{clearTimeout(quietTimer);quietTimer=setTimeout(interrupt,25000);};
  const interrupt=()=>{proofInterrupted=true;void reader.cancel().catch(()=>{});};this.interruptStream=interrupt;
  renewRead();
  const retryRoomTimer=roomRetryAt===undefined?undefined:setTimeout(interrupt,Math.max(0,roomRetryAt-Date.now()));
  if(this.storage.isSaveCatchingUp(this.id))interrupt();
  const consume=this.eventConsumer();
  const dispatch=async()=>{
   if(!data.length){eventType='';eventId='';return;}
   let payload:any;try{payload=JSON.parse(data.join('\n'));}catch{throw invalid();}
   const type=eventType,id=eventId;data=[];dataBytes=0;eventType='';eventId='';
   if(!await consume({event:type,id,data:payload})){changed=true;await reader.cancel();}
  };
  try{
   for(;;){this.check();const read=await reader.read();this.check();if(proofInterrupted)return;if(read.done){buffer+=decoder.decode();if(buffer.trim()||data.length)throw invalid();return;}
    if(read.value?.length){renewRead();this.controller.markActivity();}
    buffer+=decoder.decode(read.value,{stream:true});if(buffer.length>2*1024*1024)throw invalid();
    for(;;){const end=buffer.indexOf('\n');if(end<0)break;let line=buffer.slice(0,end);buffer=buffer.slice(end+1);if(line.endsWith('\r'))line=line.slice(0,-1);
     if(!line){await dispatch();if(changed)return;continue;}
     if(line.startsWith(':'))continue;const colon=line.indexOf(':'),field=colon<0?line:line.slice(0,colon),value=colon<0?'':line.slice(colon+1).replace(/^ /,'');if(field==='data'){dataBytes+=line.length+1;if(dataBytes>2*1024*1024)throw invalid();data.push(value);}else if(field==='event')eventType=value;else if(field==='id')eventId=value;
    }
   }
  }finally{clearTimeout(quietTimer);clearTimeout(retryRoomTimer);if(this.interruptStream===interrupt)this.interruptStream=null;this.controller.signal.removeEventListener('abort',onAbort);await reader.cancel().catch(()=>{});reader.releaseLock();}
 }
 private async run(){
  while(!this.controller.stopped&&this.view.current()){
   this.controller.next();
   try{
    const applied=await this.catchUp();this.check();if(!applied){await this.pause(250);continue;}
    if(this.storage.isSaveCatchingUp(this.id)){await this.pause(250);continue;}
    if(!this.sse&&this.quotaRetryAt!==undefined&&Date.now()>=this.quotaRetryAt)this.sse=true;
    // A proxy can reject long HTTP responses and still support a socket.
    // Keep attempting the room on its own backoff during JSON-only recovery.
    if(this.sse||this.roomSupported&&Date.now()>=this.roomRetryAt){
     await this.listen();
     if(this.sse){this.quotaBackoff=2000;this.quotaRetryAt=undefined;}
     await this.pause(100);
    }else await this.pause(1000);
    this.retry=1000;this.lastError='';
   }catch(error){
    if(this.controller.stopped||!this.view.current())return;
    if(this.controller.signal.aborted){this.retry=1000;continue;}
    if(error instanceof DOMException&&error.name==='AbortError')return;
    const fatal=error instanceof ApiError&&(projectAccessDenied(error)||error.status===501||error.code==='STALE_CANVAS_SESSION')&&!(error instanceof StreamAuthExpired);
    // A stale connection during refresh may temporarily consume a slot. Use
    // finite pages while it drains, then retry streaming with bounded backoff.
    if(error instanceof ApiError&&error.status===429&&error.code==='EVENT_STREAM_LIMIT'){
     this.sse=false;this.quotaRetryAt=Date.now()+this.quotaBackoff;this.quotaBackoff=Math.min(30000,this.quotaBackoff*2);this.lastError='';try{await this.pause(1000);}catch{return;}continue;
    }
    if(error instanceof ApiError&&[406,415].includes(error.status)){this.sse=false;this.quotaRetryAt=undefined;continue;}
    if(error instanceof ApiError&&['CANVAS_EVENT_GAP','EVENT_CURSOR_AHEAD','EVENT_CURSOR_EXPIRED'].includes(error.code)){this.cursor=null;this.pendingCursor=null;this.pendingSnapshot=null;}
    const message=error instanceof Error?error.message:String(error);
    // Brief malformed proxy responses and disconnected fetches are retried
    // here, on this same cursor. Do not interrupt the editor on the first one.
    const transportNoise=error instanceof TypeError||error instanceof ApiError&&error.code==='INVALID_RESPONSE';
    if((!transportNoise||this.retry>=4000)&&message!==this.lastError){this.lastError=message;this.view.error(error);}
    if(fatal)return;
    try{await this.pause(this.retry);}catch{return;}this.retry=Math.min(this.retry*2,10000);
   }
  }
 }
}
