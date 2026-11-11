// @vitest-environment happy-dom
import {afterEach,expect,it,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {URL as FileURL} from 'node:url';
import {runInNewContext} from 'node:vm';
import {installNativeGenerationReadiness,generationReadinessSignature,nativeGenerationCandidateGraph} from '../../apps/web/src/service/native-generation-readiness';
import {ApiError} from '../../apps/web/src/api/client';
import {generationReadinessIssue} from '../../apps/web/src/service/generation-readiness';
import {createH3LongformMode} from '../../apps/web/src/service/h3-longform-mode';
let dispose:(()=>void)|undefined;
const longformModes:{dispose:()=>void}[]=[];
afterEach(()=>{dispose?.();dispose=undefined;for(const mode of longformModes)mode.dispose();longformModes.length=0;document.body.innerHTML='';for(const style of document.head.querySelectorAll('[data-readiness-test-style]'))style.remove();vi.useRealTimers();vi.restoreAllMocks();});
const blocked={status:'blocked',issues:[{nodeId:'target',code:'PROMPT_REQUIRED',field:'prompt',message:'请填写图片描述。'}]},ready={status:'ready',issues:[]};
function fixture(inspect:any=async()=>blocked,propsOf:(element:Element)=>any[]=()=>[]){
 vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockImplementation(function(){return new DOMRect(100,100,320,36);});
 document.body.innerHTML='<div class="react-flow"><div class="react-flow__node" data-id="target" tabindex="0"><div class="generate-btn-container"><button class="generate-action-button" aria-label="开始生成">开始生成</button></div></div></div>';
 const graph:any={nodes:[{id:'target',type:'rh-image',position:{x:0,y:0},data:{modelCode:'model',params:{prompt:''},status:'idle'}}],edges:[]},callbacks=new Set<()=>void>(),manager:any={getRemoteData:()=>graph,subscribe:(callback:()=>void)=>{callbacks.add(callback);return()=>callbacks.delete(callback);},enqueue:vi.fn(),addEdge:vi.fn(()=>true)},button=document.querySelector('button')!,nativeAction=vi.fn();button.addEventListener('click',nativeAction);
 let attached:any={id:'project',client:manager};const authCallbacks=new Set<()=>void>(),runtime:any={auth:{user:{id:'user'},onClear:(callback:()=>void)=>{authCallbacks.add(callback);return()=>authCallbacks.delete(callback);}},inspect:()=>({id:attached.id}),canvasAttachment:()=>attached,storage:{assets:new Map(),encodeAsset:(value:string)=>value,subscribeAccess:()=>()=>{}},execution:{setNativeSubmitIntent:vi.fn(()=>()=>{}),inspectGeneration:vi.fn(inspect),reportGenerationReadinessFailure:vi.fn(async()=>{}),getGenerationCapabilities:()=>[]}},native:any={bt:()=>manager,j:{jsx:(_type:any,props:any)=>({props}),jsxs:(_type:any,props:any)=>({props})},c5:{getState:()=>({setSelectedNodeIds:vi.fn()})}},notice=vi.fn();
 const setSelectedNodeIds=vi.fn(),setExpandedNodeId=vi.fn();native.c5.getState=()=>({setSelectedNodeIds,setExpandedNodeId});
 const originalEnqueue=manager.enqueue;dispose=installNativeGenerationReadiness(runtime,native,notice,propsOf);
 return{runtime,native,manager,originalEnqueue,graph,button,nativeAction,notice,setSelectedNodeIds,setExpandedNodeId,change:()=>{for(const callback of callbacks)callback();},switch:()=>{attached={id:'different',client:{getRemoteData:()=>({nodes:[],edges:[]}),subscribe:()=>()=>{}}};window.dispatchEvent(new Event('rhtv:canvas-attachment'));},logout:()=>{runtime.auth.user=null;for(const callback of authCallbacks)callback();}};
}
const settle=async()=>{await Promise.resolve();await vi.advanceTimersByTimeAsync(220);await Promise.resolve();};
it('keeps passive errors quiet, gives a compact reason on Run focus and opens details only on request',async()=>{
 vi.useFakeTimers();const f=fixture(async()=>blocked);await settle();
 const note=document.querySelector<HTMLElement>('.studio-generation-readiness')!,body=note.querySelector<HTMLElement>('.studio-generation-readiness__body')!,toggle=note.querySelector<HTMLButtonElement>('.studio-generation-readiness__toggle')!;
 expect(note.hidden).toBe(true);expect(body.hidden).toBe(true);expect(f.notice).not.toHaveBeenCalled();expect(f.runtime.execution.reportGenerationReadinessFailure).not.toHaveBeenCalled();
 f.button.focus();expect(note.hidden).toBe(false);expect(body.hidden).toBe(true);expect(note.querySelector('strong')?.textContent).toBe('请填写图片描述。');
 toggle.click();expect(body.hidden).toBe(false);expect(note.querySelector('strong')?.textContent).toBe('生成前请调整输入');
 document.querySelector('.react-flow')!.dispatchEvent(new Event('pointerdown',{bubbles:true}));expect(note.hidden).toBe(true);expect(f.nativeAction).not.toHaveBeenCalled();
});
it('does not cache a recovered synchronization block under unchanged model inputs',async()=>{
 vi.useFakeTimers();let blockedSync=true;const f=fixture(async()=>blockedSync?{status:'blocked',issues:[{nodeId:'target',code:'LOCAL_DRAFT_CONFLICT',message:'正在同步'}]}:ready);f.runtime.storage.isBlocked=()=>blockedSync;f.change();await settle();expect(f.button.getAttribute('data-studio-generation-blocked')).toBe('blocked');
 blockedSync=false;f.change();await settle();expect(f.button.hasAttribute('data-studio-generation-blocked')).toBe(false);expect(f.runtime.execution.inspectGeneration).toHaveBeenCalledTimes(2);expect(f.notice).not.toHaveBeenCalled();
});
it('retries a transient inspection without editing, removes the restriction on recovery and stops on unmount',async()=>{
 vi.useFakeTimers();let unavailable=true;const f=fixture(async()=>{if(unavailable)throw new TypeError('素材暂时无法读取');return ready;});await settle();expect(f.button.getAttribute('data-studio-generation-blocked')).toBe('blocked');
 await vi.advanceTimersByTimeAsync(1000);expect(f.runtime.execution.inspectGeneration).toHaveBeenCalledTimes(2);unavailable=false;await vi.advanceTimersByTimeAsync(2000);expect(f.button.hasAttribute('data-studio-generation-blocked')).toBe(false);expect(f.runtime.execution.inspectGeneration).toHaveBeenCalledTimes(3);
 unavailable=true;f.graph.nodes[0].data.params.prompt='a different input';f.change();await settle();f.button.remove();await settle();const count=f.runtime.execution.inspectGeneration.mock.calls.length;await vi.advanceTimersByTimeAsync(30000);expect(f.runtime.execution.inspectGeneration).toHaveBeenCalledTimes(count);expect(f.notice).not.toHaveBeenCalled();expect(f.runtime.execution.reportGenerationReadinessFailure).not.toHaveBeenCalled();
});
it.each([[504,'CANVAS_REQUEST_TIMEOUT'],[503,'ASSET_METADATA_SERVICE_BUSY'],[429,'ASSET_READ_LIMIT']] as const)('recovers a %s asset check without edits even when the service code is %s',async(status,code)=>{
 vi.useFakeTimers();let failed=true;const f=fixture(async()=>failed?{status:'blocked',issues:[generationReadinessIssue(new ApiError(status,code,'素材暂时无法读取'),{id:'target',type:'rh-image'})]}:ready);await settle();expect(f.button.getAttribute('data-studio-generation-blocked')).toBe('blocked');failed=false;await vi.advanceTimersByTimeAsync(1000);expect(f.button.hasAttribute('data-studio-generation-blocked')).toBe(false);expect(f.runtime.execution.inspectGeneration).toHaveBeenCalledTimes(2);expect(f.notice).not.toHaveBeenCalled();expect(f.runtime.execution.reportGenerationReadinessFailure).not.toHaveBeenCalled();
});
it('does not repeatedly inspect permanent invalid parameters or unavailable features',async()=>{
 vi.useFakeTimers();const f=fixture(async()=>({status:'blocked',issues:[generationReadinessIssue(new ApiError(422,'MODEL_PARAMETER_INVALID','请选择有效规格'),{id:'target'})]}));await settle();await vi.advanceTimersByTimeAsync(30000);expect(f.runtime.execution.inspectGeneration).toHaveBeenCalledOnce();expect(f.button.getAttribute('data-studio-generation-blocked')).toBe('blocked');
});
it('inspects a group root including unused members and rechecks a child whose running task fails without changing its output',async()=>{
 vi.useFakeTimers();const f=fixture(async(_project:any,ids:string[],candidate:any)=>candidate.nodes.find((node:any)=>node.id==='target').data.status==='running'?{status:'blocked',issues:[{nodeId:'target',code:'NODE_INPUT_PENDING',message:'仍在运行'}]}:ready);
 f.graph.nodes.push({id:'group',type:'group',data:{nodeIds:['target','material']}},{id:'material',type:'rh-image',data:{isUpload:true,sourceObjects:['rhtv-asset:unused']}});f.button.closest<HTMLElement>('.react-flow__node')!.dataset.id='group';f.button.parentElement!.classList.add('group-toolbar');f.button.className='execute-btn';f.graph.nodes[0].data.status='running';f.change();await settle();
 expect(f.runtime.execution.inspectGeneration.mock.calls.at(-1)![1]).toEqual(['group']);expect(f.button.getAttribute('data-studio-generation-blocked')).toBe('blocked');f.graph.nodes[0].data.status='failed';f.graph.nodes[0].data.errorMsg='failed upstream task';f.change();await settle();expect(f.button.hasAttribute('data-studio-generation-blocked')).toBe(false);expect(f.runtime.execution.inspectGeneration).toHaveBeenCalledTimes(2);
 const before=f.runtime.execution.inspectGeneration.mock.calls.length;f.graph.edges.push({source:'material',target:'material'});f.change();await settle();expect(f.runtime.execution.inspectGeneration.mock.calls.length).toBe(before+1);
});
it('discards a rejected old inspection when an uncommitted form changes during the request',async()=>{
 vi.useFakeTimers();let reject!:(error:Error)=>void;const action={currentModel:{config:[{paramName:'prompt'}]},params:{prompt:'old'},onClick:vi.fn()},f=fixture(async(_project:any,_ids:any,candidate:any)=>candidate.nodes[0].data.params.prompt==='old'?new Promise((_resolve,no)=>{reject=no;}):ready,()=>[action]);await vi.advanceTimersByTimeAsync(200);
 action.params.prompt='new';reject(new Error('old metadata error'));await settle();await settle();expect(f.button.hasAttribute('data-studio-generation-blocked')).toBe(false);expect(document.body.textContent).not.toContain('old metadata error');expect(f.notice).not.toHaveBeenCalled();
});
it('rechecks changed form inputs after a clicked inspection rejects and never submits the old candidate',async()=>{
 vi.useFakeTimers();let reject!:(error:Error)=>void,submittedPrompt='';const action={currentModel:{config:[{paramName:'prompt'}]},params:{prompt:'old'},onClick:vi.fn()},f=fixture(async()=>ready,()=>[action]);await settle();
 f.runtime.execution.inspectGeneration.mockImplementation(async(_project:any,_ids:any,candidate:any)=>candidate.nodes[0].data.params.prompt==='old'?new Promise((_resolve,no)=>{reject=no;}):ready);
 f.button.addEventListener('click',()=>{submittedPrompt=action.params.prompt;});f.button.click();await Promise.resolve();await Promise.resolve();action.params.prompt='new';reject(new Error('old metadata error'));await settle();expect(f.nativeAction).toHaveBeenCalledOnce();expect(submittedPrompt).toBe('new');expect(f.notice).not.toHaveBeenCalled();expect(f.runtime.execution.reportGenerationReadinessFailure).not.toHaveBeenCalled();
});
it('invalidates stale answers through model, reference, history and undo transitions even with unchanged counts',async()=>{
 vi.useFakeTimers();const f=fixture(async(_project:any,_ids:any,candidate:any)=>candidate.nodes[0].data.selectedOutputHistoryId?blocked:ready);await settle();
 const changes=[()=>{f.graph.nodes[0].data.capabilityVersion='2';},()=>{f.graph.nodes[0].data.params.imageUrls=['rhtv-asset:first'];},()=>{f.graph.nodes[0].data.params.imageUrls=['rhtv-asset:second'];},()=>{f.graph.nodes[0].data.selectedOutputHistoryId='history-1';}];
 for(const change of changes){const before=f.runtime.execution.inspectGeneration.mock.calls.length;change();f.change();await settle();expect(f.runtime.execution.inspectGeneration.mock.calls.length).toBeGreaterThan(before);}
 expect(f.button.getAttribute('data-studio-generation-blocked')).toBe('blocked');delete f.graph.nodes[0].data.selectedOutputHistoryId;f.change();await settle();expect(f.button.hasAttribute('data-studio-generation-blocked')).toBe(false);
 expect(f.nativeAction).not.toHaveBeenCalled();expect(f.notice).not.toHaveBeenCalled();
});
it('uses the verified visible default model only while a new node has no saved selection',()=>{
 const cap:any={capabilityRef:'shown',version:'4',parameterSchemaVersion:'3',available:false,parameterSchema:{properties:{duration:{type:'integer'}}}},graph:any={nodes:[{id:'v',type:'rh-video',data:{subType:'text-video',params:{}}}],edges:[]},action={currentModel:{capabilityRef:'shown',capabilityVersion:'4',config:[]},params:{duration:5},onClick:()=>{}};
 expect(nativeGenerationCandidateGraph(graph,'v',action,[cap]).nodes[0].data).toMatchObject({modelCode:'shown',capabilityRef:'shown',capabilityVersion:'4',parameterSchemaVersion:'3',params:{duration:5}});expect(graph.nodes[0].data.capabilityRef).toBeUndefined();
 graph.nodes[0].data={capabilityRef:'saved',capabilityVersion:'1',params:{}};expect(nativeGenerationCandidateGraph(graph,'v',action,[cap]).nodes[0].data).toMatchObject({capabilityRef:'saved',capabilityVersion:'1'});
});
it('suppresses only the H3-owned video ordinary readiness and generate action, restoring normal mode on close',async()=>{
 vi.useFakeTimers();const f=fixture(async(_project:any,ids:string[])=>({status:'blocked',issues:ids.map(nodeId=>({nodeId,code:'MODEL_UNAVAILABLE',message:nodeId==='target'?'长片目标的普通入口暂无可用模型。':'另一个视频仍需选择模型。'}))}));f.graph.nodes[0].type='rh-video';f.graph.nodes.push({id:'other',type:'rh-video',position:{x:400,y:0},data:{modelCode:'ordinary',params:{prompt:''},status:'idle'}});const other=document.createElement('div');other.className='react-flow__node';other.setAttribute('data-id','other');other.innerHTML='<div class="generate-btn-container"><button class="generate-action-button">开始生成</button></div>';document.querySelector('.react-flow')!.append(other);f.change();await settle();expect(f.button.getAttribute('data-studio-generation-blocked')).toBe('blocked');expect(other.querySelector('button')!.getAttribute('data-studio-generation-blocked')).toBe('blocked');
 const mode=createH3LongformMode(document,'project','target');longformModes.push(mode);mode.set(true);await settle();expect(f.button.hasAttribute('data-studio-generation-blocked')).toBe(false);expect(other.querySelector('button')!.getAttribute('data-studio-generation-blocked')).toBe('blocked');expect(document.body.textContent).not.toContain('长片目标的普通入口暂无可用模型');expect(document.body.textContent).toContain('另一个视频仍需选择模型');f.button.click();await settle();expect(f.nativeAction).not.toHaveBeenCalled();expect(f.notice).toHaveBeenLastCalledWith('此视频正在使用 H3 分段长片，请在长片面板中生成。');expect(f.runtime.execution.reportGenerationReadinessFailure).not.toHaveBeenCalled();
 mode.set(false);await settle();expect(f.button.getAttribute('data-studio-generation-blocked')).toBe('blocked');expect(other.querySelector('button')!.getAttribute('data-studio-generation-blocked')).toBe('blocked');
});
it('keeps a remotely busy longform video out of ordinary readiness after its panel is gone',async()=>{
 vi.useFakeTimers();const f=fixture(async()=>blocked);f.graph.nodes[0].type='rh-video';f.graph.nodes[0].data.studioLongformActiveJobId='longform-job';f.change();await settle();expect(f.runtime.execution.inspectGeneration).not.toHaveBeenCalled();expect(document.querySelector('.studio-generation-readiness')).toBeNull();f.button.click();await settle();expect(f.nativeAction).not.toHaveBeenCalled();delete f.graph.nodes[0].data.studioLongformActiveJobId;f.change();await settle();expect(f.runtime.execution.inspectGeneration).toHaveBeenCalledOnce();expect(f.button.getAttribute('data-studio-generation-blocked')).toBe('blocked');
});
it('does not suppress normal image readiness or another canvas with the same node ID',async()=>{
 vi.useFakeTimers();const f=fixture(async()=>blocked),mode=createH3LongformMode(document,'another-project','target');longformModes.push(mode);mode.set(true);f.graph.nodes[0].type='rh-video';f.change();await settle();expect(f.button.getAttribute('data-studio-generation-blocked')).toBe('blocked');mode.dispose();const imageMode=createH3LongformMode(document,'project','target');longformModes.push(imageMode);f.graph.nodes[0].type='rh-image';imageMode.set(true);f.change();await settle();expect(f.button.getAttribute('data-studio-generation-blocked')).toBe('blocked');
});
function animationFrames(){
 let sequence=0;const pending=new Map<number,FrameRequestCallback>();vi.spyOn(window,'requestAnimationFrame').mockImplementation(callback=>{pending.set(++sequence,callback);return sequence;});vi.spyOn(window,'cancelAnimationFrame').mockImplementation(id=>{pending.delete(id);});
 return{pending,run:()=>{const next=[...pending.values()];pending.clear();for(const callback of next)callback(0);}};
}
it('shows checking, then the exact actionable issue, and unlocks after a corrected input',async()=>{
 vi.useFakeTimers();const f=fixture(async(_project:any,_ids:any,graph:any)=>graph.nodes[0].data.params.prompt?ready:blocked);expect(f.button.getAttribute('data-studio-generation-blocked')).toBe('checking');expect(f.button.getAttribute('aria-description')).toContain('正在准备素材');expect(document.querySelector<HTMLElement>('.studio-generation-readiness')!.hidden).toBe(true);await settle();expect(document.body.textContent).toContain('请填写图片描述');expect(f.button.getAttribute('aria-disabled')).toBe('true');expect(f.button.disabled).toBe(false);
 f.graph.nodes[0].data.params.prompt='A fox';f.change();await settle();expect(f.button.hasAttribute('data-studio-generation-blocked')).toBe(false);expect(f.runtime.execution.inspectGeneration).toHaveBeenCalledTimes(2);expect(f.runtime.execution.reportGenerationReadinessFailure).not.toHaveBeenCalled();
});
it('ignores selection, dragging, geometry and job progress changes instead of issuing more HTTP work',async()=>{
 vi.useFakeTimers();const f=fixture(async()=>ready);await settle();f.graph.nodes[0].selected=true;f.graph.nodes[0].dragging=true;f.graph.nodes[0].position.x=200;f.graph.nodes[0].data.progress=50;f.change();await settle();expect(f.runtime.execution.inspectGeneration).toHaveBeenCalledTimes(1);
});
it('revalidates on click before existing native generation and never submits a blocked command',async()=>{
 vi.useFakeTimers();const f=fixture(async()=>blocked);await settle();expect(f.runtime.execution.reportGenerationReadinessFailure).not.toHaveBeenCalled();f.button.click();f.button.click();await settle();expect(f.nativeAction).not.toHaveBeenCalled();expect(f.notice).not.toHaveBeenCalled();expect(document.querySelector<HTMLElement>('.studio-generation-readiness__body')!.hidden).toBe(false);expect(f.runtime.execution.inspectGeneration).toHaveBeenCalledTimes(2);expect(f.runtime.execution.reportGenerationReadinessFailure).toHaveBeenCalledExactlyOnceWith('project',blocked.issues[0],{targetId:'target',targetType:'NODE',control:'GENERATE',click:{visible:true,disabled:true,ariaDisabled:true}},expect.objectContaining({nodes:expect.any(Array),edges:[]}));
});
it('shows the server log number for an explicit rejected click on the same issue without a second toast',async()=>{
 vi.useFakeTimers();const f=fixture(async()=>blocked);f.runtime.execution.reportGenerationReadinessFailure.mockResolvedValue('test-log-number');
 await settle();expect(f.runtime.execution.reportGenerationReadinessFailure).not.toHaveBeenCalled();f.button.click();await settle();
 expect(f.notice).not.toHaveBeenCalled();expect(document.querySelector('.studio-generation-readiness__body')?.textContent).toContain('请填写图片描述。');expect(document.querySelector('.studio-generation-readiness__hint')?.textContent).toContain('test-log-number');
});
it('replays exactly one generation click after the asynchronous inspector permits it',async()=>{
 vi.useFakeTimers();const f=fixture(async()=>ready);await settle();f.button.click();f.button.click();await settle();expect(f.nativeAction).toHaveBeenCalledTimes(1);expect(f.runtime.execution.reportGenerationReadinessFailure).not.toHaveBeenCalled();
});
it.each(['switch','logout'] as const)('does not apply or replay a stale readiness answer after %s',async change=>{
 vi.useFakeTimers();let resolve!:(value:any)=>void;const f=fixture(()=>new Promise(answer=>resolve=answer));await vi.advanceTimersByTimeAsync(200);f.button.click();await Promise.resolve();f[change]();await Promise.resolve();resolve(ready);await settle();expect(f.nativeAction).not.toHaveBeenCalled();expect(f.button.hasAttribute('data-studio-generation-blocked')).toBe(false);
});
it('keeps a network failure visibly blocked instead of declaring unknown metadata ready',async()=>{
 vi.useFakeTimers();const f=fixture(async()=>{throw new Error('素材信息暂时无法读取。');});await settle();expect(f.button.getAttribute('data-studio-generation-blocked')).toBe('blocked');expect(document.body.textContent).toContain('素材信息暂时无法读取');
});
it('guards native JSX and manager mutation bypasses for invalid connections',async()=>{
 vi.useFakeTimers();const f=fixture(async()=>ready);f.graph.nodes.push({id:'source',type:'rh-image',data:{sourceObjects:['rhtv-asset:s']}});const original=vi.fn(),props=f.native.j.jsx(()=>null,{nodes:f.graph.nodes,edges:f.graph.edges,onConnect:original,isValidConnection:()=>true}).props;
 expect(props.isValidConnection({source:'target',target:'target'})).toBe(false);props.onConnect({source:'target',target:'target'});expect(original).not.toHaveBeenCalled();expect(()=>f.manager.enqueue({kind:'addEdge',edge:{source:'target',target:'target'}})).toThrow();expect(()=>f.manager.addEdge({source:'target',target:'target'})).toThrow();expect(f.notice).toHaveBeenCalledWith('节点不能连接自身。');
});
it('keeps actual reference and selected history changes in the readiness signature',()=>{
 const graph:any={nodes:[{id:'target',type:'rh-image',data:{params:{prompt:'A'}}},{id:'source',type:'rh-image',data:{sourceObjects:['rhtv-asset:s']}}],edges:[{source:'source',target:'target'}]},signature=generationReadinessSignature(graph,['target']);graph.nodes[1].data.selectedHistoryOutputId='another';expect(generationReadinessSignature(graph,['target'])).not.toBe(signature);
});

it('never intercepts a model-menu keyboard choice as a generation shortcut',async()=>{
 vi.useFakeTimers();const f=fixture(async()=>ready);await settle();const menu=document.createElement('button');menu.className='glass-dropdown-trigger';f.button.closest('.react-flow__node')!.append(menu);menu.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',shiftKey:true,bubbles:true,cancelable:true}));await settle();expect(f.nativeAction).not.toHaveBeenCalled();expect(f.runtime.execution.inspectGeneration).toHaveBeenCalledTimes(1);
});
it('checks ordinary groups but preserves dedicated native storyboard and video orchestration',async()=>{
 vi.useFakeTimers();const f=fixture(async()=>ready),element=f.button.closest('.react-flow__node')!;element.setAttribute('data-id','group');element.classList.add('group-toolbar');f.button.className='execute-btn';f.graph.nodes.push({id:'group',type:'group',data:{nodeIds:['target']}});f.change();await settle();expect(f.runtime.execution.inspectGeneration.mock.calls.at(-1)![1]).toEqual(['group']);
 const calls=f.runtime.execution.inspectGeneration.mock.calls.length;f.graph.nodes[1].data.groupType='video';f.change();await settle();expect(f.button.hasAttribute('data-studio-generation-blocked')).toBe(false);f.button.click();await settle();expect(f.nativeAction).toHaveBeenCalledTimes(1);expect(f.runtime.execution.inspectGeneration).toHaveBeenCalledTimes(calls);
});

it('preserves the original blocked message and action when diagnostic recording fails',async()=>{
 vi.useFakeTimers();const f=fixture(async()=>blocked);f.runtime.execution.reportGenerationReadinessFailure.mockRejectedValue(new Error('diagnostic offline'));await settle();f.button.click();await settle();expect(f.nativeAction).not.toHaveBeenCalled();expect(f.notice).not.toHaveBeenCalled();expect(document.querySelector('.studio-generation-readiness__body')?.textContent).toContain('请填写图片描述。');expect(f.runtime.execution.reportGenerationReadinessFailure).toHaveBeenCalledTimes(1);
});

it('checks each visible button as its own plan and reserves deferred upstream outputs for the actual group',async()=>{
 vi.useFakeTimers();const missing={status:'blocked',issues:[{nodeId:'downstream',sourceNodeId:'target',code:'REFERENCE_REQUIRED',message:'下游图片：上游尚未生成图片，请先生成上游。'}]},f=fixture(async(_project:any,ids:string[])=>ids.includes('downstream')&&!ids.includes('target')?missing:{...ready,...(ids.length>1?{deferredNodeIds:['downstream']}:{})});
 f.graph.nodes.push({id:'downstream',type:'rh-image',position:{x:400,y:0},data:{modelCode:'image-editor',params:{prompt:'Edit the upstream picture'}}},{id:'group',type:'group',position:{x:0,y:0},data:{nodeIds:['target','downstream']}});f.graph.edges.push({source:'target',target:'downstream'});
 const downstream=document.createElement('div');downstream.className='react-flow__node';downstream.setAttribute('data-id','downstream');downstream.innerHTML='<div class="generate-btn-container"><button class="generate-action-button" aria-label="开始生成">开始生成</button></div>';document.querySelector('.react-flow')!.append(downstream);
 const group=document.createElement('div');group.className='react-flow__node group-toolbar';group.setAttribute('data-id','group');group.innerHTML='<button class="execute-btn">整组执行</button>';document.querySelector('.react-flow')!.append(group);
 // A second control for A must share A's exact inspection, without B or group.
 const retry=document.createElement('button');retry.className='rh-node-fail-overlay__btn--retry';retry.textContent='重试';f.button.parentElement!.append(retry);f.change();await settle();
 expect(f.button.hasAttribute('data-studio-generation-blocked')).toBe(false);expect(retry.hasAttribute('data-studio-generation-blocked')).toBe(false);expect(downstream.querySelector('button')!.getAttribute('data-studio-generation-blocked')).toBe('blocked');expect(document.getElementById(downstream.querySelector('button')!.getAttribute('aria-describedby')!)?.textContent).toContain('上游尚未生成图片');expect(group.querySelector('button')!.hasAttribute('data-studio-generation-blocked')).toBe(false);
 expect(f.runtime.execution.inspectGeneration.mock.calls.map((call:any[])=>[...call[1]].sort().join(','))).toEqual(['target','downstream','group']);expect(f.runtime.execution.reportGenerationReadinessFailure).not.toHaveBeenCalled();
});

it('checks the current uncommitted form parameters without mutating the manager, and unlocks when the visible control is corrected',async()=>{
 vi.useFakeTimers();const action:any={visible:true,currentModel:{modelCode:'model',config:[{paramName:'outputPreset',type:'list'}]},params:{outputPreset:'invalid-control-value'},onClick:vi.fn()},invalid={status:'blocked',issues:[{nodeId:'target',code:'MODEL_PARAMETER_INVALID',field:'outputPreset',message:'请选择模型支持的输出规格。'}]},f=fixture(async(_project:any,_ids:any,candidate:any)=>candidate.nodes[0].data.params.outputPreset==='supported-preset'?ready:invalid,()=>[action]);
 f.graph.nodes[0].data.params.outputPreset='supported-preset';f.change();await settle();expect(f.button.getAttribute('data-studio-generation-blocked')).toBe('blocked');expect(document.body.textContent).toContain('请选择模型支持的输出规格');expect(f.graph.nodes[0].data.params.outputPreset).toBe('supported-preset');expect(f.originalEnqueue).not.toHaveBeenCalled();
 f.button.click();await settle();expect(f.nativeAction).not.toHaveBeenCalled();expect(f.runtime.execution.reportGenerationReadinessFailure).toHaveBeenCalledTimes(1);expect(f.runtime.execution.inspectGeneration.mock.calls.at(-1)![2].nodes[0].data.params.outputPreset).toBe('invalid-control-value');
 action.params.outputPreset='supported-preset';f.button.dispatchEvent(new Event('input',{bubbles:true}));await settle();expect(f.button.hasAttribute('data-studio-generation-blocked')).toBe(false);expect(f.graph.nodes[0].data.params.outputPreset).toBe('supported-preset');expect(f.nativeAction).not.toHaveBeenCalled();
});
it('keeps different buttons current form candidates separate, ignores hidden selectors, and leaves groups on the mounted graph',()=>{
 const graph:any={nodes:[{id:'target',type:'rh-image',data:{modelCode:'frozen-model',capabilityRef:'frozen-model',capabilityVersion:'1',generateNum:1,params:{prompt:'Mounted prompt',outputPreset:'mounted'}}},{id:'group',type:'group',data:{nodeIds:['target']}}],edges:[]},before=structuredClone(graph),model={config:[{paramName:'outputPreset'}]},action={currentModel:model,generateNum:4,params:{outputPreset:'candidate',prompt:'Visible prompt',rhModel:'different-model',capabilityRef:'different-model',unrelatedUiCache:'ignored'}};
 const candidate=nativeGenerationCandidateGraph(graph,'target',action);expect(candidate.nodes[0].data).toMatchObject({modelCode:'frozen-model',capabilityRef:'frozen-model',capabilityVersion:'1',generateNum:4,params:{prompt:'Visible prompt',outputPreset:'candidate'}});expect(candidate.nodes[0].data.params).not.toHaveProperty('rhModel');expect(candidate.nodes[0].data.params).not.toHaveProperty('unrelatedUiCache');expect(nativeGenerationCandidateGraph(graph,'group',action)).toBe(graph);expect(nativeGenerationCandidateGraph(graph,'target',{...action,params:{outputPreset:'another'}}).nodes[0].data.params.outputPreset).toBe('another');expect(graph).toEqual(before);
});
it('places the actionable note in a body portal without changing the native pill children or classes',async()=>{
 vi.useFakeTimers();const f=fixture(async()=>blocked),pill=f.button.parentElement!,children=[...pill.children],classes=pill.className;
 await settle();const note=document.querySelector<HTMLElement>('.studio-generation-readiness')!;expect(note.parentElement).toBe(document.body);expect(note.hidden).toBe(true);f.button.focus();expect(note.hidden).toBe(false);expect([...pill.children]).toEqual(children);expect(pill.className).toBe(classes);expect(pill.querySelector('.studio-generation-readiness')).toBeNull();expect(f.button.getAttribute('aria-describedby')).toBe(note.id);
 dispose?.();dispose=undefined;expect(document.querySelector('.studio-generation-readiness')).toBeNull();expect(f.button.hasAttribute('aria-describedby')).toBe(false);expect([...pill.children]).toEqual(children);expect(pill.className).toBe(classes);
});
it('restores pre-existing descriptions and native host classes when the portal is disposed',async()=>{
 vi.useFakeTimers();const f=fixture(async()=>blocked),pill=f.button.parentElement!;dispose?.();pill.classList.add('existing-layout');f.button.setAttribute('aria-describedby','existing-help');const help=document.createElement('p');help.id='existing-help';help.textContent='原有帮助';document.body.append(help);dispose=installNativeGenerationReadiness(f.runtime,f.native,f.notice,()=>[]);await settle();const note=document.querySelector<HTMLElement>('.studio-generation-readiness')!;expect(note.parentElement).toBe(document.body);expect(pill.className).toBe('generate-btn-container existing-layout');
 dispose?.();dispose=undefined;expect(f.button.getAttribute('aria-describedby')).toBe('existing-help');expect(pill.className).toBe('generate-btn-container existing-layout');expect(help.isConnected).toBe(true);expect(document.querySelector('.studio-generation-readiness')).toBeNull();
});
it('locates an issue outside the native pill click handler without generating a task',async()=>{
 vi.useFakeTimers();const f=fixture(async()=>blocked),pill=f.button.parentElement!,submit=vi.fn();pill.addEventListener('click',submit);await settle();const note=document.querySelector<HTMLElement>('.studio-generation-readiness')!,issue=note.querySelector<HTMLButtonElement>('.studio-generation-readiness__issue')!;issue.click();await settle();expect(f.setSelectedNodeIds).toHaveBeenCalledWith(['target']);expect(f.setExpandedNodeId).toHaveBeenCalledWith('target');expect(submit).not.toHaveBeenCalled();expect(f.nativeAction).not.toHaveBeenCalled();expect(f.runtime.execution.reportGenerationReadinessFailure).not.toHaveBeenCalled();
});
it('keeps issue actions independent from a disabled native pill pointer-events rule',async()=>{
 vi.useFakeTimers();const f=fixture(async()=>blocked),pill=f.button.parentElement!;pill.classList.add('is-disabled');f.button.disabled=true;const nativeStyle=document.createElement('style');nativeStyle.setAttribute('data-readiness-test-style','');nativeStyle.textContent='.generate-btn-container.is-disabled>*{pointer-events:none}';document.head.append(nativeStyle);f.change();await settle();
 const note=document.querySelector<HTMLElement>('.studio-generation-readiness')!,issue=note.querySelector<HTMLButtonElement>('.studio-generation-readiness__issue')!;expect(note.parentElement).toBe(document.body);expect(getComputedStyle(note).pointerEvents).not.toBe('none');issue.focus();expect(document.activeElement).toBe(issue);issue.click();await settle();expect(f.setSelectedNodeIds).toHaveBeenCalledWith(['target']);expect(f.nativeAction).not.toHaveBeenCalled();nativeStyle.remove();
});
it('checks only the visible expanded modal candidate when a hidden compact control retains different parameters',async()=>{
 vi.useFakeTimers();const compact={visible:true,currentModel:{config:[{paramName:'outputPreset'}]},params:{outputPreset:'compact-supported'},onClick:vi.fn()},expanded={visible:true,currentModel:{config:[{paramName:'outputPreset'}]},params:{outputPreset:'modal-invalid'},onClick:vi.fn()},modalIssue={status:'blocked',issues:[{nodeId:'target',code:'MODEL_PARAMETER_INVALID',message:'展开面板：请选择有效输出规格。'}]},f=fixture(async(_project:any,_ids:any,candidate:any)=>candidate.nodes[0].data.params.outputPreset==='modal-invalid'?modalIssue:ready,element=>[element.closest('.config-panel-modal-content')?expanded:compact]);
 f.button.closest<HTMLElement>('.react-flow__node')!.style.display='none';const modal=document.createElement('section');modal.className='config-panel-modal-content rh-canvas-image-params';modal.setAttribute('data-node-id','target');modal.innerHTML='<div class="generate-btn-container"><button class="generate-action-button" aria-label="开始生成">开始生成</button></div>';document.body.append(modal);f.change();await settle();
 expect(f.runtime.execution.inspectGeneration).toHaveBeenCalledTimes(1);expect(f.runtime.execution.inspectGeneration.mock.calls[0][2].nodes[0].data.params.outputPreset).toBe('modal-invalid');expect(f.button.hasAttribute('data-studio-generation-blocked')).toBe(false);expect(modal.querySelector('button')!.getAttribute('data-studio-generation-blocked')).toBe('blocked');const notes=[...document.querySelectorAll<HTMLElement>('.studio-generation-readiness')];expect(notes).toHaveLength(1);expect(notes[0].hidden).toBe(true);(modal.querySelector('button') as HTMLButtonElement).focus();expect(notes[0].hidden).toBe(false);expect(notes[0].textContent).toContain('展开面板');
});
it.each(['display','visibility','hidden','aria-hidden','zero-area'])('does not inspect or display a portal for a control hidden by %s',async mode=>{
 vi.useFakeTimers();const f=fixture(async()=>blocked),ancestor=f.button.closest<HTMLElement>('.react-flow__node')!;if(mode==='display')ancestor.style.display='none';if(mode==='visibility')ancestor.style.visibility='hidden';if(mode==='hidden')ancestor.hidden=true;if(mode==='aria-hidden')ancestor.setAttribute('aria-hidden','true');if(mode==='zero-area')vi.spyOn(f.button,'getBoundingClientRect').mockReturnValue(new DOMRect(0,0,0,0));f.change();await settle();expect(f.runtime.execution.inspectGeneration).not.toHaveBeenCalled();expect(f.button.hasAttribute('data-studio-generation-blocked')).toBe(false);expect(document.querySelector('.studio-generation-readiness')).toBeNull();
});
it('shows one portal at a time and switches active issues when a different blocked generation control is focused',async()=>{
 vi.useFakeTimers();const f=fixture(async(_project:any,ids:string[])=>({status:'blocked',issues:[{nodeId:ids[0],code:'PROMPT_REQUIRED',message:ids[0]==='target'?'第一个节点需要描述。':'第二个节点需要描述。'}]}));f.graph.nodes.push({id:'second',type:'rh-image',position:{x:400,y:0},data:{modelCode:'model',params:{prompt:''},status:'idle'}});const second=document.createElement('div');second.className='react-flow__node';second.setAttribute('data-id','second');second.innerHTML='<div class="generate-btn-container"><button class="generate-action-button" aria-label="开始生成">开始生成</button></div>';document.querySelector('.react-flow')!.append(second);f.change();await settle();
 const visible=()=>[...document.querySelectorAll<HTMLElement>('.studio-generation-readiness')].filter(note=>!note.hidden);expect(document.querySelectorAll('.studio-generation-readiness')).toHaveLength(2);expect(visible()).toHaveLength(0);f.button.focus();expect(visible()).toHaveLength(1);const button=second.querySelector<HTMLButtonElement>('button')!;button.focus();await settle();expect(visible()).toHaveLength(1);expect(visible()[0].textContent).toContain('第二个节点');expect(button.getAttribute('aria-describedby')).toBe(visible()[0].id);expect(f.nativeAction).not.toHaveBeenCalled();
});
it('collapses and expands the issue body from its header without invoking native generation',async()=>{
 vi.useFakeTimers();const onClick=vi.fn(),action={currentModel:{config:[]},params:{prompt:''},onClick},f=fixture(async()=>blocked,()=>[action]);await settle();const note=document.querySelector<HTMLElement>('.studio-generation-readiness')!,toggle=note.querySelector<HTMLButtonElement>('.studio-generation-readiness__toggle')!,body=note.querySelector<HTMLElement>('.studio-generation-readiness__body')!;
 expect(body.hidden).toBe(true);expect(note.hidden).toBe(true);f.button.focus();toggle.click();expect(toggle.closest('.studio-generation-readiness__header')).not.toBeNull();expect(toggle.getAttribute('aria-controls')).toBe(body.id);expect(toggle.getAttribute('aria-expanded')).toBe('true');expect(body.hidden).toBe(false);toggle.click();expect(body.hidden).toBe(true);expect(toggle.getAttribute('aria-expanded')).toBe('false');expect(toggle.textContent).toBe('详情');expect(note.hidden).toBe(false);toggle.click();expect(body.hidden).toBe(false);expect(toggle.getAttribute('aria-expanded')).toBe('true');expect(toggle.textContent).toBe('收起');await settle();expect(onClick).not.toHaveBeenCalled();expect(f.nativeAction).not.toHaveBeenCalled();expect(f.runtime.execution.inspectGeneration).toHaveBeenCalledTimes(1);expect(f.runtime.execution.reportGenerationReadinessFailure).not.toHaveBeenCalled();
});
it('collapses a focused issue on Escape and returns focus to its toggle',async()=>{
 vi.useFakeTimers();const f=fixture(async()=>blocked);await settle();const note=document.querySelector<HTMLElement>('.studio-generation-readiness')!,toggle=note.querySelector<HTMLButtonElement>('.studio-generation-readiness__toggle')!,body=note.querySelector<HTMLElement>('.studio-generation-readiness__body')!,issue=note.querySelector<HTMLButtonElement>('.studio-generation-readiness__issue')!;f.button.focus();toggle.click();issue.focus();expect(document.activeElement).toBe(issue);const escape=new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true});expect(issue.dispatchEvent(escape)).toBe(false);expect(escape.defaultPrevented).toBe(true);expect(body.hidden).toBe(true);expect(toggle.getAttribute('aria-expanded')).toBe('false');expect(document.activeElement).toBe(toggle);await settle();expect(f.nativeAction).not.toHaveBeenCalled();expect(f.setSelectedNodeIds).not.toHaveBeenCalled();expect(f.runtime.execution.reportGenerationReadinessFailure).not.toHaveBeenCalled();
});
it('leaves Escape outside the readiness portal available to the focused control',async()=>{
 vi.useFakeTimers();const f=fixture(async()=>blocked);await settle();const note=document.querySelector<HTMLElement>('.studio-generation-readiness')!,toggle=note.querySelector<HTMLButtonElement>('.studio-generation-readiness__toggle')!,body=note.querySelector<HTMLElement>('.studio-generation-readiness__body')!,outside=document.createElement('input'),onKeyDown=vi.fn();outside.addEventListener('keydown',onKeyDown);document.body.append(outside);f.button.focus();toggle.click();outside.focus();const escape=new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true});expect(outside.dispatchEvent(escape)).toBe(true);expect(escape.defaultPrevented).toBe(false);expect(onKeyDown).toHaveBeenCalledOnce();expect(document.activeElement).toBe(outside);expect(body.hidden).toBe(false);expect(toggle.getAttribute('aria-expanded')).toBe('true');expect(f.nativeAction).not.toHaveBeenCalled();
});
it('starts compact when an expanded native panel leaves too little room, and expands only on request',async()=>{
 vi.useFakeTimers();const f=fixture(async()=>blocked);await settle();const host=f.button.parentElement!,note=document.querySelector<HTMLElement>('.studio-generation-readiness')!,body=note.querySelector<HTMLElement>('.studio-generation-readiness__body')!,header=note.querySelector<HTMLElement>('.studio-generation-readiness__header')!,toggle=note.querySelector<HTMLButtonElement>('.studio-generation-readiness__toggle')!;
 host.classList.add('config-panel-modal-content');vi.spyOn(host,'getBoundingClientRect').mockReturnValue(new DOMRect(12,40,window.innerWidth-24,window.innerHeight-80));vi.spyOn(body,'scrollHeight','get').mockImplementation(()=>body.hidden?0:300);vi.spyOn(header,'offsetHeight','get').mockReturnValue(56);await settle();expect(body.hidden).toBe(true);expect(toggle.getAttribute('aria-expanded')).toBe('false');toggle.click();await settle();expect(body.hidden).toBe(false);expect(toggle.getAttribute('aria-expanded')).toBe('true');expect(f.nativeAction).not.toHaveBeenCalled();expect(f.button.getAttribute('aria-disabled')).toBe('true');
});
it('does not repeat layout reads over sixty idle animation frames',async()=>{
 vi.useFakeTimers();const frames=animationFrames(),f=fixture(async()=>blocked);await settle();frames.run();await settle();frames.run();const rect=vi.spyOn(f.button,'getBoundingClientRect'),read=vi.spyOn(f.manager,'getRemoteData');rect.mockClear();read.mockClear();for(let frame=0;frame<60;frame++)frames.run();expect(frames.pending.size).toBe(0);expect(rect).not.toHaveBeenCalled();expect(read).not.toHaveBeenCalled();expect(f.runtime.execution.inspectGeneration).toHaveBeenCalledTimes(1);expect(document.querySelector<HTMLElement>('.studio-generation-readiness')!.hidden).toBe(true);
});
it('ignores unrelated body animation styles and classes without rebuilding the generation graph',async()=>{
 vi.useFakeTimers();const frames=animationFrames(),f=fixture(async()=>blocked),unrelated=document.createElement('div');document.body.append(unrelated);await settle();frames.run();const read=vi.spyOn(f.manager,'getRemoteData');read.mockClear();for(let frame=0;frame<60;frame++){unrelated.style.transform=`translateX(${frame}px)`;unrelated.className='decorative-frame-'+frame;await vi.advanceTimersByTimeAsync(0);frames.run();}expect(read).not.toHaveBeenCalled();expect(frames.pending.size).toBe(0);expect(f.runtime.execution.inspectGeneration).toHaveBeenCalledTimes(1);
});
it('repositions the portal after a canvas pan without refreshing or inspecting the graph',async()=>{
 vi.useFakeTimers();const frames=animationFrames(),f=fixture(async()=>blocked),viewport=document.createElement('div');viewport.className='react-flow__viewport';f.button.closest('.react-flow')!.append(viewport);viewport.append(f.button.closest('.react-flow__node')!);let offset=0;vi.spyOn(f.button.parentElement!,'getBoundingClientRect').mockImplementation(()=>new DOMRect(100+offset,100,320,36));await settle();f.button.focus();frames.run();const note=document.querySelector<HTMLElement>('.studio-generation-readiness')!,before=note.style.left,read=vi.spyOn(f.manager,'getRemoteData');read.mockClear();offset=100;viewport.style.transform='translate(100px,0)';await settle();expect(frames.pending.size).toBe(1);frames.run();expect(note.style.left).not.toBe(before);expect(read).not.toHaveBeenCalled();expect(f.runtime.execution.inspectGeneration).toHaveBeenCalledTimes(1);expect(frames.pending.size).toBe(0);
});
it('coalesces resize and scroll layout work and disconnects all geometry observers on disposal',async()=>{
 vi.useFakeTimers();const frames=animationFrames(),observed:Element[]=[],unobserve=vi.fn(),disconnect=vi.fn();let resized!:ResizeObserverCallback;vi.spyOn(window,'ResizeObserver').mockImplementation(class {constructor(callback:ResizeObserverCallback){resized=callback;}observe=(element:Element)=>{observed.push(element);};unobserve=unobserve;disconnect=disconnect;});
 const f=fixture(async()=>blocked);let offset=0;vi.spyOn(f.button.parentElement!,'getBoundingClientRect').mockImplementation(()=>new DOMRect(100+offset,100,320,36));await settle();f.button.focus();frames.run();const note=document.querySelector<HTMLElement>('.studio-generation-readiness')!,before=note.style.left,read=vi.spyOn(f.manager,'getRemoteData');read.mockClear();expect(observed).toContain(f.button);expect(observed).toContain(note);expect(observed).toContain(f.button.closest('.react-flow__node'));offset=50;window.dispatchEvent(new Event('resize'));f.button.parentElement!.dispatchEvent(new Event('scroll'));resized([],{} as ResizeObserver);expect(frames.pending.size).toBe(1);frames.run();expect(note.style.left).not.toBe(before);expect(read).not.toHaveBeenCalled();window.dispatchEvent(new Event('resize'));expect(frames.pending.size).toBe(1);const calls=disconnect.mock.calls.length;dispose?.();dispose=undefined;expect(disconnect).toHaveBeenCalledTimes(calls+1);expect(frames.pending.size).toBe(0);window.dispatchEvent(new Event('resize'));f.button.parentElement!.dispatchEvent(new Event('scroll'));resized([],{} as ResizeObserver);f.button.closest<HTMLElement>('.react-flow__node')!.style.display='none';await settle();expect(frames.pending.size).toBe(0);expect(read).not.toHaveBeenCalled();expect(document.querySelector('.studio-generation-readiness')).toBeNull();
});
it.each(['display','visibility','hidden','aria-hidden','class','body-class'])('refreshes a changed %s ancestor without a manager notification and inspects its newly visible form',async mode=>{
 vi.useFakeTimers();const action={currentModel:{config:[{paramName:'prompt'}]},params:{prompt:''},onClick:vi.fn()},f=fixture(async(_project:any,_ids:any,candidate:any)=>candidate.nodes[0].data.params.prompt?ready:blocked,()=>[action]),ancestor=mode==='body-class'?document.body:f.button.closest<HTMLElement>('.react-flow__node')!;const css=document.createElement('style');css.setAttribute('data-readiness-test-style','');css.textContent='.readiness-test-hidden{display:none}';document.head.append(css);await settle();expect(f.button.getAttribute('data-studio-generation-blocked')).toBe('blocked');if(mode==='display')ancestor.style.display='none';if(mode==='visibility')ancestor.style.visibility='hidden';if(mode==='hidden')ancestor.hidden=true;if(mode==='aria-hidden')ancestor.setAttribute('aria-hidden','true');if(mode==='class'||mode==='body-class')ancestor.classList.add('readiness-test-hidden');await settle();expect(f.button.hasAttribute('data-studio-generation-blocked')).toBe(false);expect(document.querySelector('.studio-generation-readiness')).toBeNull();action.params.prompt='Corrected while hidden';ancestor.removeAttribute('style');ancestor.hidden=false;ancestor.removeAttribute('aria-hidden');ancestor.classList.remove('readiness-test-hidden');await settle();expect(f.runtime.execution.inspectGeneration).toHaveBeenCalledTimes(2);expect(f.runtime.execution.inspectGeneration.mock.calls[1][2].nodes[0].data.params.prompt).toBe('Corrected while hidden');expect(f.button.hasAttribute('data-studio-generation-blocked')).toBe(false);expect(f.nativeAction).not.toHaveBeenCalled();
});
it('refreshes a native model control text update with new uncommitted parameters',async()=>{
 vi.useFakeTimers();const action={currentModel:{config:[{paramName:'outputPreset'}]},params:{outputPreset:'invalid'},onClick:vi.fn()},f=fixture(async(_project:any,_ids:any,candidate:any)=>candidate.nodes[0].data.params.outputPreset==='supported'?ready:blocked,()=>[action]),label=document.createElement('span');label.textContent='无效规格';f.button.parentElement!.append(label);await settle();expect(f.button.getAttribute('data-studio-generation-blocked')).toBe('blocked');action.params.outputPreset='supported';label.firstChild!.textContent='支持的规格';await settle();expect(f.runtime.execution.inspectGeneration).toHaveBeenCalledTimes(2);expect(f.button.hasAttribute('data-studio-generation-blocked')).toBe(false);expect(f.nativeAction).not.toHaveBeenCalled();
});

it('invalidates admission when disconnect and reconnect change the order of frame inputs',()=>{
 const graph:any={nodes:[{id:'a',type:'rh-image'},{id:'b',type:'rh-image'},{id:'v',type:'rh-video'}],edges:[{source:'b',target:'v'},{source:'a',target:'v'}]},before=generationReadinessSignature(graph,['v']);graph.edges.reverse();expect(generationReadinessSignature(graph,['v'])).not.toBe(before);
});
it('lets a source toolbar create and preflight its separate result rather than running an uploaded image as an empty group',async()=>{
 vi.useFakeTimers();const f=fixture();f.graph.nodes[0].data={isUpload:true,sourceObjects:['rhtv-asset:owned']};
 const bar=f.button.parentElement!;bar.className='sb-master-bar';bar.setAttribute('data-rh-storyboard-bar','true');f.change();await settle();
 expect(f.button.hasAttribute('data-studio-generation-blocked')).toBe(false);expect(f.runtime.execution.inspectGeneration).not.toHaveBeenCalled();f.button.click();expect(f.nativeAction).toHaveBeenCalledOnce();
});


// Exercise the frozen four-cell crop and group constructors. Stub the bitmap,
// upload and editor manager only; the node types, fields and memberships are native.
async function createFourCellGroup(graph:any){
 const source=readFileSync(new FileURL('../../apps/web/public/project/assets/index-DeyN_Phq.js',import.meta.url),'utf8');
 function section(from:string,to:string){
  const start=source.indexOf(from),end=source.indexOf(to,start+from.length);
  if(start<0||end<0)throw Error('Native grid crop seam changed: '+from);
  return source.slice(start,end);
 }
 const operations={
  addNode:(node:any)=>graph.nodes.push(node),
  patchNodeData:(id:string,data:any)=>Object.assign(graph.nodes.find((n:any)=>n.id===id).data,data),
  setRemoteSyncPaused:()=>{},
 };
 let uploads=0;
 const editor=runInNewContext(section('function XCr(','function JCr(')+section('function BEr(','function HEr(')+'; $Er',{
  Image:class {naturalWidth=400;naturalHeight=400;onload=()=>{};set src(_url:string){this.onload();}},
  document:{createElement:()=>({getContext:()=>({drawImage:()=>{}}),toDataURL:()=>'data:image/png;base64,AA=='})},
  File,FEr:()=>new Uint8Array(1),ri:async()=>'rhtv-asset:crop-'+(++uploads),
  mS:()=>({w:320,h:320}),jEr:()=>'1:1',GL:(fn:()=>unknown)=>fn(),Ln:()=>operations,
  du:{x:16,y:16},Rte:10,pV:{bg:'#333',border:'#555'},queueMicrotask,
  ir:(key:string,values:any)=>key.endsWith('gridCropN')?'4宫格裁剪':'裁剪 '+values.row+'-'+values.col,
  Ie:{error:(why:unknown)=>{throw Error(String(why));}},sn:{t:(key:string)=>key},
 });
 expect(await editor(graph,graph.nodes[0],'fixture://source',{count:4,rows:2,cols:2},'crop-only')).toBe(true);
 expect(uploads).toBe(4);
 return graph.nodes.find((n:any)=>n.type==='group');
}

it('keeps newly cropped media accessible and silently disables only Run until the group contains a generator',async()=>{
 vi.useFakeTimers();
 const f=fixture(async()=>ready);
 const group=await createFourCellGroup(f.graph);
 const wrapper=f.button.closest<HTMLElement>('.react-flow__node')!;
 wrapper.dataset.id=group.id;wrapper.classList.add('group-toolbar');
 f.button.className='execute-btn';f.button.title='整组执行';
 f.change();await settle();

 function expectMediaOnly(){
  expect(f.button.getAttribute('aria-disabled')).toBe('true');
  expect(f.button.title).toContain('添加可生成的内容节点');
  expect(f.button.hasAttribute('aria-describedby')).toBe(false);
  expect(document.querySelector('.studio-generation-readiness')).toBeNull();
 }
 expectMediaOnly();
 group.data.groupName='我选出的三张图';
 const detached=group.data.nodeIds.splice(1,1)[0];
 delete f.graph.nodes.find((node:any)=>node.id===detached).data.groupId;
 f.change();await settle();
 expectMediaOnly();
 f.button.focus();
 f.button.click();
 f.button.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
 await settle();
 expect(f.nativeAction).not.toHaveBeenCalled();expect(f.notice).not.toHaveBeenCalled();
 expect(f.runtime.execution.inspectGeneration).not.toHaveBeenCalled();
 expect(f.runtime.execution.reportGenerationReadinessFailure).not.toHaveBeenCalled();
 // Other toolbar and node gestures continue to their native handlers.
 const ungroup=document.createElement('button');ungroup.textContent='解组';wrapper.append(ungroup);
 const nativeUngroup=vi.fn();ungroup.addEventListener('click',nativeUngroup);ungroup.click();expect(nativeUngroup).toHaveBeenCalledOnce();
 const member=document.createElement('div');member.className='react-flow__node';member.dataset.id=group.data.nodeIds[0];
 document.querySelector('.react-flow')!.append(member);
 const nativeDrag=vi.fn();member.addEventListener('pointerdown',nativeDrag);
 expect(member.dispatchEvent(new Event('pointerdown',{bubbles:true,cancelable:true}))).toBe(true);
 expect(nativeDrag).toHaveBeenCalledOnce();

 group.data.nodeIds.push('target');f.graph.nodes[0].data.groupId=group.id;
 f.change();await settle();
 expect(f.runtime.execution.inspectGeneration.mock.calls.at(-1)![1]).toEqual([group.id]);
 expect(f.button.hasAttribute('aria-disabled')).toBe(false);expect(f.button.title).toBe('整组执行');
 f.button.click();await settle();expect(f.nativeAction).toHaveBeenCalledOnce();

 group.data.nodeIds.length=0;delete f.graph.nodes[0].data.groupId;
 f.change();await settle();expectMediaOnly();
 dispose?.();dispose=undefined;
 expect(f.button.title).toBe('整组执行');expect(f.button.hasAttribute('aria-disabled')).toBe(false);
});


it.each(['GENERATE','RETRY','SHORTCUT'])('binds a %s activation to exactly one matching native run with button state at the click',async control=>{
 vi.useFakeTimers();const f=fixture(async()=>ready);
 if(control==='RETRY')f.button.className='rh-node-fail-overlay__btn--retry';
 await settle();const take=f.runtime.execution.setNativeSubmitIntent.mock.calls[0][0];
 expect(take('project','target','NODE')).toBeUndefined();
 if(control==='SHORTCUT')f.button.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
 else f.button.click();
 await settle();expect(f.nativeAction).toHaveBeenCalledOnce();
 expect(take('project','other','NODE')).toBeUndefined();
 const label=take('project','target','NODE');
 expect(label).toMatchObject({control,click:{visible:true,disabled:false}});
 expect(take('project','target','NODE')).toBeUndefined();
});
it('discards an orphaned replay label when another gesture starts or the page is detached',async()=>{
 vi.useFakeTimers();const f=fixture(async()=>ready),take=f.runtime.execution.setNativeSubmitIntent.mock.calls[0][0];await settle();
 f.button.click();await settle();document.body.dispatchEvent(new Event('pointerdown',{bubbles:true}));expect(take('project','target','NODE')).toBeUndefined();
 f.button.click();await settle();f.switch();await settle();expect(take('project','target','NODE')).toBeUndefined();
});
