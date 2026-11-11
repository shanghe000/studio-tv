interface SubjectPair {referenceSubjectIndex:number;sourceSubjectIndex:number}
export function videoSubjectSelection(field:any,value:unknown){
 const metadata=field?.studioVideoSubjectMetadata,schema=metadata?.parameterSchema,control=metadata?.control;
 if(field?.paramName!=='subjectMapping'||control?.mode!=='MULTI'||control.mappingRequired!==true||control.maskRequirement!=='AUTO_SAM3_REQUIRED'||schema?.type!=='array'||schema.minItems!==1||schema.maxItems!==5)return;
 const properties=schema.items?.properties;
 if(!['referenceSubjectIndex','sourceSubjectIndex'].every(key=>properties?.[key]?.type==='integer'&&properties[key].minimum===0&&properties[key].maximum===4))return;
 const rows=value??field.paramValue;
 if(!Array.isArray(rows)||rows.length<1||rows.length>5||rows.some(row=>!row||typeof row!=='object'||Object.keys(row).length!==2||!['referenceSubjectIndex','sourceSubjectIndex'].every(key=>Number.isSafeInteger(row[key])&&row[key]>=0&&row[key]<=4)))return;
 if(['referenceSubjectIndex','sourceSubjectIndex'].some(key=>new Set(rows.map(row=>row[key])).size!==rows.length))return;
 return rows.map(row=>({...row})) as SubjectPair[];
}
export function hasVideoSubjectControls(props:any){
 if(typeof props?.onChange!=='function'||!Array.isArray(props.modelConfig))return;
 const fields=props.modelConfig.filter((field:any)=>field?.paramName==='subjectMapping');if(fields.length!==1)return;
 return videoSubjectSelection(fields[0],props.params?.subjectMapping)?fields[0]:undefined;
}
export function createVideoSubjectControls(react:any,isActive:()=>boolean=()=>true){
 const h=(type:any,props:any,...children:any[])=>react.createElement(type,props,...children);
 return function VideoSubjectControls({field,value,onChange,isEn=false,disabled=false}:any){
  const rows=videoSubjectSelection(field,value);if(!rows)return null;
  const blocked=disabled||field.disabled===true,update=(next:SubjectPair[])=>{if(!blocked&&isActive()&&videoSubjectSelection(field,next))onChange('subjectMapping',next);};
  const stop=(event:any)=>event.stopPropagation(),label=isEn?'Subject mapping':'人物动作配对';
  return h('div',{className:'video-params-block studio-video-subjects nodrag nopan nowheel','data-studio-video-subjects':'',onPointerDown:stop,onMouseDown:stop,onClick:stop,onKeyDown:(event:any)=>{if(event.key!=='Escape')event.stopPropagation();}},
   h('div',{className:'studio-h3-parameter-label'},label),
   h('p',{className:'studio-video-subject-description'},isEn?'Number people from 0, left to right in the reference image and the frame where each person first appears in the video. Select matching people; do not paint labels or colors on the image.':'参考图按从左到右编号；视频按人物首次出现的画面编号，均从 0 开始。选择对应人物即可，无需在图上标号或涂色。'),
   ...rows.map((row,index)=>h('fieldset',{key:index,className:'studio-video-subject-pair',disabled:blocked},h('legend',null,isEn?`Pair ${index+1}`:`配对 ${index+1}`),
    ...(['referenceSubjectIndex','sourceSubjectIndex'] as const).map((key,column)=>h('label',{key},h('span',null,isEn?column?'Video subject':'Image subject':column?'动作视频人物':'参考图人物'),h('select',{'aria-label':`${isEn?`Pair ${index+1}`:`配对 ${index+1}`} ${isEn?column?'Video subject':'Image subject':column?'动作视频人物':'参考图人物'}`,value:row[key],onChange:(event:any)=>{const value=Number(event.currentTarget.value);if(!Number.isSafeInteger(value)||value<0||value>4)return;update(rows.map((pair,i)=>i===index?{...pair,[key]:value}:pair));}},...[0,1,2,3,4].map(value=>h('option',{key:value,value,disabled:rows.some((pair,i)=>i!==index&&pair[key]===value)},String(value)))))),
    h('button',{type:'button',className:'studio-video-subject-remove',disabled:blocked||rows.length===1,'aria-label':isEn?`Remove pair ${index+1}`:`移除配对 ${index+1}`,onClick:()=>update(rows.filter((_,i)=>i!==index))},isEn?'Remove':'移除'))),
   h('button',{type:'button',className:'studio-video-subject-add',disabled:blocked||rows.length===5,onClick:()=>{
    const next=(key:keyof SubjectPair)=>[0,1,2,3,4].find(value=>!rows.some(pair=>pair[key]===value));
    const referenceSubjectIndex=next('referenceSubjectIndex'),sourceSubjectIndex=next('sourceSubjectIndex');if(referenceSubjectIndex!==undefined&&sourceSubjectIndex!==undefined)update([...rows,{referenceSubjectIndex,sourceSubjectIndex}]);
   }},isEn?'Add subject pair':'添加人物配对'),
   h('p',{className:'studio-video-subject-description'},isEn?'1–5 pairs. Person masks are generated automatically with SAM3; uploaded masks are not supported.':'支持 1–5 组。人物遮罩由 SAM3 自动生成，无需上传遮罩。'));
 };
}
export const videoSubjectControlStyles=`
 .studio-video-subjects{width:100%;min-width:0;color:#e5e5e5;font-size:12px;line-height:1.4}
 .studio-video-subject-description{margin:6px 0 12px;color:#b8b8bd;font-size:11px;line-height:1.6;overflow-wrap:anywhere}
 .studio-video-subject-pair{display:flex;align-items:end;gap:8px;min-width:0;margin:0 0 10px;padding:0;border:0}
 .studio-video-subject-pair legend{margin-bottom:6px;padding:0;color:#e5e5e5;font-size:12px}
 .studio-video-subject-pair label{flex:1;min-width:0;color:#b8b8bd;font-size:11px}
 .studio-video-subject-pair label span{display:block;margin-bottom:4px}
 .studio-video-subject-pair select{width:100%;min-height:32px;padding:4px 8px;border:1px solid #ffffff26;border-radius:6px;background:#29292c;color:#e5e5e5;font:inherit;color-scheme:dark}
 .studio-video-subject-remove,.studio-video-subject-add{min-height:32px;padding:4px 8px;border:1px solid #ffffff26;border-radius:6px;background:transparent;color:#e5e5e5;font:inherit;cursor:pointer}
 .studio-video-subject-add{margin-bottom:4px}
 .studio-video-subject-remove:hover:not(:disabled),.studio-video-subject-add:hover:not(:disabled){background:#ffffff15}
 .studio-video-subject-remove:disabled,.studio-video-subject-add:disabled{opacity:.45;cursor:default}
 .studio-video-subject-pair select:focus-visible,.studio-video-subject-remove:focus-visible,.studio-video-subject-add:focus-visible{outline:2px solid #b7c8ff;outline-offset:2px}
`;
