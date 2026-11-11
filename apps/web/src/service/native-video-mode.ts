/** Older H3 motion results were saved in the generic multimodal video bucket.
 * The immutable composer repairs a model missing from that bucket by selecting
 * its first unrelated model. Preserve the explicit, versioned model instead. */
export function resolveSavedVideoMode(node:any,model:any):'video-motion-transfer'|undefined{
 const data=node?.data,ref='h3-motion-transfer-v1',version=data?.capabilityVersion;
 if(node?.type!=='rh-video'||!['multimodal-video','video-motion-transfer'].includes(String(data?.subType||'').toLowerCase().replaceAll('_','-'))||data?.modelCode!==ref||data?.capabilityRef!==ref||typeof version!=='string'||data.parameterSchemaVersion!==version)return;
 if(model?.capabilityRef!==ref||(model.modelCode??ref)!==ref||(model.version??model.capabilityVersion)!==version||model.parameterSchemaVersion!==version||model.kind!=='VIDEO_TO_VIDEO'||model.available!==true||model.disabled===true||model.testMode!==false||model.model?.modelRef!=='h3')return;
 const metadata=model.parameterSchema?{mode:model.parameterSchema['x-video-mode']}:(model.config??[]).find((field:any)=>field.studioVideoParameterMetadata?.capabilityRef===ref&&field.studioVideoParameterMetadata?.version===version)?.studioVideoParameterMetadata;
 if(metadata?.mode==='MOTION_TRANSFER')return'video-motion-transfer';
}
const views=new WeakMap<object,{model:any;node:any;data:any;view:any}>();
const same=(a:any,b:any)=>Object.keys(a).length===Object.keys(b).length&&Object.entries(a).every(([key,value])=>Object.hasOwn(b,key)&&b[key]===value);
function grouped(groups:any[]):any[]{return groups.flatMap(group=>[...(group.nodeModelList??[]).flatMap((row:any)=>row.modelList??[]),...grouped(group.modelGroupList??[])]);}
/** A render projection only: no model migration, graph write or synthetic
 * catalog bucket. Explicit user mode/model callbacks remain native-owned. */
export function savedVideoModeProps(props:any){
 const node=props?.targetNode??props?.node;if(node?.type!=='rh-video'||!Object.hasOwn(props,'visible')||!Array.isArray(props.references)||!props.models||!Array.isArray(props.videoModelGroups))return props;
 const candidates=[...Object.values(props.models).flat(),...grouped(props.videoModelGroups)],model=candidates.find(model=>resolveSavedVideoMode(node,model)),mode=resolveSavedVideoMode(node,model);if(!mode)return props;
 let cached=views.get(node);if(!cached||cached.model!==model||!same(node,cached.node)||!same(node.data,cached.data)){cached={model,node:{...node},data:{...node.data},view:{...node,data:{...node.data,subType:mode}}};views.set(node,cached);}
 return{...props,...(props.targetNode===node?{targetNode:cached.view}:{node:cached.view}),initialSubType:mode};
}
