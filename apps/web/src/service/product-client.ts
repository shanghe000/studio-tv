import {ApiClient,ApiError,type ApiResult,type RequestOptions} from '../api/client';

import {CanvasRoom} from './canvas-room';

export interface V2RequestOptions extends RequestOptions {
 /** Headers accepted, then each nonempty body chunk. For idle deadlines. */
 onReadProgress?:()=>void;
}

/** One transport and memory-only session for both STUDIO API versions. */
export class ProductClient extends ApiClient {
 private epoch=0;
 private canvasSessions=new Map<string,{id:string;proof?:string;lease?:string}>();
 private readonly rooms=new Map<string,CanvasRoom>();
 private readonly pending=new Set<AbortController>();
 private readonly responseContexts=new WeakMap<Response,{epoch:number;signal?:AbortSignal|null}>();
 private revoked:((error?:ApiError)=>void)|null=null;
 private productRefresh:(()=>Promise<boolean>)|null=null;
 override onRefresh(callback:()=>Promise<boolean>){this.productRefresh=callback;}
 /** Agent credentials use the same serialized refresh manager as ordinary
  * requests. A changed login must never supply credentials to an old run. */
 async refreshAccess(signal?:AbortSignal):Promise<boolean>{
  const scope=this.scoped(signal);
  try{scope.check();if(!this.getAccessToken())throw new ApiError(401,'UNAUTHORIZED','请先使用飞书登录。');if(!this.productRefresh)return false;const restored=await this.productRefresh();scope.check();return restored;}
  finally{scope.release();}
 }
 onRevoked(callback:(error?:ApiError)=>void){this.revoked=callback;}
 reportV2Failure(error:ApiError){if(error.status===401||error.status===403&&/TOOL_ACCESS|ACCESS_REVOKED|AUTHORIZATION_DENIED|IPAC_PERMISSION_DENIED|ACCOUNT_DISABLED|FEISHU_IDENTITY_REQUIRED/.test(error.code))this.revoked?.(error);}
 async decodeV2Response<T>(response:Response,signal?:AbortSignal|null,onReadProgress?:()=>void){
  const context=this.responseContexts.get(response),epoch=context?.epoch??this.epoch,scope=this.scoped(context?.signal);
  const abort=()=>scope.controller.abort(signal?.reason);
  if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});
  try{return await this.decodeV2<T>(response,epoch,scope.controller.signal,onReadProgress);}
  finally{signal?.removeEventListener('abort',abort);scope.release();}
 }
 setCanvasSession(projectId:string,clientId:string|null,pageProof?:string,leaseId?:string){
  if(!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/.test(projectId)||clientId!==null&&!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/.test(clientId))throw new ApiError(400,'INVALID_CANVAS_SESSION','画布协作会话无效。');
  if(pageProof!==undefined&&!/^[A-Za-z0-9_-]{32,96}$/.test(pageProof))throw new ApiError(400,'INVALID_CANVAS_SESSION','画布页面凭据无效。');
  if(leaseId!==undefined&&!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/.test(leaseId))throw new ApiError(400,'INVALID_CANVAS_SESSION','画布编辑任期无效。');
  if(clientId===null)this.canvasSessions.delete(projectId);else this.canvasSessions.set(projectId,{id:clientId,proof:pageProof,lease:leaseId});
 }
 private canvasHeaders(path:string,options:RequestOptions|RequestInit){
  const headers=new Headers(options.headers),method=String(options.method||'GET').toUpperCase();
  if(['GET','HEAD','OPTIONS'].includes(method))return headers;
  const match=path.match(/^\/projects\/([^/?]+)(?:\/|$)/);let projectId=match?decodeURIComponent(match[1]):undefined;
  let body:any=options.body;
  if(typeof body==='string'&&body.startsWith('{'))try{body=JSON.parse(body);}catch{/* The request decoder owns malformed JSON. */}
  if(!projectId&&body&&typeof body==='object'&&typeof body.projectId==='string')projectId=body.projectId;
  if(!projectId&&/^\/longform\/projects(?:\/|$)/.test(path)&&body&&typeof body==='object'&&typeof body.canvasId==='string')projectId=body.canvasId;
  // A late control request can outlive its original page or edit term. Only
  // the control API may retain an explicit page and term bound to its own body.
  const control=/^\/projects\/[^/?]+\/edit-session(?:\/ready|\/requests(?:\/[^/?]+(?:\/decision)?)?)?$/.test(path);
  if(control&&headers.has('X-STUDIO-Canvas-Session')){
   const id=headers.get('X-STUDIO-Canvas-Session'),proof=headers.get('X-STUDIO-Canvas-Proof'),lease=headers.get('X-STUDIO-Canvas-Lease');
   if(!id||id!==body?.clientId||!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/.test(id)){
    headers.delete('X-STUDIO-Canvas-Session');headers.delete('X-STUDIO-Canvas-Proof');headers.delete('X-STUDIO-Canvas-Lease');
    return headers;
   }
   if(proof&&(proof!==body?.pageProof||!/^[A-Za-z0-9_-]{32,96}$/.test(proof)))headers.delete('X-STUDIO-Canvas-Proof');
   if(body?.leaseId&&(!lease||lease===body.leaseId)&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/.test(body.leaseId))headers.set('X-STUDIO-Canvas-Lease',body.leaseId);
   else headers.delete('X-STUDIO-Canvas-Lease');
   return headers;
  }
  // These endpoints look up the actual project by an opaque task, conversation
  // or execution ID on the server. Supply this page's writer for its request.
  const indirect=/^\/(?:assistant\/)?conversations\//.test(path)
   || /^\/agent-runs\/[^/?]+\/(?:auth-context|cancel)$/.test(path)
   || /^(?:\/(?:tasks|media-jobs|assistant-runs)\/[^/?]+\/cancel|\/history\/delete|\/history\/[^/?]+\/outputs\/[^/?]+)$/.test(path);
  if(!projectId&&indirect){
   headers.delete('X-STUDIO-Canvas-Session');headers.delete('X-STUDIO-Canvas-Proof');headers.delete('X-STUDIO-Canvas-Lease');
   if(this.canvasSessions.size===1)projectId=this.canvasSessions.keys().next().value;
  }
  if(projectId){
   const page=this.canvasSessions.get(projectId);
   if(page)headers.set('X-STUDIO-Canvas-Session',page.id);else headers.delete('X-STUDIO-Canvas-Session');
   if(page?.proof)headers.set('X-STUDIO-Canvas-Proof',page.proof);else headers.delete('X-STUDIO-Canvas-Proof');
   if(page?.lease)headers.set('X-STUDIO-Canvas-Lease',page.lease);else headers.delete('X-STUDIO-Canvas-Lease');
  }
  return headers;
 }
 openCanvasRoom(id:string,after:string,signal:AbortSignal){
  const token=this.getAccessToken();
  if(!token)return null;
  const room=CanvasRoom.open(id,token,after,signal);
  if(room){this.rooms.get(id)?.close();this.rooms.set(id,room);}
  return room;
 }
 releaseCanvasRoom(id:string,room:CanvasRoom){
  if(this.rooms.get(id)===room)this.rooms.delete(id);
  room.close();
 }
 clearRequests(){this.epoch++;for(const room of this.rooms.values())room.close();this.rooms.clear();for(const controller of this.pending)controller.abort();this.pending.clear();this.canvasSessions.clear();}
 private scoped(signal?:AbortSignal|null){
  const controller=new AbortController(),epoch=this.epoch;
  const abort=()=>controller.abort(signal?.reason);
  if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});
  this.pending.add(controller);
  return{controller,check:()=>{if(epoch!==this.epoch||controller.signal.aborted)throw new ApiError(401,'SESSION_CHANGED','登录状态已变更，本次操作已取消。');},release:()=>{signal?.removeEventListener('abort',abort);this.pending.delete(controller);}};
 }
 override async request<T>(path:string,options:RequestOptions={}):Promise<ApiResult<T>>{
  // A refreshed login may retry this request after an editing handoff. Keep
  // the original page proof with the original mutation, like the v2 transport.
  const scope=this.scoped(options.signal),headers=this.canvasHeaders(path,options);let usedToken=this.getAccessToken();
  const request=()=>{usedToken=this.getAccessToken();return super.request<T>(path,{...options,headers,retryAuth:false,signal:scope.controller.signal});};
  try{let result:ApiResult<T>;try{result=await request();}catch(error){scope.check();if(error instanceof ApiError&&error.status===401&&!options.anonymous&&options.retryAuth!==false){const current=this.getAccessToken(),restored=current&&current!==usedToken?true:this.productRefresh?await this.productRefresh():false;scope.check();if(!restored)throw error;result=await request();}else throw error;}scope.check();return result;}
  catch(error){scope.check();const refreshCollision=options.anonymous&&['/auth/sessions/refresh','/auth/refresh'].includes(path)&&error instanceof ApiError&&error.status===401&&error.code==='REFRESH_RACE_RETRY';if(!refreshCollision&&error instanceof ApiError&&(error.status===401||error.status===403&&['IPAC_PERMISSION_DENIED','ACCOUNT_DISABLED','FEISHU_IDENTITY_REQUIRED'].includes(error.code)))this.revoked?.(error);throw error;}
  finally{scope.release();}
 }
 private v2(path:string){
  if(!path.startsWith('/')||path.startsWith('//')||/[\\#]/.test(path)||new URL('/api/v2'+path,'https://studio.invalid').pathname.indexOf('/api/v2/')!==0)throw new Error('STUDIO v2 API path must be relative');
  return '/api/v2'+path;
 }
 async requestV2<T>(path:string,options:V2RequestOptions={}):Promise<ApiResult<T>>{
  const epoch=this.epoch;
  const {body,idempotencyKey,etag,anonymous=false,retryAuth: _retry,onReadProgress,...init}=options;
  if(anonymous)throw new ApiError(401,'UNAUTHORIZED','请先使用飞书登录。');
  const headers=new Headers(init.headers);
  if(body!==undefined)headers.set('Content-Type','application/json');
  if(idempotencyKey)headers.set('Idempotency-Key',idempotencyKey);
  if(etag)headers.set('If-Match',etag);
  const project=init.method==='POST'&&this.rooms.size&&/^\/projects\/([A-Za-z0-9_.:-]+)\/canvas-operations$/.exec(path);
  if(project){
   const id=project[1],page=this.canvasSessions.get(id),batch=body as {clientId?:string;batchId?:string}|undefined;
   if(page?.proof&&page.lease&&batch?.clientId===page.id&&batch.batchId){
    const base=headers.get('X-STUDIO-Canvas-Receipt')==='delta-v1'?Number(headers.get('X-STUDIO-Canvas-Base')):undefined;
    const request=this.rooms.get(id)?.write(body,{proof:page.proof,lease:page.lease},base,init.signal);
    if(request){
     const result=await request;
     if(epoch!==this.epoch)throw new ApiError(401,'SESSION_CHANGED','登录状态已变更，本次操作已取消。');
     init.signal?.throwIfAborted();
     if(result&&result.status!==401)return this.decodeEnvelope<T>(result.body,result.status,result.etag);
     // WebSocket may have committed the batch before its response was lost.
     // A different page/tenure must never inherit this in-flight write.
     const active=this.canvasSessions.get(id);
     if(!active||active.id!==page.id||active.proof!==page.proof||active.lease!==page.lease)
      throw new ApiError(409,'EDIT_SESSION_EXPIRED','画布编辑连接正在恢复。');
    }
   }
  }
  const response=await this.rawV2(path,{...init,headers,body:body===undefined?undefined:JSON.stringify(body),retryAuth:_retry});
  return this.decodeV2<T>(response,epoch,init.signal,onReadProgress);
 }
 /** Only extension routes whose contract declares a raw DTO use this method.
  * Envelope APIs keep their strict decoder; no shape-based fallback is used. */
 async requestRawJsonV2<T>(path:string,options:RequestOptions={}):Promise<ApiResult<T>>{
  const epoch=this.epoch,{body,idempotencyKey,etag,anonymous=false,retryAuth,onReadProgress,...init}=options;
  if(anonymous)throw new ApiError(401,'UNAUTHORIZED','请先使用飞书登录。');
  const headers=new Headers(init.headers);if(body!==undefined)headers.set('Content-Type','application/json');if(idempotencyKey)headers.set('Idempotency-Key',idempotencyKey);if(etag)headers.set('If-Match',etag);
  const response=await this.rawV2(path,{...init,headers,body:body===undefined?undefined:JSON.stringify(body),retryAuth});
  if(!response.ok)return this.decodeV2<T>(response,epoch,init.signal,onReadProgress);
  let data:T;if(response.status===204)data=undefined as T;else try{data=await this.readJson(response,epoch,init.signal,onReadProgress) as T;}catch{this.checkResponse(epoch,init.signal);throw new ApiError(502,'INVALID_RESPONSE','服务器返回了无法识别的响应。');}
  this.checkResponse(epoch,init.signal);
  return{data,etag:response.headers.get('ETag'),status:response.status};
 }
 async multipartV2<T>(path:string,body:FormData,idempotencyKey:string,signal?:AbortSignal):Promise<ApiResult<T>>{
  const epoch=this.epoch,response=await this.rawV2(path,{method:'POST',body,signal,headers:{'Idempotency-Key':idempotencyKey}});
  return this.decodeV2<T>(response,epoch,signal);
 }
 private checkResponse(epoch:number,signal?:AbortSignal|null){
  if(epoch!==this.epoch)throw new ApiError(401,'SESSION_CHANGED','登录状态已变更，本次操作已取消。');
  signal?.throwIfAborted();
 }
 /** Fetch resolves at headers. Keep cancellation and identity fencing alive
  * until its JSON body completes, including streams paused by a proxy. Do not
  * impose the small event-frame limit on full graphs or asset collections. */
 private async readJson(response:Response,epoch:number,signal?:AbortSignal|null,onReadProgress?:()=>void):Promise<unknown>{
  const scope=this.scoped(signal);
  let reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
  const abort=()=>{void reader?.cancel(scope.controller.signal.reason).catch(()=>{});};
  try{
   reader=response.body?.getReader();
   scope.controller.signal.addEventListener('abort',abort,{once:true});
   if(scope.controller.signal.aborted)abort();
   this.checkResponse(epoch,scope.controller.signal);
   onReadProgress?.();
   const decoder=new TextDecoder(),parts:string[]=[];
   if(reader)for(;;){
    const chunk=await reader.read();this.checkResponse(epoch,scope.controller.signal);
    if(chunk.done)break;
    if(chunk.value.byteLength)onReadProgress?.();
    parts.push(decoder.decode(chunk.value,{stream:true}));
   }
   parts.push(decoder.decode());
   this.checkResponse(epoch,scope.controller.signal);
   return JSON.parse(parts.join(''));
  }finally{
   if(epoch!==this.epoch||scope.controller.signal.aborted)abort();
   scope.controller.signal.removeEventListener('abort',abort);
   reader?.releaseLock();scope.release();
  }
 }
 private async decodeV2<T>(response:Response,epoch:number,signal?:AbortSignal|null,onReadProgress?:()=>void):Promise<ApiResult<T>>{
  let envelope:any;
  try{envelope=await this.readJson(response,epoch,signal,onReadProgress);}catch{this.checkResponse(epoch,signal);throw new ApiError(response.status,'INVALID_RESPONSE','服务器返回了无法识别的响应。');}
  this.checkResponse(epoch,signal);
  const result=this.decodeEnvelope<T>(envelope,response.status,response.headers.get('ETag'));
  if(response.headers.get('X-STUDIO-Canvas-Update')==='delta-v1')result.canvasDelta=true;
  if(response.headers.get('X-STUDIO-Canvas-Room')==='ws-v1')result.canvasRoom=true;
  return result;
 }
 private decodeEnvelope<T>(value:unknown,status:number,etag:string|null):ApiResult<T>{
  const envelope=value as {code?:unknown;data?:T;error?:{code?:string;message?:string};message?:string;requestId?:string}|null;
  if(!envelope||typeof envelope!=='object')throw new ApiError(status,'INVALID_RESPONSE','服务器返回了无法识别的响应。');
  if(status<200||status>=300||envelope.code!==0){
   const code=String(envelope.error?.code||envelope.code||'API_ERROR');
   const error=new ApiError(status,code,String(envelope.error?.message||envelope.message||'请求失败。'),envelope.requestId);this.reportV2Failure(error);throw error;
  }
  return{data:envelope.data as T,etag,status};
 }
 async rawV2(path:string,options:RequestInit&{retryAuth?:boolean}={}):Promise<Response>{
  const target=this.v2(path),token=this.getAccessToken(),epoch=this.epoch;
  if(!token)throw new ApiError(401,'UNAUTHORIZED','请先使用飞书登录。');
  const scope=this.scoped(options.signal),headers=this.canvasHeaders(path,options);
  // Caller headers cannot carry another identity or Router credentials.
  headers.delete('X-Router-Subject-Ref');headers.delete('X-Workspace-Id');headers.set('Authorization','Bearer '+token);
  const {retryAuth=true,...init}=options;
  const request=()=>{const current=this.getAccessToken();if(!current)throw new ApiError(401,'UNAUTHORIZED','请先使用飞书登录。');usedToken=current;const activeHeaders=new Headers(headers);activeHeaders.set('Authorization','Bearer '+current);return this.transport(target,{...init,headers:activeHeaders,signal:scope.controller.signal,credentials:'same-origin',redirect:'error'});};
  let response:Response|undefined,usedToken=token;
  try{
   response=await request();scope.check();
   const replayable=typeof ReadableStream==='undefined'||!(options.body instanceof ReadableStream);
   if(response.status===401&&retryAuth&&replayable){
    const current=this.getAccessToken(),restored=current&&current!==usedToken?true:this.productRefresh?await this.productRefresh():false;scope.check();
    if(restored){await response.body?.cancel();response=await request();scope.check();}
   }
   if(response.status===401)this.revoked?.(new ApiError(401,'UNAUTHENTICATED','请先使用飞书登录。'));
   this.responseContexts.set(response,{epoch,signal:options.signal});return response;
  }
  catch(error){if(scope.controller.signal.aborted)await response?.body?.cancel().catch(()=>{});throw error;}
  finally{scope.release();}
 }
}
