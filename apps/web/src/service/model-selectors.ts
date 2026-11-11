import {generatedImageSelectionProps} from './image-selection-params';
import {historicalH3ModelProps} from './h3-model-version';
import {h3PresetSelectionProps} from './h3-preset-selection';
import {fitsInputs,fitsOutputs} from './model-catalog';
import {nodeReadinessMaterials,readinessModelInputReason} from './connection-readiness';
import {nativeImageToolbarProps} from './image-quick-scenes';
import type {NativeModelBindingPort} from './model-bindings';
import {nativeVideoMenuProps,nativeVideoSourceMenu,nativeOrdinarySourceMenu,modelSourceMenuStyles} from './video-model-menu';
import {clearModelCatalogView,consumeNativeModelSelectionIntent,modelCatalogViewRevision,projectModelCatalogProps,replaceModelCatalogView,subscribeModelCatalogView,withNativeModelSelectionIntent} from './model-catalog-view';
import {credentialsChangedEvent,installProviderCredentialSettings} from './model-provider-credentials';
import {videoModelInputAvailability} from './video-model-input-availability';
import {savedVideoModeProps} from './native-video-mode';

const modalities=new Set(['TEXT','STRUCTURED','IMAGE','VIDEO','AUDIO','FILE']);
const projected=new WeakMap<object,Map<string,any>>();
const patchCallbacks=new WeakMap<Function,WeakMap<object,WeakMap<object,Function>>>();
const videoReplicaViews=new WeakMap<object,{groups:object;models:object;signature:string;single:any;multiple:any;code:any;selected:any;data:any;node:any;view:any;displayModels:any;originalPatch:any;patch:any}>();
const apiVideoCallbacks=new WeakSet<Function>();
const unavailableApiCallbacks=new WeakSet<Function>();
const unavailableApiViews=new WeakMap<object,{models:object;groups:object;ref:string;mode:string;version:any;schemaVersion:any;source:any;displayModels:any;displayGroups:any}>();
const videoMode=(value:any)=>typeof value==='string'?value.replaceAll('_','-').toLowerCase():'';
const savedVideoModes=new Set(['text-video','image-video','start-video','end-video','start-end-video','multimodal-video','video-video','video-edit','video-extend','video-clip-reshoot']);
function groupedVideoModels(groups:any[]):{model:any;mode:string}[]{return groups.flatMap(group=>[...(group.nodeModelList??[]).flatMap((row:any)=>(row.modelList??[]).map((model:any)=>({model,mode:videoMode(row.nodeType)}))),...groupedVideoModels(group.modelGroupList??[])]);}
/** A removed key changes availability, never the user's saved model choice.
 * Keep its full catalog config in the original native bucket, including during
 * separate list/group loading. Only an explicit selector choice may replace it. */
export function unavailableApiVideoProps(props:any,bindings?:NativeModelBindingPort){
 const node=props?.targetNode??props?.node,data=node?.data,original=props?.onNodeDataPatch;
 if(node?.type!=='rh-video'||!Object.hasOwn(props,'visible')||!props.models||!Array.isArray(props.videoModelGroups)||!Array.isArray(props.references)||!data||typeof original!=='function'||unavailableApiCallbacks.has(original))return props;
 const ref=String(data.modelCode??data.capabilityRef??''),grouped=groupedVideoModels(props.videoModelGroups),flat=Object.entries(props.models).flatMap(([mode,models])=>Array.isArray(models)?models.map(model=>({model,mode:videoMode(mode)})):[]),rows=[...flat,...grouped],choice=rows.find(row=>row.model?.modelCode===ref&&row.model?.capabilityRef===ref&&row.model?.['x-model-source']?.kind==='API');
 if(!choice||choice.model.available===true&&choice.model.disabled!==true||!Array.isArray(choice.model.config)||!choice.model.config.length)return props;
 const mode=savedVideoModes.has(videoMode(data.subType))?videoMode(data.subType):savedVideoModes.has(choice.mode)?choice.mode:videoMode(props.initialSubType)||'text-video';
 let cached=unavailableApiViews.get(data);
 if(!cached||cached.models!==props.models||cached.groups!==props.videoModelGroups||cached.ref!==ref||cached.mode!==mode||cached.version!==data.capabilityVersion||cached.schemaVersion!==data.parameterSchemaVersion||cached.source!==choice.model){
  const model={...choice.model,available:false,disabled:true,...(typeof data.capabilityVersion==='string'?{capabilityVersion:data.capabilityVersion}:{}),...(typeof data.parameterSchemaVersion==='string'?{parameterSchemaVersion:data.parameterSchemaVersion}:{})},bucket=Array.isArray(props.models[mode])?props.models[mode]:[],displayModels={...props.models,[mode]:[model,...bucket.filter((row:any)=>row.modelCode!==ref)]};
  // Preserve the actual unavailable leaf. A late/missing groups response may
  // borrow this complete disabled catalog row, never an enabled substitute.
  const displayGroups=grouped.some(row=>row.model.modelCode===ref)?props.videoModelGroups:[...props.videoModelGroups,{modelGroupId:'studio-unavailable-api:'+ref,modelGroupName:model.modelName,modelGroupNameEn:model.modelNameEn,nodeTypeList:[mode.toUpperCase().replaceAll('-','_')],nodeModelList:[{nodeType:mode.toUpperCase().replaceAll('-','_'),modelList:[model]}]}];
  cached={models:props.models,groups:props.videoModelGroups,ref,mode,version:data.capabilityVersion,schemaVersion:data.parameterSchemaVersion,source:choice.model,displayModels,displayGroups};unavailableApiViews.set(data,cached);
 }
 const apiBindingHandled=apiVideoCallbacks.has(original),onNodeDataPatch=(id:string,patch:any,...rest:any[])=>{
  if(bindings&&!bindings.current())return false;
  if(id!==node.id)return original(id,patch,...rest);
  const nextRef=String(patch?.modelCode??patch?.capabilityRef??patch?.params?.rhModel??ref),changesChoice=nextRef!==ref||patch?.subType!==undefined&&videoMode(patch.subType)!==mode||patch?.capabilityVersion!==undefined&&data.capabilityVersion!==undefined&&patch.capabilityVersion!==data.capabilityVersion||patch?.parameterSchemaVersion!==undefined&&data.parameterSchemaVersion!==undefined&&patch.parameterSchemaVersion!==data.parameterSchemaVersion;
  if(!changesChoice)return original(id,patch,...rest);
  const current=Object.values(projectModelCatalogProps(props).models).flat().find((model:any)=>model?.modelCode===nextRef&&model?.capabilityRef===nextRef&&model.available===true&&model.disabled!==true) as any;
  if(!current||!consumeNativeModelSelectionIntent(node.id,nextRef))return false;
  const value={...patch,capabilityRef:current.capabilityRef,capabilityVersion:current.capabilityVersion,parameterSchemaVersion:current.parameterSchemaVersion},result=original(id,value,...rest);
  if((current['x-model-source']?.kind!=='API'||!apiBindingHandled)&&result!==false&&!(result&&typeof result.then==='function'))bindings?.record(node,value);
  return result;
 };
 unavailableApiCallbacks.add(onNodeDataPatch);apiVideoCallbacks.add(onNodeDataPatch);
 return{...props,initialSubType:mode,models:cached.displayModels,videoModelGroups:cached.displayGroups,onNodeDataPatch};
}
/** Video model selection records the same immutable catalog binding as other
 * explicit model changes. The account key never becomes part of this patch. */
export function apiVideoSelectionProps(props:any,bindings?:NativeModelBindingPort){
 const node=props?.targetNode??props?.node,original=props?.onNodeDataPatch;
 if(node?.type!=='rh-video'||typeof original!=='function'||apiVideoCallbacks.has(original)||!props.models||!Object.values(props.models).flat().some((model:any)=>model?.['x-model-source']?.kind==='API')&&(!bindings||node.data?.capabilityVersion)||['viralRemixReplicaModel','viralRemixReplicaModels','viralRemixReplicaModelCode'].some(key=>Object.hasOwn(node.data??{},key)))return props;
 const onNodeDataPatch=(id:string,patch:any,...args:any[])=>{
  if(bindings&&!bindings.current())return;
  const ref=patch?.modelCode,rows=Object.values(projectModelCatalogProps(props).models).flat() as any[],explicit=id===node.id&&ref&&consumeNativeModelSelectionIntent(id,ref),model=ref?rows.find(row=>row.capabilityRef===ref&&row.modelCode===ref&&row.available===true&&row.disabled!==true&&(ref!==node.data?.modelCode&&row['x-model-source']?.kind==='API'||explicit&&!node.data?.capabilityVersion)):undefined;
  const repair=!!model&&!!explicit&&!node.data?.capabilityVersion&&!!node.data?.taskId;
  const bound=model?{...patch,capabilityRef:model.capabilityRef,capabilityVersion:model.capabilityVersion,parameterSchemaVersion:model.parameterSchemaVersion,...(repair?{taskId:'',estimateTaskId:'',errorMsg:'',status:'idle'}:{})}:patch,result=original(id,bound,...args);
  if(model&&id===node.id&&result!==false&&!(result&&typeof result.then==='function'))bindings?.record(node,bound);
  return result;
 };apiVideoCallbacks.add(onNodeDataPatch);return{...props,onNodeDataPatch};
}
/** Native Ror prepends saved replica metadata to the video menu. Only its
 * render view may use current catalog models; the saved node stays intact. */
function nativeVideoReplicaProps(props:any,node:any,bindings?:NativeModelBindingPort){
 const data=node.data,groups=props.videoModelGroups,subType=String(data?.subType??'').replaceAll('_','-').toLowerCase();
 if(node.type!=='rh-video'||!Object.hasOwn(props,'visible')||!Array.isArray(props.references)||!data||typeof data!=='object'||!Array.isArray(groups)||subType&&subType!=='multimodal-video'||!['viralRemixReplicaModel','viralRemixReplicaModels','viralRemixReplicaModelCode'].some(key=>Object.hasOwn(data,key)))return props;
 const inputs=new Set<string>();
 for(const reference of props.references??[]){const kind=String(reference?.kind??'').toUpperCase();if(modalities.has(kind))inputs.add(kind);else if(kind==='VIDEOFRAME')inputs.add('IMAGE');}
 for(const [kind,names]of Object.entries({IMAGE:['imageUrl','imageUrls','firstFrameUrl','lastFrameUrl'],VIDEO:['videoUrl','videoUrls'],AUDIO:['audioUrl','audioUrls']}))for(const name of names)if(Array.isArray(data.params?.[name])?data.params[name].some(Boolean):!!data.params?.[name])inputs.add(kind);
 // S3r defaults initialSubType to text-video independently of node.data.
 const bucket=String(props.initialSubType===undefined?'text-video':props.initialSubType).replaceAll('_','-').toLowerCase(),signature=bucket+':'+[...inputs].sort().join(','),cached=videoReplicaViews.get(data);
 if(cached?.groups===groups&&cached.models===props.models&&cached.originalPatch===props.onNodeDataPatch&&cached.signature===signature&&cached.single===data.viralRemixReplicaModel&&cached.multiple===data.viralRemixReplicaModels&&cached.code===data.viralRemixReplicaModelCode&&cached.selected===data.modelCode){
  if(cached.node!==node){cached.node=node;cached.view={...node,data:cached.data};}
  return{...props,models:cached.displayModels,onNodeDataPatch:cached.patch,...(props.targetNode===node?{targetNode:cached.view}:{node:cached.view})};
 }
 const catalog=new Map<string,any>(),choices=new Map<string,any>(),kinds:Record<string,string>={TEXT_VIDEO:'TEXT_TO_VIDEO',IMAGE_VIDEO:'IMAGE_TO_VIDEO',START_VIDEO:'IMAGE_TO_VIDEO',END_VIDEO:'IMAGE_TO_VIDEO',START_END_VIDEO:'IMAGE_TO_VIDEO',MULTIMODAL_VIDEO:'OMNI_REFERENCE',VIDEO_VIDEO:'VIDEO_TO_VIDEO',VIDEO_EDIT:'VIDEO_TO_VIDEO',VIDEO_EXTEND:'VIDEO_TO_VIDEO',VIDEO_MOTION_TRANSFER:'VIDEO_TO_VIDEO',VIDEO_CLIP_RESHOOT:'VIDEO_TO_VIDEO'},visit=(rows:any[])=>{for(const group of rows){for(const row of group.nodeModelList??[])for(const model of row.modelList??[])if(model?.available===true&&model.kind===kinds[row.nodeType]&&model.capabilityRef&&model.modelCode===model.capabilityRef&&fitsInputs(model,[...inputs])){choices.set(model.capabilityRef,model);if(row.nodeType==='MULTIMODAL_VIDEO')catalog.set(model.capabilityRef,model);}if(Array.isArray(group.modelGroupList))visit(group.modelGroupList);}};visit(groups);
 const current=(model:any)=>catalog.get(String(model?.capabilityRef??model?.modelCode??model?.code??'').trim()),view={...data};
 // Drop only the derived embedded menu fields. Ror's chosen model name and
 // config then come exclusively from the available public catalog.
 delete view.viralRemixReplicaModel;delete view.viralRemixReplicaModels;delete view.viralRemixReplicaModelCode;
 const single=current(data.viralRemixReplicaModel),multiple=Array.isArray(data.viralRemixReplicaModels)?data.viralRemixReplicaModels.map(current).filter(Boolean):[];
 if(single)view.viralRemixReplicaModel=single;if(multiple.length)view.viralRemixReplicaModels=multiple;
 const code=String(data.viralRemixReplicaModelCode??'').trim();if(catalog.has(code))view.viralRemixReplicaModelCode=code;
 const selected=String(data.modelCode??'').trim(),rows=Array.isArray(props.models?.[bucket])?props.models[bucket]:[];let displayModels=props.models;
 if(selected&&!rows.some((model:any)=>model?.modelCode===selected&&model.capabilityRef===selected&&model.available===true&&model.kind===kinds[bucket.toUpperCase().replaceAll('-','_')]&&fitsInputs(model,[...inputs]))){
  // nk repairs missing saved choices into its first model and commits params.
  // Keep this unavailable value in T only, never in the cascade catalog. Lc's
  // fallback menu also respects disabled; execution still rejects the old ref.
  displayModels={...props.models,[bucket]:[...rows.filter((model:any)=>model.modelCode!==selected),{modelCode:selected,modelName:'未配置模型',modelNameEn:'Unconfigured model',available:false,disabled:true,config:[],generateNum:[1]}]};
 }
 const originalPatch=props.onNodeDataPatch,patch=typeof originalPatch==='function'?(id:string,value:any,...rest:any[])=>{if(bindings&&!bindings.current())return;const model=value?.modelCode!==data.modelCode?choices.get(value?.modelCode):undefined,bound=model?{...value,capabilityRef:model.capabilityRef,capabilityVersion:model.capabilityVersion,parameterSchemaVersion:model.parameterSchemaVersion}:value;const result=originalPatch(id,bound,...rest);if(model&&id===node.id&&result!==false&&!(result&&typeof result.then==='function')&&bindings?.current())bindings.record(node,bound);return result;}:originalPatch;
 const mapped={...node,data:view};videoReplicaViews.set(data,{groups,models:props.models,signature,single:data.viralRemixReplicaModel,multiple:data.viralRemixReplicaModels,code:data.viralRemixReplicaModelCode,selected:data.modelCode,data:view,node,view:mapped,displayModels,originalPatch,patch});
 return{...props,models:displayModels,onNodeDataPatch:patch,...(props.targetNode===node?{targetNode:mapped}:{node:mapped})};
}
/** Filter before native aEt/bTe deduplicates modelName or nk repairs a saved
 * model. The original component, menu and callbacks still render the controls. */
export function nativeModelProps(props:any,bindings?:NativeModelBindingPort){
 props=projectModelCatalogProps(props);
 const originalNode=props?.targetNode??props?.node,node=originalNode&&bindings?.node(originalNode)||originalNode;
 if(node!==originalNode)props={...props,...(props.targetNode===originalNode?{targetNode:node}:{node})};
 if(node?.type==='rh-video'){props=savedVideoModeProps(props);props=unavailableApiVideoProps(apiVideoSelectionProps(h3PresetSelectionProps(historicalH3ModelProps(nativeVideoReplicaProps(props,props.targetNode??props.node,bindings),bindings),bindings),bindings),bindings);return videoModelInputAvailability(props,node);}
 if(!node||!['rh-text','rh-script','rh-storyboard','rh-image'].includes(node.type)||!props.models||!Array.isArray(props.nodes)||!Array.isArray(props.edges))return props;
 const inputs=new Set<string>(['TEXT']),add=(value:any)=>{const kind=String(value?.kind??value?.type??'').toUpperCase(),mime=String(value?.mimeType??'').toUpperCase();if(modalities.has(kind))inputs.add(kind);else if(kind==='RH-IMAGE'||mime.startsWith('IMAGE/'))inputs.add('IMAGE');else if(kind==='RH-VIDEO'||mime.startsWith('VIDEO/'))inputs.add('VIDEO');else if(kind==='RH-AUDIO'||mime.startsWith('AUDIO/'))inputs.add('AUDIO');};
 const params=node.data?.params??{};
 for(const [kind,names]of Object.entries({IMAGE:['imageUrl','imageUrls'],VIDEO:['videoUrl','videoUrls'],AUDIO:['audioUrl','audioUrls']}))for(const name of names)if(Array.isArray(params[name])?params[name].some(Boolean):!!params[name])inputs.add(kind);
 for(const reference of props.references??[])add(reference);
 const incoming=new Set(props.edges.filter((edge:any)=>edge.target===node.id).map((edge:any)=>edge.source));for(const source of props.nodes)if(incoming.has(source.id)){
  add(source);const data=source.data??{};if(typeof data.imageUrl==='string'&&data.imageUrl.trim())inputs.add('IMAGE');for(const output of Array.isArray(data.output)?data.output:[])if(output&&typeof output==='object')add(output);
 }
 const image=node.type==='rh-image',materials=image?nodeReadinessMaterials(node,{nodes:props.nodes,edges:props.edges}):[],savedVersion=String(node.data?.capabilityVersion||''),oldVersion=savedVersion==='1'||image&&savedVersion==='2',selected=String(node.data?.modelCode??node.data?.capabilityRef??''),signature=(image?'image:':'text:')+[...inputs].sort().join(',')+(image?':context:'+props.nodes.some((row:any)=>row.id===node.id)+':'+materials.map(item=>item.kind+':'+item.reference).sort().join(','):'')+(oldVersion?':v'+savedVersion+':'+selected:''),cache=projected.get(props.models)??new Map<string,any>();projected.set(props.models,cache);let models=cache.get(signature);
 if(!models){
  const kind=inputs.has('IMAGE')?'IMAGE_UNDERSTANDING':'LLM';let changed=false;
  models=Object.fromEntries(Object.entries(props.models).map(([bucket,rows]:[string,any])=>{
   if(!Array.isArray(rows))return[bucket,rows];const filtered=rows.filter((model:any)=>image||!model.model||!['LLM','IMAGE_UNDERSTANDING'].includes(model.kind)||model.kind===kind&&fitsInputs(model,[...inputs])&&fitsOutputs(model,kind)).map((model:any)=>{
    // Saved @1 has no reasoning control and only single-image generation.
    // A prompt edit must keep that node's authoritative historical version.
    if(oldVersion&&model.modelCode===selected&&['2','3'].includes(model.capabilityVersion)&&model.capabilityVersion!==savedVersion){
     if(image&&model.model&&['TEXT_TO_IMAGE','IMAGE_TO_IMAGE'].includes(model.kind)){changed=true;model={...model,capabilityVersion:savedVersion,parameterSchemaVersion:savedVersion,generateNum:savedVersion==='1'?[1]:model.generateNum,config:model.config.filter((field:any)=>field.paramName!=='transparentBackground'&&(savedVersion!=='1'||field.paramName!=='count')).map((field:any)=>field.paramName==='imageUrls'&&model.capabilityRef==='codex-image-edit-v1'?{...field,maxNum:1}:field)};}
     if(!image&&model.config?.some((field:any)=>field.paramName==='reasoning_effort')){changed=true;return{...model,capabilityVersion:'1',parameterSchemaVersion:'1',config:model.config.filter((field:any)=>field.paramName!=='reasoning_effort')};}
    }
    if(image&&model.model&&model.available===true){const reason=readinessModelInputReason(model,materials,[...inputs]);if(reason){changed=true;return{...model,disabled:true,studioInputDisabledReason:reason,reason,description:reason,descriptionEn:reason};}if(model.kind==='IMAGE_TO_IMAGE'&&props.nodes.some((row:any)=>row.id===node.id)&&!materials.some(item=>item.kind==='IMAGE')){changed=true;const hint='需要至少 1 张参考图片，可先选择模型再添加素材。';return{...model,description:[model.description,hint].filter(Boolean).join(' '),descriptionEn:[model.descriptionEn,hint].filter(Boolean).join(' ')};}}
    return model;
   });if(filtered.length!==rows.length)changed=true;return[bucket,filtered.length===rows.length&&!changed?rows:filtered];
  }));if(!changed)models=props.models;cache.set(signature,models);
 }
 let onNodeDataPatch=props.onNodeDataPatch;
 if(typeof onNodeDataPatch==='function'){
  const original=onNodeDataPatch,callbacks=patchCallbacks.get(original)??new WeakMap<object,WeakMap<object,Function>>();patchCallbacks.set(original,callbacks);const nodes=callbacks.get(models)??new WeakMap<object,Function>();callbacks.set(models,nodes);onNodeDataPatch=nodes.get(node);
  if(!onNodeDataPatch){onNodeDataPatch=(id:string,patch:any,...rest:any[])=>{if(bindings&&!bindings.current())return;const ref=patch?.modelCode??patch?.params?.rhModel;if(ref&&ref!==node.data?.modelCode&&Object.values(models).flat().some((row:any)=>row.capabilityRef===ref&&row.disabled===true))return false;const model=Object.values(models).flat().find((row:any)=>row.capabilityRef===ref&&row.available&&row.disabled!==true) as any,bind=model&&(!node.data?.capabilityVersion||ref!==node.data.modelCode),value=bind?{...patch,modelCode:ref,capabilityRef:ref,capabilityVersion:model.capabilityVersion,parameterSchemaVersion:model.parameterSchemaVersion}:patch;const result=original(id,value,...rest);if(bind&&id===node.id&&result!==false&&!(result&&typeof result.then==='function')&&bindings?.current())bindings.record(node,value);return result;};nodes.set(node,onNodeDataPatch);}
 }
 return models===props.models&&onNodeDataPatch===props.onNodeDataPatch?props:{...props,models,onNodeDataPatch};
}

export function installNativeModelProjection(native:any,bindingPort?:()=>NativeModelBindingPort|undefined):()=>void {
 const jsx=native?.j;if(!jsx)return()=>{};const installed:{name:string;original:Function;wrapper:Function}[]=[],composers=new WeakMap<Function,Function>(),intentMenus=new WeakMap<Function,Function>(),ownerContext=typeof native.r?.createContext==='function'?native.r.createContext(null):null;
 const parameterPorts=new WeakMap<NativeModelBindingPort,NativeModelBindingPort>();const parameterRefreshes=new Map<string,{port:NativeModelBindingPort;patch:any}>();let active=true;
 const currentBindings=()=>{
  const port=bindingPort?.();if(!port||typeof native.cw!=='function')return port;
  let view=parameterPorts.get(port);if(!view){view={...port,refreshParameters:(id,patch)=>{
   // The frozen nk form keeps an optimistic preset cache keyed by node ID.
   // Its exported authoritative-parameter event clears that cache and updates
   // the mounted form without remounting uploads, references or prompt tools.
   if(active&&port.current()){parameterRefreshes.clear();parameterRefreshes.set(id,{port,patch});}
  }};parameterPorts.set(port,view);}return view;
 };
 const composer=(type:any,props:any)=>{
  const node=props?.targetNode??props?.node,react=native.r;
  if(node?.type!=='rh-video'||!Object.hasOwn(props,'visible')||!Array.isArray(props.references)||!Array.isArray(props.videoModelGroups)||!props.models||typeof react?.useEffect!=='function')return type;
  let wrapped=composers.get(type);if(!wrapped){wrapped=function StudioVideoCatalogComposer(input:any){const [revision,setRevision]=react.useState(modelCatalogViewRevision);react.useEffect(()=>subscribeModelCatalogView(()=>setRevision(modelCatalogViewRevision())),[]);void revision;const projected=nativeModelProps(input,currentBindings()),selected=projected.targetNode??projected.node;
   react.useEffect(()=>{
    const row=parameterRefreshes.get(selected?.id),data=selected?.data;
    if(!row||!active||!row.port.current())return;
    // nk must first render the new catalog and subscribe its new callback.
    // Refreshing during the old commit normalizes a new duration to old 5s.
    if(data?.modelCode!==row.patch.modelCode||data?.capabilityVersion!==row.patch.capabilityVersion||data?.parameterSchemaVersion!==row.patch.parameterSchemaVersion||data?.params?.outputPreset!==row.patch.params?.outputPreset)return;
    parameterRefreshes.delete(selected.id);native.cw(selected.id,data);
   });
   const content=react.createElement(type,projected);return ownerContext?react.createElement(ownerContext.Provider,{value:(input.targetNode??input.node)?.id??null},content):content;};composers.set(type,wrapped);}return wrapped;
 };
 const intentMenu=(type:Function)=>{if(!ownerContext||typeof native.r?.useContext!=='function')return type;let wrapped=intentMenus.get(type);if(!wrapped){wrapped=function StudioVideoModelSelection(input:any){const owner=native.r.useContext(ownerContext),onChange=typeof input.onChange==='function'?(ref:string,...args:any[])=>typeof owner==='string'?withNativeModelSelectionIntent(owner,ref,()=>input.onChange(ref,...args)):input.onChange(ref,...args):input.onChange;return native.r.createElement(type,{...input,onChange});};intentMenus.set(type,wrapped);}return wrapped;};
 for(const name of ['jsx','jsxs'])if(typeof jsx[name]==='function'){
  const original=jsx[name],wrapper=function(this:any,...args:any[]){if(typeof args[0]==='function'){const bindings=currentBindings(),type=args[0],prepared=generatedImageSelectionProps(args[1],native.c5?.getState?.(),bindings),composerType=composer(type,prepared);if(composerType!==type){args[0]=composerType;args[1]=prepared;}else{const props=nativeImageToolbarProps(nativeModelProps(prepared,bindings),type.name),videoType=nativeVideoSourceMenu(type,props,native.r),sourceType=videoType===type?nativeOrdinarySourceMenu(type,props,native.r):videoType;args[0]=sourceType===type?type:intentMenu(sourceType);args[1]=sourceType===type?nativeVideoMenuProps(type,props):props;}}return Reflect.apply(original,this,args);};jsx[name]=wrapper;installed.push({name,original,wrapper});
 }
 return()=>{active=false;parameterRefreshes.clear();for(const {name,original,wrapper}of installed)if(jsx[name]===wrapper)jsx[name]=original;};
}

/** Public model availability refreshes after a user changes their key. No
 * credential bytes pass through this event or the canvas model projection. */
export function installModelSelectors(runtime?:any,_native?:any,notice?:(text:string)=>void,documentRoot:Document=document):()=>void {
 if(!runtime?.auth||!runtime?.api||!runtime?.execution)return()=>{};
 let disposed=false,sequence=0;const style=documentRoot.createElement('style');style.textContent=modelSourceMenuStyles;documentRoot.head.append(style);const settings=installProviderCredentialSettings(runtime,documentRoot);
 const refresh=async()=>{const turn=++sequence;try{runtime.execution.invalidateCatalog();const groups=await runtime.execution.handle('/canvas/model/group/list',{});if(!disposed&&turn===sequence&&runtime.auth.user&&Array.isArray(groups))replaceModelCatalogView(groups);}catch{if(!disposed&&turn===sequence)notice?.('API Key 已更新，模型列表暂时无法刷新，请重新打开作品后重试。');}};
 const clear=()=>{sequence++;clearModelCatalogView();};window.addEventListener(credentialsChangedEvent,refresh);const release=runtime.auth.onClear(clear);
 return()=>{disposed=true;sequence++;settings();release();window.removeEventListener(credentialsChangedEvent,refresh);clearModelCatalogView();style.remove();};
}
