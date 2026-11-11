// @vitest-environment happy-dom
import {afterEach,expect,it,vi} from 'vitest';
import {installNativeGenerationControls} from '../../apps/web/src/service/native-integration';

const disposers:(()=>void)[]=[];
afterEach(()=>{for(const dispose of disposers.splice(0).reverse())dispose();document.body.replaceChildren();});

function setup(){
 document.body.innerHTML='<div class="react-flow__node" data-id="video"><div class="rh-params-card"><textarea></textarea><button type="button" class="glass-dropdown-trigger tap-dropdown-btn"><span>模型</span></button><button type="button" class="tap-dropdown-btn">普通模型</button><div class="studio-model-source-menu"><div role="tablist"><button type="button" role="tab">API 服务</button></div><button type="button">配置 API Key</button></div><div class="generate-btn-container"><button type="button" class="generate-action-button" aria-label="开始生成">开始生成</button></div></div></div>';
 const graph={nodes:[{id:'video',type:'rh-video',data:{status:'idle',params:{prompt:'A non-empty saved video prompt'}}}],edges:[]},state={selectedNodeIds:['video'],localRunningNodeIds:[]},prefs={submitTask:'enter'},generate=vi.fn().mockResolvedValue({id:'accepted'}),notice=vi.fn();let hooks:any;
 const native={bt:()=>({getRemoteData:()=>graph}),le:(value:any)=>{hooks=value;},c5:{getState:()=>state,setState:vi.fn()},gw:()=>prefs};
 const action={currentModel:{modelCode:'official-video',available:true},params:{prompt:'A non-empty visible video prompt'},visible:true,disabled:false,isGenerating:false,preflight:vi.fn(),onClick:vi.fn(()=>hooks.onGenerate('video'))};
 const generateButton=document.querySelector('.generate-action-button')!;
 Object.assign(generateButton,{__reactFiber$owned:{memoizedProps:{onClick:vi.fn()},return:{memoizedProps:action,return:{memoizedProps:{nodeId:'video'}}}}});
 const execution={generate,cancelNode:vi.fn(),onTerminal:()=>()=>{},onSettled:()=>()=>{},installNativeRunningPort:()=>()=>{}};
 disposers.push(installNativeGenerationControls({auth:{user:{id:'user'}},inspect:()=>({id:'project'}),execution},notice,native));
 return{action,generate,notice,prefs,prompt:document.querySelector('textarea')!,graph};
}

it.each(['.glass-dropdown-trigger','.glass-dropdown-trigger span','.tap-dropdown-btn:not(.glass-dropdown-trigger)','.studio-model-source-menu [role="tab"]','.studio-model-source-menu button:not([role])'])('lets keyboard events reach %s without generating a non-empty video',selector=>{
 const f=setup(),control=document.querySelector<HTMLElement>(selector)!,targetGuard=vi.fn((event:Event)=>event.stopPropagation());
 control.addEventListener('keydown',targetGuard);control.addEventListener('keyup',targetGuard);
 for(const submitTask of ['enter','shift-enter']){
  f.prefs.submitTask=submitTask;
  for(const key of ['Enter',' ','Spacebar'])for(const type of ['keydown','keyup']){
   const event=new KeyboardEvent(type,{key,shiftKey:submitTask==='shift-enter',bubbles:true,cancelable:true});
   control.dispatchEvent(event);
   expect(event.defaultPrevented).toBe(false);
  }
 }
 expect(targetGuard).toHaveBeenCalledTimes(12);
 expect(f.action.preflight).not.toHaveBeenCalled();expect(f.action.onClick).not.toHaveBeenCalled();expect(f.generate).not.toHaveBeenCalled();expect(f.notice).not.toHaveBeenCalled();
 expect(f.graph.nodes[0].data.params.prompt).toBe('A non-empty saved video prompt');
});

it.each(['enter','shift-enter'])('keeps the ordinary prompt %s generation shortcut',submitTask=>{
 const f=setup();f.prefs.submitTask=submitTask;const event=new KeyboardEvent('keydown',{key:'Enter',shiftKey:submitTask==='shift-enter',bubbles:true,cancelable:true});
 f.prompt.dispatchEvent(event);
 expect(event.defaultPrevented).toBe(true);expect(f.action.preflight).toHaveBeenCalledOnce();expect(f.action.onClick).toHaveBeenCalledOnce();expect(f.generate).toHaveBeenCalledExactlyOnceWith('video');expect(f.notice).not.toHaveBeenCalled();
});
