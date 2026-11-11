import {sha256} from '@noble/hashes/sha2.js';
import type {ProjectGraph} from '../api/types';
export const META_NODE='rhtv_meta_v1';
export const META_TYPE='__rhtv_meta';
const credentialKey=/^(password|passwd|secret|access[_-]?token|refresh[_-]?token|api[_-]?key|authorization|credential|platformKey)$/i;
const forbiddenKey=new Set(['__proto__','prototype','constructor']);
export interface NativeGraph {nodes:any[];edges:any[];meta?:Record<string,any>;viewport?:{x:number;y:number;zoom:number}}
export function cleanJson(value:any, mapUrl:(value:string)=>string=value=>value,depth=0):any {
 if(depth>80)throw new Error('画布数据层级过深。');
 if(typeof value==='string'){
  const mapped=mapUrl(value);
  if(mapped.startsWith('blob:')||mapped.includes('/__rhtv_media/'))throw new Error('画布包含未上传的本地素材，请先完成上传。');
  if(/^https?:\/\//.test(mapped)){let url:URL;try{url=new URL(mapped);}catch{return mapped;}for(const key of [...url.searchParams.keys()])if(/signature|token|credential|x-amz|x-tos/i.test(key)){url.search='';return url.href;}}
  return mapped;
 }
 if(value===null||typeof value==='boolean')return value;
 if(typeof value==='number'){if(!Number.isFinite(value))throw new Error('画布包含无效数字。');return value;}
 if(Array.isArray(value))return value.map(x=>cleanJson(x,mapUrl,depth+1));
 if(value&&typeof value==='object'){
  const result:Record<string,any>={};
  for(const [key,item]of Object.entries(value)){
   if(forbiddenKey.has(key))throw new Error('画布包含不允许的数据字段。');
   if(credentialKey.test(key)&&typeof item==='string')continue;
   if(item===undefined||typeof item==='function'||key==='__studioCopySource')continue;
   // Preset definitions carry audited catalog metadata. A matching cover URL
   // must not rewrite their prompt/reference fields into mutable owned assets.
   result[key]=cleanJson(item,key==='presetSelections'?value=>value:mapUrl,depth+1);
  }
  return result;
 }
 return null;
}
export function encodeGraph(native:NativeGraph,mapUrl?:(value:string)=>string):ProjectGraph {
 if(!Array.isArray(native.nodes)||!Array.isArray(native.edges))throw new Error('无效画布结构。');
 const ids=new Set<string>();
 const nodes=native.nodes.map(node=>{
  const {id,type,position,data={},...extra}=node;
  if(String(id)===META_NODE||String(type)===META_TYPE||ids.has(String(id)))throw new Error('画布包含重复或保留的节点 ID。');
  ids.add(String(id));
  if(data.__rhtv!==undefined)throw new Error('节点使用了保留的扩展字段。');
  const safe=cleanJson(data,mapUrl);
  if(Object.keys(extra).length)safe.__rhtv={native:cleanJson(extra,mapUrl)};
  return{id:String(id),type:String(type),position:{x:Number(position.x),y:Number(position.y)},data:safe};
 });
 const edgeIds=new Set<string>(),edgeExtras:Record<string,any>={};
 const edges=native.edges.map(edge=>{
  const{id,source,target,sourceHandle=null,targetHandle=null,...extra}=edge;
  if(edgeIds.has(String(id))||!ids.has(String(source))||!ids.has(String(target)))throw new Error('画布包含重复连线或不存在的节点引用。');
  edgeIds.add(String(id));
  if(Object.hasOwn(extra,'__studioNativeEdgeId'))throw new Error('连线使用了保留的扩展字段。');
  const nativeId=String(id),storedId=/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(nativeId)?nativeId:'studio_edge_'+[...sha256(new TextEncoder().encode(nativeId))].map(byte=>byte.toString(16).padStart(2,'0')).join('').slice(0,52);
  if(Object.keys(extra).length||storedId!==nativeId)edgeExtras[storedId]={...cleanJson(extra,mapUrl),...(storedId!==nativeId?{__studioNativeEdgeId:nativeId}:{})};
  return{id:storedId,source:String(source),target:String(target),sourceHandle:sourceHandle===null?null:String(sourceHandle),targetHandle:targetHandle===null?null:String(targetHandle)};
 });
 nodes.push({id:META_NODE,type:META_TYPE,position:{x:0,y:0},data:{version:'1',meta:cleanJson(native.meta||{},mapUrl),edges:edgeExtras}});
 const viewport=native.viewport||native.meta?.viewport||{x:0,y:0,zoom:1};
 if(!Number.isFinite(viewport.x)||!Number.isFinite(viewport.y)||!Number.isFinite(viewport.zoom)||viewport.zoom<=0)throw new Error('画布缩放参数无效。');
 return cleanJson({schemaVersion:'1',nodes,edges,viewport},mapUrl);
}
export function decodeGraph(graph:ProjectGraph,mapUrl:(value:string)=>string=value=>value):NativeGraph {
 const map=(value:any):any=>typeof value==='string'?mapUrl(value):Array.isArray(value)?value.map(map):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([key,item])=>[key,key==='presetSelections'?item:map(item)])):value;
 const safe=map(cleanJson(graph)),metadata=safe.nodes.find((node:any)=>node.id===META_NODE);
 if(metadata&&metadata.data.version!=='1')throw new Error('暂不支持此画布扩展版本。');
 return{
  nodes:safe.nodes.filter((node:any)=>node.id!==META_NODE).map((node:any)=>{const{__rhtv,...data}=node.data;return{...(__rhtv?.native||{}),id:node.id,type:node.type,position:node.position,data};}),
  edges:safe.edges.map((edge:any)=>{const {__studioNativeEdgeId,...extra}=metadata?.data.edges?.[edge.id]||{};return{...extra,...edge,...(typeof __studioNativeEdgeId==='string'?{id:__studioNativeEdgeId}:{})};}),
  meta:{...(metadata?.data.meta||{}),viewport:safe.viewport},
  viewport:safe.viewport,
 };
}
