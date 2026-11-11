// @vitest-environment happy-dom
import {afterEach,expect,it,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {URL as NodeURL} from 'node:url';
import {runInNewContext} from 'node:vm';
import {installNativePresence} from '../../apps/web/src/service/native-presence';
import {installNativeGenerationReadiness} from '../../apps/web/src/service/native-generation-readiness';
import {encodeGraph} from '../../apps/web/src/service/graph';
import {ApiError} from '../../apps/web/src/api/client';
import {MemoryDraftStorage} from './draft-journal-fixture';

const frozen=readFileSync(new NodeURL('../../apps/web/public/project/assets/index-DeyN_Phq.js',import.meta.url),'utf8');
const captured=(start:string,end:string)=>{const a=frozen.indexOf(start),b=frozen.indexOf(end,a+start.length);if(a<0||b<0)throw Error('Frozen event seam changed: '+start);return frozen.slice(a,b);};
const disposers:(()=>void)[]=[];
afterEach(()=>{for(const dispose of disposers.splice(0))dispose();document.body.innerHTML='';vi.restoreAllMocks();vi.unstubAllGlobals();});
const turn=()=>new Promise(resolve=>setTimeout(resolve,0));

function fixture(){
 vi.stubGlobal('localStorage',new MemoryDraftStorage());history.replaceState({},'', '/project/canvas/project');
 document.body.innerHTML='<div class="react-flow"><div class="react-flow__viewport"><div class="react-flow__node" data-id="source"><div class="react-flow__handle source connectable connectablestart connectableend" data-nodeid="source" data-handleid="output"></div></div><div class="react-flow__node" data-id="target"><div class="react-flow__handle target connectable connectablestart connectableend" data-nodeid="target" data-handleid="input"></div><div class="config-panel-wrap"><textarea>Original prompt</textarea></div></div></div></div>';
 const graph:any={nodes:[{id:'source',type:'rh-image',position:{x:0,y:0},data:{}},{id:'target',type:'rh-video',position:{x:300,y:0},data:{params:{prompt:'Original prompt'}}}],edges:[]};
 let sequence=0,ownClient='',leases:any[]=[],waiting=true,denied=false,finish!:()=>void,gate=new Promise<void>(resolve=>finish=resolve);const pending:any[]=[];
 const snapshot=()=>({schemaVersion:'1',projectId:'project',epoch:'boot',sequence:String(++sequence),serverTime:new Date().toISOString(),presenceTtlMs:20000,leaseTtlMs:15000,members:[{clientId:ownClient,userId:'user',displayName:'当前成员',role:'EDITOR',cursor:null,selectedNodeIds:[],lastSeenAt:new Date().toISOString()}],leases});
 const request=vi.fn(async(path:string,options:any={})=>{if(options.body?.clientId)ownClient=options.body.clientId;if(path.endsWith('/node-leases')&&options.method==='POST'){if(waiting)await gate;if(denied)throw new ApiError(409,'NODE_EDIT_OCCUPIED','其他成员正在编辑。');for(const nodeId of options.body.nodeIds)leases=[...leases.filter(lease=>lease.nodeId!==nodeId),{nodeId,clientId:ownClient,userId:'user',displayName:'当前成员',expiresAt:new Date(Date.now()+15000).toISOString()}];}return{data:snapshot(),etag:null,status:200};});
 const manager:any={getRemoteData:()=>graph,enqueue:vi.fn((op:any)=>pending.push(op)),flushOperationQueue:vi.fn(()=>{for(const op of pending.splice(0)){if(op.kind==='addEdge')graph.edges.push(op.edge);if(op.kind==='removeEdge')graph.edges=graph.edges.filter((edge:any)=>edge.id!==op.edgeId);}}),addEdge(edge:any){this.enqueue({kind:'addEdge',edge});this.flushOperationQueue(true);},removeEdge(edgeId:string){this.enqueue({kind:'removeEdge',edgeId});this.flushOperationQueue(true);}};
 const storage:any={snapshots:new Map([['project',{graph:encodeGraph(graph),revision:1}]]),canEdit:()=>true,subscribeAccess:()=>()=>{},encodeAsset:(value:string)=>value,captureDraft:vi.fn(),refreshDraftBackups:vi.fn(),draftRecoveryState:()=>({persistence:'saved'}),hasPending:()=>false};
 let attachment:any={id:'project',client:manager};const native:any={c5:{getState:()=>({selectedNodeIds:['target']}),subscribe:()=>()=>{}},j:{jsx:(_type:any,props:any)=>props,jsxs:(_type:any,props:any)=>props}},notice=vi.fn(),runtime:any={api:{requestV2:request,rawV2:vi.fn(async()=>new Response(new ReadableStream(),{headers:{'Content-Type':'text/event-stream'}})),reportV2Failure:vi.fn()},auth:{user:{id:'user'},onClear:()=>()=>{}},storage,canvasAttachment:()=>attachment,setCanvasPresence:(client:any)=>runtime.presence=client,waitForSave:vi.fn(async()=>{})};
 disposers.push(installNativePresence(runtime,native,notice));
 return{runtime,native,manager,graph,request,notice,grant:()=>{waiting=false;finish();},pause:()=>{waiting=true;gate=new Promise<void>(resolve=>finish=resolve);},deny:()=>{denied=true;waiting=false;finish();},switchProject:()=>{attachment={id:'other',client:{}};window.dispatchEvent(new Event('rhtv:canvas-attachment'));},source:document.querySelector<HTMLElement>('.source')!,target:document.querySelector<HTMLElement>('.target')!,input:document.querySelector<HTMLTextAreaElement>('textarea')!};
}

function frozenConnection(f:ReturnType<typeof fixture>,callbacks?:{connect:(connection:any)=>void;start:(event:any,details:any)=>void;end:(event:any,state:any)=>void}){
 const sourceHandle={id:'output',nodeId:'source',type:'source',position:'right',x:10,y:20},targetHandle={id:'input',nodeId:'target',type:'target',position:'left',x:310,y:20};
 const lookup=new Map([['source',{id:'source',internals:{handleBounds:{source:[sourceHandle]}}}],['target',{id:'target',internals:{handleBounds:{target:[targetHandle]}}}]]),update=vi.fn(),end=vi.fn(callbacks?.end),cancel=vi.fn();
 vi.spyOn(document,'elementFromPoint').mockImplementation(x=>x>100?f.target:f.source);
 const start=runInNewContext(captured('function Wyt(','function aVn(')+captured('function aVn(','function Yyt(')+captured('function Yyt(','const wge=')+';aVn',{
  jyt:(element:Element)=>element.getRootNode(),jh:(event:MouseEvent,rect?:DOMRect)=>({x:event.clientX-(rect?.left??0),y:event.clientY-(rect?.top??0)}),Y2:(_node:any,handle:any)=>handle,Yr:{Left:'left'},w8e:{right:'left'},WA:(point:any)=>point,mR:(point:any)=>point,rVn:(point:any)=>point.x>100?targetHandle:null,W2:{Strict:'strict'},requestAnimationFrame:vi.fn(),cancelAnimationFrame:vi.fn(),structuredClone,
 });
 const connected=vi.fn(callbacks?.connect??((connection:any)=>f.manager.addEdge({id:'edge',...connection}))),props=f.native.j.jsx('canvas',{nodes:f.graph.nodes,edges:f.graph.edges,onConnect:connected,onConnectStart:callbacks?.start,onConnectEnd:end});
 const down=(event:MouseEvent)=>start(event,{connectionMode:'strict',connectionRadius:20,handleId:'output',nodeId:'source',isTarget:false,domNode:document.querySelector('.react-flow'),nodeLookup:lookup,lib:'react',autoPanOnConnect:false,flowId:'qa',panBy:vi.fn(),cancelConnection:cancel,onConnectStart:props.onConnectStart,onConnect:props.onConnect,onConnectEnd:props.onConnectEnd,updateConnection:update,getTransform:()=>[0,0,1],getFromHandle:()=>sourceHandle,handleDomNode:f.source});
 f.source.addEventListener('mousedown',down);disposers.push(()=>f.source.removeEventListener('mousedown',down));
 return{connected,end,update,cancel};
}

const pointer=(type:string,target:EventTarget,x:number,y=20)=>target.dispatchEvent(new PointerEvent(type,{bubbles:true,cancelable:true,pointerId:1,pointerType:'mouse',button:0,buttons:type==='pointerup'?0:1,clientX:x,clientY:y}));

it.each(['before-release','after-release'])('finishes the real frozen connection once when the first lease arrives %s',async timing=>{
 const f=fixture();await vi.waitFor(()=>expect(f.runtime.presence?.state().status).toBe('connected'));const native=frozenConnection(f);
 pointer('pointerdown',f.source,10);await turn();
 if(timing==='before-release'){f.grant();await vi.waitFor(()=>expect(f.runtime.presence.owns(['source'])).toBe(true));await turn();}
 pointer('pointermove',f.target,310);pointer('pointerup',f.target,310);
 if(timing==='after-release'){expect(native.end).not.toHaveBeenCalled();f.grant();}
 await vi.waitFor(()=>expect(native.connected).toHaveBeenCalledTimes(1));expect(native.end).toHaveBeenCalledTimes(1);expect(native.cancel).toHaveBeenCalledTimes(1);expect(f.graph.edges).toEqual([{id:'edge',source:'source',sourceHandle:'output',target:'target',targetHandle:'input'}]);expect(f.runtime.presence.hasPending()).toBe(false);
 const updates=native.update.mock.calls.length;document.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,clientX:410,clientY:50,buttons:0}));document.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,clientX:410,clientY:50}));expect(native.update).toHaveBeenCalledTimes(updates);expect(native.end).toHaveBeenCalledTimes(1);
});

function frozenCanvasCallbacks(f:ReturnType<typeof fixture>){
 const callback=(start:string)=>captured(start,'},[').replace(/^[^=]+=d\.useCallback\(/,'')+'}';
 const add=vi.fn((edge:any)=>{f.manager.addEdge(edge);return false;}),selector=vi.fn(),context:any={
  i:false,ee:{current:f.graph.nodes},W:{get current(){return f.graph.edges;}},a:[],Ct:{current:false},Bt:{current:null},MouseEvent,pm:(nodes:any[],id:string)=>nodes.find(node=>node.id===id),Bm:()=>true,H2:()=>undefined,V2e:()=>true,AA:()=>({allowed:true,full:[]}),Qvt:()=>false,_me:(edge:any)=>({id:'edge',...edge}),dy:(edges:any[],source:string,target:string)=>edges.some(edge=>edge.source===source&&edge.target===target),h:add,G:vi.fn(),requestAnimationFrame:vi.fn(),G5:(x:number)=>f.graph.nodes.find(node=>node.id===(x>100?'target':'source')),ne:(point:any)=>point,k:selector,
 };
 const callbacks=runInNewContext('const _u='+callback('_u=d.useCallback(Ve=>{if(i||!Ve.source')+';const Kp='+callback('Kp=d.useCallback((Ve,vt)=>{vt.nodeId')+';const Kf='+callback('Kf=d.useCallback(Ve=>{const vt=Bt.current')+';({connect:_u,start:Kp,end:Kf})',context);
 return{...callbacks,add,selector,context};
}

async function withReadiness(f:ReturnType<typeof fixture>){
 f.runtime.execution={inspectGeneration:vi.fn(async()=>({status:'ready',issues:[]})),getGenerationCapabilities:()=>[]};disposers.push(installNativeGenerationReadiness(f.runtime,f.native,f.notice,()=>[]));await turn();
}
const rawMouse=(type:string,target:EventTarget,x:number)=>target.dispatchEvent(new MouseEvent(type,{bubbles:true,cancelable:true,clientX:x,clientY:20,button:0,buttons:type==='mouseup'?0:1}));

it('keeps the frozen onConnect/onConnectEnd ordering with both endpoint leases and no duplicate warning',async()=>{
 const f=fixture();await vi.waitFor(()=>expect(f.runtime.presence?.state().status).toBe('connected'));f.grant();await f.runtime.presence.acquire(['source','target']);await withReadiness(f);const canvas=frozenCanvasCallbacks(f),native=frozenConnection(f,canvas);
 pointer('pointerdown',f.source,10);rawMouse('mousedown',f.source,10);pointer('pointermove',f.target,310);rawMouse('mousemove',f.target,310);pointer('pointerup',f.target,310);rawMouse('mouseup',f.target,310);await turn();
 expect(native.connected).toHaveBeenCalledTimes(1);expect(canvas.add).toHaveBeenCalledTimes(1);expect(native.end).toHaveBeenCalledTimes(1);expect(f.notice).not.toHaveBeenCalled();expect(f.graph.edges).toHaveLength(1);expect(canvas.context.Bt.current).toBeNull();
});

it.each(['granted','denied'])('does not let the frozen onConnectEnd fallback bypass the second endpoint lease (%s)',async outcome=>{
 const f=fixture();await vi.waitFor(()=>expect(f.runtime.presence?.state().status).toBe('connected'));f.grant();await f.runtime.presence.acquire(['source']);f.pause();await withReadiness(f);const canvas=frozenCanvasCallbacks(f),native=frozenConnection(f,canvas);
 pointer('pointerdown',f.source,10);rawMouse('mousedown',f.source,10);pointer('pointermove',f.target,310);rawMouse('mousemove',f.target,310);pointer('pointerup',f.target,310);rawMouse('mouseup',f.target,310);await turn();expect(canvas.add).not.toHaveBeenCalled();expect(f.graph.edges).toEqual([]);expect(f.runtime.presence.hasPending()).toBe(false);
 if(outcome==='granted'){f.grant();await vi.waitFor(()=>expect(native.connected).toHaveBeenCalledTimes(1));expect(canvas.add).toHaveBeenCalledTimes(1);expect(f.graph.edges).toHaveLength(1);expect(f.notice).not.toHaveBeenCalled();}else{f.deny();await vi.waitFor(()=>expect(f.notice).toHaveBeenCalledWith('其他成员正在编辑。'));expect(canvas.add).not.toHaveBeenCalled();expect(native.connected).not.toHaveBeenCalled();expect(f.graph.edges).toEqual([]);expect(f.runtime.presence.hasPending()).toBe(false);}
 expect(canvas.context.Bt.current).toBeNull();expect(canvas.selector).not.toHaveBeenCalled();
});

it('does not cancel a legitimate first drag when the previously focused prompt blurs',async()=>{
 const f=fixture();await vi.waitFor(()=>expect(f.runtime.presence?.state().status).toBe('connected'));f.grant();await f.runtime.presence.acquire(['target']);f.input.focus();f.pause();await withReadiness(f);const canvas=frozenCanvasCallbacks(f),native=frozenConnection(f,canvas),node=f.source.closest<HTMLElement>('.react-flow__node')!;node.tabIndex=0;const focus=()=>node.focus();f.source.addEventListener('mousedown',focus);disposers.push(()=>f.source.removeEventListener('mousedown',focus));
 pointer('pointerdown',f.source,10);await turn();f.grant();await vi.waitFor(()=>expect(f.runtime.presence.owns(['source'])).toBe(true));await turn();expect(document.activeElement).toBe(node);pointer('pointermove',f.target,310);pointer('pointerup',f.target,310);await turn();expect(native.connected).toHaveBeenCalledTimes(1);expect(canvas.add).toHaveBeenCalledTimes(1);expect(f.graph.edges).toHaveLength(1);expect(f.notice).not.toHaveBeenCalled();
});

it('finishes the first frozen gesture before replaying a rapid second gesture waiting behind its target lease',async()=>{
 const f=fixture();await vi.waitFor(()=>expect(f.runtime.presence?.state().status).toBe('connected'));f.grant();await f.runtime.presence.acquire(['source']);f.pause();await withReadiness(f);const canvas=frozenCanvasCallbacks(f),events:string[]=[];const firstEnd=canvas.end;canvas.end=(...args:any[])=>{events.push('first end');return firstEnd(...args);};const tracked=frozenConnection(f,canvas);const down=()=>events.push('second down');const button=document.createElement('button');button.textContent='下一次操作';f.source.closest('.react-flow__node')!.append(button);button.addEventListener('mousedown',down);
 pointer('pointerdown',f.source,10);rawMouse('mousedown',f.source,10);pointer('pointermove',f.target,310);rawMouse('mousemove',f.target,310);pointer('pointerup',f.target,310);rawMouse('mouseup',f.target,310);await turn();expect(canvas.add).not.toHaveBeenCalled();pointer('pointerdown',button,10);pointer('pointerup',button,10);rawMouse('mouseup',button,10);expect(events).toEqual([]);
 f.grant();await vi.waitFor(()=>expect(events).toEqual(['first end','second down']));expect(tracked.connected).toHaveBeenCalledTimes(1);expect(canvas.add).toHaveBeenCalledTimes(1);expect(canvas.context.Bt.current).toBeNull();expect(f.graph.edges).toHaveLength(1);expect(f.notice).not.toHaveBeenCalled();
});

it('does not use the frozen end fallback when inputs change and readiness rejects the pending connection',async()=>{
 const f=fixture();await vi.waitFor(()=>expect(f.runtime.presence?.state().status).toBe('connected'));f.grant();await f.runtime.presence.acquire(['source']);f.pause();await withReadiness(f);const canvas=frozenCanvasCallbacks(f),native=frozenConnection(f,canvas);rawMouse('mousedown',f.source,10);rawMouse('mousemove',f.target,310);rawMouse('mouseup',f.target,310);await turn();f.graph.nodes=f.graph.nodes.filter((node:any)=>node.id!=='source');f.grant();await vi.waitFor(()=>expect(f.notice).toHaveBeenCalledWith('连线节点已变化，请重新连接。'));expect(native.connected).not.toHaveBeenCalled();expect(canvas.add).not.toHaveBeenCalled();expect(f.graph.edges).toEqual([]);expect(canvas.context.Bt.current).toBeNull();expect(canvas.selector).not.toHaveBeenCalled();
});

it('discards a pending endpoint lease completion after the canvas changes',async()=>{
 const f=fixture();await vi.waitFor(()=>expect(f.runtime.presence?.state().status).toBe('connected'));f.grant();await f.runtime.presence.acquire(['source']);f.pause();await withReadiness(f);const canvas=frozenCanvasCallbacks(f),native=frozenConnection(f,canvas);rawMouse('mousedown',f.source,10);rawMouse('mousemove',f.target,310);rawMouse('mouseup',f.target,310);await turn();f.switchProject();f.grant();await turn();await turn();expect(native.connected).not.toHaveBeenCalled();expect(native.end).not.toHaveBeenCalled();expect(canvas.add).not.toHaveBeenCalled();expect(f.graph.edges).toEqual([]);expect(f.notice).not.toHaveBeenCalled();
});

it('does not forward a second compatibility mousemove during a replayed native connection',async()=>{
 const f=fixture();await vi.waitFor(()=>expect(f.runtime.presence?.state().status).toBe('connected'));const native=frozenConnection(f);pointer('pointerdown',f.source,10);f.grant();await vi.waitFor(()=>expect(f.runtime.presence.owns(['source'])).toBe(true));await turn();pointer('pointermove',f.target,310);const updates=native.update.mock.calls.length;
 f.target.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,clientX:310,clientY:20,buttons:1}));expect(native.update).toHaveBeenCalledTimes(updates);pointer('pointerup',f.target,310);await vi.waitFor(()=>expect(native.connected).toHaveBeenCalledTimes(1));expect(native.end).toHaveBeenCalledTimes(1);
});

it('retains modifier keys and the real DOM target through document and window replay listeners',async()=>{
 const f=fixture();await vi.waitFor(()=>expect(f.runtime.presence?.state().status).toBe('connected'));const docMove=vi.fn(),windowMove=vi.fn(),docUp=vi.fn();document.addEventListener('mousemove',docMove);window.addEventListener('mousemove',windowMove);document.addEventListener('mouseup',docUp);disposers.push(()=>{document.removeEventListener('mousemove',docMove);window.removeEventListener('mousemove',windowMove);document.removeEventListener('mouseup',docUp);});
 pointer('pointerdown',f.source,10);f.grant();await vi.waitFor(()=>expect(f.runtime.presence.owns(['source'])).toBe(true));await turn();for(const type of ['pointermove','pointerup'])f.target.dispatchEvent(new PointerEvent(type,{bubbles:true,cancelable:true,pointerId:1,pointerType:'mouse',button:0,buttons:type==='pointerup'?0:1,clientX:310,clientY:20,ctrlKey:true,metaKey:true,shiftKey:true,altKey:true}));
 expect(docMove).toHaveBeenCalledTimes(1);expect(windowMove).toHaveBeenCalledTimes(1);expect(docUp).toHaveBeenCalledTimes(1);for(const event of [docMove.mock.calls[0][0],docUp.mock.calls[0][0]]){expect(event.target).toBe(f.target);expect([event.ctrlKey,event.metaKey,event.shiftKey,event.altKey]).toEqual([true,true,true,true]);}
});

it.each(['blur','pointercancel'])('cleans up an already started frozen connection on %s without connecting or opening a selector',async type=>{
 const f=fixture();await vi.waitFor(()=>expect(f.runtime.presence?.state().status).toBe('connected'));const native=frozenConnection(f);pointer('pointerdown',f.source,10);f.grant();await vi.waitFor(()=>expect(f.runtime.presence.owns(['source'])).toBe(true));await turn();pointer('pointermove',f.target,310);window.dispatchEvent(new Event(type));await turn();
 expect(native.cancel).toHaveBeenCalledTimes(1);expect(native.connected).not.toHaveBeenCalled();expect(native.end).not.toHaveBeenCalled();expect(f.graph.edges).toEqual([]);const updates=native.update.mock.calls.length;document.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,clientX:310,clientY:20}));document.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,clientX:310,clientY:20}));expect(native.update).toHaveBeenCalledTimes(updates);expect(native.cancel).toHaveBeenCalledTimes(1);
});

it('does not replay a completed drag into another project after its late lease reply',async()=>{
 const f=fixture();await vi.waitFor(()=>expect(f.runtime.presence?.state().status).toBe('connected'));const native=frozenConnection(f);pointer('pointerdown',f.source,10);await turn();pointer('pointermove',f.target,310);pointer('pointerup',f.target,310);f.switchProject();f.grant();await turn();expect(native.update).not.toHaveBeenCalled();expect(native.connected).not.toHaveBeenCalled();expect(native.end).not.toHaveBeenCalled();expect(f.graph.edges).toEqual([]);
});

it.each(['before-release','after-release'])('ends a denied pointer intent %s without leaving document mouse events blocked',async timing=>{
 const f=fixture();await vi.waitFor(()=>expect(f.runtime.presence?.state().status).toBe('connected'));const native=frozenConnection(f),move=vi.fn(),click=vi.fn();document.addEventListener('mousemove',move);f.source.addEventListener('click',click);disposers.push(()=>document.removeEventListener('mousemove',move));pointer('pointerdown',f.source,10);await turn();
 if(timing==='before-release'){f.deny();await vi.waitFor(()=>expect(f.notice).toHaveBeenCalledWith('其他成员正在编辑。'));}pointer('pointerup',f.source,10);if(timing==='after-release')f.deny();await vi.waitFor(()=>expect(f.notice).toHaveBeenCalledWith('其他成员正在编辑。'));
 document.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,clientX:310,clientY:20}));f.source.click();expect(move).toHaveBeenCalledTimes(1);expect(click).not.toHaveBeenCalled();expect(native.update).not.toHaveBeenCalled();expect(native.connected).not.toHaveBeenCalled();expect(f.graph.edges).toEqual([]);
});

function frozenPasteGate(paste:ReturnType<typeof vi.fn>){
 const gate=captured('Oe=d.useCallback(de=>{if(!O||z)return;const ye=de.clipboardData;',',Ee=d.useCallback(').replace(/^Oe=d.useCallback\(/,'').replace(/,\[r,z,n,m,O\]\)$/,'');
 return runInNewContext(captured('function a_t(','function u4r(')+';('+gate+')',{O:'target',z:false,n:[],r:[],m:()=>'',sn:{t:()=>clipboardTip},iEe:(file:File)=>file.type.startsWith('image/')?'IMAGE':null,sVe:paste});
}
const clipboardTip='当前内容只能在RHTV画布中粘贴，如需复制图片，请使用右键菜单中“复制为图片”';

it('lets the real frozen paste capture consume its internal-reference marker after lease acquisition',async()=>{
 const f=fixture(),paste=vi.fn();await vi.waitFor(()=>expect(f.runtime.presence?.state().status).toBe('connected'));const gate=frozenPasteGate(paste);f.input.parentElement!.addEventListener('paste',gate,true);disposers.push(()=>f.input.parentElement?.removeEventListener('paste',gate,true));
 const data=new DataTransfer();data.setData('text/plain',clipboardTip);f.input.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data}));expect(f.input.value).toBe('Original prompt');f.grant();await vi.waitFor(()=>expect(paste).toHaveBeenCalledTimes(1));expect(f.input.value).toBe('Original prompt');expect(paste.mock.calls[0][4].getData('text/plain')).toBe(clipboardTip);
});

it('preserves image files and custom clipboard formats for the frozen paste capture',async()=>{
 const f=fixture(),paste=vi.fn();await vi.waitFor(()=>expect(f.runtime.presence?.state().status).toBe('connected'));const gate=frozenPasteGate(paste);f.input.parentElement!.addEventListener('paste',gate,true);disposers.push(()=>f.input.parentElement?.removeEventListener('paste',gate,true));
 const data=new DataTransfer(),file=new File(['local image'],'reference.png',{type:'image/png'});data.items.add(file);data.setData('application/x-studiotv-test','retained clipboard metadata');f.input.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data}));f.grant();await vi.waitFor(()=>expect(paste).toHaveBeenCalledTimes(1));expect(paste.mock.calls[0][4].files[0]).toBe(file);expect(paste.mock.calls[0][4].getData('application/x-studiotv-test')).toBe('retained clipboard metadata');expect(f.input.value).toBe('Original prompt');
});

it('emulates one ordinary text insertion only after the native paste handler leaves it unhandled',async()=>{
 const f=fixture(),paste=vi.fn(),input=vi.fn();await vi.waitFor(()=>expect(f.runtime.presence?.state().status).toBe('connected'));const gate=frozenPasteGate(paste);f.input.parentElement!.addEventListener('paste',gate,true);f.input.addEventListener('input',input);disposers.push(()=>f.input.parentElement?.removeEventListener('paste',gate,true));f.input.setSelectionRange(0,8);
 const data=new DataTransfer();data.setData('text/plain','New');f.input.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data}));expect(input).not.toHaveBeenCalled();f.grant();await vi.waitFor(()=>expect(input).toHaveBeenCalledTimes(1));expect(paste).not.toHaveBeenCalled();expect(f.input.value).toBe('New prompt');expect(f.input.selectionStart).toBe(3);expect(input.mock.calls[0][0].inputType).toBe('insertFromPaste');
});

it.each(['denied','switch'])('keeps pending paste inert when acquisition is %s',async outcome=>{
 const f=fixture(),paste=vi.fn(),input=vi.fn();await vi.waitFor(()=>expect(f.runtime.presence?.state().status).toBe('connected'));f.input.parentElement!.addEventListener('paste',paste,true);f.input.addEventListener('input',input);disposers.push(()=>f.input.parentElement?.removeEventListener('paste',paste,true));const data=new DataTransfer();data.setData('text/plain','Do not insert');f.input.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data}));await turn();if(outcome==='denied')f.deny();else{f.switchProject();f.grant();}await turn();await turn();expect(paste).not.toHaveBeenCalled();expect(input).not.toHaveBeenCalled();expect(f.input.value).toBe('Original prompt');
});

function frozenPlus(f:ReturnType<typeof fixture>){
 const plus=document.createElement('div');plus.className='node-plus-button node-add-btn-right';f.source.closest('.react-flow__node')!.append(plus);
 const drag=vi.fn(),short=vi.fn(),properties=f.native.j.jsx('plus',{onConnectionDragStart:drag,onShortClick:short});
 const component=runInNewContext(captured('function zM(','function B2r(')+';zM',{
  d:{useRef:(value:any)=>({current:value}),useState:(value:any)=>[value,vi.fn()],useCallback:(fn:Function)=>fn},c:{jsx:(_type:any,props:any)=>props,jsxs:(_type:any,props:any)=>props},document,setTimeout,clearTimeout,j2r:300,F2r:()=>({x:0,y:0}),
 });
 const rendered=component(properties);plus.addEventListener('pointerdown',rendered.onPointerDown);plus.addEventListener('click',rendered.onClick);disposers.push(()=>{plus.removeEventListener('pointerdown',rendered.onPointerDown);plus.removeEventListener('click',rendered.onClick);});return{plus,drag,short};
}
it.each(['before-release','after-release'])('starts the real pointer-only plus drag on the first gesture when its lease arrives %s',async timing=>{
 const f=fixture();await vi.waitFor(()=>expect(f.runtime.presence?.state().status).toBe('connected'));const plus=frozenPlus(f),mouse=vi.fn();plus.plus.addEventListener('mousedown',mouse);
 pointer('pointerdown',plus.plus,10);await turn();if(timing==='before-release'){f.grant();await vi.waitFor(()=>expect(f.runtime.presence.owns(['source'])).toBe(true));await turn();}
 pointer('pointermove',f.target,310);pointer('pointerup',f.target,310);if(timing==='after-release'){expect(plus.drag).not.toHaveBeenCalled();f.grant();}
 await vi.waitFor(()=>expect(plus.drag).toHaveBeenCalledTimes(1));expect(plus.short).not.toHaveBeenCalled();expect(mouse).not.toHaveBeenCalled();expect(plus.drag.mock.calls[0][0]).toBeInstanceOf(PointerEvent);
 pointer('pointermove',f.target,410);pointer('pointerup',f.target,410);expect(plus.drag).toHaveBeenCalledTimes(1);
});
it('opens the real plus menu once for a completed first short click after the lease arrives',async()=>{
 const f=fixture();await vi.waitFor(()=>expect(f.runtime.presence?.state().status).toBe('connected'));const plus=frozenPlus(f);pointer('pointerdown',plus.plus,10);pointer('pointerup',plus.plus,10);f.grant();await vi.waitFor(()=>expect(plus.short).toHaveBeenCalledTimes(1));expect(plus.drag).not.toHaveBeenCalled();
});
it.each(['blur','pointercancel'])('cleans the real plus pointer timer/listeners on %s without opening its menu',async type=>{
 const f=fixture();await vi.waitFor(()=>expect(f.runtime.presence?.state().status).toBe('connected'));const plus=frozenPlus(f);pointer('pointerdown',plus.plus,10);f.grant();await vi.waitFor(()=>expect(f.runtime.presence.owns(['source'])).toBe(true));await turn();window.dispatchEvent(new Event(type));pointer('pointermove',f.target,310);pointer('pointerup',f.target,310);await new Promise(resolve=>setTimeout(resolve,320));expect(plus.short).not.toHaveBeenCalled();expect(plus.drag).not.toHaveBeenCalled();
});
it.each(['denied','switch'])('does not start the real plus gesture after a %s lease attempt',async outcome=>{
 const f=fixture();await vi.waitFor(()=>expect(f.runtime.presence?.state().status).toBe('connected'));const plus=frozenPlus(f);pointer('pointerdown',plus.plus,10);pointer('pointermove',f.target,310);pointer('pointerup',f.target,310);if(outcome==='denied')f.deny();else{f.switchProject();f.grant();}await turn();await turn();expect(plus.short).not.toHaveBeenCalled();expect(plus.drag).not.toHaveBeenCalled();
});

it('replays the first SVG icon click after its lease without requiring HTMLElement.click()',async()=>{
 const f=fixture();await vi.waitFor(()=>expect(f.runtime.presence?.state().status).toBe('connected'));const svg=document.createElementNS('http://www.w3.org/2000/svg','svg'),path=document.createElementNS('http://www.w3.org/2000/svg','path');svg.append(path);f.source.closest('.react-flow__node')!.append(svg);const click=vi.fn();svg.addEventListener('click',click);pointer('pointerdown',path,10);pointer('pointerup',path,10);f.grant();await vi.waitFor(()=>expect(click).toHaveBeenCalledTimes(1));expect(click.mock.calls[0][0].target).toBe(path);expect(f.notice).not.toHaveBeenCalled();
});
