import {readFileSync} from 'node:fs';
import {expect,it} from 'vitest';
import {capabilityModel} from '../../apps/web/src/service/execution';
import {selectCapability} from '../../apps/web/src/service/model-catalog';
import {routerParameters} from '../../apps/web/src/service/native-parameters';
import {videoParameters} from '../../apps/web/src/service/video-input';
import {videoSubjectSelection} from '../../apps/web/src/service/video-subject-controls';
import {videoModelInputAvailability} from '../../apps/web/src/service/video-model-input-availability';
import {projectModelGroups,replaceModelCatalogView,clearModelCatalogView} from '../../apps/web/src/service/model-catalog-view';

const rows:any[]=JSON.parse(readFileSync(new URL('./fixtures/canvas-catalog-audit-20261104.json',import.meta.url),'utf8'));
const models=rows.filter(c=>c.model&&!c.testMode);
function* table(fields:[string,any[]][],index=0):Generator<Record<string,any>>{
 if(index===fields.length){yield {};return;}
 const [name,values]=fields[index];for(const rest of table(fields,index+1))for(const value of values)yield {...rest,[name]:value};
}
// Ordered arrays are significant to the API even when two permutations mean
// the same pairing to the operator. Each subject can appear once per side.
function* pairs(path:{referenceSubjectIndex:number;sourceSubjectIndex:number}[]=[],usedImage=0,usedVideo=0):Generator<typeof path>{
 if(path.length)yield path;
 for(let i=0;i<5;i++)if(!(usedImage&(1<<i)))for(let j=0;j<5;j++)if(!(usedVideo&(1<<j)))yield* pairs([...path,{referenceSubjectIndex:i,sourceSubjectIndex:j}],usedImage|1<<i,usedVideo|1<<j);
}
it('enumerates every current model and finite parameter tuple; unavailable video profiles remain disabled without a key',()=>{
 let scalarTuples=0,enabled=0,authorized=0;
 for(const cap of models){
  const display=capabilityModel(cap);expect(display.disabled,cap.capabilityRef).toBe(!cap.available);
  if(!cap.available)expect(()=>selectCapability(rows,cap.kind,[],{capabilityRef:cap.capabilityRef,capabilityVersion:cap.version},{allowTestMode:false})).toThrowError(expect.objectContaining({code:'MODEL_UNAVAILABLE'}));
  const fields=Object.entries(cap.parameterSchema.properties??{}) as [string,any][];
  const options=fields.map(([key,schema]):[string,any[]]=>{
   const field=display.config.find(f=>f.paramName===(key==='reasoningEffort'?'reasoning_effort':key));
   const values=key==='count'?display.generateNum:key==='subjectMapping'?[field?.paramValue]:field?.optionValue?.map((v:any)=>v.value);
   const expected=schema.enum??(schema.type==='boolean'?[true,false]:key==='subjectMapping'?[schema.default]:undefined);
   expect(values,cap.capabilityRef+'/'+key).toEqual(expected);expect(values?.length).toBeGreaterThan(0);return[key,values];
  });
  let count=0;for(const params of table(options)){
   const ui={params:{...params},generateNum:params.count};
   if('reasoningEffort' in params){ui.params.reasoning_effort=params.reasoningEffort;delete ui.params.reasoningEffort;}
   if('count' in params)delete ui.params.count;
   const projected=routerParameters(cap,ui);expect(projected,cap.capabilityRef).toEqual(params);
   if(cap.outputKinds.includes('VIDEO'))expect(videoParameters(cap,projected)).toEqual(params);
   count++;
  }
  scalarTuples+=count;const total=count*(fields.some(([k])=>k==='subjectMapping')?32825:1);
  if(cap.available)enabled+=total;else authorized+=total;
 }
 expect([rows.length,models.length,scalarTuples,enabled,authorized]).toEqual([84,62,3534,788250,3060]);
});

it.each(models.filter(c=>c.parameterSchema.properties?.subjectMapping))('enumerates all one-to-one ordered subject mappings across 1–5 pairs for $capabilityRef',cap=>{
 const field=capabilityModel(cap).config.find(f=>f.paramName==='subjectMapping')!;
 // The selected output preset is an independent enum, not a constraint on a
 // mapping. The previous test separately checks every preset for each model.
 let n=0;for(const mapping of pairs()){
  const selection=videoSubjectSelection(field,mapping);if(!selection||JSON.stringify(selection)!==JSON.stringify(mapping))throw Error('Subject control rejected or changed valid mapping');
  const result=videoParameters(cap,{subjectMapping:selection});if(JSON.stringify(result.subjectMapping)!==JSON.stringify(mapping))throw Error('Parameter projection changed subject order');n++;
 }
 expect(n).toBe(32825);
 for(const invalid of [[],[{referenceSubjectIndex:5,sourceSubjectIndex:0}],[{referenceSubjectIndex:0,sourceSubjectIndex:1},{referenceSubjectIndex:0,sourceSubjectIndex:2}]]){
  expect(videoSubjectSelection(field,invalid)).toBeUndefined();expect(()=>videoParameters(cap,{subjectMapping:invalid})).toThrow();
 }
},30000);

it('greys a video model if its own reference count is exceeded, survives credential refresh, and re-enables on disconnect',()=>{
 const profile=(ref:string)=>capabilityModel(models.find(c=>c.capabilityRef===ref));
 const small=profile('h3-first-frame-v1'),large=profile('h3-first-last-frame-v1'),group=(m:any)=>({nodeModelList:[{modelList:[m]}]});
 const target={id:'t',type:'rh-video',data:{}},nodes=[target,...['a','b'].map(id=>({id,type:'rh-image',data:{sourceObjects:['rhtv-asset:'+id]}}))];
 const input={nodes,edges:['a','b'].map(source=>({source,target:'t'})),videoModelGroups:[{modelGroupList:[group(small),group(large)]}]};
 const list=(groups:any[])=>groups[0].modelGroupList.map((g:any)=>g.nodeModelList[0].modelList[0]);
 const projected=videoModelInputAvailability(input,target);
 try{
  expect(list(projected.videoModelGroups).map((m:any)=>m.disabled)).toEqual([true,false]);expect(list(projected.videoModelGroups)[0].reason).toContain('当前有 2 项');
  replaceModelCatalogView([group(small),group(large)]);expect(list(projectModelGroups(projected.videoModelGroups))[0].disabled).toBe(true);
  expect(list(videoModelInputAvailability({...input,edges:input.edges.slice(1)},target).videoModelGroups).map((m:any)=>m.disabled)).toEqual([false,false]);
 }finally{clearModelCatalogView();}
});

import {validateInputMedia,validatePlannedInputMedia} from '../../apps/web/src/service/input-media-constraints';
it('enforces the legacy official provider body builder limits before queueing, including aspect, byte inflation and per-kind duration totals',()=>{
 const cap=models.find(c=>c.capabilityRef==='h3-official-omni-reference-v1'),seed=models.find(c=>c.capabilityRef==='seedance-2-5-official-omni-reference-v1');
 const asset=(kind:string,patch:any={})=>({id:'asset',kind,mimeType:{IMAGE:'image/jpeg',VIDEO:'video/mp4',AUDIO:'audio/wav'}[kind],width:640,height:360,byteSize:2000,durationSeconds:6,...patch}) as any;
 expect(()=>validateInputMedia(cap,[asset('IMAGE',{width:320,height:800}),asset('AUDIO')])).not.toThrow();
 for(const a of [asset('IMAGE',{width:255,height:300}),asset('IMAGE',{width:640,height:1600+1}),asset('IMAGE',{byteSize:10*1048576+1}),asset('VIDEO',{width:296}),asset('VIDEO',{durationSeconds:15.001}),asset('AUDIO',{mimeType:'audio/flac'})])expect(()=>validateInputMedia(cap,[a])).toThrow();
 expect(()=>validateInputMedia(seed,[asset('VIDEO',{durationSeconds:3.999})])).toThrow();
 expect(()=>validateInputMedia(seed,[asset('VIDEO',{durationSeconds:4})])).not.toThrow();
 expect(()=>validateInputMedia(cap,[asset('AUDIO',{durationSeconds:9}),asset('AUDIO',{durationSeconds:7})])).toThrow();
 expect(()=>validateInputMedia(cap,[asset('VIDEO',{byteSize:48*1048576})])).toThrow();
 expect(()=>validateInputMedia(seed,[asset('VIDEO',{byteSize:48*1048576})])).not.toThrow();
 expect(()=>validatePlannedInputMedia(cap,[{sourceNodeId:'i',kind:'IMAGE',width:640,height:1601}])).toThrow();
});

it('rejects assets outside the Codex native image budget or accepted formats',()=>{
 const cap=models.find(c=>c.capabilityRef==='codex-image-edit-v1'),mb=1048576;
 const asset=(id:string,size:number,mimeType='image/png')=>({id,kind:'IMAGE',byteSize:size,mimeType} as any);
 expect(()=>validateInputMedia(cap,[asset('a',10*mb),asset('b',6*mb)])).not.toThrow();
 expect(()=>validateInputMedia(cap,[asset('a',10*mb),asset('b',6*mb+1)])).toThrow(/合计/);
 expect(()=>validateInputMedia(cap,[asset('a',10*mb+1)])).toThrow(/10 MiB/);
 expect(()=>validateInputMedia(cap,[asset('a',100,'image/gif')])).toThrow(/文件格式/);
});
