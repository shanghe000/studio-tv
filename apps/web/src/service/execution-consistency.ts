import {ApiError} from '../api/client';
import type {Capability} from './model-catalog';
import {equalDraftValue,type DraftConflict} from './canvas-draft';
import {withPreflightContext,type PreflightComponent} from './preflight';

/** Convert internal paths to bounded diagnostic symbols. Node data and custom
 * keys never leave the client; only a validated node ID survives sanitation. */
export function draftConflictDiagnostic(conflict:DraftConflict):{reason:DraftConflict['reason'];component:PreflightComponent;sourceNodeId?:string}{
 const parts=conflict.path.split('/').slice(1).map(part=>part.replaceAll('~1','/').replaceAll('~0','~'));
 let component:PreflightComponent='METADATA';
 const field=parts[3];
 if(parts[0]==='edges'||conflict.reason==='DANGLING_REFERENCE')component='TOPOLOGY';
 else if(conflict.reason==='MODEL_PARAMETERS'||field==='modelSelection'||['modelCode','capabilityRef','capabilityVersion','parameterSchemaVersion','subType'].includes(field))component='MODEL';
 else if(parts[0]==='nodes'&&parts.length===2||conflict.reason==='DELETE_EDIT'&&parts.length===2)component='IDENTITY';
 else if(['prompt','text','content','userPromptSnapshot'].includes(field)||field==='params'&&['prompt','text'].includes(parts[4]))component='PROMPT';
 else if(['historyStorage','nodeOutputHistory','selectedHistoryOutputId','selectedOutputHistoryId','selectedHistoryBatchId','selectedOutputHistoryIndex'].includes(field))component='HISTORY';
 else if(['imageOrder','videoOrder','audioOrder','sourceObjects','imageUrl','videoUrl','audioUrl','assetId','assetIds'].includes(field))component='REFERENCES';
 else if(field==='output')component='OUTPUT';
 else if(['params','routerParameters','generateNum'].includes(field))component='PARAMETERS';
 else if(['presetSelections','promptCodes','cameraControl','styleName','stylePrompt','sceneCode'].includes(field))component='PRESETS';
 return{reason:conflict.reason,component,...(parts[0]==='nodes'?{sourceNodeId:parts[1]}:{})};
}

export function executionInputFailure(cap:Capability|undefined,phase:'command'|'snapshot',component:PreflightComponent,nodeId:string,message:string){
 return withPreflightContext(new ApiError(409,'STALE_EXECUTION_INPUT',message),{schemaVersion:'1',...(cap?{capabilityRef:cap.capabilityRef,capabilityVersion:cap.version,requestedKind:cap.kind}:{}),issues:[{field:phase==='command'?'inputs.command':'inputs.snapshot',reason:phase==='command'?'COMMAND_MISMATCH':'INPUT_CHANGED',component,sourceNodeId:nodeId}]});
}

/** Explain a rejected comparison using fixed symbols only. Never return field
 * values or arbitrary user-defined keys from the graph. */
export function executionDifference(before:any,after:any,targetId:string):{component:PreflightComponent;nodeId:string}{
 if(!equalDraftValue(before.edges,after.edges))return{component:'TOPOLOGY',nodeId:targetId};
 const prior=new Map<string,any>((before.nodes??[]).map((node:any)=>[node.id,node]));
 for(const node of after.nodes??[]){
  const previous=prior.get(node.id);if(!previous)return{component:'IDENTITY',nodeId:node.id};prior.delete(node.id);
  if(node.type!==previous.type)return{component:'MODEL',nodeId:node.id};
  for(const key of new Set([...Object.keys(previous.data??{}),...Object.keys(node.data??{})])){
   const a=previous.data?.[key],b=node.data?.[key];if(equalDraftValue(a,b))continue;
   let component:PreflightComponent='METADATA';
   if(['modelCode','capabilityRef','capabilityVersion','parameterSchemaVersion','modelType','subType','toolsType'].includes(key))component='MODEL';
   else if(['prompt','text','content','userPromptSnapshot'].includes(key))component='PROMPT';
   else if(['imageOrder','videoOrder','audioOrder','sourceObjects','toolsSourceUrl','imageUrl','videoUrl','audioUrl','assetId','assetIds'].includes(key))component=node.id===targetId?'OUTPUT':'REFERENCES';
   else if(['presetSelections','promptCodes','cameraControl','styleName','stylePrompt','sceneCode'].includes(key))component='PRESETS';
   else if(['historyStorage','nodeOutputHistory','selectedOutputHistoryId','selectedHistoryOutputId','selectedHistoryBatchId','selectedOutputHistoryIndex'].includes(key))component='HISTORY';
   else if(key==='output')component=node.id===targetId?'OUTPUT':'REFERENCES';
   else if(key==='maxConnect')component='TOPOLOGY';
   else if(key==='routerParameters'||key==='generateNum')component='PARAMETERS';
   else if(key==='params'){
    const changed=[...new Set([...Object.keys(a??{}),...Object.keys(b??{})])].filter(name=>!equalDraftValue(a?.[name],b?.[name]));
    component=changed.some(name=>['prompt','text'].includes(name))?'PROMPT':changed.some(name=>['imageUrls','imageUrl','videoUrls','videoUrl','audioUrls','audioUrl','imageOrder','videoOrder','audioOrder'].includes(name))?'REFERENCES':'PARAMETERS';
   }
   return{component,nodeId:node.id};
  }
 }
 return{component:'IDENTITY',nodeId:prior.keys().next().value??targetId};
}
