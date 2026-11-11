import {expect,it,vi} from 'vitest';
import {canvasProjectFromPath,installCanvasLifecycle} from '../../apps/web/src/service/canvas-lifecycle';

function setup({mounted=true}={}){
 const handlers=new Map<string,Function>(),client={roomId:'p'},entry={id:'p',client,identityId:'owner'};let attached:any=entry,subscriber!:(state:any)=>void,mutation!:()=>void;
 const runtime={canvasAttachment:()=>attached,detachCanvas:vi.fn(()=>{attached=null;}),setCanvasPageActive:vi.fn((active:boolean)=>{if(!active)runtime.detachCanvas();}),attachCanvas:vi.fn((id:string,client:any)=>{attached={id,client};})};
 const unsubscribe=vi.fn(),disconnect=vi.fn(),router={state:{location:{pathname:'/project/canvas/p'}},subscribe:vi.fn(fn=>{subscriber=fn;return unsubscribe;})};
 const element={},root:any={firstElementChild:mounted?element:null,children:mounted?[element]:[]},surface={location:{pathname:'/project/canvas/p'},MutationObserver:class {constructor(fn:()=>void){mutation=fn;}observe=vi.fn();disconnect=disconnect;},addEventListener:vi.fn((name:string,fn:Function)=>handlers.set(name,fn)),removeEventListener:vi.fn((name:string)=>handlers.delete(name))};
 const props=(value:any)=>value===element?[{value:{router}}]:[];
 const dispose=installCanvasLifecycle(runtime,props,surface,{getElementById:()=>root});
 const navigate=(pathname:string)=>{surface.location.pathname=pathname;router.state.location.pathname=pathname;subscriber(router.state);};
 return{runtime,client,entry,router,root,element,surface,dispose,unsubscribe,disconnect,handlers,navigate,mutation:()=>mutation()};
}

it('releases the old attachment on real SPA PUSH/POP while leaving query-only canvas navigation attached',()=>{
 const s=setup();s.navigate('/project/canvas/p');expect(s.runtime.detachCanvas).not.toHaveBeenCalled();
 s.navigate('/projects/canvas/me/');expect(s.runtime.detachCanvas).toHaveBeenCalledOnce();expect(s.runtime.canvasAttachment()).toBeNull();
 s.navigate('/project/canvas/p');expect(s.runtime.attachCanvas).not.toHaveBeenCalled();s.dispose();expect(s.unsubscribe).toHaveBeenCalledOnce();
});

it('stops a bfcache document and resumes only its same mounted canvas on pageshow',()=>{
 const s=setup();s.handlers.get('pagehide')!({persisted:true});expect(s.runtime.detachCanvas).toHaveBeenCalledOnce();expect(s.runtime.setCanvasPageActive).toHaveBeenCalledWith(false);expect(s.unsubscribe).not.toHaveBeenCalled();
 s.handlers.get('pageshow')!({persisted:true});expect(s.runtime.setCanvasPageActive).toHaveBeenLastCalledWith(true);expect(s.runtime.attachCanvas).toHaveBeenCalledExactlyOnceWith('p',s.client,'owner');
 // Duplicate pageshow must not create a second attachment/stream.
 s.handlers.get('pageshow')!({persisted:true});expect(s.runtime.attachCanvas).toHaveBeenCalledOnce();s.dispose();
});

it.each(['route','room'])('does not resume a cached document whose %s changed',change=>{
 const s=setup();s.handlers.get('pagehide')!({persisted:true});
 if(change==='route')s.surface.location.pathname='/projects/canvas/me/';else s.client.roomId='q';
 s.handlers.get('pageshow')!({persisted:true});expect(s.runtime.attachCanvas).not.toHaveBeenCalled();s.dispose();
});

it('cleans up a noncached page and its router subscription without reinstalling native integrations',()=>{
 const s=setup();s.handlers.get('pagehide')!({persisted:false});expect(s.runtime.canvasAttachment()).toBeNull();expect(s.unsubscribe).toHaveBeenCalledOnce();expect(s.handlers.size).toBe(0);s.dispose();expect(s.unsubscribe).toHaveBeenCalledOnce();
});

it('finds the existing router after native mount and detaches immediately if it already left the canvas',()=>{
 const s=setup({mounted:false});expect(s.router.subscribe).not.toHaveBeenCalled();s.router.state.location.pathname='/projects/canvas/me/';s.root.firstElementChild=s.element;s.root.children=[s.element];s.mutation();
 expect(s.router.subscribe).toHaveBeenCalledOnce();expect(s.disconnect).toHaveBeenCalledOnce();expect(s.runtime.detachCanvas).toHaveBeenCalledOnce();s.dispose();
});

it('accepts only canonical canvas identity paths',()=>{
 expect(canvasProjectFromPath('/project/canvas/prj_123/')).toBe('prj_123');
 for(const path of ['/projects/canvas/me/','/project/canvas/p/nested','/project/canvas/%2F','/project/canvas/%'])expect(canvasProjectFromPath(path)).toBeNull();
});
