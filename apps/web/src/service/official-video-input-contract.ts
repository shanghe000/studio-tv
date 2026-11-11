import type {Capability} from './model-catalog';

/** Current officialvideo@1 adapters apply these limits in their body builder.
 * Older directory revisions omit them. Do not infer them for future versions
 * or for another adapter with a similar title. */
export function officialVideoProvider(cap:Capability){
 const provider=cap.model?.providerRef,ref=cap.model?.modelRef;
 return cap.testMode===false&&cap.version==='1'&&cap.parameterSchemaVersion==='1'&&cap.outputKinds?.includes('VIDEO')&&ref&&cap.capabilityRef.startsWith(ref+'-')&&(provider==='minimax-official'||provider==='volcengine-official')?provider:undefined;
}
// These limits match STUDIO modelmedia's authenticated byte reader. Canvas uploads
// and local media operations have separate admission rules.
const transport:Record<string,{maxBytes:number;mimeTypes:string[]}>={
 IMAGE:{maxBytes:10*1048576,mimeTypes:['image/png','image/jpeg','image/webp']},
 VIDEO:{maxBytes:64*1048576,mimeTypes:['video/mp4']},
 AUDIO:{maxBytes:16*1048576,mimeTypes:['audio/wav','audio/mpeg']},
};
export function mediaInputContract(cap:Capability){
 const model=modelMediaContract(cap);
 if(cap.testMode!==false||!(cap.executionKind==='MODEL'||!cap.executionKind&&cap.model)||model&&model.schemaVersion!=='1')return model;
 const kinds={...model?.kinds};
 for(const [kind,policy] of Object.entries(transport)){
  const limit=kinds[kind];
  if(!limit&&!cap.inputKinds?.includes(kind))continue;
  const knownBytesOnly=!(limit?.maxBytes>0),knownMimeOnly=limit?.mimeTypes==null;
  kinds[kind]={...limit,knownBytesOnly,knownMimeOnly,
   maxBytes:knownBytesOnly?policy.maxBytes:Math.min(limit.maxBytes,policy.maxBytes),
   mimeTypes:knownMimeOnly?policy.mimeTypes:policy.mimeTypes.filter(type=>limit.mimeTypes.includes(type))};
 }
 return Object.keys(kinds).length?{...model,schemaVersion:'1',kinds}:model;
}
function modelMediaContract(cap:Capability){
 const declared=cap.parameterSchema?.['x-input-media-constraints'];
 if(declared!==undefined)return declared;
 // These immutable Codex app-server versions check decoded input bytes before constructing native messages.
 const codexVersions:Record<string,string[]>={'codex-text-v1':['1'],'codex-vision-text-v1':['1'],'codex-6-vision-text-v1':['1','2'],'codex-6-1-vision-text-v1':['1','2'],'codex-image-edit-v1':['1','2','3']};
 if(cap.testMode===false&&cap.inputKinds?.includes('IMAGE')&&codexVersions[cap.capabilityRef]?.includes(cap.version)&&cap.parameterSchemaVersion===cap.version)return{schemaVersion:'1',kinds:{IMAGE:{maxBytes:10*1048576,maxTotalBytes:16*1048576,mimeTypes:['image/png','image/jpeg','image/webp']}}};
 const provider=officialVideoProvider(cap);if(!provider)return undefined;
 const mini=provider==='minimax-official',seed25=cap.model!.modelRef==='seedance-2-5-official',total=seed25?30000:15000;
 const sideMin=mini?256:300,sideMax=mini?5760:6000;
 return{schemaVersion:'1',kinds:{
  IMAGE:{maxBytes:10*1048576,minWidth:sideMin,minHeight:sideMin,maxWidth:sideMax,maxHeight:sideMax,minAspect:0.4,maxAspect:2.5,maxPixels:16777216,mimeTypes:['image/png','image/jpeg','image/webp']},
  VIDEO:{maxBytes:(mini?50:64)*1048576,minWidth:300,minHeight:300,maxPixels:2073600,minDurationMs:seed25&&cap.parameterSchema?.['x-video-mode']==='OMNI_REFERENCE'?4000:2000,maxDurationMs:15000,maxTotalDurationMs:total,mimeTypes:['video/mp4']},
  AUDIO:{maxBytes:15*1048576,minDurationMs:2000,maxDurationMs:15000,maxTotalDurationMs:total,mimeTypes:['audio/wav','audio/mpeg']},
 }};
}
