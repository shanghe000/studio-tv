import {expect,it,vi} from 'vitest';
import {installMeasuredGenerationProgress,measuredGenerationLabel} from '../../apps/web/src/service/generation-progress';

it('labels sampler scope explicitly and clears percentages outside measured sampling',()=>{
 const base={taskId:'task',state:'RUNNING',progress:.5,progressDetail:{scope:'SAMPLING' as const,phase:'sampling'}};
 expect(measuredGenerationLabel(base)).toBe('采样进度 50%');
 expect(measuredGenerationLabel({...base,progress:null,progressDetail:{scope:'SAMPLING',phase:'decoding'}})).toBe('解码中');
 expect(measuredGenerationLabel({...base,progress:null,progressDetail:{scope:'SAMPLING',phase:'loading_model'}})).toBe('加载模型中');
 expect(measuredGenerationLabel({...base,progress:null,progressDetail:{scope:'SAMPLING',phase:'UPSCALING'}})).toBe('超分处理中');
 expect(measuredGenerationLabel({...base,progress:null,progressDetail:null},'运行中 91%')).toBe('运行中');
 expect(measuredGenerationLabel({...base,state:'QUEUED'})).toBe('排队中');
 expect(measuredGenerationLabel({...base,state:'FAILED'})).toBe('生成失败');
 expect(measuredGenerationLabel({...base,state:'CANCELED'})).toBe('已取消');
 expect(measuredGenerationLabel({...base,state:'SUCCEEDED',progress:1,progressDetail:{scope:'TASK',phase:'completed'}})).toBe('已完成');
 expect(measuredGenerationLabel({...base,progress:.9,progressDetail:null})).not.toContain('%');
});

it('labels segmented generation without inventing a sampling fraction or changing its task scope',()=>{
 const value={taskId:'long-video',state:'RUNNING',progress:null,progressDetail:{scope:'TASK' as const,phase:'SEGMENT_GENERATION'}},before=structuredClone(value);
 expect(measuredGenerationLabel(value,'采样中 93%')).toBe('分段生成中');expect(value).toEqual(before);
 expect(measuredGenerationLabel({...value,state:'QUEUED'})).toBe('排队中');expect(measuredGenerationLabel({...value,state:'SUCCEEDED',progress:1})).toBe('已完成');
 expect(measuredGenerationLabel({...value,progressDetail:{scope:'TASK',phase:'DECODING'}})).toBe('解码中');
});

it('replaces only the pinned native estimate component and retains unrelated upload labels',()=>{
 function K3(){} function UploadLabel(){}
 const original=vi.fn((component:any,props:any)=>({component,props})),value={taskId:'task',state:'RUNNING',progress:.25,progressDetail:{scope:'SAMPLING',phase:'sampling'}},execution={subscribeProgress:vi.fn(),nodeProgress:vi.fn(()=>value)},native={j:{jsx:original,jsxs:original},r:{Fragment:'fragment',useSyncExternalStore:(_subscribe:any,read:any)=>read(),createElement:(component:any,props:any,...children:any[])=>({component,props,children})},bt:()=>({getRemoteData:()=>({nodes:[]})})};
 const stop=installMeasuredGenerationProgress({execution},native);
 try{
  const projected=native.j.jsx(K3,{nodeId:'node',baseText:'生成中'}),rendered=projected.component(projected.props);
  expect(rendered.children).toEqual(['采样进度 25%']);
  expect(native.j.jsx(UploadLabel,{nodeId:'node',baseText:'上传中'}).component).toBe(UploadLabel);
  execution.nodeProgress.mockReturnValue(undefined as any);
  expect(projected.component(projected.props).component).toBe(K3);
 }finally{stop();}
 expect(native.j.jsx).toBe(original);
});
