import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {ApiError} from '../../apps/web/src/api/client';
import {HistoryVideoGrants,installVideoHistoryGrants,type HistoryVideoGrantPort} from '../../apps/web/src/service/video-history-grants';
import {historyVideoPosterURL} from '../../apps/web/src/service/video-history-display';

const origin='https://studio.invalid',now=Date.parse('2026-11-05T08:00:00Z');
const url=(id='ast_video',grant='old')=>`${origin}/storage/assets/${id}?token=fixture.${grant}`;
const asset=(id='ast_video',grant='old',ttl=15*60000)=>({id,kind:'VIDEO',mimeType:'video/mp4',state:'READY',downloadUrl:url(id,grant),previewUrl:url(id,grant),urlsExpireAt:new Date(Date.now()+ttl).toISOString()});
const row=(id='ast_video')=>({id:'out_'+id,url:url(id),resultUrl:url(id),type:'VIDEO',taskId:'task',taskPlanId:'plan',createTime:now});
const deferred=<T>()=>{let resolve!:(value:T)=>void,reject!:(error:any)=>void;return{promise:new Promise<T>((yes,no)=>{resolve=yes;reject=no;}),resolve,reject};};
const flush=async()=>{for(let i=0;i<15;i++)await Promise.resolve();};
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(now);});afterEach(()=>vi.useRealTimers());
function manager(cached:any=asset()){
 let scope:string|null='user';const resolve=vi.fn().mockImplementation(async(id:string)=>asset(id,'new')),port:HistoryVideoGrantPort={scope:()=>scope,cached:id=>cached?.id===id?cached:undefined,resolve},grants=new HistoryVideoGrants(port,origin),owner={},epoch=grants.session();
 return{grants,owner,epoch,resolve,port,scope:(value:string|null)=>{scope=value;},watch:(rows=[row()])=>grants.watch(owner,rows,epoch)};
}

describe('metadata-authorized video history renewal',()=>{
 it('immediately replaces an expired row with already authorized current metadata, keeping IDs and inputs',()=>{
  const env=manager(asset('ast_video','fresh')),original=row();env.watch();const projected=env.grants.project([original],env.epoch)[0];
  expect(projected).toEqual({...original,url:url('ast_video','fresh'),resultUrl:url('ast_video','fresh')});expect(original.url).toBe(url());expect(env.resolve).not.toHaveBeenCalled();env.grants.dispose();
 });
 it('renews 50 seconds before metadata expiry and ignores focus storms while the grant is valid',async()=>{
  const env=manager();env.watch();for(let i=0;i<100;i++)env.grants.wake();expect(env.resolve).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(850000);expect(env.resolve).toHaveBeenCalledOnce();expect(env.grants.project([row()],env.epoch)[0].url).toBe(url('ast_video','new'));
  const preview=env.grants.project([{key:'canvas-history-video-out',url:url(),metadata:{prompt:'saved'}}],env.epoch,true)[0];expect(preview).toMatchObject({url:url('ast_video','new'),thumbnailUrl:historyVideoPosterURL(url('ast_video','new'),'preview'),metadata:{prompt:'saved'}});
  for(let i=0;i<100;i++)env.grants.wake();expect(env.resolve).toHaveBeenCalledOnce();env.grants.dispose();expect(vi.getTimerCount()).toBe(0);
 });
 it('shares pending reads across owners and aborts only after the final owner leaves',async()=>{
  const env=manager(undefined),pending=deferred<any>();env.port.cached=()=>undefined;env.resolve.mockReturnValue(pending.promise);env.watch();const second={};env.grants.watch(second,[row()],env.epoch);expect(env.resolve).toHaveBeenCalledOnce();
  const signal=env.resolve.mock.calls[0][1] as AbortSignal;env.grants.remove(env.owner);expect(signal.aborted).toBe(false);env.grants.remove(second);expect(signal.aborted).toBe(true);
  pending.resolve(asset('ast_video','late'));await flush();expect(env.grants.project([row()],env.epoch)[0].url).toBe('');expect(vi.getTimerCount()).toBe(0);env.grants.dispose();
 });
 it('does not show expired bytes while a stalled request waits, and fences a late success after its deadline',async()=>{
  const env=manager(asset('ast_video','old',1000)),pending=deferred<any>();env.resolve.mockReturnValue(pending.promise);env.watch();await vi.advanceTimersByTimeAsync(1001);
  expect(env.grants.project([row()],env.epoch)[0].url).toBe('');expect(env.grants.message(env.owner,env.epoch)).toContain('正在');
  await vi.advanceTimersByTimeAsync(14000);expect(env.grants.message(env.owner,env.epoch)).toContain('更新失败');pending.resolve(asset('ast_video','too-late'));await flush();expect(env.grants.project([row()],env.epoch)[0].url).toBe('');env.grants.dispose();
 });
 it.each([401,403,404])('removes denied URLs, stops automatic retries for %s, and allows explicit recovery',async status=>{
  const env=manager(asset('ast_video','old',40000));env.resolve.mockRejectedValue(new ApiError(status,'DENIED','Denied'));env.watch();await flush();expect(env.grants.project([row()],env.epoch)[0].url).toBe('');expect(env.grants.message(env.owner,env.epoch)).toContain('无权访问');
  await vi.advanceTimersByTimeAsync(600000);for(let i=0;i<100;i++)env.grants.wake();expect(env.resolve).toHaveBeenCalledOnce();
  env.resolve.mockResolvedValue(asset('ast_video','recovered'));env.grants.retry(env.owner,env.epoch);await flush();expect(env.resolve).toHaveBeenCalledTimes(2);expect(env.grants.project([row()],env.epoch)[0].url).toBe(url('ast_video','recovered'));env.grants.dispose();
 });
 it('bounds transient retries and deduplicates manual/online retry storms',async()=>{
  const env=manager(asset('ast_video','old',40000));env.resolve.mockRejectedValue(new ApiError(503,'TEMPORARY','later'));env.watch();await vi.advanceTimersByTimeAsync(600000);expect(env.resolve).toHaveBeenCalledTimes(3);
  env.resolve.mockImplementation(async()=>asset('ast_video','recovered'));for(let i=0;i<100;i++){env.grants.wake();env.grants.retry(env.owner,env.epoch);}await flush();expect(env.resolve).toHaveBeenCalledTimes(4);expect(env.grants.project([row()],env.epoch)[0].url).toBe(url('ast_video','recovered'));env.grants.dispose();
 });
 it('does not revive retained cached bytes when a denied row is unmounted then reopened',async()=>{
  const env=manager(asset('ast_video','old',40000));env.resolve.mockRejectedValue(new ApiError(403,'DENIED','revoked'));env.watch();await flush();env.grants.remove(env.owner);
  const pending=deferred<any>(),next={};env.resolve.mockReturnValue(pending.promise);expect(env.grants.project([row()],env.epoch)[0].url).toBe('');env.grants.watch(next,[row()],env.epoch);expect(env.grants.project([row()],env.epoch)[0].url).toBe('');
  pending.resolve(asset('ast_video','authorized-again'));await flush();expect(env.grants.project([row()],env.epoch)[0].url).toBe(url('ast_video','authorized-again'));env.grants.dispose();
 });
 it('fences old success and old denial after same-account sign-out/sign-in',async()=>{
  const env=manager(undefined);env.port.cached=()=>undefined;const old=deferred<any>(),next=deferred<any>();env.resolve.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);env.watch();env.scope(null);env.grants.reset();env.scope('user');env.grants.wake();
  const owner={},epoch=env.grants.session();env.grants.watch(owner,[row()],epoch);old.reject(new ApiError(403,'OLD_SESSION','old'));await flush();expect(env.grants.message(owner,epoch)).toContain('正在');expect(env.grants.project([row()],env.epoch)[0].url).toBe('');
  next.resolve(asset('ast_video','new-session'));await flush();expect(env.grants.project([row()],epoch)[0].url).toBe(url('ast_video','new-session'));expect(env.grants.project([row()],env.epoch)[0].url).toBe('');env.grants.dispose();
 });
 it('starts correctly when installed before login, and new mounted owners can share history across projects',()=>{
  const env=manager();env.scope(null);env.grants.reset();env.scope('user');env.grants.wake();const first={},second={},epoch=env.grants.session();env.grants.watch(first,[row()],epoch);env.grants.remove(first);env.grants.watch(second,[row()],epoch);
  expect(env.grants.project([row()],epoch)[0].url).toBe(url());expect(env.grants.message(second,epoch)).toBe('');env.grants.dispose();
 });
 it('cancels an old source and never applies it to a newly selected asset',async()=>{
  const env=manager(undefined);env.port.cached=()=>undefined;const a=deferred<any>(),b=deferred<any>();env.resolve.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);env.watch();env.watch([row('ast_second')]);expect(env.resolve.mock.calls[0][1].aborted).toBe(true);
  a.resolve(asset('ast_video','late'));b.resolve(asset('ast_second','fresh'));await flush();expect(env.grants.project([row('ast_second')],env.epoch)[0].url).toBe(url('ast_second','fresh'));env.grants.dispose();
 });
 it.each(['wrong-asset','wrong-kind','wrong-origin','expired','invalid-expiry'])('rejects inconsistent renewed metadata: %s',async kind=>{
  const env=manager(asset('ast_video','old',40000)),next:any=asset('ast_video','new');if(kind==='wrong-asset')next.id='other';if(kind==='wrong-kind')next.kind='IMAGE';if(kind==='wrong-origin')next.downloadUrl=next.downloadUrl.replace(origin,'https://other.invalid');if(kind==='expired')next.urlsExpireAt=new Date(now).toISOString();if(kind==='invalid-expiry')next.urlsExpireAt='unknown';
  env.resolve.mockResolvedValue(next);env.watch();await flush();expect(env.grants.project([row()],env.epoch)[0].url).toBe(url());expect(env.grants.message(env.owner,env.epoch)).toContain('更新失败');env.grants.dispose();
 });
});

const index=readFileSync(new URL('../../apps/web/public/project/assets/index-DeyN_Phq.js',import.meta.url),'utf8'),shell=readFileSync(new URL('../../apps/web/public/project/assets/CanvasEditorShell-Dt_89lTt.js',import.meta.url),'utf8');
const jsx=(type:any,props:any,...keys:any[])=>({type,props,keys});
const nodes=(tree:any):any[]=>!tree||typeof tree!=='object'?[]:[tree,...(Array.isArray(tree)?tree:Object.values(tree.props||{})).flatMap(nodes)];
function renderer(runEffects=true){
 const states:any[]=[],refs:any[]=[],effects:any[]=[],memos:any[]=[],subscriptions:(()=>void)[]=[];let si=0,ri=0,ei=0,mi=0,dirty=false,queue:Function[]=[];
 const changed=(before:any[]|undefined,after:any[]|undefined)=>!before||!after||before.length!==after.length||before.some((value,i)=>!Object.is(value,after[i]));
 const effect=(fn:Function,deps:any[])=>{const i=ei++;if(changed(effects[i]?.deps,deps)){queue.push(()=>{effects[i]?.cleanup?.();effects[i]={deps,cleanup:runEffects?fn():undefined};});}};
 const react:any={Fragment:'fragment',isValidElement:(value:any)=>!!value?.type,cloneElement:(element:any,props:any)=>({...element,props:{...element.props,...props}}),forwardRef:(render:Function)=>({render}),useState:(initial:any)=>{const i=si++;if(!(i in states))states[i]=typeof initial==='function'?initial():initial;return[states[i],(value:any)=>{const next=typeof value==='function'?value(states[i]):value;if(!Object.is(next,states[i])){states[i]=next;dirty=true;}}];},useRef:(initial:any)=>refs[ri]??(refs[ri++]={current:initial}),useMemo:(fn:Function,deps:any[])=>{const i=mi++;if(changed(memos[i]?.deps,deps))memos[i]={deps,value:fn()};return memos[i].value;},useCallback:(fn:Function)=>fn,useEffect:effect,useLayoutEffect:effect,useImperativeHandle:(ref:any,fn:Function,deps:any[])=>effect(()=>{if(ref)ref.current=fn();},deps),useSyncExternalStore:(subscribe:Function,snapshot:Function)=>{effect(()=>{const release=subscribe(()=>{dirty=true;});subscriptions.push(release);return release;},[subscribe]);return snapshot();}};
 // Refs need a stable position even when the previous value already exists.
 react.useRef=(initial:any)=>{const i=ri++;return refs[i]??(refs[i]={current:initial});};react.useCallback=(fn:Function,deps:any[])=>react.useMemo(()=>fn,deps);
 return{react,render:(type:any,props:any,ref?:any)=>{let tree:any,count=0;do{dirty=false;si=ri=ei=mi=0;queue=[];tree=(typeof type==='function'?type:type.render)(props,ref);for(const run of queue)run();if(++count>15)throw new Error('render loop');}while(dirty);return tree;},unmount:()=>{for(const item of effects)item?.cleanup?.();for(const release of subscriptions)release();}};
}
function integration(ttl=40000){
 const engine=renderer(),surface:any=new EventTarget();surface.location={origin,pathname:'/project/canvas/project'};surface.document=new EventTarget();surface.document.visibilityState='visible';
 const stateInitializers:any[]=[],useState=engine.react.useState;engine.react.useState=function(initial:any){stateInitializers.push(initial);return useState(initial);};
 const resolve=vi.fn().mockImplementation(async()=>asset('ast_video','new')),cache=asset('ast_video','old',ttl),port:HistoryVideoGrantPort={scope:()=> 'user',cached:()=>cache,resolve};
 const api=vi.fn().mockResolvedValue({records:[row()],total:1}),open=vi.fn(),download=vi.fn(),copy=vi.fn().mockResolvedValue(true),toast={error:vi.fn(),success:vi.fn(),info:vi.fn()};
 const native:any={r:engine.react,j:{jsx,jsxs:jsx,Fragment:'fragment'}},sandbox:any={Set,Map,Array,Object,String,Number,Math,Boolean,Promise,d:engine.react,c:native.j,It:()=>({t:(key:string)=>key}),VJn:(rows:any[])=>rows.length?[{date:'2026-11-05',items:rows}]:[],zJn:(value:any)=>value,FB:()=>false,Kbt:()=>false,Ybt:()=>false,Xbt:()=>false,Oo:(value:string)=>historyVideoPosterURL(value),QJn:open,Xl:download,qJn:()=> 'mp4',Dp:copy,Ie:toast,_Mn:api,HJn:(value:string)=>value,oer:(value:any)=>({...value}),rer:()=>Promise.resolve({}),eer:()=>({prompt:'saved'}),window:{},document:{},IntersectionObserver:class{observe(){}disconnect(){}}};
 // Execute the real frozen translation hook, including its function-initializer
 // useState before the history records state. A pure `t` stub missed this seam.
 const languageListeners=new Set<()=>void>();let language='zh';
 const i18n={options:{defaultNS:'translation'},isInitialized:true,languages:['zh'],getFixedT:()=>{const captured=language;return(key:string)=>captured==='zh'?key:'en:'+key;},hasLoadedNamespace:()=>true,on:(_event:string,fn:()=>void)=>languageListeners.add(fn),off:(_event:string,fn:()=>void)=>languageListeners.delete(fn)};
 engine.react.useContext=()=>undefined;
 const helperStart=index.indexOf('class lZt{'),helperEnd=index.indexOf(';function cnt(',helperStart),readyStart=index.indexOf('XQt='),readyEnd=index.indexOf(',hE=',readyStart);
 const translation=runInNewContext('const '+index.slice(readyStart,readyEnd)+';'+index.slice(helperStart,helperEnd)+';It',{d:engine.react,sZt:{},aZt:()=>i18n,rZt:()=>({bindI18n:'languageChanged',useSuspense:false}),hE:(value:any)=>typeof value==='string',QQt:(value:any)=>typeof value==='object'&&value!==null,Ffe:vi.fn(),Array,Object,Promise});
 sandbox.It=translation;
 const start=index.indexOf('const Jbt=d.forwardRef('),end=index.indexOf('}),aer=',start)+2;
 native.dp=runInNewContext(index.slice(start,end)+';Jbt',new Proxy(sandbox,{get:(target,key)=>key in target?target[key]:typeof key==='string'?function NativeIcon(){}:undefined}));
 const release=installVideoHistoryGrants(native,port,surface),props={type:'VIDEO',visible:true,activeTab:'VIDEO',scope:'personal',isTeamCanvas:false,selectMode:false,selectedIds:new Set(),onItemClick:vi.fn(),onToggleSelect:vi.fn(),onToggleDateSelect:vi.fn()},ref={current:null as any};
 const render=()=>{const wrapped=native.j.jsx(native.dp,props);return engine.render(wrapped.type,wrapped.props,ref);};
 return{engine,native,props,port,resolve,surface,api,open,download,copy,toast,render,ref,release,sandbox,stateInitializers,changeLanguage:()=>{language='en';for(const listener of languageListeners)listener();},languageListeners};
}
function outerRender(native:any,engine:ReturnType<typeof renderer>,element:any){
 const keys=['useState','useRef','useMemo','useCallback','useEffect','useLayoutEffect','useImperativeHandle','useSyncExternalStore'],saved=Object.fromEntries(keys.map(key=>[key,native.r[key]]));
 try{for(const key of keys)native.r[key]=engine.react[key];return engine.render(element.type,element.props);}finally{Object.assign(native.r,saved);}
}

describe('actual frozen native history contracts',()=>{
 it('passes the real nested translation state unchanged and renews every actual row action from the records candidate',async()=>{
  const env=integration(),original=env.engine.react.useState;try{
   env.render();expect(typeof env.stateInitializers[0]).toBe('function');expect(env.stateInitializers[1]).toEqual([]);await flush();env.render();await flush();const tree=env.render();expect(env.engine.react.useState).toBe(original);expect(env.api,'history list loader').toHaveBeenCalledOnce();expect(env.resolve,'grant renewal').toHaveBeenCalledOnce();expect(env.ref.current.getItems()[0]).toMatchObject({id:'out_ast_video',url:url('ast_video','new'),taskId:'task',taskPlanId:'plan'});
   const action=(label:string)=>nodes(tree).find(node=>node.props?.label===label)?.props.children.props.onClick({stopPropagation:vi.fn()});
   action('canvas.assetsPanel.view');expect(env.open).toHaveBeenCalledWith(expect.objectContaining({activeRecord:expect.objectContaining({resultUrl:url('ast_video','new'),id:'out_ast_video'})}));
   action('canvas.assetLibraryModal.use');expect(env.props.onItemClick).toHaveBeenCalledWith(expect.objectContaining({resultUrl:url('ast_video','new'),taskPlanId:'plan'}));await action('canvas.imageToolbar.download');expect(env.download).toHaveBeenCalledWith(url('ast_video','new'),'canvas-history-out_ast_video.mp4');
   expect(nodes(tree).find(node=>node.type==='img'&&node.props.alt==='history-out_ast_video')?.props.src).toBe(historyVideoPosterURL(url('ast_video','new')));
   const item=nodes(tree).find(node=>node.props?.className==='history-item');item.props.onMouseEnter();await flush();const hovered=env.render();expect(nodes(hovered).find(node=>node.type==='video')?.props.src).toBe(url('ast_video','new'));
   env.props.visible=false;env.render();await vi.advanceTimersByTimeAsync(1800000);expect(env.resolve).toHaveBeenCalledOnce();
  }finally{env.engine.unmount();env.release();}expect(vi.getTimerCount()).toBe(0);
 });
 it('keeps real translation-hook updates independent from records renewal and preserves its original setter',async()=>{
  const env=integration(),original=env.engine.react.useState;try{
   env.render();await flush();env.render();await flush();let tree=env.render();expect(env.languageListeners.size).toBe(1);expect(env.resolve).toHaveBeenCalledOnce();
   env.changeLanguage();tree=env.render();expect(env.engine.react.useState).toBe(original);const use=nodes(tree).find(node=>node.props?.label==='en:canvas.assetLibraryModal.use');expect(use).toBeDefined();use.props.children.props.onClick({stopPropagation:vi.fn()});
   expect(env.props.onItemClick).toHaveBeenCalledWith(expect.objectContaining({resultUrl:url('ast_video','new'),id:'out_ast_video'}));expect(env.api).toHaveBeenCalledOnce();expect(env.resolve).toHaveBeenCalledOnce();
  }finally{env.engine.unmount();env.release();}expect(env.languageListeners.size).toBe(0);
 });
 it('restores the React hook even when the actual native render throws',()=>{
  const env=integration(),original=env.engine.react.useState;env.sandbox.VJn=()=>{throw new Error('native-render-error');};try{expect(()=>env.render()).toThrow('native-render-error');expect(env.engine.react.useState).toBe(original);}finally{env.engine.unmount();env.release();}
 });
 it('does not wrap image history, unknown forwardRefs or an altered native hook signature',()=>{
  const env=integration();try{expect(env.native.j.jsx(env.native.dp,{...env.props,type:'IMAGE'}).type).toBe(env.native.dp);const other={render:()=>null};expect(env.native.j.jsx(other,env.props).type).toBe(other);}finally{env.engine.unmount();env.release();}
 });
 it('disables only denied native rows and restores their original media actions after a successful retry',async()=>{
  const env=integration();env.api.mockResolvedValue({records:[row(),row('ast_readable')],total:2});env.port.cached=id=>id==='ast_readable'?asset(id,'valid',30*60000):asset();env.resolve.mockRejectedValue(new ApiError(403,'DENIED','denied'));
  try{
   env.render();await flush();env.render();await vi.advanceTimersByTimeAsync(850000);let tree=env.render();
   const blocked=nodes(tree).find(node=>node.props?.['data-studio-history-video-state']==='unavailable');expect(blocked).toBeDefined();expect(nodes(blocked).filter(node=>node.type==='button').every(node=>node.props.disabled===true)).toBe(true);
   expect(nodes(blocked).filter(node=>node.type==='img'||node.type==='video')).toEqual([]);expect(nodes(blocked).some(node=>node.props?.alt?.startsWith('history-'))).toBe(false);expect(nodes(blocked).find(node=>node.props?.['data-studio-history-video-placeholder'])?.props).toMatchObject({children:'视频暂不可用',style:{pointerEvents:'none'}});
   const allowed=nodes(tree).find(node=>node.props?.className==='history-item'&&!node.props?.['aria-disabled']);expect(allowed).toBeDefined();expect(nodes(allowed).filter(node=>node.type==='button').every(node=>node.props.disabled!==true)).toBe(true);
   expect(nodes(allowed).some(node=>node.props?.['data-studio-history-video-placeholder'])).toBe(false);expect(nodes(allowed).find(node=>node.type==='img')?.props.src).toBe(historyVideoPosterURL(url('ast_readable','valid')));
   blocked.props.onClick({preventDefault:vi.fn(),stopPropagation:vi.fn()});expect(env.open).not.toHaveBeenCalled();
   await vi.advanceTimersByTimeAsync(1000);env.resolve.mockImplementation(async(id:string)=>asset(id,'recovered'));nodes(tree).find(node=>node.type==='button'&&node.props.children==='重试').props.onClick();await flush();tree=env.render();
   expect(nodes(tree).some(node=>node.props?.['data-studio-history-video-state']==='unavailable')).toBe(false);expect(env.ref.current.getItems().find((item:any)=>item.id==='out_ast_video').resultUrl).toBe(url('ast_video','recovered'));
   expect(nodes(tree).some(node=>node.props?.['data-studio-history-video-placeholder'])).toBe(false);
  }finally{env.engine.unmount();env.release();}
 });
 it('shows an unavailable poster in actual native bulk selection while keeping selection and deletion callbacks',async()=>{
  const env=integration();env.props.selectMode=true;env.resolve.mockRejectedValue(new ApiError(403,'DENIED','revoked'));const remove=vi.fn().mockResolvedValue({successList:['out_ast_video'],failList:[]});env.sandbox.TMn=remove;
  try{
   env.render();await flush();env.render();await flush();let tree=env.render();const blocked=nodes(tree).find(node=>node.props?.['data-studio-history-video-state']==='unavailable');expect(blocked).toBeDefined();expect(blocked.props['aria-disabled']).toBeUndefined();
   expect(nodes(blocked).some(node=>node.type==='img'||node.type==='video'||node.props?.alt?.startsWith('history-'))).toBe(false);expect(nodes(blocked).find(node=>node.props?.['data-studio-history-video-placeholder'])?.props.children).toBe('视频暂不可用');
   blocked.props.onClick();expect(env.props.onToggleSelect).toHaveBeenCalledWith(expect.objectContaining({id:'out_ast_video'}));await env.ref.current.batchDeleteByIds(['out_ast_video']);expect(remove).toHaveBeenCalledWith({ids:['out_ast_video']},{scope:'personal'});tree=env.render();expect(nodes(tree).some(node=>node.props?.['data-studio-history-video-placeholder'])).toBe(false);
  }finally{env.engine.unmount();env.release();}
 });
 it('renews the already-open native video context menu item and keeps download/export bound to its output',async()=>{
  const env=integration(150000),outerEngine=renderer(),menuEngine=renderer(),start=shell.indexOf('function aS('),end=shell.indexOf('function u4(',start),close=vi.fn(),download=vi.fn(),exportTo=vi.fn();
  const menu=runInNewContext(shell.slice(start,end)+';aS',{p:menuEngine.react,c:env.native.j,Xe:()=>({t:(key:string)=>key}),lr:{createPortal:(tree:any)=>tree},vr:{mediaPreview:100},document:{body:{},addEventListener:vi.fn(),removeEventListener:vi.fn()},window:{innerWidth:1000,innerHeight:800}});
  const item={key:'canvas-history-video-out_ast_video',url:url(),canvasHistoryTaskId:'task',canvasHistoryTaskPlanId:'plan',metadata:{prompt:'saved'}},props={item,kind:'video',position:{x:10,y:10},onClose:close,onDownload:download,onExportToCanvas:exportTo};
  try{
   env.render();await flush();env.render();const wrapped=env.native.j.jsx(menu,props);expect(wrapped.type.name).toBe('VideoHistoryMenu');expect(outerRender(env.native,outerEngine,wrapped).props.item.url).toBe(url());
   await vi.advanceTimersByTimeAsync(100000);const projected=outerRender(env.native,outerEngine,wrapped);expect(projected.props.item).toMatchObject({...item,url:url('ast_video','new')});
   const tree=menuEngine.render(projected.type,projected.props),buttons=nodes(tree).filter(node=>node.type==='button');buttons.find(node=>node.props.children==='canvas.nodeOutputHistory.downloadCurrent').props.onClick();buttons.find(node=>node.props.children==='canvas.nodeOutputHistory.exportToCanvas').props.onClick();
   expect(download).toHaveBeenCalledWith(expect.objectContaining({url:url('ast_video','new'),canvasHistoryTaskPlanId:'plan'}));expect(exportTo).toHaveBeenCalledWith(expect.objectContaining({url:url('ast_video','new'),key:item.key}));expect(close).toHaveBeenCalledTimes(2);
   env.resolve.mockRejectedValue(new ApiError(403,'DENIED','revoked'));await vi.advanceTimersByTimeAsync(850000);expect(outerRender(env.native,outerEngine,wrapped)).toBeNull();expect(close).toHaveBeenCalledTimes(3);
  }finally{menuEngine.unmount();outerEngine.unmount();env.engine.unmount();env.release();}
 });
 it('updates an already-open actual C4 video player and its download, then removes media actions on revocation',async()=>{
  const env=integration(150000),outerEngine=renderer(),previewEngine=renderer(false),download=vi.fn(),exportTo=vi.fn().mockResolvedValue(true),close=vi.fn(),start=shell.indexOf('function C4('),end=shell.indexOf('const ev=',start);
  const sandbox:any={Set,Map,Array,Object,String,Number,Math,Boolean,Date,undefined,p:previewEngine.react,c:env.native.j,Xe:()=>({t:(key:string)=>key}),ol:(selector:Function)=>selector({running:false,start:vi.fn()}),k4:()=>2,w4:()=>[],Y0:()=>({min:.25,max:4,step:.1,scale:1}),jc:()=>({width:0,height:0}),S4:()=> '2026-11-05',Qc:()=> 'video',Tf:download,X0:()=> 'mp4',window:{innerWidth:1000,innerHeight:800},document:{},console};
  const C4=runInNewContext(shell.slice(start,end)+';C4',new Proxy(sandbox,{get:(target,key)=>key in target?target[key]:typeof key==='string'?function NativeUiStub(){}:undefined})),item={key:'canvas-history-video-out_ast_video',url:url(),thumbnailUrl:historyVideoPosterURL(url(),'preview'),canvasHistoryTaskId:'task',canvasHistoryTaskPlanId:'plan'},props={kind:'video',items:[item],activeIndex:0,onSelect:vi.fn(),onExportToCanvas:exportTo,onClose:close};
  try{
   env.render();await flush();env.render();const wrapped=env.native.j.jsx(C4,props);expect(wrapped.type.name).toBe('VideoHistoryPreview');let projected=outerRender(env.native,outerEngine,wrapped);expect(projected.props.items[0].url).toBe(url());
   await vi.advanceTimersByTimeAsync(100000);projected=outerRender(env.native,outerEngine,wrapped);const tree=previewEngine.render(projected.type,projected.props),video=nodes(tree).find(node=>node.type==='video');expect(video.props).toMatchObject({src:url('ast_video','new'),poster:historyVideoPosterURL(url('ast_video','new'),'preview')});
   nodes(tree).find(node=>node.type==='button'&&node.props['aria-label']==='canvas.nodeOutputHistory.downloadCurrent').props.onClick();await flush();expect(download).toHaveBeenCalledWith(url('ast_video','new'),'video-01.mp4');
   nodes(tree).find(node=>node.type==='button'&&node.props['aria-label']==='canvas.nodeOutputHistory.exportToCanvas').props.onClick();await flush();expect(exportTo).toHaveBeenCalledWith(expect.objectContaining({url:url('ast_video','new'),canvasHistoryTaskPlanId:'plan'}));
   env.resolve.mockRejectedValue(new ApiError(403,'DENIED','revoked'));await vi.advanceTimersByTimeAsync(850000);const unavailable=outerRender(env.native,outerEngine,wrapped);expect(nodes(unavailable).some(node=>node.type===C4)).toBe(false);expect(nodes(unavailable).some(node=>node.props?.children?.includes?.('无权访问'))).toBe(true);nodes(unavailable).find(node=>node.type==='button'&&node.props.children==='关闭').props.onClick();expect(close).toHaveBeenCalledOnce();
  }finally{previewEngine.unmount();outerEngine.unmount();env.engine.unmount();env.release();}
 });
});
