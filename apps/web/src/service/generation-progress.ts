export interface ProgressDetail {phase:string;scope:'SAMPLING'|'TASK';currentStep?:number;totalSteps?:number}
export interface GenerationProgress {taskId:string;state:string;progress:number|null;progressDetail?:ProgressDetail|null}

export function measuredGenerationLabel(value:GenerationProgress,baseText='运行中'){
 if(value.state==='QUEUED')return '排队中';
 if(value.state==='SUCCEEDED')return '已完成';
 if(value.state==='FAILED')return '生成失败';
 if(value.state==='CANCELED')return '已取消';
 const detail=value.progressDetail;
 if(detail?.scope==='SAMPLING'&&typeof value.progress==='number'&&Number.isFinite(value.progress)&&value.progress>=0&&value.progress<=1)return `采样进度 ${Math.floor(value.progress*100)}%`;
 const phase=String(detail?.phase??'').toLowerCase();
 if(phase==='segment_generation')return '分段生成中';
 if(/queu|wait/.test(phase))return '排队中';
 if(/load/.test(phase))return '加载模型中';
 if(/decod/.test(phase))return '解码中';
 if(/upscal/.test(phase))return '超分处理中';
 if(/encod|sav|mux/.test(phase))return '保存成片中';
 if(/sampl/.test(phase))return '采样中';
 return baseText.replace(/\s*\d+(?:\.\d+)?%/g,'')||'运行中';
}

/** Replace the inspected native estimate label, leaving the original loading
 * card, cancel button and unrelated upload progress untouched. */
export function installMeasuredGenerationProgress(runtime:any,native:any){
 const react=native.r,jsx=native.j;
 if(!react?.useSyncExternalStore||!jsx)return()=>{};
 const installed:{name:string;original:Function;wrapper:Function}[]=[];
 const fallback=(id:string):GenerationProgress|undefined=>{
  const node=native.bt?.()?.getRemoteData?.()?.nodes?.find((row:any)=>row.id===id),data=node?.data;
  if(!data?.taskId||!Object.hasOwn(data,'progressDetail')&&!String(data.taskId).startsWith('tsk_'))return;
  // An old terminal node can show this loading label while a retry is still
  // submitting. Its previous completion is not the new attempt's progress.
  const active=['processing','running'].includes(data.status);
  return{taskId:data.taskId,state:'RUNNING',progress:active&&typeof data.progress==='number'?data.progress/100:null,progressDetail:active?data.progressDetail:null};
 };
 function MeasuredLabel({nodeId,baseText,original}:any){
  const observed=react.useSyncExternalStore(runtime.execution.subscribeProgress,()=>runtime.execution.nodeProgress(nodeId),()=>undefined),value=observed??fallback(nodeId);
  return value?react.createElement(react.Fragment,null,measuredGenerationLabel(value,baseText)):react.createElement(original,{nodeId,baseText});
 }
 for(const name of ['jsx','jsxs'])if(typeof jsx[name]==='function'){
  const original=jsx[name],wrapper=function(this:any,...args:any[]){
   // K3 is the pinned native timer-based generation label in index-DeyN_Phq.
   if(typeof args[0]==='function'&&args[0].name==='K3'&&typeof args[1]?.nodeId==='string'&&typeof args[1]?.baseText==='string')args=[MeasuredLabel,{...args[1],original:args[0]},...args.slice(2)];
   return Reflect.apply(original,this,args);
  };jsx[name]=wrapper;installed.push({name,original,wrapper});
 }
 return()=>{for(const {name,original,wrapper}of installed)if(jsx[name]===wrapper)jsx[name]=original;};
}
