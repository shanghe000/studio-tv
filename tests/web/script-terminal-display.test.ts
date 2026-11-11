import {readFileSync} from 'node:fs';
import {expect,it,vi} from 'vitest';
import {installScriptTerminalDisplay} from '../../apps/web/src/service/script-terminal-display';

const frozen=readFileSync(new URL('../../apps/web/public/project/assets/index-DeyN_Phq.js',import.meta.url),'utf8');
const section=(a:string,b:string)=>{const start=frozen.indexOf(a),end=frozen.indexOf(b,start+a.length);if(start<0||end<0)throw new Error('Frozen script render seam changed');return frozen.slice(start,end);};
const jsx=(type:any,props:any)=>({type,props}),memo=(type:any,compare?:any)=>({$$typeof:Symbol.for('react.memo'),type,compare});
const stage={customBadgeText:'正在生成分镜表，请稍后',pendingOutputScene:'film'};

function setup(){
 const identity={},node:any={id:'script',type:'rh-script',position:{x:0,y:0},data:{status:'finished',taskId:'accepted',output:{rows:[{id:'one'}]},params:{scene:'film'}}},manager={getRemoteData:()=>({nodes:[node],edges:[]})};
 let terminal:Function=()=>{};const release=vi.fn(),runtime:any={auth:{user:identity},inspect:()=>({id:'p'}),execution:{onTerminal:(fn:Function)=>{terminal=fn;return release;}}};
 const notified=vi.fn(),react:any={useSyncExternalStore:(subscribe:Function,snapshot:Function)=>{subscribe(notified);return snapshot();},memo,useMemo:(fn:Function)=>fn(),useCallback:(fn:Function)=>fn,useRef:(value:any)=>({current:value}),useState:(value:any)=>[typeof value==='function'?value():value,()=>{}],useEffect:()=>{},useLayoutEffect:()=>{}};
 const native:any={r:react,j:{jsx,jsxs:jsx},bt:()=>manager};
 const localState={localRunningNodeIds:[],selectedNodeIds:[],isLocalRunning:()=>false,blurredNodeIds:new Set()},flowState={nodes:[node],edges:[]};
 const call=Object.assign((selector:Function)=>selector(localState),{getState:()=>localState}),scope:any={d:react,c:native.j,It:()=>({t:(key:string)=>key}),bv:()=> 'full',xa:()=>({getNode:()=>node}),qA:()=>()=>{},Yo:()=>false,Et:call,wr:(selector:Function)=>selector(flowState),Xi:()=> 'film',id:(output:any)=>output?.rows??[],hl:()=>false,mD:()=>false,Ku:()=>'',kce:()=>'',Gf:()=>({models:{}}),j0:()=>({}),P2:380,XD:220,hmt:220,lSe:()=>new Map(),B_t:()=>({}),aNe:()=>1,V_t:()=>({focusElementsInViewport:()=>{}}),av:()=>({id:'p'}),rr:{RUNNING:'running'},
  ba:()=>({getState:()=>({})}),fi:()=>false,ta:()=>false,Di:()=>false,ic:()=> 'Script',s4:()=>false,Va:()=>()=>{},kl:()=>()=>{},UTe:()=>({width:380,height:220}),WEt:()=>false,i1t:()=>false,lor:()=>false,lNr:()=>false,fNr:()=>false,ed:()=>false,VTr:()=>false,HSe:()=>false,TNr:(busy:boolean)=>busy,Ote:()=>undefined,vw:()=>({mode:'current'}),aP:()=>[],bV:()=>false,$d:()=>false,X2e:()=>false,uee:()=>false,UEt:function NativeOverlay(){},pTr:function NativeLabel(){},Qy:function NativeHandle(){},Yr:{Left:'left',Right:'right'},eHe:function NativeSkeleton(){},is:function NativeIcon(){},F5:()=>({}),Sd:()=>({}),su:()=>[],gOr:function NativeResize(){},pjr:function NativeTable(){},Vme:()=>false,
 };
 // Missing UI-only components are inert JSX types. The actual native Rjr/Eg
 // bodies, including fct/bTr busy conditions, execute unchanged. Effects are
 // deliberately not mounted here; the real browser trace supplies timing.
 const globals=new Proxy(scope,{has:()=>true,get:(target,key)=>key===Symbol.unscopables?undefined:key in target?target[key]:key in globalThis?(globalThis as any)[key]:()=>null});
 const source=section('function fct(','function ')+section('function bTr(','function ')+section('function Eg(','function ')+section('function Rjr(','const Ajr=');
 const components=new Function('scope',`with(scope){${source};return{Rjr,Eg};}`)(globals);
 const stop=installScriptTerminalDisplay(runtime,native);
 const props=(patch:any={})=>({id:'script',type:'rh-script',data:{...node.data,...stage,...patch}});
 const emit=(patch:any={})=>terminal({nodeId:'script',taskId:'accepted',projectId:'p',manager,status:'SUCCESS',...patch});
 const render=(type:any,p:any)=>{const element=native.j.jsx(type,p);return typeof element.type==='function'?element.type(p):element.type.type(p);};
 const tree=(element:any):any[]=>!element||typeof element!=='object'?[]:[element,...(Array.isArray(element.props?.children)?element.props.children:[element.props?.children]).flatMap(tree)];
 const skeleton=(element:any)=>tree(element).some(value=>value.type===scope.eHe);
 return{runtime,native,node,manager,identity,release,notified,components,props,emit,render,skeleton,skeletonData:(element:any)=>tree(element).find(value=>value.type===scope.eHe)?.props.data,stop};
}

it('proves the exact frozen Eg stays busy on the captured stale stage and clears only after a matching applied terminal receipt',()=>{
 const c=setup(),p=c.props(),raw=structuredClone(p);
 expect(c.skeleton(c.render(c.components.Eg,p))).toBe(true);
 c.emit();expect(c.notified).toHaveBeenCalledOnce();expect(c.skeleton(c.render(c.components.Eg,p))).toBe(false);
 expect(p).toEqual(raw);expect(c.node.data).not.toHaveProperty('customBadgeText');c.stop();
});
it('projects the actual frozen memo Rjr before its native Eg child receives props',()=>{
 const c=setup(),type=memo(c.components.Rjr),p=c.props();
 const before=c.render(type,p);expect(before.props.type).toBe('rh-script');expect(before.props.data.customBadgeText).toBe(stage.customBadgeText);
 c.emit();const after=c.render(type,p);expect(after.props.data.customBadgeText).toBe('');expect(after.props.data.pendingOutputScene).toBeNull();expect(after.props.data.output).toBe(p.data.output);expect(after.props.data.params).toBe(p.data.params);
 expect(c.skeleton(typeof after.type==='function'?after.type(after.props):after.type.type(after.props))).toBe(false);c.stop();
});
it.each([
 ['unknown badge',{customBadgeText:'导演自定义注释',pendingOutputScene:null}],
 ['unknown pending scene',{customBadgeText:'',pendingOutputScene:'user-custom-scene'}],
 ['test badge',{customBadgeText:'TEST MODE',pendingOutputScene:null}],
])('preserves %s instead of globally suppressing the skeleton',(_label,patch)=>{
 const c=setup(),p=c.props(patch);c.emit();expect(c.skeleton(c.render(c.components.Eg,p))).toBe(true);c.stop();
});
it('retains authoritative user/test badges when replacing an exact old generation stage',()=>{
 const c=setup();c.node.data.customBadgeText='用户徽章';c.emit();let out=c.render(c.components.Eg,c.props());expect(c.skeleton(out)).toBe(true);expect(c.skeletonData(out).customBadgeText).toBe('用户徽章');
 c.node.data.testMode=true;out=c.render(c.components.Eg,c.props());expect(c.skeleton(out)).toBe(true);expect(c.skeletonData(out).customBadgeText).toBe('TEST MODE');c.stop();
});
it.each(['new task','running again','other project','other manager','other identity','signed out','non-script'])('ignores an old receipt for %s',mode=>{
 const c=setup();c.emit();let p=c.props();
 if(mode==='new task'){c.node.data.taskId='new';p=c.props({taskId:'new'});}
 if(mode==='running again'){c.node.data.status='running';p=c.props({status:'running'});}
 if(mode==='other project')c.runtime.inspect=()=>({id:'other'});
 if(mode==='other manager')c.native.bt=()=>({getRemoteData:()=>({nodes:[c.node],edges:[]})});
 if(mode==='other identity')c.runtime.auth.user={};
 if(mode==='signed out')c.runtime.auth.user=null;
 if(mode==='non-script')c.node.type='rh-image';
 expect(c.skeleton(c.render(c.components.Eg,p))).toBe(true);c.stop();
});
it('leaves unrelated lookalikes untouched and releases its subscription without overwriting a later JSX wrapper',()=>{
 const c=setup();function Eg(){return null;}function Other(){return null;}
 expect(c.native.j.jsx(Eg,{}).type).toBe(Eg);expect(c.native.j.jsx(Other,{}).type).toBe(Other);
 const p=c.props(),adapted=c.native.j.jsx(c.components.Eg,p).type;c.emit();expect(c.skeleton(adapted(p))).toBe(false);
 const previous=c.native.j.jsx,later=(...args:any[])=>previous(...args);c.native.j.jsx=later;c.stop();expect(c.native.j.jsx).toBe(later);expect(c.release).toHaveBeenCalledOnce();expect(c.skeleton(adapted(p))).toBe(true);
});
