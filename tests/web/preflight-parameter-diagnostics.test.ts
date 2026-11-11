import {readFileSync} from 'node:fs';
import {expect,it} from 'vitest';
import {validateCapabilityParameters} from '../../apps/web/src/service/schema-parameters';
import {preflightContext,preflightError,preflightParameterNames,preflightParameterRules,withPreflightContext} from '../../apps/web/src/service/preflight';
import {routerParameters} from '../../apps/web/src/service/native-parameters';
import {videoParameters} from '../../apps/web/src/service/video-input';

const cap=(schema:any):any=>({capabilityRef:'synthetic-parameters',version:'3',kind:'IMAGE_TO_IMAGE',testMode:false,available:true,parameterSchema:schema});
function rejected(schema:any,value:any){try{validateCapabilityParameters(cap(schema),value);throw Error('accepted invalid parameters');}catch(error){expect(error).toMatchObject({code:'MODEL_PARAMETER_INVALID'});return preflightContext(error)!;}}

it('records exact declared nested parameter paths and schema rule without values',()=>{
 const context=rejected({type:'object',properties:{subjectMapping:{type:'array',items:{type:'object',properties:{referenceSubjectIndex:{type:'integer',minimum:0}}}}}},{subjectMapping:[{referenceSubjectIndex:0},{referenceSubjectIndex:-1}]});
 expect(context).toMatchObject({capabilityRef:'synthetic-parameters',capabilityVersion:'3',issues:[{field:'parameters',component:'PARAMETERS',parameterPath:['subjectMapping',1,'referenceSubjectIndex'],parameterRule:'minimum'}]});
 expect(JSON.stringify(context)).not.toContain('"actual"');
});

it('records missing required names through local refs and oneOf schema branches',()=>{
 const schema={$defs:{voice:{type:'object',required:['voiceId'],properties:{voiceId:{type:'string'}}}},type:'object',properties:{style:{$ref:'#/$defs/voice'}}};
 expect(rejected(schema,{style:{}}).issues![0]).toMatchObject({parameterPath:['style','voiceId'],parameterRule:'required'});
 expect(rejected({oneOf:[{type:'object',properties:{seed:{type:'integer'}}},{type:'string'}]},{seed:'PRIVATE_VALUE'}).issues![0]).toMatchObject({parameterRule:'oneOf'});
});

it('drops unknown additional object keys while retaining the declared parent identity',()=>{
 const context=rejected({type:'object',properties:{subjectMapping:{type:'array',items:{type:'object',additionalProperties:false,properties:{seed:{type:'integer'}}}}}},{subjectMapping:[{seed:1,PRIVATE_UNKNOWN_KEY:'PRIVATE_VALUE'}]});
 expect(context.issues![0]).toMatchObject({parameterPath:['subjectMapping',0],parameterRule:'additionalProperties'});
 expect(JSON.stringify(context)).not.toMatch(/PRIVATE_UNKNOWN_KEY|PRIVATE_VALUE/);
 const root=rejected({type:'object',additionalProperties:false},{PRIVATE_UNKNOWN_KEY:'PRIVATE_VALUE'});
 expect(root.issues![0]).not.toHaveProperty('parameterPath');expect(root.issues![0].parameterRule).toBe('additionalProperties');
});

it('never accepts a field name merely because it appears in a rejected value',()=>{
 const context=rejected({type:'object',additionalProperties:false,properties:{voice:{type:'string'}}},{seed:'PRIVATE_VALUE'});
 expect(context.issues![0]).not.toHaveProperty('parameterPath');expect(JSON.stringify(context)).not.toContain('PRIVATE_VALUE');
 const future=rejected({type:'object',properties:{newUnreviewedField:{type:'integer'}}},{newUnreviewedField:'PRIVATE_VALUE'});
 expect(future.issues![0]).not.toHaveProperty('parameterPath');expect(future.issues![0].parameterRule).toBe('type');
});

it.each([['PRIVATE_NAME'],['https://private.invalid'],['subjectMapping',-1],['subjectMapping',10000],['subjectMapping',0.5],['subjectMapping',{}],Array.from({length:13},()=> 'seed')])('sanitizes unsafe parameter paths: %j',path=>{
 const error=preflightError('MODEL_PARAMETER_INVALID','invalid');withPreflightContext(error,{issues:[{field:'parameters',reason:'PARAMETER_INVALID',parameterPath:path as any,parameterRule:'enum'}]});
 expect(preflightContext(error)?.issues![0]).toEqual({field:'parameters',reason:'PARAMETER_INVALID',parameterRule:'enum'});
});

it('does not permit arbitrary rule text or parameter metadata on unrelated diagnostics',()=>{
 const error=preflightError('MODEL_PARAMETER_INVALID','invalid');withPreflightContext(error,{issues:[{field:'parameters',reason:'PARAMETER_INVALID',parameterPath:['seed'],parameterRule:'PRIVATE_VALUE' as any},{field:'references.kind',reason:'KIND_UNSUPPORTED',parameterPath:['seed'],parameterRule:'enum'}]});
 expect(preflightContext(error)?.issues).toEqual([{field:'parameters',reason:'PARAMETER_INVALID',parameterPath:['seed']},{field:'references.kind',reason:'KIND_UNSUPPORTED'}]);
});

it('keeps machine contract token/rule sets identical to the browser sanitizer',()=>{
 const contract=JSON.parse(readFileSync(new URL('../../contracts/generation-diagnostics-extension.schema.json',import.meta.url),'utf8')),$=contract.$defs.preflightIssue.properties;
 expect($.parameterPath.items.oneOf[0].enum).toEqual([...preflightParameterNames]);expect($.parameterRule.enum).toEqual([...preflightParameterRules]);
});

it.each([
 ['count',{count:{type:'integer',enum:[1,2]}},{generateNum:4},{}],
 ['reasoningEffort',{reasoningEffort:{type:'string',enum:['low','high']}},{params:{reasoning_effort:'PRIVATE_VALUE'}},{}],
 ['outputPreset',{outputPreset:{type:'string',enum:['square']}},{params:{outputPreset:'PRIVATE_VALUE'}},{capabilityRef:'moss-image-generate-v1',version:'1',kind:'TEXT_TO_IMAGE',model:{providerRef:'comfy',modelRef:'moss-image'}}],
])('preserves exact parameter identity for the existing early %s check',(name,properties,data,overrides)=>{
 try{routerParameters({...cap({type:'object',properties}),...overrides},data);throw Error('accepted');}catch(error){expect(preflightContext(error)?.issues![0]).toMatchObject({parameterPath:[name],parameterRule:'enum'});expect(JSON.stringify(preflightContext(error))).not.toContain('PRIVATE_VALUE');}
});

it('identifies the exact repeated subject index without recording its value',()=>{
 const item={type:'object',required:['referenceSubjectIndex','sourceSubjectIndex'],properties:{referenceSubjectIndex:{type:'integer'},sourceSubjectIndex:{type:'integer'}}};
 const schema={type:'object','x-video-mode':'MOTION_TRANSFER','x-video-parameter-metadata':{schemaVersion:'1'},properties:{subjectMapping:{type:'array',items:item}}};
 const selected={...cap(schema),model:{providerRef:'fixture',modelRef:'fixture'},outputKinds:['VIDEO']};
 try{videoParameters(selected,{subjectMapping:[{referenceSubjectIndex:40,sourceSubjectIndex:20},{referenceSubjectIndex:40,sourceSubjectIndex:21}]});throw Error('accepted');}catch(error){expect(preflightContext(error)?.issues![0]).toMatchObject({parameterPath:['subjectMapping',1,'referenceSubjectIndex'],parameterRule:'uniqueItems'});expect(JSON.stringify(preflightContext(error))).not.toContain('40');}
});
