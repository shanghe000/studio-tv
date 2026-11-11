import {describe,expect,it} from 'vitest';
import {ApiError} from '../../apps/web/src/api/client';
import type {Asset} from '../../apps/web/src/api/types';
import {selectCapability,resolveCapability,type Capability} from '../../apps/web/src/service/model-catalog';
import {preflightContext,preflightError,withPreflightContext} from '../../apps/web/src/service/preflight';
import {videoInputIssues,videoPreflightError,videoParameters} from '../../apps/web/src/service/video-input';
import {validateInputMedia} from '../../apps/web/src/service/input-media-constraints';

const model=(patch:Partial<Capability>={}):Capability=>({capabilityRef:'selected-model',version:'4',title:'所选模型',kind:'LLM',testMode:false,available:true,inputKinds:['TEXT','STRUCTURED'],outputKinds:['TEXT'],model:{providerRef:'configured',modelRef:'configured',title:'Configured',version:'2'},...patch});
const video=(mode='MOTION_TRANSFER',legacy=false):Capability=>model({kind:'IMAGE_TO_VIDEO',inputKinds:['TEXT','IMAGE','VIDEO','AUDIO'],outputKinds:['VIDEO'],model:{providerRef:'configured',modelRef:legacy?'h3':'configured',title:'Configured',version:'2'},parameterSchema:{'x-video-parameter-metadata':{schemaVersion:'1'},'x-video-mode':mode,'x-media-limits':{IMAGE:1,VIDEO:1,AUDIO:0},'x-media-total-limit':2}});
const caught=(run:()=>unknown)=>{try{run();throw new Error('expected preflight rejection');}catch(error){if(!(error instanceof ApiError))throw error;return error;}};

describe('structured preflight validation',()=>{
 it('identifies the selected model/version and each unsupported input kind',()=>{
  const cap=model(),error=caught(()=>selectCapability([cap],'LLM',['TEXT','IMAGE','AUDIO'],{capabilityRef:cap.capabilityRef}));
  expect(error.message).toContain('selected-model');expect(error.message).toContain('版本 4');expect(error.message).toContain('图片、音频');expect(error.message).toContain('支持的输入为文字、结构化数据');
  expect(preflightContext(error)).toEqual({schemaVersion:'1',capabilityRef:'selected-model',capabilityVersion:'4',requestedKind:'IMAGE_UNDERSTANDING',inputKinds:['TEXT','IMAGE','AUDIO'],issues:[{field:'model.kind',reason:'KIND_MISMATCH'},{field:'inputs.kind',reason:'KIND_UNSUPPORTED',inputKind:'IMAGE',expectedKinds:['TEXT','STRUCTURED']},{field:'inputs.kind',reason:'KIND_UNSUPPORTED',inputKind:'AUDIO',expectedKinds:['TEXT','STRUCTURED']}]});
 });
 it('records an output mismatch separately from an input mismatch',()=>{
  const cap=model({outputKinds:['IMAGE']}),error=caught(()=>selectCapability([cap],'LLM',['TEXT'],{capabilityRef:cap.capabilityRef}));
  expect(preflightContext(error)?.issues).toEqual([{field:'output.kind',reason:'OUTPUT_UNSUPPORTED',expectedKinds:['TEXT','STRUCTURED']}]);expect(error.message).toContain('文字或结构化输出');
 });
 it('records forbidden media kind without inventing an asset position',()=>{
  const cap=video('TEXT_TO_VIDEO'),error=caught(()=>selectCapability([cap],cap.kind,['TEXT','VIDEO'],{capabilityRef:cap.capabilityRef}));
  expect(preflightContext(error)?.issues).toEqual([{field:'references.kind',reason:'REFERENCE_FORBIDDEN',inputKind:'VIDEO',maximum:0}]);expect(error.message).toContain('移除参考素材');
 });
 it('records missing and excessive references for current and historical H3 modes',()=>{
  const missing=videoPreflightError(video('FIRST_LAST_FRAME',true),[{type:'image'}]);
  expect(missing?.message).toContain('需要 2 张图片');expect(preflightContext(missing)?.issues).toEqual([{field:'references.count',reason:'COUNT_REQUIRED',inputKind:'IMAGE',actual:1,expected:2}]);
  const excess=videoPreflightError(video(),[{type:'image'},{type:'image'},{type:'video'}]);
  expect(preflightContext(excess)?.issues).toEqual([{field:'references.total',reason:'COUNT_EXCEEDED',actual:3,maximum:2},{field:'references.count',reason:'COUNT_EXCEEDED',inputKind:'IMAGE',actual:2,maximum:1}]);
  expect(videoInputIssues(video('OMNI_REFERENCE',true),[{type:'audio'}])[0]).toMatchObject({field:'references.count',reason:'KIND_UNSUPPORTED',inputKind:'AUDIO',actual:1,maximum:0});
  expect(videoInputIssues(video('OMNI_REFERENCE',true),[])).toEqual([{field:'references.visual',reason:'REFERENCE_REQUIRED',actual:0,minimum:1,expectedKinds:['IMAGE','VIDEO']}]);
 });
 it('records required roles and upload problems without copying reference values',()=>{
  const cap=video();cap.parameterSchema['x-media-roles']=[{kind:'VIDEO',minItems:1,title:'动作源视频'}];
  expect(videoInputIssues(cap,[{type:'image'}])).toEqual([{field:'references.count',reason:'REFERENCE_REQUIRED',inputKind:'VIDEO',actual:0,minimum:1}]);
  expect(videoInputIssues(cap,[{type:'video',uploading:true}])).toEqual([{field:'references.upload',reason:'UPLOAD_PENDING',inputKind:'VIDEO',inputIndex:0}]);
  expect(videoInputIssues(cap,[{type:'image',uploadError:true}])).toEqual([{field:'references.upload',reason:'UPLOAD_FAILED',inputKind:'IMAGE',inputIndex:0}]);
 });
 it('includes measured asset size/duration and limits with exact input identity',()=>{
  const cap=video();cap.parameterSchema['x-input-media-constraints']={schemaVersion:'1',kinds:{IMAGE:{maxBytes:10*1048576,maxWidth:4096},VIDEO:{maxDurationMs:30000,maxTotalDurationMs:30000}}};
  const assets=[{id:'ast_image',kind:'IMAGE',byteSize:11*1048576,width:5000,height:1000,url:'https://private.example/image?signature=secret',name:'private-name'},{id:'ast_video',kind:'VIDEO',durationSeconds:55.519}] as unknown as Asset[];
  const error=caught(()=>validateInputMedia(cap,assets)),context=preflightContext(error);
  expect(error.message).toContain('第 1 项参考图片为 11 MiB');expect(error.message).toContain('第 2 项参考视频为 55.519 秒');expect(error.message).toContain('版本 4');
  expect(context?.issues).toEqual([{field:'media.byteSize',reason:'MAXIMUM_EXCEEDED',inputKind:'IMAGE',inputIndex:0,assetId:'ast_image',actual:11*1048576,maximum:10*1048576},{field:'media.width',reason:'MAXIMUM_EXCEEDED',inputKind:'IMAGE',inputIndex:0,assetId:'ast_image',actual:5000,maximum:4096},{field:'media.durationMs',reason:'MAXIMUM_EXCEEDED',inputKind:'VIDEO',inputIndex:1,assetId:'ast_video',actual:55519,maximum:30000},{field:'media.totalDurationMs',reason:'MAXIMUM_EXCEEDED',inputKind:'VIDEO',actual:55519,maximum:30000}]);
  expect(JSON.stringify(context)).not.toMatch(/private|signature|secret|url|name/);expect(error.message).not.toMatch(/private|signature|secret/);
 });
 it('records missing metadata and invalid model parameters without raw values',()=>{
  const cap=video();cap.parameterSchema['x-input-media-constraints']={schemaVersion:'1',kinds:{VIDEO:{minDurationMs:1000,maxDurationMs:30000}}};
  expect(preflightContext(caught(()=>validateInputMedia(cap,[{id:'ast_video',kind:'VIDEO'} as Asset])))?.issues).toEqual([{field:'media.durationMs',reason:'METADATA_MISSING',inputKind:'VIDEO',inputIndex:0,assetId:'ast_video'}]);
  cap.parameterSchema.required=['outputPreset'];cap.parameterSchema.properties={outputPreset:{enum:['supported']}};
  expect(preflightContext(caught(()=>videoParameters(cap,{outputPreset:'private-user-value'})))?.issues).toEqual([{field:'parameters',reason:'PARAMETER_INVALID',component:'PARAMETERS',parameterPath:['outputPreset'],parameterRule:'enum'}]);
 });
 it('retains requested unavailable historical version and never substitutes the latest',async()=>{
  const cap=model();let error:unknown;
  try{await resolveCapability(async()=>{throw new ApiError(404,'NOT_FOUND','not found');},[cap],'LLM',['TEXT'],{capabilityRef:cap.capabilityRef,capabilityVersion:'2'});}catch(value){error=value;}
  expect(preflightContext(error)).toMatchObject({capabilityRef:'selected-model',capabilityVersion:'2',issues:[{field:'model.kind',reason:'MODEL_VERSION_CHANGED'}]});
 });
 it('bounds and sanitizes attached metadata while preserving the original error identity',()=>{
  const error=preflightError('MODEL_INPUT_UNSUPPORTED','本次输入未通过。');
  const extra={prompt:'private prompt',url:'https://private?signature=secret',field:'inputs.kind',reason:'KIND_UNSUPPORTED',inputKind:'IMAGE',actual:NaN,assetId:'https://private',inputIndex:2};
  expect(withPreflightContext(error,{capabilityRef:'https://private',capabilityVersion:'4',inputKinds:['IMAGE'],issues:Array.from({length:25},()=>extra)} as any)).toBe(error);
  const context=preflightContext(error)!;expect(context.issues).toHaveLength(16);expect(context.issues![0]).toEqual({field:'inputs.kind',reason:'KIND_UNSUPPORTED',inputKind:'IMAGE',inputIndex:2});expect(context.capabilityRef).toBeUndefined();expect(JSON.stringify(context)).not.toMatch(/private|prompt|url|signature/);
 });
});

it('retains only allowlisted consistency stages and affected input components',()=>{
 const error=preflightError('STALE_EXECUTION_INPUT','输入同步中。',model(),{issues:[{field:'inputs.command',reason:'COMMAND_MISMATCH',component:'PARAMETERS',sourceNodeId:'target'},{field:'inputs.snapshot',reason:'INPUT_CHANGED',component:'REFERENCES'}]});
 expect(preflightContext(error)?.issues).toEqual([{field:'inputs.command',reason:'COMMAND_MISMATCH',component:'PARAMETERS',sourceNodeId:'target'},{field:'inputs.snapshot',reason:'INPUT_CHANGED',component:'REFERENCES'}]);
 withPreflightContext(error,{issues:[{field:'inputs.command',reason:'COMMAND_MISMATCH',component:'private prompt' as any}]});
 expect(preflightContext(error)?.issues).toEqual([{field:'inputs.command',reason:'COMMAND_MISMATCH'}]);
});
