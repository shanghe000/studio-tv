import {ApiError} from '../api/client';
import type {NativeGraph} from './graph';

interface Binding {type:string;capabilityRef:string;capabilityVersion:string;parameterSchemaVersion?:string}
export interface NativeModelBindingPort {node:(node:any)=>any;record:(node:any,patch:any)=>void;current:()=>boolean;refreshParameters?:(nodeId:string,patch:any)=>void}
const text=(value:any,max:number)=>typeof value==='string'&&value.length>0&&value.length<=max&&value.trim()===value;
const same=(value:any,previous:any)=>Object.keys(value).length===Object.keys(previous).length&&Object.entries(value).every(([key,item])=>Object.hasOwn(previous,key)&&previous[key]===item);
function binding(node:any):Binding|undefined {
 const data=node?.data;
 if(data?.capabilityVersion===undefined)return undefined;
 const ref=data.capabilityRef??data.modelCode;
 if(!text(ref,200)||!text(data.capabilityVersion,100)||data.modelCode&&data.modelCode!==ref||data.parameterSchemaVersion!==undefined&&!text(data.parameterSchemaVersion,100))throw new ApiError(422,'MODEL_SELECTION_INVALID','保存的模型版本信息无效，请重新选择模型。');
 return{type:node.type,capabilityRef:ref,capabilityVersion:data.capabilityVersion,...(data.parameterSchemaVersion?{parameterSchemaVersion:data.parameterSchemaVersion}:{})};
}
/** Native D1n/wct drops unknown data keys. Keep public version bindings outside
 * its schema, then restore them only to matching node/model copies. */
export class ModelBindings {
 private projects=new Map<string,Map<string,Binding>>();
 private views=new WeakMap<object,{binding:Binding;view:any;rawNode:any;rawData:any}>();
 clear(){this.projects.clear();this.views=new WeakMap();}
 delete(projectId:string){this.projects.delete(projectId);}
 reconcile(projectId:string,graph:NativeGraph){const ids=new Set(graph.nodes.map(node=>node.id)),rows=this.projects.get(projectId);if(rows)for(const id of rows.keys())if(!ids.has(id))rows.delete(id);}
 seed(projectId:string,graph:NativeGraph){const rows=new Map<string,Binding>();for(const node of graph.nodes){const value=binding(node);if(value)rows.set(node.id,value);}this.projects.set(projectId,rows);}
 capture(projectId:string,graph:NativeGraph){for(const node of graph.nodes)if(!this.projects.get(projectId)?.has(node.id))this.record(projectId,node,{});}
 node(projectId:string,node:any){
  if(node?.data?.capabilityVersion!==undefined)return node;
  const value=this.projects.get(projectId)?.get(node?.id),ref=node?.data?.modelCode??node?.data?.capabilityRef;
  if(!value||value.type!==node.type||ref!==value.capabilityRef)return node;
  const cached=this.views.get(node);if(cached?.binding===value&&same(node,cached.rawNode)&&same(node.data,cached.rawData))return cached.view;
  const view={...node,data:{...node.data,capabilityRef:value.capabilityRef,capabilityVersion:value.capabilityVersion,...(value.parameterSchemaVersion?{parameterSchemaVersion:value.parameterSchemaVersion}:{})}};this.views.set(node,{binding:value,view,rawNode:{...node},rawData:{...node.data}});return view;
 }
 graph(projectId:string,graph:NativeGraph):NativeGraph {let changed=false;const nodes=graph.nodes.map(node=>{const view=this.node(projectId,node);changed ||= view!==node;return view;});return changed?{...graph,nodes}:graph;}
 record(projectId:string,node:any,patch:any){
  const updated={...node,data:{...node.data,...patch}},value=binding(updated);if(!value)return;
  let rows=this.projects.get(projectId);if(!rows){rows=new Map();this.projects.set(projectId,rows);}rows.set(node.id,value);
 }
}
