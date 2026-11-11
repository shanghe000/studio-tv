import {semanticImageTools} from './image-semantic-tools';
import type {NativeGraph} from './graph';
import {canvasImageSource,canvasSourceMediaReferences,orderCanvasMediaReferences} from './canvas-media-reference';
/** Reproduce only the frozen image composer's public Cq/Cye + camera chunk
 * projection. This is a draft-equivalence check, never template authority:
 * the server independently validates selectors and freezes them as USER data. */
export type NativeTextProjection=(value:string)=>string;
const text=(value:unknown)=>String(value??'').trim();
const promptCode=(row:any)=>text(row?.promptCode??row?.prompt_code);
export const nativeImagePromptCodes=(data:any):string[]=>[...new Set<string>((Array.isArray(data?.presetSelections)?data.presetSelections:[]).map(promptCode).filter(Boolean))];
const noStyle=(row:any)=>['无','none','无特定风格'].includes(text(row?.name??row?.label).toLowerCase());
const presetText=(row:any)=>!row||typeof row!=='object'||promptCode(row)?'':text(row.prompt??row.prefixPrompt??row.STYLE_PROMPTS??row.FILM_FILTER_PROMPTS??row.VIEW_MODE_PROMPTS??row.stylePrompt??row.des);
export function nativeImageComposedPrompt(raw:string,data:any):string;
export function nativeImageComposedPrompt(raw:string,data:any,node:any,graph:NativeGraph,projectText?:NativeTextProjection):string|undefined;
export function nativeImageComposedPrompt(raw:string,data:any,node?:any,graph?:NativeGraph,projectText?:NativeTextProjection):string|undefined{
 // Role labels are shown inside the editor, while STUDIO promptCodes carry their
 // authored instructions independently. Do not accept arbitrary hidden text.
 const source=raw.replace(/【角色设计开始】[\s\S]*?【角色设计结束】\n?/g,'').replace(/\n{3,}/g,'\n\n').trim();
 const rows=Array.isArray(data?.presetSelections)?data.presetSelections:[],custom=rows.find((row:any)=>row?.key==='customPrompt');
 const parts=[...rows.filter((row:any)=>row?.key&&row.key!=='customPrompt'&&!noStyle(row)).map(presetText),custom?.prefix,source,custom?.suffix,...rows.filter((row:any)=>row?.key==='styleLibrary'&&!promptCode(row)&&!noStyle(row)).map((row:any)=>row.suffixPrompt)];
 const composed=parts.map(text).filter(Boolean).join('\n'),camera=text(data?.cameraControl?.chunk);
 const own=camera?composed?composed+'\n'+camera:camera:composed;
 if(!node||!graph)return own;
 return nativeImageDirectTextPrompt(own,node,graph,projectText);
}
/** q_ appends only direct text sources, in incoming-edge order. The editor's
 * existing prompt-node filter is significant: it avoids repeating an Agent
 * prompt when the user has already written one. Rich text uses the exact
 * native serializer port; unsupported mentions retain the strict check. */
export function nativeImageDirectTextPrompt(own:string,node:any,graph:NativeGraph,projectText?:NativeTextProjection):string|undefined{
 const incoming=graph.edges.filter(edge=>edge.target===node.id),sources=incoming.map(edge=>graph.nodes.find(source=>source.id===edge.source));
 const mentions=(Array.isArray(node.data?.mentionAssets)?node.data.mentionAssets:[]).filter((row:any)=>String(row?.type||'').toUpperCase()==='TEXT').map((row:any)=>String(row.text??'').trim()).filter(Boolean);
 if(!sources.some(source=>source?.type==='rh-text'))return [own,...mentions].filter(Boolean).join('\n');
 const data=node.data||{},subType=String(data.subType||'').toLowerCase().replaceAll('_','-');
 if(node.type!=='rh-image'||data.toolsType||data.isStoryboard||!['text-image','image-image'].includes(subType)||new Set(incoming.map(edge=>edge.source)).size!==incoming.length||sources.some(source=>!source))return;
 const parts:string[]=[];
 for(let index=0;index<sources.length;index++){
  const source=sources[index]!,value=source.data||{},edge=incoming[index];
  if(source.type!=='rh-text')continue;
  if(edge.conditioningRole!=null||edge.sourceHandle!=null&&edge.sourceHandle!=='output'||edge.targetHandle!=null&&edge.targetHandle!=='input'||value.selectedHistoryOutputId||value.selectedOutputHistoryId)return;
  if(own.trim()&&(value._isPromptTextNode===true||value.agentCreated===true&&/提示词$/.test(text(value.title??value.label))))continue;
  let content=typeof value.text==='string'&&value.text?value.text:typeof value.content==='string'?value.content:'';
  // dJ selects text before content, then Vut uses the live native DOM/table
  // serializer. Use that exact instance port for rich text; missing, broken or
  // invalid native projection must never become an approximate HTML strip or
  // silently fall back to a potentially stale content cache.
  if(/<[a-z][\s\S]*>/i.test(content)){
   if(!projectText)return;
   try{const projected=projectText(content);if(typeof projected!=='string')return;content=projected;}catch{return;}
  }
  if(content.trim())parts.push(content);
 }
 return[own,parts.join('\n'),...mentions].filter(Boolean).join('\n');
}
/** A native run includes its untouched editor snapshot. Normalize only an
 * exact recomputation; a forged or stale projection is left for rejection. */
export function normalizeNativeImagePrompt(data:any,node?:any,graph?:NativeGraph,projectText?:NativeTextProjection):any{
 const snapshot=data?.userPromptSnapshot;
 if(snapshot?.paramName!=='prompt'||typeof snapshot.value!=='string')return data;
 const raw=snapshot.value,composed=node&&graph?nativeImageComposedPrompt(raw,data,node,graph,projectText):nativeImageComposedPrompt(raw,data);
 if(composed===undefined||data?.params?.prompt!==composed)return data;
 const params={...data.params,prompt:raw};
 if(params.text===composed)params.text=raw;
 return{...data,params,...(data.prompt===composed?{prompt:raw}:{})};
}

/** Ordinary native image pickers add edges. Explicit inline assets and the
 * selected style are separate inputs; a former run's params.imageUrls is not.
 * Tools, storyboard entities, frame selectors and direct API clients keep
 * their own explicit input contracts. */
export function usesNativeImageInputs(node:any):boolean{
 const d=node?.data??{},mode=String(d.subType??'').toLowerCase().replaceAll('_','-');
 return node?.type==='rh-image'&&(mode==='text-image'||mode==='image-image'||mode===''&&!!(d.modelCode||d.capabilityRef))&&!d.toolsType&&!d.toolsSourceUrl&&!d.sourceNodeId&&!d.isUpload&&!d.isStoryboard&&!d.autoCreatedByAiApp&&!d.sceneCode&&!d.videoFrameAssets?.length;
}
/** q_/oNn uses the displayed source result, Np orders its node/URL identities,
 * and the selected style reference is appended afterwards. Unknown history
 * cannot prove which result was displayed and keeps the strict rejection. */
export function nativeImageComposedReferences(node:any,graph:NativeGraph,encodeAsset:(value:string)=>string,nativeComposer=false):string[]|undefined{
 const data=node.data||{};
 const reopenedTool=data.historyStorage?.source==='remote'&&Array.isArray(data.output)&&data.output.length>0&&['codex-image-generate-v1','codex-image-edit-v1'].includes(data.capabilityRef??data.modelCode)&&(semanticImageTools.has(String(data.toolsType||'').toUpperCase().replaceAll('-','_'))||data.isPortraitAdjustResult===true);
 if(node.type!=='rh-image'||data.toolsType&&!reopenedTool||data.isStoryboard||!nativeComposer&&data.mentionAssets?.length)return;
 const rows:{nodeId:string;url:string}[]=[],incoming=graph.edges.filter(edge=>edge.target===node.id);
 if(new Set(incoming.map(edge=>edge.source)).size!==incoming.length)return;
 for(const edge of incoming){
  if(edge.conditioningRole!=null||edge.sourceHandle!=null&&edge.sourceHandle!=='output'||edge.targetHandle!=null&&edge.targetHandle!=='input')return;
  const source=graph.nodes.find(source=>source.id===edge.source),value=source?.data;
  // q_ separates dJ text conditioning from its oNn media collection. A mixed
  // text+image form still has image references; text is not an image failure.
  if(source?.type==='rh-text'||nativeComposer&&['rh-script','rh-storyboard'].includes(source?.type))continue;
  if(!source||!canvasImageSource(source.type))return;
  const outputs=Array.isArray(value.output)?value.output:value.output?[value.output]:[];
  if(value.selectedHistoryOutputId&&!outputs.some((item:any)=>item?.historyOutputId===value.selectedHistoryOutputId))return;
  if(!value.selectedHistoryOutputId&&value.selectedOutputHistoryId){
   const index=Number(value.selectedOutputHistoryIndex||0),entry=Array.isArray(value.nodeOutputHistory)?value.nodeOutputHistory.find((item:any)=>item?.id===value.selectedOutputHistoryId):undefined,selected=entry?.outputs?.[index],url=typeof selected==='string'?selected:selected?.url;
   if(!Number.isSafeInteger(index)||index<0||typeof url!=='string'||!url||!outputs.some((item:any)=>(typeof item==='string'?item:item?.url)===url))return;
  }
  const values=canvasSourceMediaReferences(source,'image');
  if(!values?.length||values.some(value=>!value.startsWith('rhtv-asset:')))return;
  for(const url of values)rows.push({nodeId:source.id,url});
 }
 if(nativeComposer)for(const mention of Array.isArray(data.mentionAssets)?data.mentionAssets:[]){
  const kind=String(mention?.type||'IMAGE').toUpperCase();if(['TEXT','VIDEO','AUDIO'].includes(kind))continue;
  const ref=typeof mention?.url==='string'?encodeAsset(mention.url.trim()):'';
  if(!ref.startsWith('rhtv-asset:'))return;
  if(!rows.some(row=>row.nodeId===''&&row.url===ref))rows.push({nodeId:'',url:ref});
 }
 const refs=orderCanvasMediaReferences(rows,data.imageOrder,encodeAsset).map(value=>value.url);
 if(!nativeComposer&&!refs.length){const original=data.params?.imageUrls;if(Array.isArray(original))refs.push(...original);else if(original)refs.push(original);}
 const style=String(data.presetSelections?.find((row:any)=>row?.key==='styleLibrary')?.referenceImageUrl||'').trim();
 if(style){const reference=encodeAsset(style);if(!reference.startsWith('rhtv-asset:'))return;if(refs.at(-1)!==reference)refs.push(reference);}
 return refs.every(ref=>typeof ref==='string'&&ref.startsWith('rhtv-asset:'))?refs:undefined;
}
