// @vitest-environment happy-dom
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {createServiceShellLoading,NATIVE_ENTRY,preloadNativeEntry} from '../../apps/web/src/runtime/service-shell-loading';
import {ServiceLoginGate} from '../../apps/web/src/api/login-gate';

const dispose:Array<()=>void>=[];
beforeEach(()=>{document.head.innerHTML='';document.body.innerHTML='<div id="root"></div>';});
afterEach(()=>{for(const release of dispose.splice(0))release();vi.useRealTimers();vi.restoreAllMocks();});
function fixture(canReload?:()=>boolean){
 let frameId=0;const frames=new Map<number,FrameRequestCallback>(),surface={location:{reload:vi.fn()},requestAnimationFrame:vi.fn((callback:FrameRequestCallback)=>{frames.set(++frameId,callback);return frameId;}),cancelAnimationFrame:vi.fn((id:number)=>frames.delete(id))};
 const loading=createServiceShellLoading({doc:document,surface:surface as any,canReload});dispose.push(loading.disconnect);return{loading,surface,frames,paint:()=>{const pending=[...frames.values()];frames.clear();for(const callback of pending)callback(0);}};
}
async function mutations(){await new Promise(resolve=>setTimeout(resolve,0));}
const panel=()=>document.getElementById('studio-tv-shell-loading');

describe('service shell loading handoff',()=>{
 it('keeps a small startup surface through admission, module execution, and an actual React commit/paint',async()=>{
  const f=fixture();expect(panel()?.textContent).toContain('正在打开工作台');f.loading.authorized();const ready=vi.fn(),waiting=f.loading.waitForRootMount().then(ready);
  expect(panel()?.textContent).toContain('正在加载工作台');window.dispatchEvent(new Event('rhtv:native-ready'));await mutations();expect(ready).not.toHaveBeenCalled();expect(f.frames.size).toBe(0);
  const root=document.getElementById('root')!;root.innerHTML='<main>Fixture mounted workbench</main>';await mutations();expect(ready).not.toHaveBeenCalled();expect(f.frames.size).toBe(1);f.paint();await waiting;expect(ready).toHaveBeenCalledOnce();expect(panel()).not.toBeNull();f.loading.finish();expect(panel()).toBeNull();expect(root.textContent).toBe('Fixture mounted workbench');
 });
 it('cannot finish merely because authentication or the native-ready event completed',async()=>{
  const f=fixture();f.loading.authorized();window.dispatchEvent(new Event('rhtv:native-ready'));f.loading.finish();expect(panel()).not.toBeNull();expect(document.getElementById('root')!.childElementCount).toBe(0);
 });
 it.each(['hidden','inert','display','visibility'])('waits for a %s root subtree to become genuinely visible',async(kind)=>{
  const f=fixture(),root=document.getElementById('root')!,view=document.createElement('main');view.textContent='Fixture native page';root.append(view);
  if(kind==='hidden')view.hidden=true;else if(kind==='inert')view.inert=true;else if(kind==='display')view.style.display='none';else view.style.visibility='hidden';
  f.loading.authorized();const ready=vi.fn(),waiting=f.loading.waitForRootMount().then(ready);await mutations();expect(ready).not.toHaveBeenCalled();expect(f.frames.size).toBe(0);
  view.hidden=false;view.inert=false;view.style.cssText='';await mutations();expect(f.frames.size).toBe(1);f.paint();await waiting;expect(ready).toHaveBeenCalledOnce();
 });
 it('ignores scripts/styles and a hidden root, including a root hidden again before its paint',async()=>{
  const f=fixture(),root=document.getElementById('root')!;root.innerHTML='<script type="application/json">{}</script><style></style>';f.loading.authorized();const ready=vi.fn(),waiting=f.loading.waitForRootMount().then(ready);await mutations();expect(f.frames.size).toBe(0);
  root.append(document.createElement('main'));await mutations();expect(f.frames.size).toBe(1);root.hidden=true;f.paint();await mutations();expect(ready).not.toHaveBeenCalled();root.hidden=false;await mutations();f.paint();await waiting;expect(ready).toHaveBeenCalledOnce();
 });
 it('aborts a pending commit wait and prevents a late native root from resolving it',async()=>{
  const f=fixture(),controller=new AbortController();f.loading.authorized();const waiting=f.loading.waitForRootMount(controller.signal),rejected=expect(waiting).rejects.toMatchObject({name:'AbortError'});controller.abort();await rejected;
  document.getElementById('root')!.append(document.createElement('main'));await mutations();expect(f.frames.size).toBe(0);f.loading.cancel();expect(panel()).toBeNull();expect(document.getElementById('root')!.hidden).toBe(true);expect(document.getElementById('root')!.inert).toBe(true);
 });
 it('keeps an auth gate above loading, and an authoritative clear hides the old page without a late fail obscuring the gate',async()=>{
  const f=fixture(),listeners=new Set<()=>void>(),auth={user:{id:'fixture-user'} as any,ensureFresh:async()=>true,onClear:(callback:()=>void)=>{listeners.add(callback);return()=>{listeners.delete(callback);}}};
  const api={request:vi.fn(async()=>({data:{items:[]},status:200,etag:null}))},gate=new ServiceLoginGate({auth,api} as any);dispose.push(()=>gate.disconnect());
  expect(panel()!.hidden).toBe(true);expect(getComputedStyle(panel()!).display).toBe('none');expect(await gate.enter()).toBe(true);expect(panel()!.hidden).toBe(false);f.loading.authorized();
  const controller=new AbortController();listeners.add(()=>{f.loading.cancel();controller.abort();});const waiting=f.loading.waitForRootMount(controller.signal),rejected=expect(waiting).rejects.toMatchObject({name:'AbortError'});document.getElementById('root')!.append(document.createElement('main'));await mutations();
  auth.user=null;for(const clear of [...listeners])clear();await rejected;f.loading.fail(new Error('late failure'));f.loading.finish();expect(panel()).toBeNull();expect(document.getElementById('root')!.hidden).toBe(true);expect(document.getElementById('root')!.inert).toBe(true);expect(f.frames.size).toBe(0);
 });
 it('shows a recovery option after 60 seconds and still accepts a late successful root',async()=>{
  vi.useFakeTimers();const f=fixture();f.loading.authorized();const resolved=vi.fn(),waiting=f.loading.waitForRootMount().then(resolved);await vi.advanceTimersByTimeAsync(20_000);expect(panel()?.textContent).toContain('仍在加载');await vi.advanceTimersByTimeAsync(40_000);
  expect(panel()?.textContent).toContain('完成后会自动打开');expect(resolved).not.toHaveBeenCalled();const retry=panel()!.querySelector<HTMLButtonElement>('button')!;expect(retry.textContent).toBe('重新加载');retry.click();expect(f.surface.location.reload).toHaveBeenCalledOnce();document.getElementById('root')!.append(document.createElement('main'));await vi.advanceTimersByTimeAsync(1);expect(f.frames.size).toBe(1);retry.click();expect(f.surface.location.reload).toHaveBeenCalledOnce();f.paint();await waiting;f.loading.finish();expect(resolved).toHaveBeenCalledOnce();expect(panel()).toBeNull();expect(vi.getTimerCount()).toBe(0);
 });
 it('offers recovery while an import is pending but does not permanently reject its later mount wait',async()=>{
  vi.useFakeTimers();const f=fixture();f.loading.authorized();await vi.advanceTimersByTimeAsync(60_000);expect(panel()?.textContent).toContain('重新加载');expect(f.surface.location.reload).not.toHaveBeenCalled();document.getElementById('root')!.append(document.createElement('main'));const waiting=f.loading.waitForRootMount();expect(f.frames.size).toBe(1);f.paint();await waiting;f.loading.finish();expect(panel()).toBeNull();expect(vi.getTimerCount()).toBe(0);
 });
 it('keeps a connection retry in place after the resource delay and fences stale retry clicks on cancellation',async()=>{
  vi.useFakeTimers();const f=fixture(),retry=vi.fn();f.loading.authorized();f.loading.retryConnection(retry);await vi.advanceTimersByTimeAsync(60_000);expect(panel()?.textContent).toContain('连接暂时不可用');const button=panel()!.querySelector<HTMLButtonElement>('button')!;button.click();expect(retry).toHaveBeenCalledOnce();f.loading.cancel();button.disabled=false;button.click();expect(retry).toHaveBeenCalledOnce();expect(f.surface.location.reload).not.toHaveBeenCalled();
 });
 it('allows an explicit retry for a native error placeholder when no editable document or save exists',()=>{
  const f=fixture(()=>true);document.getElementById('root')!.innerHTML='<main class="route-status-page">Loading failed</main>';f.loading.authorized();f.loading.fail(new Error('resource failed'));panel()!.querySelector<HTMLButtonElement>('button')!.click();expect(f.surface.location.reload).toHaveBeenCalledOnce();
 });
 it('removes an obsolete reload action if a live document attaches while loading is delayed',async()=>{
  vi.useFakeTimers();let safe=true;const f=fixture(()=>safe);f.loading.authorized();await vi.advanceTimersByTimeAsync(60000);const button=panel()!.querySelector<HTMLButtonElement>('button')!;safe=false;button.click();expect(f.surface.location.reload).not.toHaveBeenCalled();expect(panel()?.textContent).toContain('画布已打开');expect(panel()!.querySelector('button')).toBeNull();f.loading.fail(new Error('late install failure'));expect(panel()?.textContent).toContain('当前画布内容仍保留');expect(panel()!.querySelector('button')).toBeNull();
 });
 it('does not unhide its error surface while the admission gate still owns presentation',()=>{
  const f=fixture();panel()!.hidden=true;f.loading.authorized();f.loading.fail(new Error('Fixture resource failure'));expect(panel()!.hidden).toBe(true);expect(getComputedStyle(panel()!).display).toBe('none');
 });
 it('releases the pending paint, observers, waits, and timers on disposal',async()=>{
  const f=fixture();f.loading.authorized();const waiting=f.loading.waitForRootMount(),rejected=expect(waiting).rejects.toMatchObject({name:'AbortError'});document.getElementById('root')!.append(document.createElement('main'));await mutations();expect(f.frames.size).toBe(1);f.loading.disconnect();await rejected;
  expect(f.surface.cancelAnimationFrame).toHaveBeenCalledOnce();expect(f.frames.size).toBe(0);expect(panel()).toBeNull();document.getElementById('root')!.append(document.createElement('aside'));await mutations();expect(f.frames.size).toBe(0);
 });
});

describe('admitted native module preload',()=>{
 it('preloads only the fixed immutable entry without a native script or execution event',()=>{
  const ready=vi.fn();window.addEventListener('rhtv:native-ready',ready);const release=preloadNativeEntry();dispose.push(release);const link=document.querySelector<HTMLLinkElement>('link[rel="modulepreload"]')!;expect(link.getAttribute('href')).toBe(NATIVE_ENTRY);expect(document.querySelector('script')).toBeNull();expect(ready).not.toHaveBeenCalled();release();expect(document.querySelector('link[rel="modulepreload"]')).toBeNull();window.removeEventListener('rhtv:native-ready',ready);
 });
 it('does not duplicate or remove an existing entry preload owned by another initializer',()=>{
  const link=document.createElement('link');link.rel='modulepreload';link.href=NATIVE_ENTRY;document.head.append(link);const release=preloadNativeEntry();expect(document.querySelectorAll('link[rel="modulepreload"]')).toHaveLength(1);release();expect(link.isConnected).toBe(true);
 });
});
