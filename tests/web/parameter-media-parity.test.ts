import {readFileSync} from 'node:fs';
import {expect,it} from 'vitest';
import {parameterSchemaFailure,validateCapabilityParameters} from '../../apps/web/src/service/schema-parameters';
import {routerParameters} from '../../apps/web/src/service/native-parameters';
import {videoParameters} from '../../apps/web/src/service/video-input';
import {validateInputMedia} from '../../apps/web/src/service/input-media-constraints';
import {preflightContext} from '../../apps/web/src/service/preflight';

const cap=(schema:any):any=>({capabilityRef:'synthetic-image',version:'1',parameterSchemaVersion:'1',kind:'IMAGE_TO_IMAGE',available:true,testMode:false,model:{providerRef:'fixture',modelRef:'fixture',version:'1'},parameterSchema:schema});
const invalid=[
 ['enum also enforces numeric type',{type:'integer',enum:[1,'2']},'2','type'],
 ['enum also enforces numeric maximum',{type:'integer',enum:[1,20],maximum:10},20,'maximum'],
 ['boolean is not a string',{type:'boolean'},'false','type'],
 ['required nested key',{type:'object',required:['seed'],properties:{seed:{type:'integer'}}},{},'required'],
 ['extra nested keys',{type:'object',additionalProperties:false,properties:{seed:{type:'integer'}}},{seed:1,unknown:true},'additionalProperties'],
 ['exclusive numeric bound',{type:'number',exclusiveMaximum:1},1,'maximum'],
 ['numeric step',{type:'number',multipleOf:0.1},0.25,'multipleOf'],
 ['large numeric fractional step',{type:'number',multipleOf:1},1000000000000000.5,'multipleOf'],
 ['minimum string length',{type:'string',minLength:2},'😀','minLength'],
 ['pattern',{type:'string',pattern:'^[a-z]+$'},'UPPER','pattern'],
 ['array minimum',{type:'array',minItems:1},[],'minItems'],
 ['array maximum',{type:'array',maxItems:1},[1,2],'maxItems'],
 ['array item type',{type:'array',items:{type:'integer'}},[1,'2'],'type'],
 ['structural duplicate array values',{type:'array',uniqueItems:true},[{a:1,b:2},{b:2,a:1}],'uniqueItems'],
 ['allOf conjunction',{allOf:[{type:'number'},{minimum:4}]},3,'minimum'],
 ['anyOf union',{anyOf:[{type:'string'},{type:'boolean'}]},42,'anyOf'],
 ['oneOf rejects overlapping branches',{oneOf:[{type:'number'},{minimum:0}]},1,'oneOf'],
 ['not',{not:{type:'string'}},'no','not'],
 ['conditional then',{type:'object',if:{properties:{mode:{const:'fixed'}},required:['mode']},then:{required:['seed']}},{mode:'fixed'},'required'],
 ['dependent required',{type:'object',dependentRequired:{seed:['mode']}},{seed:1},'required'],
 ['dependent schemas remain conjunctive',{type:'object',dependentRequired:{seed:['mode']},dependentSchemas:{seed:{required:['other']}}},{seed:1,other:2},'required'],
 ['contains',{type:'array',contains:{type:'integer'},minContains:2},[1,'a'],'contains'],
 ['local reference',{$defs:{value:{type:'integer',minimum:1}},$ref:'#/$defs/value'},0,'minimum'],
] as const;
it.each(invalid)('checks %s without letting enum or another assertion short circuit',(_name,schema,value,rule)=>{expect(parameterSchemaFailure(schema,value)?.rule).toBe(rule);});

it('validates conjunctive nested parameters after native UI projection without coercion',()=>{
 const selected=cap({type:'object',additionalProperties:false,required:['outputPreset'],properties:{outputPreset:{type:'string',enum:['square']},enabled:{type:'boolean',default:false}}});
 expect(routerParameters(selected,{params:{outputPreset:'square',rhModel:'retained UI selection',prompt:'private authored text'},nodeOutputHistory:[]})).toEqual({outputPreset:'square',enabled:false});
 expect(()=>routerParameters(selected,{params:{outputPreset:'bad'}})).toThrowError(expect.objectContaining({code:'MODEL_PARAMETER_INVALID'}));
 expect(()=>routerParameters(selected,{params:{outputPreset:'square',enabled:null}})).toThrowError(expect.objectContaining({code:'MODEL_PARAMETER_INVALID'}));
 expect(()=>routerParameters(selected,{params:{}})).toThrowError(expect.objectContaining({code:'MODEL_PARAMETER_INVALID'}));
});

it.each([
 ['ordinary image outputPreset','IMAGE_TO_IMAGE','outputPreset',{type:'string',enum:['square','wide'],default:'square'},'square','wide','unsupported'],
 ['ordinary text numeric parameter','LLM','temperature',{type:'number',minimum:0,maximum:2,default:1},0.5,1.5,20],
])('uses the visible %s edit ahead of the previous run receipt',(_name,kind,key,field,oldValue,newValue,invalidValue)=>{
 const selected={...cap({type:'object',properties:{[key]:field}}),kind},frozen={routerParameters:{[key]:oldValue}};
 expect(routerParameters(selected,{...frozen,params:{[key]:newValue}})).toEqual({[key]:newValue});
 expect(()=>routerParameters(selected,{...frozen,params:{[key]:invalidValue}})).toThrowError(expect.objectContaining({code:'MODEL_PARAMETER_INVALID'}));
 expect(()=>routerParameters(selected,{...frozen,params:{[key]:null}})).toThrowError(expect.objectContaining({code:'MODEL_PARAMETER_INVALID'}));
 expect(routerParameters(selected,frozen)).toEqual({[key]:oldValue});
 expect(routerParameters(selected,{})).toEqual({[key]:field.default});
});

it('retains all video enum constraints and explicit null instead of substituting a default',()=>{
 const selected=cap({type:'object','x-video-mode':'TEXT_TO_VIDEO','x-video-parameter-metadata':{schemaVersion:'1'},properties:{steps:{type:'integer',enum:[4,20],maximum:10,default:4}}});selected.kind='TEXT_TO_VIDEO';selected.outputKinds=['VIDEO'];
 expect(videoParameters(selected,{})).toEqual({steps:4});
 for(const steps of [20,null])expect(()=>videoParameters(selected,{steps})).toThrowError(expect.objectContaining({code:'MODEL_PARAMETER_INVALID'}));
});

it('does not put parameter values into safe preflight diagnostics',()=>{
 const selected=cap({type:'object',properties:{voice:{type:'string',enum:['valid']}}});
 try{validateCapabilityParameters(selected,{voice:'PRIVATE_INVALID_VOICE'});throw Error('accepted');}catch(error){expect(error).toMatchObject({code:'MODEL_PARAMETER_INVALID'});expect(JSON.stringify(preflightContext(error))).not.toContain('PRIVATE_INVALID_VOICE');expect(preflightContext(error)).toMatchObject({capabilityRef:'synthetic-image',capabilityVersion:'1',issues:[{field:'parameters',component:'PARAMETERS'}]});}
});

it.each([{format:'email'},{$ref:'https://unknown.invalid/schema'},{unevaluatedProperties:false}])('rejects unsupported schema assertions explicitly: %j',schema=>{expect(parameterSchemaFailure(schema,{})).toMatchObject({schemaError:true});});

it('uses Unicode code point lengths, JSON structural enum equality and decimal steps',()=>{
 expect(parameterSchemaFailure({type:'string',minLength:1,maxLength:1},'😀')).toBeNull();
 expect(parameterSchemaFailure({enum:[{a:1,b:2}]},{b:2,a:1})).toBeNull();
 expect(parameterSchemaFailure({type:'number',multipleOf:0.1},0.3)).toBeNull();
});

for(const file of ['router-h3-capabilities.json','router-official-video-capabilities.json','router-motion-capabilities.json','router-motion-source-capabilities.json','router-moss-image-capability.json']){
 const parsed=JSON.parse(readFileSync(new URL('./fixtures/'+file,import.meta.url),'utf8')),rows=Array.isArray(parsed)?parsed:parsed.items??[parsed];
 it.each(rows)('accepts the real catalog defaults from '+file+' for $capabilityRef',(selected:any)=>{expect(()=>routerParameters(selected,{})).not.toThrow();});
}

const mediaCap=cap({type:'object','x-input-media-constraints':{schemaVersion:'1',kinds:{IMAGE:{maxBytes:10*1048576,maxWidth:4096,maxHeight:4096,maxPixels:4096*4096},VIDEO:{minDurationMs:1000,maxDurationMs:30000},AUDIO:{maxBytes:1048576,minDurationMs:100,maxDurationMs:30000,maxTotalDurationMs:40000}}}});
const asset=(values:any):any=>({id:'asset',kind:'IMAGE',byteSize:1024,width:1024,height:1024,state:'READY',...values});
it.each([
 [{byteSize:undefined},'media.byteSize'],[{byteSize:0},'media.byteSize'],[{width:undefined},'media.width'],[{height:0},'media.height'],[{kind:'VIDEO',durationSeconds:null},'media.durationMs'],
])('rejects missing trusted asset metadata %j',(values,field)=>{
 try{validateInputMedia(mediaCap,[asset({id:'good'}),asset({...values,id:'bad'})]);throw Error('accepted');}catch(error){expect(error).toMatchObject({code:'MEDIA_INPUT_INVALID'});expect(preflightContext(error)?.issues).toContainEqual(expect.objectContaining({field,reason:'METADATA_MISSING',inputIndex:1,assetId:'bad'}));}
});
it('accepts exact image and video limits and rejects a byte or millisecond over',()=>{
 expect(()=>validateInputMedia(mediaCap,[asset({byteSize:10*1048576,width:4096,height:4096}),asset({kind:'VIDEO',durationSeconds:30})])).not.toThrow();
 for(const bad of [asset({byteSize:10*1048576+1}),asset({kind:'VIDEO',durationSeconds:30.001})])expect(()=>validateInputMedia(mediaCap,[bad])).toThrowError(expect.objectContaining({code:'MEDIA_INPUT_INVALID'}));
});
it('checks aggregate audio duration after per-input metadata validation',()=>{
 expect(()=>validateInputMedia(mediaCap,[asset({kind:'AUDIO',durationSeconds:25}),asset({kind:'AUDIO',durationSeconds:20})])).toThrowError(expect.objectContaining({code:'MEDIA_INPUT_INVALID'}));
});
