import type {NativeGraph} from './graph';

const entityImages=new Set(['rh-role','rh-scene','rh-entity']);
/** q_ rewrites these three native source types to rh-image in its command.
 * They keep their durable identity and image output semantics in the graph. */
export const canvasImageSource=(type:unknown)=>type==='rh-image'||entityImages.has(String(type));
export function restoreCommandSourceTypes(command:NativeGraph|undefined,base:NativeGraph|undefined,targetId:string):NativeGraph|undefined{
 if(!command||!base)return command;
 const direct=new Set(base.edges.filter(e=>e.target===targetId).map(e=>e.source)),aliases=new Map(base.nodes.filter(n=>direct.has(n.id)&&entityImages.has(n.type)).map(n=>[n.id,n.type]));
 if(!aliases.size)return command;
 const consumed=new Set(command.edges.filter(e=>e.target===targetId).map(e=>e.source));
 return{...command,nodes:command.nodes.map(n=>n.id!==targetId&&consumed.has(n.id)&&n.type==='rh-image'&&aliases.has(n.id)?{...n,type:aliases.get(n.id)}:n)};
}

/** The displayed output of a connected media node is its input contribution.
 * Its old generation parameters and ancestor inputs are never contributions. */
export function canvasSourceMediaReferences(source:any,kind:'image'|'video'|'audio'):string[]|undefined{
 const data=source.data??{},outputs=Array.isArray(data.output)?data.output:data.output?[data.output]:[];
 let chosen=data.selectedHistoryOutputId?outputs.find((output:any)=>output?.historyOutputId===data.selectedHistoryOutputId):outputs[0];
 if(data.selectedHistoryOutputId&&chosen===undefined)return;
 if(!data.selectedHistoryOutputId&&data.selectedOutputHistoryId){
  const index=Number(data.selectedOutputHistoryIndex||0),entry=Array.isArray(data.nodeOutputHistory)?data.nodeOutputHistory.find((value:any)=>value?.id===data.selectedOutputHistoryId):undefined,selected=entry?.outputs?.[index],url=typeof selected==='string'?selected:selected?.url;
  if(!Number.isSafeInteger(index)||index<0||typeof url!=='string'||!url)return;
  const at=outputs[index],first=outputs[0];chosen=(typeof at==='string'?at:at?.url)===url?at:(typeof first==='string'?first:first?.url)===url?first:undefined;
  if(chosen===undefined)return;
 }
 const output=typeof chosen==='string'?chosen:chosen?.url;
 if((data.selectedHistoryOutputId||data.selectedOutputHistoryId)&&!output)return;
 const list=(value:any)=>Array.isArray(value)?value:value?[value]:[];
 const values=output?[output]:[...list(data.sourceObjects),...(typeof data[kind+'Url']==='string'?[data[kind+'Url']]:[])];
 // oNn contributes these explicit media fields even when an output exists.
 if(kind==='video'&&typeof data.sourceVideo==='string')values.push(data.sourceVideo);
 if(kind==='audio'&&typeof data.audioUrl==='string')values.push(data.audioUrl);
 return values.every(value=>typeof value==='string'&&!!value)?[...new Set<string>(values)]:undefined;
}

/** The frozen Np sorter accepts compound keys, URLs, node IDs and saved object
 * identities. First occurrences win; unmatched references keep edge order. */
export function orderCanvasMediaReferences<T extends {nodeId:string;url:string}>(rows:readonly T[],order:unknown,encodeAsset:(value:string)=>string=value=>value):T[]{
 const rank=new Map<string,number>();
 const keys=(value:any):string[]=>{if(typeof value==='string')return[encodeAsset(value)];if(!value||typeof value!=='object')return[];const url=typeof value.url==='string'&&value.url||typeof value.fileUrl==='string'&&value.fileUrl||'',id=typeof value.nodeId==='string'?value.nodeId:'';return[typeof value._key==='string'&&value._key?encodeAsset(value._key):url?encodeAsset(id?id+'::'+url:url):'',url?encodeAsset(url):'',id].filter(Boolean);};
 if(Array.isArray(order))order.forEach((value:any,index:number)=>{for(const key of keys(value))if(!rank.has(key))rank.set(key,index);});
 const counts=new Map<string,number>(),ordered=rows.map((row,index)=>{let position=Infinity,duplicate=0;for(const key of [row.nodeId?row.nodeId+'::'+row.url:row.url,row.url,row.nodeId].filter(Boolean))if(rank.has(key)){position=rank.get(key)!;duplicate=counts.get(key)||0;counts.set(key,duplicate+1);break;}return{row,index,position,duplicate};});
 ordered.sort((a,b)=>a.position-b.position||a.duplicate-b.duplicate||a.index-b.index);
 return ordered.map(value=>value.row);
}
