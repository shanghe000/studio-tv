/** A suspended browser can keep an SSE connection open while losing its
 * pending read. Only retire that read cycle; the owning CanvasSync keeps its
 * confirmed event cursor, deferred view, and local operation journal. */
export class CanvasSyncTransport {
 private cycle=new AbortController();
 private detach?:()=>void;
 private lastActivity=Date.now();
 private recovering=false;
 private wakes=new Set<()=>void>();
 stopped=false;
 get signal(){return this.cycle.signal;}
 next(){if(!this.stopped&&this.signal.aborted)this.cycle=new AbortController();}
 /** Only successful reads / validated room frames renew liveness. Opening a
  * socket or sending a write says nothing about its ability to receive. */
 markActivity=()=>{this.lastActivity=Date.now();this.recovering=false;};
 onWake(listener:()=>void){this.wakes.add(listener);return()=>{this.wakes.delete(listener);};}
 listen(doc=globalThis.document,surface=globalThis.window){
  if(this.stopped||this.detach||!doc?.addEventListener||!doc.removeEventListener||!surface?.addEventListener||!surface.removeEventListener)return;
  let resumed=false;
  const suspend=()=>{resumed=false;this.recovering=false;};
  const wake=(forced=false)=>{
   if(this.stopped||this.signal.aborted||!forced&&(this.recovering||Date.now()-this.lastActivity<15000))return;
   this.recovering=true;
   // Clear transport backoffs before the current read is canceled. The next
   // cycle still uses the confirmed cursor and the same pending operations.
   for(const listener of this.wakes)listener();
   this.cycle.abort();
  };
  const resume=()=>{if(!resumed){resumed=true;wake(true);}};
  const visible=()=>{if(doc.visibilityState==='hidden')suspend();else wake();};
  const focus=()=>{if(doc.visibilityState==='visible')wake();};
  const show=(event:PageTransitionEvent)=>{if(event.persisted)resume();};
  doc.addEventListener('freeze',suspend);doc.addEventListener('resume',resume);doc.addEventListener('visibilitychange',visible);
  surface.addEventListener('offline',suspend);surface.addEventListener('online',resume);surface.addEventListener('focus',focus);
  surface.addEventListener('pagehide',suspend);surface.addEventListener('pageshow',show);
  this.detach=()=>{
   doc.removeEventListener('freeze',suspend);doc.removeEventListener('resume',resume);doc.removeEventListener('visibilitychange',visible);
   surface.removeEventListener('offline',suspend);surface.removeEventListener('online',resume);surface.removeEventListener('focus',focus);
   surface.removeEventListener('pagehide',suspend);surface.removeEventListener('pageshow',show);
  };
 }
 abort(){this.stopped=true;this.detach?.();this.detach=undefined;this.wakes.clear();this.cycle.abort();}
 async pause(ms:number){
  const signal=this.signal;if(signal.aborted)return;
  await new Promise<void>(resolve=>{const finish=()=>{clearTimeout(timer);signal.removeEventListener('abort',finish);resolve();};const timer=setTimeout(finish,ms);signal.addEventListener('abort',finish,{once:true});});
 }
}
