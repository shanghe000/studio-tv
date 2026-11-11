// The native image body subscribes to the viewport store and unmounts media
// outside its window. Supply the display tier here, before an <img> gets a
// src. Tool inputs, stored graph URLs and downloads continue to use the source.
const widths=new Set([256,384,512,720,1440,2560]);
const scopedMedia=/^\/storage\/canvas-media\/[a-f0-9]{32}\/[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export function viewportPreviewProps(props:any,view:any,origin:string) {
 if(!props||!view?.imageMediaVirtualizationEnabled||typeof props.nodeId!=='string'||
    typeof props.url!=='string'||!Object.hasOwn(props,'fallbackSourceUrl')||
    typeof props.onRecognitionMediaLoad!=='function'||typeof props.skipIntrinsicSizePatch!=='boolean'||
    props.skipIntrinsicSizePatch||props.resolutionUrl||props.url!==props.fallbackSourceUrl)return props;
 const id=props.nodeId;
 if(!view.imageMediaWindowNodeIds?.has(id)||view.selectedNodeIds?.includes(id)||
    [view.expandedNodeId,view.outputHistoryOpenNodeId,view.multiOutputExpandedNodeId,view.paramsUiLockNodeId,view.resizingNodeId].includes(id))return props;
 let source:URL;try{source=new URL(props.url,origin);}catch{return props;}
 if(source.origin!==origin||source.search||source.hash||!scopedMedia.test(source.pathname))return props;
 const tier=view.imageResolutionTargetWidths?.get(id)||256;if(!widths.has(tier))return props;
 source.searchParams.set('previewWidth',String(tier));
 // Intrinsic size/recognition are authoring inputs and must never observe a
 // thumbnail's dimensions. Selecting the node mounts the original again.
 return {...props,url:source.href,onRecognitionMediaLoad:undefined,skipIntrinsicSizePatch:true};
}
export function installCanvasViewportPreviews(native:any,surface:Window=window){
 const jsx=native.j,store=native.c5;if(!jsx||typeof store?.getState!=='function'||typeof jsx.jsx!=='function')return()=>{};
 const original=jsx.jsx;
 const wrapped=function(this:any,type:any,props:any,...args:any[]){
  if(typeof type==='function'&&typeof props?.skipIntrinsicSizePatch==='boolean'&&props.fallbackSourceUrl){
   props=viewportPreviewProps(props,store.getState(),surface.location.origin);
  }
  return original.call(this,type,props,...args);
 };
 jsx.jsx=wrapped;return()=>{if(jsx.jsx===wrapped)jsx.jsx=original;};
}
