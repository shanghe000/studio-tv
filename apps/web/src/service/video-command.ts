import type {NativeGraph} from './graph';
import {equalDraftValue} from './canvas-draft';
import {isH3} from './h3-input';
import {isVideoCapability} from './video-parameter-options';
import type {Capability} from './model-catalog';
import {restoreRemoteHistoryCommandData} from './remote-history-command';
import type {NativeTextProjection} from './image-prompt-projection';
import {canvasImageSource,canvasSourceMediaReferences,orderCanvasMediaReferences} from './canvas-media-reference';
/** The frozen video composer transmits direct source/target pairs without IDs
 * or handles. Restore only an exact projection of the mounted input edges. */
export function completeNativeVideoCommand(command:NativeGraph|undefined,baseline:NativeGraph|undefined,targetId:string,capability?:Capability){
 if(!command||!baseline)return command;
 const target=command.nodes.find(n=>n.id===targetId),mounted=baseline.nodes.find(n=>n.id===targetId);
 const video=String(target?.data?.modelCode||'').startsWith('h3-')||capability?.capabilityRef===target?.data?.modelCode&&isVideoCapability(capability);
 if(target?.type==='rh-video'&&mounted?.type==='rh-video'&&video){
  const data=restoreRemoteHistoryCommandData(target.data||{},mounted.data||{});
  if(data!==target.data)command={...command,nodes:command.nodes.map(n=>n.id===targetId?{...n,data}:n)};
 }
 if(target?.type!=='rh-video'||mounted?.type!=='rh-video'||!video||command.nodes.length!==command.edges.length+1)return command;
 if(new Set(command.nodes.map(n=>n.id)).size!==command.nodes.length||command.nodes.some(n=>!baseline.nodes.some(saved=>saved.id===n.id&&saved.type===n.type)))return command;
 const incoming=baseline.edges.filter(e=>e.target===targetId);
 if(command.edges.length!==incoming.length||new Set(command.edges.map(e=>e.source)).size!==command.edges.length)return command;
 for(const edge of command.edges){const matches=incoming.filter(saved=>saved.source===edge.source&&saved.target===edge.target);if(edge.target!==targetId||Object.keys(edge).some(k=>k!=='source'&&k!=='target')||matches.length!==1||!command.nodes.some(n=>n.id===edge.source))return command;const saved=matches[0];if(saved.conditioningRole!=null||saved.sourceHandle!=null&&saved.sourceHandle!=='output'||saved.targetHandle!=null&&saved.targetHandle!=='input')return command;}
 const supplied=new Map(command.nodes.map(n=>[n.id,n]));return{...baseline,nodes:baseline.nodes.map(n=>supplied.get(n.id)??n)};
}

/** Recompute the native modal reference list without accepting arbitrary new
 * assets from the command. Ordered keys use the existing nodeId::asset grammar. */
export function nativeVideoReferences(node:any,graph:NativeGraph,kind:'image'|'video'|'audio',options:{nativeComposer?:boolean}={}):string[]|undefined{
 const rows:{key:string;url:string}[]=[];
 for(const edge of graph.edges.filter(e=>e.target===node.id)){
  const source=graph.nodes.find(n=>n.id===edge.source);
  if(options.nativeComposer&&(!source||edge.conditioningRole!=null||edge.sourceHandle!=null&&edge.sourceHandle!=='output'||edge.targetHandle!=null&&edge.targetHandle!=='input'))return;
  if(!source||(kind==='image'?!canvasImageSource(source.type):source.type!=='rh-'+kind))continue;
  const d=source.data||{};if(d.selectedOutputHistoryId&&!options.nativeComposer)return;
  if(options.nativeComposer){
   const values=canvasSourceMediaReferences(source,kind);if(!values?.length)return;
   for(const url of values){if(!url.startsWith('rhtv-asset:'))return;rows.push({key:source.id+'::'+url,url});}
   continue;
  }
  const outputs=Array.isArray(d.output)?d.output:d.output?[d.output]:[];
  let chosen=d.selectedHistoryOutputId?outputs.find((o:any)=>o?.historyOutputId===d.selectedHistoryOutputId)??outputs[0]:outputs[0];
  const out=typeof chosen==='string'?chosen:chosen?.url;
  const values=out?[out]:[...(Array.isArray(d.sourceObjects)?d.sourceObjects:d.sourceObjects?[d.sourceObjects]:[]),...(typeof d[kind+'Url']==='string'?[d[kind+'Url']]:[]),...(options.nativeComposer&&kind==='video'&&typeof d.sourceVideo==='string'?[d.sourceVideo]:[])];
  if(options.nativeComposer&&!values.length)return;
  for(const url of new Set(values)){if(typeof url!=='string'||!url.startsWith('rhtv-asset:'))return;rows.push({key:source.id+'::'+url,url});}
 }
 if(options.nativeComposer)for(const mention of Array.isArray(node.data?.mentionAssets)?node.data.mentionAssets:[]){
  const type=String(mention?.type||'IMAGE').toUpperCase();if(type==='TEXT'||(type==='VIDEO'?'video':type==='AUDIO'?'audio':'image')!==kind)continue;
  const url=typeof mention?.url==='string'?mention.url.trim():'';if(!url.startsWith('rhtv-asset:'))return;if(!rows.some(row=>row.key===url))rows.push({key:url,url});
 }
 const order=node.data?.[kind+'Order']??node.data?.params?.[kind+'Order'];
 if(options.nativeComposer)return orderCanvasMediaReferences(rows.map(({key,url})=>({nodeId:key===url?'':key.slice(0,key.length-url.length-2),url})),order).map(row=>row.url);
 if(Array.isArray(order)){
  const rank=(row:{key:string;url:string})=>order.indexOf(row.key);
  rows.sort((a,b)=>{const x=rank(a),y=rank(b);return(x<0?Infinity:x)-(y<0?Infinity:y)});
 }
 if(!rows.length){if(options.nativeComposer)return[];const current=node.data?.params?.[kind+'Urls'];if(Array.isArray(current))return current.every((v:any)=>typeof v==='string'&&v.startsWith('rhtv-asset:'))?current:undefined;return current?[current]:[];}
 return rows.map(r=>r.url);
}

/** q_ appends direct text sources and explicit text mentions to the authored
 * prompt. Rich text must use the mounted native serializer, never HTML regexes. */
export function nativeVideoComposedPrompt(raw:string,node:any,graph:NativeGraph,projectText?:NativeTextProjection):string|undefined{
 if(node?.type!=='rh-video'||node.data?.isStoryboard||node.data?.localVideoEdit)return;
 const parts:string[]=[];
 for(const edge of graph.edges.filter(value=>value.target===node.id)){
  const source=graph.nodes.find(value=>value.id===edge.source);if(!source)return;
  if(!['rh-text','text-input','text'].includes(source.type))continue;
  if(edge.conditioningRole!=null||edge.sourceHandle!=null&&edge.sourceHandle!=='output'||edge.targetHandle!=null&&edge.targetHandle!=='input')return;
  const data=source.data||{},title=String(data.title||data.label||'').trim();if(raw.trim()&&(data._isPromptTextNode===true||data.agentCreated===true&&/提示词$/.test(title)))continue;
  let value=typeof data.text==='string'&&data.text?data.text:typeof data.content==='string'?data.content:'';
  if(/<[a-z][\s\S]*>/i.test(value)){if(!projectText)return;try{const projected=projectText(value);if(typeof projected!=='string')return;value=projected;}catch{return;}}
  if(value.trim())parts.push(value);
 }
 const mentions=(Array.isArray(node.data?.mentionAssets)?node.data.mentionAssets:[]).filter((value:any)=>String(value?.type||'').toUpperCase()==='TEXT').map((value:any)=>String(value.text||'').trim()).filter(Boolean);
 return[raw,parts.join('\n'),mentions.join('\n')].filter(Boolean).join('\n');
}

/** A frozen snapshot is a reversible projection only when its exact current
 * text composition still matches. A new authored prompt stays unchanged. */
export function normalizeNativeVideoPrompt(data:any,node:any,graph:NativeGraph,projectText?:NativeTextProjection):any{
 const snapshot=data?.userPromptSnapshot;if(snapshot?.paramName!=='prompt'||typeof snapshot.value!=='string')return data;
 const composed=nativeVideoComposedPrompt(snapshot.value,{...node,data},graph,projectText);if(composed===undefined||data.params?.prompt!==composed)return data;
 const params={...data.params,prompt:snapshot.value};if(params.text===composed)params.text=snapshot.value;
 return{...data,params,...(data.prompt===composed?{prompt:snapshot.value}:{})};
}

export interface NativeVideoInputProjection {data:any;references:Record<'image'|'video'|'audio',string[]>;composedPrompt:string|undefined;error?:string}
export function usesNativeVideoInputs(node:any):boolean{
 const data=node?.data||{};return node?.type==='rh-video'&&!data.isUpload&&!data.isStoryboard&&!data.localVideoEdit&&!data.toolsSourceUrl&&!data.sourceNodeId&&!data.autoCreatedByAiApp;
}
/** Explicitly native canvas only: the frozen picker creates nodes/edges (pye),
 * while inline references live in mentionAssets (j8). params.*Urls are its last
 * execution projection. This read-only candidate never clears results/history or
 * changes the mounted graph. Direct API callers keep the three-argument reader. */
export function projectNativeVideoInputs(node:any,graph:NativeGraph,projectText?:NativeTextProjection):NativeVideoInputProjection|undefined{
 const data=node?.data||{};
 if(!usesNativeVideoInputs(node))return;
 const references={} as NativeVideoInputProjection['references'];let error:string|undefined;
 for(const kind of ['image','video','audio'] as const){const rows=nativeVideoReferences(node,graph,kind,{nativeComposer:true});references[kind]=rows??[];if(!rows)error??=`当前${{image:'图片',video:'视频',audio:'音频'}[kind]}参考连线或素材尚不可用，请重新连接已有结果或移除该参考。`;}
 const normalized=normalizeNativeVideoPrompt(data,node,graph,projectText),params={...normalized.params};for(const kind of ['image','video','audio'] as const)params[kind+'Urls']=references[kind];
 const projected=error?data:{...normalized,params},raw=typeof projected.params?.prompt==='string'?projected.params.prompt:'';
 const composedPrompt=nativeVideoComposedPrompt(raw,{...node,data:projected},graph,projectText);if(composedPrompt===undefined)error??='当前文字连线无法安全读取，请重新连接文字节点后再生成。';
 return{data:error?data:projected,references,composedPrompt,error};
}

/** Native hydration omits prior execution metadata from generated source nodes.
 * Restore absent fields only for the identical frozen model, history and media;
 * source edits and target command values must still pass the full guard. */
export function restoreSavedVideoSourceMetadata(command:NativeGraph,saved:NativeGraph,targetId:string):NativeGraph{
 return {...command,nodes:command.nodes.map(node=>{
  if(node.id===targetId||node.type!=='rh-video')return node;
  const prior=saved.nodes.find(n=>n.id===node.id),data=node.data||{},persisted=prior?.data;
  if(prior?.type!==node.type||!data.historyStorage?.historyId||!persisted)return node;
  for(const key of ['modelCode','capabilityRef','capabilityVersion','parameterSchemaVersion','historyStorage','videoUrl','sourceObjects','output','selectedHistoryOutputId','selectedOutputHistoryId'])if(!equalDraftValue(data[key],persisted[key]))return node;
  const restored={...data};for(const key of ['routerParameters','userPromptSnapshot'])if(data[key]===undefined&&persisted[key]!==undefined)restored[key]=structuredClone(persisted[key]);
  return {...node,data:restored};
 })};
}

const h3Refs=new Set(['h3-first-frame-v1','h3-first-last-frame-v1','h3-reference-v1','h3-video-reference-v1']);
/** Capability inspection uses input pixels, never the target's last result.
 * This projection is not saved: history and display fields remain on canvas. */
export function canvasMediaInputProjection(target:any,graph:NativeGraph,capability?:Capability):NativeGraph{
 const ref=target?.data?.capabilityRef??target?.data?.modelCode;
 const advertised=capability&&capability.capabilityRef===ref&&capability.available&&capability.testMode===false&&capability.model;
 if(!(target?.type==='rh-video'&&(h3Refs.has(ref)||advertised&&(isH3(capability)||isVideoCapability(capability))))&&!(target?.type==='rh-image'&&(['codex-image-generate-v1','codex-image-edit-v1'].includes(ref)||advertised&&['TEXT_TO_IMAGE','IMAGE_TO_IMAGE','IMAGE_ENHANCE'].includes(capability.kind)&&capability.outputKinds?.includes('IMAGE'))))return graph;
 const direct=new Set(graph.edges.filter(e=>e.target===target.id).map(e=>e.source));
 const media=new Set(['rh-image','rh-role','rh-scene','rh-entity','rh-video','rh-audio']);
 const display=['sourceObjects','imageUrl','videoUrl','audioUrl','assetId','assetIds'];
 return {...graph,nodes:graph.nodes.filter(n=>n.id===target.id||direct.has(n.id)||!media.has(n.type)).map(n=>{
  if(n.id===target.id){const data={...n.data};for(const key of display)delete data[key];return{...n,data};}
  if(!media.has(n.type))return n;
  return{...n,data:Object.fromEntries([...display,'output'].filter(key=>Object.hasOwn(n.data||{},key)).map(key=>[key,n.data[key]]))};
 })};
}
