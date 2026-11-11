import {ApiError} from '../api/client';
import {projectAccessDenied,retryableCanvasRead} from './project-access';
import {randomUuid} from '../browser-compat';
import type {ProductClient} from './product-client';

const accountProtocol='account-pages-v1';
const protocolHeader='X-STUDIO-Canvas-Protocol';
export interface EditRequest {drainRequired?:boolean;requestId:string; userId:string; displayName:string; sameAccount:boolean; expiresAt:string; retryAfterMs?:number}
interface Outgoing {requestId:string; state:'PENDING'|'DECLINED'|'TRANSFERRED'|'EXPIRED'|'CANCELED'; sameAccount?:boolean; availableAt?:string;retryAfterMs?:number}
interface EditStatus {protocol?:string;canJoin?:boolean;accountHandoff?:boolean;projectId:string; state:'FREE'|'HELD'|'OCCUPIED'|'SYNC_REQUIRED'; leaseId?:string; holder?:{userId:string;displayName:string;canApprove?:boolean}; incoming:EditRequest[]; outgoing?:Outgoing}
interface Receipt {protocol?:string;projectId:string;clientId:string;state:'HELD'|'SYNC_REQUIRED';leaseId:string;resumeToken?:string;expiresAt:string;expiresInMs?:number;ttlSeconds:30}
export interface PageEditState {
 status:'connecting'|'editing'|'occupied'|'offline'|'readonly'|'saving'|'syncing';
 message?:string; accountHandoff?:boolean; holder?:EditStatus['holder']; incoming?:EditRequest; outgoing?:Outgoing;
}
export interface HandoffHooks {
 foreground:()=>boolean;
 visible?:()=>boolean;
 beforeDrain:()=>boolean;
 prepare:(signal:AbortSignal,progress:()=>void)=>Promise<void>;
 sync:(signal:AbortSignal,progress:()=>void)=>Promise<number>;
 finish:(signal:AbortSignal,progress:()=>void)=>Promise<void>;
 recheckAccess?:(signal:AbortSignal)=>Promise<void>;
 resume:()=>Promise<string|undefined>;
 remember:(token:string)=>void;
 forgetResume?:()=>void;
 changed:()=>void;
 leaseChanged:(leaseId?:string)=>void;
}

const lost=()=>new ApiError(409,'STALE_CANVAS_SESSION','画布编辑连接已变更。');
const pending=()=>new ApiError(409,'CANVAS_SESSION_PENDING','画布正在连接，连接后可继续编辑。');
const permanent=(err:unknown)=>err instanceof ApiError&&projectAccessDenied(err)&&err.code!=='EDIT_REQUEST_NOT_FOUND';
const occupied=(err:unknown)=>err instanceof ApiError&&['PROJECT_EDIT_OCCUPIED','EDIT_SESSION_EXPIRED','STALE_EDIT_SESSION','CANVAS_SYNC_REQUIRED','EDIT_RESUME_INVALID'].includes(err.code);
const invalid=()=>new ApiError(502,'INVALID_EDIT_SESSION','暂时无法核实画布编辑权限。');
function untilCanceled<T>(job:Promise<T>,signal:AbortSignal):Promise<T>{
 return new Promise((resolve,reject)=>{
  const abort=()=>reject(signal.reason??lost());
  if(signal.aborted){abort();return;}
  signal.addEventListener('abort',abort,{once:true});
  job.then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));
 });
}

/** Only the server grants writing. Intent to edit is local to this document and
 * may be renewed by genuine foreground activation, never by a polling viewer. */
export class CanvasHandoffSession {
 readonly clientId=randomUuid();
 private view:PageEditState={status:'connecting'};
 private listeners=new Set<()=>void>();
 private term?:string;
 private writableTerm=false;
 private accountPages=false;
 private deadline=0;
 private renewAt=0;
 private stopped=false;
 private disconnected=false;
 private started=false;
 private wants=true;
 readonly pageProof=randomUuid();
 private requested?:string;
 private manualRequest?:{id:string;holder:string};
 private requestAutomatic=false;
 private lastRequestPost=0;
 private requestBegan=0;
 private task?:Promise<void>;
 private controller?:AbortController;
 private timer?:ReturnType<typeof setInterval>;
 private heartbeat?:AbortController;
 private nextPoll=0;
 private retryDelay=1000;
 private retryAt=0;
 private retryVacant=false;
 private visibleOpening=false;
 private deferred?:{id:string;at:number};
 private bufferedFocus=false;
 private pointerIntent=false;
 private checkPriorOwner=false;
 private needsAccessRecheck=false;
 private progress=new WeakMap<AbortSignal,()=>void>();

 constructor(readonly api:ProductClient,readonly projectId:string,readonly userId:string,private isCurrent:()=>boolean,
  private canEdit:()=>boolean,private sameIdentity:()=>boolean,private hooks:HandoffHooks,private now:()=>number=Date.now){}
 readonly current=()=>!this.stopped&&this.isCurrent()&&this.sameIdentity();
 state(){return this.view;}
 subscribe(listener:()=>void){this.listeners.add(listener);return()=>this.listeners.delete(listener);}
 private update(state:PageEditState){
  if(JSON.stringify(this.view)===JSON.stringify(state))return;
  this.view=state;for(const fn of this.listeners)fn();
 }
 ownsLease(){return this.current()&&this.canEdit()&&!this.disconnected&&!!this.term&&this.writableTerm&&this.deadline>this.now()+250;}
 holds(){return this.ownsLease()&&this.view.status==='editing';}
 permitsObservedRevision=()=>this.accountPages;
 editTenure(){return this.holds()?this.term:undefined;}
 readonly ensure=():Promise<void>=>this.holds()?Promise.resolve():Promise.reject(pending());
 readonly ensureForSave=():Promise<void>=>this.ownsLease()?Promise.resolve():Promise.reject(pending());

 private foreground(){return this.hooks.visible?.()!==false&&(this.hooks.foreground()||this.pointerIntent);}
 private path(){return '/projects/'+encodeURIComponent(this.projectId)+'/edit-session';}
 private check(signal:AbortSignal){
  if(!this.current()||this.disconnected||signal.aborted)throw signal.reason??lost();
  if(!this.canEdit())throw new ApiError(403,'READ_ONLY','当前账号只有查看权限。');
 }
 private async call<T>(suffix:string,method:string,body:unknown,signal:AbortSignal){
  this.check(signal);
  const result=await untilCanceled(this.api.requestV2<T>(this.path()+suffix,{method,body:method==='GET'?undefined:{...(body as object),pageProof:this.pageProof},signal,onReadProgress:this.progress.get(signal),headers:{[protocolHeader]:accountProtocol,'X-STUDIO-Canvas-Session':this.clientId,'X-STUDIO-Canvas-Proof':this.pageProof}}),signal);
  this.progress.get(signal)?.();
  this.check(signal);return result.data;
 }
 private clearTerm(){this.term=undefined;this.writableTerm=false;this.hooks.leaseChanged();this.deadline=0;this.heartbeat?.abort();this.heartbeat=undefined;}
 private release(term:string){
  if(!this.sameIdentity())return;
  void this.api.requestV2(this.path(),{method:'DELETE',headers:{[protocolHeader]:accountProtocol,'X-STUDIO-Canvas-Session':this.clientId,'X-STUDIO-Canvas-Proof':this.pageProof},body:{clientId:this.clientId,leaseId:term,pageProof:this.pageProof},keepalive:true,retryAuth:false}).catch(()=>{});
 }
 private noteReceipt(data:Receipt,sent:number){
  const lifetime=data?.expiresInMs===undefined?30000:data.expiresInMs;
  if(!Number.isSafeInteger(lifetime)||lifetime<0||lifetime>30000||data?.projectId!==this.projectId||data.clientId!==this.clientId||!data.leaseId||data.ttlSeconds!==30||
   !['SYNC_REQUIRED','HELD'].includes(data.state)||!Number.isFinite(Date.parse(data.expiresAt)))throw invalid();
  if(sent+lifetime<=this.now()+250)throw lost();
  this.term=data.leaseId;this.writableTerm=data.state==='HELD';this.deadline=sent+lifetime;this.renewAt=sent+10000;
  this.hooks.leaseChanged(this.writableTerm?this.term:undefined);
  if(data.protocol===accountProtocol)this.accountPages=true;
  if(!this.accountPages&&data.resumeToken&&data.state==='HELD')this.hooks.remember(data.resumeToken);
 }
 private problem(error:unknown){
  if(!this.current()||this.disconnected)return;
  // A missed read/heartbeat cannot revoke an already confirmed grant. Keep
  // its original deadline; every actual write still has to pass server fencing.
  if(this.holds()&&retryableCanvasRead(error)){
   this.nextPoll=this.now()+2000;
   return;
  }
  const handingOff=this.view.status==='saving';
  const opening=this.view.status==='syncing';
  const term=this.term,request=this.view.incoming;
  if(term)this.checkPriorOwner=true;
  this.clearTerm();
  if(opening&&term){
   // This document released its own unconfirmed opening. Its foreground intent
   // may still claim an empty canvas, but may never displace a new holder.
   this.retryVacant=this.wants&&this.foreground();
   this.release(term);
  }
  if(handingOff&&term&&request&&!request.drainRequired&&this.sameIdentity()){
   // A timed-out approval might already have committed. Only the server's
   // next observation can tell us who owns the canvas. The decision is fenced
   // by the old term. Keep the old page's operation queue available for replay.
   const decision=request.sameAccount?'DEFER':'DECLINE';
   const body={clientId:this.clientId,pageProof:this.pageProof,leaseId:term,decision};
   void this.api.requestV2(this.path()+'/requests/'+encodeURIComponent(request.requestId)+'/decision',{
    method:'POST',body,headers:{[protocolHeader]:accountProtocol,'X-STUDIO-Canvas-Session':this.clientId,'X-STUDIO-Canvas-Proof':this.pageProof},retryAuth:false,
   }).catch(()=>{});
  }
  if(permanent(error)){
   // A control route's denial fences this page immediately, but does not make
   // cached project access a permanent terminal state. Reconfirm authority
   // before attempting a new grant; actual revocation still remains read-only.
   this.needsAccessRecheck=(error as ApiError).status!==401;
   this.retryAt=this.now()+8000;this.nextPoll=this.retryAt;
   this.update({status:'readonly',message:(error as Error).message});return;
  }
  this.retryAt=this.now()+this.retryDelay;this.retryDelay=Math.min(8000,this.retryDelay*2);
  this.nextPoll=this.retryAt;
  const detail=error instanceof ApiError&&['CANVAS_VIEW_BUSY','CANVAS_SAVE_PENDING','CANVAS_NOT_READY','INVALID_OPERATION_RECEIPT'].includes(error.code)?error.message:undefined;
  this.update({status:'offline',message:detail??(handingOff?'正在确认上次交接的结果…':'正在重新连接画布…')});
 }

 /** All ownership transitions and decisions share one bounded sequence. A
  * separate, fenced renewal may run while the outgoing page flushes changes. */
 private run(work:(signal:AbortSignal)=>Promise<void>,queue=false):Promise<void>{
  if(!this.current()||this.disconnected)return Promise.reject(lost());
  if(this.task)return queue?this.task.catch(()=>{}).then(()=>this.run(work,true)):this.task;
  const ctl=new AbortController();this.controller=ctl;
  let timeout:ReturnType<typeof setTimeout>;
  const progress=()=>{clearTimeout(timeout);if(!ctl.signal.aborted)timeout=setTimeout(()=>ctl.abort(new ApiError(504,'EDIT_HANDOFF_TIMEOUT','画布连接暂未就绪。')),20000);};
  this.progress.set(ctl.signal,progress);progress();
  const job=untilCanceled(Promise.resolve().then(()=>{this.check(ctl.signal);return work(ctl.signal);}),ctl.signal)
   .catch(error=>{if(this.controller===ctl)this.problem(error);throw error;})
   .finally(()=>{clearTimeout(timeout);this.progress.delete(ctl.signal);if(this.controller===ctl){this.controller=undefined;this.task=undefined;}});
  this.task=job;return job;
 }
 private async acquire(signal:AbortSignal,token?:string){
  const sent=this.now();let receipt:Receipt;
  try{receipt=await this.call<Receipt>('','POST',{clientId:this.clientId,requireSync:true,...(token?{resumeToken:token}:{})},signal);}
  catch(error){if(occupied(error))return false;throw error;}
  this.noteReceipt(receipt,sent);
  await this.accept(signal,true);return true;
 }
 private async accept(signal:AbortSignal,initial=false){
  const term=this.term;
  if(!term)throw invalid();
  // An auto-request which completed after blur must not steal writing from
  // the window in front. A recipient explicitly approved by a colleague keeps its grant.
  const releaseIfInactive=()=>{
   if(this.accountPages||!(initial||this.requestAutomatic)||this.foreground())return false;
   this.clearTerm();this.release(term);this.wants=false;this.requested=undefined;this.update({status:'occupied'});return true;
  };
  if(releaseIfInactive())return;
  this.update({status:'syncing',message:'正在更新到最新画布…'});
  for(let attempt=0;attempt<3;attempt++){
   const revision=await untilCanceled(this.hooks.sync(signal,()=>this.progress.get(signal)?.()),signal);this.check(signal);this.progress.get(signal)?.();
   if(!Number.isSafeInteger(revision)||revision<1)throw invalid();
   if(releaseIfInactive())return;
   if(this.writableTerm)break;
   try{
    const sent=this.now(),r=await this.call<Receipt>('/ready','POST',{clientId:this.clientId,leaseId:term,revision},signal);
    if(r?.leaseId!==term||r.state!=='HELD')throw invalid();
    this.noteReceipt(r,sent);break;
   }catch(error){if(!(error instanceof ApiError&&error.code==='CANVAS_SYNC_REQUIRED'&&attempt<2))throw error;}
  }
  await untilCanceled(this.hooks.finish(signal,()=>this.progress.get(signal)?.()),signal);this.check(signal);this.progress.get(signal)?.();
  if(!this.ownsLease())throw lost();
  if(releaseIfInactive())return;
  this.wants=true;this.pointerIntent=false;this.checkPriorOwner=false;this.requested=undefined;this.manualRequest=undefined;this.requestAutomatic=false;this.visibleOpening=false;this.retryVacant=false;this.retryAt=0;this.retryDelay=1000;
  this.update({status:'editing'});this.hooks.changed();
 }
 private validate(status:EditStatus){
  if(status?.projectId!==this.projectId||!['FREE','HELD','OCCUPIED','SYNC_REQUIRED'].includes(status.state)||
   !Array.isArray(status.incoming??[])||status.incoming?.some(i=>!i||!i.requestId||typeof i.displayName!=='string'||typeof i.sameAccount!=='boolean'))throw invalid();
  if(status.protocol!==undefined&&status.protocol!==accountProtocol)throw invalid();
  if(status.protocol===accountProtocol)this.accountPages=true;
  if(status.state==='OCCUPIED'&&!status.holder?.userId&&!(this.accountPages&&status.accountHandoff))throw invalid();
  return status;
 }
 private async sendRequest(id:string,signal:AbortSignal,onlyIfFree=false){
  if(!this.requestBegan)this.requestBegan=this.now();
  this.lastRequestPost=this.now();
  const status=this.validate(await this.call<EditStatus>('/requests','POST',{clientId:this.clientId,requestId:id,...(onlyIfFree?{onlyIfFree:true}:{})},signal));
  if(onlyIfFree&&status.state==='OCCUPIED'&&status.outgoing?.requestId!==id){
   // The reservation raced another live writer. Observing FREE grants no
   // permission to request that newly occupied canvas.
   this.wants=false;this.pointerIntent=false;this.visibleOpening=false;
   this.requested=undefined;this.requestAutomatic=false;
  }
  if(this.requestAutomatic&&(!this.foreground()||!this.wants)&&status.state==='OCCUPIED'){
   await this.cancelOutgoing(id,signal);return;
  }
  await this.apply(status,signal,false);
 }
 private async cancelOutgoing(id:string,signal:AbortSignal){
  this.pointerIntent=false;this.requested=undefined;this.manualRequest=undefined;
  const status=this.validate(await this.call<EditStatus>('/requests/'+encodeURIComponent(id),'DELETE',{clientId:this.clientId},signal));
  await this.apply(status,signal,false);
 }
 // The account owns editing; each browser document needs its own confirmed
 // lease. Joining a sibling never asks it to drain, release or transfer.
 private async accountViewer(status:EditStatus,signal:AbortSignal,allowAction:boolean){
  if(this.term)this.clearTerm();
  this.checkPriorOwner=false;this.visibleOpening=false;
  if(status.accountHandoff){
   this.wants=false;this.update({status:'occupied',accountHandoff:true,holder:status.holder,message:'正在等待各页面保存修改并交接。'});return;
  }
  const outgoing=status.outgoing;
  if(outgoing?.state==='PENDING'){
   this.requested=outgoing.requestId;
   this.update({status:'occupied',holder:status.holder,outgoing,message:'已申请编辑，等待对方保存并交接。'});
   if(allowAction&&this.now()-this.lastRequestPost>=2000){
    this.requestAutomatic=false;
    await this.sendRequest(outgoing.requestId,signal);
   }
   return;
  }
  this.requested=undefined;this.requestAutomatic=false;
  if(status.state==='FREE'&&allowAction&&(status.canJoin||this.wants&&this.hooks.visible?.()!==false||this.foreground()&&this.pointerIntent)){
   if(await this.acquire(signal))return;
   // The account could have changed between observing and joining.
   this.nextPoll=this.now()+500;this.update({status:'connecting'});return;
  }
  if(status.state==='OCCUPIED')this.wants=false;
  this.update({status:'occupied',holder:status.holder,outgoing});
 }
 private async apply(status:EditStatus,signal:AbortSignal,allowAction:boolean){
  this.check(signal);
  if(status.state==='HELD'||status.state==='SYNC_REQUIRED'){
   if(!status.leaseId)throw invalid();
   if(status.state==='SYNC_REQUIRED'||!this.holds()||this.term!==status.leaseId){
    if(this.term!==status.leaseId)this.clearTerm();
    this.term=status.leaseId;this.writableTerm=false;this.hooks.leaseChanged();
    // GET proves ownership, but only a timed POST establishes a usable local deadline.
    if(status.state==='HELD'){
     const sent=this.now(),r=await this.call<Receipt>('','POST',{clientId:this.clientId,leaseId:this.term},signal);
     if(r?.leaseId!==this.term)throw lost();this.noteReceipt(r,sent);
    }
    await this.accept(signal);return;
   }
   if(this.accountPages){
    const incoming=status.incoming?.find(i=>!i.sameAccount);
    if(incoming?.drainRequired){
     this.update({status:'editing',incoming,accountHandoff:true,message:'正在保存本页修改并交接。'});
     if(allowAction&&this.hooks.beforeDrain())await this.decide(incoming,'APPROVE',signal,true);
    }else this.update({status:'editing',incoming});
    return;
   }
   const incoming=(status.incoming??[]).find(i=>i.sameAccount)??status.incoming?.[0];
   if(incoming?.sameAccount&&allowAction){
    if(!this.hooks.beforeDrain()){
     this.update({status:'editing',incoming,message:'当前操作结束后会自动切换到另一页。'});
     if(this.deferred?.id!==incoming.requestId||this.now()-this.deferred.at>=10000){
      this.deferred={id:incoming.requestId,at:this.now()};
      await this.defer(incoming,signal);
     }
     return;
    }
    this.update({status:'editing',incoming});
    await this.decide(incoming,'APPROVE',signal,true);return;
   }
   this.update({status:'editing',incoming});
   return;
  }
  if(this.accountPages){await this.accountViewer(status,signal,allowAction);return;}
  // The server can have expired or transferred our lease even if our timer
  // was throttled. No background retry may turn that loss into a fresh claim.
  if(this.visibleOpening){
   if(status.state==='FREE'&&this.hooks.visible?.()){
    this.pointerIntent=true;this.wants=true;
   }else{
    this.visibleOpening=false;this.pointerIntent=false;this.wants=this.foreground();
   }
  }
  const previousWriter=!!this.term||this.checkPriorOwner;
  const retryOpening=this.retryVacant&&this.wants&&status.state==='FREE'&&this.foreground();
  this.retryVacant=false;
  const recoverExpired=previousWriter&&!retryOpening&&this.wants&&status.state==='FREE'&&allowAction&&this.foreground();
  if(previousWriter){
   this.hooks.forgetResume?.();this.clearTerm();
   if(!retryOpening){this.wants=false;this.pointerIntent=false;}
  }
  this.checkPriorOwner=false;
  const previous=this.requested,out=status.outgoing;
  if(out?.state==='PENDING'){
   this.requested=out.requestId;
   if(typeof out.sameAccount==='boolean')this.requestAutomatic=out.sameAccount;
   this.update({status:'occupied',holder:status.holder,outgoing:out,message:'已申请编辑，正在等待交接。'});
   if(!allowAction)return;
   if(this.requestAutomatic&&(!this.foreground()||!this.wants)){await this.cancelOutgoing(out.requestId,signal);return;}
   const serverTime=Date.parse(out.availableAt??'');
   const localGrace=(this.requestBegan||this.now())+30000;
   const available=Number.isFinite(serverTime)?Math.min(serverTime,localGrace):localGrace;
   const due=typeof out.retryAfterMs==='number'&&Number.isFinite(out.retryAfterMs)?out.retryAfterMs<=0:this.now()>=available;
   if(status.state==='FREE'||(this.requestAutomatic&&due&&this.now()-this.lastRequestPost>=2000))await this.sendRequest(out.requestId,signal);
   return;
  }
  if(!retryOpening&&previous&&out?.requestId===previous){
   // A waiting foreground tab may return after the application and holder
   // have both expired. Cancellation or a superseding tab must still win.
   const expiredWait=this.requestAutomatic&&out.state==='EXPIRED'&&status.state==='FREE'&&this.wants&&this.foreground();
   if(!expiredWait){this.wants=false;this.pointerIntent=false;}
   this.requested=undefined;this.requestAutomatic=false;
  }
  const same=status.holder?.userId===this.userId;
  if(!same&&status.state==='OCCUPIED')this.wants=false;
  const mine=out&&this.manualRequest?.id===out.requestId&&this.manualRequest.holder===status.holder?.userId;
  const message=same||!mine?undefined:out?.state==='DECLINED'?'对方暂未同意，你可以继续查看或再次申请。':out?.state==='EXPIRED'?'上次申请已过期，可以重新申请。':undefined;
  if(recoverExpired){
   // A sleeping writer may find the canvas already free after somebody else
   // took it and left. The normal acquisition refuses retired pages. Only a
   // subsequent real activation can make a new explicit /requests claim.
   if(await this.acquire(signal))return;
  }
  if(!allowAction||!this.wants||!this.foreground()){
   this.update({status:'occupied',holder:status.holder,outgoing:out,message});return;
  }
  if(status.state==='FREE'){
   // A retired document can obtain a new term only through an explicit
   // request. Polling after demotion leaves wants=false until reactivation.
   this.requestBegan=this.now();this.requested=randomUuid();this.requestAutomatic=true;
   await this.sendRequest(this.requested,signal,true);return;
  }
  if(same){this.requestBegan=this.now();this.requested=randomUuid();this.requestAutomatic=true;await this.sendRequest(this.requested,signal);return;}
  this.update({status:'occupied',holder:status.holder,outgoing:out,message});
 }
 private inspect=async(signal:AbortSignal)=>{
  if(this.needsAccessRecheck){await untilCanceled(this.hooks.recheckAccess?.(signal)??Promise.resolve(),signal);this.check(signal);this.needsAccessRecheck=false;this.progress.get(signal)?.();}
  if(!this.canEdit()){this.clearTerm();this.update({status:'readonly',message:'当前账号只有查看权限。'});return;}
  const status=this.validate(await this.call<EditStatus>('','GET',undefined,signal));
  await this.apply(status,signal,true);
  this.retryAt=0;this.retryDelay=1000;
 };
 private defer(req:EditRequest,signal:AbortSignal){
  return this.call('/requests/'+encodeURIComponent(req.requestId)+'/decision','POST',{clientId:this.clientId,leaseId:this.term,decision:'DEFER'},signal);
 }
 private async decide(req:EditRequest,decision:'APPROVE'|'DECLINE',signal:AbortSignal,prepared=false){
  if(!this.holds()||this.view.incoming?.requestId!==req.requestId)return;
  const leaseId=this.term;
  if(decision==='APPROVE'){
   if(!prepared&&!this.hooks.beforeDrain()){
    this.update({...this.view,message:'请先结束拖动或文字输入，再同意交接。'});return;
   }
   this.bufferedFocus=false;
   this.update({status:'saving',incoming:req,message:'正在保存修改，完成后会交出编辑权…'});
   // A resumed device can first observe a request late in its grace period.
   // Protect its final save from a simultaneous same-account forced takeover.
   if(req.sameAccount&&(req.retryAfterMs??0)<20000)await this.defer(req,signal);
   await untilCanceled(this.hooks.prepare(signal,()=>this.progress.get(signal)?.()),signal);this.check(signal);this.progress.get(signal)?.();
   if(!this.ownsLease()||this.term!==leaseId)throw lost();
   this.wants=false;
  }
  const status=this.validate(await this.call<EditStatus>('/requests/'+encodeURIComponent(req.requestId)+'/decision','POST',{clientId:this.clientId,leaseId,decision},signal));
  this.deferred=undefined;
  if(decision==='APPROVE'&&status.state==='HELD'&&status.leaseId===leaseId&&this.ownsLease()){
   // The recipient canceled while our final edits were being confirmed.
   this.wants=true;this.update({status:'editing'});
  }else if(decision==='APPROVE'){
   this.hooks.forgetResume?.();this.manualRequest=undefined;this.clearTerm();this.hooks.changed();
   if(this.bufferedFocus){this.bufferedFocus=false;this.wants=this.foreground();}else this.pointerIntent=false;
  }
  await this.apply(status,signal,false);
 }
 requestEdit(){return this.run(async signal=>{
  if(!this.canEdit()||this.holds())return;
  this.checkPriorOwner=false;this.retryAt=0;this.wants=true;this.pointerIntent=true;
  if(this.view.accountHandoff)return;
  if(!this.view.holder){await this.inspect(signal);return;}
  this.requestAutomatic=!this.accountPages&&this.view.holder.userId===this.userId;this.requestBegan=this.now();
  this.requested=this.view.outgoing?.state==='PENDING'?this.view.outgoing.requestId:randomUuid();
  this.manualRequest=this.requestAutomatic?undefined:{id:this.requested,holder:this.view.holder.userId};
  await this.sendRequest(this.requested,signal);
 },true);}
 cancelRequest(){return this.run(async signal=>{this.wants=false;const id=this.requested;if(id)await this.cancelOutgoing(id,signal);},true);}
 decision(choice:'APPROVE'|'DECLINE'){const req=this.view.incoming;if(!req)return Promise.resolve();return this.run(signal=>this.decide(req,choice,signal),true);}
 private renew(){
  if(!this.term||this.heartbeat)return;
  const term=this.term,ctl=new AbortController(),sent=this.now();this.heartbeat=ctl;
  const timeout=setTimeout(()=>ctl.abort(new ApiError(504,'CANVAS_RENEW_TIMEOUT','画布连接暂未收到响应。')),5000);
  void this.call<Receipt>('','POST',{clientId:this.clientId,leaseId:term},ctl.signal).then(r=>{
   if(this.heartbeat!==ctl||this.term!==term)return;
   // /ready may have completed while an earlier admission heartbeat was in
   // flight. Its old SYNC_REQUIRED receipt cannot demote the confirmed grant.
   if(r?.leaseId===term&&r.state==='SYNC_REQUIRED'&&this.writableTerm)return;
   if(r?.leaseId!==term||!['HELD','SYNC_REQUIRED'].includes(r.state))throw invalid();
   this.noteReceipt(r,sent);
  }).catch(error=>{
   if(this.heartbeat!==ctl||this.term!==term)return;
   if(this.deadline>this.now()+250&&retryableCanvasRead(error)){this.renewAt=this.now()+2000;return;}
   this.invalidate(error);
  }).finally(()=>{
   clearTimeout(timeout);if(this.heartbeat===ctl)this.heartbeat=undefined;
  });
 }
 private tick=()=>{
  if(!this.started||!this.current()||this.disconnected||this.view.status==='readonly'&&(!this.needsAccessRecheck||!this.canEdit()))return;
  if(this.term&&this.deadline>0&&this.deadline<=this.now()+250){this.invalidate(lost());return;}
  if(this.term&&this.deadline>0&&this.now()>=this.renewAt)this.renew();
  if(!this.task&&this.now()>=Math.max(this.nextPoll,this.retryAt)){
   this.nextPoll=this.now()+(this.view.outgoing?.state==='PENDING'||this.holds()?1500:2500);
   void this.run(this.inspect).catch(()=>{});
  }
 };
 start(){
  if(this.started)return this.task??this.ensure();
  this.started=true;this.timer=setInterval(this.tick,500);
  this.wants=this.foreground();this.visibleOpening=!this.wants&&this.hooks.visible?.()===true;this.nextPoll=this.now()+1500;
  return this.run(async signal=>{
   if(!this.canEdit()){this.update({status:'readonly',message:'当前账号只有查看权限。'});return;}
   const observed=this.validate(await this.call<EditStatus>('','GET',undefined,signal));
   if(this.accountPages){this.wants=this.hooks.visible?.()!==false;await this.apply(observed,signal,true);return;}
   const token=await this.hooks.resume();this.check(signal);
   if(this.visibleOpening&&token&&this.hooks.visible?.()){
    // A freshly reloaded embedded tab can be visible before the host reports
    // focus. Its exclusive per-tab receipt can resume that exact page. If the
    // old DELETE won the race, acquire only when the server shows FREE.
    this.pointerIntent=true;this.wants=true;
    if(await this.acquire(signal,token))return;
    const status=this.validate(await this.call<EditStatus>('','GET',undefined,signal));
    if(status.state==='FREE'&&this.pointerIntent&&this.hooks.visible()){
     if(await this.acquire(signal))return;
    }
    this.pointerIntent=false;this.visibleOpening=false;this.wants=this.foreground();await this.inspect(signal);return;
   }
   if(!this.wants){await this.apply(observed,signal,true);return;}
   if(!await this.acquire(signal,token))await this.inspect(signal);
  });
 }
 activate(trustedPointer=false){
  if(!this.current()||this.holds())return;
  // Embedded browsers can deliver real pointer input while reporting that the
  // document has no focus. Keep this intent just through the requested switch.
  if(trustedPointer)this.pointerIntent=true;
  if(!this.foreground())return;
  if(this.view.status==='saving'){this.bufferedFocus=true;return;}
  this.checkPriorOwner=false;
  this.wants=true;
  this.wake();
 }
 background(){
  this.visibleOpening=false;this.retryVacant=false;this.pointerIntent=false;this.bufferedFocus=false;
  if(!this.accountPages&&(this.requestAutomatic||(!this.requested&&!this.holds())))this.wants=false;
  this.wake();
 }
 wake(){if(!this.current()||this.disconnected)return;this.nextPoll=0;this.tick();}
 retry(){this.checkPriorOwner=false;this.pointerIntent=this.hooks.visible?.()!==false;this.retryAt=0;this.wants=this.foreground();this.disconnected=false;this.nextPoll=0;return this.run(this.inspect,true);}
 private interrupt(){this.controller?.abort(lost());this.controller=undefined;this.task=undefined;this.clearTerm();}
 invalidate(error?:unknown){
  if(!this.current())return;
  if(this.term)this.checkPriorOwner=true;
  this.pointerIntent=false;this.bufferedFocus=false;this.interrupt();this.problem(error??lost());
  if(this.accountPages){if(error instanceof ApiError&&error.code==='PROJECT_EDIT_OCCUPIED')this.wants=false;}
  else if(occupied(error))this.wants=false;
 }
 offline(){if(!this.current())return;this.checkPriorOwner=this.checkPriorOwner||!!this.term;this.pointerIntent=false;this.bufferedFocus=false;this.disconnected=true;this.interrupt();this.update({status:'offline',message:'网络已断开，恢复后会自动连接。'});}
 online(){if(!this.current())return;if(this.view.status==='readonly'&&this.canEdit())this.update({status:'connecting'});this.disconnected=false;this.retryAt=0;this.nextPoll=0;this.tick();}
 stop(){
  if(this.stopped)return;const term=this.term,id=this.requested;
  this.stopped=true;this.interrupt();clearInterval(this.timer);this.listeners.clear();
  if(term)this.release(term);
  if(id&&this.sameIdentity())void this.api.requestV2(this.path()+'/requests/'+encodeURIComponent(id),{method:'DELETE',body:{clientId:this.clientId,pageProof:this.pageProof},headers:{[protocolHeader]:accountProtocol,'X-STUDIO-Canvas-Session':this.clientId,'X-STUDIO-Canvas-Proof':this.pageProof},keepalive:true,retryAuth:false}).catch(()=>{});
 }
}
