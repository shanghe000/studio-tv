import {equalDraftValue} from './canvas-draft';

/** Frozen W8 omits the local history cache and legacy selection fields when
 * submitting a remote result. Recover only those omissions from the captured
 * node, with the same durable history, displayed media and remote selection.
 * Explicit values and every subsequent canvas edit still pass the full guard. */
export function restoreRemoteHistoryCommandData(submitted:Record<string,any>,captured:Record<string,any>,imageBatch=false):Record<string,any>{
 const history=captured.historyStorage;
 if(history?.source!=='remote'||history.schemaVersion!==1||typeof history.historyId!=='string'||!history.historyId)return submitted;
 const identity=['modelCode','capabilityRef','capabilityVersion','parameterSchemaVersion','output','sourceObjects','imageUrl','videoUrl','audioUrl','assetId','assetIds','selectedHistoryOutputId','selectedHistoryBatchId'];
 if(!identity.every(key=>equalDraftValue(submitted[key],captured[key])))return submitted;
 const projectedHistory={...submitted.historyStorage};
 if(imageBatch&&projectedHistory.imageBatchOrigin===undefined&&history.imageBatchOrigin!==undefined)projectedHistory.imageBatchOrigin=history.imageBatchOrigin;
 if(!equalDraftValue(projectedHistory,history))return submitted;
 const omitted=['nodeOutputHistory','selectedOutputHistoryId','selectedOutputHistoryIndex'];
 if(!omitted.every(key=>!Object.hasOwn(submitted,key)||equalDraftValue(submitted[key],captured[key])))return submitted;
 const patch=Object.fromEntries(omitted.filter(key=>!Object.hasOwn(submitted,key)&&Object.hasOwn(captured,key)).map(key=>[key,structuredClone(captured[key])]));
 return {...submitted,...patch,historyStorage:structuredClone(projectedHistory)};
}
