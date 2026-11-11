import {nativePortraitAlias} from './image-semantic-tools';
import type {NativeModelBindingPort} from './model-bindings';
import {usesNativeImageInputs} from './image-prompt-projection';

const comfyPromptImageRefs=new Set(['flux1-dev-generate-v1','flux2-klein-9b-generate-v1','qwen-image-edit-2511-v1','z-image-turbo-generate-v1','flux2-klein4b-generate-v1']);
/** Only registered prompt-driven image profiles can reopen a saved composer.
 * Fixed Comfy profiles need their persisted exact binding; upscalers have no
 * authored prompt and batch siblings remain uploads in the native selector. */
export function editableGeneratedImageModel(data:any){
 if(['codex-image-generate-v1','codex-image-edit-v1'].includes(data?.capabilityRef??data?.modelCode))return true;
 return comfyPromptImageRefs.has(data?.capabilityRef)&&data.modelCode===data.capabilityRef&&data.capabilityVersion==='1'&&data.parameterSchemaVersion==='1';
}

/** zU creates an editable owner and an input edge before its first request.
 * Native hides both the image toolbar and composer until an output exists.
 * A rejected request must still leave the owner available for a second run. */
function canRetryPortraitWithoutResult(node:any,state:any){
 const data=node.data;
 const model=data.capabilityRef??data.modelCode;
 const status=String(data.status??'idle').toLowerCase();
 const hasOutput=Array.isArray(data.output)?data.output.length>0:!!data.output;
 return data.isPortraitAdjustResult===true
  && ['idle','failed','error','finished'].includes(status)
  && !state?.localRunningNodeIds?.includes(node.id)
  && [nativePortraitAlias,'codex-image-edit-v1','qwen-image-edit-2511-v1'].includes(model)
  && String(data.subType).toLowerCase().replaceAll('_','-')==='image-image'
  && Array.isArray(data.presetSelections)&&data.presetSelections.length>0
  && !hasOutput&&!data.sourceObjects?.length&&!data.imageUrl;
}

/** The frozen image selector treats sourceObjects without incoming edges as an
 * upload, and hides every redraw result. STUDIO stores generated pixels there too.
 * Reopen it for a single durable result or an editable, rejected portrait owner;
 * the native child still owns tool/mask/history overlay exclusion and layout. */
export function generatedImageSelectionProps(props:any,state:any,bindings?:NativeModelBindingPort){
 const selection=props?.imageSelection,originalNode=selection?.targetNode;
 // D1n/wct omits version keys from the inner selector's target too. Restore
 // only the current project's exact binding into a render copy before the
 // editable-profile gate; the manager, native data and callbacks stay intact.
 const node=originalNode&&bindings?.current()?bindings.node(originalNode):originalNode,data=node?.data;
 if(!selection||selection.showParams||selection.showParamsCard||selection.isRead!==false||props.readonly===true||node?.type!=='rh-image'||!data)return props;
 if(state?.selectedNodeIds?.length!==1||state.selectedNodeIds[0]!==node.id||state.isNodeDragging||state.isSelectionDragging||state.isBoxSelectResult)return props;
 if(data.isUpload===true||data.isPoseControlReference===true||data.hidePromptInput===true||data.status==='uploading'||data.localVideoEdit===true)return props;
 if(typeof data.params?.prompt!=='string'||!data.params.prompt.trim())return props;
 const savedResult=selection.showToolbar===true&&editableGeneratedImageModel(data)&&data.historyStorage?.source==='remote'
  &&data.historyStorage.historyId&&Array.isArray(data.output)&&data.output.length>0;
 // A copy intentionally has no task/history ownership. Its exact model and
 // authored parameters still make it a generation node after reload. This is
 // a render-only classification; output pixels never become new inputs.
 const copiedResult=selection.showToolbar===true&&editableGeneratedImageModel(data)&&usesNativeImageInputs(node)
  &&data.capabilityRef===data.modelCode&&typeof data.capabilityVersion==='string'&&!!data.capabilityVersion
  &&typeof data.parameterSchemaVersion==='string'&&!!data.parameterSchemaVersion
  &&['idle','failed','error'].includes(String(data.status??'idle'))&&!data.taskId&&!data.historyStorage?.historyId&&!data.batchOrigin
  &&Array.isArray(data.output)&&data.output.some((value:any)=>typeof value==='string'&&!!value||value&&typeof value==='object'&&(value.url||value.assetId))
  &&!state?.localRunningNodeIds?.includes(node.id);
 if(!savedResult&&!copiedResult&&!canRetryPortraitWithoutResult(node,state))return props;
 if(typeof selection.onGenerate!=='function'||typeof selection.onNodeDataPatch!=='function')return props;
 return{...props,imageSelection:{...selection,targetNode:node,showParams:true}};
}
