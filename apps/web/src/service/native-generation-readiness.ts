import {observeSnapshotDom,type SnapshotIntent} from './canvas-failure-snapshot';
import {newResultTool} from './node-tool-contract';
import {ApiError} from '../api/client';
import type {NativeGraph} from './graph';
import type {Capability} from './model-catalog';
import {generationReadinessNodeIds,inspectCanvasConnection,nodeReadinessMaterials,type CanvasConnection} from './connection-readiness';
import {h3LongformModeEvent,h3LongformOwnsGeneration} from './h3-longform-mode';

import type {GenerationReadiness} from './generation-readiness';
export type {GenerationReadiness,GenerationReadinessIssue} from './generation-readiness';
const transient=new Set(['selected','dragging','width','height','progress','progressDetail','taskId','estimateTaskId','errorMsg','generationStartedAt','estimatedSeconds','status']);
/** Selection, pointer movement, node geometry and job progress do not change
 * readiness. Actual reference/history/model/form changes always do. */
export function generationReadinessSignature(graph:NativeGraph,ids:readonly string[]):string{
 const related=new Set(ids);
 for(let pass=0;pass<graph.nodes.length;pass++){let changed=false;for(const node of graph.nodes){
  if((related.has(node.parentId as string)||related.has(node.parentNode as string))&&!related.has(node.id)){related.add(node.id);changed=true;}
  if(related.has(node.id)&&['group','rh-group'].includes(node.type))for(const child of Array.isArray(node.data?.nodeIds)?node.data.nodeIds:[])if(typeof child==='string'&&!related.has(child)){related.add(child);changed=true;}
 }if(!changed)break;}
 for(let pass=0;pass<graph.nodes.length;pass++){let changed=false;for(const edge of graph.edges)if(related.has(edge.target)&&!related.has(edge.source)){related.add(edge.source);changed=true;}if(!changed)break;}
 return JSON.stringify({ids:[...ids].sort(),nodes:graph.nodes.filter(node=>related.has(node.id)).map(node=>({id:node.id,type:node.type,parentId:node.parentId,parentNode:node.parentNode,data:Object.fromEntries(Object.entries(node.data??{}).filter(([key])=>!transient.has(key))),uploading:node.data?.status==='uploading'||node.data?.uploading===true,busy:['running','processing'].includes(node.data?.status)})).sort((a,b)=>a.id.localeCompare(b.id)),edges:graph.edges.filter(edge=>related.has(edge.target)).map(edge=>({source:edge.source,target:edge.target,sourceHandle:edge.sourceHandle??null,targetHandle:edge.targetHandle??null,conditioningRole:edge.conditioningRole??null}))});
}
const visibleInputKeys=new Set(['prompt','text','imageUrl','imageUrls','videoUrl','videoUrls','audioUrl','audioUrls','firstImageUrl','lastImageUrl','firstFrameUrl','lastFrameUrl']);
const selectionKeys=new Set(['rhModel','modelCode','capabilityRef','capabilityVersion','parameterSchemaVersion','model','modelId']);
/** The native form can keep its latest controls in React until submit. Inspect
 * a per-button candidate without flushing or changing the mounted canvas. */
export function nativeGenerationCandidateGraph(graph:NativeGraph,targetId:string,action:any,caps:readonly Capability[]=[]):NativeGraph{
 const node=graph.nodes.find(node=>node.id===targetId);if(!node||node.type==='group'||!action?.currentModel||!action.params||typeof action.params!=='object'||Array.isArray(action.params))return graph;
 const data=node.data??{},ref=data.capabilityRef??data.modelCode,version=data.capabilityVersion;
 // A brand-new native form displays its default before it writes modelCode.
 // Inspect that exact advertised selection, including an unavailable default;
 // do not silently pick another model or let hidden params replace a saved one.
 const visibleModel=action.currentModel,visibleRef=visibleModel.capabilityRef??visibleModel.modelCode,visibleVersion=visibleModel.capabilityVersion;
 const selected=caps.find(cap=>cap.capabilityRef===(ref??visibleRef)&&((version??(!ref?visibleVersion:undefined))===undefined||cap.version===(version??visibleVersion))),cap=selected;
 const defaults=!ref&&selected&&visibleVersion===selected.version?{modelCode:selected.capabilityRef,capabilityRef:selected.capabilityRef,capabilityVersion:selected.version,parameterSchemaVersion:selected.parameterSchemaVersion}:{};
 const allowed=new Set([...visibleInputKeys,...Object.keys(cap?.parameterSchema?.properties??{}),...(action.currentModel.config??[]).map((field:any)=>field?.paramName).filter((key:any)=>typeof key==='string')]);
 const params={...data.params};for(const [key,value]of Object.entries(action.params))if(allowed.has(key)&&!selectionKeys.has(key))params[key]=structuredClone(value);
 const quantity=Object.hasOwn(action,'generateNum')&&action.generateNum!==undefined?action.generateNum:Object.hasOwn(action.params,'generateNum')?action.params.generateNum:undefined;
 const candidate={...node,data:{...data,...defaults,params,...(quantity!==undefined?{generateNum:structuredClone(quantity)}:{})}};
 return{...graph,nodes:graph.nodes.map(value=>value.id===targetId?candidate:value)};
}
interface ButtonContext {button:HTMLButtonElement;target:string;ids:string[];candidate:NativeGraph;group:boolean;key?:string}
interface InspectionState {ids:string[];pending:boolean;sequence:number;retries?:number;result?:GenerationReadiness;timer?:ReturnType<typeof setTimeout>}
interface Mark {note:HTMLElement;collapsed:boolean;userExpanded:boolean}
type SavedAttributes = Map<string, {before:string|null; written:string}>;
interface ReadinessRect {left:number;top:number;right:number;bottom:number;width:number;height:number}
const transientCheckCodes=new Set(['GENERATION_CHECK_UNAVAILABLE','PREFLIGHT_UNAVAILABLE','INVALID_RESPONSE','NETWORK_ERROR','REQUEST_TIMEOUT','LOCAL_DRAFT_CONFLICT','STALE_CANVAS_SESSION','CANVAS_REQUIRED']);
const transientCheck=(answer:GenerationReadiness)=>answer.issues.some(issue=>issue.retryable===true||transientCheckCodes.has(issue.code));
/** Keep the explanation outside the native panel's fixed-height controls and
 * inside the viewport. Side placements are useful for expanded parameter panes. */
export function generationReadinessPlacement(anchor:ReadinessRect,viewport:{width:number;height:number},contentHeight:number){
 const margin=12,gap=10,width=Math.min(360,Math.max(0,viewport.width-2*margin)),height=Math.min(300,Math.max(60,contentHeight)),bottom=viewport.height-margin;
 const clamp=(value:number,min:number,max:number)=>Math.max(min,Math.min(value,max));
 const left=clamp(anchor.right-width,margin,viewport.width-margin-width),top=clamp(anchor.top,margin,bottom-height);
 const candidates=[
  {left,top:Math.max(margin,anchor.bottom+gap),width,maxHeight:bottom-Math.max(margin,anchor.bottom+gap)},
  {left,top:margin,width,maxHeight:Math.min(bottom,anchor.top-gap)-margin,above:true},
  {left:Math.max(margin,anchor.right+gap),top,width:Math.min(width,viewport.width-margin-anchor.right-gap),maxHeight:bottom-top},
  {left:margin,top,width:Math.min(width,anchor.left-gap-margin),maxHeight:bottom-top,leftSide:true}
 ].filter(item=>item.width>=Math.min(240,width)&&item.maxHeight>=60);
 const best=candidates.find(item=>item.maxHeight>=height)??candidates.sort((a,b)=>b.width*Math.min(height,b.maxHeight)-a.width*Math.min(height,a.maxHeight))[0];
 if(!best)return;
 const maxHeight=Math.min(300,best.maxHeight),actualHeight=Math.min(height,maxHeight);
 return{left:best.leftSide?anchor.left-gap-best.width:best.left,top:best.above?anchor.top-gap-actualHeight:best.top,width:best.width,maxHeight};
}
/** Owns only transient UI and local-event guards. The inspector is shared with
 * submit and remains the sole authority for complete input requirements. */
export function installNativeGenerationReadiness(runtime:any,native:any,notice:(message:string)=>void,propsOf:(element:Element)=>any[],root:Document=document):()=>void{
 const view=root.defaultView;if(!view||typeof runtime.execution?.inspectGeneration!=='function')return()=>{};
 const states=new Map<string,InspectionState>();
 const buttonAttrs = new Map<HTMLButtonElement, SavedAttributes>();
 const marks=new Map<HTMLButtonElement,Mark>(),restorers:(()=>void)[]=[],inflight=new WeakSet<HTMLButtonElement>(),cache=new Map<string,GenerationReadiness>();
 const style=root.createElement('style');style.textContent=nativeGenerationReadinessStyles;root.head.append(style);
 const connectionHint=root.createElement('div');connectionHint.className='studio-connection-readiness';connectionHint.setAttribute('role','status');connectionHint.hidden=true;root.body.append(connectionHint);
 let disposed=false,scheduled=false,manager:any=null,project='',user='',releaseGraph:(()=>void)|undefined,request=0,replay=false,contexts:ButtonContext[]=[],lastRejected:{reason:string;at:number}|undefined,activeButton:HTMLButtonElement|null=null,layoutFrame:number|undefined,hideTimer:ReturnType<typeof setTimeout>|undefined;
 const buttonSelector='.generate-action-button,.rh-node-fail-overlay__btn--retry,.group-toolbar .execute-btn',panelSelector='.config-panel-wrap,.config-panel-modal-content,.ce-node-toolbar,.rh-params-card,.group-toolbar,.rh-node-fail-overlay,.generate-btn-container,.rh-canvas-compact-input-panel';
 const layoutElements=new Set<Element>(),controlVisibility=new WeakMap<HTMLElement,boolean>();let resizeObserver:ResizeObserver|undefined;
 const identity=()=>String(runtime.auth?.user?.id??''),attachment=()=>runtime.canvasAttachment?.(),managerNow=()=>attachment()?.client??native.bt?.(),projectNow=()=>String(attachment()?.id??runtime.inspect?.().id??'');
 const current=()=>!disposed&&!!user&&identity()===user&&managerNow()===manager&&projectNow()===project;
 const graph=():NativeGraph|undefined=>{const value=manager?.getRemoteData?.();return value?(runtime.storage?.restoreModelBindings?.(project,value)??value):undefined;};
 const capabilities=()=>runtime.execution.getGenerationCapabilities?.()??[];
 const encode=(value:string)=>runtime.storage?.encodeAsset?.(value)??value;
 const visible=(element:HTMLElement)=>{let shown=element.isConnected;for(let current:HTMLElement|null=element;shown&&current;current=current.parentElement){const style=view.getComputedStyle(current);if(current.hidden||current.getAttribute('aria-hidden')==='true'||style.display==='none'||style.visibility==='hidden'||style.visibility==='collapse')shown=false;}if(shown){const rect=element.getBoundingClientRect();shown=rect.width>0&&rect.height>0;}if(element.matches(buttonSelector))controlVisibility.set(element,shown);return shown;};
 const setButtonAttributes=(button:HTMLButtonElement, values:Record<string,string>)=>{
  let saved=buttonAttrs.get(button);
  if(!saved){saved=new Map();buttonAttrs.set(button,saved);}
  for(const [name,value] of Object.entries(values)){
   const prior=saved.get(name),now=button.getAttribute(name);
   if(!prior||now!==prior.written)saved.set(name,{before:now,written:value});
   else prior.written=value;
   if(now!==value)button.setAttribute(name,value);
  }
 };
 const restore=(button:HTMLButtonElement)=>{
  for(const [key,value] of buttonAttrs.get(button)??[]){
   if(button.getAttribute(key)!==value.written)continue;
   if(value.before===null)button.removeAttribute(key);
   else button.setAttribute(key,value.before);
  }
  buttonAttrs.delete(button);marks.get(button)?.note.remove();marks.delete(button);
  if(activeButton===button)activeButton=null;
 };
 const clickIntents=new Map<string,{at:number;project:string;manager:any;user:string;intent:SnapshotIntent}>();
 const clear=()=>{clickIntents.clear();if(hideTimer)clearTimeout(hideTimer);hideTimer=undefined;if(layoutFrame!==undefined)view.cancelAnimationFrame(layoutFrame);layoutFrame=undefined;resizeObserver?.disconnect();layoutElements.clear();for(const button of [...buttonAttrs.keys()])restore(button);for(const state of states.values())if(state.timer)clearTimeout(state.timer);states.clear();contexts=[];cache.clear();request++;connectionHint.hidden=true;};
 const anchorFor=(button:HTMLButtonElement)=>button.closest<HTMLElement>('.config-panel-modal-content,.config-panel-wrap,.group-toolbar,.rh-node-fail-overlay')??button.parentElement??button;
 const positionNotes=()=>{
  if(!current())return;const available=contexts.filter(context=>marks.has(context.button)&&visible(context.button)).filter(context=>{const rect=context.button.getBoundingClientRect();return rect.bottom>0&&rect.right>0&&rect.top<view.innerHeight&&rect.left<view.innerWidth;});
  // Passive validation controls submission, but selecting or editing a node is
  // not an attempt to run it. Only an intentional encounter with Run reveals
  // its compact explanation; details require an explicit action.
  const context=available.find(context=>context.button===activeButton);
  for(const [button,mark]of marks)mark.note.hidden=button!==context?.button;
  if(!context)return;const mark=marks.get(context.button)!,note=mark.note,anchor=anchorFor(context.button),viewport={width:view.innerWidth,height:view.innerHeight};
  const theme=view.getComputedStyle(anchor);for(const key of ['--canvas-bg-secondary','--canvas-text-primary','--canvas-text-secondary','--canvas-border-strong','--canvas-border-subtle','--canvas-control-hover-neutral']){const value=theme.getPropertyValue(key).trim();if(value&&note.style.getPropertyValue(key)!==value)note.style.setProperty(key,value);}
  const width=Math.min(360,Math.max(0,viewport.width-24))+'px';if(note.style.width!==width)note.style.width=width;
  const body=note.querySelector<HTMLElement>('.studio-generation-readiness__body'),height=Math.min(300,(note.firstElementChild as HTMLElement)?.offsetHeight+(body&&!body.hidden?body.scrollHeight:0)+2||60),outer=generationReadinessPlacement(anchor.getBoundingClientRect(),viewport,height),controls=context.button.closest<HTMLElement>('.rh-image-params-config-row,.config-row,.llm-controls,.audio-config-row')??context.button;
  if(!mark.collapsed&&!mark.userExpanded&&(!outer||outer.maxHeight<Math.min(height,120))){const body=note.querySelector<HTMLElement>('.studio-generation-readiness__body'),toggle=note.querySelector<HTMLButtonElement>('.studio-generation-readiness__toggle');if(body&&toggle){mark.collapsed=true;body.hidden=true;toggle.textContent='详情';toggle.setAttribute('aria-expanded','false');positionNotes();return;}}
  // A nearly full-screen expanded panel may leave only a header-sized gap.
  // In that case keep details clear of its action row; they remain collapsible.
  const placement=outer&&outer.maxHeight>=Math.min(height,120)?outer:generationReadinessPlacement(controls.getBoundingClientRect(),viewport,height)??outer;
  if(!placement){note.hidden=true;return;}for(const [key,value]of Object.entries(placement))if(note.style[key as 'left']!==value+'px')note.style[key as 'left']=value+'px';
 };
 // Layout follows actual geometry changes. An idle blocked button must not
 // keep scanning every mounted control and its ancestors on every frame.
 const queueLayout=()=>{if(layoutFrame===undefined&&marks.size&&!disposed)layoutFrame=view.requestAnimationFrame(()=>{layoutFrame=undefined;positionNotes();});};
 resizeObserver=typeof view.ResizeObserver==='function'?new view.ResizeObserver(entries=>{if(disposed)return;queueLayout();if(entries.some(entry=>entry.target.matches(buttonSelector)&&contexts.some(context=>context.button===entry.target)!==visible(entry.target as HTMLElement)))schedule();}):undefined;
 const observeLayout=()=>{
  if(!resizeObserver)return;const next=new Set<Element>(root.querySelectorAll(buttonSelector));for(const context of contexts){next.add(anchorFor(context.button));const node=context.button.closest('.react-flow__node');if(node)next.add(node);}for(const mark of marks.values())next.add(mark.note);
  for(const element of layoutElements)if(!next.has(element)){resizeObserver.unobserve(element);layoutElements.delete(element);}for(const element of next)if(!layoutElements.has(element)){resizeObserver.observe(element);layoutElements.add(element);}
 };
 const buttonTarget=(button:HTMLButtonElement,value:NativeGraph)=>{const direct=button.closest('[data-target-node-id],[data-node-id],.react-flow__node[data-id]');return direct?.getAttribute('data-target-node-id')??direct?.getAttribute('data-node-id')??direct?.getAttribute('data-id')??propsOf(button).map(prop=>prop.groupNode?.id??prop.targetNode?.id??prop.node?.id??prop.nodeId??prop.groupId).find(id=>typeof id==='string'&&value.nodes.some(node=>node.id===id));};
 const isLongformTarget=(target:string|undefined,value:NativeGraph)=>{const node=value.nodes.find(node=>node.id===target);return node?.type==='rh-video'&&!!target&&(h3LongformOwnsGeneration(root,project,target)||!!node.data?.studioLongformActiveJobId);};
 const buttonContext=(button:HTMLButtonElement,value:NativeGraph):ButtonContext|undefined=>{
  if(!visible(button)||newResultTool(button)||button.closest('.home-agent-input-bar')||button.matches('.rh-node-generating-cancel'))return;const props=propsOf(button),action=props.find(prop=>prop.currentModel&&prop.params&&typeof prop.onClick==='function');if(action?.visible===false||action?.isGenerating||/^(?:停止|取消|Stop|Cancel)/i.test(button.getAttribute('aria-label')??button.textContent??''))return;
  const target=buttonTarget(button,value);
  if(!target||!value.nodes.some(node=>node.id===target)||['running','processing','uploading'].includes(value.nodes.find(node=>node.id===target)?.data?.status))return;
  if(isLongformTarget(target,value))return;
  const targetNode=value.nodes.find(node=>node.id===target),group=targetNode?.type==='group'||targetNode?.type==='rh-group';if(group&&(['storyboard','video'].includes(targetNode.data?.groupType)||targetNode.data?.storyboardEntityGroup===true))return;
  const members=generationReadinessNodeIds(value,target);
  return{button,target,group,ids:group&&members.length?[target]:members,candidate:nativeGenerationCandidateGraph(value,target,action,capabilities())};
 };
 const collect=(value:NativeGraph)=>[...root.querySelectorAll<HTMLButtonElement>(buttonSelector)].map(button=>buttonContext(button,value)).filter((value):value is ButtonContext=>!!value);
 const keyFor=(value:NativeGraph,ids:string[],group:boolean)=>{
  const material=nodeReadinessMaterials,targets=[...new Set(ids.flatMap(id=>generationReadinessNodeIds(value,id)))],assets=targets.flatMap(id=>{const node=value.nodes.find(node=>node.id===id);return node?material(node,value,encode):[];}).map(item=>{const asset=item.reference.startsWith('rhtv-asset:')?runtime.storage?.assets?.get(item.reference.slice(11)):undefined;return[item.reference,asset?.state,asset?.byteSize,asset?.durationSeconds,asset?.width,asset?.height];});
  return (group?'group:':'node:')+JSON.stringify([runtime.storage?.access?.(project)?.canRun??null,runtime.storage?.isBlocked?.(project)??false])+'|'+generationReadinessSignature(value,ids)+'|'+JSON.stringify(assets)+'|'+JSON.stringify(capabilities().map((cap:any)=>[cap.capabilityRef,cap.version,cap.available]));
 };
 const locate=(id:string)=>{const state=native.c5?.getState?.();state?.setSelectedNodeIds?.([id]);state?.setExpandedNodeId?.(id);const element=[...root.querySelectorAll<HTMLElement>('.react-flow__node[data-id]')].find(element=>element.getAttribute('data-id')===id);element?.focus({preventScroll:false});};
 const paint=()=>{
  const live=new Set(contexts.map(context=>context.button));for(const button of buttonAttrs.keys())if(!live.has(button)||!button.isConnected)restore(button);
  for(const context of contexts){
   // A material-only group (including a new grid crop) has no operation to
   // inspect. Keep its Run control inert and leave the selected assets exposed.
   if(!context.ids.length){
    if(marks.has(context.button))restore(context.button);
    const reason=context.group?'添加可生成的内容节点后，可整组执行。':'此节点是素材，可连接到生成节点。';
    setButtonAttributes(context.button,{'data-studio-generation-blocked':'unavailable','aria-disabled':'true',title:reason,'aria-description':reason});
    continue;
   }
   if(!marks.has(context.button)&&buttonAttrs.has(context.button))restore(context.button);
   const state=context.key?states.get(context.key):undefined,result=state?.result,issues=result?.issues??[];
   const checking=!result||state?.pending===true,blocked=checking||issues.length>0||result?.status==='blocked';
   if(!blocked){restore(context.button);continue;}
   let mark=marks.get(context.button);
   if(!mark){
    const note=root.createElement('section');note.className='studio-generation-readiness';note.id='studio-generation-readiness-'+Math.random().toString(36).slice(2);note.hidden=true;note.setAttribute('data-studio-generation-readiness','');note.setAttribute('role','status');note.setAttribute('aria-live','polite');
    for(const name of ['pointerdown','mousedown','click','wheel'])note.addEventListener(name,event=>event.stopPropagation());
    mark={note,collapsed:true,userExpanded:false};marks.set(context.button,mark);root.body.append(note);
   }
   const message=checking?'正在准备素材并检查生成条件…':issues[0]?.message??'当前生成条件尚未满足，请检查模型和输入。';
   setButtonAttributes(context.button,{'data-studio-generation-blocked':checking?'checking':'blocked','aria-disabled':'true','aria-describedby':mark.note.id,'aria-description':message});
   const affected=new Set(issues.map(issue=>issue.nodeId)).size;
   const summary=checking?'正在检查生成条件…':affected>1?`${affected} 个节点需要调整`:message;
   const titleText=()=>mark!.collapsed?summary:checking?summary:'生成前请调整输入';
   const signature=message+'|'+issues.map(issue=>issue.nodeId+':'+issue.sourceNodeId+':'+issue.field+':'+issue.message).join('|');
   if(mark.note.getAttribute('data-signature')!==signature){
    mark.note.replaceChildren();mark.note.setAttribute('data-signature',signature);mark.note.dataset.state=checking?'checking':'blocked';
    const header=root.createElement('div');header.className='studio-generation-readiness__header';const title=root.createElement('strong');title.textContent=titleText();header.append(title);mark.note.append(header);
    if(!checking){
     const body=root.createElement('div');body.className='studio-generation-readiness__body';body.id=mark.note.id+'-details';body.hidden=mark.collapsed;
     for(const issue of issues.length?issues:[{message,nodeId:context.target,sourceNodeId:undefined}]){
      const row=root.createElement('div');row.className='studio-generation-readiness__row';const text=root.createElement('p');text.textContent=issue.message;
      const sourceId=issue.sourceNodeId??issue.nodeId,source=context.candidate.nodes.find(node=>node.id===sourceId),sourceName=String(source?.data?.title||source?.data?.label||sourceId);
      const link=root.createElement('button');link.type='button';link.className='studio-generation-readiness__issue';link.textContent=sourceId!==issue.nodeId?'查看参考素材':'查看输入';link.setAttribute('aria-label',`查看“${sourceName}”：${issue.message}`);
      link.addEventListener('click',()=>{mark!.collapsed=true;mark!.userExpanded=false;mark!.note.removeAttribute('data-signature');activeButton=null;paint();locate(sourceId);});row.append(text,link);body.append(row);
     }
     const hint=root.createElement('p');hint.className='studio-generation-readiness__hint';hint.textContent='修改后自动重新检查，无需重新打开节点。';body.append(hint);mark.note.append(body);
     const toggle=root.createElement('button');toggle.type='button';toggle.className='studio-generation-readiness__toggle';toggle.textContent=mark.collapsed?'详情':'收起';toggle.setAttribute('aria-expanded',String(!mark.collapsed));toggle.setAttribute('aria-controls',body.id);
     toggle.addEventListener('click',()=>{mark!.collapsed=!mark!.collapsed;mark!.userExpanded=!mark!.collapsed;body.hidden=mark!.collapsed;toggle.textContent=mark!.collapsed?'详情':'收起';toggle.setAttribute('aria-expanded',String(!mark!.collapsed));title.textContent=titleText();positionNotes();});header.append(toggle);
    }
   }else{
    const title=mark.note.querySelector('strong');if(title)title.textContent=titleText();
   }
  }
  observeLayout();positionNotes();queueLayout();
 };
 const retainAnswer=(value:NativeGraph,ids:string[],key:string,state:InspectionState,group:boolean,answer:GenerationReadiness)=>{
  state.result=answer;state.pending=false;
  if(transientCheck(answer)){
   cache.delete(key);const delay=[1000,2000,5000,10000,15000][Math.min(state.retries??0,4)];state.retries=(state.retries??0)+1;
   if(state.timer)clearTimeout(state.timer);
   state.timer=setTimeout(()=>{state.timer=undefined;if(current()&&states.get(key)===state)void inspect(value,ids,key,state,group);},delay);
  }else{state.retries=0;cache.set(key,answer);if(cache.size>16)cache.delete(cache.keys().next().value!);}
 };
 const inspect=async(value:NativeGraph,ids:string[],key:string,state:InspectionState,group:boolean)=>{
  const ownRequest=request,ownSequence=++state.sequence,ownManager=manager,ownUser=user,ownProject=project;state.pending=true;state.result=undefined;paint();
  const valid=()=>current()&&manager===ownManager&&user===ownUser&&project===ownProject&&ownRequest===request&&states.get(key)===state&&state.sequence===ownSequence;
  try{const answer=await runtime.execution.inspectGeneration(ownProject,ids,structuredClone(value),group);if(!valid())return;
   if(!answer||!['ready','blocked'].includes(answer.status)||!Array.isArray(answer.issues))throw new Error('生成条件检查暂不可用，请重试。');
   const latest=graph();if(!latest||!contexts.some(context=>{if(!context.button.isConnected)return false;const currentContext=buttonContext(context.button,latest);return!!currentContext&&keyFor(currentContext.candidate,currentContext.ids,currentContext.group)===key;})){state.pending=false;schedule();return;}
   retainAnswer(value,ids,key,state,group,answer);paint();return answer as GenerationReadiness;
  }catch(reason){if(valid()){
   const latest=graph();
   // A rejected old request is just as stale as a successful old response.
   if(!latest||!contexts.some(context=>{const fresh=context.button.isConnected&&buttonContext(context.button,latest);return fresh&&keyFor(fresh.candidate,fresh.ids,fresh.group)===key;})){state.pending=false;schedule();return;}
   retainAnswer(value,ids,key,state,group,{status:'blocked',issues:ids.map(nodeId=>({nodeId,code:'GENERATION_CHECK_UNAVAILABLE',message:reason instanceof Error?reason.message:'生成条件检查暂不可用，请重试。'}))});paint();}return;}
 };
 const refresh=()=>{
  scheduled=false;if(disposed)return;const nextManager=managerNow(),nextProject=projectNow(),nextUser=identity();if(manager!==nextManager||project!==nextProject||user!==nextUser){releaseGraph?.();for(const restore of restorers.splice(0).reverse())restore();clear();manager=nextManager;project=nextProject;user=nextUser;releaseGraph=typeof manager?.subscribe==='function'?manager.subscribe(schedule):undefined;if(manager&&user&&project)guardManager(manager);}
  if(!current()){clear();return;}const value=graph();if(!value?.nodes||!value?.edges){clear();return;}contexts=collect(value);
  // Each button describes its own execution plan. Combining visible single
  // nodes would falsely permit future outputs from an unrelated button.
  const active=new Set<string>();for(const context of contexts){if(!context.ids.length)continue;const ids=[...context.ids].sort(),candidate=context.candidate,key=keyFor(candidate,ids,context.group);context.key=key;active.add(key);if(states.has(key))continue;
   const result=cache.get(key),state:InspectionState={ids,pending:!result,sequence:0,...(result?{result}:{})};states.set(key,state);if(!result)state.timer=setTimeout(()=>{state.timer=undefined;if(current()&&states.get(key)===state)void inspect(candidate,ids,key,state,context.group);},180);
  }
  for(const [key,state]of states)if(!active.has(key)){if(state.timer)clearTimeout(state.timer);states.delete(key);}paint();
 };
 function schedule(){if(!disposed&&!scheduled){scheduled=true;queueMicrotask(refresh);}}
 const rejectConnection=(connection:CanvasConnection,value=graph())=>{if(!current()||!value)return;const check=inspectCanvasConnection(connection,value,capabilities(),{assets:runtime.storage?.assets,encodeAsset:encode});if(!check.allowed){lastRejected={reason:check.reason!,at:Date.now()};connectionHint.textContent=check.reason!;connectionHint.hidden=false;return check;}connectionHint.hidden=true;return check;};
 const assertEdge=(edge:any,value?:NativeGraph)=>{const check=rejectConnection(edge,value);if(check&&!check.allowed){notice(check.reason!);throw new ApiError(422,check.code??'CONNECTION_INVALID',check.reason!);}};
 function guardManager(owner:any){
  const ownedProject=project,ownedUser=user,active=()=>current()&&manager===owner&&project===ownedProject&&user===ownedUser;
  // Native create-connected-node enqueues addNode and immediately validates
  // addEdge in the same stack. Publish that node before the edge inspector.
  const addNode=owner.addNode;let publishing=false;
  if(typeof addNode==='function'){const wrapper=function(this:any,...args:any[]){const result=addNode.apply(this,args);if(active()&&!publishing){publishing=true;try{owner.flushOperationQueue?.(true);}finally{publishing=false;}}return result;};owner.addNode=wrapper;restorers.push(()=>{if(owner.addNode===wrapper)owner.addNode=addNode;});}
  for(const name of ['enqueue','addEdge']){const original=owner[name];if(typeof original!=='function')continue;const wrapper=function(this:any,operation:any,...args:any[]){if(active()){if(name==='addEdge')assertEdge(operation);else if(operation?.kind==='addEdge')assertEdge(operation.edge);else if(operation?.kind==='pasteGraph'){const originalGraph=graph()!,candidate={...originalGraph,nodes:[...originalGraph.nodes,...operation.nodes],edges:[...originalGraph.edges]};for(const edge of operation.edges??[]){assertEdge(edge,candidate);candidate.edges.push(edge);}}}return original.call(this,operation,...args);};owner[name]=wrapper;restorers.push(()=>{if(owner[name]===wrapper)owner[name]=original;});}
 }
 const jsxRestorers:(()=>void)[]=[];
 for(const name of ['jsx','jsxs']){const original=native.j?.[name];if(typeof original!=='function')continue;const wrapper=function(this:any,type:any,props:any,...args:any[]){if(current()&&Array.isArray(props?.nodes)&&Array.isArray(props?.edges)&&typeof props.onConnect==='function'){
   const connect=props.onConnect,valid=props.isValidConnection,end=props.onConnectEnd;props={...props,isValidConnection:(connection:CanvasConnection)=>{if(valid&&valid(connection)===false)return false;return rejectConnection(connection)?.allowed??false;},onConnect:(connection:CanvasConnection)=>{const check=rejectConnection(connection);if(check&&!check.allowed){notice(check.reason!);return;}return connect(connection);},onConnectEnd:(...values:any[])=>{const state=values[1];if(state?.toHandle&&lastRejected&&Date.now()-lastRejected.at<2000)notice(lastRejected.reason);connectionHint.hidden=true;lastRejected=undefined;return end?.(...values);}};
  }return original.call(this,type,props,...args);};native.j[name]=wrapper;jsxRestorers.push(()=>{if(native.j[name]===wrapper)native.j[name]=original;});}
 // A native action may await asset checks before reaching /canvas/task/run.
 // Only arm a matching once-only handoff when replaying a verified user action.
 const releaseNativeIntent=runtime.execution.setNativeSubmitIntent?.((pid:string,id:string,type:string)=>{
  const item=clickIntents.get(id);
  if(!item)return;
  clickIntents.delete(id);
  if(!current()||pid!==project||item.project!==pid||item.manager!==manager||item.user!==user||
     item.intent.targetType!==type||performance.now()-item.at>10000)return;
  return item.intent;
 });
 const releaseDiagnosticDom=runtime.execution.setDiagnosticDom?.((projectId:string,targetId:string)=>{
  if(!current()||project!==projectId)return;
  const matched=contexts.find(c=>c.target===targetId&&c.button===activeButton)??contexts.find(c=>c.target===targetId);
  const node=graph()?.nodes.find(n=>n.id===targetId);
  return observeSnapshotDom(root,targetId,matched?.button,visible,native.bq?.getState?.()?.isRead,matched?.group??(node?['group','rh-group'].includes(node.type):undefined));
 });
 const releaseDiagnosticSelection=runtime.execution.setDiagnosticSelection?.(()=>native.c5?.getState?.()?.selectedNodeIds??[]);
 const supersedeOrphanIntent=()=>{if(!replay)clickIntents.clear();};
 const activate=(event:Event)=>{
  if(replay||!current()||(event.target as Element)?.closest?.('[data-studio-h3-longform]'))return;let button=(event.target as Element)?.closest?.<HTMLButtonElement>('.generate-action-button,.rh-node-fail-overlay__btn--retry,.group-toolbar .execute-btn');
  if(event.type==='keydown'){const key=event as KeyboardEvent;if((event.target as Element)?.closest?.('.glass-dropdown-trigger,.tap-dropdown-btn,.studio-model-source-menu'))return;if(key.isComposing||key.altKey||key.metaKey||key.ctrlKey||key.key!=='Enter'&&key.key!==' ')return;if(!button){const preference=native.gw?.()?.submitTask??'shift-enter';if(key.key!=='Enter'||preference==='none'||(preference==='shift-enter')!==key.shiftKey)return;button=(event.target as Element)?.closest('.ce-node-toolbar,.rh-params-card,.react-flow__node')?.querySelector<HTMLButtonElement>('.generate-action-button')??null;}}
  const value=graph();if(button&&value&&isLongformTarget(buttonTarget(button,value),value)){event.preventDefault();event.stopImmediatePropagation();notice('此视频正在使用 H3 分段长片，请在长片面板中生成。');return;}const context=button&&value?buttonContext(button,value):undefined;if(!context)return;if(!context.ids.length){event.preventDefault();event.stopImmediatePropagation();return;}activeButton=context.button;positionNotes();event.preventDefault();event.stopImmediatePropagation();if(inflight.has(context.button))return;inflight.add(context.button);
  clickIntents.delete(context.target);
  const rawAria=context.button.getAttribute('aria-disabled');
  const intent:SnapshotIntent={
   targetId:context.target,targetType:context.group?'GROUP':'NODE',
   control:event.type==='keydown'?'SHORTCUT':context.group?'GROUP':context.button.matches('.rh-node-fail-overlay__btn--retry')?'RETRY':'GENERATE',
   click:{visible:true,disabled:context.button.matches(':disabled')||rawAria==='true',...(rawAria==='true'||rawAria==='false'?{ariaDisabled:rawAria==='true'}:{})},
  };
  const ownManager=manager,ownUser=user,ownProject=project;void(async()=>{for(let attempt=0;attempt<2;attempt++){if(!current()||manager!==ownManager||user!==ownUser||project!==ownProject||!context.button.isConnected)return;const latest=graph()!,visible=buttonContext(context.button,latest);if(!visible||visible.target!==context.target)return;const ids=visible.ids,candidate=visible.candidate;if(!ids.length)return;const key=keyFor(candidate,ids,visible.group),answer:GenerationReadiness=await Promise.resolve().then(()=>runtime.execution.inspectGeneration(project,ids,structuredClone(candidate),visible.group)).catch(reason=>({status:'blocked',issues:ids.map(nodeId=>({nodeId,code:'GENERATION_CHECK_UNAVAILABLE',message:reason instanceof Error?reason.message:'生成条件检查暂不可用，请重试。'}))}));if(!current()||manager!==ownManager||user!==ownUser||project!==ownProject||!context.button.isConnected)return;const currentContext=buttonContext(context.button,graph()!);if(!currentContext||currentContext.target!==context.target)return;if(keyFor(currentContext.candidate,currentContext.ids,currentContext.group)!==key)continue;const state=states.get(key)??{ids,pending:false,sequence:0};states.set(key,state);if(state.timer)clearTimeout(state.timer);state.timer=undefined;state.sequence++;retainAnswer(candidate,ids,key,state,visible.group,answer);refresh();if(answer.status!=='ready'||answer.issues.length){const issue=answer.issues[0];
      const mark=marks.get(context.button);if(mark){mark.collapsed=false;mark.userExpanded=true;mark.note.removeAttribute('data-signature');activeButton=context.button;paint();}
      if(issue){
       try{
        const logId=await runtime.execution.reportGenerationReadinessFailure?.(ownProject,issue,intent,candidate);
        if(logId&&current()&&manager===ownManager&&user===ownUser&&project===ownProject){
         const latestContext=buttonContext(context.button,graph()!);
         // A later edit can reuse this button for a different failure.
         if(latestContext&&latestContext.target===visible.target&&keyFor(latestContext.candidate,latestContext.ids,latestContext.group)===key){
          const hint=marks.get(context.button)?.note.querySelector('.studio-generation-readiness__hint');
          if(hint)hint.textContent='日志编号：'+logId+'。修改后会自动重新检查。';
         }
        }
       }catch{/* Diagnostic delivery cannot invalidate the original explanation. */}
      }
      schedule();return;}
    for(const item of contexts)if(item.button===context.button)restore(item.button);
    const at=performance.now();
    for(const [id,entry] of clickIntents)if(at-entry.at>10000)clickIntents.delete(id);
    clickIntents.set(context.target,{at,project:ownProject,manager:ownManager,user:ownUser,intent});
    replay=true;
    try{context.button.click();}catch(error){clickIntents.delete(context.target);throw error;}finally{replay=false;}
    return;}
   notice('输入刚有变化，正在重新检查生成条件。');schedule();})().catch(reason=>{if(current())notice(reason instanceof Error?reason.message:'生成条件检查失败，请重试。');}).finally(()=>inflight.delete(context.button));
 };
 const move=(event:PointerEvent)=>{if(!connectionHint.hidden){connectionHint.style.left=Math.max(12,Math.min(event.clientX+16,view.innerWidth-312))+'px';connectionHint.style.top=Math.max(12,Math.min(event.clientY+20,view.innerHeight-100))+'px';}};
 const hideUnpinned=()=>{if(activeButton&&!marks.get(activeButton)?.userExpanded){activeButton=null;positionNotes();}};
 const choose=(event:Event)=>{
  if(hideTimer)clearTimeout(hideTimer);hideTimer=undefined;
  const element=event.target as Element,button=element?.closest?.<HTMLButtonElement>('.generate-action-button,.rh-node-fail-overlay__btn--retry,.group-toolbar .execute-btn')??element?.closest?.('.generate-btn-container')?.querySelector<HTMLButtonElement>('.generate-action-button');
  if(button&&marks.has(button)){activeButton=button;positionNotes();return;}
  if(element?.closest?.('.studio-generation-readiness'))return;
  if(event.type==='focusin')hideUnpinned();else hideTimer=setTimeout(hideUnpinned,160);
 };
 const dismiss=(event:Event)=>{
  const element=event.target as Element;if(element?.closest?.('.studio-generation-readiness')||element?.closest?.(buttonSelector)||element?.closest?.('.generate-btn-container'))return;
  if(activeButton){const mark=marks.get(activeButton);if(mark){mark.collapsed=true;mark.userExpanded=false;mark.note.removeAttribute('data-signature');}activeButton=null;paint();}
 };
 const collapse=(event:KeyboardEvent)=>{if(event.key!=='Escape')return;const note=(event.target as Element)?.closest?.('.studio-generation-readiness');if(!note)return;const mark=[...marks.values()].find(mark=>mark.note===note),toggle=note.querySelector<HTMLButtonElement>('.studio-generation-readiness__toggle');if(!mark||!toggle||mark.collapsed)return;event.preventDefault();event.stopImmediatePropagation();toggle.click();toggle.focus();};
 const ownUi='[data-studio-generation-readiness],.studio-connection-readiness',containsControl=(element:Element)=>element.matches(buttonSelector)||!!element.querySelector(buttonSelector),styleBefore=root.createElement('div');
 const observer=new MutationObserver(records=>{
  let changed=false,moved=false;
  for(const record of records){const element=record.target instanceof Element?record.target:record.target.parentElement;if(!element||element.closest(ownUi))continue;
   if(record.type==='childList'){
    const controls=[...record.addedNodes,...record.removedNodes].some(node=>node instanceof Element&&!node.matches(ownUi)&&containsControl(node));
    if(controls||element.closest(panelSelector))changed=true;
   }else if(record.type==='characterData'){if(element.closest(panelSelector))changed=true;}
   else if(record.attributeName==='style'){
    if(!containsControl(element)&&!element.closest(panelSelector))continue;
    styleBefore.style.cssText=record.oldValue??'';
    if(['display','visibility','content-visibility'].some(key=>styleBefore.style.getPropertyValue(key)!==(element as HTMLElement).style.getPropertyValue(key)))changed=true;
    else moved=true;
   }else if((element===root.body||element===root.documentElement)&&record.attributeName==='class'){
    moved=true;for(const button of root.querySelectorAll<HTMLButtonElement>(buttonSelector)){const before=controlVisibility.get(button);if(before!==undefined&&visible(button)!==before)changed=true;}
   }
   else if(containsControl(element)||element.closest(panelSelector)){
    const classes=(value:string|null)=>(value??'').split(/\s+/).filter(name=>name&&!['selected','dragging'].includes(name)).sort().join(' ');
    if(record.attributeName==='class'&&classes(record.oldValue)===classes(element.getAttribute('class')))moved=true;else changed=true;
   }
  }
  if(changed)schedule();else if(moved)queueLayout();
 });observer.observe(root.body,{subtree:true,childList:true,characterData:true,attributes:true,attributeOldValue:true,attributeFilter:['data-target-node-id','data-node-id','data-id','class','aria-label','hidden','aria-hidden','style']});
 view.addEventListener('pointerdown',supersedeOrphanIntent,true);view.addEventListener('keydown',supersedeOrphanIntent,true);view.addEventListener('blur',supersedeOrphanIntent);
 view.addEventListener('click',activate,true);view.addEventListener('keydown',activate,true);view.addEventListener('rhtv:canvas-attachment',schedule);view.addEventListener(h3LongformModeEvent,schedule);root.addEventListener('input',schedule,true);root.addEventListener('change',schedule,true);root.addEventListener('pointermove',move as EventListener,true);const auth=runtime.auth?.onClear?.(schedule),access=runtime.storage?.subscribeAccess?.(schedule),subscription=runtime.execution.subscribeGenerationReadiness?.(schedule);refresh();
 root.addEventListener('pointerover',choose,true);root.addEventListener('focusin',choose,true);root.addEventListener('pointerdown',dismiss,true);view.addEventListener('keydown',collapse,true);
 view.addEventListener('resize',queueLayout);root.addEventListener('scroll',queueLayout,true);
 return()=>{disposed=true;request++;releaseNativeIntent?.();releaseDiagnosticDom?.();releaseDiagnosticSelection?.();releaseGraph?.();auth?.();access?.();subscription?.();observer.disconnect();view.removeEventListener('pointerdown',supersedeOrphanIntent,true);view.removeEventListener('keydown',supersedeOrphanIntent,true);view.removeEventListener('blur',supersedeOrphanIntent);view.removeEventListener('click',activate,true);view.removeEventListener('keydown',activate,true);view.removeEventListener('rhtv:canvas-attachment',schedule);view.removeEventListener(h3LongformModeEvent,schedule);root.removeEventListener('input',schedule,true);root.removeEventListener('change',schedule,true);root.removeEventListener('pointermove',move as EventListener,true);root.removeEventListener('pointerover',choose,true);root.removeEventListener('focusin',choose,true);root.removeEventListener('pointerdown',dismiss,true);view.removeEventListener('keydown',collapse,true);view.removeEventListener('resize',queueLayout);root.removeEventListener('scroll',queueLayout,true);for(const restore of restorers.reverse())restore();for(const restore of jsxRestorers.reverse())restore();clear();connectionHint.remove();style.remove();};
}
export const nativeGenerationReadinessStyles=`
[data-studio-generation-blocked]{opacity:.55;cursor:not-allowed}
/* Native modal = 2000, group toolbar = 2050, choice menus = 2100. */
.studio-generation-readiness{position:fixed;z-index:2060;display:flex;flex-direction:column;box-sizing:border-box;min-width:0;margin:0;border:1px solid var(--canvas-border-strong,#4b4d50);border-radius:12px;background:var(--canvas-bg-secondary,#252628);color:var(--canvas-text-primary,#f0f0f0);font:14px/1.5 system-ui,sans-serif;white-space:normal;text-align:start;overflow:hidden;overflow-wrap:anywhere;pointer-events:auto;isolation:isolate;color-scheme:normal}
.studio-generation-readiness[hidden]{display:none}
.studio-generation-readiness__header{flex:0 0 auto;display:flex;align-items:center;gap:8px;padding:12px 16px;color:var(--canvas-text-primary,#f0f0f0)}
.studio-generation-readiness__header:before{content:'';flex:0 0 6px;width:6px;height:6px;border-radius:50%;background:#edc77b}
.studio-generation-readiness__header strong{flex:1;min-width:0;font:500 14px/1.5 system-ui,sans-serif}
.studio-generation-readiness .studio-generation-readiness__toggle{flex:0 0 auto;min-height:32px;padding:4px 6px;border:0;border-radius:4px;background:transparent;color:var(--canvas-text-secondary,#bfc1c5);font:13px/1.5 system-ui,sans-serif;cursor:pointer}
.studio-generation-readiness .studio-generation-readiness__toggle:hover{background:var(--canvas-control-hover-neutral,#3c3e42);color:var(--canvas-text-primary,#f0f0f0)}
.studio-generation-readiness .studio-generation-readiness__toggle:focus-visible{outline:2px solid var(--canvas-text-primary,#f0f0f0);outline-offset:2px}
.studio-generation-readiness__body{min-height:0;overflow:auto;overscroll-behavior:contain;padding:0 16px 12px;scrollbar-width:thin;scrollbar-color:#686b70 transparent}
.studio-generation-readiness__body[hidden]{display:none}
.studio-generation-readiness__row+.studio-generation-readiness__row{margin-top:12px;padding-top:12px;border-top:1px solid var(--canvas-border-subtle,#414346)}
.studio-generation-readiness__row p{margin:0;white-space:normal;font:400 14px/1.6 system-ui,sans-serif;color:var(--canvas-text-primary,#f0f0f0);overflow-wrap:anywhere}
.studio-generation-readiness .studio-generation-readiness__issue{display:inline-flex;align-items:center;justify-content:center;min-height:36px;max-width:100%;margin:6px 0 0;padding:4px 10px;border:1px solid var(--canvas-border-strong,#66696f);border-radius:6px;background:transparent;color:var(--canvas-text-primary,#f0f0f0);font:500 13px/1.5 system-ui,sans-serif;white-space:normal;cursor:pointer;pointer-events:auto}
.studio-generation-readiness .studio-generation-readiness__issue:hover{background:var(--canvas-control-hover-neutral,#3c3e42)}
.studio-generation-readiness .studio-generation-readiness__issue:focus-visible{outline:2px solid var(--canvas-text-primary,#f0f0f0);outline-offset:2px}
.studio-generation-readiness__hint{margin:10px 0 0;color:var(--canvas-text-secondary,#bfc1c5);font:12px/1.5 system-ui,sans-serif}
.studio-generation-readiness ::selection{background:#70664b;color:#fff}
.studio-connection-readiness{position:fixed;z-index:10020;max-width:min(300px,calc(100vw - 48px));padding:9px 12px;border:1px solid #65516c;border-radius:7px;background:#2d2533;color:#efe7f4;font:12px/1.5 system-ui;pointer-events:none;box-shadow:0 4px 16px #0004}.studio-connection-readiness[hidden]{display:none}@media(pointer:coarse){.studio-generation-readiness .studio-generation-readiness__issue{min-height:44px;font-size:14px}}
`;
