import {expect,it} from 'vitest';
import {canvasTabResume} from '../../apps/web/src/service/canvas-tab-resume';
function storage(seed:Map<string,string>=new Map()){
 return {data:seed,getItem:(key:string)=>seed.get(key)??null,setItem:(key:string,value:string)=>{seed.set(key,value);}};
}
function broker(){
 const locked=new Set<string>();
 return {request:async(name:string,_opts:unknown,run:(lock:unknown)=>Promise<void>)=>{
  if(locked.has(name))return run(null);
  locked.add(name);try{await run({name});}finally{locked.delete(name);}
 }};
}
function browser(store:ReturnType<typeof storage>,lock:ReturnType<typeof broker>|undefined,type='navigate'):Window{
 return {sessionStorage:store,navigator:{locks:lock},performance:{getEntriesByType:()=>[{type}]}} as unknown as Window;
}
it('allows only a genuine new document reload to use its predecessor token, once, after the prior document lock is released',async()=>{
 const store=storage(),locks=broker(),owner=canvasTabResume(browser(store,locks),'alice','p');
 await owner.resume();owner.remember('private-code');owner.close();await new Promise(resolve=>setTimeout(resolve,0));
 const tab=browser(store,locks,'reload'),reload=canvasTabResume(tab,'alice','p');
 expect(await reload.resume()).toBe('private-code');expect(await reload.resume()).toBeUndefined();
 reload.remember('next-token');reload.close();await new Promise(resolve=>setTimeout(resolve,0));
 const bfcache=canvasTabResume(tab,'alice','p');expect(await bfcache.resume()).toBeUndefined();bfcache.close();
});
it('refuses cloned sessionStorage, ordinary navigation and unsupported Web Locks; the original page remains recoverable',async()=>{
 const locks=broker(),original=storage(),owner=canvasTabResume(browser(original,locks),'alice','p');await owner.resume();owner.remember('original-token');
 const first=canvasTabResume(browser(storage(new Map(original.data)),locks,'reload'),'alice','p');expect(await first.resume()).toBeUndefined();first.close();
 const cloneStore=storage(new Map(original.data)),clone=canvasTabResume(browser(cloneStore,locks),'alice','p');expect(await clone.resume()).toBeUndefined();clone.close();
 const plain=canvasTabResume(browser(storage(new Map(original.data)),undefined,'reload'),'alice','p');expect(await plain.resume()).toBeUndefined();plain.close();
 owner.close();await new Promise(resolve=>setTimeout(resolve,0));
 const duplicateReload=canvasTabResume(browser(cloneStore,locks,'reload'),'alice','p');expect(await duplicateReload.resume()).toBeUndefined();duplicateReload.close();
 const originalReload=canvasTabResume(browser(original,locks,'reload'),'alice','p');expect(await originalReload.resume()).toBe('original-token');originalReload.close();
});
