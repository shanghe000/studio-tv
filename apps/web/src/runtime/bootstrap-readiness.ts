import {ApiError} from '../api/client';

/** Retry only transport/service availability, not malformed canvas contents or
 * a programming exception. INVALID_RESPONSE is also used by business parsers,
 * so only the HTTP envelope decoder's failure is admitted here. */
export function retryableBootstrapRead(error:unknown):boolean{
 if(error instanceof TypeError)return /fetch|network|load failed|failed to load/i.test(error.message);
 if(!(error instanceof ApiError))return false;
 if(error.code==='INVALID_RESPONSE')return error.message==='服务器返回了无法识别的响应。';
 if(error.status===501||error.code.startsWith('INVALID_'))return false;
 // Service availability is conveyed by HTTP status even when a gateway uses
 // its own business code. It must not require a refresh after recovery.
 if([408,429,503,504].includes(error.status))return true;
 return error.status>=500&&(/(?:_UNAVAILABLE|_TIMEOUT)$/.test(error.code)||/^(?:API_ERROR|HTTP_[5][0-9]{2}|[5][0-9]{2})$/.test(error.code));
}

type Options={signal:AbortSignal;current:()=>boolean;retryCurrent?:()=>boolean;waiting:(retry:()=>void)=>void;attempting:()=>void;surface?:Pick<Window,'addEventListener'|'removeEventListener'>;online?:()=>boolean};
const canceled=()=>new DOMException('页面加载已取消。','AbortError');

/** Initial preparation has no editable document yet. Never race an unresolved
 * read against another read: only an actual rejection schedules another try.
 * Cancellation ends the waiter, but never permits a retry of that old read. */
export async function prepareServiceBootstrap(work:()=>Promise<void>,options:Options):Promise<void>{
 const surface=options.surface??window,online=options.online??(()=>navigator.onLine!==false);
 const check=()=>{if(options.signal.aborted||!options.current())throw canceled();};
 const checkRetry=()=>{check();if(options.retryCurrent?.()===false)throw canceled();};
 const run=()=>new Promise<void>((resolve,reject)=>{
  const abort=()=>{release();reject(canceled());},release=()=>options.signal.removeEventListener('abort',abort);
  options.signal.addEventListener('abort',abort,{once:true});
  if(options.signal.aborted){abort();return;}
  Promise.resolve().then(()=>{checkRetry();return work();}).then(()=>{release();resolve();},error=>{release();reject(error);});
 });
 let failures=0;
 for(;;){
  checkRetry();options.attempting();
  try{await run();check();return;}
  catch(error){checkRetry();if(!retryableBootstrapRead(error))throw error;}
  await new Promise<void>((resolve,reject)=>{
   let settled=false,timer:ReturnType<typeof setTimeout>|undefined;
   const release=()=>{clearTimeout(timer);surface.removeEventListener('online',wake);options.signal.removeEventListener('abort',abort);};
   const complete=(error?:Error)=>{if(settled)return;settled=true;release();error?reject(error):resolve();};
   const abort=()=>complete(canceled());
   const retry=()=>{try{checkRetry();complete();}catch{abort();}};
   const wake=()=>{if(online())retry();};
   surface.addEventListener('online',wake);options.signal.addEventListener('abort',abort,{once:true});
   if(options.signal.aborted){abort();return;}
   if(online())timer=setTimeout(wake,Math.min(15000,1000*2**Math.min(failures++,4)));
   options.waiting(retry);
  });
 }
}
