import type {NativeGraph} from './graph';
import {equalDraftValue} from './canvas-draft';
import {semanticImageTools,panoramaScenes} from './image-semantic-tools';
import {quickSceneCodes} from './image-quick-scenes';
import {editableGeneratedImageModel} from './image-selection-params';
import {restoreRemoteHistoryCommandData} from './remote-history-command';
const toolType=(node:any)=>String(node?.data?.toolsType||'').toUpperCase().replaceAll('-','_');
const panorama=(node:any)=>toolType(node)==='IMAGE_IMAGE'&&node.data?.panorama?.isPanoramaNode===true&&panoramaScenes.has(node.data?.sceneCode);
/** Frozen o_ submits a single result node; uEt submits result + source and a
 * source/target-only edge. qp has already persisted their actual input edges.
 * Recover omitted ancestors from the synchronously captured graph. Submitted
 * nodes remain untouched, so the caller still checks every input field. */
export function completeNativeImageToolCommand(command:NativeGraph|undefined,baseline:NativeGraph|undefined,targetId:string):NativeGraph|undefined{
 if(!command||!baseline)return command;
 let target=command.nodes.find(node=>node.id===targetId);const mounted=baseline.nodes.find(node=>node.id===targetId);
 if(target?.type!=='rh-image'||mounted?.type!=='rh-image')return command;
 // W8 omits local history fields when re-submitting a remote result, including
 // a populated cache. Restore omissions only for the captured durable result.
 const prior=mounted.data||{},suppliedData=target.data||{},history=prior.historyStorage;
 if(editableGeneratedImageModel(prior)&&Array.isArray(prior.output)&&prior.output.length){
  const data=restoreRemoteHistoryCommandData(suppliedData,prior,true);
  if(data!==suppliedData){
   target={...target,data};command={...command,nodes:command.nodes.map(node=>node.id===targetId?target!:node)};
  }
 }
 const type=toolType(target);
 const single=command.nodes.length===1&&command.edges.length===0&&(semanticImageTools.has(type)||target.data?.isPortraitAdjustResult===true||panorama(target));
 const reopenedTool=history?.source==='remote'&&Array.isArray(prior.output)&&prior.output.length>0&&(semanticImageTools.has(type)||prior.isPortraitAdjustResult===true);
 const composer=(reopenedTool||!type&&['image-image','text-image'].includes(String(target.data?.subType||'').replaceAll('_','-').toLowerCase()))&&typeof mounted.data?.params?.prompt==='string';
 const pair=command.nodes.length===command.edges.length+1&&command.edges.length>0&&(composer||command.nodes.length===2&&(['IMAGE_CUTOUT','IMAGE_CUTOUT_TEXT','IMAGE_ENHANCE','IMAGE_GIGAPIXEL','IMAGE_HD'].includes(type)||type==='IMAGE_IMAGE'&&quickSceneCodes.has(target.data?.sceneCode)));
 if(!single&&!pair||!baseline.edges.some(edge=>edge.target===targetId))return command;
 if(new Set(command.nodes.map(node=>node.id)).size!==command.nodes.length||command.nodes.some(node=>!baseline.nodes.some(saved=>saved.id===node.id)))return command;
 if(pair){
  if(command.edges.length!==baseline.edges.filter(edge=>edge.target===targetId).length||new Set(command.edges.map(edge=>edge.source)).size!==command.edges.length)return command;
  for(const edge of command.edges){const source=command.nodes.find(node=>node.id===edge.source),matches=baseline.edges.filter(saved=>saved.source===edge.source&&saved.target===edge.target);
  // uEt intentionally omits default handles, IDs and display metadata. It
  // cannot override a conditioned edge or substitute another source.
  const ordinaryText=composer&&!type&&source?.type==='rh-text'&&baseline.nodes.find(node=>node.id===source.id)?.type==='rh-text';
  if(source?.type!=='rh-image'&&!ordinaryText||edge.source!==source?.id||edge.target!==targetId||Object.keys(edge).some(key=>key!=='source'&&key!=='target')||matches.length!==1)return command;
  const saved=matches[0];if(saved.conditioningRole!=null||saved.sourceHandle!=null&&saved.sourceHandle!=='output'||saved.targetHandle!=null&&saved.targetHandle!=='input')return command;
  }
 }
 const supplied=new Map(command.nodes.map(node=>[node.id,node]));
 return{...baseline,nodes:baseline.nodes.map(node=>supplied.get(node.id)??node)};
}

/** The frozen editor omits redundant upload metadata from source image nodes.
 * Recover only absent metadata for exactly the same owned source assets; the
 * caller must still compare the complete input closure with the save receipt. */
export function restoreSavedImageUploadMetadata(command:NativeGraph,saved:NativeGraph,targetId:string):NativeGraph{
 return{...command,nodes:command.nodes.map(node=>{
  if(node.id===targetId||node.type!=='rh-image')return node;
  const prior=saved.nodes.find(value=>value.id===node.id),data=node.data||{},metadata=prior?.data;
  if(prior?.type!==node.type||metadata?.isUpload!==true||!Array.isArray(metadata.assetIds)||!metadata.assetIds.length)return node;
  const sources=Array.isArray(data.sourceObjects)&&data.sourceObjects.length?data.sourceObjects:typeof data.imageUrl==='string'?[data.imageUrl]:[];
  if(!sources.length||sources.some((value:any)=>typeof value!=='string'||!value.startsWith('rhtv-asset:')))return node;
  const ids=new Set(sources.map((value:string)=>value.slice('rhtv-asset:'.length)));
  if(metadata.assetIds.length!==ids.size||new Set(metadata.assetIds).size!==ids.size||metadata.assetIds.some((id:any)=>typeof id!=='string'||!ids.has(id)))return node;
  return{...node,data:{...data,...(data.assetIds===undefined?{assetIds:metadata.assetIds}:{}),...(data.isUpload===undefined?{isUpload:true}:{})}};
 })};
}

/** Native generated-image views omit server-owned result/selection metadata.
 * Restore absent fields only from the pre-submit persisted snapshot, and only
 * if the save receipt and the displayed source image still match that snapshot.
 * Never fill user prompt/params/history, overwrite explicit values, or accept a
 * newly changed field merely because the server returned it during the save. */
export function restoreCapturedImageResultMetadata(command:NativeGraph,saved:NativeGraph,captured:NativeGraph|undefined,targetId:string):NativeGraph{
 if(!captured)return command;
 return{...command,nodes:command.nodes.map(node=>{
  const receipt=saved.nodes.find(n=>n.id===node.id),base=captured.nodes.find(n=>n.id===node.id),data=node.data||{},prior=base?.data;
  if(node.id!==targetId&&node.type==='rh-text'&&base?.type==='rh-text'&&receipt?.type==='rh-text'&&!data.hidePromptInput&&prior?.historyStorage?.source==='remote'&&prior.historyStorage.historyId){
   const identity=['modelCode','capabilityRef','capabilityVersion','parameterSchemaVersion','historyStorage','text','content','prompt','params','output','selectedHistoryOutputId','selectedOutputHistoryId','selectedOutputHistoryIndex'];
   if(identity.every(key=>equalDraftValue(data[key],prior[key])&&equalDraftValue(receipt.data?.[key],prior[key]))){
    const keys=['routerParameters','userPromptSnapshot'];
    // WFr's native data schema also omits the ordinary text UI category. This
    // exact historical source identity was already persisted before submit;
    // restore only its known normal-text category, never a new or changed one.
    if(prior.textUiCategory==='text-text'&&typeof prior.capabilityRef==='string'&&prior.modelCode===prior.capabilityRef&&typeof prior.capabilityVersion==='string'&&Array.isArray(prior.output)&&prior.output.length)keys.push('textUiCategory');
    const patch=Object.fromEntries(keys.filter(key=>data[key]===undefined&&prior[key]!==undefined&&equalDraftValue(receipt.data?.[key],prior[key])).map(key=>[key,structuredClone(prior[key])]));
    if(Object.keys(patch).length)return{...node,data:{...data,...patch}};
   }
  }
  if(node.type!=='rh-image')return node;
  // Generated source images have remote history; some also have batchOrigin.
  // Restore only the two omitted execution fields from the pre-submit source,
  // with identical model/version, history selection and owned result media.
  if(node.id!==targetId&&base?.type==='rh-image'&&receipt?.type==='rh-image'&&prior?.historyStorage?.source==='remote'&&prior.historyStorage.historyId&&data.isUpload!==true){
   const identity=['modelCode','capabilityRef','capabilityVersion','parameterSchemaVersion','historyStorage','imageUrl','sourceObjects','output','selectedHistoryOutputId','selectedOutputHistoryId'];
   if(identity.every(key=>equalDraftValue(data[key],prior[key])&&equalDraftValue(receipt.data?.[key],prior[key]))){
    const patch=Object.fromEntries(['routerParameters','userPromptSnapshot'].filter(key=>data[key]===undefined&&prior[key]!==undefined&&equalDraftValue(receipt.data?.[key],prior[key])).map(key=>[key,structuredClone(prior[key])]));
    // A generated source can also carry batch ownership metadata below.
    // Keep both independently verified repairs instead of returning after
    // only its omitted execution fields have been restored.
    if(Object.keys(patch).length)node={...node,data:{...data,...patch}};
   }
  }
  if(base?.type!=='rh-image'||receipt?.type!=='rh-image'||!prior?.batchOrigin||!Array.isArray(prior.assetIds)||prior.assetIds.length!==1)return node;
  const refs=Array.isArray(data.sourceObjects)&&data.sourceObjects.length?data.sourceObjects:typeof data.imageUrl==='string'?[data.imageUrl]:[];
  if(refs.length!==1||refs[0]!=='rhtv-asset:'+prior.assetIds[0]||!equalDraftValue(receipt.data?.assetIds,prior.assetIds))return node;
  if(node.id===targetId&&!equalDraftValue(data.historyStorage,prior.historyStorage))return node;
  const patch:Record<string,any>={};
  const keys=node.id===targetId?['assetIds','batchOrigin']:['assetIds','batchOrigin','routerParameters','testMode','userPromptSnapshot'];
  for(const key of keys)if(data[key]===undefined&&prior[key]!==undefined&&equalDraftValue(receipt.data?.[key],prior[key]))patch[key]=structuredClone(prior[key]);
  return Object.keys(patch).length?{...node,data:{...node.data,...patch}}:node;
 })};
}

/** The portrait constructor omits maxConnect. Mounting the native panel writes
 * this all-null rule when the catalog declares no extra port limits. The
 * model, actual edges and any explicit/finite limit remain execution inputs. */
export function nativePortraitPortDefaults(node:any):boolean{
 return node?.type==='rh-image'&&node.data?.isPortraitAdjustResult===true
  &&equalDraftValue(node.data.maxConnect,{text:null,image:null,video:null});
}
