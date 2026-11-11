import {afterEach,expect,it,vi} from 'vitest';
import {bindNativeProfile,installNativeProfile} from '../../apps/web/src/api/native-profile';
import type {User} from '../../apps/web/src/api/types';

const user:User={id:'usr-real',displayName:'维护者',avatarUrl:'https://avatar.example.invalid/employee.png',locale:'zh-CN',memberships:[],wallet:{currency:'USD',amount:'0'},teamIds:[]};
const fallback='url("/project/assets/avatar-big-B1NVlEMF.png.svg")';
afterEach(()=>vi.unstubAllGlobals());

function nativeAccount(){
 let name='Personal',image=fallback;
 const writes={name:0,image:0};
 const label={get textContent(){return name;},set textContent(value:string){name=value;writes.name++;}};
 const avatar={style:{get backgroundImage(){return image;},set backgroundImage(value:string){image=value;writes.image++;}}};
 const click=vi.fn(),children=[avatar,label];
 const account={isConnected:true,children,onclick:click,matches:()=>true,querySelector:vi.fn((selector:string)=>selector.endsWith('.team-sign--personal')?label:avatar)};
 return{account:account as unknown as Element,source:account,label,avatar,writes,children,click};
}

it('uses only existing account slots and preserves the native menu click and child layout',()=>{
 const native=nativeAccount();
 bindNativeProfile(native.account,user);
 expect(native.label.textContent).toBe('维护者');
 expect(native.avatar.style.backgroundImage).toBe('url("https://avatar.example.invalid/employee.png")');
 expect(native.source.children).toBe(native.children);expect(native.source.onclick).toBe(native.click);
 bindNativeProfile(native.account,user);
 expect(native.writes).toEqual({name:1,image:1});
 bindNativeProfile(native.account,null);
 expect(native.label.textContent).toBe('Personal');expect(native.avatar.style.backgroundImage).toBe(fallback);
});

it('never presents an unsafe avatar scheme or interprets a display name as markup',()=>{
 const native=nativeAccount();
 bindNativeProfile(native.account,{...user,displayName:'<img onerror=alert(1)>',avatarUrl:'javascript:alert(1)'});
 expect(native.label.textContent).toBe('<img onerror=alert(1)>');
 expect(native.avatar.style.backgroundImage).toBe(fallback);
});

it('reconciles native rerenders without a loop and clears old identity on sign-out',()=>{
 const native=nativeAccount();
 const observers:{target?:Element;options?:MutationObserverInit;callback:()=>void;disconnect:ReturnType<typeof vi.fn>}[]=[];
 vi.stubGlobal('MutationObserver',class {
  state:{target?:Element;options?:MutationObserverInit;callback:()=>void;disconnect:ReturnType<typeof vi.fn>};
  constructor(callback:()=>void){this.state={callback,disconnect:vi.fn()};observers.push(this.state);}
  observe(target:Element,options:MutationObserverInit){this.state.target=target;this.state.options=options;}
  disconnect(){this.state.disconnect();}
 });
 const callbacks=new Set<()=>void>();
 const auth={user:user as User|null,onClear:(callback:()=>void)=>{callbacks.add(callback);return()=>{callbacks.delete(callback);};}};
 const root={querySelectorAll:vi.fn(()=>[native.account])} as unknown as Document;
 const lifecycle=new EventTarget();
 const bridge=installNativeProfile(auth,root,lifecycle as unknown as Window);
 expect(observers).toHaveLength(1);expect(observers[0].target).toBe(native.account);
 expect(observers[0].options?.attributeFilter).toEqual(['style','class']);
 native.label.textContent='Personal';observers[0].callback();
 expect(native.label.textContent).toBe(user.displayName);
 const writes={...native.writes};observers[0].callback();
 expect(native.writes).toEqual(writes);
 auth.user=null;for(const callback of callbacks)callback();
 expect(native.label.textContent).toBe('Personal');expect(native.avatar.style.backgroundImage).toBe(fallback);
 native.avatar.style.backgroundImage='url("https://avatar.example.invalid/old.png")';observers[0].callback();
 expect(native.avatar.style.backgroundImage).toBe(fallback);
 bridge.dispose();expect(callbacks.size).toBe(0);expect(observers[0].disconnect).toHaveBeenCalled();
});

it('disconnects removed accounts and pauses observers for BFCache before restoring the current identity',()=>{
 const native=nativeAccount();
 const observers:{callback:()=>void;disconnect:ReturnType<typeof vi.fn>}[]=[];
 vi.stubGlobal('MutationObserver',class {
  state:{callback:()=>void;disconnect:ReturnType<typeof vi.fn>};
  constructor(callback:()=>void){this.state={callback,disconnect:vi.fn()};observers.push(this.state);}
  observe(){}
  disconnect(){this.state.disconnect();}
 });
 let items=[native.account];
 const root={querySelectorAll:()=>items} as unknown as Document;
 const auth={user:user as User|null,onClear:()=>()=>{}},lifecycle=new EventTarget();
 const bridge=installNativeProfile(auth,root,lifecycle as unknown as Window);
 native.source.isConnected=false;items=[];bridge.prune();
 expect(observers[0].disconnect).toHaveBeenCalledOnce();
 native.source.isConnected=true;items=[native.account];bridge.mount();
 expect(observers).toHaveLength(2);
 lifecycle.dispatchEvent(new Event('pagehide'));
 expect(observers[1].disconnect).toHaveBeenCalledOnce();
 auth.user=null;bridge.mount();expect(observers).toHaveLength(2);
 lifecycle.dispatchEvent(new Event('pageshow'));
 expect(observers).toHaveLength(3);expect(native.label.textContent).toBe('Personal');expect(native.avatar.style.backgroundImage).toBe(fallback);
 bridge.dispose();lifecycle.dispatchEvent(new Event('pageshow'));expect(observers).toHaveLength(3);
});
