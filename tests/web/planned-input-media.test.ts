import {expect,it} from 'vitest';
import {validatePlannedInputMedia,type PlannedInputMedia} from '../../apps/web/src/service/input-media-constraints';
import {preflightContext} from '../../apps/web/src/service/preflight';

const cap:any={capabilityRef:'downstream-model',version:'4',kind:'OMNI_REFERENCE',testMode:false,available:true,parameterSchema:{'x-input-media-constraints':{schemaVersion:'1',kinds:{IMAGE:{maxBytes:1048576,maxWidth:2048,maxHeight:2048,maxPixels:2097152},VIDEO:{maxBytes:1048576,minDurationMs:2000,maxDurationMs:30000},AUDIO:{maxTotalDurationMs:40000}}}}};
const plan=(values:Partial<PlannedInputMedia>={}):PlannedInputMedia=>({sourceNodeId:'upstream',kind:'IMAGE',...values});
function rejection(plans:PlannedInputMedia[]){try{validatePlannedInputMedia(cap,plans);throw Error('accepted incompatible planned output');}catch(error){expect(error).toMatchObject({code:'MEDIA_INPUT_INVALID'});return{error:error as Error,context:preflightContext(error)!};}}

it.each([
 [plan({width:2049}),'media.width',2049,2048],
 [plan({height:2049}),'media.height',2049,2048],
 [plan({width:2048,height:2048}),'media.pixels',4194304,2097152],
 [plan({kind:'VIDEO',durationMs:30001}),'media.durationMs',30001,30000],
])('rejects a known planned limit violation %j',(source,field,actual,maximum)=>{
 const {error,context}=rejection([source]);expect(error.message).toContain('上游计划输出');expect(error.message).toContain('调整上游输出规格');
 expect(context).toMatchObject({capabilityRef:'downstream-model',capabilityVersion:'4',issues:[{field,reason:'MAXIMUM_EXCEEDED',sourceNodeId:'upstream',actual,maximum}]});
 expect(context.issues![0]).not.toHaveProperty('assetId');expect(JSON.stringify(context)).not.toMatch(/"state"|"byteSize"/);
});

it('rejects a known planned duration below the allowed minimum',()=>{
 const {context}=rejection([plan({kind:'VIDEO',durationMs:1999})]);expect(context.issues![0]).toMatchObject({field:'media.durationMs',reason:'MINIMUM_NOT_MET',sourceNodeId:'upstream',inputKind:'VIDEO',actual:1999,minimum:2000});
});

it('allows exact size and duration boundaries with no fabricated byte metadata',()=>{
 expect(()=>validatePlannedInputMedia(cap,[plan({width:2048,height:1024}),plan({kind:'VIDEO',durationMs:2000}),plan({kind:'VIDEO',durationMs:30000})])).not.toThrow();
});

it.each([{}, {width:undefined,height:null}, {kind:'VIDEO',durationMs:0}, {kind:'VIDEO',durationMs:NaN}, {width:Infinity}, {kind:'UNKNOWN',width:99999}])('leaves unknown planned facts unknown: %j',values=>{
 expect(()=>validatePlannedInputMedia(cap,[plan(values as any)])).not.toThrow();
});

it('checks a declared known dimension even when the other dimension remains unknown',()=>{
 const {context}=rejection([plan({width:3000})]);expect(context.issues).toEqual([{field:'media.width',reason:'MAXIMUM_EXCEEDED',inputKind:'IMAGE',sourceNodeId:'upstream',inputIndex:0,actual:3000,maximum:2048}]);
});

it('can reject an aggregate already above the limit even with another unknown output',()=>{
 const {context}=rejection([plan({kind:'AUDIO',sourceNodeId:'voice-a',durationMs:25000}),plan({kind:'AUDIO',sourceNodeId:'voice-b',durationMs:20000}),plan({kind:'AUDIO',sourceNodeId:'voice-c'})]);
 expect(context.issues).toEqual(['voice-a','voice-b'].map(sourceNodeId=>({field:'media.totalDurationMs',reason:'MAXIMUM_EXCEEDED',inputKind:'AUDIO',sourceNodeId,actual:45000,maximum:40000})));
});

it('does not mutate descriptors or infer undeclared provider limits',()=>{
 const descriptors=[plan({width:1024,height:1024})],before=structuredClone(descriptors);validatePlannedInputMedia(cap,descriptors);expect(descriptors).toEqual(before);
 expect(()=>validatePlannedInputMedia({...cap,parameterSchema:{}},[plan({width:999999,height:999999,durationMs:999999})])).not.toThrow();
});
