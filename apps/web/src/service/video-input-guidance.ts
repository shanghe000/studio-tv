import type {Capability} from './model-catalog';
import {nativeVideoReferences} from './video-command';

export interface VideoInputMaterial {kind:'IMAGE'|'VIDEO'|'AUDIO';title:string;minimum:number;maximum:number;description:string;maxBytes?:number}
export interface VideoInputGuidance {schemaVersion:'1';mode:string;available:boolean;summary:string;connection:string;materials:VideoInputMaterial[];visualRequired:boolean;anyMedia:boolean;maximumTotal?:number;promptIgnored:boolean;subject?:string}
const modes=new Set(['TEXT_TO_VIDEO','FIRST_FRAME','FIRST_LAST_FRAME','LAST_FRAME','OMNI_REFERENCE','MOTION_TRANSFER']);
const amount=(n:unknown,fallback=0)=>Number.isSafeInteger(n)&&Number(n)>=0&&Number(n)<=50?Number(n):fallback;
const materialName={IMAGE:'参考图片',VIDEO:'参考视频',AUDIO:'参考音频'} as const;
const unit={IMAGE:'张',VIDEO:'段',AUDIO:'段'} as const;

/** Informational UI metadata comes from the same public input contract as
 * execution. It never changes a parameter, a saved model or a preset tuple. */
export function videoInputGuidance(cap:Capability|undefined):VideoInputGuidance|undefined{
 if(!cap||cap.testMode!==false||!cap.model||!cap.outputKinds?.includes('VIDEO'))return;
 const schema=cap.parameterSchema??{},mode=schema['x-video-mode'];if(!modes.has(mode))return;
 const input=schema['x-input-constraints']??{},limits=schema['x-media-limits']??{},roles=Array.isArray(schema['x-media-roles'])?schema['x-media-roles']:[];
 const materials:VideoInputMaterial[]=[];
 for(const kind of ['IMAGE','VIDEO','AUDIO'] as const){
  const declared=roles.filter((role:any)=>role?.kind===kind),key=kind.toLowerCase(),maximum=amount(limits[kind],amount(input[`max_${key}s`]));if(!maximum)continue;
  let minimum=amount(input[`min_${key}s`],declared.reduce((sum:number,role:any)=>sum+amount(role.minItems),0));
  if(kind==='IMAGE'&&['FIRST_FRAME','LAST_FRAME','FIRST_LAST_FRAME'].includes(mode))minimum=mode==='FIRST_LAST_FRAME'?2:1;
  const title=declared.map((role:any)=>role.title).filter((title:any)=>typeof title==='string'&&title.trim()).join(' / ')||materialName[kind];
  const descriptions=declared.map((role:any)=>role.description).filter((text:any)=>typeof text==='string'&&text.trim());
  const maxBytes=schema['x-input-media-constraints']?.schemaVersion==='1'?schema['x-input-media-constraints'].kinds?.[kind]?.maxBytes:undefined;
  const sizeHint=Number.isSafeInteger(maxBytes)&&maxBytes>0?`每${unit[kind]}不超过 ${maxBytes/1048576} MiB。`:'';
  const description=[descriptions.join('；')||(minimum===maximum?`需要 ${minimum} ${unit[kind]}。`:minimum?`需要 ${minimum}–${maximum} ${unit[kind]}。`:`可选，最多 ${maximum} ${unit[kind]}。`),sizeHint].filter(Boolean).join(' ');
  materials.push({kind,title,minimum,maximum,description,...(sizeHint?{maxBytes}:{})});
 }
 const visualRequired=input.require_visual===true||mode==='OMNI_REFERENCE'&&schema['x-reference-requirement']!=='ANY_MEDIA',anyMedia=mode==='OMNI_REFERENCE'&&schema['x-reference-requirement']==='ANY_MEDIA';
 const connection='将上游素材节点的输出端连到本节点左侧输入端，也可在下方素材区添加已上传素材。';
 const images=materials.find(row=>row.kind==='IMAGE'),videos=materials.find(row=>row.kind==='VIDEO');
 const summaries:Record<string,string>={TEXT_TO_VIDEO:'填写视频描述即可生成，无需参考素材。',FIRST_FRAME:'需要 1 张图片作为视频首帧。',LAST_FRAME:'需要 1 张图片作为视频尾帧。',FIRST_LAST_FRAME:'需要 2 张图片，按素材顺序分别作为首帧和尾帧。',MOTION_TRANSFER:'需要 1 张人物参考图和 1 段动作源视频。'};
 const summary=summaries[mode]||(anyMedia?'至少添加 1 项图片、视频或音频参考。':images?.minimum?`至少添加 ${images.minimum} 张参考图片。`:videos?'至少添加 1 张图片或 1 段视频作为视觉参考。':'至少添加 1 张参考图片。');
 const control=schema['x-subject-control'];
 const sourceMotion=cap.capabilityRef==='h3-motion-transfer-v1'&&cap.version==='2'&&cap.model.providerRef==='comfy'&&cap.model.modelRef==='h3'&&schema['x-temporal-alignment']?.durationPolicy==='SOURCE_VIDEO';
 const subject=control?.mode==='SINGLE'?(sourceMotion?'参考图和动作视频都需要是单人素材，无需上传遮罩。建议从源视频截帧重绘人物，保留姿态、构图和背景；长片可能遗漏手势或改变背景。':'参考图和动作视频都需要是单人素材，无需上传遮罩。'):control?.mode==='MULTI'?'在“人物动作配对”中选择图片人物与视频人物。两边按人物首次出现的画面从左到右、从 0 开始编号；遮罩自动生成，无需手绘。':undefined;
 const maximumTotal=amount(input.max_references,amount(schema['x-media-total-limit']));
 return{schemaVersion:'1',mode,available:cap.available,summary,connection,materials,visualRequired,anyMedia,...(maximumTotal?{maximumTotal}:{}),promptIgnored:schema['x-prompt-policy']==='ignored',...(subject?{subject}:{})};
}

export function videoInputHint(cap:Capability|undefined){
 const guide=videoInputGuidance(cap);if(!guide)return '';
 if(!guide.available)return '此模型暂不可用，请在模型菜单中选择已开放的型号。';
 const optional=guide.materials.filter(row=>row.minimum===0).map(row=>`${row.title}最多 ${row.maximum} ${unit[row.kind]}`).join('，');
 const subject=cap?.parameterSchema?.['x-subject-control']?.mode==='MULTI'?'请在参数中配对人物，编号从 0 开始；人物遮罩自动生成。':guide.subject??'';
 return[guide.summary,guide.mode==='TEXT_TO_VIDEO'?'':'上传参考素材，或从画布中选择已有素材。',optional?`可选：${optional}。`:'',guide.promptIgnored?'此型号按参考图和动作视频处理，无需填写提示词。':'',subject].filter(Boolean).join(' ');
}

/** Empty canvas video bodies keep their native icon and layout. The owned
 * note explains the current model and live input connections without changing
 * either the graph or native model selection. */
export function installCanvasVideoInputGuidance(runtime:any,native:any,propsOf:(element:Element)=>any[],root:Document=document){
 const owned=new Map<HTMLElement,{note:HTMLElement;signature:string}>(),panelNotes=new Map<HTMLElement,{note:HTMLElement;signature:string}>();
 let disposed=false,queued=false,identity='',caps:Capability[]=[],epoch=0;
 const style=root.createElement('style');style.id='studio-video-input-guidance';style.textContent=videoInputGuidanceStyles;root.head.append(style);
 const clear=()=>{for(const [host,{note}]of owned){note.remove();host.classList.remove('studio-video-guidance-host');}owned.clear();for(const {note}of panelNotes.values())note.remove();panelNotes.clear();};
 const refresh=()=>{
  if(queued||disposed)return;queued=true;queueMicrotask(()=>{
   queued=false;if(disposed)return;
   const key=runtime.auth?.user?String(runtime.auth.user.id)+':'+String(runtime.inspect?.().id??''):'';
   if(key!==identity){identity=key;caps=[];const request=++epoch;if(key&&typeof runtime.execution?.catalog==='function')void runtime.execution.catalog().then((rows:Capability[])=>{if(!disposed&&epoch===request){caps=rows;refresh();}}).catch(()=>{});}
   if(!key){clear();return;}
   const mounted=native.bt?.()?.getRemoteData?.(),graph=mounted?(runtime.storage?.restoreModelBindings?.(String(runtime.inspect?.().id??''),mounted)??mounted):undefined;if(!Array.isArray(graph?.nodes)||!Array.isArray(graph?.edges)){clear();return;}
   const encode=(value:any):any=>typeof value==='string'?(runtime.storage?.encodeAsset?.(value)??value):Array.isArray(value)?value.map(encode):value;
   const safeGraph={...graph,nodes:graph.nodes.map((row:any)=>{const data=row.data??{},params=data.params??{},mapped={...data,params:{...params}};for(const kind of ['image','video','audio']){const key=kind+'Url';if(Object.hasOwn(data,key))mapped[key]=encode(data[key]);if(Object.hasOwn(params,key+'s'))mapped.params[key+'s']=encode(params[key+'s']);}if(Object.hasOwn(data,'sourceObjects'))mapped.sourceObjects=encode(data.sourceObjects);if(data.output)mapped.output=Array.isArray(data.output)?data.output.map((output:any)=>typeof output==='string'?encode(output):output&&typeof output==='object'?{...output,url:encode(output.url)}:output):typeof data.output==='string'?encode(data.output):{...data.output,url:encode(data.output.url)};return{...row,data:mapped};})};
   const livePanels=new Set<HTMLElement>();
   for(const panel of root.querySelectorAll<HTMLElement>('.rh-canvas-video-params[data-target-node-id]')){
    const button=panel.querySelector('.generate-action-button'),model=button?propsOf(button).find(p=>p.currentModel)?.currentModel:undefined;
    const meta=model?.config?.find((field:any)=>field.paramName==='outputPreset')?.studioVideoParameterMetadata;
    const guide=model?.studioVideoInputGuidance as VideoInputGuidance|undefined;
    if(model?.capabilityRef!=='h3-motion-transfer-v1'||model.capabilityVersion!=='2'||!model.available||meta?.durationPolicy!=='SOURCE_VIDEO'||!guide?.promptIgnored)continue;
    const node=safeGraph.nodes.find((node:any)=>node.id===panel.getAttribute('data-target-node-id')),host=panel.querySelector<HTMLElement>('.config-panel-wrap__basic');if(!node||!host)continue;
    const images=nativeVideoReferences(node,safeGraph,'image'),videos=nativeVideoReferences(node,safeGraph,'video');
    const imageBytes=guide.materials.find(row=>row.kind==='IMAGE')?.maxBytes;
    const title=`所需素材：1 张单人人物图${imageBytes?`（≤${imageBytes/1048576} MiB）`:''} · 1 段 ${meta.sourceSecondsMin}–${meta.sourceSecondsMax} 秒动作视频`;
    const status=images===undefined||videos===undefined?'请确认素材已上传完成，并选好需要的历史版本。':images.length===1&&videos.length===1?'已连接人物图和动作视频。':images.length>1||videos.length>1?'请仅保留 1 张人物图和 1 段动作视频。':`还需添加：${[images.length<1?'人物参考图':'',videos.length<1?'动作源视频':''].filter(Boolean).join('、')}。`;
    const detail='时长跟随动作视频，无需填写提示词或上传遮罩。 '+status,advice='参考图建议从源视频截帧重绘，保留姿态、构图和背景；长片可能遗漏手势或改变背景。',signature=JSON.stringify([title,detail,advice]),prior=panelNotes.get(panel);livePanels.add(panel);
    if(prior?.note.isConnected&&prior.signature===signature)continue;
    const note=prior?.note??root.createElement('div');note.className='studio-motion-source-hint';note.setAttribute('role','note');note.setAttribute('aria-label','H3动作生成所需素材');
    note.replaceChildren();for(const [className,text]of [['studio-motion-source-hint__title',title],['studio-motion-source-hint__detail',detail],['studio-motion-source-hint__detail',advice]]){const line=root.createElement('p');line.className=className;line.textContent=text;note.append(line);}
    if(note.parentNode!==host)host.insertBefore(note,host.firstChild);panelNotes.set(panel,{note,signature});
   }
   for(const [panel,{note}]of panelNotes)if(!livePanels.has(panel)||!panel.isConnected){note.remove();panelNotes.delete(panel);}
   const live=new Set<HTMLElement>();
   for(const host of root.querySelectorAll<HTMLElement>('.react-flow__node[data-id] .rh-video-empty-actions')){
    const id=host.closest('.react-flow__node')?.getAttribute('data-id'),node=safeGraph.nodes.find((row:any)=>row.id===id);if(!node||node.type!=='rh-video'||node.data?.isUpload===true)continue;live.add(host);
    const panel=[...root.querySelectorAll<HTMLElement>('.rh-canvas-video-params[data-target-node-id]')].find(row=>row.getAttribute('data-target-node-id')===id);
    const button=panel?.querySelector('.generate-action-button');
    const selected=button?propsOf(button).find(p=>p.currentModel)?.currentModel:undefined;
    const ref=selected?.capabilityRef??node.data?.capabilityRef??node.data?.modelCode,version=selected?.capabilityVersion??node.data?.capabilityVersion;
    const capability=caps.find(cap=>cap.capabilityRef===ref&&(!version||cap.version===version));
    const guide:VideoInputGuidance|undefined=selected?.studioVideoInputGuidance??videoInputGuidance(capability);
    // A saved historical version absent from the latest catalog is unknown,
    // not unavailable. Its authoritative version is resolved by inspection.
    const unavailable=selected?.available===false||capability?.available===false;
    const counts:Record<string,number>={};let unresolved=false;
    for(const kind of ['image','video','audio'] as const){const refs=nativeVideoReferences(node,safeGraph,kind);if(refs===undefined)unresolved=true;counts[kind.toUpperCase()]=refs?.length??0;}
    const usable=guide?.available===true;
    const title=unavailable?'当前视频型号暂不可用':usable?guide.summary:ref?'已选视频型号':'先选择视频模式和型号';
    const detail=unavailable?'请在下方型号菜单选择已开放的型号。':usable?(guide.mode==='TEXT_TO_VIDEO'?'在下方填写视频描述，然后开始生成。':guide.connection):ref?'展开下方参数，查看当前型号的输入要求。':'不同模式需要的输入不同；选择型号后会显示所需素材。';
    const connected=[counts.IMAGE?`${counts.IMAGE} 张图片`:'',counts.VIDEO?`${counts.VIDEO} 段视频`:'',counts.AUDIO?`${counts.AUDIO} 段音频`:''].filter(Boolean);
    const missing=usable?guide.materials.filter(row=>counts[row.kind]<row.minimum).map(row=>row.title):[];
    if(usable&&!missing.length&&guide.visualRequired&&!counts.IMAGE&&!counts.VIDEO)missing.push('图片或视频参考');
    if(usable&&!missing.length&&guide.anyMedia&&!connected.length)missing.push('参考素材');
    const selectedHistory=graph.edges.some((edge:any)=>edge.target===node.id&&graph.nodes.some((source:any)=>source.id===edge.source&&source.data?.selectedOutputHistoryId));
    const status=unavailable?'':unresolved?(selectedHistory?'历史素材将在提交时核对，请确认已选择需要的版本。':'参考素材尚未就绪，请等待上传完成或重新添加。'):missing.length?`还需添加：${missing.join('、')}`:connected.length?`已连接：${connected.join(' · ')}`:usable&&guide.materials.length?'也可在下方素材区添加已上传素材。':'';
    const signature=JSON.stringify([title,detail,status]),prior=owned.get(host);
    if(!host.classList.contains('studio-video-guidance-host'))host.classList.add('studio-video-guidance-host');
    if(prior&&prior.note.parentNode===host&&prior.signature===signature)continue;
    const note=prior?.note??root.createElement('div');note.className='studio-video-input-guide';note.setAttribute('role','note');note.setAttribute('aria-label','视频生成所需素材');
    note.replaceChildren();for(const [className,text]of [['studio-video-input-guide__title',title],['studio-video-input-guide__detail',detail],['studio-video-input-guide__status',status]]){if(!text)continue;const line=root.createElement('p');line.className=className;line.textContent=text;note.append(line);}
    if(note.parentNode!==host)host.append(note);owned.set(host,{note,signature});
   }
   for(const [host,{note}]of owned)if(!live.has(host)||!host.isConnected){note.remove();host.classList.remove('studio-video-guidance-host');owned.delete(host);}
  });
 };
 const observer=new MutationObserver(refresh);observer.observe(root.body,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['class','src','data-target-node-id']});refresh();
 return()=>{disposed=true;epoch++;observer.disconnect();clear();style.remove();};
}

export const videoInputGuidanceStyles=`
 .studio-motion-source-hint{flex:0 0 auto;margin:0 0 10px;padding:12px 20px 10px;border-bottom:1px solid var(--canvas-border-default,#3a3a3a);font-size:11px;line-height:1.6;color:var(--canvas-text-secondary,#b8b8bd);overflow-wrap:anywhere}
 .studio-motion-source-hint p{margin:0;font-size:11px;line-height:1.6}
 .studio-motion-source-hint .studio-motion-source-hint__title{margin-bottom:4px;color:var(--canvas-text-primary,#e5e5e5);font-size:12px;font-weight:500}
 .rh-video-node .rh-video-empty-actions.studio-video-guidance-host{justify-content:center;padding:16px 20px}
 .rh-video-node .rh-video-empty-actions.studio-video-guidance-host>.rh-video-empty-actions__icon{position:static;left:auto;top:auto;width:32px;height:32px;margin:0 auto 10px;transform:none}
 .rh-video-node .rh-video-empty-actions.studio-video-guidance-host .rh-node-empty-icon-raw,.rh-video-node .rh-video-empty-actions.studio-video-guidance-host .rh-node-empty-icon-svg{width:32px;height:32px}
 .rh-video-node .rh-video-empty-actions.studio-video-guidance-host.is-actions-hidden>.studio-video-input-guide{display:block}
 .studio-video-input-guide{box-sizing:border-box;width:100%;max-width:310px;margin:0 auto;text-align:center;pointer-events:none}
 .studio-video-input-guide p{padding:0;overflow-wrap:anywhere}
 .studio-video-input-guide__title{margin:0;color:var(--canvas-text-primary,#e5e5e5);font-size:12px;font-weight:500;line-height:1.5}
 .studio-video-input-guide__detail{margin:6px 0 0;color:var(--canvas-text-secondary,#a0a0a6);font-size:11px;line-height:1.55}
 .studio-video-input-guide__status{margin:7px 0 0;color:var(--canvas-text-secondary,#a0a0a6);font-size:11px;line-height:1.5}
`;
