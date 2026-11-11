import {preflightError} from './preflight';
import type {Capability} from './model-catalog';
import {validateCapabilityParameters} from './schema-parameters';

/** Native node fields remain native; only advertised Router parameters cross the API. */
export function routerParameters(cap:Capability,data:any):Record<string,any>{
 const result:Record<string,any>={},tool=String(data.toolsType||'').toUpperCase().replaceAll('-','_');
 const defined=(...values:any[])=>values.find(value=>value!==undefined);
 if(['IMAGE_REDRAW','IMAGE_ERASE','IMAGE_EXPAND','IMAGE_CUTOUT'].includes(tool)&&(cap.capabilityRef!=='codex-image-edit-v1'||cap.version!=='3'))throw preflightError('MODEL_INPUT_UNSUPPORTED','此图片工具需要支持多图参考及透明输出的当前图片模型，请选择 Codex 图片编辑版本 3。',cap,{issues:[{field:'model.kind',reason:'KIND_MISMATCH'}]});
 for(const [key,field] of Object.entries(cap.parameterSchema?.properties||{}) as [string,any][]){
  // A visible native edit must win over the previous run's frozen projection.
  const edited=key==='reasoningEffort'&&Object.hasOwn(data.params||{},'reasoning_effort'),countEdit=key==='count'&&Object.hasOwn(data,'generateNum');
  const mossSizeEdit=key==='outputPreset'&&cap.capabilityRef==='moss-image-generate-v1'&&cap.version==='1'&&cap.kind==='TEXT_TO_IMAGE'&&cap.model?.providerRef==='comfy'&&cap.model.modelRef==='moss-image'&&Object.hasOwn(data.params||{},key);
  const value=key==='transparentBackground'&&tool==='IMAGE_CUTOUT'?true:edited?data.params.reasoning_effort:countEdit?data.generateNum:Object.hasOwn(data.params||{},key)?data.params[key]:defined(data.routerParameters?.[key],field.default);
  if(mossSizeEdit&&(typeof value!=='string'||!Array.isArray(field.enum)||!field.enum.includes(value)))throw preflightError('MODEL_PARAMETER_INVALID','请选择 MOSS-Image 支持的输出尺寸。',cap,{issues:[{field:'parameters',reason:'PARAMETER_INVALID',component:'PARAMETERS',parameterPath:['outputPreset'],parameterRule:typeof value==='string'?'enum':'type'}]});
  if(key==='reasoningEffort'&&value!==undefined&&(typeof value!=='string'||!Array.isArray(field.enum)||!field.enum.includes(value)))throw preflightError('MODEL_PARAMETER_INVALID','请选择模型支持的推理强度。',cap,{issues:[{field:'parameters',reason:'PARAMETER_INVALID',component:'PARAMETERS',parameterPath:['reasoningEffort'],parameterRule:typeof value==='string'?'enum':'type'}]});
  if(key==='count'&&value!==undefined&&Array.isArray(field.enum)&&(!field.enum.includes(value)||field.type==='integer'&&!Number.isSafeInteger(value)))throw preflightError('MODEL_PARAMETER_INVALID','请选择模型支持的生成数量。',cap,{issues:[{field:'parameters',reason:'PARAMETER_INVALID',component:'PARAMETERS',parameterPath:['count'],parameterRule:field.type==='integer'&&!Number.isSafeInteger(value)?'type':'enum'}]});
  if(value!==undefined)result[key]=value;
 }
 validateCapabilityParameters(cap,result);return result;
}
