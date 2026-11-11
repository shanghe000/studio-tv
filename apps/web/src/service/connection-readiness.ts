import type {Capability} from './model-catalog';
import {mediaInputContract} from './official-video-input-contract';
import type {NativeGraph} from './graph';
import type {Asset} from '../api/types';
import {isAudioExtraction} from './audio-extraction-input';
import {isGenerationTarget} from './generation-readiness';
import {canvasImageSource,canvasSourceMediaReferences,orderCanvasMediaReferences} from './canvas-media-reference';
import {usesNativeImageInputs} from './image-prompt-projection';
import {usesNativeVideoInputs} from './video-command';

export interface CanvasConnection {source:string;target:string;sourceHandle?:string|null;targetHandle?:string|null}
export interface ConnectionReadiness {allowed:boolean;code?:string;reason?:string;needsInspection?:boolean}
export interface ReadinessMaterial {kind:'IMAGE'|'VIDEO'|'AUDIO';reference:string;sourceNodeId:string;pending:boolean}
const media=['IMAGE','VIDEO','AUDIO'] as const;
const label={IMAGE:'图片',VIDEO:'视频',AUDIO:'音频',TEXT:'文字',STRUCTURED:'结构化内容'};
const list=(value:any):string[]=>Array.isArray(value)?value.filter(value=>typeof value==='string'&&!!value):typeof value==='string'&&value?[value]:[];
const sourceKind=(node:any):ReadinessMaterial['kind']|undefined=>canvasImageSource(node?.type)?'IMAGE':node?.type==='rh-video'?'VIDEO':node?.type==='rh-audio'?'AUDIO':node?.data?.imageUrl?'IMAGE':undefined;
export function nodeReadinessMaterials(node:any,graph:NativeGraph,encode:(value:string)=>string=value=>value):ReadinessMaterial[]{
 const materials:ReadinessMaterial[]=[],seen=new Set<string>();let directImage=false;
 const add=(kind:ReadinessMaterial['kind'],reference:string,sourceNodeId:string,pending=false)=>{let canonical=reference;try{canonical=encode(reference);}catch{}const key=kind+':'+sourceNodeId+':'+canonical;if(seen.has(key))return;seen.add(key);materials.push({kind,reference:canonical,sourceNodeId,pending});};
 for(const edge of graph.edges.filter(edge=>edge.target===node.id)){
  const source=graph.nodes.find(source=>source.id===edge.source),kind=sourceKind(source);if(!source||!kind)continue;const data=source.data??{};
  if(kind==='IMAGE')directImage=true;
  const references=canvasSourceMediaReferences(source,kind.toLowerCase() as 'image'|'video'|'audio');
  if(!references?.length)add(kind,'node:'+source.id,source.id,true);else for(const reference of references)add(kind,reference,source.id,data.status==='uploading'||data.uploading===true||!!data.uploadError||!!data.selectedOutputHistoryId);
 }
 // Native canvas video params contain the last run's projection. Disconnecting
 // its sources must also remove them from hover validation, as on submission.
 if(!usesNativeVideoInputs(node)&&!usesNativeImageInputs(node))for(const kind of media)if(!materials.some(item=>item.kind===kind)){const key=kind.toLowerCase();for(const value of [...list(node.data?.params?.[key+'Urls']),...list(node.data?.params?.[key+'Url'])])add(kind,value,node.id);}
 for(const mention of Array.isArray(node.data?.mentionAssets)?node.data.mentionAssets:[]){
  const type=String(mention?.type||'').toUpperCase(),url=typeof mention?.url==='string'?mention.url.trim():'';
  if(type==='TEXT'||!url)continue;const kind=type==='VIDEO'?'VIDEO':type==='AUDIO'?'AUDIO':'IMAGE';add(kind,url,node.id,url.startsWith('blob:'));
 }
 const style=node.data?.presetSelections?.find((row:any)=>row?.key==='styleLibrary')?.referenceImageUrl;
 if(typeof style==='string'&&style){
  let canonical=style;try{canonical=encode(style);}catch{}
  const images=materials.filter(item=>item.kind==='IMAGE'),mentionedImage=node.data?.mentionAssets?.some((mention:any)=>!['TEXT','VIDEO','AUDIO'].includes(String(mention?.type||'').toUpperCase()));
  const ordered=directImage||mentionedImage?orderCanvasMediaReferences(images.map(item=>({nodeId:item.sourceNodeId===node.id?'':item.sourceNodeId,url:item.reference})),node.data?.imageOrder,encode):images.map(item=>({url:item.reference}));
  if(ordered.at(-1)?.url!==canonical)add('IMAGE',canonical,node.id);
 }
 return materials;
}
export function selectedReadinessCapability(node:any,caps:readonly Capability[]):Capability|undefined{
 const ref=node?.data?.capabilityRef??node?.data?.modelCode,version=node?.data?.capabilityVersion;
 return caps.find(cap=>cap.capabilityRef===ref&&(!version||cap.version===version));
}
export function readinessMediaLimit(cap:any,kind:ReadinessMaterial['kind']):number|undefined{
 const schema=cap.parameterSchema??{},limits=schema['x-media-limits'],input=schema['x-input-constraints'],declared=limits?.[kind]??input?.['max_'+kind.toLowerCase()+'s']??cap.studioVideoInputGuidance?.materials?.find((row:any)=>row.kind===kind)?.maximum;if(Number.isSafeInteger(declared)&&declared>=0)return declared;
 const fields=cap.config?.filter((field:any)=>field.type===kind.toLowerCase()+'Urls'||field.type===kind.toLowerCase()+'Url')??[],maximum=fields.find((field:any)=>Number.isFinite(field.maxNum)&&field.maxNum>0)?.maxNum;
 if(maximum!==undefined)return maximum;
 if(kind==='IMAGE'&&cap.capabilityRef==='codex-image-edit-v1')return cap.version==='3'?4:1;
 if(cap.inputKinds&&!cap.inputKinds.includes(kind))return 0;
 return undefined;
}
/** A connected node can still be repaired by adding missing inputs. This
 * checks only new forbidden facts, never the final minimum requirements. */
export function readinessModelInputReason(cap:any,materials:readonly ReadinessMaterial[],inputs:readonly string[]=[]):string|undefined{
 const kinds=[...new Set([...inputs,...materials.map(item=>item.kind)])],unsupported=kinds.filter(kind=>Array.isArray(cap.inputKinds)&&!cap.inputKinds.includes(kind));
 if(unsupported.length)return `此模型不支持${unsupported.map(kind=>(label as any)[kind]??'当前类型').join('、')}输入，请移除对应素材或选择兼容模型。`;
 if(cap.parameterSchema?.['x-video-mode']==='TEXT_TO_VIDEO'&&materials.length)return '文生视频不使用参考素材，请先移除参考素材或对应连线。';
 for(const kind of media){const limit=readinessMediaLimit(cap,kind),count=materials.filter(item=>item.kind===kind).length;if(limit!==undefined&&count>limit)return limit?`此模型最多支持 ${limit} 项${label[kind]}参考，当前有 ${count} 项，请移除多余素材。`:`此模型不支持${label[kind]}参考，请移除对应素材或切换模型。`;}
 if(cap.parameterSchema?.['x-video-mode']==='FIRST_LAST_FRAME'){
  const images=materials.filter(item=>item.kind==='IMAGE'&&!item.pending);if(new Set(images.map(item=>item.reference)).size!==images.length)return '当前首尾帧需要两份不同的图片素材，同一素材的两个节点不能分别用作首帧和尾帧。';
 }
 const total=cap.parameterSchema?.['x-media-total-limit']??cap.parameterSchema?.['x-input-constraints']?.max_references??cap.studioVideoInputGuidance?.maximumTotal;
 if(Number.isFinite(total)&&materials.length>total)return `此模型参考素材合计最多 ${total} 项，当前有 ${materials.length} 项。`;
 return undefined;
}
/** Synchronous ReactFlow hover gate. Unknown model/history/asset metadata is
 * left for the asynchronous generation inspector; it is never called ready. */
export function inspectCanvasConnection(connection:CanvasConnection,graph:NativeGraph,caps:readonly Capability[],options:{assets?:ReadonlyMap<string,Asset>;encodeAsset?:(value:string)=>string}={}):ConnectionReadiness{
 const deny=(code:string,reason:string):ConnectionReadiness=>({allowed:false,code,reason}),source=graph.nodes.find(node=>node.id===connection.source),target=graph.nodes.find(node=>node.id===connection.target);
 if(!source||!target)return deny('CONNECTION_NODE_MISSING','连线节点已变化，请重新连接。');
 if(source.id===target.id)return deny('CONNECTION_SELF','节点不能连接自身。');
 if(['group','rh-group','comment','rh-comment'].includes(source.type)||['group','rh-group','comment','rh-comment'].includes(target.type))return deny('CONNECTION_NODE_UNSUPPORTED','请连接具体内容节点的输出端与输入端。');
 if(connection.sourceHandle!=null&&connection.sourceHandle!=='output'||connection.targetHandle!=null&&connection.targetHandle!=='input')return deny('CONNECTION_PORT_UNSUPPORTED','请从节点输出端连接到目标节点输入端。');
 if(graph.edges.some(edge=>edge.source===source.id&&edge.target===target.id))return deny('CONNECTION_DUPLICATE','这两个节点已经连接，无需重复添加。');
 const reachable=new Set([target.id]);for(let pass=0;pass<graph.nodes.length;pass++){let changed=false;for(const edge of graph.edges)if(reachable.has(edge.source)&&!reachable.has(edge.target)){reachable.add(edge.target);changed=true;}if(!changed)break;}
 if(reachable.has(source.id))return deny('CONNECTION_CYCLE','这条连线会形成循环，请调整连接方向。');
 if(isAudioExtraction(target)){
  if(source.type!=='rh-video'||graph.edges.some(edge=>edge.target===target.id))return deny('MODEL_INPUT_UNSUPPORTED','提取音轨只接受一个视频，请先移除其他连线。');
  return {allowed:true,needsInspection:true};
 }
 if(!['rh-image','rh-video','rh-text','rh-script','rh-storyboard'].includes(target.type))return{allowed:true,needsInspection:true};
 const cap=selectedReadinessCapability(target,caps);if(!cap)return{allowed:true,needsInspection:true};
 const prospective={...graph,edges:[...graph.edges,{id:'studio-readiness-proposal',...connection}]},materials=nodeReadinessMaterials(target,prospective,options.encodeAsset);
 const kind=sourceKind(source),input=source.type==='rh-text'?'TEXT':['rh-script','rh-storyboard'].includes(source.type)?'STRUCTURED':kind;const reason=readinessModelInputReason(cap,materials,input?[input]:[]);if(reason)return deny('MODEL_INPUT_UNSUPPORTED',reason);
 const constraint=mediaInputContract(cap);let needsInspection=false;
 for(const item of materials){const asset=item.reference.startsWith('rhtv-asset:')?options.assets?.get(item.reference.slice(11)):undefined;if(!asset||item.pending){needsInspection=true;continue;}const limits=constraint?.schemaVersion==='1'?constraint.kinds?.[item.kind]:undefined;
  const name=label[item.kind]+(asset.fileName?'“'+asset.fileName+'”':'');
  const mime=asset.mimeType?.split(';')[0].trim().toLowerCase();
  if(limits?.mimeTypes&&(!limits.mimeTypes.length||mime&&!limits.mimeTypes.includes(mime)))
   return deny('MEDIA_INPUT_INVALID',`${name}的文件格式无法供当前模型读取，请更换参考素材。`);
  if(limits?.maxBytes&&asset.byteSize&&asset.byteSize>limits.maxBytes)
   return deny('MEDIA_INPUT_INVALID',`${name}为 ${Math.ceil(asset.byteSize/1048576*1000)/1000} MiB，超过当前参考上限 ${limits.maxBytes/1048576} MiB，请更换素材后再连接。`);
  const duration=asset.durationSeconds?asset.durationSeconds*1000:undefined;if(duration!==undefined&&(limits?.maxDurationMs&&duration>limits.maxDurationMs||limits?.minDurationMs&&duration<limits.minDurationMs))return deny('MEDIA_INPUT_INVALID',`${label[item.kind]}时长不符合此模型要求，请裁剪或更换素材后再连接。`);
 }
 return{allowed:true,...(needsInspection?{needsInspection:true}:{})};
}
export function generationReadinessNodeIds(graph:NativeGraph,id:string):string[]{
 const node=graph.nodes.find(node=>node.id===id);if(!node)return[];if(!['group','rh-group'].includes(node.type))return isGenerationTarget(node)?[id]:[];const selected=new Set<string>([id]);
 for(let pass=0;pass<graph.nodes.length;pass++){let added=false;for(const candidate of graph.nodes){const parents=[candidate.parentId,candidate.parentNode],declared=graph.nodes.some(group=>selected.has(group.id)&&group.data?.nodeIds?.includes(candidate.id));if(!selected.has(candidate.id)&&(parents.some(parent=>selected.has(parent))||declared)){selected.add(candidate.id);added=true;}}if(!added)break;}
 return graph.nodes.filter(candidate=>selected.has(candidate.id)&&isGenerationTarget(candidate)).map(candidate=>candidate.id);
}
