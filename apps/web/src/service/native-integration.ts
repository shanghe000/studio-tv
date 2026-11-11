import {newResultTool} from './node-tool-contract';
import {installSketchboardUi} from './sketchboard';
import {installAgentVideo} from './agent-video';
import {installMeasuredGenerationProgress} from './generation-progress';
import {ApiError} from '../api/client';
import {randomUuid} from '../browser-compat';
import type {TerminalNodeUpdate,TransientNodeSettlement} from './execution';
import {scriptTerminalFields} from './storyboard-output';
import {installScriptTerminalDisplay} from './script-terminal-display';
import {runNativeNodeGenerationAction} from './native-storyboard-generation';
import {installImageHistoryDisplay} from './image-history-display';
import {installVideoHistoryDisplay} from './video-history-display';
import {installVideoHistoryGrants} from './video-history-grants';
import {installNativeOutputPresetLayout} from './output-preset-layout';
import {assertStoryboardEntityReferenceModel,storyboardEntityReference,wrapStoryboardEntityReference} from './storyboard-entity-reference';
import {installModelSelectors,installNativeModelProjection} from './model-selectors';
import {installCanvasToolAvailability} from './canvas-tool-availability';
import {installImageToolNotices} from './image-tool-notices';
import {installCanvasViewportPreviews} from './canvas-viewport-previews';
import {installImageToolViewport} from './image-tool-viewport';
import {installCanvasComposerViewport} from './video-composer-viewport';
import {installSemanticLightIntensityDisplay} from './semantic-light-intensity-display';
import {installNativeAssetDialog} from './native-asset-dialog';
import {installNativeTextSelectionMenu} from './native-text-selection-menu';
import {installCanvasFileIntake} from './canvas-file-intake';
import {installMediaDownloads} from './media-downloads';
import {installDraftRecoveryUi} from './draft-recovery-ui';
import {installCanvasEditSession} from './canvas-edit-session';
import {installNativeNodeCopy} from './native-node-copy';
import {installNativeEditHistory} from './native-edit-history';
import {installNativeGenerationReadiness} from './native-generation-readiness';
import {installPortraitGenerationDisplay} from './portrait-generation-display';
import {installNativeModelMenuViewport} from './native-model-menu';
import {installNativeProjectFolderNavigation} from './project-navigation';
import {canvasProjectFromPath,installCanvasLifecycle} from './canvas-lifecycle';
import {installCanvasRouteLoader} from './canvas-route-loader';
import {installNativeTeamPolicy} from './native-team-policy';
import {installNativeProjectAccess} from './native-project-access';
import {videoCancellationReason} from './video-input';
import {installCanvasVideoInputGuidance} from './video-input-guidance';
import {installOfficialVideoPriceControls} from './official-video-price-controls';
import {installVideoReferencePreviews} from './video-reference-preview';
import {installH3LongformControls} from './h3-longform-controls';
import {h3LongformOwnsGeneration} from './h3-longform-mode';
import type {Features} from '../features/policy';
/** Native export seam inspected in immutable index-DeyN_Phq.js. */
const entry='/project/assets/index-DeyN_Phq.js';
const assetDialogEntry='/project/assets/pendingSketchboardImage-nI3ZcUsX.js';
const GENERATE_LABEL=/^(?:开始生成|生成|重试|整组执行|批量生成视频|Generate|Retry|Execute Group|Batch Generate Videos|生成する|グループを実行|생성|그룹 실행)$/i;
const CANCEL_LABEL=/^(?:取消生成|停止生成|取消|Cancel generation|Cancel generating|Cancel|Stop)$/i;
export function nativeProps(element:any):any[]{
 const key=Object.keys(element||{}).find(key=>key.startsWith('__reactFiber$'));
 const props:any[]=[];let fiber=key?element[key]:null;
 for(let depth=0;fiber&&depth<35;depth++,fiber=fiber.return)if(fiber.memoizedProps&&typeof fiber.memoizedProps==='object')props.push(fiber.memoizedProps);
 return props;
}
export function nativeGenerationAction(button:any){return nativeProps(button).find(props=>props.currentModel&&props.params&&typeof props.onClick==='function'&&Object.hasOwn(props,'visible'));}
/** React's host-props slot is updated on commit even when a reused button's
 * ancestor fiber still describes its previous Stop render. Read only this
 * exact native button, never a model or the surrounding toolbar's props. */
function nativeButtonRenderProps(button:any){
 const key=Object.keys(button||{}).find(key=>key.startsWith('__reactProps$')),direct=key?button[key]:undefined;
 const matches=(props:any)=>typeof props?.className==='string'&&props.className.split(/\s+/).some((name:string)=>name==='generate-action-button'||name==='rh-node-generating-cancel');
 return matches(direct)?direct:nativeProps(button).find(matches);
}
export function nativeGroupGenerationAction(button:any){
 const props=nativeProps(button),action=props.find(props=>typeof props.onClick==='function'&&typeof props.className==='string'&&props.className.split(/\s+/).includes('execute-btn'));
 const toolbar=props.find(props=>props.groupNode?.type==='group'&&typeof props.onExecute==='function'&&typeof props.onStartStoryboardBatch==='function'&&typeof props.onStartEntityBatch==='function'&&typeof props.onExecuteVideoGroup==='function'&&props.videoGroupComposeReadiness);
 return action&&toolbar?{...action,groupNode:toolbar.groupNode}:null;
}
export function generationTarget(button:any,state:any,graph:any):string|null {
 const own=button.closest?.('[data-node-id]')?.getAttribute('data-node-id')||button.closest?.('.react-flow__node[data-id]')?.getAttribute('data-id');
 if(own&&graph.nodes.some((n:any)=>n.id===own))return own;
 for(const props of nativeProps(button)){const candidate=props.nodeId||props.groupId||props.targetNode?.id||props.groupNode?.id;if(candidate&&graph.nodes.some((n:any)=>n.id===candidate))return String(candidate);}
 const ids=[state.paramsUiLockNodeId,state.expandedNodeId,...(state.selectedNodeIds?.length===1?state.selectedNodeIds:[])].filter(Boolean);
 return ids.find((id:string)=>graph.nodes.some((n:any)=>n.id===id))||null;
}
export async function installNativeIntegration(runtime:any,notice:(text:string)=>void,features?:Features){
 const native:any=await import(/* @vite-ignore */ entry);
 const assetModule:any=await import(/* @vite-ignore */ assetDialogEntry);
 const assetDialog=installNativeAssetDialog(native,assetModule.C);
 const portraitDisplay=installPortraitGenerationDisplay(native);
 const historyDisplay=installImageHistoryDisplay(native);
 const videoHistoryDisplay=installVideoHistoryDisplay(native);
 const videoHistoryGrants=installVideoHistoryGrants(native,{scope:()=>runtime.auth.user?.id??null,cached:id=>runtime.storage.assets.get(id),resolve:(id,_signal)=>runtime.storage.resolveAsset('rhtv-asset:'+id),subscribe:fn=>runtime.auth.onSession(fn)},window,fn=>runtime.auth.onClear(fn));
 const outputPresetLayout=installNativeOutputPresetLayout(native);
 const sketchboard=installSketchboardUi(runtime.execution.sketchProgress,()=>runtime.canvasAttachment()?.id,document,{catalog:()=>runtime.execution.catalog(),selections:runtime.execution.sketchModels,canRun:id=>runtime.storage.access(id)?.canRun===true,notice});
 const availability=installCanvasToolAvailability(notice,nativeProps,document,{read:()=>runtime.execution.getGenerationCapabilities(),subscribe:fn=>runtime.execution.subscribeGenerationReadiness(fn),selectedAsset:{
  scope:()=>{const page=runtime.canvasAttachment();return page&&page.identityId===runtime.auth.user?.id&&canvasProjectFromPath(location.pathname)===page.id&&runtime.storage.canRead(page.id)?page.identityId+':'+page.id:null;},
  idOf:ref=>{const encoded=runtime.storage.encodeAsset(ref);return encoded.startsWith('rhtv-asset:')?encoded.slice(11):undefined;},
  cached:id=>runtime.storage.assets.get(id),resolve:id=>runtime.storage.resolveAsset('rhtv-asset:'+id),
 }});
 const imageToolNotices=installImageToolNotices(notice,nativeProps);
 const imageViewport=installImageToolViewport();
 const composerViewport=installCanvasComposerViewport();
 const lightIntensityDisplay=installSemanticLightIntensityDisplay(nativeProps);
 const textSelectionMenu=installNativeTextSelectionMenu();
 const mediaDownloads=installMediaDownloads();
 const draftRecovery=installDraftRecoveryUi(runtime);
 const teamPolicy=installNativeTeamPolicy(native,features,runtime.collaboration);
 const routeLoader=installCanvasRouteLoader(runtime,native,nativeProps);
 const navigation=installNativeProjectFolderNavigation(native,nativeProps);
 const lifecycle=installCanvasLifecycle(runtime,nativeProps);
 const projectAccess=installNativeProjectAccess(runtime,native,nativeProps);
 await runtime.assistant.installNative(native);
 // bx is the frozen Vut text/table serializer used by q_'s direct dJ sources.
 const releaseTextProjection=typeof native.bx==='function'?runtime.execution.setNativeTextProjection?.(native.bx):undefined;
 const videoPrices=installOfficialVideoPriceControls(runtime,native,nativeProps);
 const videoReferencePreviews=installVideoReferencePreviews(runtime,nativeProps);
 const longform=installH3LongformControls(runtime,native);
 const fileIntake=installCanvasFileIntake(()=>runtime.captureCanvasFileIntent?.(),notice);
 const viewportPreviews=installCanvasViewportPreviews(native);
 const nodeCopy=installNativeNodeCopy(runtime,native);
 const editHistory=installNativeEditHistory(runtime,native);
 const projection=installNativeModelProjection(native,()=>runtime.modelBindingPort?.()),controls=installNativeGenerationControls(runtime,notice,native),models=installModelSelectors(runtime,native,notice),menus=installNativeModelMenuViewport(),agentVideo=installAgentVideo(runtime,native,notice),videoGuidance=installCanvasVideoInputGuidance(runtime,native,nativeProps),progress=installMeasuredGenerationProgress(runtime,native),editSession=installCanvasEditSession(runtime,native,window,document,notice),readiness=installNativeGenerationReadiness(runtime,native,notice,nativeProps);return()=>{fileIntake();releaseTextProjection?.();readiness();editSession();draftRecovery();progress();longform();videoReferencePreviews();videoPrices();videoGuidance();sketchboard();agentVideo();availability();imageToolNotices();composerViewport();imageViewport();lightIntensityDisplay();mediaDownloads();textSelectionMenu();projectAccess();lifecycle();routeLoader();menus();models();controls();projection();editHistory();nodeCopy();viewportPreviews();navigation();teamPolicy();outputPresetLayout();videoHistoryGrants();videoHistoryDisplay();historyDisplay();portraitDisplay();assetDialog();};
}
interface EntityContext {scriptId:string;projectId:string;props:any;deps?:any;flow?:any;models?:any;chooser?:any;controls?:any;cards?:any}
const entityKinds:Record<string,{label:string;registry:string;scene:string}>={character:{label:'角色',registry:'characters',scene:''},scene:{label:'场景',registry:'scenes',scene:'storyboard-prompt-scene-creator'},prop:{label:'道具',registry:'props',scene:'storyboard-prompt-props-creator'},product:{label:'商品',registry:'products',scene:'storyboard-prompt-goods-creator'}};
/** Exact pjr render scope ties the view Promise and selected model to their own script, never the latest modal. */
export function installNativeEntityIntegration(runtime:any,notice:(text:string)=>void,native:any){
 const react=native.r,jsx=native.j;if(typeof react?.useMemo!=='function'||typeof react?.useCallback!=='function'||typeof jsx?.jsx!=='function'||typeof jsx?.jsxs!=='function')return null;
 const contexts=new Map<string,EntityContext>(),wrappers=new WeakMap<Function,Function>(),refs=new WeakSet<object>(),busy=new Set<string>();let rendering:EntityContext|null=null,disposed=false;
 const isCurrent=(context:EntityContext)=>!disposed&&runtime.auth.user&&runtime.inspect().id===context.projectId&&native.bt()?.getRemoteData()?.nodes.some((node:any)=>node.id===context.scriptId&&node.type==='rh-script');
 const execute=async(context:EntityContext,selection:{nodeIds?:string[];entities?:any[];kind?:string;model?:any;params?:any;skipSceneCode?:boolean;nodeDataPatch?:any;groupId?:string})=>{
  if(!isCurrent(context))throw new ApiError(409,'STALE_CANVAS_SESSION','画布已切换，请重新选择实体。');
  const identity=runtime.auth.user,manager=native.bt(),graph=manager.getRemoteData(),script=graph.nodes.find((node:any)=>node.id===context.scriptId),sourceNode=selection.nodeIds?.length===1?graph.nodes.find((node:any)=>node.id===selection.nodeIds![0]):null,modelCode=selection.nodeDataPatch?.modelCode??sourceNode?.data?.modelCode;
  const models=Object.values(context.models||{}).flat() as any[],model=selection.model??models.find(model=>model.modelCode===modelCode)??context.controls?.modelOptions?.find((option:any)=>option.value===context.controls.value)?.model;
  if(!model||model.available===false)throw new ApiError(422,'ENTITY_MODEL_REQUIRED','请选择可用的实体测试模型。');
  if(context.props.isRead||native.bq?.getState?.().isRead)throw new ApiError(403,'READ_ONLY','只读画布不能生成实体。');
  const key=context.scriptId+':'+JSON.stringify(selection.nodeIds??selection.entities?.map(entity=>entity.id));if(busy.has(key))return false;busy.add(key);
  try{
   const selected=selection.nodeIds?selection.nodeIds.map(id=>graph.nodes.find((node:any)=>node.id===id)):selection.entities?.map((entity,index)=>graph.nodes.find((node:any)=>node.data?.storyboardScriptNodeId===context.scriptId&&String(node.data?.entityId)===String(entity.id)&&node.data?.storyboardEntityKind===selection.kind)??{id:'rh_entity_'+randomUuid(),type:'rh-entity',position:{x:script.position.x+Number(script.data.width||600)+80,y:script.position.y+80+index*300},data:{storyboardEntityNode:true,storyboardEntityKind:selection.kind,storyboardScriptNodeId:context.scriptId,entityId:entity.id,name:entity.name,desc:entity.desc,imageUrl:entity.imageUrl,voiceBinding:entity.voiceBinding}});
   if(!selected?.length||selected.some(node=>!node?.data?.storyboardEntityNode||node.data.storyboardScriptNodeId!==context.scriptId))throw new ApiError(422,'ENTITY_SELECTION_REQUIRED','请选择此剧本中的真实实体。');
   const assetIdentity=(value:string)=>runtime.storage?.encodeAsset(value)??value,capturedReferences=new Map(selected.map(node=>[node.id,assetIdentity(storyboardEntityReference(node.data,assetIdentity))]));
   if(selection.groupId){const group=graph.nodes.find((node:any)=>node.id===selection.groupId);if(!group||group.data?.storyboardScriptNodeId!==context.scriptId||selected.some(node=>!group.data?.nodeIds?.includes(node.id)&&node.data?.groupId!==group.id&&node.parentId!==group.id&&node.parentNode!==group.id))throw new ApiError(422,'ENTITY_SELECTION_REQUIRED','实体选择不属于当前组。');}
   const kinds=new Set(selected.map(node=>node.data.storyboardEntityKind??node.data.entityType)),view=kinds.has('character')&&!selection.skipSceneCode?await context.chooser?.open():null;
   if(kinds.has('character')&&!selection.skipSceneCode&&!view)return false;
   if(view&&!['portrait','fourView'].includes(view))throw new ApiError(422,'ENTITY_VIEW_INVALID','角色视图选择无效。');
   if(!isCurrent(context)||runtime.auth.user!==identity||native.bt()!==manager)throw new ApiError(409,'STALE_CANVAS_SESSION','画布或登录状态已变更。');
   const style=selection.skipSceneCode?'':String(native.ej(script.data,{tableScene:native.ei(script.data.output,script.data.params?.scene)})?.stylePrompt||''),toolbarParams=selection.params??context.controls?.params??script.data.storyboardEntityImageParams??{};
   const nodes=selected.map((node:any,index:number)=>{
    const patch=selection.nodeDataPatch||{},data={...node.data,...patch,params:{...node.data.params,...patch.params}},kind=String(data.storyboardEntityKind??data.entityType),definition=entityKinds[kind];
    if(!definition||!String(data.name??'').trim()||!String(data.desc??'').trim())throw new ApiError(422,'ENTITY_INPUT_REQUIRED','实体需要名称和描述。');
    if(['running','processing','uploading'].includes(data.status))throw new ApiError(409,'ENTITY_ALREADY_RUNNING','所选实体仍在执行。');
    const promptKey=native.el?.(model)||'prompt',base=String(data.storyboardEntityPrompt??data.params?.[promptKey]??'').trim()||`${definition.label}名称：${data.name}\n${definition.label}描述：${data.desc}`;
    const reference=storyboardEntityReference(data,(value:string)=>runtime.storage?.encodeAsset(value)??value);
    assertStoryboardEntityReferenceModel(model,reference,data.name);
    if(assetIdentity(reference)!==capturedReferences.get(node.id))throw new ApiError(409,'ENTITY_SELECTION_STALE','实体参考图片已变更，请重新选择后生成。');
    const params={...Object.fromEntries((model.config||[]).filter((field:any)=>field.paramName&&field.paramValue!==undefined).map((field:any)=>[field.paramName,field.paramValue])),...toolbarParams,[promptKey]:style?`${base}\n【风格】${style}`:base};
    if(reference)params.imageUrls=[reference];else delete params.imageUrls;
    const scene=selection.skipSceneCode?'':kind==='character'?(view==='fourView'?'storyboard-prompt-character-four-creator':'storyboard-prompt-character-creator'):definition.scene;
    const generated={...data,title:data.name,label:data.name,hidden:false,isStoryboardEntity:true,storyboardEntityIndex:data.storyboardEntityIndex??index,storyboardRegistryEntityId:data.entityId,storyboardRegistryEntityType:kind,modelCode:model.modelCode,params,generateNum:toolbarParams.generateNum??data.generateNum??1,subType:reference?'IMAGE_IMAGE':'TEXT_IMAGE',modelType:reference?'IMAGE_IMAGE':'TEXT_IMAGE'};
    // These are previous results, not reference inputs. Keep them in the native node until STUDIO applies the new task.
    for(const key of ['output','sourceObjects','nodeOutputHistory','historyStorage','structuredOutput','imageUrl','toolsType','toolsSourceUrl','sceneCode'])delete generated[key];
    if(reference){generated.imageUrl=reference;generated.toolsType='IMAGE_IMAGE';generated.toolsSourceUrl=reference;}if(scene)generated.sceneCode=scene;
    return{...node,type:'rh-image',data:generated};
   });
   for(const node of nodes)if(!graph.nodes.some((item:any)=>item.id===node.id)){if(!context.deps)throw new ApiError(409,'ENTITY_CONTEXT_REQUIRED','实体编辑上下文不可用。');context.deps.addNode({...node,type:'rh-entity'});}
   manager.flushOperationQueue?.(true);
   await runtime.execution.generateEntityPlans(context.projectId,nodes,model);
   if(selection.groupId)native.ii?.getState?.().clearActiveEntityGroupBatch(selection.groupId);
   return true;
  }finally{busy.delete(key);}
 };
 const safe=(work:()=>Promise<any>)=>work().catch((error:Error)=>{notice(error.message);return false;});
 const originalMemo=react.useMemo,originalRef=react.useRef,originalCallback=react.useCallback,originalJsx=jsx.jsx,originalJsxs=jsx.jsxs;
 const ref=function(this:any,initial:any){const result=originalRef.call(this,initial);
  if(rendering&&!refs.has(result)&&initial&&Object.keys(initial).sort().join(',')==='cancel,run,runBatch'&&Object.values(initial).every(value=>typeof value==='function')){
   const scriptId=rendering.scriptId;let value=result.current;Object.defineProperty(result,'current',{configurable:true,enumerable:true,get:()=>value,set:(next:any)=>{
    if(typeof next?.run==='function'&&Function.prototype.toString.call(next.run).includes('nodeDataPatch')&&Function.prototype.toString.call(next.run).includes('Kt(')&&typeof next?.runBatch==='function'&&Function.prototype.toString.call(next.runBatch).includes('Bn('))value={...next,run:(node:any,options:any={})=>safe(async()=>{const context=contexts.get(scriptId);if(!context)throw new ApiError(409,'ENTITY_CONTEXT_REQUIRED','实体上下文不可用。');return execute(context,{nodeIds:[node.id],nodeDataPatch:options.nodeDataPatch,skipSceneCode:options.skipSceneCode,params:options.nodeDataPatch?.params??node.data?.params});}),runBatch:(nodes:any[],options:any={})=>safe(async()=>{const context=contexts.get(scriptId);if(!context)throw new ApiError(409,'ENTITY_CONTEXT_REQUIRED','实体上下文不可用。');return execute(context,{nodeIds:nodes.map(node=>node.id),model:options.model,params:options.toolbarParams,skipSceneCode:options.skipSceneCode,groupId:options.groupId});})};else value=next;
   }});refs.add(result);
  }return result;
 };
 const memo=function(this:any,factory:Function,deps:any[]){const result=originalMemo.call(this,factory,deps),source=Function.prototype.toString.call(factory);
  if(rendering&&deps?.length===3&&deps[1]===rendering.scriptId&&typeof deps[0]?.getNodes==='function'&&/^\(\)\s*=>\s*j0\(/.test(source)&&typeof result?.addNode==='function'){rendering.deps=result;rendering.flow=deps[0];rendering.models=deps[2];}
  if(rendering&&deps?.length===2&&/^\(\)\s*=>\s*\(\{\s*open\s*:/.test(source)&&result?.open===deps[0]&&result?.modal===deps[1])rendering.chooser=result;
  return result;
 };
 const callback=function(this:any,fn:Function,deps:any[]){const source=Function.prototype.toString.call(fn);
  if(deps?.length===8&&typeof deps[0]==='string'&&Array.isArray(deps[1])&&Array.isArray(deps[2])&&source.includes('type==="rh-entity"')&&source.includes('B0(')&&source.includes('await jr(')){
   return originalCallback.call(this,(id:string,...args:any[])=>{const node=deps[1].find((node:any)=>node.id===id);if(node?.type!=='rh-entity')return fn(id,...args);const context=contexts.get(String(node.data?.storyboardScriptNodeId));return safe(async()=>{if(!context)throw new ApiError(409,'ENTITY_CONTEXT_REQUIRED','请打开对应剧本的实体面板。');return execute(context,{nodeIds:[id],params:args[1]?.params??node.data.params});});},deps);
  }
  if(deps?.length===3&&deps[0]?.type==='group'&&deps[0].data?.storyboardEntityGroup===true&&typeof deps[1]?.getNode==='function'&&source.includes('selectedEntityNodeIds')&&source.includes('war(')&&source.includes('clearActiveEntityGroupBatch')){
   const group=deps[0],flow=deps[1];return originalCallback.call(this,async(options:any)=>{try{const ids=options.selectedEntityNodeIds||[],node=ids.length?flow.getNode(ids[0]):null,context=contexts.get(String(node?.data?.storyboardScriptNodeId));if(!context)throw new ApiError(409,'ENTITY_CONTEXT_REQUIRED','请打开对应剧本的实体面板。');return await safe(()=>execute(context,{nodeIds:ids,model:options.model,params:options.params,groupId:group.id}));}finally{options.cancel?.();}},deps);
  }
  return originalCallback.call(this,fn,deps);
 };
 const projectProps=(type:any,props:any)=>{
  if(typeof type==='function'&&type.name==='pjr'&&props?.nodeId&&Object.hasOwn(props,'parsedRows')&&Object.hasOwn(props,'shotNumberByRowId')&&Object.hasOwn(props,'onOpenPreview')){
   let wrapper=wrappers.get(type);if(!wrapper){wrapper=function(props:any){const previous=rendering,context:EntityContext={scriptId:String(props.nodeId),projectId:String(props.canvasId||runtime.inspect().id||''),props};rendering=context;contexts.set(context.scriptId,context);try{return type(props);}finally{rendering=previous;}};wrappers.set(type,wrapper);}return{type:wrapper,props};
  }
  if(props?.targetNode?.type==='rh-entity'&&props.models&&typeof props.onGenerate==='function'&&typeof props.onNodeDataPatch==='function'){
   return{type,props:{...props,onGenerate:(id:string,_prompt?:string,options?:any)=>safe(async()=>{const node=native.bt()?.getRemoteData()?.nodes.find((node:any)=>node.id===id),context=contexts.get(String(node?.data?.storyboardScriptNodeId));if(!context)throw new ApiError(409,'ENTITY_CONTEXT_REQUIRED','请打开对应剧本的实体面板。');return execute(context,{nodeIds:[id],params:options?.params??node?.data?.params});})}};
  }
  // TOr's VTe reuse path bypasses onUpdateImage and calls its general edit handler.
  // Bind only the actual explicit entity asset picker, never arbitrary onSave edits.
  if(typeof type==='function'&&type.name==='VTe'&&props?.pickOnly===true&&props.entityReuse===true&&props.scriptTableNodeId&&props.excludeEntityId&&typeof props.onReuseEntity==='function'){
   const context=contexts.get(String(props.scriptTableNodeId));
   if(context&&entityKinds[props.initialEntityKind])return{type,props:{...props,onReuseEntity:wrapStoryboardEntityReference(runtime,native,{projectId:context.projectId,scriptId:context.scriptId,kind:props.initialEntityKind,entityId:String(props.excludeEntityId),canEdit:()=>isCurrent(context)&&!context.props.isRead},props.onReuseEntity,(entity:any)=>entity?.imageUrl)}};
  }
  if(!rendering)return{type,props};const context=rendering;
  if(props?.modelOptions&&props.configs&&props.params&&Object.hasOwn(props,'value')&&typeof props.onParamsChange==='function')context.controls=props;
  if(props?.scriptTableNodeId===context.scriptId&&Array.isArray(props.entities)&&Object.hasOwn(props,'batchSelectMode')&&typeof props.onGenerate==='function'&&typeof props.onRetry==='function'&&typeof props.onCancel==='function'){
   context.cards=props;const run=(entity:any)=>props.isRead||props.batchSelectMode||props.generatingState?.[String(entity.id)]?Promise.resolve(false):safe(()=>execute(context,{entities:[entity],kind:props.kind}));
   const onUpdateImage=typeof props.onUpdateImage==='function'?(selection:any)=>wrapStoryboardEntityReference(runtime,native,{projectId:context.projectId,scriptId:context.scriptId,kind:props.kind,entityId:String(selection?.entityId),canEdit:()=>isCurrent(context)&&!props.isRead&&!context.props.isRead},props.onUpdateImage,(selection:any)=>selection?.imageUrl)(selection):undefined;
   return{type,props:{...props,onGenerate:run,onRetry:run,...(onUpdateImage?{onUpdateImage}:{})}};
  }
  if(props?.className==='script-table-entity-batch-bar'&&typeof props.onGenerate==='function'&&typeof props.onExitSelect==='function'&&props.params){
   return{type,props:{...props,onGenerate:()=>props.readonly||props.generating||props.generateDisabled?Promise.resolve(false):safe(async()=>{const cards=context.cards,ids=new Set(cards?.selectedEntityIds||[]),entities=cards?.entities.filter((entity:any)=>ids.has(String(entity.id)))||[];const done=await execute(context,{entities,kind:props.entityType});if(done)props.onExitSelect();return done;})}};
  }
  if(props?.leading?.props?.modelOptions&&typeof props.onAction==='function'&&Function.prototype.toString.call(props.onAction).includes('$n()')){
   return{type,props:{...props,onAction:()=>props.actionDisabled?Promise.resolve(false):safe(async()=>{const graph=native.bt().getRemoteData(),script=graph.nodes.find((node:any)=>node.id===context.scriptId),registry=native.eg(graph.nodes,context.scriptId,script.data.output);let done=false;for(const [kind,definition]of Object.entries(entityKinds)){const entities=registry[definition.registry]||registry[kind]||[];if(entities.length)done=await execute(context,{entities,kind})||done;}return done;})}};
  }
  return{type,props};
 };
 const wrapJsx=(original:Function)=>function(this:any,type:any,props:any,...args:any[]){const mapped=projectProps(type,props);return original.call(this,mapped.type,mapped.props,...args);};
 const ownedJsx=wrapJsx(originalJsx),ownedJsxs=wrapJsx(originalJsxs);react.useMemo=memo;if(typeof originalRef==='function')react.useRef=ref;react.useCallback=callback;jsx.jsx=ownedJsx;jsx.jsxs=ownedJsxs;
 return{generateNode:(id:string)=>{const node=native.bt()?.getRemoteData()?.nodes.find((node:any)=>node.id===id);if(!node?.data?.storyboardEntityNode)return null;const context=contexts.get(String(node.data.storyboardScriptNodeId));return safe(async()=>{if(!context)throw new ApiError(409,'ENTITY_CONTEXT_REQUIRED','请打开对应剧本的实体面板。');return execute(context,{nodeIds:[id],params:node.data.params});});},dispose:()=>{disposed=true;contexts.clear();if(react.useMemo===memo)react.useMemo=originalMemo;if(react.useRef===ref)react.useRef=originalRef;if(react.useCallback===callback)react.useCallback=originalCallback;if(jsx.jsx===ownedJsx)jsx.jsx=originalJsx;if(jsx.jsxs===ownedJsxs)jsx.jsxs=originalJsxs;}};
}
export function installNativeGenerationControls(runtime:any,notice:(text:string)=>void,native:any){
 if(typeof native.bt!=='function'||typeof native.le!=='function')throw new Error('原生画布生成桥接不可用。');
 const entities=installNativeEntityIntegration(runtime,notice,native);
 const scriptTerminalDisplay=installScriptTerminalDisplay(runtime,native);
 let queued=false,disposed=false,cancelCatalogKey='';
 const blockedCancelButtons=new Map<HTMLButtonElement,{disabled:boolean;title:string|null;label:string|null;ariaDisabled:string|null;reason:string}>();
 const unavailableButtons=new Map<HTMLButtonElement,{disabled:boolean;attrs:Record<string,string|null>;marker:string|null;reason:string}>();
 const unavailableReason=(action:any)=>action?.currentModel?.available===false?(typeof action.currentModel.reason==='string'&&action.currentModel.reason.trim()?action.currentModel.reason:'此模型暂不可用，请选择可用模型。'):undefined;
 const restoreUnavailable=(button:HTMLButtonElement)=>{
  const prior=unavailableButtons.get(button);if(!prior)return;
  if(button.getAttribute('data-studio-model-unavailable')==='true'){
   const rendered=nativeButtonRenderProps(button),disabled=typeof rendered?.disabled==='boolean'?rendered.disabled:prior.disabled;
   if(button.disabled&&button.disabled!==disabled)button.disabled=disabled;
   for(const [name,written]of [['title',prior.reason],['aria-description',prior.reason],['aria-disabled','true']]){
    if(button.getAttribute(name)!==written)continue;
    const value=rendered&&Object.hasOwn(rendered,name)?rendered[name]:prior.attrs[name];
    if(value==null)button.removeAttribute(name);else if(button.getAttribute(name)!==String(value))button.setAttribute(name,String(value));
   }
   if(prior.marker==null)button.removeAttribute('data-studio-model-unavailable');else button.setAttribute('data-studio-model-unavailable',prior.marker);
  }
  unavailableButtons.delete(button);
 };
 const blockUnavailable=(button:HTMLButtonElement,reason:string)=>{
  let prior=unavailableButtons.get(button);
  if(!prior){prior={disabled:button.disabled,attrs:Object.fromEntries(['title','aria-description','aria-disabled'].map(name=>[name,button.getAttribute(name)])),marker:button.getAttribute('data-studio-model-unavailable'),reason};unavailableButtons.set(button,prior);}
  else{
   for(const [name,written]of [['title',prior.reason],['aria-description',prior.reason],['aria-disabled','true']])if(button.getAttribute(name)!==written)prior.attrs[name]=button.getAttribute(name);
   if(!button.disabled)prior.disabled=false;
   if(button.getAttribute('data-studio-model-unavailable')!=='true')prior.marker=button.getAttribute('data-studio-model-unavailable');
   prior.reason=reason;
  }
  if(!button.disabled)button.disabled=true;
  for(const [name,value]of [['data-studio-model-unavailable','true'],['title',reason],['aria-description',reason],['aria-disabled','true']])if(button.getAttribute(name)!==value)button.setAttribute(name,value);
 };
 const restoreCancel=(button:HTMLButtonElement,generate=false)=>{
  const prior=blockedCancelButtons.get(button);if(!prior)return;
  if(button.getAttribute('data-studio-video-cancel-blocked')==='true'){
   const rendered=nativeButtonRenderProps(button),disabled=typeof rendered?.disabled==='boolean'?rendered.disabled:prior.disabled;
   if(button.disabled&&button.disabled!==disabled)button.disabled=disabled;
   const label=typeof rendered?.['aria-label']==='string'?rendered['aria-label']:generate?(GENERATE_LABEL.test(button.textContent?.trim()||'')?button.textContent!.trim():GENERATE_LABEL.test(prior.label||'')?prior.label:/^[a-z]/i.test(prior.label||'')?'Generate':'开始生成'):prior.label;
   for(const [name,before,written]of [['title',prior.title,prior.reason],['aria-label',label,prior.reason],['aria-disabled',prior.ariaDisabled,'true']] as const){
    // A later React/native change belongs to that render. Restore only values
    // that are still exactly the decoration this bridge wrote.
    if(button.getAttribute(name)!==written)continue;
    const value=rendered&&Object.hasOwn(rendered,name)?rendered[name]:before;
    if(value==null){button.removeAttribute(name);}else if(button.getAttribute(name)!==String(value))button.setAttribute(name,String(value));
   }
   button.removeAttribute('data-studio-video-cancel-blocked');
  }
  blockedCancelButtons.delete(button);
 };
 const register=()=>{if(!runtime.auth.user)return;native.le({onGenerate:(id:string)=>{const node=native.bt()?.getRemoteData?.()?.nodes?.find((node:any)=>node.id===id);if(node?.type==='rh-video'&&(h3LongformOwnsGeneration(document,String(runtime.inspect().id||''),id)||node.data?.studioLongformActiveJobId)){notice('此视频正在使用 H3 分段长片，请在长片面板中生成。');return false;}return entities?.generateNode(id)??runtime.execution.generate(id);},onCancelGenerate:(id:string)=>{const reason=runtime.execution.nodeCancellationReason?.(id);if(reason){notice(reason);return;}void runtime.execution.cancelNode(id).catch((error:Error)=>notice(error.message));}});};
 const style=document.createElement('style');style.id='studio-service-billing-policy';style.textContent='.cost-display,.home-cost-display,.generate-btn-cost-tip-trigger,.generate-token-price-tip,.generate-price-tip-icon{display:none!important}';document.head.append(style);
 const state=()=>native.c5?.getState?.()||{};
 const runningTokens=new Map<string,{taskId?:string;restoreCurrent?:()=>boolean;fresh?:boolean}>(),capturedTokens=new Map<string,object>(),runningMethods:Record<string,Function>={},ownedRunningMethods:Record<string,Function>={};
 const running=()=>state(),isRunning=(id:string)=>typeof running().isLocalRunning==='function'?running().isLocalRunning(id):running().localRunningNodeIds?.includes(id);
 const cancelIntent=(button:HTMLButtonElement,id:string|null)=>{
  if(button.matches('.rh-node-generating-cancel'))return true;
  const prior=blockedCancelButtons.get(button),rendered=nativeButtonRenderProps(button);
  const action=nativeGenerationAction(button);
  if(prior&&(action?.isGenerating===true||id&&isRunning(id)))return true;
  const labels=[rendered?.['aria-label'],button.textContent?.trim(),button.getAttribute('aria-label')];
  const label=labels.find(value=>typeof value==='string'&&value!==prior?.reason&&(GENERATE_LABEL.test(value)||CANCEL_LABEL.test(value)));
  if(label)return CANCEL_LABEL.test(label);
  if(action?.isGenerating===true||id&&isRunning(id))return true;
  // A terminal or locally rejected attempt can leave an icon-only DOM button
  // with our aria text. Its old saved Stop label is not a current cancel intent.
  if(action?.isGenerating===false)return false;
  return !!prior&&CANCEL_LABEL.test(prior.label||'');
 };
 const rememberedTask=(id:string)=>typeof native.fp==='function'?String(native.fp(String(runtime.inspect().id||''),id)||'').trim():'';
 const recoverRestoredRun=(id:string,data:any,ttl:number)=>{
  const token=runningTokens.get(id);if(disposed||!runtime.auth.user||!Number.isFinite(ttl)||ttl<=0||!isRunning(id)||token?.fresh&&!(token.taskId&&token.restoreCurrent?.()))return;
  const task=rememberedTask(id),tasks=[data?.taskId,data?.estimateTaskId].map(value=>String(value??'').trim()).filter(Boolean);if(!task||tasks.some(id=>id!==task))return;
  runtime.execution.recoverNativeRunning?.(id,native.bt(),task,ttl);
 };
 if(typeof native.c5?.setState==='function'&&typeof running().markLocalRunning==='function'){
  for(const id of running().localRunningNodeIds||[])runningTokens.set(String(id),{});
  for(const name of ['markLocalRunning','refreshLocalRunningBaseline']){const original=running()[name];if(typeof original!=='function')continue;runningMethods[name]=original;ownedRunningMethods[name]=function(this:any,id:string,...args:any[]){
   const key=String(id),token=runningTokens.get(key),ttl=args[1],tasks=[args[0]?.taskId,args[0]?.estimateTaskId].map(value=>String(value??'').trim()).filter(Boolean),replay=name==='markLocalRunning'&&typeof ttl==='number'&&Number.isFinite(ttl)&&ttl>0,remembered=rememberedTask(key);
   // zXr restores an accepted remembered run with a remaining TTL during graph
   // hydration. Native mark is a no-op while already running. A fresh mark and
   // explicit baseline refresh still start a new local ownership token.
   const restore=replay&&token?.taskId&&token.restoreCurrent?.()&&tasks.every(task=>task===token.taskId)&&(typeof native.fp==='function'?remembered===token.taskId:tasks.length>0);
   if(!restore)runningTokens.set(key,{fresh:!replay||!!token?.fresh});const result=original.call(this,id,...args);if(replay)recoverRestoredRun(key,args[0],ttl);return result;
  };}
  native.c5.setState(ownedRunningMethods);
 }
 const ownsRunningMethods=()=>Object.keys(ownedRunningMethods).length>0&&Object.entries(ownedRunningMethods).every(([name,method])=>running()[name]===method);
 const releaseRunningPort=runtime.execution.installNativeRunningPort?.({capture:(id:string,manager:any)=>{
  const token=runningTokens.get(id);if(disposed||native.bt()!==manager||!ownsRunningMethods()||!isRunning(id)||!token||capturedTokens.get(id)===token)return undefined;capturedTokens.set(id,token);
  const current=()=>!disposed&&native.bt()===manager&&ownsRunningMethods()&&runningTokens.get(id)===token&&!!isRunning(id);
  return{current,accepted:(taskId:string,ownerCurrent:()=>boolean)=>{if(taskId&&current()&&ownerCurrent()){token.taskId=taskId;token.fresh=false;token.restoreCurrent=()=>current()&&ownerCurrent();}}};
 }});
 const releaseSettled=runtime.execution.onSettled?.((update:TransientNodeSettlement)=>{
  if(disposed||!runtime.auth.user||native.bt()!==update.manager||runtime.inspect().id!==update.projectId||!update.current())return;
  // Native 501 handling deliberately keeps an uncertain submission in its
  // session cache. Only a proven unsubmitted, still-owned attempt may forget it.
  if(update.kind==='NOT_SUBMITTED'&&typeof native.eE==='function')native.eE(update.projectId,update.nodeId);
  state().unmarkLocalRunning?.(update.nodeId);
  if(update.kind==='NOT_SUBMITTED'&&update.reason)notice(update.reason);
 });
 const releaseTerminal=runtime.execution.onTerminal?.((update:TerminalNodeUpdate)=>{
  if(disposed||!runtime.auth.user||native.bt()!==update.manager||runtime.inspect().id!==update.projectId)return;
  const node=update.manager.getRemoteData()?.nodes.find((node:any)=>node.id===update.nodeId);
  if(node?.data?.taskId!==update.taskId||!['finished','failed','idle'].includes(node.data.status))return;
  if(node.type==='rh-script'){
   // xn/br updates the current native local node; remote data can omit these
   // transient fields. k2/hx reads the same canvas' current render nodes.
   const local=native.hx?.()?.find((item:any)=>item.id===update.nodeId);
   if(local?.data?.taskId&&local.data.taskId!==update.taskId)return;
   const patch=scriptTerminalFields(local?.data??node.data);
   if(patch.customBadgeText!==undefined&&node.data.testMode===true)patch.customBadgeText='TEST MODE';
   else if(patch.customBadgeText!==undefined&&typeof node.data.customBadgeText==='string'&&!Object.hasOwn(scriptTerminalFields({customBadgeText:node.data.customBadgeText}),'customBadgeText'))patch.customBadgeText=node.data.customBadgeText;
   if(Object.keys(patch).length){if(typeof native.br==='function')native.br(update.nodeId,patch);else update.manager.patchNodeData?.(update.nodeId,patch);}
  }
  state().unmarkLocalRunning?.(update.nodeId);
 });
 const activate=(event:Event)=>{
  if(!runtime.auth.user)return;
  const button=(event.target as Element)?.closest?.('button');if(!button)return;
  // The launch composer creates graphs itself. The node parameter/retry controls are exact native seams.
  if(button.closest('.home-agent-input-bar'))return;
  const manager=native.bt(),graph=manager?.getRemoteData();if(!graph)return;
  const target=generationTarget(button,state(),graph);if(!target)return;
  const cancel=cancelIntent(button,target);if(blockedCancelButtons.has(button)&&!cancel)restoreCancel(button,true);
  const label=button.getAttribute('aria-label')||button.textContent?.trim()||'';
  const generate=button.matches('.generate-action-button,.rh-node-fail-overlay__btn--retry')&&GENERATE_LABEL.test(label);
  const group=button.closest('.group-toolbar')?nativeGroupGenerationAction(button):null;
  if(!generate&&!cancel&&!group)return;
  event.preventDefault();event.stopImmediatePropagation();register();
  if(cancel){const reason=runtime.execution.nodeCancellationReason?.(target)||videoCancellationReason(nativeGenerationAction(button)?.currentModel);if(reason)notice(reason);else void runtime.execution.cancelNode(target).catch((error:Error)=>notice(error.message));}
  else if(group){
   const node=graph.nodes.find((n:any)=>n.id===target),data=group.groupNode.data||{};
   if(button.disabled||button.getAttribute('aria-disabled')==='true'||group.disabled||group['aria-disabled']===true||['running','processing','uploading'].includes(node?.data?.status))return;
   // Dkr opens native storyboard/entity planning and video composition. Normal groups use STUDIO runs;
   // their original VMr confirmation requires the unavailable original price and wallet endpoints.
   if(['storyboard','video'].includes(data.groupType)||data.storyboardEntityGroup===true)void Promise.resolve(group.onClick()).catch((error:Error)=>notice(error.message));
   else void runtime.execution.generate(target);
  }
  else {const action=nativeGenerationAction(button);if(action){const reason=!action.isGenerating&&!isRunning(target)&&!['running','processing','uploading'].includes(graph.nodes.find((node:any)=>node.id===target)?.data?.status)?unavailableReason(action):undefined;if(reason){notice(reason);return;}void runNativeNodeGenerationAction(runtime,native,notice,target,action,!!newResultTool(button)).catch((error:Error)=>notice(error.message));}else if(!button.disabled)void(entities?.generateNode(target)??runtime.execution.generate(target));}
 };
 const shortcuts=(event:KeyboardEvent)=>{
  if(!runtime.auth.user)return;
  if(event.isComposing||event.key!=='Enter'||event.altKey||event.metaKey||event.ctrlKey)return;
  const target=event.target as Element;
  // This document capture listener runs before the native button/React guards.
  // A model control keeps Enter's default click instead of submitting its node.
  if(target?.closest?.('.glass-dropdown-trigger,.tap-dropdown-btn,.studio-model-source-menu,[data-studio-h3-longform]'))return;
  const prefs=native.gw?.()||{},submit=prefs.submitTask||'shift-enter';if(submit==='none'||(submit==='shift-enter')!==event.shiftKey)return;
  if(!target?.closest?.('.react-flow__node,.ce-node-toolbar,.rh-params-card'))return;
  const manager=native.bt(),graph=manager?.getRemoteData();if(!graph)return;
  const id=generationTarget(target,state(),graph);if(!id)return;
  const button=target.closest('.ce-node-toolbar,.rh-params-card,.react-flow__node')?.querySelector('.generate-action-button');
  const action=button?nativeGenerationAction(button):null;if(!action)return;
  // Native prompt key handlers also submit directly; consume this chord before availability guards.
  event.preventDefault();event.stopImmediatePropagation();
  const reason=!action.isGenerating&&!isRunning(id)&&!['running','processing','uploading'].includes(graph.nodes.find((node:any)=>node.id===id)?.data?.status)?unavailableReason(action):undefined;
  if(reason){notice(reason);return;}
  if(button?.hasAttribute?.('data-studiotv-unavailable')){notice(button.getAttribute('data-studiotv-unavailable')!);return;}
  if(action.disabled||action.isGenerating||action.currentModel.available===false)return;
  // Share the button dispatcher: ordinary panels retain their native callback;
  // saved storyboard images use their current guarded full graph after flushing.
  register();void runNativeNodeGenerationAction(runtime,native,notice,id,action,!!button&&!!newResultTool(button)).catch((error:Error)=>notice(error.message));
 };
 const refresh=()=>{if(queued||disposed)return;queued=true;queueMicrotask(()=>{queued=false;if(disposed)return;register();
  // fX/zXr supplies the remaining TTL from a real remembered run. fp/bSe
  // separately excludes pending submission records, including a fresh run
  // whose canvas still carries an older estimateTaskId.
  if(runtime.auth.user&&typeof native.fX==='function'){const graph=native.bt()?.getRemoteData(),projectId=String(runtime.inspect().id||'');if(projectId&&Array.isArray(graph?.nodes))native.fX(projectId,graph.nodes,recoverRestoredRun);}
  const currentGraph=native.bt()?.getRemoteData(),catalogKey=runtime.auth.user?String(runtime.auth.user.id)+':'+String(runtime.inspect().id):'';
  if(!catalogKey)cancelCatalogKey='';
  if(catalogKey&&catalogKey!==cancelCatalogKey&&typeof runtime.execution.catalog==='function'&&currentGraph?.nodes?.some((node:any)=>node.type==='rh-video'&&node.data?.taskId)){cancelCatalogKey=catalogKey;void runtime.execution.catalog().then(()=>{if(!disposed)refresh();}).catch(()=>{});}
  for(const button of [...unavailableButtons.keys()])if(button.isConnected===false)restoreUnavailable(button);
  // Original disabled state includes SKU/price-loading. Own execution does not depend on either.
  for(const button of document.querySelectorAll<HTMLButtonElement>('.generate-action-button,.rh-node-generating-cancel')){
   if(button.closest('.home-agent-input-bar')){restoreUnavailable(button);continue;}
   const prior=blockedCancelButtons.get(button),cancelNodeId=currentGraph&&generationTarget(button,state(),currentGraph),cancel=cancelIntent(button,cancelNodeId);
   if(cancel||prior){
    restoreUnavailable(button);
    const reason=cancel&&runtime.auth.user&&cancelNodeId?(runtime.execution.nodeCancellationReason?.(cancelNodeId)||videoCancellationReason(nativeGenerationAction(button)?.currentModel)):undefined;
    if(reason){
     if(!prior)blockedCancelButtons.set(button,{disabled:button.disabled,title:button.getAttribute('title'),label:button.getAttribute('aria-label'),ariaDisabled:button.getAttribute('aria-disabled'),reason});
     else{if(button.getAttribute('title')!==prior.reason)prior.title=button.getAttribute('title');if(button.getAttribute('aria-label')!==prior.reason)prior.label=button.getAttribute('aria-label');if(button.getAttribute('aria-disabled')!=='true')prior.ariaDisabled=button.getAttribute('aria-disabled');if(!button.disabled)prior.disabled=false;prior.reason=reason;}
     if(!button.disabled)button.disabled=true;for(const [name,value]of [['data-studio-video-cancel-blocked','true'],['aria-disabled','true'],['title',reason],['aria-label',reason]])if(button.getAttribute(name)!==value)button.setAttribute(name,value);
    }
    else restoreCancel(button,!cancel);
    if(cancel)continue;
   }
   if(!GENERATE_LABEL.test(button.getAttribute('aria-label')||'')){restoreUnavailable(button);continue;}
   const graph=native.bt()?.getRemoteData();if(!graph||!generationTarget(button,state(),graph)){restoreUnavailable(button);continue;}
   const id=generationTarget(button,state(),graph),node=graph.nodes.find((n:any)=>n.id===id),action=nativeGenerationAction(button);
   const reason=runtime.auth.user&&!action?.isGenerating&&!isRunning(id!)&&!['running','processing','uploading'].includes(node?.data?.status)?unavailableReason(action):undefined;
   if(reason){blockUnavailable(button,reason);continue;}
   restoreUnavailable(button);
   if(!action||action.disabled||action.isGenerating||action.currentModel.available===false)continue;
   if(runtime.auth.user&&!['running','processing','uploading'].includes(node?.data?.status)){if(button.disabled){button.disabled=false;button.setAttribute('data-studio-generation','true');}button.closest('.generate-btn-container')?.removeAttribute('inert');}
  }
 });};
 const observer=new MutationObserver(refresh);observer.observe(document.body,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['disabled','inert','aria-label','class']});
 document.addEventListener('click',activate,true);document.addEventListener('keydown',shortcuts,true);refresh();
 // These static UI hooks carry no session data and guard the current auth user.
 // Keep them installed across logout/login; identity-bound tasks are cleared by runtime.
 return()=>{disposed=true;releaseTerminal?.();releaseSettled?.();releaseRunningPort?.();scriptTerminalDisplay();for(const button of [...unavailableButtons.keys()])restoreUnavailable(button);for(const button of [...blockedCancelButtons.keys()])restoreCancel(button);const restore:Record<string,Function>={};for(const [name,method]of Object.entries(ownedRunningMethods))if(running()[name]===method)restore[name]=runningMethods[name];if(Object.keys(restore).length)native.c5.setState(restore);runningTokens.clear();capturedTokens.clear();entities?.dispose();observer.disconnect();document.removeEventListener('click',activate,true);document.removeEventListener('keydown',shortcuts,true);style.remove();};
}
