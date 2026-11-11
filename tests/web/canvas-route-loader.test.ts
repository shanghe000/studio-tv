// @vitest-environment happy-dom
import {readFileSync} from 'node:fs';
import {URL as FileURL} from 'node:url';
import {afterEach,expect,it,vi} from 'vitest';
import {ApiError} from '../../apps/web/src/api/client';
import {installCanvasRouteLoader,installCanvasRouterLoader} from '../../apps/web/src/service/canvas-route-loader';

// Execute only the MIT router engine from the immutable native bundle. Using
// its real data routes catches append-only patchRoutes or lazy-loader mistakes
// that a self-consistent mock router would miss; the application is not run.
const source=readFileSync(new FileURL('../../apps/web/public/project/assets/index-DeyN_Phq.js',import.meta.url),'utf8');
const start=source.indexOf('function cs()',source.indexOf('@remix-run/router v1.23.3')),end=source.indexOf('/**',start);
if(start<0||end<0||!source.slice(end,end+100).includes('React Router v6.30.4'))throw new Error('Frozen router boundary changed; review the route-loader seam.');
const {createRouter,createBrowserHistory}=new Function(source.slice(start,end)+';return {createRouter:XRt,createBrowserHistory:xRt};')();
const disposers:Array<()=>void>=[];
afterEach(()=>{for(const dispose of disposers.splice(0).reverse())dispose();document.body.replaceChildren();vi.restoreAllMocks();});
const deferred=<T,>()=>{let resolve!:(value:T)=>void,reject!:(reason:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
function authFixture(){
 const listeners=new Set<()=>void>();
 const auth={user:{id:'fixture-owner'} as {id:string}|null,onClear:(run:()=>void)=>{listeners.add(run);return()=>listeners.delete(run);},clear:()=>{auth.user=null;for(const run of [...listeners])run();}};
 return{auth,listeners};
}
const native={r:{createElement:(type:any,props:any,...children:any[])=>({type,props:props??{},children})}};
function setup(load=vi.fn(async(_id:string,_options?:{signal?:AbortSignal})=>{}),extra:any={}){
 window.history.replaceState(null,'','/projects/canvas/me/');
 const {auth,listeners}=authFixture(),canvas={id:'canvas',path:'/project/canvas/:id',lazy:vi.fn(async()=>({Component:()=>null})),...extra};
 const router=createRouter({history:createBrowserHistory({window}),window,routes:[{id:'list',path:'/projects/canvas/me/'},canvas]}).initialize();
 const runtime={auth,storage:{loadProject:load}},dispose=installCanvasRouterLoader(router,runtime,native);
 disposers.push(()=>{dispose();router.dispose();});
 return{router,runtime,auth,listeners,load,dispose,canvas:router.routes.find((route:any)=>route.id==='canvas')};
}
async function settle(check:()=>void){await vi.waitFor(check,{timeout:1500,interval:5});}
const args=(id='a',signal?:AbortSignal)=>({params:{id},request:new Request('http://fixture.invalid/project/canvas/'+id,{signal})});

it('loads the real snapshot before the native lazy canvas commits, without preloading unrelated list rows',async()=>{
 const pending=deferred<void>(),s=setup(vi.fn(()=>pending.promise)),commits:string[]=[];
 s.router.subscribe((state:any)=>{if(state.navigation.state==='idle'&&state.location.pathname.startsWith('/project/canvas/'))commits.push(state.location.pathname);});
 const navigation=s.router.navigate('/project/canvas/a');
 await settle(()=>expect(s.load).toHaveBeenCalledOnce());expect(s.load.mock.calls[0][0]).toBe('a');expect(s.router.state.location.pathname).toBe('/projects/canvas/me/');expect(commits).toEqual([]);
 pending.resolve();await navigation;expect(s.router.state.errors).toBeNull();expect(commits).toEqual(['/project/canvas/a']);
 expect(s.canvas.lazy).toBeUndefined();expect(s.canvas.loader).toBeTypeOf('function');
});

it('performs a fresh load for actual PUSH, POP and retry/revalidation despite an already cached project',async()=>{
 const s=setup();await s.router.navigate('/project/canvas/a');await s.router.navigate('/project/canvas/b');
 window.history.back();await settle(()=>expect(s.router.state.location.pathname).toBe('/project/canvas/a'));
 window.history.forward();await settle(()=>expect(s.router.state.location.pathname).toBe('/project/canvas/b'));
 s.router.revalidate();await settle(()=>expect(s.load).toHaveBeenCalledTimes(5));await settle(()=>expect(s.router.state.revalidation).toBe('idle'));
 expect(s.load.mock.calls.map(([id])=>id)).toEqual(['a','b','a','b','b']);
});

it('keeps ordinary query navigation and nested sketchboard navigation behind the same canvas loader',async()=>{
 const s=setup(undefined,{children:[{id:'sketchboard',path:'sketchboard'}]});
 await s.router.navigate('/project/canvas/a');await s.router.navigate('/project/canvas/a?view=details');await s.router.navigate('/project/canvas/a/sketchboard');
 expect(s.load.mock.calls.map(([id])=>id)).toEqual(['a','a','a']);expect(s.router.state.errors).toBeNull();
});

it('aborts only the obsolete route waiter on rapid A/B navigation and never commits its late result',async()=>{
 const first=deferred<void>(),second=deferred<void>(),s=setup(vi.fn((id:string)=>id==='a'?first.promise:second.promise)),commits:string[]=[];
 s.router.subscribe((state:any)=>{if(state.navigation.state==='idle'&&state.location.pathname.startsWith('/project/canvas/'))commits.push(state.location.pathname);});
 const a=s.router.navigate('/project/canvas/a');await settle(()=>expect(s.load).toHaveBeenCalledOnce());const aSignal=s.load.mock.calls[0][1]!.signal!;
 const b=s.router.navigate('/project/canvas/b');await settle(()=>expect(s.load).toHaveBeenCalledTimes(2));expect(aSignal.aborted).toBe(true);expect(s.load.mock.calls[1][1]!.signal!.aborted).toBe(false);
 second.resolve();await b;first.resolve();await a;expect(commits).toEqual(['/project/canvas/b']);expect(s.router.state.location.pathname).toBe('/project/canvas/b');
});

it.each(['clear-same-user','different-user'])('rejects a late fill after %s before any native component can use it',async change=>{
 const pending=deferred<void>(),s=setup(vi.fn(()=>pending.promise)),loader=s.canvas.loader;
 const result=loader(args());expect(s.load).toHaveBeenCalledOnce();
 if(change==='clear-same-user'){s.auth.clear();s.auth.user={id:'fixture-owner'};}else s.auth.user={id:'fixture-other'};
 pending.resolve();await expect(result).rejects.toMatchObject(change==='clear-same-user'?{name:'AbortError'}:{code:'SESSION_CHANGED'});
});

it('fails closed on an unavailable snapshot and presents recovery actions; successful retry loads again',async()=>{
 const s=setup(vi.fn().mockRejectedValueOnce(new ApiError(503,'UPSTREAM_UNAVAILABLE','private upstream detail')).mockResolvedValueOnce(undefined));
 await s.router.navigate('/project/canvas/a');expect(s.router.state.errors.canvas).toMatchObject({status:503});expect(s.router.state.loaderData.canvas).toBeUndefined();expect(s.canvas.hasErrorBoundary).toBe(true);
 const view=s.canvas.errorElement.type(),text=JSON.stringify(view);expect(text).toContain('项目暂时无法打开');expect(text).not.toContain('private upstream detail');
 view.children[2].children[0].props.onClick();await settle(()=>expect(s.load).toHaveBeenCalledTimes(2));await settle(()=>expect(s.router.state.errors).toBeNull());
 view.children[2].children[1].props.onClick();await settle(()=>expect(s.router.state.location.pathname).toBe('/projects/canvas/me/'));
});

it('rejects an unauthenticated or invalid project before any transport and respects a pre-aborted navigation',async()=>{
 const s=setup(),loader=s.canvas.loader;s.auth.user=null;await expect(loader(args())).rejects.toMatchObject({status:401});
 s.auth.user={id:'fixture-owner'};await expect(loader(args('a/b'))).rejects.toMatchObject({status:400});const controller=new AbortController();controller.abort();await expect(loader(args('a',controller.signal))).rejects.toMatchObject({name:'AbortError'});
 expect(s.load).not.toHaveBeenCalled();
});

it('preserves an existing loader only after the real full load and restores its own route properties on disposal',async()=>{
 const order:string[]=[],original=vi.fn(async()=>{order.push('original');return{metadata:'original'};}),revalidate=()=>false,errorElement={old:true};
 const s=setup(vi.fn(async()=>{order.push('snapshot');}),{loader:original,shouldRevalidate:revalidate,errorElement,hasErrorBoundary:true});
 await s.router.navigate('/project/canvas/a');expect(order).toEqual(['snapshot','original']);expect(s.router.state.loaderData.canvas).toEqual({metadata:'original'});
 s.dispose();expect(s.canvas.loader).toBe(original);expect(s.canvas.shouldRevalidate).toBe(revalidate);expect(s.canvas.errorElement).toBe(errorElement);expect(s.canvas.hasErrorBoundary).toBe(true);expect(s.listeners.size).toBe(0);
});

it('cancels outstanding route waits on disposal and leaves another owner’s later route patch intact',async()=>{
 const pending=deferred<void>(),s=setup(vi.fn(()=>pending.promise)),result=s.canvas.loader(args()),replacement=vi.fn(),revalidate=()=>false,errorElement={replacement:true};
 s.canvas.loader=replacement;s.canvas.shouldRevalidate=revalidate;s.canvas.errorElement=errorElement;s.canvas.hasErrorBoundary=false;s.dispose();
 await expect(result).rejects.toMatchObject({name:'AbortError'});pending.resolve();expect(s.canvas.loader).toBe(replacement);expect(s.canvas.shouldRevalidate).toBe(revalidate);expect(s.canvas.errorElement).toBe(errorElement);expect(s.canvas.hasErrorBoundary).toBe(false);
});

it('fails closed if the immutable router no longer has the expected canvas route',()=>{
 const {auth,listeners}=authFixture();expect(()=>installCanvasRouterLoader({routes:[{path:'/other'}]},{auth,storage:{loadProject:vi.fn()}},native)).toThrow('未找到画布路由');expect(listeners.size).toBe(0);
});

it('discovers the real RouterProvider after native mount and releases it only for final pagehide/disposal',async()=>{
 const {auth,listeners}=authFixture(),load=vi.fn(async()=>{}),router={routes:[{path:'/project/canvas/:id'}],state:{location:{pathname:'/projects/canvas/me/'}},revalidate:vi.fn(),navigate:vi.fn()},root=document.createElement('div');root.id='root';document.body.append(root);
 const props=(element:any)=>element?[{value:{router}}]:[],dispose=installCanvasRouteLoader({auth,storage:{loadProject:load}},native,props);disposers.push(dispose);
 expect(router.routes[0]).not.toHaveProperty('loader');root.append(document.createElement('main'));await settle(()=>expect(router.routes[0]).toHaveProperty('loader'));
 const loader=(router.routes[0] as any).loader;await loader(args());expect(load).toHaveBeenCalledOnce();
 const cachedHide=new Event('pagehide');Object.defineProperty(cachedHide,'persisted',{value:true});window.dispatchEvent(cachedHide);expect((router.routes[0] as any).loader).toBe(loader);
 window.dispatchEvent(new Event('pagehide'));expect((router.routes[0] as any).loader).toBeUndefined();expect(listeners.size).toBe(0);
});
