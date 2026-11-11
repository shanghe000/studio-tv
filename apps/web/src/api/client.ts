import {blockedApi,INTERNAL_FEATURE_MESSAGE,type Features} from '../features/policy';
import {randomUuid} from '../browser-compat';
export class ApiError extends Error {
 constructor(public status:number, public code:string, message:string, public requestId?:string){super(message);this.name='ApiError';}
}
export interface ApiResult<T> {data:T;etag:string|null;status:number;canvasMediaScope?:string;canvasDelta?:boolean;canvasRoom?:boolean}
export interface RequestOptions extends Omit<RequestInit,'body'> {body?:unknown;idempotencyKey?:string;etag?:string;anonymous?:boolean;retryAuth?:boolean;onReadProgress?:()=>void}
export class ApiClient {
 private token:string|null=null;
 private refresh: (()=>Promise<boolean>)|null=null;
 readonly transport:typeof fetch;
 constructor(readonly base='/api/v1',transport:typeof fetch=globalThis.fetch.bind(globalThis),readonly features?:Features){this.transport=transport;}
 setAccessToken(token:string|null){this.token=token;}
 getAccessToken(){return this.token;}
 onRefresh(callback:()=>Promise<boolean>){this.refresh=callback;}
 async request<T>(path:string,options:RequestOptions={}):Promise<ApiResult<T>>{
  if(!path.startsWith('/')||path.startsWith('//'))throw new Error('API path must be relative');
  if(this.features&&blockedApi(this.base+path.split('?')[0],this.features))throw new ApiError(403,'FEATURE_DISABLED',INTERNAL_FEATURE_MESSAGE);
  const {body,idempotencyKey,etag,anonymous,retryAuth=true,onReadProgress,...init}=options;
  const headers=new Headers(init.headers);
  if(body!==undefined)headers.set('Content-Type','application/json');
  if(this.token&&!anonymous)headers.set('Authorization','Bearer '+this.token);
  if(idempotencyKey)headers.set('Idempotency-Key',idempotencyKey);
  if(etag)headers.set('If-Match',etag);
  const response=await this.transport(this.base+path,{...init,headers,body:body===undefined?undefined:JSON.stringify(body),credentials:'same-origin'});
  if(response.status===401&&!anonymous&&retryAuth&&this.refresh&&await this.refresh())return this.request<T>(path,{...options,retryAuth:false});
  let envelope:any;
  try{
   if(!onReadProgress)envelope=await response.json();
   else{
    const reader=response.body?.getReader(),decoder=new TextDecoder(),parts:string[]=[];
    const abort=()=>{void reader?.cancel(init.signal?.reason).catch(()=>{});};
    init.signal?.addEventListener('abort',abort,{once:true});
    try{
     init.signal?.throwIfAborted();onReadProgress();
     if(reader)for(;;){const chunk=await reader.read();init.signal?.throwIfAborted();if(chunk.done)break;if(chunk.value.byteLength)onReadProgress();parts.push(decoder.decode(chunk.value,{stream:true}));}
     parts.push(decoder.decode());envelope=JSON.parse(parts.join(''));
    }finally{init.signal?.removeEventListener('abort',abort);if(init.signal?.aborted)abort();reader?.releaseLock();}
   }
  }catch{init.signal?.throwIfAborted();throw new ApiError(response.status,'INVALID_RESPONSE','服务器返回了无法识别的响应。');}
  if(!response.ok||envelope.code!==0)throw new ApiError(response.status,String(envelope.error?.code||envelope.code||'API_ERROR'),String(envelope.error?.message||envelope.message||'请求失败。'),envelope.requestId);
  const scope=response.headers.get('X-STUDIO-Canvas-Media');
  return{data:envelope.data as T,etag:response.headers.get('ETag'),status:response.status,...(scope&&/^[a-f0-9]{32}$/.test(scope)?{canvasMediaScope:scope}:{})};
 }
 mutation<T>(path:string,body:unknown,method='POST',etag?:string){return this.request<T>(path,{method,body,etag,idempotencyKey:randomUuid()});}
}
