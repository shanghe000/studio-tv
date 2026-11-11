import {randomUuid} from '../browser-compat';

/** sessionStorage is copied when a tab is duplicated. Only a real reload may
 * consume its predecessor's receipt, and only after this origin's exclusive
 * Web Lock confirms that the original document no longer owns the tab. */
const bootstrapped=new WeakMap<Window,Set<string>>();
export function canvasTabResume(surface:Window, user:string, project:string){
 const key='studio:canvas-tab:'+encodeURIComponent(user)+':'+encodeURIComponent(project);
 let storage:Storage|undefined,previous:{tab?:string;token?:string}={};
 try{storage=surface.sessionStorage;previous=JSON.parse(storage.getItem(key)??'{}')??{};}catch{}
 const navigation=surface.performance?.getEntriesByType?.('navigation')[0] as PerformanceNavigationTiming|undefined;
 const seen=bootstrapped.get(surface)??new Set<string>();bootstrapped.set(surface,seen);
 const reload=!seen.has(key)&&navigation?.type==='reload';seen.add(key);
 const validTab=typeof previous.tab==='string'&&/^[\w-]{1,80}$/.test(previous.tab);
 const tab=reload&&validTab?previous.tab!:randomUuid();
 const token=reload&&validTab&&typeof previous.token==='string'?previous.token:undefined;
 let held=false,disposed=false,unlock:(()=>void)|undefined;
 const write=(value?:string)=>{try{storage?.setItem(key,JSON.stringify({tab,...(value?{token:value}:{})}));}catch{}};
 // Navigations and bfcache restores cannot replay a copied token on a later reload.
 write();
 let locked:Promise<boolean>=Promise.resolve(false);
 if(surface.navigator?.locks?.request&&storage){
  locked=new Promise(resolve=>{
   void surface.navigator.locks.request('studio:canvas-tab:'+tab,{ifAvailable:true},async lock=>{
    if(!lock||disposed){resolve(false);return;}
    held=true;resolve(true);
    await new Promise<void>(done=>{unlock=done;});
   }).catch(()=>resolve(false));
  });
 }
 let consumed=false;
 return {
  async resume(){if(consumed)return;consumed=true;return await locked&&held&&!disposed?token:undefined;},
  remember(value:string){if(held&&!disposed)write(value);},
  forget(){if(held&&!disposed)write();},
  close(){disposed=true;held=false;unlock?.();}
 };
}
