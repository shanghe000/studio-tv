import {ApiError} from '../api/client';
import {randomUuid} from '../browser-compat';
import {nativeVideoReferences} from './video-command';
import {createH3LongformMode} from './h3-longform-mode';
import {LongformClient,longformBusy,longformDraft,longformDuration,longformOutputLimitText,longformResolutionPresets,validateLongformDraft,type LongformCapabilities,type LongformDraft,type LongformProject,type LongformSegment,type LongformAction,type LongformReference} from './h3-longform';

const panelSelector='.rh-canvas-video-params[data-target-node-id]';
const stateNames:Record<string,string>={QUEUED:'排队中',RUNNING:'生成中',PREPARING:'准备中',SUBMITTING:'正在提交模型',COMPOSING:'正在合片',SUCCEEDED:'已完成',FAILED:'失败',UNKNOWN:'正在确认任务',STOPPED:'已停止',PENDING:'待生成',STALE:'需重做'};
const phaseNames:Record<string,string>={QUEUED:'等待生成',LOADING_MODELS:'加载模型',SAMPLING:'采样',DECODING:'解码',SAVING:'保存结果',COMPOSING:'合并视频',VERIFYING:'检查结果',SUBMITTED:'已提交模型',RUNNING:'模型处理中',SEGMENT_GENERATION:'分段生成',COMPLETE:'完成'};
const fieldNames:Record<string,string>={aspectRatio:'画面比例',aspect_ratio:'画面比例',megapixels:'百万像素',duration:'默认段时长',durationSeconds:'默认段时长',seed:'种子',seedMode:'后续段种子方式',steps:'采样步数',sampler:'采样器',samplerName:'采样器',sampler_name:'采样器',scheduler:'调度器',denoise:'降噪强度',sigmas:'自定义 SIGMAS',loraName:'LoRA',lora_name:'LoRA',loras:'LoRA',attention:'注意力方式',attentionBackend:'注意力方式',contextFrames:'续接上下文帧数',dynamicMask:'动态掩码',driftCorrection:'防漂移',livePreview:'云端采样预览',previewInterval:'预览间隔',previewFrames:'预览帧数',previewMaxResolution:'预览最长边',previewFps:'预览帧率',model:'视频模型',clip:'文本编码器',videoVae:'视频 VAE',audioVae:'音频 VAE',sparseAttention:'稀疏注意力',refImageSize:'参考图尺寸',enabled:'启用',selection:'算法',tau:'稀疏阈值',keepPercent:'保留比例（%）',startPercent:'开始比例',endPercent:'结束比例',denseBlocks:'密集块',minTokens:'最少 Token',extraTokens:'额外 Token',sinkConditioning:'参考条件保留',verbose:'详细采样信息',name:'名称',strength:'强度'};
const primaryFields=new Set(['aspectRatio','aspect_ratio','megapixels','duration','durationSeconds']);
const spatialFields=new Set(['aspectRatio','aspect_ratio','megapixels','width','height']);
export function longformSettingHelp(key:string,description:unknown){
 if(key==='livePreview')return '此项控制云端采样预览；Studio TV 显示生成进度和完成后的分段视频，不显示采样中的实时画面。';
 if(typeof description!=='string'||!description.trim()||/^Native (?:SGUN\/H3|sparse-attention)\b/i.test(description.trim()))return;
 if(key==='seed')return '使用十进制整数文本保存种子，支持 0–18446744073709551615，避免大整数精度损失。';
 if(key==='sigmas')return 'SIGMAS 需严格递减并以 0 结束；填写 null 时使用采样步数、调度器和降噪设置。';
 return description;
}

export function longformReferences(node:any,graph:any,encode:(value:string)=>string):LongformReference[]{
 const walk=(value:any):any=>typeof value==='string'?encode(value):Array.isArray(value)?value.map(walk):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([k,v])=>[k,walk(v)])):value;
 const safe=walk(graph),target=safe.nodes.find((n:any)=>n.id===node.id),refs:LongformReference[]=[];
 for(const kind of ['image','video','audio'] as const){
  const values=nativeVideoReferences(target,safe,kind,{nativeComposer:true});
  if(values===undefined)throw new ApiError(422,'LONGFORM_REFERENCE_NOT_READY','参考素材尚未就绪，请完成上传并检查连线。');
  for(const value of values){if(!/^rhtv-asset:[A-Za-z0-9_-]{1,200}$/.test(value))throw new ApiError(422,'LONGFORM_REFERENCE_INVALID','请使用已上传到画布的参考素材。');refs.push({assetId:value.slice(11),kind:kind.toUpperCase() as LongformReference['kind'],role:kind==='image'?'REFERENCE_IMAGE':kind==='video'?'REFERENCE_VIDEO':'REFERENCE_AUDIO'});}
 }
 return refs;
}

/** Pair by owned asset identity, not the video's transient position. A native
 * reorder changes the serialized index; a disconnected target fails closed. */
export class LongformAudioRoles {
 private pairs=new Map<string,string|null>();
 restore(references:LongformReference[]){const videos=references.filter(ref=>ref.kind==='VIDEO');for(const ref of references)if(ref.kind==='AUDIO')this.pairs.set(ref.assetId,ref.role==='VIDEO_AUDIO'?videos[ref.videoIndex??-1]?.assetId??'missing-video:'+String(ref.videoIndex):null);}
 set(audioAssetId:string,videoAssetId:string|null){this.pairs.set(audioAssetId,videoAssetId);}
 target(audioAssetId:string){return this.pairs.get(audioAssetId);}
 apply(references:LongformReference[]):LongformReference[]{
  const videos=references.filter(ref=>ref.kind==='VIDEO'),paired=new Set<number>();
  return references.map(ref=>{if(ref.kind!=='AUDIO')return{...ref};const target=this.pairs.get(ref.assetId);if(!target)return{assetId:ref.assetId,kind:'AUDIO',role:'REFERENCE_AUDIO'};
   const indices=videos.flatMap((video,index)=>video.assetId===target?[index]:[]);if(indices.length!==1)throw new ApiError(422,'LONGFORM_AUDIO_PAIR_MISSING',indices.length?'配对的参考视频重复出现，请保留一份后重新配对。':'配对的参考视频已断开，请重新连接或将音频改为独立参考。');
   if(paired.has(indices[0]))throw new ApiError(422,'LONGFORM_AUDIO_PAIR_DUPLICATE','同一参考视频只能配对一份音轨，请调整音频用途。');paired.add(indices[0]);return{assetId:ref.assetId,kind:'AUDIO',role:'VIDEO_AUDIO',videoIndex:indices[0]};
  });
 }
}

export function createLongformPanel(options:{doc:Document;api:any;canvasId:string;nodeId:string;sessionScope?:string;current:()=>boolean;references:()=>LongformReference[];referenceName?:(reference:LongformReference,index:number)=>string|undefined;beforeMutation?:()=>Promise<void>;notice?:(text:string)=>void}){
 const {doc}=options;let journal:Storage|undefined;try{journal=doc.defaultView?.sessionStorage;}catch{}
 const client=new LongformClient(options.api,options.current,journal,'studio-longform-pending:'+options.sessionScope+':'+options.canvasId+':'+options.nodeId);
 const mode=createH3LongformMode(doc,options.canvasId,options.nodeId);
 const box=doc.createElement('details');box.className='studio-h3-longform nodrag nopan nowheel';box.dataset.studioH3Longform='';
 const summary=doc.createElement('summary');summary.textContent='H3 分段长片';const content=doc.createElement('div');content.className='studio-longform-content';box.append(summary,content);
 let disposed=false,loading=false,pending=false,dirty=false,editSerial=0,lastReferenceSignature:string|undefined,cap:LongformCapabilities|undefined,project:LongformProject|undefined,recoveringProjectId:string|undefined,error='',message='',timer:ReturnType<typeof setTimeout>|undefined,editTimer:ReturnType<typeof setTimeout>|undefined,automaticSave:Promise<void>|undefined;
 let draft:LongformDraft={title:'H3 分段长片',commonPrompt:'',settings:{},segments:[{id:randomUuid(),prompt:'',duration:10}],references:[]};
 const openSegments=new Set<string>(),urls=new Set<string>(),rawSettings=new Map<string,string>(),invalidSettings=new Set<string>(),retryCurrent=new Set<string>(),audioRoles=new LongformAudioRoles();
 const currentReferences=()=>audioRoles.apply(options.references());
 const node=<K extends keyof HTMLElementTagNameMap>(tag:K,text?:string,className?:string)=>{const x=doc.createElement(tag);if(text!==undefined)x.textContent=text;if(className)x.className=className;return x;};
 const alive=()=>!disposed&&options.current();
 const updateMode=()=>mode.set(alive()&&(cap?.available===true&&box.open||longformBusy(project)));
 const stop=(e:Event)=>{if(!(e instanceof KeyboardEvent)||e.key!=='Escape')e.stopPropagation();};for(const name of ['pointerdown','mousedown','click','keydown','keyup','wheel'])box.addEventListener(name,stop);
 const button=(text:string,action:()=>void,disabled=false,primary=false)=>{const x=node('button',text,primary?'studio-longform-button is-primary':'studio-longform-button');x.type='button';x.disabled=disabled;x.addEventListener('click',()=>{try{action();}catch(e){error=humanError(e);render();}});return x;};
 const setDirty=()=>{dirty=true;editSerial++;message='有修改待保存';const status=content.querySelector('[data-longform-save]');if(status)status.textContent=message;clearTimeout(editTimer);editTimer=setTimeout(()=>void autoSave(),800);};
 const label=(text:string,input:HTMLElement)=>{const x=node('label',undefined,'studio-longform-field');x.append(node('span',text),input);return x;};
 const input=(value:any,key:string,onChange:(value:any)=>void,config:{type?:string;min?:number;max?:number;step?:number;disabled?:boolean;placeholder?:string}={})=>{
  const x=node('input');x.type=config.type??'text';x.value=value===undefined?'':String(value);x.dataset.longformField=key;if(config.min!==undefined)x.min=String(config.min);if(config.max!==undefined)x.max=String(config.max);if(config.step!==undefined)x.step=String(config.step);x.disabled=!!config.disabled;x.placeholder=config.placeholder??'';x.addEventListener('input',()=>{onChange(x.type==='number'?x.value===''?undefined:Number(x.value):x.value);setDirty();});return x;
 };
 const textarea=(value:string,key:string,onChange:(value:string)=>void)=>{const x=node('textarea');x.value=value;x.rows=3;x.dataset.longformField=key;x.addEventListener('input',()=>{onChange(x.value);setDirty();});return x;};
 const schedule=()=>{clearTimeout(timer);if(alive()&&(recoveringProjectId||longformBusy(project)))timer=setTimeout(()=>void reload(false),2500);};
 const accept=(next:LongformProject,resetDraft=true)=>{if(!next||typeof next.id!=='string')throw new Error('服务器返回的长片状态无效，请刷新。');if(!Array.isArray(next.segments)||!Array.isArray(next.jobs)){recoveringProjectId=next.id;message='正在确认长片创建结果';return;}recoveringProjectId=undefined;project=next;if(resetDraft){audioRoles.restore(next.references??[]);draft=longformDraft(next,options.references());dirty=false;}error='';updateMode();};
 async function initialize(){
  if(loading||cap||!alive())return;loading=true;render();
  try{cap=await client.capabilities();if(!alive())return;if(cap.available===false){error=cap.reason??'H3 分段长片暂不可用，请联系管理员。';return;}
   const found=await client.find(options.canvasId,options.nodeId);if(!alive())return;if(found[0])accept(found[0]);else{
    const properties=cap.settingsSchema?.properties??{},settings={...cap.defaults};for(const [key,schema]of Object.entries(properties))if(settings[key]===undefined&&schema.default!==undefined)settings[key]=structuredClone(schema.default);
    draft.settings=settings;draft.references=options.references();draft.segments[0].duration=Number(settings.duration??settings.durationSeconds??10);
   }
  }catch(e){error=humanError(e);}finally{loading=false;if(alive()){render();updateMode();schedule();}}
 }
 async function reload(explicit=true){
  if(!alive()||loading||pending)return;loading=true;if(explicit)render();
  try{if(project||recoveringProjectId){const next=await client.get(project?.id??recoveringProjectId!);if(alive())accept(next,!dirty);}else{const found=await client.find(options.canvasId,options.nodeId);if(alive()&&found[0])accept(found[0],!dirty);}
   if(explicit)message=client.hasPending()?'已读取最新状态；请重试上次操作以确认提交结果':dirty?'已刷新任务，当前编辑仍待保存':'已读取最新任务状态';
  }catch(e){if(alive())error=humanError(e);}finally{loading=false;if(alive()){render();schedule();}}
 }
 async function save(){
  if(!cap)return;if(invalidSettings.size)throw new Error('高级设置中有格式无效的 JSON，请修正后保存。');draft.references=currentReferences();const reason=validateLongformDraft(draft,cap);if(reason)throw new Error(reason);
  if(project&&longformBusy(project))throw new Error('任务正在运行，待本段完成并停止后再修改。');
  await options.beforeMutation?.();if(!alive())return;
  const serial=editSerial,submitted=structuredClone(draft),known=new Set(project?.segments.map(s=>s.id)??[]),additions=project?submitted.segments.filter(s=>!s.id||!known.has(s.id)):[];
  const patch=additions.length?{...submitted,segments:submitted.segments.filter(s=>s.id&&known.has(s.id))}:submitted;
  const next=project?await client.action(project,'updateDraft',{patch}):await client.create(options.canvasId,options.nodeId,submitted);if(alive()){accept(next,serial===editSerial&&!additions.length);if(additions.length&&serial===editSerial){dirty=false;message='已有设置已保存；新增段准备好后点击续拍';}else message=dirty?'新修改待保存':'已保存';}
 }
 async function autoSave(){
  if(!alive()||!dirty||pending||!cap||longformBusy(project)||invalidSettings.size||validateLongformDraft(draft,cap))return;
  pending=true;const status=content.querySelector('[data-longform-save]');if(status)status.textContent='正在保存…';let succeeded=false;const operation=save();automaticSave=operation;
  try{await operation;succeeded=true;if(alive()){const status=content.querySelector('[data-longform-save]');if(status)status.textContent=message;}}catch(e){if(alive()){error=humanError(e);render();}}finally{pending=false;if(automaticSave===operation)automaticSave=undefined;if(alive()&&dirty&&succeeded)editTimer=setTimeout(()=>void autoSave(),1000);}
 }
 async function perform(type:LongformAction|'save'|'retryPending',fields:Record<string,any>={}){
  if(automaticSave)try{await automaticSave;}catch{/* Reuse the original pending request below; never submit a new key. */}
  if(pending||!alive())return;clearTimeout(editTimer);pending=true;error='';render();
  try{if(type==='retryPending'){accept(await client.retryPending());message='已确认上次操作';}
   else if(type==='save')await save();
   else{const inputChanged=project&&JSON.stringify(project.references??[])!==JSON.stringify(currentReferences());if(!project||dirty||inputChanged&&!['adoptCandidate','composeSelected','stopAfterSegment'].includes(type))await save();if(!project||!alive())return;await options.beforeMutation?.();if(!alive())return;accept(await client.action(project,type,fields));message=type==='stopAfterSegment'?'将在当前段完成后停止':type==='composeSelected'?'已提交合片任务':'操作已提交';}
  }catch(e){if(alive()){error=humanError(e);options.notice?.(error);}}finally{pending=false;if(alive()){render();schedule();}}
 }
 async function showArtifact(artifactId:string,host:HTMLElement,download=false){
  if(!project||!alive())return;const action=host.querySelector('button');if(action)action.disabled=true;
  try{const blob=await client.artifact(project.id,artifactId);if(!alive())return;const url=URL.createObjectURL(blob);urls.add(url);
   if(download){const link=node('a');link.href=url;link.download=`${project.title}-${artifactId}.mp4`;link.click();setTimeout(()=>{URL.revokeObjectURL(url);urls.delete(url);},60000);}
   else{const video=node('video');video.controls=true;video.playsInline=true;video.preload='metadata';video.src=url;host.querySelector('video')?.remove();host.append(video);}
  }catch(e){error=humanError(e);render();}finally{if(action)action.disabled=false;}
 }
 function settingsFields(keys:string[],host:HTMLElement,schemas=cap?.settingsSchema?.properties??{},values=draft.settings,prefix=''){
  const locked=!!project?.segments.some(segment=>segment.candidates.some(candidate=>candidate.status==='SUCCEEDED'));
  for(const key of keys){if(['width','height','previewFrames'].includes(key)||schemas[key].readOnly)continue;const schema=schemas[key],title=fieldNames[key]??schema.title??key,value=values[key],path=prefix+key,types=Array.isArray(schema.type)?schema.type:[schema.type],disabled=pending||longformBusy(project)||locked&&spatialFields.has(key);let control:HTMLElement;
   if(Array.isArray(schema.enum)){const select=node('select');select.dataset.longformField='setting-'+path;select.disabled=disabled;for(const choice of schema.enum){const option=node('option',String(choice));option.value=JSON.stringify(choice);option.selected=JSON.stringify(choice)===JSON.stringify(value);select.append(option);}select.addEventListener('change',()=>{values[key]=JSON.parse(select.value);setDirty();});control=select;}
   else if(schema.type==='boolean'){const check=input('',path,()=>{}, {type:'checkbox',disabled});check.checked=value===true;check.addEventListener('change',()=>{values[key]=check.checked;setDirty();});control=check;}
   else if(schema.type==='object'&&schema.properties){const nested=node('details',undefined,'studio-longform-nested');nested.append(node('summary',title));const grid=node('div',undefined,'studio-longform-grid');if(!values[key]||typeof values[key]!=='object')values[key]={};settingsFields(Object.keys(schema.properties),grid,schema.properties,values[key],path+'.');nested.append(grid);host.append(nested);continue;}
   else if(key==='loras'&&schema.items?.properties){const group=node('div',undefined,'studio-longform-loras'),rows=Array.isArray(value)?value:[];for(const [i,item]of rows.entries()){const row=node('div',undefined,'studio-longform-grid');settingsFields(['name','strength'],row,schema.items.properties,item,path+'.'+i+'.');row.append(button('移除 LoRA',()=>{rows.splice(i,1);setDirty();render();},disabled));group.append(row);}group.append(button('添加 LoRA',()=>{const first=schema.items.properties.name.enum?.[0];if(first){values[key]=[...rows,{name:first,strength:1}];setDirty();render();}},disabled||rows.length>=(schema.maxItems??8)));control=group;}
   else if(types.includes('array')||types.includes('object')){const edit=textarea(rawSettings.get(path)??(value===undefined?'':JSON.stringify(value,null,2)),'setting-'+path,text=>{rawSettings.set(path,text);try{values[key]=text?JSON.parse(text):null;invalidSettings.delete(path);edit.setCustomValidity('');}catch{invalidSettings.add(path);edit.setCustomValidity('请输入有效的 JSON。');}});edit.disabled=disabled;control=edit;}
   else control=input(value,'setting-'+path,next=>values[key]=next,{type:['number','integer'].includes(schema.type)?'number':'text',min:schema.minimum,max:schema.maximum,step:schema.type==='integer'?1:schema.multipleOf??'any' as any,disabled});
   const field=label(title,control),help=longformSettingHelp(key,schema.description);if(help)field.append(node('small',help));host.append(field);
  }
 }
 function render(){
  const focused=doc.activeElement as HTMLInputElement|HTMLTextAreaElement|null,focusKey=box.contains(focused)?focused?.dataset.longformField:undefined,selection=focusKey&&typeof focused?.selectionStart==='number'?[focused.selectionStart,focused.selectionEnd]:undefined;
  const advancedOpen=content.querySelector<HTMLDetailsElement>('.studio-longform-advanced')?.open??false;
  content.replaceChildren();const busy=longformBusy(project),blocked=pending||busy;
  if(loading&&!cap){content.append(node('p','正在读取长片能力与已有任务…','studio-longform-muted'));return;}
  if(!cap||cap.available===false){content.append(node('p',error||'展开后读取可用设置。','studio-longform-muted'));if(error)content.append(button('重新读取',()=>{cap=undefined;void initialize();}));return;}
  if(recoveringProjectId){const recovery=node('p','正在确认已有长片的创建结果，请勿重复创建。','studio-longform-muted');recovery.setAttribute('role','status');content.append(recovery);if(error)content.append(node('p',error,'studio-longform-error'));content.append(button('刷新检查结果',()=>void reload(true),loading));if(client.hasPending())content.append(button('重试上次操作',()=>void perform('retryPending'),pending));return;}
  const status=node('p',message||'分段生成，可逐段回看并重新选择结果。','studio-longform-muted');status.dataset.longformSave='';status.setAttribute('role','status');status.setAttribute('aria-live','polite');content.append(status);
  if(error||client.hasPending()){const alert=node('div',undefined,'studio-longform-error');alert.setAttribute('role','alert');alert.append(node('p',error||'上次操作的提交结果尚待确认，请重试相同操作以继续。'));if(client.hasPending())alert.append(button('重试上次操作',()=>void perform('retryPending')),button('刷新检查结果',()=>void reload(true)));else alert.append(button('刷新',()=>void reload(true)));content.append(alert);}
  const basics=node('div',undefined,'studio-longform-grid');const title=input(draft.title,'title',value=>draft.title=value,{disabled:blocked});basics.append(label('长片名称',title));settingsFields(Object.keys(cap.settingsSchema?.properties??{}).filter(key=>primaryFields.has(key)),basics);content.append(basics);
  const selected=project?.segments.flatMap(s=>s.candidates.filter(c=>c.id===s.selectedCandidateId))??[],size=selected.find(c=>c.width&&c.height),width=size?.width??project?.settings.width,height=size?.height??project?.settings.height,dimensionLocked=!!project?.segments.some(segment=>segment.candidates.some(candidate=>candidate.status==='SUCCEEDED'));
  const resolutions=node('div',undefined,'studio-longform-actions');for(const preset of longformResolutionPresets(draft.settings,cap)){const action=button(`${preset.resolution}p${preset.approximate?' 近似':''} · ${preset.width} × ${preset.height}`,()=>{draft.settings.megapixels=preset.megapixels;delete draft.settings.width;delete draft.settings.height;setDirty();render();},blocked||dimensionLocked);action.dataset.longformResolution=String(preset.resolution);action.title=`按当前比例计算 ${preset.megapixels} MP；原生 ${cap.limits?.dimensionMultiple??32} 像素网格，实际 ${preset.width} × ${preset.height}。`;resolutions.append(action);}if(resolutions.childElementCount){content.append(resolutions,node('p','预设按当前比例换算原生像素规模；720p、1080p等可能对齐到邻近的32倍数，实际像素以保存结果为准。','studio-longform-muted'));}
  content.append(node('p',`${draft.segments.length} 段 · 计划 ${Number(longformDuration(draft).toFixed(2))} 秒${width&&height?` · ${dirty?'上次保存':'实际'} ${width} × ${height}`:' · 保存后显示实际像素'}${selected.length?' · 同链尺寸已锁定':''}`,'studio-longform-output'));
  const common=textarea(draft.commonPrompt,'commonPrompt',value=>draft.commonPrompt=value);common.disabled=blocked;content.append(label('全片共用描述',common));
  let refs:LongformReference[]=[];try{refs=options.references();}catch(e){content.append(node('p',humanError(e),'studio-longform-error'));}
  const referenceSection=node('section',undefined,'studio-longform-references');referenceSection.setAttribute('aria-label','当前参考素材与音频用途');referenceSection.append(node('p','当前参考素材','studio-longform-reference-title'));
  if(!refs.length)referenceSection.append(node('p','需要参考时，先把图片、视频或音频节点连到本视频卡；素材顺序沿用当前排列。也可使用纯文字描述。','studio-longform-muted'));
  else{
   const list=node('ol',undefined,'studio-longform-reference-list'),videos=refs.filter(ref=>ref.kind==='VIDEO'),kindCounts={IMAGE:0,VIDEO:0,AUDIO:0};
   for(const [index,ref]of refs.entries()){
    const item=node('li'),kind=ref.kind==='IMAGE'?'图片':ref.kind==='VIDEO'?'视频':'音频',ordinal=++kindCounts[ref.kind],name=options.referenceName?.(ref,index)??`${kind} ${ordinal}`;
    item.append(node('p',`${index+1}. ${name} · ${kind} ${ordinal}`));
    if(ref.kind==='AUDIO'){
     const select=node('select');select.dataset.longformField='audio-role-'+ref.assetId;select.setAttribute('aria-label',`${name}的用途`);select.disabled=blocked;
     const independent=node('option','独立参考音频');independent.value='';select.append(independent);
     for(const [videoIndex,video]of videos.entries()){const videoName=options.referenceName?.(video,refs.indexOf(video)),option=node('option',`参考视频 ${videoIndex+1} 的音轨${videoName?' · '+videoName:''}`);option.value=video.assetId;option.disabled=videos.filter(v=>v.assetId===video.assetId).length>1;select.append(option);}
     const paired=audioRoles.target(ref.assetId);if(paired&&!videos.some(video=>video.assetId===paired)){const missing=node('option','原配对视频已断开，请重新选择');missing.value=paired;missing.disabled=true;select.append(missing);}select.value=paired??'';
     select.addEventListener('change',()=>{audioRoles.set(ref.assetId,select.value||null);setDirty();render();});item.append(label('音频用途',select));
    }
    list.append(item);
   }
   referenceSection.append(list);try{currentReferences();}catch(e){referenceSection.append(node('p',humanError(e),'studio-longform-error'));}
  }
  referenceSection.append(node('p',`支持最多 ${cap.limits?.maxImages??9} 张图片、${cap.limits?.maxVideos??3} 段视频、${cap.limits?.maxAudios??3} 份独立音频和 ${cap.limits?.maxVideoAudioTracks??3} 份配对音轨；每段视频最多配一份音轨。`,'studio-longform-muted'));content.append(referenceSection);
  const advanced=node('details',undefined,'studio-longform-advanced');advanced.open=advancedOpen;advanced.append(node('summary','高级采样与续接设置'));const fields=node('div',undefined,'studio-longform-grid');settingsFields(Object.keys(cap.settingsSchema?.properties??{}).filter(key=>!primaryFields.has(key)),fields);advanced.append(fields);content.append(advanced);
  if(project){const active=project.jobs.find(job=>job.id===project?.activeJobId)??project.jobs.at(-1);if(active){const segment=project.segments.findIndex(s=>s.id===active.currentSegmentId),line=node('div',undefined,'studio-longform-progress'),progress=active.progress&&typeof active.progress==='object'?active.progress:undefined;line.setAttribute('role','status');line.append(node('p',`任务：${stateNames[active.status]??active.status}`));if(segment>=0)line.append(node('p',`分段：第 ${segment+1} / ${project.segments.length} 段`));if(progress?.phase)line.append(node('p',`当前阶段：${phaseNames[progress.phase]??'处理中'}`));if(progress?.scope==='SEGMENT'&&Number.isSafeInteger(progress.currentStep)&&Number.isSafeInteger(progress.totalSteps)&&progress.totalSteps!>0&&progress.currentStep!>=0&&progress.currentStep!<=progress.totalSteps!)line.append(node('p',`本段采样：${progress.currentStep} / ${progress.totalSteps} 步`));content.append(line);if(active.error)content.append(node('p',longformFailureMessage(active.error),'studio-longform-error'));}}
  const list=node('ol',undefined,'studio-longform-segments');draft.segments.forEach((segment,index)=>{
   const saved=project?.segments.find(s=>s.id===segment.id)??project?.segments[index],item=node('li'),details=node('details',undefined,'studio-longform-segment');details.open=openSegments.has(segment.id??String(index))||index===0&&!project;details.addEventListener('toggle',()=>{const key=segment.id??String(index);if(details.open)openSegments.add(key);else openSegments.delete(key);});
   const picked=saved?.candidates.find(candidate=>candidate.id===saved.selectedCandidateId),head=node('summary',`第 ${index+1} 段 · ${segment.duration} 秒 · ${saved?.stale?'前段已改变，需重做':picked?'已采用':saved?.candidates.length?'待选择结果':'待生成'}`);details.append(head);
   if(saved?.stale)details.append(node('p','前段或输入已修改，此段结果与当前链不再一致。请从受影响段重做后续，再合片。','studio-longform-warning'));
   const prompt=textarea(segment.prompt,'prompt-'+index,value=>segment.prompt=value);prompt.disabled=blocked;details.append(label('本段描述',prompt));
   const row=node('div',undefined,'studio-longform-grid');row.append(label('时长（秒）',input(segment.duration,'duration-'+index,value=>segment.duration=value,{type:'number',min:cap?.limits?.durationMin??cap?.limits?.minDuration??0.01,max:cap?.limits?.durationMax??cap?.limits?.maxDuration??150,step:.01,disabled:blocked})),label('本段种子',input(segment.seed,'seed-'+index,value=>segment.seed=value===''?undefined:String(value),{disabled:blocked,placeholder:'自动'})));details.append(row);
   const durations=node('div',undefined,'studio-longform-actions');for(const seconds of [5,8,10,15].filter(seconds=>seconds>=(cap?.limits?.durationMin??cap?.limits?.minDuration??0.01)&&seconds<=(cap?.limits?.durationMax??cap?.limits?.maxDuration??150)))durations.append(button(`${seconds} 秒`,()=>{segment.duration=seconds;setDirty();render();},blocked));details.append(durations);
   if(saved){const useCurrent=node('input');useCurrent.type='checkbox';useCurrent.checked=retryCurrent.has(saved.id);useCurrent.disabled=blocked;useCurrent.addEventListener('change',()=>{if(useCurrent.checked)retryCurrent.add(saved.id);else retryCurrent.delete(saved.id);});details.append(label('重抽使用当前高级设置、参考素材与共用描述',useCurrent));details.append(node('p','本段描述、时长和种子按当前输入。未勾选时，其余高级设置、参考素材与共用描述沿用原结果。','studio-longform-muted'));}
   const actions=node('div',undefined,'studio-longform-actions');if(saved)actions.append(button('重抽本段',()=>void perform('retrySegment',{segmentId:saved.id,prompt:segment.prompt,settings:{...(retryCurrent.has(saved.id)?structuredClone(draft.settings):{}),duration:segment.duration},...(retryCurrent.has(saved.id)?{references:currentReferences(),commonPrompt:draft.commonPrompt}:{}),...(segment.seed===undefined?{}:{seed:segment.seed})}),blocked),button('从本段重做后续',()=>void perform('regenerateFrom',{segmentId:saved.id}),blocked));
   if(saved?.selectedCandidateId&&project!.segments.slice(index+1).some(s=>s.stale)){actions.append(button('保留后续旧片段',()=>void perform('keepFollowing',{segmentId:saved!.id}),blocked));details.append(node('p','保留旧片段可能使人物、道具和接缝不一致；请回看衔接，再决定是否合片。','studio-longform-muted'));}
   if(!saved)actions.append(button('移除本段',()=>{draft.segments.splice(index,1);setDirty();render();},blocked||draft.segments.length===1));details.append(actions);
   for(const [candidateIndex,candidate]of (saved?.candidates??[]).entries()){
    const candidateRow=node('div',undefined,'studio-longform-candidate');const text=`结果 ${candidateIndex+1} · ${stateNames[candidate.status]??candidate.status}${candidate.seed!==undefined?` · 种子 ${candidate.seed}`:''}${candidate.width&&candidate.height?` · ${candidate.width} × ${candidate.height}`:''}${candidate.frames?` · ${candidate.frames} 帧`:''}${candidate.duration?` · 实际 ${Number(candidate.duration.toFixed(3))} 秒`:''}`;candidateRow.append(node('p',text));
    if(candidate.artifactId&&candidate.status==='SUCCEEDED'){const media=node('div',undefined,'studio-longform-media');media.append(button('预览',()=>void showArtifact(candidate.artifactId!,media)),button('原规格导出',()=>void showArtifact(candidate.artifactId!,media,true)));candidateRow.append(media);candidateRow.append(button(candidate.id===saved?.selectedCandidateId?'撤回采用':'采用此结果',()=>void perform('adoptCandidate',{segmentId:saved!.id,candidateId:candidate.id===saved?.selectedCandidateId?null:candidate.id}),blocked||!!saved?.stale&&candidate.id!==saved.selectedCandidateId));}
    if(candidate.error)candidateRow.append(node('p',longformFailureMessage(candidate.error),'studio-longform-error'));details.append(candidateRow);
   }
   item.append(details);list.append(item);
  });content.append(list);
  const add=()=>{draft.segments.push({id:randomUuid(),prompt:'',duration:Number(draft.settings.duration??draft.settings.durationSeconds??10)});setDirty();render();};
  const additions=project?draft.segments.filter(segment=>!project!.segments.some(s=>s.id===segment.id)):[],last=project?.segments.at(-1),canAppend=!!last&&!last.stale&&last.candidates.some(c=>c.id===last.selectedCandidateId&&c.status==='SUCCEEDED');
  const footer=node('div',undefined,'studio-longform-actions');footer.append(button(project?'添加续拍段':'添加分段',add,blocked||draft.segments.length>=(cap.limits?.maxSegments??10000)),button(pending?'正在提交…':'保存设置',()=>void perform('save'),blocked),button('生成全部分段',()=>void perform('generateAll'),blocked||additions.length>0,true));
  if(additions.length){footer.append(button('续拍新增分段',()=>void perform('append',{segments:structuredClone(additions)}),blocked||!canAppend,true));content.append(node('p',canAppend?'新增分段仅在点击续拍后提交生成。':'续拍前请先为当前末段采用一个有效结果。','studio-longform-muted'));}
  if(project){const stop=button('本段完成后停止',()=>void perform('stopAfterSegment'),pending||!busy);stop.title='只停止本长片在当前段之后的生成，不中断正在生成的段或其他任务。';footer.append(button('刷新状态',()=>void reload(true),pending),stop);}content.append(footer);
  const canCompose=!!project&&project.segments.length>0&&project.segments.every(s=>!s.stale&&s.selectedCandidateId&&s.candidates.some(c=>c.id===s.selectedCandidateId&&c.status==='SUCCEEDED'));
  if(project){const compose=node('div',undefined,'studio-longform-compositions');compose.append(button('合并已采用分段',()=>void perform('composeSelected'),blocked||!canCompose));if(!canCompose)compose.append(node('p','每段采用一个有效结果后，即可按顺序合片。','studio-longform-muted'));compose.append(node('p',longformOutputLimitText(cap),'studio-longform-muted'));for(const [i,result]of project.compositions.entries())if(result.artifactId){const media=node('div',undefined,'studio-longform-media');media.append(node('p',`合片 ${i+1}`),button('预览合片',()=>void showArtifact(result.artifactId!,media)),button('导出合片原规格',()=>void showArtifact(result.artifactId!,media,true)));compose.append(media);}content.append(compose);}
  if(focusKey){const next=[...content.querySelectorAll<HTMLInputElement|HTMLTextAreaElement>('[data-longform-field]')].find(x=>x.dataset.longformField===focusKey);next?.focus({preventScroll:true});if(next&&selection&&typeof next.setSelectionRange==='function'&&next.type!=='number')try{next.setSelectionRange(selection[0],selection[1]);}catch{}}
 }
 box.addEventListener('toggle',()=>{updateMode();if(box.open)void initialize();schedule();});render();
 return{element:box,open:()=>{box.open=true;void initialize();},syncReferences:()=>{let signature:string;try{const refs=options.references();signature=JSON.stringify(refs.map((ref,index)=>[ref,options.referenceName?.(ref,index)]));}catch(e){signature='error:'+humanError(e);}if(signature===lastReferenceSignature)return;const prior=lastReferenceSignature;lastReferenceSignature=signature;if(cap&&prior!==undefined)setDirty();if(cap)render();},dispose:()=>{if(dirty&&alive()&&!pending&&cap&&!invalidSettings.size&&!validateLongformDraft(draft,cap)){let submitted:LongformDraft|undefined;try{submitted={...structuredClone(draft),references:currentReferences()};}catch(e){options.notice?.(humanError(e));}const saved=project;if(submitted)void options.beforeMutation?.().then(()=>{if(!options.current())return;return saved?client.action(saved,'updateDraft',{patch:submitted}):client.create(options.canvasId,options.nodeId,submitted!);}).catch(e=>options.notice?.(humanError(e)));}disposed=true;mode.dispose();clearTimeout(timer);clearTimeout(editTimer);for(const url of urls)URL.revokeObjectURL(url);box.remove();},refresh:()=>void reload(true),getProject:()=>project};
}

function longformFailureMessage(error:unknown){const detail=error&&typeof error==='object'?error as Record<string,unknown>:undefined;for(const value of [typeof error==='string'?error:detail?.message,detail?.code])if(typeof value==='string'&&value.trim())return value.trim();return '生成失败，请重试。';}
function humanError(error:unknown){return error instanceof Error?error.message:'操作未完成，请刷新任务状态后重试。';}

export function installH3LongformControls(runtime:any,native:any,doc:Document=document){
 type Panel=ReturnType<typeof createLongformPanel>;
 const rows=new Map<HTMLElement,{nodeId:string;host:HTMLElement;row:Panel;release:()=>void}>(),nodes=new Map<string,Panel>();let disposed=false,queued=false,identity='';const style=doc.createElement('style');style.id='studio-h3-longform-controls';style.textContent=h3LongformStyles;doc.head.append(style);
 const detach=(panel:HTMLElement)=>{const binding=rows.get(panel);if(!binding)return;binding.release();if(binding.row.element.parentElement===binding.host)binding.row.element.remove();rows.delete(panel);};
 const clear=()=>{for(const panel of rows.keys())detach(panel);for(const row of nodes.values())row.dispose();nodes.clear();};
 const refresh=()=>{if(queued||disposed)return;queued=true;queueMicrotask(()=>{queued=false;if(disposed)return;const canvasId=runtime.inspect?.().id,key=runtime.auth?.user&&canvasId?runtime.auth.user.id+':'+canvasId:'';if(key!==identity){identity=key;clear();}if(!key)return;
  const graph=native.bt?.()?.getRemoteData?.();if(!Array.isArray(graph?.nodes)||!Array.isArray(graph.edges))return;const live=new Set<HTMLElement>();
  for(const panel of doc.querySelectorAll<HTMLElement>(panelSelector)){const nodeId=panel.dataset.targetNodeId,target=graph.nodes.find((node:any)=>node.id===nodeId);if(target?.type!=='rh-video'||target.data?.isUpload||target.data?.isStoryboard||target.data?.localVideoEdit)continue;live.add(panel);const host=panel.querySelector<HTMLElement>('.config-panel-wrap__basic')??panel,binding=rows.get(panel);if(binding&&binding.nodeId===nodeId&&binding.host===host&&binding.row.element.parentElement===host){binding.row.syncReferences();continue;}detach(panel);
   const scope=key,row=nodes.get(nodeId!)??createLongformPanel({doc,api:runtime.api,canvasId,nodeId:nodeId!,sessionScope:String(runtime.auth.user.id),current:()=>!disposed&&identity===scope&&runtime.auth?.user&&runtime.inspect?.().id===canvasId,references:()=>{const actual=native.bt?.()?.getRemoteData?.(),node=actual?.nodes.find((n:any)=>n.id===nodeId);if(!node)throw new Error('视频节点已移除，请重新打开。');return longformReferences(node,actual,(value:string)=>runtime.storage?.encodeAsset?.(value)??value);},referenceName:(ref:LongformReference)=>{const asset=runtime.storage?.assets?.get?.(ref.assetId);if(typeof asset?.fileName==='string'&&asset.fileName.trim())return asset.fileName;const actual=native.bt?.()?.getRemoteData?.(),sources=actual?.nodes.filter((node:any)=>actual.edges.some((edge:any)=>edge.source===node.id&&edge.target===nodeId));for(const source of sources??[]){const data=source.data??{};if(JSON.stringify(data).includes(ref.assetId)){const title=data.fileName??data.name??data.title??data.label;if(typeof title==='string'&&title.trim())return title;}}return undefined;},beforeMutation:async()=>{runtime.storage.requirePermission(canvasId,'canRun');await runtime.flushCanvasMutations?.(canvasId);await runtime.waitForSave?.();if(runtime.inspect?.().id!==canvasId)throw new Error('画布已切换。');},notice:(text:string)=>runtime.notice?.(text)});
   nodes.set(nodeId!,row);host.append(row.element);host.dataset.studioLongformHost='';const layout=()=>{panel.classList.toggle('studio-longform-open',row.element.open);host.classList.toggle('studio-longform-host-open',row.element.open);};row.element.addEventListener('toggle',layout);layout();rows.set(panel,{nodeId:nodeId!,host,row,release:()=>{row.element.removeEventListener('toggle',layout);panel.classList.remove('studio-longform-open');host.classList.remove('studio-longform-host-open');host.removeAttribute('data-studio-longform-host');}});row.syncReferences();
  }
  for(const panel of rows.keys())if(!live.has(panel)||!panel.isConnected)detach(panel);
  for(const [id,row]of nodes)if(!graph.nodes.some((node:any)=>node.id===id&&node.type==='rh-video')){row.dispose();nodes.delete(id);}
 });};
 const observer=new MutationObserver(records=>{if(records.every(r=>r.target instanceof Element&&r.target.closest('[data-studio-h3-longform]')))return;refresh();});observer.observe(doc.body,{subtree:true,childList:true,attributes:true,attributeFilter:['data-target-node-id','class']});const release=runtime.auth?.onClear?.(()=>{identity='';clear();});refresh();return()=>{disposed=true;observer.disconnect();release?.();clear();style.remove();};
}

export const h3LongformStyles=`
 .studio-h3-longform{box-sizing:border-box;width:100%;min-width:0;flex:0 0 auto;padding:8px 20px 12px;border-top:1px solid var(--canvas-border-default,#3a3a3a);color:var(--canvas-text-primary,#e5e5e5);font:inherit;font-size:12px;line-height:1.5;text-align:left}
 .studio-h3-longform summary{min-height:34px;display:flex;align-items:center;gap:8px;cursor:pointer;font-weight:500;list-style:none}.studio-h3-longform summary::-webkit-details-marker{display:none}.studio-h3-longform summary:before{content:'';width:6px;height:6px;border:solid currentColor;border-width:0 1px 1px 0;transform:rotate(-45deg);transition:transform .15s ease;flex:0 0 auto}.studio-h3-longform details[open]>summary:before,.studio-h3-longform[open]>summary:before{transform:rotate(45deg)}
 .studio-longform-content{min-width:0;max-height:min(66vh,max(0px,calc(var(--studio-video-composer-max-height,100vh) - 60px)));overflow:auto;overscroll-behavior:contain;padding:0 3px 4px 0;scrollbar-color:#68686e #27272a;scrollbar-width:thin}.studio-longform-content::selection{background:#6078a8;color:#fff}
 .studio-h3-longform p{margin:6px 0;font-size:11px;line-height:1.55;overflow-wrap:anywhere}.studio-longform-muted,.studio-longform-field small{color:var(--canvas-text-secondary,#b8b8bd)}.studio-longform-output{color:var(--canvas-text-primary,#e5e5e5);font-variant-numeric:tabular-nums}.studio-longform-error{color:#ffb0a9}.studio-longform-warning{color:#f0d092}.studio-longform-progress{color:#c3d1ff}
 .studio-longform-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px 12px;margin:12px 0}.studio-longform-field{display:flex;min-width:0;flex-direction:column;gap:5px;margin:10px 0}.studio-longform-grid>.studio-longform-field{margin:0}.studio-longform-field>span{font-size:11px;color:var(--canvas-text-secondary,#b8b8bd)}.studio-longform-field small{font-size:10px;line-height:1.5}
 .studio-longform-field input,.studio-longform-field select,.studio-longform-field textarea{box-sizing:border-box;width:100%;min-width:0;min-height:32px;padding:6px 8px;background:var(--canvas-bg-tertiary,#29292c);color:var(--canvas-text-primary,#e5e5e5);border:1px solid #ffffff26;border-radius:6px;font:inherit;caret-color:#c3d1ff;color-scheme:dark}.studio-longform-field textarea{resize:vertical;min-height:80px;line-height:1.55}.studio-longform-field input[type=checkbox]{width:18px;min-height:18px;accent-color:#9bb5ec}.studio-h3-longform :disabled{opacity:.48;cursor:default}.studio-h3-longform :is(input,select,textarea,button,summary):focus-visible{outline:2px solid #b7c8ff;outline-offset:2px}
 .studio-longform-button{min-height:32px;padding:5px 9px;border:1px solid #ffffff26;border-radius:6px;background:transparent;color:inherit;font:inherit;font-size:11px;cursor:pointer}.studio-longform-button:hover:not(:disabled){background:#ffffff15}.studio-longform-button.is-primary{background:#d8e2ff;color:#1d263d;border-color:transparent}.studio-longform-button.is-primary:hover:not(:disabled){background:#e7edff}.studio-longform-actions{display:flex;gap:7px;flex-wrap:wrap;margin:12px 0}.studio-longform-advanced{margin:14px 0;border-top:1px solid #ffffff17}.studio-longform-segments{padding:0;margin:14px 0;list-style:none}.studio-longform-segment{padding:8px 0;border-top:1px solid #ffffff1f}.studio-longform-segment>summary{font-variant-numeric:tabular-nums;line-height:1.6}.studio-longform-candidate{padding:10px 0;border-top:1px solid #ffffff12}.studio-longform-media{display:flex;gap:7px;flex-wrap:wrap;align-items:center;margin:8px 0}.studio-longform-media video{display:block;flex:0 0 100%;width:100%;max-height:240px;border-radius:8px;background:#161618}.studio-longform-compositions{margin:16px 0 0;padding-top:12px;border-top:1px solid #ffffff26}[data-studio-longform-host].studio-longform-host-open>:not([data-studio-h3-longform]){display:none!important}
 .studio-longform-references{margin:14px 0;padding:10px 0;border-top:1px solid #ffffff17}.studio-longform-reference-title{font-weight:500}.studio-longform-reference-list{list-style:none;margin:8px 0;padding:0}.studio-longform-reference-list>li{padding:6px 0;border-bottom:1px solid #ffffff12}.studio-longform-reference-list>li>p{margin:0}.studio-longform-reference-list .studio-longform-field{margin:6px 0}.studio-longform-reference-list select{font-size:11px}
 @media(max-width:600px){.studio-h3-longform{padding-inline:12px}.studio-longform-grid{grid-template-columns:minmax(0,1fr)}.studio-longform-content{max-height:min(58vh,max(0px,calc(var(--studio-video-composer-max-height,100vh) - 60px)))}}
 @media(prefers-reduced-motion:reduce){.studio-h3-longform summary:before{transition:none}}
`;
