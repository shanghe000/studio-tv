import {ApiError} from '../api/client';
import {randomUuid} from '../browser-compat';
import type {ProductClient} from './product-client';

export interface PresencePoint {x:number;y:number}
export interface CanvasParticipant {clientId:string;userId:string;displayName:string;role:'OWNER'|'EDITOR'|'VIEWER';cursor:PresencePoint|null;selectedNodeIds:string[];lastSeenAt:string}
export interface CanvasPresencePerson {userId:string;displayName:string;role:CanvasParticipant['role'];pages:CanvasParticipant[];isYou:boolean;hasCurrentPage:boolean;editing:boolean}
/** Presence transports pages so leases and cursors remain independent. The
 * member list counts people and exposes additional pages without double-counting
 * the same verified user after a refresh or on another device. */
export function presencePeople(members:readonly CanvasParticipant[],leases:readonly CanvasNodeLease[],userId:string,clientId:string):CanvasPresencePerson[]{
 const grouped=new Map<string,CanvasParticipant[]>();for(const member of members){const pages=grouped.get(member.userId)??[];pages.push(member);grouped.set(member.userId,pages);}
 return [...grouped].map(([id,pages])=>{const ordered=[...pages].sort((a,b)=>Date.parse(b.lastSeenAt)-Date.parse(a.lastSeenAt)),representative=pages.find(page=>page.clientId===clientId)??ordered[0],pageIds=new Set(pages.map(page=>page.clientId));return{userId:id,displayName:representative.displayName,role:representative.role,pages:ordered,isYou:id===userId,hasCurrentPage:pages.some(page=>page.clientId===clientId),editing:leases.some(lease=>lease.userId===id&&pageIds.has(lease.clientId))};});
}
export interface CanvasNodeLease {nodeId:string;clientId:string;userId:string;displayName:string;expiresAt:string}
export interface CanvasPresenceSnapshot {schemaVersion:'1';projectId:string;epoch:string;sequence:string;serverTime:string;presenceTtlMs:number;leaseTtlMs:number;members:CanvasParticipant[];leases:CanvasNodeLease[]}
export interface CanvasPresenceState {status:'connecting'|'connected'|'reconnecting'|'offline';snapshot:CanvasPresenceSnapshot|null;error?:string}
const id=(value:unknown,max=160):value is string=>typeof value==='string'&&value.length>0&&value.length<=max&&/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(value);
const iso=(value:unknown):value is string=>typeof value==='string'&&Number.isFinite(Date.parse(value));
const point=(value:any)=>value===null||value&&Number.isFinite(value.x)&&Number.isFinite(value.y)&&Math.abs(value.x)<=1e7&&Math.abs(value.y)<=1e7&&Object.keys(value).every(key=>key==='x'||key==='y');
const sequence=(value:unknown):value is string=>typeof value==='string'&&/^(0|[1-9][0-9]{0,19})$/.test(value);
const kinds=['OWNER','EDITOR','VIEWER'];
const invalid=()=>new ApiError(502,'INVALID_CANVAS_PRESENCE','协作状态暂时不可用，正在重新连接。');
export function validatePresenceSnapshot(value:any,projectId:string):asserts value is CanvasPresenceSnapshot {
 if(value?.schemaVersion!=='1'||value.projectId!==projectId||!id(value.epoch)||!sequence(value.sequence)||!iso(value.serverTime)||value.presenceTtlMs!==20000||value.leaseTtlMs!==15000||!Array.isArray(value.members)||value.members.length>64||!Array.isArray(value.leases)||value.leases.length>2048)throw invalid();
 const pages=new Set<string>(),nodes=new Set<string>();
 for(const member of value.members){
  if(!member||!id(member.clientId,64)||pages.has(member.clientId)||!id(member.userId)||typeof member.displayName!=='string'||member.displayName.length>320||!kinds.includes(member.role)||!point(member.cursor)||!iso(member.lastSeenAt)||!Array.isArray(member.selectedNodeIds)||member.selectedNodeIds.length>32||member.selectedNodeIds.some((nodeId:any)=>!id(nodeId,200))||new Set(member.selectedNodeIds).size!==member.selectedNodeIds.length)throw invalid();
  pages.add(member.clientId);
 }
 for(const lease of value.leases){if(!lease||!id(lease.nodeId,200)||nodes.has(lease.nodeId)||!id(lease.clientId,64)||!id(lease.userId)||typeof lease.displayName!=='string'||lease.displayName.length>320||!iso(lease.expiresAt))throw invalid();nodes.add(lease.nodeId);}
}
const compare=(a:string,b:string)=>a.length===b.length?a.localeCompare(b):a.length-b.length;
const nodes=(values:string[],maximum=128)=>{
 const result=[...new Set(values)];if(result.length>maximum||result.some(value=>!id(value,200)))throw new ApiError(422,'CANVAS_LEASE_LIMIT',`一次最多编辑 ${maximum} 个有效节点，请分批操作。`);return result.sort();
};

/** Transient awareness and bounded node leases. No graph data, prompt text,
 * access token, or cursor state is stored in the document or browser storage. */
export class CanvasPresenceClient {
 readonly clientId=randomUuid();
 private controller=new AbortController();
 private view:CanvasPresenceState={status:'connecting',snapshot:null};
 private listeners=new Set<()=>void>();
 private deadlines=new Map<string,number>();
 private memberDeadlines=new Map<string,number>();
 private expiredEpochs=new Set<string>();
 private heartbeatTimer:ReturnType<typeof setInterval>|undefined;
 private expiryTimer:ReturnType<typeof setInterval>|undefined;
 private postTimer:ReturnType<typeof setTimeout>|undefined;
 private pendingPost:Promise<void>|null=null;
 private joining:Promise<void>|null=null;
 private lastPost=0;
 private serverOffset:number|undefined;
 private firstJoinServerTime:number|undefined;
 private cursor:PresencePoint|null=null;
 private selected:string[]=[];
 private dirty=false;
 private started=false;
 private polling=false;
 private quotaRetryAt:number|undefined;
 private quotaBackoff=2000;
 private acquirePending=new Map<string,Promise<void>>();
 constructor(readonly api:ProductClient,readonly projectId:string,readonly userId:string,private canEdit:()=>boolean,private current:()=>boolean,private now=()=>Date.now(),private sameIdentity=()=>this.current()){}
 private path(suffix=''){return'/projects/'+encodeURIComponent(this.projectId)+suffix;}
 private check(){if(this.controller.signal.aborted||!this.current())throw new ApiError(409,'STALE_CANVAS_SESSION','画布已切换，本次协作操作已取消。');}
 private notify(){for(const listener of this.listeners)listener();}
 subscribe(listener:()=>void){this.listeners.add(listener);return()=>this.listeners.delete(listener);}
 state():CanvasPresenceState {
  const snapshot=this.view.snapshot,now=this.now();
  return{...this.view,snapshot:snapshot?{...snapshot,members:snapshot.members.filter(member=>(this.memberDeadlines.get(member.clientId)??0)>now),leases:snapshot.leases.filter(lease=>(this.deadlines.get(lease.nodeId)??0)>now)}:null};
 }
 holder(nodeId:string){return this.state().snapshot?.leases.find(lease=>lease.nodeId===nodeId);}
 owns(nodeIds:string[]){return!this.controller.signal.aborted&&this.view.status!=='offline'&&this.current()&&this.canEdit()&&nodeIds.every(nodeId=>{const lease=this.holder(nodeId);return lease?.clientId===this.clientId&&lease.userId===this.userId&&(this.deadlines.get(nodeId)??0)>this.now()+250;});}
 get joinedAt(){return this.firstJoinServerTime;}
 private accept(value:unknown,sentAt?:number,join=false){
  this.check();validatePresenceSnapshot(value,this.projectId);
  const previous=this.view.snapshot;
  if(previous&&value.epoch!==previous.epoch){if(this.expiredEpochs.has(value.epoch))return;this.expiredEpochs.add(previous.epoch);}
  if(previous&&value.epoch===previous.epoch&&(compare(value.sequence,previous.sequence)<0||value.sequence===previous.sequence&&Date.parse(value.serverTime)<Date.parse(previous.serverTime)))return;
  const received=this.now(),server=Date.parse(value.serverTime);
  // A page's first acknowledged join is the server-clock baseline used to
  // distinguish an old refresh cursor from a genuinely active other page.
  if(join&&this.firstJoinServerTime===undefined)this.firstJoinServerTime=server;
  // A request's start is a conservative lower bound for serverTime. Using
  // receipt time would incorrectly extend a lease after a slow response.
  if(sentAt!==undefined)this.serverOffset=previous?.epoch===value.epoch&&this.serverOffset!==undefined?Math.min(this.serverOffset,sentAt-server):sentAt-server;
  const offset=this.serverOffset??received-server-1000;
  this.deadlines=new Map(value.leases.map(lease=>[lease.nodeId,Date.parse(lease.expiresAt)+offset]));
  this.memberDeadlines=new Map(value.members.map(member=>[member.clientId,Date.parse(member.lastSeenAt)+value.presenceTtlMs+offset]));
  this.view={status:'connected',snapshot:value};this.notify();
 }
 private failed(error:unknown){if(this.controller.signal.aborted||!this.current())return;this.view={...this.view,status:'offline',error:error instanceof Error?error.message:'协作连接暂时中断，正在重连。'};this.notify();}
 async start(){
  if(this.started)return this.joining??Promise.resolve();this.started=true;
  this.joining=this.post(true);this.heartbeatTimer=setInterval(()=>{void this.post().catch(error=>this.failed(error));},5000);
  let expiry='';this.expiryTimer=setInterval(()=>{const state=this.state(),key=JSON.stringify([state.snapshot?.members.map(member=>member.clientId),state.snapshot?.leases.map(lease=>lease.nodeId)]);if(key!==expiry){expiry=key;this.notify();}},250);
  try{await this.joining;this.check();void this.streamLoop();}catch(error){this.failed(error);void this.streamLoop();throw error;}finally{this.joining=null;}
 }
 setCursor(value:PresencePoint|null){if(!point(value))return;this.cursor=value;this.dirty=true;this.schedulePost();}
 setSelection(value:string[]){this.selected=nodes(value,10000).slice(0,32);this.dirty=true;this.schedulePost();}
 private schedulePost(){if(!this.started||this.postTimer||this.controller.signal.aborted)return;this.postTimer=setTimeout(()=>{this.postTimer=undefined;void this.post().catch(error=>this.failed(error));},Math.max(0,110-(this.now()-this.lastPost)));}
 private async post(join=false):Promise<void>{
  this.check();if(this.pendingPost){this.dirty=true;return this.pendingPost;}
  const request=(async()=>{this.dirty=false;this.lastPost=this.now();const sentAt=this.now();const result=await this.api.requestV2<CanvasPresenceSnapshot>(this.path('/presence'),{method:'POST',body:{clientId:this.clientId,cursor:this.cursor,selectedNodeIds:this.selected},signal:this.controller.signal});this.accept(result.data,sentAt,join);})();
  this.pendingPost=request;try{await request;}finally{if(this.pendingPost===request)this.pendingPost=null;if(this.dirty)this.schedulePost();}
 }
 async acquire(values:string[]):Promise<void>{
  const requested=nodes(values);if(!requested.length)return;this.check();
  if(!this.canEdit())throw new ApiError(403,'READ_ONLY','当前只有查看权限，不能占用或修改节点。');
  if(this.owns(requested))return;
  const key=requested.join('|'),existing=this.acquirePending.get(key);if(existing)return existing;
  const pending=(async()=>{
   if(!this.started)await this.start();else if(this.joining)await this.joining;else if(this.view.status==='offline')await this.post(true);
   this.check();const before=new Set(this.state().snapshot?.leases.filter(lease=>lease.clientId===this.clientId).map(lease=>lease.nodeId));
   const acquired:string[]=[];
   try{for(let index=0;index<requested.length;index+=32){const chunk=requested.slice(index,index+32),sentAt=this.now();const result=await this.api.requestV2<CanvasPresenceSnapshot>(this.path('/node-leases'),{method:'POST',body:{clientId:this.clientId,nodeIds:chunk},signal:this.controller.signal});this.accept(result.data,sentAt);acquired.push(...chunk.filter(nodeId=>!before.has(nodeId)));}this.check();if(!this.owns(requested))throw new ApiError(409,'NODE_LEASE_EXPIRED','节点占用已过期，请等待协作连接恢复后继续。');}
   catch(error){if(acquired.length)await this.release(acquired).catch(()=>{});throw error;}
  })();
  this.acquirePending.set(key,pending);try{await pending;}finally{if(this.acquirePending.get(key)===pending)this.acquirePending.delete(key);}
 }
 async release(values?:string[]){
  this.check();const requested=nodes(values??this.state().snapshot?.leases.filter(lease=>lease.clientId===this.clientId).map(lease=>lease.nodeId)??[]);
  for(let index=0;index<requested.length;index+=32){const sentAt=this.now();const result=await this.api.requestV2<CanvasPresenceSnapshot>(this.path('/node-leases'),{method:'DELETE',body:{clientId:this.clientId,nodeIds:requested.slice(index,index+32)},signal:this.controller.signal});this.accept(result.data,sentAt);}
 }
 private async pause(ms:number){const signal=this.controller.signal;await new Promise<void>(resolve=>{const timer=setTimeout(done,ms);function done(){clearTimeout(timer);signal.removeEventListener('abort',done);resolve();}signal.addEventListener('abort',done,{once:true});});this.check();}
 private async streamLoop(){
  let retry=500;
  while(!this.controller.signal.aborted&&this.current()){
   try{
    if(this.view.status==='offline')await this.post(true);
    if(this.polling&&this.quotaRetryAt!==undefined&&this.now()>=this.quotaRetryAt)this.polling=false;
    if(this.polling){const sentAt=this.now(),result=await this.api.requestV2<CanvasPresenceSnapshot>(this.path('/presence?'+new URLSearchParams({clientId:this.clientId})),{signal:this.controller.signal});this.accept(result.data,sentAt);await this.pause(1000);continue;}
    this.check();const response=await this.api.rawV2(this.path('/presence/events?'+new URLSearchParams({clientId:this.clientId})),{headers:{Accept:'text/event-stream'},signal:this.controller.signal});
    if(!response.ok){await this.api.decodeV2Response(response);throw invalid();}
    if(!response.headers.get('Content-Type')?.toLowerCase().startsWith('text/event-stream')||!response.body)throw invalid();
    const reader=response.body.getReader(),decoder=new TextDecoder(),abort=()=>{void reader.cancel();};this.controller.signal.addEventListener('abort',abort,{once:true});let buffer='',data:string[]=[],dataBytes=0,totalBytes=0,type='';
    try{
     for(;;){this.check();const result=await reader.read();this.check();if(result.done)break;totalBytes+=result.value.byteLength;if(totalBytes>16*1048576)throw invalid();buffer+=decoder.decode(result.value,{stream:true});if(buffer.length>2*1048576)throw invalid();
      for(;;){const end=buffer.indexOf('\n');if(end<0)break;let line=buffer.slice(0,end);buffer=buffer.slice(end+1);if(line.endsWith('\r'))line=line.slice(0,-1);
       if(!line){if(data.length){const value=JSON.parse(data.join('\n'));if(type==='presence.snapshot')this.accept(value);else if(type==='stream.error'){if(!Number.isInteger(value.status)||typeof value.code!=='string'||typeof value.message!=='string')throw invalid();throw new ApiError(value.status,value.code,value.message);}else throw invalid();}data=[];dataBytes=0;type='';}
       else if(line.startsWith('data:')){dataBytes+=line.length;if(dataBytes>2*1048576)throw invalid();data.push(line.slice(5).replace(/^ /,''));}else if(line.startsWith('event:'))type=line.slice(6).trim();
      }
     }
    }finally{this.controller.signal.removeEventListener('abort',abort);await reader.cancel().catch(()=>{});reader.releaseLock();}
    retry=500;this.quotaBackoff=2000;this.quotaRetryAt=undefined;this.view={...this.view,status:'reconnecting'};this.notify();await this.pause(100);
   }catch(error){if(this.controller.signal.aborted||!this.current())return;
    if(error instanceof ApiError&&error.status===429&&['PRESENCE_STREAM_LIMIT','EVENT_STREAM_LIMIT'].includes(error.code)){
     // A refresh can leave its old stream draining. Keep finite authenticated
     // polling while probing for a released slot, with a capped backoff.
     this.polling=true;this.quotaRetryAt=this.now()+this.quotaBackoff;this.quotaBackoff=Math.min(30000,this.quotaBackoff*2);this.view={...this.view,status:'reconnecting'};this.notify();continue;
    }
    if(error instanceof ApiError&&([406,415].includes(error.status)||error.status===501&&['PRESENCE_STREAM_AUTH_UNAVAILABLE','PRESENCE_STREAM_TRANSPORT_UNAVAILABLE','TRANSPORT_UNAVAILABLE'].includes(error.code))){this.polling=true;this.quotaRetryAt=undefined;this.view={...this.view,status:'reconnecting'};this.notify();continue;}
    this.failed(error);if(error instanceof ApiError&&[401,403,404,501].includes(error.status)){this.deadlines.clear();this.memberDeadlines.clear();this.view={status:'offline',snapshot:null,error:error.message};this.notify();if(error.status===401||error.status===403)this.api.reportV2Failure(error);return;}
    try{await this.pause(retry);}catch{return;}retry=Math.min(5000,retry*2);
   }
  }
 }
 stop(options:{release?:boolean}={}){
  if(this.controller.signal.aborted)return;
  if(options.release!==false&&this.sameIdentity())void this.api.requestV2(this.path('/presence/'+encodeURIComponent(this.clientId)),{method:'DELETE',keepalive:true}).catch(()=>{});
  this.controller.abort();if(this.heartbeatTimer)clearInterval(this.heartbeatTimer);if(this.expiryTimer)clearInterval(this.expiryTimer);if(this.postTimer)clearTimeout(this.postTimer);this.listeners.clear();this.acquirePending.clear();this.deadlines.clear();this.memberDeadlines.clear();this.view={status:'offline',snapshot:null};
 }
}
