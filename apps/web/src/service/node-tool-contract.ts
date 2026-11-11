import type {Asset} from '../api/types';
import {isVideoProfile,videoInputError} from './video-input';
import {validateInputMedia} from './input-media-constraints';
import {fitsInputs,fitsOutputs,type Capability} from './model-catalog';

// Keys in the pinned native toolbar registry (eir / tir); the same key is used
// in pinned buttons and the portalled More menu. Local tools do not need a model.
export const toolbarContracts={
 image:{
  analyze:'vision',poseControl:'edit',panorama:'panorama-menu',quality:'quality-menu',editElement:'layers',storyboard:'edit',
  gridCrop:'local',angle3d:'edit',lighting:'edit',imageEdit:'local',adjust:'local',crop:'local',rotate:'local',
  repaint:'region',erase:'region',expand:'region',cutout:'region',cutoutText:'edit',
 },
 video:{
  clipReshoot:'reshoot',quality:'video-quality',videoEdit:'local',captureFrame:'local',depthCapture:'depth',analyze:'video-analysis',
  audioSep:'audio-menu',repair:'repair',crop:'media',speed:'media',reverse:'media',rotate:'media',
 },
} as const;
const unavailable:Record<string,string>={
 reshoot:'视频重拍流程尚未接通。','video-quality':'视频画质处理模型尚未接入。',depth:'视频深度提取模型尚未接入。',
 'video-analysis':'视频理解能力尚未接入。',repair:'视频修复模型尚未接入。',remake:'视频复刻与分镜分析流程尚未接通。',
 asr:'语音识别能力尚未接入。',lipsync:'对口型模型尚未接入。',app:'AI 应用暂未开放。',
 'video-draft':'视频草案渲染流程尚未接通，请使用已开放的剪辑工具。',
 director:'导演台的 AI 场景识别尚未接通，可手动布置场景。',
 'world-generation':'3D 世界生成模型尚未接入，可上传已有的世界文件。',
 'local-retry':'这是媒体处理结果；请从源视频重新打开处理工具。',
};
const requirements:Record<string,[string,string,string,string?]>={
 vision:['IMAGE_UNDERSTANDING','IMAGE','TEXT'],edit:['IMAGE_TO_IMAGE','IMAGE','IMAGE'],region:['IMAGE_TO_IMAGE','IMAGE','IMAGE'],
 panorama:['IMAGE_TO_IMAGE','IMAGE','IMAGE'],layers:['IMAGE_LAYER_DECOMPOSITION','IMAGE','IMAGE'],upscale:['IMAGE_ENHANCE','IMAGE','IMAGE'],
 'text-image':['TEXT_TO_IMAGE','TEXT','IMAGE'],'text-video':['TEXT_TO_VIDEO','TEXT','VIDEO','TEXT_TO_VIDEO'],motion:['VIDEO_TO_VIDEO','IMAGE','VIDEO','MOTION_TRANSFER'],
};
export function nodeToolReason(action:string,catalog?:readonly Capability[],image?:Asset):string|null{
 if(Object.hasOwn(unavailable,action))return unavailable[action];
 if(action==='audio-video'){
  // The native shortcut creates a normal video node with an audio edge.
  // Apply the same complete reference check as submission, including account access.
  const accepts=(c:Capability)=>c.kind==='OMNI_REFERENCE'&&isVideoProfile(c)&&fitsInputs(c,['AUDIO'])&&!videoInputError({...c,available:true},[{type:'AUDIO'}]);
  if(catalog?.some(c=>c.available&&accepts(c)))return null;
  return '当前账号没有可仅使用音频参考的视频型号。请配置支持该方式的官方全能参考型号，或将图片、视频一并接入普通视频节点。';
 }
 if(!catalog)return null;
 if(action==='quality-menu')return nodeToolReason('edit',catalog,image)&&nodeToolReason('upscale',catalog,image)?'当前没有可用的图片增强或放大模型。':null;
 const rule=requirements[action];if(!rule)return null;
 const [kind,input,output,mode]=rule,candidates=catalog.filter(c=>c.testMode===false&&c.kind===kind&&!!c.model&&fitsInputs(c,action==='motion'?[input,'VIDEO']:[input])&&fitsOutputs(c,kind)&&c.outputKinds?.includes(output)
  &&(!mode||c.parameterSchema?.['x-video-mode']===mode&&c.parameterSchema?.['x-video-parameter-metadata']?.schemaVersion==='1')
  &&(action!=='region'||c.capabilityRef==='codex-image-edit-v1'&&c.version==='3'));
 let inputError='';
 for(const c of candidates)if(c.available){
  if(input==='IMAGE'&&image){try{validateInputMedia(c,[image]);}catch(error){if(!(error instanceof Error))throw error;inputError=error.message;continue;}}
  return null;
 }
 if(inputError)return inputError;
 if(action==='text-video')return '当前账号没有可用的文生视频型号。请在模型设置中配置支持文生视频的厂商 Key，或改用图片参考生成。';
 if(action==='layers')return '图片分层模型尚未接入，可使用重绘、擦除或抠图。';
 if(action==='motion')return '当前没有可用的动作迁移模型。';
 return '当前没有支持此操作的可用模型。';
}
// These exact native forms run commands that *create a different result
// node*. The node owning the toolbar can be a pure uploaded source.
export function newResultTool(button:Element){
 if(!button.matches?.('.generate-action-button'))return undefined;
 if(button.closest('.sb-master-bar[data-rh-storyboard-bar="true"]'))return 'edit';
 if(button.closest('.rh-outpaint__generate,.rh-inplace-mask-editor__generate'))return 'region';
 if(button.closest('.rh-tool-panel__generate,.rh-portrait-generate-controls'))return 'edit';
 return undefined;
}
const panelActions:Record<string,string>={'rh-video-remake':'remake','rh-video-analysis':'video-analysis','rh-remake-request':'remake','rh-ai':'app','audio-to-text':'asr','audio-lip-sync':'lipsync','audio-to-video':'audio-video','llm-video-describe':'video-analysis','text-to-video':'text-video'};
function fiberKeys(element:any){
 const key=Object.keys(element).find(k=>k.startsWith('__reactFiber$')),keys:string[]=[];
 for(let f=key&&element[key],i=0;f&&i<12;f=f.return,i++)if(f.key!=null)keys.push(String(f.key));return keys;
}
export function nativeNodeToolAction(el:Element,props:any[]):string|undefined{
 if(el.matches('.rh-video-draft-dialog__footer .generate-action-button'))return 'video-draft';
 if(newResultTool(el)){
  // A shared bar also hosts cutout/quality. Its exact catalog selection,
  // not the menu's broad source kind, determines the specialized capability.
  const model=props.find(p=>p.currentModel&&p.params)?.currentModel;
  if(model?.kind==='IMAGE_ENHANCE')return 'upscale';
  return newResultTool(el);
 }
 if(el.matches('.director-recognize-price-action > .ai-vision-workspace__primary,.director-recognize-price-action > .text-scene-workspace__primary'))return 'director';
 // Imported canvases can still contain results and open portals of retired
 // services. Their controls bypass the node's ordinary generation button.
 if(el.matches('.video-analysis-result__action.is-primary'))return 'remake';
 if(el.matches('.rh-video-remake-node__button,.remake-request-confirm-button,.rh-video-remake-wb__shell .xyq-launch__confirm .storyboard-fullscreen-step-bar__action,.rh-video-remake-wb__modal .rh-video-remake-wb__primary'))return 'remake';
 // The frozen viewer reuses this class for retrying *uploads*. Only a
 // failed generation calls the run command. Keep reupload and preview live.
 if(el.matches('.world-3d-retry-btn')&&props.some(p=>p.data?.status==='failed'&&typeof p.onNodeDataPatch==='function'))return 'world-generation';
 if(el.matches('.rh-node-selector__item[data-panel-key],.rh-add-node-panel__item[data-panel-key]'))return panelActions[el.getAttribute('data-panel-key')!];
 if(el.matches('.rh-text-selection-item')){
  const menu=props.find(p=>typeof p.onVideo==='function'&&typeof p.onImage==='function'&&typeof p.selectedText==='string');
  const click=props.find(p=>p.className==='rh-text-selection-item')?.onClick;
  if(menu&&click===menu.onVideo)return 'text-video';
  if(menu&&click===menu.onImage)return 'text-image';
 }
 if(el.matches('.rh-node-context-menu__item')){
  const key=fiberKeys(el).find(k=>k.startsWith('down-'));if(key)return panelActions[key.slice(5)];
 }
 const image=el.closest('.rh-canvas-image-toolbar,.rh-media-toolbar-more-portal.image-toolbar'),video=el.closest('.rh-canvas-video-toolbar,.rh-media-toolbar-more-portal.video-toolbar');
 if(!(image||video))return;
 const keys=fiberKeys(el);
 if(image&&el.matches('.rh-image-toolbar-popup__item')&&keys[0]==='generate'&&props.some(p=>typeof p.isViewing==='boolean'&&typeof p.onSelect==='function'))return 'panorama';
 if(video&&el.closest('.more-tools-popup--quality'))return 'video-quality';
 if(el.closest('.rh-image-toolbar-popup--quality')){
  if(keys[0]==='image-enhance')return 'edit';
  if(['image-hd','image-gigapixel'].includes(keys[0]))return 'upscale';return;
 }
 if(!el.matches('.toolbar-btn,.rh-image-toolbar-btn,.rh-media-toolbar-more-portal [role=menuitem]'))return;
 if(video&&keys.includes('one-click-remake'))return 'remake';
 const map:Record<string,string>=image?toolbarContracts.image:toolbarContracts.video;
 return keys.map(k=>Object.hasOwn(map,k)?map[k]:undefined).find(Boolean);
}
