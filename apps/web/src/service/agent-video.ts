import {ApiError} from '../api/client';
import {randomUuid} from '../browser-compat';
import {capabilityModel} from './execution';
import {isH3} from './h3-input';
import {isVideoProfile,videoModes,videoInputError,videoPreflightError,videoParameters,videoUploadFileError,videoUploadAccept} from './video-input';
import {videoPromptSelection} from './video-reference-bindings';
import type {Capability} from './model-catalog';
import {videoInputHint} from './video-input-guidance';
import {validateInputMedia} from './input-media-constraints';
import {preflightContext,preflightError,preflightInputKinds,withPreflightContext} from './preflight';

export async function launchAgentVideo(runtime:any,native:any,request:{capabilityRef:string;version:string;prompt:string;attachments:any[];parameters:any}){
 const projectId=runtime.inspect().id,userId=runtime.auth.user?.id,manager=native.bt(),id='studio-video-'+randomUuid();
 const current=()=>runtime.auth.user?.id===userId&&runtime.inspect().id===projectId&&native.bt()===manager;
 try{
 if(!projectId||!userId||!manager)throw new ApiError(409,'CANVAS_REQUIRED','请先打开画布。');
 runtime.storage.requirePermission(projectId,'canRun');
 const caps:Capability[]=await runtime.execution.catalog(),cap=caps.find(c=>c.capabilityRef===request.capabilityRef&&c.version===request.version&&c.available&&(isH3(c)||isVideoProfile(c)));
 if(!cap)throw preflightError('MODEL_UNAVAILABLE',caps.find(c=>c.capabilityRef===request.capabilityRef)?.reason||'视频模型当前不可用，请重新选择。',undefined,{capabilityRef:request.capabilityRef,capabilityVersion:request.version,issues:[{field:'model.kind',reason:'MODEL_UNAVAILABLE'}]});
 const error=videoPreflightError(cap,request.attachments);if(error)throw error;
 if(cap.parameterSchema?.['x-prompt-policy']!=='ignored'&&!request.prompt.trim())throw new ApiError(422,'PROMPT_REQUIRED','请描述希望生成的视频。');
 const params=videoParameters(cap,request.parameters),assets=await Promise.all(request.attachments.map(item=>runtime.storage.resolveAsset(item.url)));
 const actual=videoPreflightError(cap,assets.map((a:any)=>({type:a.kind})));if(actual)throw actual;
 validateInputMedia(cap,assets);
 if(assets.some((a:any,i:number)=>a.kind.toLowerCase()!==request.attachments[i].type))throw preflightError('ASSET_TYPE_MISMATCH','参考素材类型发生变化，请重新添加。',cap,{inputKinds:preflightInputKinds(assets.map((asset:any)=>asset.kind)),issues:assets.flatMap((asset:any,index:number)=>asset.kind.toLowerCase()===request.attachments[index].type?[]:[{field:'references.kind',reason:'KIND_MISMATCH',inputKind:preflightInputKinds([asset.kind])[0],inputIndex:index,assetId:asset.id,expectedKinds:preflightInputKinds([request.attachments[index].type])}])});
 if(!current())throw new ApiError(409,'STALE_CANVAS_SESSION','画布已切换，未提交生成。');
 runtime.storage.requirePermission(projectId,'canRun');
 const graph=manager.getRemoteData(),x=graph.nodes.length?Math.max(...graph.nodes.map((n:any)=>Number(n.position?.x||0)+Number(n.data?.width||400)))+580:480,y=0;
 const generic=isVideoProfile(cap),urls=assets.map((asset:any,index:number)=>generic?(String(asset.id).startsWith('rhtv-asset:')?asset.id:'rhtv-asset:'+asset.id):request.attachments[index].url);
 const refs=assets.map((a:any,i:number)=>({id:'studio-ref-'+randomUuid(),type:'rh-'+a.kind.toLowerCase(),position:{x:x-480,y:y+i*300},data:{title:request.attachments[i].name||a.fileName,sourceObjects:[urls[i]],[a.kind.toLowerCase()+'Url']:urls[i],status:'success'}}));
 const media=generic?Object.fromEntries(['IMAGE','VIDEO','AUDIO'].filter(kind=>assets.some((asset:any)=>asset.kind===kind)).map(kind=>[kind.toLowerCase()+'Urls',assets.flatMap((asset:any,index:number)=>asset.kind===kind?[urls[index]]:[])])):{};
 const node:any={id,type:'rh-video',position:{x,y},data:{title:cap.title,modelCode:cap.capabilityRef,capabilityRef:cap.capabilityRef,capabilityVersion:cap.version,parameterSchemaVersion:cap.parameterSchemaVersion,subType:videoModes[cap.parameterSchema['x-video-mode']],params:{prompt:request.prompt,...params,...media},routerParameters:params,generateNum:1,status:'idle'}};
 if(generic){const selection=videoPromptSelection(cap,node,{nodes:[node],edges:[]});if(selection)node.data.promptSelection=selection;}
 for(const source of refs)manager.addNode(source);manager.addNode(node);
 for(const source of refs)manager.addEdge({id:'studio-edge-'+randomUuid(),source:source.id,target:id});
 manager.flushOperationQueue?.(true);
 if(typeof window!=='undefined')window.dispatchEvent(new CustomEvent('canvas:focus-bounds',{detail:{nodeIds:[...refs.map((n:any)=>n.id),id]}}));
 // The ordinary node path persists the graph, binds the task and writes back
 // outputs in the background even after the composer closes or reloads.
 try{const result=await runtime.execution.run({projectId,targetType:'NODE',targetId:id,graph:manager.getRemoteData()});return{...result,nodeId:id};}
 catch(error){if(current())manager.patchNodeData(id,{status:'failed',errorMsg:error instanceof Error?error.message:'视频提交失败。'});throw error;}
 }catch(error){
  withPreflightContext(error,{capabilityRef:request.capabilityRef,capabilityVersion:request.version,inputKinds:preflightInputKinds(request.attachments.map(item=>item.type)),...preflightContext(error)});
  if(current())await runtime.execution.reportPreflightFailure?.({projectId,nodeId:id},error);throw error;
 }
}

/** Replace only the Agent video composer wiring. Keep the immutable native
 * editor, attachment cards, mode picker, model cascade and parameter popover. */
export function installAgentVideo(runtime:any,native:any,notice:(text:string)=>void){
 const react=native.r,jsx=native.j;if(!react?.useState||!jsx?.jsxs)return()=>{};
 const drafts=new WeakMap<Function,any>();let disposed=false;
 const clone=(element:any,props:any)=>react.cloneElement(element,props);
 function VideoComposer({input,bottom,toolbar}:any){
  const key=runtime.auth.user?.id+':'+runtime.inspect().id;
  let draft=drafts.get(input.props.onTextChange);if(!draft||draft.key!==key){draft={key,attachments:[...(input.props.attachments??[])],ref:'',params:{},busy:false,seen:new Set((input.props.attachments??[]).map((a:any)=>a.id))};drafts.set(input.props.onTextChange,draft);}
  const [,render]=react.useState(0),[caps,setCaps]=react.useState([] as Capability[]),fileRef=react.useRef(null),editor=react.useRef(null),mounted=react.useRef(true),composing=react.useRef(false);
  const redraw=()=>{if(mounted.current&&!disposed)render((n:number)=>n+1);};
  react.useEffect(()=>{mounted.current=true;let active=true;runtime.execution.catalog().then((rows:Capability[])=>{if(active)setCaps(rows.filter(c=>isH3(c)||isVideoProfile(c)));}).catch((e:Error)=>{if(active)notice(e.message);});return()=>{active=false;mounted.current=false;};},[]);
  const cap=caps.find((c:Capability)=>c.capabilityRef===draft.ref)??caps.find((c:Capability)=>c.available)??caps[0],mode=cap?videoModes[cap.parameterSchema['x-video-mode']]:'text-video';
  const models=caps.map((c:Capability)=>capabilityModel(c)),model=models.find((m:any)=>m.capabilityRef===cap?.capabilityRef),selected=model?{...model,code:model.modelCode,name:model.modelName,nameEn:model.modelNameEn}:null;
  const groups=caps.map((c:Capability,i:number)=>({modelGroupId:c.capabilityRef,modelGroupName:c.title,modelGroupNameEn:c.title,nodeTypeList:[videoModes[c.parameterSchema['x-video-mode']].toUpperCase().replaceAll('-','_')],nodeModelList:[{nodeType:videoModes[c.parameterSchema['x-video-mode']].toUpperCase().replaceAll('-','_'),modelList:[models[i]]}]}));
  const allModels=Object.fromEntries([...new Set(Object.values(videoModes))].map(type=>[type,models.filter((_:any,i:number)=>videoModes[caps[i].parameterSchema['x-video-mode']]===type)]));
  const choose=(value:any)=>{const ref=value.modelCode||value.code,next=caps.find((c:Capability)=>c.capabilityRef===ref);if(!next?.available){notice(next?.reason||'此视频模型尚未配置。');return;}if(ref!==draft.ref){draft.ref=ref;draft.params={};redraw();}};
  react.useEffect(()=>{for(const item of input.props.attachments??[]){if(draft.seen.has(item.id))continue;draft.seen.add(item.id);const problem=videoInputError(cap,[...draft.attachments,item].map((a:any)=>({type:a.type})),false);if(problem){notice(problem);input.props.onRemoveAttachment(item.id);}else{draft.attachments.push(item);redraw();}}},[input.props.attachments,cap]);
  draft.text=input.props.text;
  const error=videoInputError(cap,draft.attachments),needsPrompt=cap?.parameterSchema?.['x-prompt-policy']!=='ignored',canSend=!!cap&&!error&&!draft.busy&&(!needsPrompt||!!input.props.text?.trim());
  const send=async()=>{
   if(composing.current||draft.busy)return;const problem=videoInputError(cap,draft.attachments);if(problem){notice(problem);return;}
   const submission=editor.current?.getSubmission(),prompt=submission?.requestText??input.props.text;
   if(needsPrompt&&!prompt?.trim()){notice('请描述希望生成的视频。');return;}
   draft.busy=true;redraw();const sentText=input.props.text,sent=[...draft.attachments];
   try{await launchAgentVideo(runtime,native,{capabilityRef:cap!.capabilityRef,version:cap!.version,prompt:prompt??'',attachments:sent,parameters:draft.params});if(mounted.current&&!disposed){notice('已创建视频节点，正在生成；结果将自动保存到画布。');if(draft.text===sentText)input.props.onTextChange('');const sentIds=new Set(sent.map((a:any)=>a.id));draft.attachments=draft.attachments.filter((a:any)=>!sentIds.has(a.id));for(const item of input.props.attachments??[])if(sentIds.has(item.id))input.props.onRemoveAttachment(item.id);}}
   catch(e){if(mounted.current&&!disposed)notice(e instanceof Error?e.message:'视频提交失败。');}
   finally{draft.busy=false;redraw();}
  };
  const remove=(id:string)=>{
   draft.attachments.find((item:any)=>item.id===id)?.controller?.abort();
   draft.attachments=draft.attachments.filter((item:any)=>item.id!==id);input.props.onRemoveAttachment(id);redraw();
  };
  const upload=async(item:any)=>{
   if(!cap||item.uploading||draft.key!==runtime.auth.user?.id+':'+runtime.inspect().id)return;
   const controller=new AbortController();item.controller=controller;item.uploading=true;item.uploadError=false;redraw();
   try{
    const url=await runtime.uploadFile(item.file,{signal:controller.signal,validate:(file:File)=>{
     const problem=videoUploadFileError(cap,file);if(problem)throw new Error(problem);
    }});
    if(!controller.signal.aborted){item.url=url;item.preview=item.type==='image'?url:undefined;}
   }catch(e){if(!controller.signal.aborted){item.uploadError=true;if(mounted.current&&draft.key===runtime.auth.user?.id+':'+runtime.inspect().id)notice(e instanceof Error?e.message:'上传失败。');}}
   finally{item.uploading=false;delete item.controller;redraw();}
  };
  const addFiles=(files:FileList|File[])=>{
   if(draft.busy)return;
   for(const file of Array.from(files)){
    const item={id:randomUuid(),file,name:file.name,type:file.type.split('/')[0],uploading:false};
    const problem=videoInputError(cap,[...draft.attachments,item].map((a:any)=>({type:a.type})),false);
    if(problem){notice(problem);continue;}
    draft.attachments.push(item);void upload(item);
   }
   redraw();
  };
  const open=()=>{if(fileRef.current){fileRef.current.accept=videoUploadAccept(cap);fileRef.current.click();}};Object.assign(open,{studioH3Upload:true});
  const direct=toolbar.props.directPanel;
  const view=direct?clone(direct,{allModelData:allModels,videoModelGroups:groups,attachments:draft.attachments,subType:mode,selectedModel:selected,modelParams:cap?{...videoParameters(cap),...draft.params}:{},onModelChange:choose,onModelParamsChange:(p:any)=>{draft.params=p;redraw();},onSubTypeChange:()=>{}}):null;
  const modeOptions=Object.entries({TEXT_TO_VIDEO:'文生视频',FIRST_FRAME:'首帧',FIRST_LAST_FRAME:'首尾帧',LAST_FRAME:'尾帧',OMNI_REFERENCE:'全能参考',MOTION_TRANSFER:'动作迁移'}).map(([m,title])=>{const profiles=caps.filter((c:Capability)=>c.parameterSchema['x-video-mode']===m);return{type:videoModes[m],title,disabled:!profiles.some((c:Capability)=>c.available),reason:profiles.find((c:Capability)=>c.reason)?.reason||'此模式尚未配置。'};});
  const inputView=clone(input,{ref:editor,attachments:draft.attachments,fileInputRef:fileRef,onSend:send,onRemoveAttachment:remove,onRetryAttachment:(id:string)=>{const item=draft.attachments.find((a:any)=>a.id===id);if(item?.file)void upload(item);},onFileSelect:addFiles,onOpenFilePicker:open,onOpenCanvasPicker:input.props.onOpenCanvasPicker,onCompositionStart:()=>{composing.current=true;},onCompositionEnd:()=>{composing.current=false;}});
  const toolbarView=clone(toolbar,{onSend:send,canSend,isLoading:false,onOpenFilePicker:open,directPanel:view,showDirectPrice:false,videoSubType:mode,videoModeOptions:modeOptions,onVideoModeSelect:(option:any)=>{const next=caps.find((c:Capability)=>c.available&&videoModes[c.parameterSchema['x-video-mode']]===option.type);if(next)choose({code:next.capabilityRef});}});
  const referenceHint=videoInputHint(cap);
  return react.createElement(react.Fragment,null,inputView,react.createElement('div',{className:'studio-agent-video-hint',role:'status'},draft.busy?'正在提交视频任务…':error??(mode==='text-video'?'通过文字描述生成视频。':mode==='start-video'?'1 张图片作为首帧。':mode==='end-video'?'1 张图片作为尾帧。':mode==='start-end-video'?'图片按添加顺序用作首帧、尾帧。':referenceHint||`最多 ${cap?.parameterSchema['x-media-limits']?.IMAGE??0} 张图片、${cap?.parameterSchema['x-media-limits']?.AUDIO??0} 段音频${cap?.parameterSchema['x-media-limits']?.VIDEO?`、${cap.parameterSchema['x-media-limits'].VIDEO} 段视频`:''}，合计最多 ${cap?.parameterSchema['x-media-total-limit']??12} 个。`)),clone(bottom,{children:toolbarView}));
 }
 const installed:{name:string;original:Function;wrapper:Function}[]=[];
 for(const name of ['jsx','jsxs']){const original=jsx[name],wrapper=function(this:any,...args:any[]){
  const props=args[1];if(props?.onClick?.studioH3Upload)args[1]={...props,title:'上传图片、视频或音频','aria-label':'上传图片、视频或音频'};if(args[0]==='div'&&typeof props?.className==='string'&&props.className.split(/\s+/).includes('ap-input-overlay-host')&&Array.isArray(props.children)){
   const input=props.children[0],bottom=props.children[1],toolbar=bottom?.props?.children;
   if(input?.props?.chatMode==='video'&&toolbar?.props?.directPanel&&typeof input.props.onTextChange==='function')args[1]={...props,children:react.createElement(VideoComposer,{key:runtime.auth.user?.id+':'+runtime.inspect().id,input,bottom,toolbar})};
  }return Reflect.apply(original,this,args);
 };jsx[name]=wrapper;installed.push({name,original,wrapper});}
 const style=document.createElement('style');style.textContent='.studio-agent-video-hint{padding:4px 14px;color:#aeb2b8;font-size:12px;line-height:1.5}.hcp-inline-menu__group,.mg-cascade-panel__item,.mg-cascade-panel__col,.hcp-inline-chip--model{text-transform:none!important;letter-spacing:normal!important}';document.head.append(style);
 return()=>{disposed=true;style.remove();for(const {name,original,wrapper}of installed)if(jsx[name]===wrapper)jsx[name]=original;};
}
