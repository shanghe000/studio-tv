import {afterEach,expect,it,vi} from 'vitest';
import {generationTarget,installNativeEntityIntegration,installNativeGenerationControls,nativeGenerationAction,nativeGroupGenerationAction,nativeProps} from '../../apps/web/src/service/native-integration';
import {capabilityModel,ExecutionAdapter} from '../../apps/web/src/service/execution';
import motionCatalog from './fixtures/router-motion-capabilities.json';
import sourceMotionCatalog from './fixtures/router-motion-source-capabilities.json';
import {ModelBindings} from '../../apps/web/src/service/model-bindings';
import officialCatalog from './fixtures/router-official-video-capabilities.json';
import {videoCancellationReason} from '../../apps/web/src/service/video-input';
import {ProductClient} from '../../apps/web/src/service/product-client';
import {ServiceStorage} from '../../apps/web/src/service/storage';
import {readFileSync} from 'node:fs';
const graph={nodes:[{id:'image',type:'rh-image'},{id:'group',type:'rh-group'}]};
function button(props:any[]=[]){let fiber:any=null;for(const item of [...props].reverse())fiber={memoizedProps:item,return:fiber};return{__reactFiber$owned:fiber,closest:()=>null};}
it('uses exact native node and parameter props for the generation seam',()=>{
 const run=vi.fn(),element=button([{onClick:vi.fn()},{currentModel:{modelCode:'mock-image'},params:{prompt:'fox'},visible:true,onClick:run},{nodeId:'image'}]);expect(nativeProps(element)).toHaveLength(3);expect(nativeGenerationAction(element)?.onClick).toBe(run);expect(generationTarget(element,{selectedNodeIds:['group']},graph)).toBe('image');
});
it('respects native selection and ignores unrelated controls or multi-selection',()=>{
 expect(nativeGenerationAction(button([{onClick:vi.fn(),visible:true}]))).toBeUndefined();expect(nativeGroupGenerationAction(button([{onClick:vi.fn(),className:'execute-btn'}]))).toBeNull();expect(generationTarget(button(),{selectedNodeIds:['image','group']},graph)).toBeNull();expect(generationTarget(button(),{expandedNodeId:'image'},graph)).toBe('image');expect(generationTarget(button([{groupId:'group'}]),{},graph)).toBe('group');expect(generationTarget(button([{groupNode:{id:'group'}}]),{selectedNodeIds:['image']},graph)).toBe('group');
});
it('prefers the explicit native node DOM ID over a stale selection',()=>{
 const element={closest:(selector:string)=>selector==='[data-node-id]'?{getAttribute:()=> 'image'}:null};expect(generationTarget(element,{selectedNodeIds:['group']},graph)).toBe('image');
});
afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers();});

function domElement(tagName:string,className:string,parent:any=null,attributes:Record<string,string>={}){
 const children:any[]=[],classes=new Set(className.split(' ').filter(Boolean));
 const element:any={tagName:tagName.toUpperCase(),className,parent,children,disabled:false,textContent:'',
  getAttribute:(name:string)=>attributes[name]??null,setAttribute:(name:string,value:string)=>{attributes[name]=value;},removeAttribute:(name:string)=>{delete attributes[name];},
  matches:(selector:string)=>selector.split(',').some(part=>{const value=part.trim(),match=value.match(/^\[([^\]]+)\]$/);if(match)return Object.hasOwn(attributes,match[1]);const css=value.match(/^\.([\w-]+)(?:\[([^\]]+)\])?$/);return css?classes.has(css[1])&&(!css[2]||Object.hasOwn(attributes,css[2])):value.toUpperCase()===element.tagName;}),
  closest:(selector:string)=>element.matches(selector)?element:parent?.closest(selector)||null,
  querySelector:(selector:string):any=>{for(const child of children){if(child.matches(selector))return child;const match=child.querySelector(selector);if(match)return match;}return null;},
 };
 parent?.children.push(element);return element;
}
function controls(overrides:any={},options:{panelClass?:string;buttonClass?:string;label?:string;initialRunning?:string[];initialData?:any;remembered?:{taskId:string|null;ttl:number;data?:any}}={}){
 const snapshot:any={nodes:[{id:'image',type:'rh-image',data:{status:'idle',params:{prompt:'saved'}}}],edges:[]},listeners=new Map<string,any>(),hooks:any={current:null},prefs={submitTask:'shift-enter'};
 Object.assign(snapshot.nodes[0].data,options.initialData);
 const node=domElement('div','react-flow__node',null,{'data-id':'image'}),panel=domElement('div',options.panelClass||'rh-params-card',node),container=domElement('div','generate-btn-container',panel,{inert:''}),button=domElement('button',options.buttonClass||'generate-action-button',container,{'aria-label':options.label||'生成'}),input=domElement('textarea','',panel);
 button.disabled=true;
 let terminalListener:any,settledListener:any,runningPort:any,nativeState:any;const releaseTerminal=vi.fn(()=>{terminalListener=null;}),releaseSettled=vi.fn(()=>{settledListener=null;}),releaseRunningPort=vi.fn(()=>{runningPort=null;}),unmarkLocalRunning=vi.fn((id:string)=>{nativeState.localRunningNodeIds=nativeState.localRunningNodeIds.filter((value:string)=>value!==id);});
 const originalMark=vi.fn((id:string)=>{if(!nativeState.localRunningNodeIds.includes(id))nativeState.localRunningNodeIds.push(id);}),originalRefresh=vi.fn((id:string)=>{if(!nativeState.localRunningNodeIds.includes(id))nativeState.localRunningNodeIds.push(id);});
 nativeState={selectedNodeIds:['image'],localRunningNodeIds:options.initialRunning||[],markLocalRunning:originalMark,refreshLocalRunningBaseline:originalRefresh,unmarkLocalRunning,isLocalRunning:(id:string)=>nativeState.localRunningNodeIds.includes(id)};
 const execution={generate:vi.fn(async(id:string)=>({id,prompt:snapshot.nodes[0].data.params.prompt})),cancelNode:vi.fn().mockResolvedValue(undefined),recoverNativeRunning:vi.fn(),onTerminal:vi.fn((listener:any)=>{terminalListener=listener;return releaseTerminal;}),onSettled:vi.fn((listener:any)=>{settledListener=listener;return releaseSettled;}),installNativeRunningPort:vi.fn((port:any)=>{runningPort=port;return releaseRunningPort;})};
 const action={currentModel:{modelCode:'mock-image',available:true},params:{prompt:'unsaved panel text'},visible:true,disabled:false,isGenerating:false,preflight:vi.fn(),onClick:vi.fn(()=>{snapshot.nodes[0].data.params={prompt:action.params.prompt};return hooks.current.onGenerate('image');}),...overrides};
 button.__reactFiber$owned={memoizedProps:{onClick:vi.fn()},return:{memoizedProps:action,return:{memoizedProps:{nodeId:'image'}}}};
 const manager={getRemoteData:()=>snapshot},native:any={bt:()=>manager,le:vi.fn((value:any)=>{hooks.current=value;}),c5:{getState:()=>nativeState,setState:(patch:any)=>{nativeState={...nativeState,...patch};}},gw:()=>prefs};
 if(options.remembered){native.fp=vi.fn(()=>options.remembered!.taskId);native.fX=vi.fn((_project:string,_nodes:any[],restore:Function)=>restore('image',options.remembered!.data||snapshot.nodes[0].data,options.remembered!.ttl));}
 const runtime={auth:{user:{id:'studio-user'} as any},inspect:()=>({id:'p'}),execution},notice=vi.fn(),style={id:'',textContent:'',remove:vi.fn()},disconnect=vi.fn(),observe=vi.fn();let mutationCallback:()=>void=()=>{};
 vi.stubGlobal('document',{body:{},head:{append:vi.fn()},createElement:()=>style,querySelectorAll:()=>[button],addEventListener:(kind:string,listener:any,capture:boolean)=>{expect(capture).toBe(true);listeners.set(kind,listener);},removeEventListener:(kind:string,listener:any)=>{if(listeners.get(kind)===listener)listeners.delete(kind);}});
 vi.stubGlobal('MutationObserver',class{constructor(callback:()=>void){mutationCallback=callback;}observe(...args:any[]){observe(...args);}disconnect(){disconnect();}});
 const dispose=installNativeGenerationControls(runtime,notice,native);
 const key=(values:any={})=>{const event:any={target:input,key:'Enter',shiftKey:true,altKey:false,ctrlKey:false,metaKey:false,isComposing:false,preventDefault:vi.fn(),stopImmediatePropagation:vi.fn(),...values};listeners.get('keydown')?.(event);return event;};
 const click=()=>{const event:any={target:button,preventDefault:vi.fn(),stopImmediatePropagation:vi.fn()};listeners.get('click')?.(event);return event;};
 return{action,button,container,node,snapshot,execution,hooks,native,runtime,prefs,notice,key,click,dispose,listeners,style,disconnect,observe,mutate:()=>mutationCallback(),manager,releaseTerminal,releaseSettled,releaseRunningPort,originalMark,originalRefresh,unmarkLocalRunning,runningPort:()=>runningPort,settled:(update:any)=>settledListener?.(update),terminal:(update:any)=>terminalListener?.(update)};
}

it('disables native stop controls and explains the limit for all real motion and official video profiles',async()=>{
 for(const raw of [...motionCatalog,...officialCatalog] as any[]){
  const cap={...raw,testMode:false},model=capabilityModel(cap),control=controls({currentModel:model,isGenerating:true},{label:'停止生成',initialData:{status:'processing',taskId:'accepted'}});control.snapshot.nodes[0].type='rh-video';control.button.disabled=false;(control.execution as any).nodeCancellationReason=()=>videoCancellationReason(cap);
  await Promise.resolve();expect(control.button.disabled).toBe(true);expect(control.button.getAttribute('title')).toContain('提交后不能停止');expect(control.button.getAttribute('aria-disabled')).toBe('true');control.click();control.hooks.current.onCancelGenerate('image');expect(control.execution.cancelNode).not.toHaveBeenCalled();expect(control.unmarkLocalRunning).not.toHaveBeenCalled();control.dispose();expect(control.button.disabled).toBe(false);expect(control.button.getAttribute('aria-label')).toBe('停止生成');
 }
});

it.each(['unknown','supported','test-mode'])('retains cancellation semantics for %s video support',async mode=>{
 const cap:any={...(motionCatalog as any[])[0],testMode:mode==='test-mode',supportsCancel:mode==='unknown'?undefined:mode==='supported'},control=controls({currentModel:capabilityModel(cap)},{label:'停止生成',initialData:{taskId:'accepted'}});control.snapshot.nodes[0].type='rh-video';control.button.disabled=false;await Promise.resolve();expect(control.button.getAttribute('data-studio-video-cancel-blocked')).toBeNull();control.click();expect(control.execution.cancelNode).toHaveBeenCalledExactlyOnceWith('image');control.dispose();
});

it.each(['local rejection','terminal failure'])('releases an icon-only video Stop decoration after %s, even if the lease is no longer current',async mode=>{
 const cap={...(motionCatalog as any[])[0],testMode:false},c=controls({currentModel:capabilityModel(cap),isGenerating:true},{label:'停止生成',initialRunning:['image'],initialData:{status:'processing',taskId:'accepted'}});c.snapshot.nodes[0].type='rh-video';c.button.disabled=false;(c.execution as any).nodeCancellationReason=()=>videoCancellationReason(cap);
 await Promise.resolve();expect(c.button.getAttribute('data-studio-video-cancel-blocked')).toBe('true');expect(c.button.textContent).toBe('');
 const lease=c.runningPort().capture('image',c.manager);c.native.c5.getState().unmarkLocalRunning('image');c.action.isGenerating=false;c.snapshot.nodes[0].data.status=mode==='terminal failure'?'failed':'idle';
 // The prior lease has already lost ownership, as in the real failed/local
 // rejection cases. Release follows this button's current render/action.
 expect(lease.current()).toBe(false);c.mutate();await Promise.resolve();
 expect(c.button.getAttribute('data-studio-video-cancel-blocked')).toBeNull();expect(c.button.getAttribute('title')).toBeNull();expect(c.button.getAttribute('aria-disabled')).toBeNull();expect(c.button.getAttribute('aria-label')).toBe('开始生成');expect(c.button.disabled).toBe(false);expect(c.container.getAttribute('inert')).toBeNull();
 c.click();expect(c.action.onClick).toHaveBeenCalledOnce();expect(c.execution.generate).toHaveBeenCalledExactlyOnceWith('image');expect(c.execution.cancelNode).not.toHaveBeenCalled();c.dispose();
});

it.each(['finished','failed'])('uses the latest exact React button props when a %s video replaces Stop with Generate',async status=>{
 const c=controls({currentModel:capabilityModel({...motionCatalog[0],testMode:false}),isGenerating:true},{label:'停止生成',initialRunning:['image'],initialData:{status:'processing',taskId:'accepted'}});c.snapshot.nodes[0].type='rh-video';c.button.disabled=false;
 await Promise.resolve();expect(c.button.getAttribute('data-studio-video-cancel-blocked')).toBe('true');
 c.action.isGenerating=false;c.snapshot.nodes[0].data.status=status;c.native.c5.getState().unmarkLocalRunning('image');
 // React's committed host slot is current while the ancestor fiber still has
 // Stop props. An icon-only button need not change its disabled DOM property.
 c.button.__reactFiber$owned.memoizedProps={className:'generate-action-button',disabled:false,'aria-label':'停止生成'};
 c.button.__reactProps$owned={className:'generate-action-button',disabled:false,'aria-label':'开始生成',title:'重新生成此视频','aria-disabled':false};
 c.mutate();await Promise.resolve();
 expect(c.button.disabled).toBe(false);expect(c.button.getAttribute('data-studio-video-cancel-blocked')).toBeNull();expect(c.button.getAttribute('aria-label')).toBe('开始生成');expect(c.button.getAttribute('title')).toBe('重新生成此视频');expect(c.button.getAttribute('aria-disabled')).toBe('false');
 expect(c.observe).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({characterData:true,attributeFilter:expect.arrayContaining(['aria-label','class'])}));
 c.click();expect(c.execution.generate).toHaveBeenCalledExactlyOnceWith('image');expect(c.execution.cancelNode).not.toHaveBeenCalled();c.dispose();
});

it('recovers a stale icon-only Stop decoration in the click turn before its mutation refresh',async()=>{
 const c=controls({currentModel:capabilityModel({...motionCatalog[0],testMode:false}),isGenerating:true},{label:'Stop',initialRunning:['image'],initialData:{status:'processing'}});c.button.disabled=false;await Promise.resolve();
 c.action.isGenerating=false;c.native.c5.getState().unmarkLocalRunning('image');c.snapshot.nodes[0].data.status='idle';
 c.click();expect(c.button.getAttribute('data-studio-video-cancel-blocked')).toBeNull();expect(c.button.getAttribute('aria-label')).toBe('Generate');expect(c.execution.generate).toHaveBeenCalledExactlyOnceWith('image');expect(c.execution.cancelNode).not.toHaveBeenCalled();c.dispose();
});

it.each(['native action','local running'])('keeps real unsupported video cancellation blocked while %s is active',async running=>{
 const c=controls({currentModel:capabilityModel({...motionCatalog[0],testMode:false}),isGenerating:running==='native action'},{label:'停止生成',initialRunning:running==='local running'?['image']:[],initialData:{status:'processing'}});c.button.disabled=false;await Promise.resolve();
 c.button.__reactProps$owned={className:'generate-action-button',disabled:false,'aria-label':'开始生成'};c.mutate();await Promise.resolve();
 expect(c.button.getAttribute('data-studio-video-cancel-blocked')).toBe('true');expect(c.button.disabled).toBe(true);c.click();expect(c.execution.cancelNode).not.toHaveBeenCalled();expect(c.execution.generate).not.toHaveBeenCalled();expect(c.notice).toHaveBeenCalledWith(expect.stringContaining('提交后不能停止'));c.dispose();
});

it('preserves native attribute updates and an unavailable action when removing a Stop decoration',async()=>{
 const c=controls({currentModel:capabilityModel({...motionCatalog[0],testMode:false}),isGenerating:true},{label:'停止生成'});c.button.disabled=false;await Promise.resolve();
 c.action.isGenerating=false;c.action.disabled=true;c.button.__reactProps$owned={className:'generate-action-button',disabled:true,'aria-label':'开始生成',title:'请先添加图片','aria-disabled':true};
 c.button.setAttribute('aria-label','开始生成');c.button.setAttribute('title','请先添加图片');c.button.setAttribute('aria-disabled','true');c.mutate();await Promise.resolve();
 expect(c.button.getAttribute('data-studio-video-cancel-blocked')).toBeNull();expect(c.button.disabled).toBe(true);expect(c.button.getAttribute('aria-label')).toBe('开始生成');expect(c.button.getAttribute('title')).toBe('请先添加图片');expect(c.button.getAttribute('aria-disabled')).toBe('true');c.click();expect(c.execution.generate).not.toHaveBeenCalled();expect(c.execution.cancelNode).not.toHaveBeenCalled();c.dispose();
});

it('does not overwrite a newer native render when disposing the cancellation decoration',async()=>{
 const c=controls({currentModel:capabilityModel({...motionCatalog[0],testMode:false}),isGenerating:true},{label:'停止生成'});c.button.disabled=false;await Promise.resolve();
 c.button.__reactProps$owned={className:'generate-action-button',disabled:false,'aria-label':'Generate',title:'Generate video','aria-disabled':false};c.button.disabled=false;c.button.setAttribute('aria-label','Generate');c.button.setAttribute('title','Generate video');c.button.setAttribute('aria-disabled','false');c.dispose();
 expect(c.button.disabled).toBe(false);expect(c.button.getAttribute('aria-label')).toBe('Generate');expect(c.button.getAttribute('title')).toBe('Generate video');expect(c.button.getAttribute('aria-disabled')).toBe('false');expect(c.button.getAttribute('data-studio-video-cancel-blocked')).toBeNull();
});

it('recovers a cached accepted TTL restoration that predates installing the native bridge',async()=>{
 const c=controls({}, {initialRunning:['image'],initialData:{estimateTaskId:'old-task'},remembered:{taskId:'old-task',ttl:30000}});await Promise.resolve();expect(c.execution.recoverNativeRunning).toHaveBeenCalledExactlyOnceWith('image',c.manager,'old-task',30000);expect(c.originalMark).not.toHaveBeenCalled();expect(c.native.fp).toHaveBeenCalledWith('p','image');c.dispose();
});

it.each(['pending','unmarked','foreign-hint','expired'])('rejects a late install TTL recovery with %s evidence',async mode=>{
 const c=controls({}, {initialRunning:mode==='unmarked'?[]:['image'],initialData:{estimateTaskId:mode==='foreign-hint'?'foreign':'old-task'},remembered:{taskId:mode==='pending'?null:'old-task',ttl:mode==='expired'?0:30000}});await Promise.resolve();expect(c.execution.recoverNativeRunning).not.toHaveBeenCalled();expect(c.unmarkLocalRunning).not.toHaveBeenCalled();c.dispose();
});

it('does not confuse a fresh local mark with restoring an older accepted task whose graph hint remains',async()=>{
 const c=controls({}, {initialData:{estimateTaskId:'old-task'},remembered:{taskId:'old-task',ttl:30000}});await Promise.resolve();c.native.c5.getState().markLocalRunning('image',c.snapshot.nodes[0].data);c.native.c5.getState().markLocalRunning('image',c.snapshot.nodes[0].data,30000);expect(c.execution.recoverNativeRunning).not.toHaveBeenCalled();expect(c.unmarkLocalRunning).not.toHaveBeenCalled();c.dispose();
});

it('keeps an accepted live lease and verifies recovery from the native accepted cache after all graph task hints clear',async()=>{
 const c=controls({}, {remembered:{taskId:'own-task',ttl:30000}});await Promise.resolve();c.native.c5.getState().markLocalRunning('image',c.snapshot.nodes[0].data);const lease=c.runningPort().capture('image',c.manager);lease.accepted('own-task',()=>true);c.native.c5.getState().markLocalRunning('image',{status:'idle'},30000);expect(lease.current()).toBe(true);expect(c.execution.recoverNativeRunning).toHaveBeenCalledExactlyOnceWith('image',c.manager,'own-task',30000);c.dispose();
});

it('retries a temporary owner query on the original once-captured native restoration lease and releases only after verified DETACHED',async()=>{
 vi.useFakeTimers();const c=controls({}, {initialRunning:['image'],initialData:{estimateTaskId:'old-task'},remembered:{taskId:'old-task',ttl:30000}});let reads=0;const transport=vi.fn((path:string)=>{expect(path).toBe('/api/v2/tasks/old-task');return Promise.resolve(++reads===1?new Response(JSON.stringify({error:{code:'TEMPORARY',message:'temporary owner lookup failure'}}),{status:503}):new Response(JSON.stringify({code:0,data:{id:'old-task',projectId:'p',kind:'CANVAS',targetType:'NODE',targetId:'image',canvasManaged:true,state:'SUCCEEDED',plans:[{nodeId:'image',executionId:'ex',state:'SUCCEEDED',canvasBinding:{applicationState:'DETACHED',reason:'NODE_CHANGED'}}]}})));});
 const api=new ProductClient('/api/v1',transport);api.setAccessToken('owner');const adapter=new ExecutionAdapter(api,new ServiceStorage(api,c.notice),async()=>{},c.notice),row={get:(key:string)=>key==='id'?'image':undefined};c.manager.ynodes={toArray:()=>[row]};adapter.attach('p',c.manager);adapter.installNativeRunningPort(c.runningPort());adapter.onSettled(c.settled);c.execution.recoverNativeRunning=adapter.recoverNativeRunning.bind(adapter) as any;
 try{await vi.advanceTimersByTimeAsync(1);expect(reads).toBe(1);expect(c.runningPort().capture('image',c.manager)).toBeUndefined();expect(c.unmarkLocalRunning).not.toHaveBeenCalled();await vi.advanceTimersByTimeAsync(250);expect(reads).toBe(2);expect(c.unmarkLocalRunning).toHaveBeenCalledExactlyOnceWith('image');expect(c.snapshot.nodes[0].data).toMatchObject({status:'idle',estimateTaskId:'old-task'});expect(c.snapshot.nodes[0].data.taskId).toBeUndefined();}finally{adapter.clear();c.dispose();}
});

it.each(['markLocalRunning','refreshLocalRunningBaseline'])('tracks a later native %s call before it reaches execution and restores the owned seam on disposal',async method=>{
 const c=controls();await Promise.resolve();c.native.c5.getState().markLocalRunning('image');const first=c.runningPort().capture('image',c.manager);expect(first.current()).toBe(true);expect(c.runningPort().capture('image',c.manager)).toBeUndefined();c.native.c5.getState()[method]('image');expect(first.current()).toBe(false);const next=c.runningPort().capture('image',c.manager);expect(next.current()).toBe(true);c.dispose();expect(next.current()).toBe(false);expect(c.native.c5.getState().markLocalRunning).toBe(c.originalMark);expect(c.native.c5.getState().refreshLocalRunningBaseline).toBe(c.originalRefresh);expect(c.releaseSettled).toHaveBeenCalledOnce();expect(c.releaseRunningPort).toHaveBeenCalledOnce();
});

it('keeps the captured lease through its accepted receipt and exact native TTL hydration replay, then releases a detached overlay',async()=>{
 const c=controls();await Promise.resolve();c.native.c5.getState().markLocalRunning('image',c.snapshot.nodes[0].data);const lease=c.runningPort().capture('image',c.manager);lease.accepted('own-task',()=>true);
 Object.assign(c.snapshot.nodes[0].data,{taskId:'own-task',status:'processing',estimateTaskId:'own-task',generationStartedAt:1791297866546});c.native.c5.getState().markLocalRunning('image',c.snapshot.nodes[0].data,45000);expect(lease.current()).toBe(true);expect(c.runningPort().capture('image',c.manager)).toBeUndefined();
 Object.assign(c.snapshot.nodes[0].data,{taskId:'',status:'idle'});c.native.c5.getState().markLocalRunning('image',c.snapshot.nodes[0].data,30000);expect(lease.current()).toBe(true);(c.native as any).hx=()=>[{id:'image',data:{taskId:'own-task',status:'processing'}}];c.settled({nodeId:'image',taskId:'own-task',projectId:'p',manager:c.manager,kind:'DETACHED',current:lease.current});expect(c.unmarkLocalRunning).toHaveBeenCalledExactlyOnceWith('image');expect(c.snapshot.nodes[0].data).toMatchObject({taskId:'',status:'idle'});expect(lease.current()).toBe(false);c.dispose();
});

it.each(['unaccepted','foreign-task','foreign-estimate','no-task','expired','owner-changed','manager-changed','not-running'])('does not preserve a lease for an unsafe native TTL replay: %s',async mode=>{
 const c=controls();await Promise.resolve();c.native.c5.getState().markLocalRunning('image');const lease=c.runningPort().capture('image',c.manager);let ownerCurrent=true;if(mode!=='unaccepted')lease.accepted('own-task',()=>ownerCurrent);
 const data:any={taskId:'own-task',estimateTaskId:'own-task',status:'processing'};if(mode==='foreign-task')data.taskId='other-task';if(mode==='foreign-estimate')data.estimateTaskId='other-task';if(mode==='no-task'){delete data.taskId;delete data.estimateTaskId;}if(mode==='owner-changed')ownerCurrent=false;if(mode==='manager-changed')c.native.bt=()=>({getRemoteData:()=>c.snapshot});if(mode==='not-running')c.native.c5.getState().unmarkLocalRunning('image');
 c.native.c5.getState().markLocalRunning('image',data,mode==='expired'?0:45000);expect(lease.current()).toBe(false);c.settled({nodeId:'image',taskId:'own-task',projectId:'p',manager:c.manager,kind:'DETACHED',current:lease.current});expect(c.unmarkLocalRunning).toHaveBeenCalledTimes(mode==='not-running'?1:0);c.dispose();
});

it.each(['markLocalRunning','refreshLocalRunningBaseline'])('invalidates even an accepted lease when a genuinely newer native %s starts',async method=>{
 const c=controls();await Promise.resolve();c.native.c5.getState().markLocalRunning('image');const lease=c.runningPort().capture('image',c.manager);lease.accepted('own-task',()=>true);c.native.c5.getState()[method]('image',{taskId:'own-task',estimateTaskId:'own-task'},method==='refreshLocalRunningBaseline'?45000:undefined);expect(lease.current()).toBe(false);
 lease.accepted('own-task',()=>true);c.native.c5.getState().markLocalRunning('image',{taskId:'own-task'},45000);c.settled({nodeId:'image',taskId:'own-task',projectId:'p',manager:c.manager,kind:'DETACHED',current:lease.current});expect(c.unmarkLocalRunning).not.toHaveBeenCalled();c.dispose();
});

it('releases detached and unsubmitted overlays through an independent current signal even while the native render task ID lags',async()=>{
 const c=controls();await Promise.resolve();Object.assign(c.snapshot.nodes[0].data,{status:'idle',taskId:''});(c.native as any).hx=()=>[{...c.snapshot.nodes[0],data:{taskId:'old-task',status:'processing'}}];
 for(const kind of ['DETACHED','NOT_SUBMITTED']){c.native.c5.getState().markLocalRunning('image');const lease=c.runningPort().capture('image',c.manager);c.settled({nodeId:'image',...(kind==='DETACHED'?{taskId:'old-task'}:{}),projectId:'p',manager:c.manager,kind,current:lease.current});expect(lease.current()).toBe(false);}
 expect(c.unmarkLocalRunning).toHaveBeenCalledTimes(2);expect(c.snapshot.nodes[0].data).toMatchObject({status:'idle',taskId:''});c.dispose();
});

it('fences transient settlement after a newer native mark, logout, project change, manager change, or disposal',async()=>{
 const c=controls();await Promise.resolve();c.native.c5.getState().markLocalRunning('image');const lease=c.runningPort().capture('image',c.manager),update={nodeId:'image',taskId:'old-task',projectId:'p',manager:c.manager,kind:'DETACHED',current:lease.current};
 c.runtime.auth.user=null;c.settled(update);c.runtime.auth.user={id:'studio-user'};c.runtime.inspect=()=>({id:'q'});c.settled(update);c.runtime.inspect=()=>({id:'p'});const original=c.native.bt;c.native.bt=()=>({getRemoteData:()=>c.snapshot});c.settled(update);c.native.bt=original;c.native.c5.getState().markLocalRunning('image');c.settled(update);
 const listener=c.execution.onSettled.mock.calls[0][0];c.dispose();listener(update);expect(c.unmarkLocalRunning).not.toHaveBeenCalled();
});

it('does not replace a native running method installed by a later integration during disposal',async()=>{
 const c=controls();await Promise.resolve();const replacement=vi.fn();c.native.c5.setState({markLocalRunning:replacement});c.dispose();expect(c.native.c5.getState().markLocalRunning).toBe(replacement);expect(c.native.c5.getState().refreshLocalRunningBaseline).toBe(c.originalRefresh);
});

it.each([['finished','SUCCESS'],['failed','FAILED'],['idle','CANCELLED']])('clears the native running overlay only on current authoritative %s completion',async(nativeStatus,status)=>{
 const control=controls();control.snapshot.nodes[0].data={taskId:'current-task',status:nativeStatus};await Promise.resolve();expect(control.unmarkLocalRunning).not.toHaveBeenCalled();
 control.terminal({nodeId:'image',taskId:'current-task',projectId:'p',manager:control.manager,status});expect(control.unmarkLocalRunning).toHaveBeenCalledExactlyOnceWith('image');control.dispose();expect(control.releaseTerminal).toHaveBeenCalledOnce();
});

it('fences terminal overlay callbacks after logout, manager/project changes, newer tasks and disposal',async()=>{
 const control=controls(),update={nodeId:'image',taskId:'current-task',projectId:'p',manager:control.manager,status:'SUCCESS'};control.snapshot.nodes[0].data={taskId:'current-task',status:'finished'};await Promise.resolve();
 control.runtime.auth.user=null;control.terminal(update);control.runtime.auth.user={id:'studio-user'};
 const originalManager=control.native.bt;control.native.bt=()=>({getRemoteData:()=>control.snapshot});control.terminal(update);control.native.bt=originalManager;
 control.runtime.inspect=()=>({id:'q'});control.terminal(update);control.runtime.inspect=()=>({id:'p'});
 control.snapshot.nodes[0].data={taskId:'new-task',status:'finished'};control.terminal(update);control.snapshot.nodes[0].data={taskId:'current-task',status:'processing'};control.terminal(update);
 const subscribed=control.execution.onTerminal.mock.calls[0][0];control.dispose();control.snapshot.nodes[0].data={taskId:'current-task',status:'finished'};subscribed(update);
 expect(control.unmarkLocalRunning).not.toHaveBeenCalled();expect(control.releaseTerminal).toHaveBeenCalledOnce();
});

it.each([
 {testMode:false,badge:'',expected:''},
 {testMode:true,badge:'TEST MODE',expected:'TEST MODE'},
 {testMode:false,badge:'用户自定义徽标',expected:'用户自定义徽标'},
])('clears exact script-local stages and restores the authoritative badge: %j',async mode=>{
 const control=controls();control.snapshot.nodes[0].type='rh-script';control.snapshot.nodes[0].data={taskId:'current-task',status:'finished',testMode:mode.testMode,customBadgeText:mode.badge};
 const local={...control.snapshot.nodes[0],data:{...control.snapshot.nodes[0].data,customBadgeText:'正在生成分镜表，请稍后',pendingOutputScene:'film'}};
 (control.native as any).hx=()=>[local];const patch=vi.fn((id:string,data:any)=>Object.assign(local.data,data));(control.native as any).br=patch;
 await Promise.resolve();control.terminal({nodeId:'image',taskId:'current-task',projectId:'p',manager:control.manager,status:'SUCCESS'});
 expect(patch).toHaveBeenCalledExactlyOnceWith('image',{customBadgeText:mode.expected,pendingOutputScene:null});expect(control.unmarkLocalRunning).toHaveBeenCalledExactlyOnceWith('image');control.dispose();
});

it('does not release a newer local script task while an older remote terminal callback arrives',async()=>{
 const control=controls();control.snapshot.nodes[0].type='rh-script';control.snapshot.nodes[0].data={taskId:'old-task',status:'finished'};
 (control.native as any).hx=()=>[{...control.snapshot.nodes[0],data:{taskId:'new-task',status:'processing',customBadgeText:'正在生成分镜表，请稍后'}}];const patch=vi.fn();(control.native as any).br=patch;
 await Promise.resolve();control.terminal({nodeId:'image',taskId:'old-task',projectId:'p',manager:control.manager,status:'SUCCESS'});
 expect(patch).not.toHaveBeenCalled();expect(control.unmarkLocalRunning).not.toHaveBeenCalled();control.dispose();
});

it('re-registers the STUDIO hook for keyboard submission and flushes the exact native panel callback first',async()=>{
 const control=controls();await Promise.resolve();
 expect(control.button.disabled).toBe(false);expect(control.container.getAttribute('inert')).toBeNull();
 const staleNativeGenerate=vi.fn();control.hooks.current={onGenerate:staleNativeGenerate};control.native.le.mockClear();
 const event=control.key();
 expect(event.preventDefault).toHaveBeenCalledOnce();expect(event.stopImmediatePropagation).toHaveBeenCalledOnce();
 expect(control.native.le).toHaveBeenCalledOnce();expect(control.action.preflight).toHaveBeenCalledOnce();expect(control.action.onClick).toHaveBeenCalledWith({cancel:expect.any(Function)});
 expect(staleNativeGenerate).not.toHaveBeenCalled();expect(control.execution.generate).toHaveBeenCalledWith('image');
 expect(await control.execution.generate.mock.results[0].value).toEqual({id:'image',prompt:'unsaved panel text'});
 control.dispose();expect(control.listeners.size).toBe(0);expect(control.disconnect).toHaveBeenCalledOnce();expect(control.style.remove).toHaveBeenCalledOnce();
});

it('routes the real Chinese native generate label through the exact panel callback before STUDIO execution',async()=>{
 const control=controls({}, {label:'开始生成'});await Promise.resolve();
 expect(control.button.disabled).toBe(false);expect(control.container.getAttribute('inert')).toBeNull();
 const staleNativeGenerate=vi.fn();control.hooks.current={onGenerate:staleNativeGenerate};
 const event=control.click();expect(event.preventDefault).toHaveBeenCalledOnce();expect(event.stopImmediatePropagation).toHaveBeenCalledOnce();
 expect(control.action.preflight).toHaveBeenCalledOnce();expect(control.action.onClick).toHaveBeenCalledExactlyOnceWith({cancel:expect.any(Function)});expect(staleNativeGenerate).not.toHaveBeenCalled();
 expect(control.execution.generate).toHaveBeenCalledExactlyOnceWith('image');expect(await control.execution.generate.mock.results[0].value).toEqual({id:'image',prompt:'unsaved panel text'});
 control.dispose();
});

it.each(['click','keyboard'])('uses the same owned current-node dispatcher for storyboard image %s',async route=>{
 const control=controls({params:{prompt:'saved'}},{label:'开始生成',initialData:{modelCode:'mock-image',isStoryboard:true,sceneCode:'storyboard-prompt-board',storyboardRowId:'row-1__merge_row-1',storyboardRowIds:['row-1']}}),flush=vi.fn();Object.assign(control.manager,{flushOperationQueue:flush});await Promise.resolve();
 const before=structuredClone(control.snapshot);route==='click'?control.click():control.key();
 expect(control.action.preflight).toHaveBeenCalledOnce();expect(flush).toHaveBeenCalledExactlyOnceWith(true);expect(control.action.onClick).not.toHaveBeenCalled();expect(control.execution.generate).toHaveBeenCalledExactlyOnceWith('image');expect(control.snapshot).toEqual(before);expect(control.originalMark).not.toHaveBeenCalled();control.dispose();
});

it.each(['click','keyboard'])('reports an unsaved storyboard model from %s without invoking either generation path',async route=>{
 const control=controls({params:{prompt:'saved'},currentModel:{modelCode:'new-model',available:true}},{label:'开始生成',initialData:{modelCode:'old-model',isStoryboard:true,sceneCode:'storyboard-prompt-board',storyboardRowId:'row-1__merge_row-1',storyboardRowIds:['row-1']}});await Promise.resolve();route==='click'?control.click():control.key();await Promise.resolve();
 expect(control.action.preflight).toHaveBeenCalledOnce();expect(control.action.onClick).not.toHaveBeenCalled();expect(control.execution.generate).not.toHaveBeenCalled();expect(control.notice).toHaveBeenCalledExactlyOnceWith('分镜模型尚未保存，请确认模型后重新生成。');control.dispose();
});

it.each(['click','keyboard'])('keeps storyboard native preflight ahead of the owned %s dispatcher',async route=>{
 const control=controls({params:{prompt:'saved'}},{label:'开始生成',initialData:{modelCode:'mock-image',isStoryboard:true,sceneCode:'storyboard-prompt-board',storyboardRowId:'row-1__merge_row-1',storyboardRowIds:['row-1']}});control.action.preflight.mockReturnValue('请添加参考图');await Promise.resolve();route==='click'?control.click():control.key();
 expect(control.notice).toHaveBeenCalledExactlyOnceWith('请添加参考图');expect(control.action.onClick).not.toHaveBeenCalled();expect(control.execution.generate).not.toHaveBeenCalled();control.dispose();
});

it.each([{disabled:true},{isGenerating:true},{currentModel:{modelCode:'mock-image',available:false}}])('keeps the real Chinese generate button guarded: %j',async overrides=>{
 const control=controls(overrides,{label:'开始生成'});await Promise.resolve();const event=control.click();
 expect(event.preventDefault).toHaveBeenCalledOnce();expect(control.action.onClick).not.toHaveBeenCalled();expect(control.execution.generate).not.toHaveBeenCalled();control.dispose();
});

it('keeps preflight errors and the homepage launch outside Chinese node generation',async()=>{
 const control=controls({}, {label:'开始生成'});await Promise.resolve();control.action.preflight.mockReturnValue('请填写画面描述');control.click();
 expect(control.notice).toHaveBeenCalledExactlyOnceWith('请填写画面描述');expect(control.action.onClick).not.toHaveBeenCalled();expect(control.execution.generate).not.toHaveBeenCalled();control.dispose();
 const home=controls({}, {panelClass:'home-agent-input-bar',label:'开始生成'});await Promise.resolve();const event=home.click();
 expect(home.button.disabled).toBe(true);expect(event.preventDefault).not.toHaveBeenCalled();expect(home.action.onClick).not.toHaveBeenCalled();expect(home.execution.generate).not.toHaveBeenCalled();home.dispose();
});

it.each([{currentModel:{modelCode:'mock-image',available:false}},{disabled:true},{isGenerating:true}])('keeps an unavailable or disabled native action guarded for keyboard submission: %j',async overrides=>{
 const control=controls(overrides);await Promise.resolve();control.native.le.mockClear();
 const event=control.key();expect(control.action.onClick).not.toHaveBeenCalled();expect(control.execution.generate).not.toHaveBeenCalled();expect(control.native.le).not.toHaveBeenCalled();expect(event.preventDefault).toHaveBeenCalledOnce();expect(event.stopImmediatePropagation).toHaveBeenCalledOnce();control.dispose();
});

it('preserves shortcut preferences, composition, modifier guards, current auth and preflight errors',async()=>{
 const control=controls();await Promise.resolve();
 control.key({shiftKey:false});control.key({isComposing:true});control.key({altKey:true});control.key({ctrlKey:true});control.key({metaKey:true});control.prefs.submitTask='none';control.key();
 control.prefs.submitTask='enter';control.key();expect(control.action.onClick).not.toHaveBeenCalled();
 control.runtime.auth.user=null;control.key({shiftKey:false});expect(control.action.onClick).not.toHaveBeenCalled();
 control.runtime.auth.user={id:'studio-user'};control.action.preflight.mockReturnValue('需要描述');const event=control.key({shiftKey:false});
 expect(event.preventDefault).toHaveBeenCalledOnce();expect(control.notice).toHaveBeenCalledWith('需要描述');expect(control.action.onClick).not.toHaveBeenCalled();expect(control.execution.generate).not.toHaveBeenCalled();control.dispose();
});

function groupControls(data:any,disabled:any={}){
 const control=controls({}, {panelClass:'ce-node-toolbar group-toolbar',buttonClass:'toolbar-btn execute-btn',label:'批量生成视频'}),groupNode={id:'group',type:'group',data:{status:'idle',...data}},order:string[]=[],plan=vi.fn(()=>{order.push('native plan');});
 control.snapshot.nodes=[groupNode];control.node.setAttribute('data-id','group');control.button.disabled=false;
 const action={className:'toolbar-btn execute-btn',onClick:plan,...disabled},toolbar={groupNode,onExecute:vi.fn(),onStartStoryboardBatch:vi.fn(),onStartEntityBatch:vi.fn(),onExecuteVideoGroup:vi.fn(),videoGroupComposeReadiness:{canCompose:true}};
 control.button.__reactFiber$owned={memoizedProps:action,return:{memoizedProps:toolbar}};
 return{...control,groupNode,toolbar,groupAction:action,order,plan};
}

it.each([{groupType:'storyboard'},{groupType:'video'},{storyboardEntityGroup:true}])('keeps exact native specialized group planning before any product run: %j',async data=>{
 const control=groupControls(data);await Promise.resolve();control.native.le.mockImplementation(value=>{control.order.push('STUDIO register');control.hooks.current=value;});
 expect(nativeGroupGenerationAction(control.button)?.groupNode).toBe(control.groupNode);
 const event=control.click();expect(event.preventDefault).toHaveBeenCalledOnce();expect(control.order).toEqual(['STUDIO register','native plan']);expect(control.plan).toHaveBeenCalledOnce();expect(control.execution.generate).not.toHaveBeenCalled();control.dispose();
});

it('uses STUDIO execution for normal groups without invoking the native price and wallet confirmation',async()=>{
 const control=groupControls({groupType:'normal'});await Promise.resolve();control.click();expect(control.execution.generate).toHaveBeenCalledWith('group');expect(control.plan).not.toHaveBeenCalled();control.dispose();
});

it.each([{disabled:true},{'aria-disabled':true}])('preserves native disabled specialized group planning: %j',async disabled=>{
 const control=groupControls({groupType:'storyboard'},disabled);await Promise.resolve();control.click();expect(control.plan).not.toHaveBeenCalled();expect(control.execution.generate).not.toHaveBeenCalled();control.dispose();
});

it('bypasses only the Ps billing wrapper for storyboard node creation and keeps selection preflight local',async()=>{
 const created:string[]=[],create=vi.fn(({cancel})=>{created.push('video-for-selected-shot');cancel();}),preflight=vi.fn(),control=controls({onClick:create,preflight},{panelClass:'group-params-create-video-nodes'});
 await Promise.resolve();control.click();expect(preflight).toHaveBeenCalledOnce();expect(created).toEqual(['video-for-selected-shot']);expect(create).toHaveBeenCalledWith({cancel:expect.any(Function)});expect(control.execution.generate).not.toHaveBeenCalled();
 preflight.mockReturnValue('请选择分镜');control.click();expect(control.notice).toHaveBeenCalledWith('请选择分镜');expect(create).toHaveBeenCalledOnce();expect(control.execution.generate).not.toHaveBeenCalled();control.dispose();
});

it('leaves the native launch composer to create its own graph',async()=>{
 const control=controls({}, {panelClass:'home-agent-input-bar'});await Promise.resolve();expect(control.button.disabled).toBe(true);
 const event=control.click();expect(event.preventDefault).not.toHaveBeenCalled();expect(control.action.onClick).not.toHaveBeenCalled();expect(control.execution.generate).not.toHaveBeenCalled();control.dispose();
});

it('routes an enabled native retry to STUDIO and preserves its original disabled guard',async()=>{
 const control=controls({}, {buttonClass:'rh-node-fail-overlay__btn--retry',label:'重试'}),nativeRetry=vi.fn();
 control.button.__reactFiber$owned={memoizedProps:{onClick:nativeRetry},return:{memoizedProps:{nodeId:'image'}}};control.button.disabled=false;
 await Promise.resolve();const event=control.click();expect(event.stopImmediatePropagation).toHaveBeenCalledOnce();expect(control.execution.generate).toHaveBeenCalledWith('image');expect(nativeRetry).not.toHaveBeenCalled();
 control.button.disabled=true;control.click();expect(control.execution.generate).toHaveBeenCalledOnce();control.dispose();
});

function entityControls(options:{queuedImage?:boolean}={}){
 const snapshot:any={nodes:[{id:'script',type:'rh-script',position:{x:10,y:20},data:{stylePrompt:'original style',output:{storyboardEntities:{characters:[],scenes:[],props:[],products:[]}}}},{id:'role',type:'rh-entity',position:{x:100,y:200},data:{storyboardEntityNode:true,storyboardEntityKind:'character',storyboardScriptNodeId:'script',entityId:'registry-role',name:'Alice',desc:'captured description',status:'idle'}},{id:'unselected',type:'rh-entity',position:{x:200,y:200},data:{storyboardEntityNode:true,storyboardEntityKind:'character',storyboardScriptNodeId:'script',entityId:'unselected',name:'Bob',desc:'unselected description',status:'idle'}}],edges:[]};
 let pendingImage:Function|undefined;
 const model:any={modelCode:'mock-image',available:true,testMode:true,config:[{paramName:'prompt',type:'prompt'},{paramName:'count',paramValue:1}]},manager={getRemoteData:()=>snapshot,patchNodeData:vi.fn((id:string,patch:any)=>Object.assign(snapshot.nodes.find((node:any)=>node.id===id).data,patch)),flushOperationQueue:vi.fn(()=>{const pending=pendingImage;pendingImage=undefined;pending?.();})},flow={getNodes:()=>snapshot.nodes,getEdges:()=>snapshot.edges,getNode:(id:string)=>snapshot.nodes.find((node:any)=>node.id===id)},addNode=vi.fn(node=>snapshot.nodes.push(node));
 const native:any={bt:()=>manager,r:{useMemo:(factory:Function)=>factory(),useCallback:(callback:Function)=>callback,useRef:(current:any)=>({current})},j:{jsx:(type:any,props:any,key:any)=>({type,props,key}),jsxs:(type:any,props:any,key:any)=>({type,props,key})},ej:(data:any)=>({stylePrompt:data.stylePrompt}),ei:()=> 'film',el:()=> 'prompt',eg:()=>snapshot.nodes[0].data.output.storyboardEntities,ii:{getState:()=>({clearActiveEntityGroupBatch:vi.fn()})}};
 const runtime={auth:{user:{id:'owner'} as any},inspect:()=>({id:'p'}),storage:{encodeAsset:(value:string)=>value},execution:{generateEntityPlans:vi.fn().mockResolvedValue({taskId:'real-task',testMode:true})}},notice=vi.fn(),open=vi.fn().mockResolvedValue('fourView'),originalGenerate=vi.fn(),originalBatch=vi.fn(),exit=vi.fn();
 const j0=()=>({getNodes:flow.getNodes,getEdges:flow.getEdges,addNode}),y=flow,g={TEXT_IMAGE:[model]},o=open,l={type:'real-native-view-modal',props:{}},Kt=vi.fn(),Bn=vi.fn(),cancel=vi.fn();let registry:any;
 function pjr(props:any){const e=props.nodeId;native.r.useMemo(()=>j0(y,e,g),[y,e,g]);native.r.useMemo(()=>({open:o,modal:l}),[o,l]);const params=native.j.jsx('native-model-chooser',{value:model.modelCode,modelOptions:[{value:model.modelCode,model}],configs:model.config,params:{count:3,generateNum:3},onParamsChange:vi.fn()});
  const batch=native.j.jsx('native-batch-bar',{className:'script-table-entity-batch-bar',entityType:'character',generating:false,generateDisabled:false,readonly:false,params,onGenerate:originalBatch,onExitSelect:exit});
  const cards=native.j.jsx('native-cards',{scriptTableNodeId:e,kind:'character',entities:[{id:'registry-role',name:'Alice',desc:'captured description'},{id:'unselected',name:'Bob',desc:'unselected description'}],selectedEntityIds:['registry-role'],batchSelectMode:false,generatingState:{},isRead:false,onGenerate:originalGenerate,onRetry:originalGenerate,onCancel:vi.fn(),onUpdateImage:({entityId,imageUrl}:any)=>{const apply=()=>{const node=snapshot.nodes.find((node:any)=>node.data.entityId===entityId);if(node)Object.assign(node.data,{imageUrl,output:[]});};if(options.queuedImage)pendingImage=apply;else apply();}});
  registry=native.r.useRef({run:async()=>false,cancel:()=>false,runBatch:async()=>false});registry.current={run:(node:any,options:any)=>{const patch=options?.nodeDataPatch;return Kt(node,patch);},cancel,runBatch:(nodes:any[],options:any)=>Bn(nodes,options)};
  return native.j.jsxs('native-layout',{children:[params,batch,cards,l],className:'unchanged-native-layout'});
 }
 const bridge=installNativeEntityIntegration(runtime,notice,native)!;
 const render=(id='script')=>{const element=native.j.jsx(pjr,{nodeId:id,canvasId:'p',data:snapshot.nodes.find((node:any)=>node.id===id)?.data,parsedRows:[],shotNumberByRowId:{},onOpenPreview:vi.fn(),open:true});return element.type(element.props);};
 return{snapshot,model,native,runtime,notice,open,render,bridge,originalGenerate,originalBatch,exit,addNode,flow,manager,registry:()=>registry,Kt,Bn,cancel};
}

it('overrides the exact scoped entity onGenerate and retry while preserving layout, chooser, view, selection, style and native count',async()=>{
 const control=entityControls(),tree=control.render();expect(tree.props.className).toBe('unchanged-native-layout');expect(tree.props.children[3]).toEqual({type:'real-native-view-modal',props:{}});
 const cards=tree.props.children[2];expect(await cards.props.onGenerate(cards.props.entities[0])).toBe(true);expect(control.open).toHaveBeenCalledOnce();expect(control.originalGenerate).not.toHaveBeenCalled();
 const [project,nodes,model]=control.runtime.execution.generateEntityPlans.mock.calls[0];expect(project).toBe('p');expect(nodes).toHaveLength(1);expect(nodes[0]).toMatchObject({id:'role',type:'rh-image',position:{x:100,y:200},data:{name:'Alice',desc:'captured description',generateNum:3,sceneCode:'storyboard-prompt-character-four-creator',params:{prompt:'角色名称：Alice\n角色描述：captured description\n【风格】original style',count:3}}});expect(model).toBe(control.model);expect(control.addNode).not.toHaveBeenCalled();control.bridge.dispose();
});
it('executes the actual entity batch selection and exits selection only after a real task submission',async()=>{
 const control=entityControls(),tree=control.render(),batch=tree.props.children[1];expect(await batch.props.onGenerate()).toBe(true);expect(control.originalBatch).not.toHaveBeenCalled();expect(control.runtime.execution.generateEntityPlans.mock.calls[0][1].map((node:any)=>node.id)).toEqual(['role']);expect(control.exit).toHaveBeenCalledOnce();control.bridge.dispose();
});
it('routes the exact group entity callback through selected IDs/model/params and always releases the native cancel callback',async()=>{
 const control=entityControls();control.render();const war=vi.fn(),clearActiveEntityGroupBatch=vi.fn(),original=async(Q:any)=>{const ids=Q.selectedEntityNodeIds;await war(ids);clearActiveEntityGroupBatch();},group={id:'group',type:'group',data:{storyboardEntityGroup:true,storyboardScriptNodeId:'script',nodeIds:['role']}},cancel=vi.fn(),run=control.native.r.useCallback(original,[group,control.flow,vi.fn()]);control.snapshot.nodes.push(group);
 expect(await run({selectedEntityNodeIds:['role'],model:control.model,params:{count:4,generateNum:4},cancel})).toBe(true);expect(war).not.toHaveBeenCalled();expect(cancel).toHaveBeenCalledOnce();expect(control.runtime.execution.generateEntityPlans.mock.calls[0][1]).toMatchObject([{id:'role',data:{generateNum:4,params:{count:4}}}]);control.bridge.dispose();
});
it('preserves the original callback identity for unrelated hooks and JSX props',()=>{
 const control=entityControls(),callback=()=>42;expect(control.native.r.useCallback(callback,[])).toBe(callback);const props={onGenerate:callback,params:{},className:'other-batch'};expect(control.native.j.jsx('unrelated',props).props).toBe(props);expect(control.native.r.useMemo(()=>({open:callback,modal:{}}),[callback,{}]).open).toBe(callback);control.bridge.dispose();
});
it('does not submit entities after view cancellation, logout, stale project, native busy or read-only guards',async()=>{
 const control=entityControls(),tree=control.render(),cards=tree.props.children[2];control.open.mockResolvedValueOnce(null);expect(await cards.props.onGenerate(cards.props.entities[0])).toBe(false);
 let finish!:(view:string)=>void;control.open.mockImplementationOnce(()=>new Promise(resolve=>finish=resolve));const pending=cards.props.onGenerate(cards.props.entities[0]);await vi.waitFor(()=>expect(finish).toBeTypeOf('function'));control.runtime.auth.user=null;finish('portrait');expect(await pending).toBe(false);expect(control.runtime.execution.generateEntityPlans).not.toHaveBeenCalled();
 control.runtime.auth.user={id:'owner'};control.snapshot.nodes[1].data.status='running';expect(await cards.props.onGenerate(cards.props.entities[0])).toBe(false);control.snapshot.nodes[1].data.status='idle';control.native.bq={getState:()=>({isRead:true})};expect(await cards.props.onGenerate(cards.props.entities[0])).toBe(false);expect(control.runtime.execution.generateEntityPlans).not.toHaveBeenCalled();control.bridge.dispose();
});
it('binds character view selection to the matching script and never an unrelated recent modal',async()=>{
 const control=entityControls();control.render();const otherOpen=vi.fn().mockResolvedValue('portrait');control.native.r.useMemo(()=>({open:otherOpen,modal:{}}),[otherOpen,{}]);expect(await control.bridge.generateNode('role')).toBe(true);expect(control.open).toHaveBeenCalledOnce();expect(otherOpen).not.toHaveBeenCalled();expect(control.runtime.execution.generateEntityPlans.mock.calls[0][1][0].data.sceneCode).toBe('storyboard-prompt-character-four-creator');control.bridge.dispose();
});
it('overrides the exact native entity runner ref, preserves cancellation and unsaved parameter patches, and bypasses its original key preflight',async()=>{
 const control=entityControls();control.render();const runner=control.registry().current;
 expect(runner.cancel).toBe(control.cancel);expect(await runner.run(control.snapshot.nodes[1],{skipSceneCode:true,nodeDataPatch:{params:{prompt:'unsaved entity prompt',count:4,generateNum:4}}})).toBe(true);expect(control.Kt).not.toHaveBeenCalled();expect(control.open).not.toHaveBeenCalled();const node=control.runtime.execution.generateEntityPlans.mock.calls[0][1][0];expect(node.data.params).toMatchObject({prompt:'unsaved entity prompt',count:4});expect(node.data.generateNum).toBe(4);expect(node.data).not.toHaveProperty('sceneCode');expect(node.data.params.prompt).not.toContain('original style');
 await runner.runBatch([control.snapshot.nodes[2]],{model:control.model,toolbarParams:{count:2,generateNum:2},skipSceneCode:true});expect(control.Bn).not.toHaveBeenCalled();expect(control.runtime.execution.generateEntityPlans.mock.calls[1][1].map((node:any)=>node.id)).toEqual(['unselected']);control.bridge.dispose();
});
it('uses only an explicit user reference and excludes prior entity outputs/history from the model input snapshot',async()=>{
 const control=entityControls();Object.assign(control.snapshot.nodes[1].data,{imageUrl:'https://studio.invalid/previous-result',output:[{assetId:'old-output',url:'https://studio.invalid/previous-result'}],nodeOutputHistory:[{outputs:[{assetId:'old-history'}]}],sourceObjects:['https://studio.invalid/old-source']});control.render();await control.bridge.generateNode('role');const first=control.runtime.execution.generateEntityPlans.mock.calls[0][1][0].data;
 for(const key of ['output','nodeOutputHistory','sourceObjects','imageUrl','toolsSourceUrl'])expect(first).not.toHaveProperty(key);expect(first.params).not.toHaveProperty('imageUrls');expect(control.snapshot.nodes[1].data.output).toHaveLength(1);
 Object.assign(control.snapshot.nodes[1].data,{storyboardEntityUserReference:true,imageUrl:'https://studio.invalid/user-reference'});await control.bridge.generateNode('role');const second=control.runtime.execution.generateEntityPlans.mock.calls[1][1][0].data;expect(second.params.imageUrls).toEqual(['https://studio.invalid/user-reference']);expect(second.subType).toBe('IMAGE_IMAGE');control.bridge.dispose();
});

it('binds the actual frozen TOr upload selection callback to a persisted explicit reference and the selected edit model',async()=>{
 const control=entityControls({queuedImage:true});control.model.kind='IMAGE_TO_IMAGE';const tree=control.render(),cards=tree.props.children[2];
 const frozen=readFileSync(new URL('../../apps/web/public/project/assets/index-DeyN_Phq.js',import.meta.url),'utf8'),start=frozen.indexOf('function te(me){',frozen.indexOf('const TOr=')),end=frozen.indexOf('const oe=',start),source=frozen.slice(start,end);
 const close=vi.fn(),choose=new Function('I','fe','_','T','N','x',`return (${source})`)('registry-role',close,false,null,vi.fn(),cards.props.onUpdateImage);
 choose({url:'rhtv-asset:ast_user_portrait'});expect(close).toHaveBeenCalledOnce();expect(control.manager.patchNodeData).toHaveBeenCalledWith('role',{storyboardEntityUserReference:true,toolsType:'IMAGE_IMAGE',toolsSourceUrl:'rhtv-asset:ast_user_portrait'},expect.any(Object));
 expect(await cards.props.onGenerate(cards.props.entities[0])).toBe(true);const data=control.runtime.execution.generateEntityPlans.mock.calls[0][1][0].data;expect(data).toMatchObject({subType:'IMAGE_IMAGE',toolsSourceUrl:'rhtv-asset:ast_user_portrait',params:{imageUrls:['rhtv-asset:ast_user_portrait']}});expect(control.runtime.execution.generateEntityPlans.mock.calls[0][2]).toBe(control.model);control.bridge.dispose();
});

it('keeps a public edit selection and rejects a missing reference with the affected entity name',async()=>{
 const control=entityControls();control.model.kind='IMAGE_TO_IMAGE';const cards=control.render().props.children[2];expect(await cards.props.onGenerate(cards.props.entities[0])).toBe(false);expect(control.runtime.execution.generateEntityPlans).not.toHaveBeenCalled();expect(control.notice).toHaveBeenCalledWith(expect.stringContaining('Alice'));control.bridge.dispose();
});

it('wraps only the actual VTe entity reuse picker and preserves its original selection update',async()=>{
 const control=entityControls();control.render();function VTe(){}const original=vi.fn((value:any)=>Object.assign(control.snapshot.nodes[1].data,{imageUrl:value.imageUrl,output:[]})),props={pickOnly:true,entityReuse:true,scriptTableNodeId:'script',excludeEntityId:'registry-role',initialEntityKind:'character',onReuseEntity:original};
 const mapped=control.native.j.jsx(VTe,props);mapped.props.onReuseEntity({imageUrl:'rhtv-asset:ast_reused_own_result'});expect(original).toHaveBeenCalledOnce();expect(control.snapshot.nodes[1].data).toMatchObject({imageUrl:'rhtv-asset:ast_reused_own_result',storyboardEntityUserReference:true,toolsSourceUrl:'rhtv-asset:ast_reused_own_result'});
 function OtherPicker(){}expect(control.native.j.jsx(OtherPicker,props).props).toBe(props);expect(control.native.j.jsx(VTe,{...props,entityReuse:false}).props.onReuseEntity).toBe(original);control.bridge.dispose();
});

it('rejects a changed user reference while the real character view chooser is pending',async()=>{
 const control=entityControls();control.model.kind='IMAGE_TO_IMAGE';const cards=control.render().props.children[2];cards.props.onUpdateImage({entityId:'registry-role',imageUrl:'rhtv-asset:ast_first'});let done!:(view:string)=>void;control.open.mockImplementationOnce(()=>new Promise(resolve=>done=resolve));const pending=cards.props.onGenerate(cards.props.entities[0]);await vi.waitFor(()=>expect(done).toBeTypeOf('function'));cards.props.onUpdateImage({entityId:'registry-role',imageUrl:'rhtv-asset:ast_second'});done('fourView');expect(await pending).toBe(false);expect(control.runtime.execution.generateEntityPlans).not.toHaveBeenCalled();expect(control.notice).toHaveBeenCalledWith(expect.stringContaining('参考图片已变更'));control.bridge.dispose();
});

function sourceMotionControls(){
 const model=capabilityModel({...sourceMotionCatalog[0],testMode:false} as any),control=controls({currentModel:model,params:{generateNum:1,outputPreset:'landscape-480p-source',imageUrls:['rhtv-asset:motion-image'],videoUrls:['rhtv-asset:motion-video']},onClick:vi.fn()},{label:'开始生成',initialData:{modelCode:'h3-motion-transfer-v1',subType:'video-video',prompt:'',params:{imageUrls:'',videoUrls:'',outputPreset:'landscape-480p-source'}}});
 control.snapshot.nodes[0].type='rh-video';
 control.snapshot.nodes.push({id:'motion-image',type:'rh-image',data:{isUpload:true,sourceObjects:['rhtv-asset:motion-image']}},{id:'motion-video',type:'rh-video',data:{isUpload:true,sourceObjects:['rhtv-asset:motion-video']}});
 control.snapshot.edges.push({id:'image-reference',source:'motion-image',target:'image'},{id:'video-reference',source:'motion-video',target:'image'});
 const restore=vi.fn((_id:string,graph:any)=>({...graph,nodes:graph.nodes.map((node:any)=>node.id==='image'?{...node,data:{...node.data,capabilityRef:'h3-motion-transfer-v1',capabilityVersion:'2',parameterSchemaVersion:'2'}}:node)})),flush=vi.fn();
 Object.assign(control.runtime,{storage:{restoreModelBindings:restore,encodeAsset:(value:string)=>value}});Object.assign(control.manager,{flushOperationQueue:flush});
 return{...control,restore,flush};
}

it.each(['click','keyboard'])('submits the exact promptless H3 source-duration model through the current STUDIO graph on %s',async route=>{
 const c=sourceMotionControls();await Promise.resolve();const before=structuredClone(c.snapshot),params=structuredClone(c.action.params);
 route==='click'?c.click():c.key();
 expect(c.action.preflight).toHaveBeenCalledOnce();expect(c.action.onClick).not.toHaveBeenCalled();expect(c.flush).toHaveBeenCalledExactlyOnceWith(true);expect(c.restore).toHaveBeenCalledWith('p',c.snapshot);expect(c.execution.generate).toHaveBeenCalledExactlyOnceWith('image');expect(c.snapshot).toEqual(before);expect(c.action.params).toEqual(params);expect(c.action.params).not.toHaveProperty('prompt');expect(c.originalMark).not.toHaveBeenCalled();c.dispose();
});

it('resolves upstream motion references once even when the same assets are also stored in node parameters',async()=>{
 const c=sourceMotionControls();c.snapshot.nodes[0].data.params.imageUrls=['rhtv-asset:motion-image'];c.snapshot.nodes[0].data.params.videoUrls=['rhtv-asset:motion-video'];await Promise.resolve();const before=structuredClone(c.snapshot);c.click();expect(c.execution.generate).toHaveBeenCalledOnce();expect(c.snapshot).toEqual(before);expect(c.action.onClick).not.toHaveBeenCalled();c.dispose();
});

it.each(['missing-image','missing-video','changed-image','changed-video','preset','count','authored-prompt','extra-parameter','bound-version','session'])('keeps the promptless source-duration dispatcher guarded for %s',async change=>{
 const c=sourceMotionControls();
 if(change==='missing-image')c.snapshot.edges.splice(0,1);
 if(change==='missing-video')c.snapshot.edges.splice(1,1);
 if(change==='changed-image')c.action.params.imageUrls=['rhtv-asset:foreign-image'];
 if(change==='changed-video')c.action.params.videoUrls=['rhtv-asset:foreign-video'];
 if(change==='preset')c.action.params.outputPreset='portrait-480p-source';
 if(change==='count')c.action.params.generateNum=2;
 if(change==='authored-prompt')c.action.params.prompt='new authored input';
 if(change==='extra-parameter')c.action.params.unreviewed=1;
 if(change==='bound-version')c.restore.mockImplementation((_id:string,graph:any)=>({...graph,nodes:graph.nodes.map((node:any)=>node.id==='image'?{...node,data:{...node.data,capabilityRef:'h3-motion-transfer-v1',capabilityVersion:'1',parameterSchemaVersion:'1'}}:node)}));
 if(change==='session')c.flush.mockImplementation(()=>{c.runtime.auth.user={id:'another-user'};});
 await Promise.resolve();c.click();await vi.waitFor(()=>expect(c.notice).toHaveBeenCalledOnce());expect(c.execution.generate).not.toHaveBeenCalled();expect(c.action.onClick).not.toHaveBeenCalled();c.dispose();
});

it('retains source-duration preflight ahead of the STUDIO dispatcher',async()=>{
 const c=sourceMotionControls();c.action.preflight.mockReturnValue('请添加动作源视频');await Promise.resolve();c.click();expect(c.notice).toHaveBeenCalledExactlyOnceWith('请添加动作源视频');expect(c.execution.generate).not.toHaveBeenCalled();expect(c.action.onClick).not.toHaveBeenCalled();expect(c.flush).not.toHaveBeenCalled();c.dispose();
});

it.each(['v1','unknown-version','required-prompt','different-policy'])('retains the existing native callback for %s instead of broadening the promptless dispatcher',async mode=>{
 const c=sourceMotionControls();
 if(mode==='v1'){c.action.currentModel.capabilityVersion='1';c.action.currentModel.parameterSchemaVersion='1';}
 if(mode==='unknown-version'){c.action.currentModel.capabilityVersion='3';c.action.currentModel.parameterSchemaVersion='3';}
 if(mode==='required-prompt')c.action.currentModel.studioVideoInputGuidance.promptIgnored=false;
 if(mode==='different-policy')c.action.currentModel.config.find((field:any)=>field.paramName==='outputPreset').studioVideoParameterMetadata.durationPolicy='FIXED';
 await Promise.resolve();c.click();expect(c.action.preflight).toHaveBeenCalledOnce();expect(c.action.onClick).toHaveBeenCalledExactlyOnceWith({cancel:expect.any(Function)});expect(c.execution.generate).not.toHaveBeenCalled();c.dispose();
});

function firstSourceMotionControls(){
 const c=sourceMotionControls(),bindings=new ModelBindings(),catalog=vi.fn().mockResolvedValue([{...sourceMotionCatalog[0],testMode:false}]),current=vi.fn(()=>true),record=vi.fn((node:any,patch:any)=>bindings.record('p',node,patch));
 c.restore.mockImplementation((id:string,graph:any)=>bindings.graph(id,graph));Object.assign(c.runtime,{modelBindingPort:()=>({current,node:(node:any)=>bindings.node('p',node),record})});Object.assign(c.execution,{catalog});
 return{...c,catalog,record,bindingCurrent:current};
}

it.each(['click','keyboard'])('freezes an unbound first H3 v2 selection through ModelBindings on %s after matching the current catalog',async route=>{
 const c=firstSourceMotionControls();await Promise.resolve();const before=structuredClone(c.snapshot);route==='click'?c.click():c.key();await vi.waitFor(()=>expect(c.execution.generate).toHaveBeenCalledOnce());
 expect(c.catalog).toHaveBeenCalledOnce();expect(c.record).toHaveBeenCalledExactlyOnceWith(c.snapshot.nodes[0],{modelCode:'h3-motion-transfer-v1',capabilityRef:'h3-motion-transfer-v1',capabilityVersion:'2',parameterSchemaVersion:'2'});expect(c.restore('p',c.snapshot).nodes[0].data.capabilityVersion).toBe('2');expect(c.action.onClick).not.toHaveBeenCalled();expect(c.snapshot).toEqual(before);c.dispose();
});

it('freezes the JSON-serialized native first motion selection while retaining its ignored blank line',async()=>{
 const c=firstSourceMotionControls();c.action.currentModel=JSON.parse(JSON.stringify(c.action.currentModel));c.snapshot.nodes[0].data.prompt='\n';
 const metadata=c.action.currentModel.config.find((field:any)=>field.paramName==='outputPreset').studioVideoParameterMetadata;
 expect(Object.hasOwn(metadata,'outputLimits')).toBe(false);
 await Promise.resolve();const before=structuredClone(c.snapshot);c.click();await vi.waitFor(()=>expect(c.execution.generate).toHaveBeenCalledOnce());
 expect(c.catalog).toHaveBeenCalledOnce();expect(c.record).toHaveBeenCalledOnce();expect(c.action.onClick).not.toHaveBeenCalled();expect(c.notice).not.toHaveBeenCalled();expect(c.snapshot).toEqual(before);expect(c.snapshot.nodes[0].data.prompt).toBe('\n');c.dispose();
});

it('still rejects a defined source metadata difference after JSON normalization',async()=>{
 const c=firstSourceMotionControls();c.action.currentModel=JSON.parse(JSON.stringify(c.action.currentModel));c.action.currentModel.config.find((field:any)=>field.paramName==='outputPreset').studioVideoParameterMetadata.outputLimits={maxArtifactBytes:17};
 await Promise.resolve();c.click();await vi.waitFor(()=>expect(c.notice).toHaveBeenCalledOnce());expect(c.record).not.toHaveBeenCalled();expect(c.execution.generate).not.toHaveBeenCalled();c.dispose();
});

it.each(['history','prior-task','version','schema','policy','missing-model'])('does not bind an unreviewed or historical first motion selection: %s',async change=>{
 const c=firstSourceMotionControls();
 if(change==='history')c.snapshot.nodes[0].data.nodeOutputHistory=[{id:'old-result'}];
 if(change==='prior-task')c.snapshot.nodes[0].data.taskId='prior-task';
 const rows:any=structuredClone([{...sourceMotionCatalog[0],testMode:false}]);
 if(change==='version')rows[0].version='1';
 if(change==='schema')rows[0].parameterSchemaVersion='1';
 if(change==='policy')rows[0].parameterSchema['x-video-parameter-metadata'].durationPolicy='FIXED';
 if(change==='missing-model')rows.length=0;
 c.catalog.mockResolvedValue(rows);await Promise.resolve();c.click();await vi.waitFor(()=>expect(c.notice).toHaveBeenCalledOnce());expect(c.record).not.toHaveBeenCalled();expect(c.execution.generate).not.toHaveBeenCalled();c.dispose();
});

it.each(['preset','reference','session','binding'])('rejects edits while the first source-duration selection waits for catalog confirmation: %s',async change=>{
 const c=firstSourceMotionControls();let finish!:(rows:any[])=>void;c.catalog.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));await Promise.resolve();c.click();await vi.waitFor(()=>expect(finish).toBeTypeOf('function'));
 if(change==='preset')c.snapshot.nodes[0].data.params.outputPreset='portrait-480p-source';
 if(change==='reference')c.snapshot.nodes.find((node:any)=>node.id==='motion-video').data.sourceObjects=['rhtv-asset:changed'];
 if(change==='session')c.runtime.auth.user={id:'other-user'};
 if(change==='binding')c.bindingCurrent.mockReturnValue(false);
 finish([{...sourceMotionCatalog[0],testMode:false}]);await vi.waitFor(()=>expect(c.notice).toHaveBeenCalledOnce());expect(c.record).not.toHaveBeenCalled();expect(c.execution.generate).not.toHaveBeenCalled();c.dispose();
});

it.each(['blank-line','retained-description','explicit-description'])('preserves ignored text without fabricating a prompt: %s',async mode=>{
 const c=sourceMotionControls();
 if(mode==='blank-line'){c.snapshot.nodes[0].data.prompt='\n';c.action.params.prompt='';}
 if(mode==='retained-description')c.snapshot.nodes[0].data.prompt='A previously authored description.';
 if(mode==='explicit-description'){c.snapshot.nodes[0].data.params.prompt='A previously authored description.';c.action.params.prompt='A previously authored description.';}
 await Promise.resolve();const before=structuredClone(c.snapshot),params=structuredClone(c.action.params);c.click();expect(c.execution.generate).toHaveBeenCalledOnce();expect(c.snapshot).toEqual(before);expect(c.action.params).toEqual(params);c.dispose();
});

const missingProviderKey='请先在个人设置配置对应厂商的 API Key。';
function unavailableProviderControls(overrides:any={},options:any={}){
 return controls({currentModel:capabilityModel({...officialCatalog[0],available:false,reason:missingProviderKey,testMode:false}),disabled:false,...overrides},{label:'开始生成',...options});
}

it.each(['click','keyboard'])('disables an unavailable provider model and explains its reason for %s without changing parameters',async route=>{
 const c=unavailableProviderControls();c.snapshot.nodes[0].type='rh-video';c.button.disabled=false;const before=structuredClone(c.snapshot),params=structuredClone(c.action.params);await Promise.resolve();
 expect(c.button.disabled).toBe(true);expect(c.button.getAttribute('data-studio-model-unavailable')).toBe('true');expect(c.button.getAttribute('title')).toBe(missingProviderKey);expect(c.button.getAttribute('aria-description')).toBe(missingProviderKey);expect(c.button.getAttribute('aria-disabled')).toBe('true');expect(c.button.getAttribute('data-studio-video-cancel-blocked')).toBeNull();
 route==='click'?c.click():c.key();expect(c.action.onClick).not.toHaveBeenCalled();expect(c.action.preflight).not.toHaveBeenCalled();expect(c.execution.generate).not.toHaveBeenCalled();expect(c.notice).toHaveBeenCalledExactlyOnceWith(missingProviderKey);expect(c.snapshot).toEqual(before);expect(c.action.params).toEqual(params);c.dispose();
});

it('restores the current native generate state after the provider Key becomes available',async()=>{
 const c=unavailableProviderControls();c.button.disabled=false;await Promise.resolve();c.action.currentModel.available=true;c.action.currentModel.disabled=false;c.action.currentModel.reason=null;
 c.button.__reactProps$owned={className:'generate-action-button',disabled:false,'aria-label':'开始生成',title:'生成此视频','aria-disabled':false};c.mutate();await Promise.resolve();
 expect(c.button.disabled).toBe(false);expect(c.button.getAttribute('data-studio-model-unavailable')).toBeNull();expect(c.button.getAttribute('title')).toBe('生成此视频');expect(c.button.getAttribute('aria-description')).toBeNull();expect(c.button.getAttribute('aria-disabled')).toBe('false');c.click();expect(c.action.onClick).toHaveBeenCalledOnce();expect(c.execution.generate).toHaveBeenCalledOnce();c.dispose();
});

it('retains a newer native disabled state when the provider Key is restored',async()=>{
 const c=unavailableProviderControls();c.button.disabled=false;await Promise.resolve();c.action.currentModel.available=true;c.action.disabled=true;
 c.button.__reactProps$owned={className:'generate-action-button',disabled:true,'aria-label':'开始生成',title:'请等待素材上传完成','aria-disabled':true,'aria-description':'素材上传中'};c.mutate();await Promise.resolve();
 expect(c.button.disabled).toBe(true);expect(c.button.getAttribute('data-studio-model-unavailable')).toBeNull();expect(c.button.getAttribute('title')).toBe('请等待素材上传完成');expect(c.button.getAttribute('aria-description')).toBe('素材上传中');expect(c.button.getAttribute('aria-disabled')).toBe('true');c.click();expect(c.execution.generate).not.toHaveBeenCalled();c.dispose();
});

it.each([true,false])('does not replace running video cancellation policy when a Key is missing (supportsCancel=%s)',async supportsCancel=>{
 const c=unavailableProviderControls({currentModel:capabilityModel({...officialCatalog[0],available:false,reason:missingProviderKey,testMode:false,supportsCancel}),isGenerating:true},{label:'停止生成',initialData:{status:'processing',taskId:'accepted'}});c.snapshot.nodes[0].type='rh-video';c.button.disabled=false;await Promise.resolve();
 expect(c.button.getAttribute('data-studio-model-unavailable')).toBeNull();expect(c.button.disabled).toBe(!supportsCancel);c.click();expect(c.execution.generate).not.toHaveBeenCalled();if(supportsCancel)expect(c.execution.cancelNode).toHaveBeenCalledExactlyOnceWith('image');else{expect(c.notice).toHaveBeenCalledWith(expect.stringContaining('提交后不能停止'));expect(c.execution.cancelNode).not.toHaveBeenCalled();}c.dispose();
});

it('releases the unavailable-model decoration before a real supported Stop render',async()=>{
 const c=unavailableProviderControls({currentModel:capabilityModel({...officialCatalog[0],available:false,reason:missingProviderKey,testMode:false,supportsCancel:true})});c.snapshot.nodes[0].type='rh-video';c.button.disabled=false;await Promise.resolve();expect(c.button.getAttribute('data-studio-model-unavailable')).toBe('true');
 c.action.isGenerating=true;c.snapshot.nodes[0].data.status='processing';c.button.setAttribute('aria-label','停止生成');c.button.__reactProps$owned={className:'generate-action-button',disabled:false,'aria-label':'停止生成',title:'停止此任务'};c.mutate();await Promise.resolve();
 expect(c.button.disabled).toBe(false);expect(c.button.getAttribute('data-studio-model-unavailable')).toBeNull();expect(c.button.getAttribute('title')).toBe('停止此任务');expect(c.button.getAttribute('aria-description')).toBeNull();c.click();expect(c.execution.cancelNode).toHaveBeenCalledExactlyOnceWith('image');c.dispose();
});

it('updates the provider reason while unavailable and restores only its own attributes on disposal',async()=>{
 const c=unavailableProviderControls();c.button.disabled=false;c.button.setAttribute('title','原有生成提示');await Promise.resolve();c.action.currentModel.reason='该型号暂未开放。';c.mutate();await Promise.resolve();expect(c.button.getAttribute('title')).toBe('该型号暂未开放。');
 c.button.setAttribute('aria-description','原生界面更新的说明');c.button.disabled=false;c.dispose();expect(c.button.disabled).toBe(false);expect(c.button.getAttribute('title')).toBe('原有生成提示');expect(c.button.getAttribute('aria-description')).toBe('原生界面更新的说明');expect(c.button.getAttribute('aria-disabled')).toBeNull();expect(c.button.getAttribute('data-studio-model-unavailable')).toBeNull();
});
