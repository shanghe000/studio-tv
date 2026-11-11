// @vitest-environment happy-dom
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {initializeFrameShell,nativeFrameModule} from '../../apps/web/src/runtime/frame-shell';
import {gateFrameShellHtml,nativeFrameShells} from '../../apps/web/scripts/frame-shell-html.mjs';

// Explicit local protocol fixtures. No production identity, OAuth consent,
// project mutation, native external transport, or model is called here.
const user={id:'fixture-user',displayName:'Fixture user',avatarUrl:null,locale:'zh-CN',memberships:[],wallet:{currency:'CNY',amount:'0'},teamIds:[]};
const session={accessToken:'fixture-private-token',tokenType:'Bearer',expiresIn:900,user};
const configuration={provider:'IPAC_FEISHU',configured:true,loginUrl:'/api/v1/auth/feishu/login',unavailableReason:null};
const json=(status:number,data:unknown)=>new Response(JSON.stringify(status===200?{code:0,data}:data),{status,headers:{'Content-Type':'application/json'}});
const failure=(status:number,code:string)=>json(status,{error:{code,message:'Local test failure'}});
const dispose:Array<()=>void>=[];
beforeEach(()=>{Object.assign((window as any).happyDOM.settings,{disableJavaScriptFileLoading:true,disableCSSFileLoading:true,handleDisabledFileLoadingAsSuccess:true});document.body.innerHTML='<div id="root"><button>Native editor</button></div>';document.head.innerHTML='';document.documentElement.setAttribute('data-studiotv-frame-pending','');window.sessionStorage.clear();});
afterEach(()=>{for(const release of dispose.splice(0))release();vi.unstubAllGlobals();vi.restoreAllMocks();document.documentElement.removeAttribute('data-studiotv-frame-pending');});
function surface(path='/opencut/?projectId=fixture#clip'){
 const url=new URL(path,'http://studio.fixture'),events=new EventTarget();
 const location={href:url.href,origin:url.origin,pathname:url.pathname,search:url.search,hash:url.hash,replace:vi.fn(),reload:vi.fn(),assign:vi.fn()};
 const history={state:{fixture:true},replaceState:vi.fn((_state:unknown,_title:string,path:string)=>{const next=new URL(path,location.origin);Object.assign(location,{href:next.href,pathname:next.pathname,search:next.search,hash:next.hash});})};
 const tab={location,history,sessionStorage:window.sessionStorage,fetch:vi.fn(),addEventListener:events.addEventListener.bind(events),removeEventListener:events.removeEventListener.bind(events),dispatchEvent:events.dispatchEvent.bind(events),parent:null as any};tab.parent=tab;return tab;
}
function fixture(options:{path?:string;mode?:'service'|'preview';refresh?:()=>Response|Promise<Response>;projects?:()=>Response|Promise<Response>;parent?:any;loadNative?:any}={}){
 const tab=surface(options.path),load=options.loadNative??vi.fn(async()=>{}),entry=document.createElement('script');entry.type='module';entry.src='/frame-shell-entry.js';entry.setAttribute('data-studiotv-native-entry',tab.location.pathname.startsWith('/hyperframes-studio')?'/hyperframes-studio/assets/index-BwvD1qfL.js':tab.location.pathname.startsWith('/labs/rhhyperframes')?'/_nuxt/DGtFQwJn.js':'./assets/index-CTfB2_56.js');document.head.append(entry);
 tab.fetch=vi.fn(async(path:string,_init?:RequestInit)=>{
  if(path==='/api/v1/auth/csrf')return json(200,{csrfToken:'fixture-csrf'});
  if(path==='/api/v1/auth/sessions/refresh')return options.refresh?options.refresh():json(200,session);
  if(path==='/api/v1/projects?page=1&pageSize=1')return options.projects?options.projects():json(200,{items:[],page:1,pageSize:1,total:0});
  if(path==='/api/v1/auth/config')return json(200,configuration);
  throw new Error('Unregistered local fixture route: '+path);
 });
 if(options.parent)tab.parent=options.parent;
 const controller=initializeFrameShell({mode:options.mode??'service',doc:document,surface:tab as any,loadNative:load});dispose.push(controller.disconnect);return{tab,load,entry,controller};
}

describe('native frame shell admission',()=>{
 it.each(['/opencut/','/labs/rhhyperframes/','/hyperframes-studio/index.html'])('starts %s only after a real session and protected tv.access read',async(path)=>{
  let finish!:(value:Response)=>void;const projects=new Promise<Response>(resolve=>finish=resolve),f=fixture({path,projects:()=>projects});
  await vi.waitFor(()=>expect(f.tab.fetch).toHaveBeenCalledWith('/api/v1/projects?page=1&pageSize=1',expect.anything()));
  expect(f.load).not.toHaveBeenCalled();expect(document.documentElement.hasAttribute('data-studiotv-frame-pending')).toBe(true);expect(document.getElementById('root')!.hidden).toBe(true);
  finish(json(200,{items:[]}));expect(await f.controller.started).toBe(true);expect(f.load).toHaveBeenCalledOnce();expect(document.documentElement.hasAttribute('data-studiotv-frame-pending')).toBe(false);expect(document.getElementById('root')!.hidden).toBe(false);
  expect(f.tab.fetch.mock.calls.map(call=>call[0])).toEqual(['/api/v1/auth/csrf','/api/v1/auth/sessions/refresh','/api/v1/projects?page=1&pageSize=1']);
  const headers=new Headers(f.tab.fetch.mock.calls[2][1]!.headers);expect(headers.get('Authorization')).toBe('Bearer '+session.accessToken);
  expect(document.cookie).not.toContain(session.accessToken);expect(f.tab).not.toHaveProperty('__RHTV_PREVIEW__');
 });
 it('redirects an anonymous standalone shell to same-origin Feishu while its native module remains unstarted',async()=>{
  const f=fixture({refresh:()=>failure(401,'REFRESH_REVOKED')});await vi.waitFor(()=>expect(f.tab.location.replace).toHaveBeenCalledOnce());
  const destination=new URL(f.tab.location.replace.mock.calls[0][0],f.tab.location.origin);expect(destination.origin).toBe(f.tab.location.origin);expect(destination.searchParams.get('returnTo')).toBe('/opencut/?projectId=fixture');expect(destination.hash).toBe('');expect(f.load).not.toHaveBeenCalled();expect(document.getElementById('root')!.hidden).toBe(true);
 });
 it('keeps authoritative permission denial separate from login and never starts the native module',async()=>{
  const f=fixture({projects:()=>failure(403,'IPAC_PERMISSION_DENIED')});await vi.waitFor(()=>expect(document.getElementById('studio-tv-login-gate')?.textContent).toContain('没有使用工作台的权限'));
  expect(f.load).not.toHaveBeenCalled();expect(f.tab.location.replace).not.toHaveBeenCalled();expect(f.tab.fetch.mock.calls.map(call=>call[0])).toHaveLength(3);expect(document.documentElement.hasAttribute('data-studiotv-frame-pending')).toBe(true);
 });
 it('recovers after a temporary authentication outage without loading the native module or repeating OAuth',async()=>{
  let unavailable=true;const f=fixture({refresh:()=>unavailable?failure(503,'IPAC_UNAVAILABLE'):json(200,session)});await vi.waitFor(()=>expect(document.getElementById('studio-tv-login-gate')?.textContent).toContain('暂时无法恢复登录'));
  expect(f.load).not.toHaveBeenCalled();expect(f.tab.location.replace).not.toHaveBeenCalled();unavailable=false;document.querySelector<HTMLButtonElement>('#studio-tv-login-gate button')!.click();expect(await f.controller.started).toBe(true);expect(f.load).toHaveBeenCalledOnce();expect(f.tab.location.replace).not.toHaveBeenCalled();
 });
 it('reuses an admitted same-origin STUDIO host without a second refresh or native token bridge and hides on host clear',async()=>{
  let clear!:()=>void;const release=vi.fn(),parent:any={location:{origin:'http://studio.fixture'},__RHTV_PREVIEW__:{mode:'service',auth:{user,onClear:vi.fn((callback:()=>void)=>{clear=callback;return release;})}}};parent.parent=parent;
  const f=fixture({parent});expect(await f.controller.started).toBe(true);expect(f.tab.fetch).not.toHaveBeenCalled();expect(f.load).toHaveBeenCalledOnce();clear();expect(document.documentElement.hasAttribute('data-studiotv-frame-pending')).toBe(true);expect(document.querySelector('#studiotv-frame-shell-error')?.textContent).toContain('登录状态已变更');f.controller.disconnect();expect(release).toHaveBeenCalledOnce();
 });
 it.each(['missing','preview','anonymous','cross-origin'])('fails closed for a %s embedded host',async(kind)=>{
  const parent:any={location:{origin:kind==='cross-origin'?'https://external.fixture':'http://studio.fixture'}};parent.parent=parent;if(kind!=='missing')parent.__RHTV_PREVIEW__={mode:kind==='preview'?'preview':'service',auth:{user:kind==='anonymous'?null:user}};
  const f=fixture({parent});expect(await f.controller.started).toBe(false);expect(f.load).not.toHaveBeenCalled();expect(f.tab.fetch).not.toHaveBeenCalled();expect(document.querySelector('#studiotv-frame-shell-error')).not.toBeNull();expect(document.documentElement.hasAttribute('data-studiotv-frame-pending')).toBe(true);
 });
 it('preserves preview mode with no STUDIO authentication traffic',async()=>{
  const f=fixture({mode:'preview'});expect(await f.controller.started).toBe(true);expect(f.tab.fetch).not.toHaveBeenCalled();expect(f.load).toHaveBeenCalledOnce();expect(document.documentElement.hasAttribute('data-studiotv-frame-pending')).toBe(false);
 });
 it('does not gate generated work or signed player documents',async()=>{
  const f=fixture({path:'/api/v2/studio/preview/work/index.html?grant=fixture'});expect(await f.controller.started).toBe(false);expect(f.tab.fetch).not.toHaveBeenCalled();expect(f.load).not.toHaveBeenCalled();expect(document.querySelector('#studio-tv-login-gate')).toBeNull();expect(document.querySelector('#studiotv-frame-shell-error')).toBeNull();
 });
 it('fences a late protected read after pagehide and never starts an abandoned native shell',async()=>{
  let finish!:(value:Response)=>void;const projects=new Promise<Response>(resolve=>finish=resolve),f=fixture({projects:()=>projects});await vi.waitFor(()=>expect(f.tab.fetch).toHaveBeenCalledTimes(3));const signal=f.tab.fetch.mock.calls[2][1]!.signal!;
  f.tab.dispatchEvent(new Event('pagehide'));expect(signal.aborted).toBe(true);finish(json(200,{items:[]}));await new Promise(resolve=>setTimeout(resolve,0));expect(f.load).not.toHaveBeenCalled();expect(document.querySelector('#studio-tv-login-gate')).toBeNull();expect(document.documentElement.hasAttribute('data-studiotv-frame-pending')).toBe(true);
 });
 it('keeps a retained service editor hidden and reloads through fresh admission after a bfcache return',async()=>{
  const f=fixture();expect(await f.controller.started).toBe(true);
  const hide=new Event('pagehide'),show=new Event('pageshow');Object.defineProperty(hide,'persisted',{value:true});Object.defineProperty(show,'persisted',{value:true});f.tab.dispatchEvent(hide);
  expect(document.documentElement.hasAttribute('data-studiotv-frame-pending')).toBe(true);expect(f.tab.location.reload).not.toHaveBeenCalled();f.tab.dispatchEvent(show);expect(f.tab.location.reload).toHaveBeenCalledOnce();expect(f.load).toHaveBeenCalledOnce();
 });
 it('preserves preview bfcache behavior without a service reload or hidden retained editor',async()=>{
  const f=fixture({mode:'preview'});expect(await f.controller.started).toBe(true);
  for(const name of ['pagehide','pageshow']){const event=new Event(name);Object.defineProperty(event,'persisted',{value:true});f.tab.dispatchEvent(event);}
  expect(f.tab.location.reload).not.toHaveBeenCalled();expect(document.documentElement.hasAttribute('data-studiotv-frame-pending')).toBe(false);
 });
 it('copies the original module crossorigin and nonce only after admission',async()=>{
  const f=fixture({loadNative:undefined});f.controller.disconnect();document.head.innerHTML='<script type="module" crossorigin nonce="fixture-nonce" src="/frame-shell-entry.js" data-studiotv-native-entry="./assets/index-CTfB2_56.js"></script>';
  document.querySelector<HTMLScriptElement>('script[data-studiotv-native-entry]')!.nonce='fixture-nonce';
  const controller=initializeFrameShell({mode:'preview',surface:f.tab as any});dispose.push(controller.disconnect);const module=document.querySelector<HTMLScriptElement>('script[data-studiotv-native-started]')!;expect(module.src).toBe('http://studio.fixture/opencut/assets/index-CTfB2_56.js');expect(module.hasAttribute('crossorigin')).toBe(true);expect(module.nonce).toBe('fixture-nonce');expect(await controller.started).toBe(true);
 });
});

describe('frame module boundary',()=>{
 it.each(['https://external.fixture/opencut/assets/index.js','/project/assets/index.js','./assets/subdir/index.js','./assets/index.js?grant=fixture','./assets/index.js#fragment','//external.fixture/opencut/assets/index.js','http://user:pass@studio.fixture/opencut/assets/index.js'])('rejects unsafe or unrelated module %s',source=>{expect(()=>nativeFrameModule(source,surface().location as any)).toThrow();});
 it('rejects an application module on a generated player path',()=>{expect(()=>nativeFrameModule('/opencut/assets/index.js',surface('/work/index.html').location as any)).toThrow();});
});

describe('dist-only native shell transformation',()=>{
 it.each(nativeFrameShells)('gates %s while preserving source HTML and classic frame-runtime order',path=>{
  const original=readFileSync(new URL('../../apps/web/public/'+path,import.meta.url),'utf8'),output=gateFrameShellHtml(path,original),doc=new DOMParser().parseFromString(output,'text/html');
  const originalDoc=new DOMParser().parseFromString(original,'text/html'),native=originalDoc.querySelector<HTMLScriptElement>('script[type="module"][src]')!,loader=doc.querySelector<HTMLScriptElement>('script[type="module"][src]')!;
  expect(loader.getAttribute('src')).toBe('/frame-shell-entry.js');expect(loader.getAttribute('data-studiotv-native-entry')).toBe(native.getAttribute('src'));expect(doc.querySelectorAll('script[type="module"][src]')).toHaveLength(1);expect(doc.documentElement.hasAttribute('data-studiotv-frame-pending')).toBe(true);
  const pending=doc.getElementById('studiotv-frame-pending-style')!.textContent!;expect(pending).toContain('display:none!important');expect(pending).toContain(':not(#studio-tv-login-gate)');expect(pending).toContain(':not(#studiotv-frame-shell-error)');
  expect(output.indexOf('src="/runtime-config.js"')).toBeLessThan(output.indexOf('src="/frame-runtime.js"'));expect(output.indexOf('src="/frame-runtime.js"')).toBeLessThan(output.indexOf('src="/frame-shell-entry.js"'));expect(doc.querySelectorAll('script:not([src])').length).toBe(originalDoc.querySelectorAll('script:not([src])').length);
  expect(gateFrameShellHtml(path,output)).toBe(output);expect(readFileSync(new URL('../../apps/web/public/'+path,import.meta.url),'utf8')).toBe(original);
 });
 it.each(['hyperframes-studio/work/index.html','opencut/generated/index.html','labs/other/index.html','project/canvas/index.html'])('leaves %s untouched',path=>{const html='<html><head><script type="module" src="./work.js"></script></head><body>Generated work</body></html>';expect(gateFrameShellHtml(path,html)).toBe(html);});
 it.each(['<html><head></head><body></body></html>','<html><head><script type="module" src="a.js"></script><script type="module" src="b.js"></script></head></html>'])('fails the build on an ambiguous native module boundary',html=>{expect(()=>gateFrameShellHtml('opencut/index.html',html)).toThrow('Expected one native module entry');});
});
