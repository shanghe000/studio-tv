import type {Asset} from '../api/types';
import {selectedCanvasAssets,type SelectedCanvasAssetPort} from './selected-canvas-asset';
import {canvasSourceMediaReferences} from './canvas-media-reference';
import type {Capability} from './model-catalog';
import {nativeNodeToolAction,nodeToolReason} from './node-tool-contract';
import {videoSpeedIssue} from './video-speed-availability';
type PropsOf=(element:Element)=>any[];
const imageInputTools=new Set(['vision','edit','region','panorama','layers','upscale','motion','quality-menu']);
const marker='data-studiotv-unavailable';
const selector='button,[role="menuitem"],[role="option"],[role="tab"]';
const rules:Record<string,Record<string,string>>={
 'rh-image':{
  '编辑元素|Edit elements':'图片分层模型尚未接入，可使用重绘、擦除或抠图。',
  '放大|高清|Upscale|HD':'精确放大/高清模型尚未接入，可使用画质中的增强。',
 },
 'rh-video':{
  '视频重拍|片段重拍|Video Reshoot|Clip Reshoot':'视频重拍流程尚未接通，可使用首帧、首尾帧或全能参考生成。',
  '一键复刻|One-click Replicate':'视频复刻与分镜分析流程尚未接通。',
  '画质|高清|放大|增强|降噪|补帧|Quality|HD|Upscale|Enhance|Denoise|Interpolate':'视频画质处理模型尚未接入。',
  '深度捕捉|Depth Capture':'视频深度提取模型尚未接入。',
  '解析|视频解析|Analyze|Video Analysis':'视频理解能力尚未接入。',
  '人声分离|环境音分离|Vocal Separation|Ambient Separation':'分轨模型尚未接入，可用音频分离提取完整音轨。',
  '视频修复|去水印|去字幕|去模糊|Video Repair|Remove Watermark|Remove Subtitles|Remove Blur':'视频修复模型尚未接入。',
  '视频编辑|视频延长|Video Edit|Video Extend':'视频编辑/延长能力尚未接入。',
  '文生视频|文字生视频|文字生成视频|Text to Video':'当前视频模型需要图片参考，暂不支持纯文字生成视频。',
  '动作模仿|Motion Transfer':'动作迁移模型尚未接入。',
  '5x|10x|5×|10×':'当前倍速处理支持 0.25–4 倍。',
 },
 'rh-text':{'文字转视频|文字生视频|文生视频|文字生成视频|Text to Video':'当前视频模型需要图片参考，暂不支持纯文字生成视频。','视频理解|视频参考|Video Reference':'视频理解能力尚未接入。'},
 'rh-script':{'视频参考分镜|视频参考|Video Ref to Storyboard':'视频理解能力尚未接入。'},
 'rh-audio':{
  '音频提取文案|Audio to Text':'语音识别能力尚未接入。',
  '图片对口型|Lip Sync':'对口型模型尚未接入。',
  '文生音频|音频生音频|文字生成音乐|语音|音乐|声音克隆|Text to Audio|Audio to Audio|Speech|Music|Voice Clone':'音频生成模型尚未接入；已有音频仍可上传、播放和作为视频参考。',
 },
};
const generationGaps:Record<string,string>={
 TEXT_MUSIC:'音乐生成模型尚未接入。',TEXT_SONG:'音乐生成模型尚未接入。',MULTIVIEW_TO_3D:'3D 模型生成能力尚未接入。',
 TEXT_VIDEO:'纯文生视频模型尚未接入，请使用首帧、首尾帧或全能参考。',
 VIDEO_TEXT:'视频理解能力尚未接入。',
 VIDEO_VIDEO:'视频编辑模型尚未接入。',
 VIDEO_EXTEND:'视频延长模型尚未接入。',
 TEXT_AUDIO:'音频生成模型尚未接入。',AUDIO_AUDIO:'音频生成模型尚未接入。',
 TEXT_TO_W3D:'3D 世界生成模型尚未接入。',IMAGE_TO_W3D:'3D 世界生成模型尚未接入。',VIDEO_TO_W3D:'3D 世界生成模型尚未接入。',
 TEXT_TO_3D:'3D 模型生成能力尚未接入。',IMAGE_TO_3D:'3D 模型生成能力尚未接入。',
};
/** Toolbar actions use actual catalog rows; a selected placeholder or a label
 * alone cannot advertise a newly connected generation mode. */
function hasAvailableVideoMode(props:any[],mode:string){
 const rows:any[]=[],seen=new Set<object>();
 const visit=(value:any,depth=0)=>{
  if(!value||typeof value!=='object'||depth>6||seen.has(value))return;seen.add(value);
  if(Array.isArray(value)){for(const row of value)visit(row,depth+1);return;}
  if(value.capabilityRef&&value.modelCode===value.capabilityRef){rows.push(value);return;}
  for(const [key,row]of Object.entries(value))if(!['node','targetNode','nodes','edges'].includes(key))visit(row,depth+1);
 };
 for(const p of props)for(const value of [p.toolbarContext?.models,p.models,p.allModelData,p.videoModelGroups])visit(value);
 return rows.some(row=>row.available===true&&row.testMode===false&&row.model&&row.config?.some((field:any)=>field.paramName==='outputPreset'&&field.studioVideoParameterMetadata?.mode===mode));
}
export function canvasToolUnavailable(element:Element,propsOf:PropsOf,catalog?:readonly Capability[],assetFor?:(reference:string)=>Asset|string|undefined):string|null{
 const props=propsOf(element);
 const speed=videoSpeedIssue(element,props);if(speed)return speed;
 const action=nativeNodeToolAction(element,props);
 if(action){
  const host=element.closest('.react-flow__node');
  const currentToolbar=!element.closest('[hidden],[aria-hidden="true"]')&&(!host||host.classList.contains('selected'));
  const imageNode=assetFor&&currentToolbar&&imageInputTools.has(action)&&props.map(p=>p.targetNode??p.node).find(n=>n?.type==='rh-image');
  const ref=imageNode&&canvasSourceMediaReferences(imageNode,'image')?.[0];
  const unavailable=nodeToolReason(action,catalog);
  if(unavailable)return unavailable;
  const asset=ref&&assetFor?assetFor(ref):undefined;
  if(typeof asset==='string')return asset;
  const reason=asset?nodeToolReason(action,catalog,asset):null;
  if(reason||catalog||!['text-video','motion','layers','upscale'].includes(action))return reason;
 }
 const owner=props.find(p=>p.targetNode?.type?.startsWith('rh-')||p.node?.type?.startsWith('rh-'));
 const node=owner?.targetNode??owner?.node;
 if(!node)return null;
 // Mode tabs are navigation, including the currently unavailable initial text
 // mode. Native per-option input checks and the generation guard still apply.
 if(node.type==='rh-video'&&element.matches('.video-input-mode-btn'))return null;
 if(node.data?.localVideoEdit===true&&(element.matches('.generate-action-button')||/^(?:重试|Retry)$/i.test(element.textContent?.trim()||'')))return nodeToolReason('local-retry');
 if(node.type==='rh-ai'&&element.matches('.run-price-btn,.generate-action-button,.ai-app-params__model-btn'))return 'AI 应用暂未开放。';
 const label=String(props.find(p=>typeof p.label==='string')?.label||element.getAttribute('aria-label')||element.textContent||'').trim();
 // Quality parameter choices can share these labels; only the processing menu is blocked.
 if(node.type==='rh-image'&&/^(放大|高清|Upscale|HD)$/i.test(label)&&!element.closest('.rh-image-toolbar-popup--quality'))return null;
 if(node.type==='rh-image'&&/^(放大|高清|Upscale|HD)$/i.test(label)){
  const models=props.find(p=>p.toolbarContext?.models)?.toolbarContext.models;
  const rows=Object.values(models??{}).flat() as any[];
  if(rows.some(row=>row.available===true&&row.testMode===false&&row.kind==='IMAGE_ENHANCE'))return null;
 }
 if(node.type==='rh-image'&&/^(编辑元素|Edit elements)$/i.test(label)){
  const models=props.find(p=>p.toolbarContext?.models)?.toolbarContext.models;
  const rows=models?.['image-layer-decomposition']??models?.IMAGE_LAYER_DECOMPOSITION;
  if(Array.isArray(rows)&&rows.some(row=>row.available===true&&row.testMode===false))return null;
 }
 if(['rh-text','rh-video'].includes(node.type)&&/^(文字转视频|文字生视频|文生视频|文字生成视频|Text to Video)$/i.test(label)){
  if(catalog)return nodeToolReason('text-video',catalog);
  if(hasAvailableVideoMode(props,'TEXT_TO_VIDEO'))return null;
 }
 if(node.type==='rh-video'&&/^(动作模仿|Motion Transfer)$/i.test(label)&&hasAvailableVideoMode(props,'MOTION_TRANSFER'))return null;
 for(const [labels,reason] of Object.entries(rules[node.type]??{}))
  if(labels.split('|').some(value=>value.toLowerCase()===label.toLowerCase()))return reason;
 if(/^(开始生成|生成|重试|Generate|Retry)$/i.test(label)||element.classList.contains('generate-action-button')){
  const type=String(node.data?.toolsType||node.data?.subType||'').toUpperCase().replaceAll('-','_');
  // Explicit bindings can represent newer connected models. Never override them
  // using a legacy subtype alone; their own availability guard remains in charge.
  if(node.data?.capabilityRef||node.data?.params?.capabilityRef||props.some(p=>p.currentModel?.available===true&&p.currentModel?.testMode===false))return null;
  return generationGaps[type]??null;
 }
 return null;
}

/** aria-disabled keeps the reason focusable; capture guards prevent native
 * commands before they create nodes or submit jobs. Never touch native disabled.
 */
export function installCanvasToolAvailability(notice:(text:string)=>void,propsOf:PropsOf,root:Document=document,source?:{read:()=>readonly Capability[];assetFor?:(reference:string)=>Asset|undefined;selectedAsset?:SelectedCanvasAssetPort;subscribe:(refresh:()=>void)=>()=>void}){
 let catalog=source?.read();
 const style=root.createElement('style');
 style.textContent=`[${marker}]{opacity:.42!important;filter:grayscale(1)!important;cursor:not-allowed!important;box-shadow:none!important}[${marker}] .glass-button__glow{display:none!important}[${marker}]:focus-visible{outline:1px solid #a3a3a3!important;outline-offset:3px}`;
 root.head.append(style);
 const owned=new Map<Element,Map<string,{before:string|null;value:string}>>();
 let disposed=false,queued=false;
 const restore=(element:Element)=>{
  for(const [name,state] of owned.get(element)??[])if(element.getAttribute(name)===state.value){
   if(state.before===null)element.removeAttribute(name);else element.setAttribute(name,state.before);
  }
  owned.delete(element);
 };
 const apply=(element:Element,reason:string|null)=>{
  if(!reason){restore(element);return;}
  let attrs=owned.get(element);if(!attrs){attrs=new Map();owned.set(element,attrs);}
  for(const [name,value] of Object.entries({[marker]:reason,'aria-disabled':'true',title:`暂不可用：${reason}`,'aria-description':`暂不可用：${reason}`})){
   const old=attrs.get(name),current=element.getAttribute(name);
   if(!old||current!==old.value)attrs.set(name,{before:current,value});else old.value=value;
   if(current!==value)element.setAttribute(name,value);
  }
 };
 const schedule=()=>{if(!queued&&!disposed){queued=true;queueMicrotask(refresh);}};
 const media=source?.selectedAsset?selectedCanvasAssets(source.selectedAsset,schedule):undefined;
 const assetFor=media?.read??source?.assetFor;
 const refresh=()=>{
  queued=false;if(disposed)return;
  for(const element of owned.keys())if(!element.isConnected)restore(element);
  media?.begin();
  for(const element of root.querySelectorAll(selector))apply(element,canvasToolUnavailable(element,propsOf,catalog,assetFor));
  media?.end();
 };
 const onInput=(e:Event)=>{if((e.target as Element)?.closest?.('.rh-video-speed-panel')&&!queued){queued=true;queueMicrotask(refresh);}};
 root.addEventListener('input',onInput,true);
 const unsubscribe=source?.subscribe(()=>{catalog=source.read();if(!queued&&!disposed){queued=true;queueMicrotask(refresh);}});
 const observer=new MutationObserver(()=>{if(!queued&&!disposed){queued=true;queueMicrotask(refresh);}});
 observer.observe(root.body,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['aria-label','class','aria-selected','aria-pressed','src','data-target-node-id']});
 const guard=(event:Event)=>{
  if(event.type==='keydown'&&!['Enter',' '].includes((event as KeyboardEvent).key))return;
  const target=event.target as Element|null,element=target?.closest?.(selector);if(!element)return;
  const reason=canvasToolUnavailable(element,propsOf,catalog,assetFor);apply(element,reason);if(!reason)return;
  event.preventDefault();event.stopImmediatePropagation();
  if(event.type==='click'||event.type==='keydown')notice(`暂不可用：${reason}`);
 };
 const events=['pointerdown','mousedown','click','keydown'];
 for(const name of events)root.addEventListener(name,guard,true);
 refresh();
 return()=>{disposed=true;media?.reset();observer.disconnect();unsubscribe?.();root.removeEventListener('input',onInput,true);for(const name of events)root.removeEventListener(name,guard,true);for(const element of owned.keys())restore(element);style.remove();};
}
