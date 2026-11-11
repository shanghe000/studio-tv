import {videoParameterSelection,selectVideoParameter} from './video-parameter-options';
import type {VideoInputGuidance} from './video-input-guidance';

export interface H3ParameterControlProps {
 field:any;
 value:unknown;
 onChange:(name:string,value:string)=>void;
 isEn?:boolean;
 disabled?:boolean;
}

/** Af has no selected-model prop. Only the explicitly tagged, validated video
 * output field may opt in; unrelated outputPreset fields keep native UI. */
export function hasH3ParameterControls(props:any){
 if(typeof props?.onChange!=='function'||!Array.isArray(props.modelConfig))return;
 const fields=props.modelConfig.filter((field:any)=>field?.paramName==='outputPreset');
 if(fields.length!==1)return;
 const field=fields[0];
 return videoParameterSelection(field,props.params?.outputPreset??field.paramValue)?field:undefined;
}

/** Reuse the frozen application's React instance. This component is fully
 * controlled: only a real advertised optionValue crosses the native callback. */
export function createH3ParameterControls(react:any,isActive:()=>boolean=()=>true){
 const h=(type:any,props:any,...children:any[])=>react.createElement(type,props,...children);
 return function H3ParameterControls({field,value,onChange,isEn=false,disabled=false}:H3ParameterControlProps){
  const view=videoParameterSelection(field,value);if(!view)return null;
  const selected=view.selected,tuple=selected.preset,blocked=disabled||field.disabled===true,guide=field.studioVideoInputGuidance as VideoInputGuidance|undefined;
  const words=isEn?{ratio:'Choose aspect ratio',resolution:'Choose resolution',duration:'Choose video duration',second:'s',original:'Original sizes',current:'Current output',upgrade:'Choosing a new specification uses the new parameters.'}:{ratio:'选择比例',resolution:'选择分辨率',duration:'选择视频生成时长',second:'秒',original:'保留规格',current:'当前输出',upgrade:'选择新增规格将使用新版参数。'};
  const choose=(change:Parameters<typeof selectVideoParameter>[1])=>{
   if(blocked||!isActive())return;
   const next=selectVideoParameter(view,change);if(next!==undefined&&next!==value)onChange('outputPreset',next);
  };
  const stop=(event:any)=>event.stopPropagation();
  const icon=(ratio:string)=>{
   if(ratio==='adaptive')return h('svg',{viewBox:'0 0 32 28',width:32,height:28,fill:'none',stroke:'currentColor',strokeWidth:1.5,'aria-hidden':true,focusable:false},h('rect',{x:4,y:5,width:24,height:18,rx:2,strokeDasharray:'3 2'}));
   const [width,height]=ratio.split(':').map(Number),scale=Math.min(26/width,22/height),w=width*scale,b=height*scale;
   return h('svg',{viewBox:'0 0 32 28',width:32,height:28,fill:'none',stroke:'currentColor',strokeWidth:1.5,'aria-hidden':true,focusable:false},h('rect',{x:(32-w)/2,y:(28-b)/2,width:w,height:b,rx:2}));
  };
  const followsSource=view.metadata?.durationPolicy==='SOURCE_VIDEO';
  const duration=view.durations[Math.max(0,view.durationIndex)]??tuple.durationSeconds,oneDuration=view.durations.length<2,automatic=duration===-1;
  const durationText=followsSource?(isEn?'Match motion video':'跟随动作视频'):automatic?(isEn?'Follow references':'智能跟随'):oneDuration?(isEn?`Fixed ${duration}s`:`固定${duration}秒`):`${duration} ${words.second}`;
  const originalSelected=view.extras.some(choice=>choice.value===selected.value);
  const ratioLabel=(label:string)=>label==='adaptive'?(isEn?'Match references':'自动匹配参考素材'):label;
  const mode=guide?.mode??view.metadata?.mode,modeLabel:Record<string,[string,string]>={TEXT_TO_VIDEO:['文生视频','Text to video'],FIRST_FRAME:['首帧图生视频','First frame'],LAST_FRAME:['尾帧图生视频','Last frame'],FIRST_LAST_FRAME:['首尾帧图生视频','First and last frames'],OMNI_REFERENCE:['全能参考','Multimodal reference'],MOTION_TRANSFER:['动作迁移','Motion transfer']};
  const roles=Array.isArray(view.metadata?.mediaRoles)?view.metadata.mediaRoles.filter(role=>role&&typeof role.title==='string'&&role.title&&typeof role.role==='string'):[];
  const subject=view.metadata?.subjectControl;
  const outputBytes=view.metadata?.outputLimits?.maxArtifactBytes,outputMiB=typeof outputBytes==='number'&&Number.isSafeInteger(outputBytes)&&outputBytes>0?outputBytes/1024/1024:undefined;
  const summary=[tuple.width&&tuple.height?`${tuple.width}×${tuple.height}`:selected.resolution?.toUpperCase(),!view.legacy&&selected.ratio?ratioLabel(selected.ratio):undefined,followsSource?(isEn?'Match motion video':'跟随动作视频'):tuple.durationSeconds===-1?(isEn?'Follow references':'智能跟随'):`${tuple.durationSeconds}${words.second}`,tuple.fps?`${tuple.fps} fps`:undefined].filter(Boolean).join(' · ');
  return h('div',{className:'video-params-block scale-selector studio-h3-parameters nodrag nopan nowheel','data-studio-h3-parameters':'','data-studio-video-parameters':'',onPointerDown:stop,onMouseDown:stop,onClick:stop,onKeyDown:(event:any)=>{if(event.key!=='Escape')event.stopPropagation();}},
   guide?h('div',{className:'studio-video-reference-requirements studio-video-reference-requirements--primary','data-studio-video-material-help':''},
    h('div',{className:'studio-h3-parameter-label'},isEn?'Materials for this video':'生成所需素材'),
    h('p',{className:'studio-video-input-summary'},guide.summary),
    guide.mode!=='TEXT_TO_VIDEO'?h('p',{className:'studio-video-input-connection'},guide.connection):null,
    h('dl',null,...guide.materials.map(material=>h('div',{key:material.kind},h('dt',null,material.title,material.minimum>0?h('span',null,isEn?' · Required':' · 必填'):null),h('dd',null,material.description)))),
    guide.subject?h('p',{className:'studio-video-input-connection'},guide.subject):null,
    guide.promptIgnored?h('p',{className:'studio-video-input-connection'},isEn?'This model uses the image and motion video; no prompt is needed.':'此型号按人物图和动作视频处理，无需填写提示词。'):null):null,
   mode&&modeLabel[mode]?h('div',{className:'studio-video-mode'},modeLabel[mode][isEn?1:0]):null,
   view.ratios.length?h('div',{className:'studio-h3-parameter-section'},
    h('div',{className:'studio-h3-parameter-label'},words.ratio),
    h('div',{className:'studio-h3-ratios',style:{gridTemplateColumns:`repeat(${Math.min(6,view.ratios.length)},minmax(0,1fr))`},role:'group','aria-label':words.ratio},...view.ratios.map(ratio=>h('button',{key:ratio.id,type:'button',className:'studio-h3-ratio',disabled:blocked||ratio.disabled,'aria-label':`${words.ratio} ${ratioLabel(ratio.label)}`,'aria-pressed':selected.ratio===ratio.id,'data-h3-ratio':ratio.id,onClick:()=>choose({ratio:ratio.id})},icon(ratio.label),h('span',null,ratioLabel(ratio.label)))))):null,
   view.resolutions.length?h('div',{className:'studio-h3-parameter-section'},
    h('div',{className:'studio-h3-parameter-label'},words.resolution),
    h('div',{className:'studio-h3-resolutions',role:'group','aria-label':words.resolution},...view.resolutions.map(resolution=>h('button',{key:resolution.id,type:'button',className:'studio-h3-resolution',disabled:blocked||resolution.disabled,'aria-pressed':selected.resolution===resolution.id,'data-h3-resolution':resolution.id,onClick:()=>choose({resolution:resolution.id})},resolution.label)))):null,
   h('div',{className:'studio-h3-parameter-section'},
    h('div',{className:'studio-h3-duration-heading'},h('span',{className:'studio-h3-parameter-label'},words.duration),view.durations.length>3&&!automatic&&!followsSource?h('select',{className:'studio-h3-duration-select',value:duration,disabled:blocked,'aria-label':words.duration,onChange:(event:any)=>choose({durationSeconds:Number(event.currentTarget.value)})},...view.durations.map(seconds=>h('option',{key:seconds,value:seconds},`${seconds} ${words.second}`))):h('output',{className:'studio-h3-duration-value','aria-live':'polite'},durationText)),
    !automatic&&!followsSource?h('input',{type:'range',className:'studio-h3-duration',min:0,max:Math.max(1,view.durations.length-1),step:1,value:Math.max(0,view.durationIndex),style:{'--studio-h3-range-fill':`${oneDuration?0:Math.max(0,view.durationIndex)/(view.durations.length-1)*100}%`},disabled:blocked||oneDuration,'aria-label':words.duration,'aria-valuetext':durationText,'data-rh-canvas-slider-interaction':'true',onChange:(event:any)=>{
     const index=Number(event.currentTarget.value);if(!Number.isSafeInteger(index)||index<0||index>=view.durations.length)return;
     choose({durationSeconds:view.durations[index]});
    }}):null,
    !automatic&&!followsSource?h('div',{className:'studio-h3-duration-stops','aria-hidden':true},...view.durations.flatMap((seconds,index)=>view.durations.length>5&&index!==0&&index!==view.durations.length-1&&index!==Math.floor((view.durations.length-1)/2)?[]:[h('span',{key:seconds,style:{left:`${oneDuration?0:index/(view.durations.length-1)*100}%`}},`${seconds}${words.second}`)])):null,
    followsSource?h('p',{className:'studio-h3-upgrade-hint','data-studio-source-duration':''},isEn?`Output uses the full motion video (${view.metadata?.sourceSecondsMin}–${view.metadata?.sourceSecondsMax}s). Trim the source video first if you need a shorter result.`:`按完整动作视频时长生成（支持 ${view.metadata?.sourceSecondsMin}–${view.metadata?.sourceSecondsMax} 秒）。需要缩短时，请先裁剪源视频。`):null),
   view.extras.length>0?h('label',{className:'studio-h3-original'},h('span',null,words.original),h('select',{value:originalSelected?selected.value:'',disabled:blocked,'aria-label':words.original,onChange:(event:any)=>choose({value:event.currentTarget.value})},h('option',{value:'',disabled:true},isEn?'Choose an original size':'选择原有尺寸'),...view.extras.map(choice=>h('option',{key:choice.value,value:choice.value,disabled:choice.disabled},`${choice.preset.width}×${choice.preset.height} · ${choice.preset.durationSeconds}${words.second}`)))):null,
   h('div',{className:'studio-h3-output-summary','aria-label':words.current},summary+(view.legacy&&selected.resolution==='1080p'?(isEn?' · 32-pixel aligned':' · 32像素对齐'):'')),
   view.metadata?.supportsCancel===false?h('p',{className:'studio-h3-upgrade-hint'},isEn?'Submitted video tasks cannot be stopped. Check references and parameters before generating.':'任务提交后不能停止，请在生成前确认参考素材和参数。'):null,
   outputMiB?h('p',{className:'studio-h3-upgrade-hint'},isEn?`Videos up to ${outputMiB} MiB can be imported. For larger files, choose a lower resolution or shorter duration.`:`成片最多导入 ${outputMiB} MiB；超过上限不会导入，请降低分辨率或时长后重试。`):null,
   !guide&&roles.length?h('div',{className:'studio-video-reference-requirements'},h('div',{className:'studio-h3-parameter-label'},isEn?'Reference requirements':'参考素材要求'),h('dl',null,...roles.map(role=>h('div',{key:role.role},h('dt',null,role.title,role.minItems&&role.minItems>0?h('span',null,isEn?' · Required':' · 必填'):null),h('dd',null,typeof role.description==='string'?role.description:role.maxItems?(isEn?`Up to ${role.maxItems}`:`最多 ${role.maxItems} 个`):''))))):null,
   !guide&&subject&&['SINGLE','MULTI'].includes(subject.mode)?h('p',{className:'studio-video-subject-requirement'},subject.mode==='MULTI'?(isEn?'Multiple subjects':'多人动作'):(isEn?'Single subject':'单人动作'),typeof subject.maskSemantics==='string'?` · ${subject.maskSemantics}`:''):null,
   view.choices.some(choice=>choice.upgrade)&&!selected.upgrade?h('p',{className:'studio-h3-upgrade-hint'},words.upgrade):null);
 };
}

export const h3ParameterControlStyles=`
 .studio-h3-parameters{width:100%;min-width:0;box-sizing:border-box;color:#e5e5e5;font-size:12px;line-height:1.4}
 .studio-h3-parameters .studio-h3-parameter-section+.studio-h3-parameter-section{margin-top:18px}
 .studio-h3-parameters .studio-h3-parameter-label{display:block;margin:0 0 8px;color:#b8b8bd;font-size:12px;font-weight:500;line-height:16px}
 .studio-h3-ratios{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:2px;padding:4px;border-radius:9px;background:#ffffff09}
 .studio-h3-ratio,.studio-h3-resolution{box-sizing:border-box;min-width:0;border:0;border-radius:6px;background:transparent;color:#b8b8bd;font:inherit;cursor:pointer;transition:background-color .15s ease,color .15s ease}
 .studio-h3-ratio{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;min-height:56px;padding:4px 2px}
 .studio-h3-ratio span{font-size:11px;line-height:14px;white-space:nowrap}
 .studio-h3-ratio svg{display:block;flex-shrink:0}
 .studio-h3-ratio:hover:not(:disabled),.studio-h3-resolution:hover:not(:disabled){background:#ffffff15;color:#f5f5f7}
 .studio-h3-ratio[aria-pressed=true],.studio-h3-resolution[aria-pressed=true]{background:#ffffff24;color:#fff}
 .studio-h3-ratio:focus-visible,.studio-h3-resolution:focus-visible,.studio-h3-duration:focus-visible,.studio-h3-original select:focus-visible{outline:2px solid #b7c8ff;outline-offset:2px}
 .studio-h3-ratio:disabled,.studio-h3-resolution:disabled{opacity:.45;cursor:not-allowed}
 .studio-h3-resolutions{display:flex;flex-wrap:wrap;gap:2px;padding:3px;border-radius:8px;background:#ffffff09}
 .studio-h3-resolution{flex:1 0 48px;min-height:34px;padding:7px 8px;font-weight:500}
 .studio-h3-duration-heading{display:flex;align-items:baseline;justify-content:space-between;gap:8px}
 .studio-h3-parameters .studio-h3-duration-heading .studio-h3-parameter-label{margin-bottom:0}
 .studio-h3-duration-value{color:#f5f5f7;font-size:13px;font-variant-numeric:tabular-nums}
 .studio-h3-duration-select{max-width:110px;min-height:32px;padding:4px 8px;border:1px solid #ffffff26;border-radius:6px;background:#29292d;color:#f5f5f7;font:inherit;font-variant-numeric:tabular-nums}
 .studio-h3-duration-select:focus-visible{outline:2px solid #b7c8ff;outline-offset:2px}
 .studio-h3-duration{display:block;box-sizing:border-box;appearance:none;-webkit-appearance:none;width:100%;height:22px;margin:7px 0 0;padding:0;border:0;background:transparent;cursor:pointer;touch-action:pan-y}
 .studio-h3-duration::-webkit-slider-runnable-track{height:4px;border-radius:2px;background:linear-gradient(to right,#c7c7ce var(--studio-h3-range-fill,0%),#ffffff26 var(--studio-h3-range-fill,0%))}
 .studio-h3-duration::-webkit-slider-thumb{appearance:none;-webkit-appearance:none;width:4px;height:16px;margin-top:-6px;border:0;border-radius:2px;background:#fff}
 .studio-h3-duration::-moz-range-track{height:4px;border-radius:2px;background:#ffffff26}
 .studio-h3-duration::-moz-range-progress{height:4px;border-radius:2px;background:#c7c7ce}
 .studio-h3-duration::-moz-range-thumb{width:4px;height:16px;border:0;border-radius:2px;background:#fff}
 .studio-h3-duration:disabled{opacity:.65;cursor:default}
 .studio-h3-duration-stops{position:relative;height:16px;margin:0 7px;color:#b8b8bd;font-size:11px;font-variant-numeric:tabular-nums}
 .studio-h3-duration-stops span{position:absolute;top:0;transform:translateX(-50%);white-space:nowrap}
 .studio-h3-duration-stops span:first-child{transform:none}
 .studio-h3-duration-stops span:last-child:not(:first-child){transform:translateX(-100%)}
 .studio-h3-original{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;margin-top:16px;color:#b8b8bd}
 .studio-h3-original select{flex:1;min-width:0;max-width:100%;padding:6px 8px;border:1px solid #ffffff26;border-radius:6px;background:#29292c;color:#e5e5e5;font:inherit;color-scheme:dark}
 .studio-h3-output-summary{margin-top:12px;color:#b8b8bd;font-size:11px;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
 .studio-h3-upgrade-hint{margin:6px 0 0;color:#b8b8bd;font-size:11px;line-height:1.5}
 .studio-video-mode{margin-bottom:16px;color:#e5e5e5;font-size:12px;font-weight:500}
 .studio-video-reference-requirements{margin-top:18px}
 .studio-video-reference-requirements--primary{margin:0 0 18px}
 .studio-video-input-summary{margin:0 0 6px;color:#e5e5e5;font-size:12px;line-height:1.5}
 .studio-video-input-connection{margin:6px 0 10px;color:#b8b8bd;font-size:11px;line-height:1.6;overflow-wrap:anywhere}
 .studio-video-reference-requirements dl{margin:0}
 .studio-video-reference-requirements dl>div+div{margin-top:10px}
 .studio-video-reference-requirements dt{color:#e5e5e5;font-size:12px}
 .studio-video-reference-requirements dt span,.studio-video-reference-requirements dd,.studio-video-subject-requirement{color:#b8b8bd;font-size:11px;line-height:1.5;overflow-wrap:anywhere}
 .studio-video-reference-requirements dd{margin:2px 0 0}
 .studio-video-subject-requirement{margin:10px 0 0}
 @media(prefers-reduced-motion:reduce){.studio-h3-ratio,.studio-h3-resolution{transition:none}}
`;
