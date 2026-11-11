import {ApiError} from '../api/client';

/** A stalled request must release its queue even when a transport ignores abort.
 * Progress extends this deadline; it never confirms a write or changes its ID. */
export async function canvasRequestDeadline<T>(
 parent:AbortSignal|undefined,
 work:(signal:AbortSignal,progress:()=>void)=>Promise<T>,
 onProgress?:()=>void,
 milliseconds=15000,
):Promise<T>{
 const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined,finished=false;
 const abort=()=>controller.abort(parent?.reason);
 const progress=()=>{
  if(finished||controller.signal.aborted)return;
  clearTimeout(timer);timer=setTimeout(()=>controller.abort(new ApiError(504,'CANVAS_REQUEST_TIMEOUT','画布连接暂未收到响应，正在自动重试。')),milliseconds);
  onProgress?.();
 };
 if(parent?.aborted)abort();else parent?.addEventListener('abort',abort,{once:true});
 let rejectAbort:()=>void=()=>{};
 const canceled=new Promise<never>((_,reject)=>{
  rejectAbort=()=>reject(controller.signal.reason??new DOMException('画布请求已取消','AbortError'));
  controller.signal.addEventListener('abort',rejectAbort,{once:true});
  if(controller.signal.aborted)rejectAbort();
 });
 try{
  controller.signal.throwIfAborted();progress();
  return await Promise.race([canceled,work(controller.signal,progress)]);
 }finally{
  finished=true;clearTimeout(timer);parent?.removeEventListener('abort',abort);controller.signal.removeEventListener('abort',rejectAbort);
 }
}
