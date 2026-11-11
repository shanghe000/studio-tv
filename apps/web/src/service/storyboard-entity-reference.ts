import {ApiError} from '../api/client';

const text=(value:any)=>typeof value==='string'?value.trim():'';
const owned=(value:string,encode:(value:string)=>string)=>{const ref=encode(text(value));return /^rhtv-asset:[A-Za-z0-9_-]+$/.test(ref)?ref:'';};
/** A generated preview never becomes a reference merely because it has an image. */
export function storyboardEntityReference(data:any,encode:(value:string)=>string=value=>value):string {
 if(data?.storyboardEntityUserReference!==true)return '';
 const image=text(data.imageUrl),source=text(data.toolsSourceUrl);
 if(!image||source&&encode(source)!==encode(image))return '';
 return image;
}

interface SelectionOwner {projectId:string;scriptId:string;kind:string;entityId:string;canEdit?:()=>boolean}
/** Called only by the frozen fullscreen entity picker's explicit upload/reuse callbacks. */
export function wrapStoryboardEntityReference(runtime:any,native:any,owner:SelectionOwner,callback:Function,selectedImage:(value:any)=>string){
 return function(this:any,value:any,...args:any[]){
  const identity=runtime.auth.user,manager=native.bt(),graph=manager?.getRemoteData(),project=runtime.inspect().id;
  const node=graph?.nodes.find((item:any)=>item.data?.storyboardEntityNode===true&&item.data?.storyboardScriptNodeId===owner.scriptId&&String(item.data?.entityId)===owner.entityId&&item.data?.storyboardEntityKind===owner.kind);
  const nodeId=node?.id,image=text(selectedImage(value)),encode=(value:string)=>runtime.storage.encodeAsset(value),asset=owned(image,encode);
  const allowed=!!identity&&project===owner.projectId&&node&&owner.canEdit?.()!==false&&!native.bq?.getState?.().isRead&&!['running','processing','uploading'].includes(node.data.status)&&!!asset;
  const finish=()=>{
   if(!allowed||owner.canEdit?.()===false||runtime.auth.user!==identity||runtime.inspect().id!==owner.projectId||native.bt()!==manager||native.bq?.getState?.().isRead)return;
   // pjr.qt/vt queues xn's image update. Settle that native operation before
   // comparing the chosen image with getRemoteData's integrated projection.
   manager.flushOperationQueue?.(true);
   const current=manager.getRemoteData()?.nodes.find((item:any)=>item.id===nodeId&&item.data?.storyboardEntityNode===true&&item.data?.storyboardScriptNodeId===owner.scriptId&&String(item.data?.entityId)===owner.entityId&&item.data?.storyboardEntityKind===owner.kind);
   if(!current||['running','processing','uploading'].includes(current.data.status)||owned(current.data.imageUrl,encode)!==asset)return;
   // These existing native fields survive D1n/L1n serialization and asset encoding.
   // toolsSourceUrl fixes the selected asset: a later generated preview has a different identity.
   manager.patchNodeData(current.id,{storyboardEntityUserReference:true,toolsType:'IMAGE_IMAGE',toolsSourceUrl:current.data.imageUrl},{allowFields:['storyboardEntityUserReference','toolsType','toolsSourceUrl']});
   manager.flushOperationQueue?.(true);
  };
  const result=callback.call(this,value,...args);
  if(result&&typeof result.then==='function')return result.then((output:any)=>{finish();return output;});
  finish();return result;
 };
}

export function assertStoryboardEntityReferenceModel(model:any,reference:string,name='此实体'){
 if(['IMAGE_TO_IMAGE','IMAGE_IMAGE'].includes(model?.kind)&&!reference)throw new ApiError(422,'ENTITY_REFERENCE_REQUIRED',`请先为“${name}”上传或选择一张参考图片，再使用参考图编辑模型。`);
 if(['TEXT_TO_IMAGE','TEXT_IMAGE'].includes(model?.kind)&&reference)throw new ApiError(422,'ENTITY_REFERENCE_MODEL_REQUIRED',`“${name}”已选择参考图片，请选择参考图编辑模型，或先清除参考图片。`);
}
