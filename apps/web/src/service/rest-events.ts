import {ApiError} from '../api/client';
/** Same-origin persisted STUDIO streams; event fields follow the SSE protocol. */
export class ServiceEventSource extends EventTarget {
 static readonly CONNECTING=0;static readonly OPEN=1;static readonly CLOSED=2;
 readonly CONNECTING=0;readonly OPEN=1;readonly CLOSED=2;
 static connect:(url:string,options:RequestInit)=>Promise<Response|undefined>;
 readyState=0;readonly withCredentials=false;readonly url:string;
 onopen:((event:Event)=>void)|null=null;onmessage:((event:MessageEvent)=>void)|null=null;onerror:((event:Event)=>void)|null=null;
 private controller=new AbortController();
 constructor(url:string|URL){super();this.url=String(url);void this.consume();}
 close(){this.controller.abort();this.readyState=2;}
 private emit(type:string,event:Event){this.dispatchEvent(event);if(type==='open')this.onopen?.(event);if(type==='message')this.onmessage?.(event as MessageEvent);if(type==='error')this.onerror?.(event);}
 private async consume(){try{
  const response=await ServiceEventSource.connect(this.url,{signal:this.controller.signal,headers:{Accept:'text/event-stream'}});
  if(this.controller.signal.aborted){void response?.body?.cancel();return;}
  if(!response?.ok||!response.body||!response.headers.get('Content-Type')?.includes('text/event-stream'))throw new ApiError(response?.status||501,'EVENT_PROTOCOL_UNAVAILABLE','此 STUDIO 事件协议尚未接入。');
  this.readyState=1;this.emit('open',new Event('open'));
  const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='',id='';
  this.controller.signal.addEventListener('abort',()=>{void reader.cancel();},{once:true});
  for(;;){const chunk=await reader.read();buffer+=decoder.decode(chunk.value,{stream:!chunk.done});buffer=buffer.replaceAll('\r\n','\n');let boundary:number;
   while((boundary=buffer.indexOf('\n\n'))>=0){if(this.controller.signal.aborted)return;const block=buffer.slice(0,boundary);buffer=buffer.slice(boundary+2);let type='message';const data:string[]=[];for(const line of block.split('\n')){const sep=line.indexOf(':'),key=sep<0?line:line.slice(0,sep),value=sep<0?'':line.slice(sep+1).replace(/^ /,'');if(key==='event')type=value;if(key==='id'&&!value.includes('\0'))id=value;if(key==='data')data.push(value);}if(data.length)this.emit(type,new MessageEvent(type,{data:data.join('\n'),lastEventId:id,origin:globalThis.location?.origin||''}));}
   if(chunk.done)break;
  }this.readyState=2;
 }catch{if(!this.controller.signal.aborted){this.readyState=2;this.emit('error',new Event('error'));}}}
}
