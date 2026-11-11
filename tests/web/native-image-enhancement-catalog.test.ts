// @vitest-environment happy-dom
import {expect,it,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {URL as FileURL} from 'node:url';
import {ExecutionAdapter} from '../../apps/web/src/service/execution';
import {ProductClient} from '../../apps/web/src/service/product-client';
import {ServiceStorage} from '../../apps/web/src/service/storage';
import {canvasToolUnavailable} from '../../apps/web/src/service/canvas-tool-availability';

const compiled=readFileSync(new FileURL('../../apps/web/public/project/assets/index-DeyN_Phq.js',import.meta.url),'utf8');
const primaryTypes=JSON.parse(compiled.match(/const kW=(\[[^\]]+\])/ )![1]);
// Execute the pinned primary catalog's actual row-to-native-key mapper. This
// was the missing bridge between Router's available model and toolbar props.
const start=compiled.indexOf('let OM=null,tN=null;async function Lgt()'),end=compiled.indexOf('async function rF()',start);
function nativeModels(rows:any[]){const read=new Function('Um','kW','Pgt','z9n',compiled.slice(start,end)+';return Lgt();');return read(async()=>rows,primaryTypes,(values:any[])=>values,{}) as Promise<Record<string,any[]>>;}
const seed=(overrides:any={})=>({capabilityRef:'seedvr2-image-enhance-v1',version:'1',kind:'IMAGE_ENHANCE',title:'SeedVR2 3B FP8 · 2×',available:true,testMode:false,model:{providerRef:'comfy',modelRef:'seedvr2-3b',title:'SeedVR2 3B FP8',version:'1'},inputKinds:['TEXT','STRUCTURED','IMAGE'],outputKinds:['IMAGE'],parameterSchemaVersion:'1',parameterSchema:{'x-prompt-policy':'ignored',properties:{outputPreset:{type:'string',enum:['2x'],default:'2x'}}},...overrides});
function adapter(caps:any[]){const api=new ProductClient('/api/v1',vi.fn(async()=>new Response(JSON.stringify({code:0,data:{items:caps,nextCursor:null}}))));api.setAccessToken('fixture-owner');return new ExecutionAdapter(api,new ServiceStorage(api,vi.fn()),async()=>{},vi.fn(),{allowTestMode:false});}
function item(label:string){const popup=document.createElement('div');popup.className='rh-image-toolbar-popup--quality';const button=document.createElement('button');button.setAttribute('role','menuitem');button.textContent=label;popup.append(button);return button;}

it('adds real enhancement tool kinds to the native primary toolbar context and unlocks only those actual actions',async()=>{
 expect(primaryTypes).not.toContain('IMAGE_GIGAPIXEL');expect(primaryTypes).not.toContain('IMAGE_HD');
 const execution=adapter([seed()]),rows=await execution.handle('/canvas/model/list',{types:primaryTypes}),models=await nativeModels(rows),node={id:'image',type:'rh-image',data:{imageUrl:'rhtv-asset:owned'}},toolbarContext={canvasId:'project',canvasName:'test',nodes:[node],models,getGraphSnapshot:()=>({nodes:[node],edges:[]})};
 for(const key of ['image-gigapixel','image-hd']){
  expect(models[key]).toHaveLength(1);expect(models[key][0]).toMatchObject({kind:'IMAGE_ENHANCE',modelCode:'seedvr2-image-enhance-v1',available:true,testMode:false});
  expect(models[key][0].config.some((field:any)=>field.paramName==='prompt')).toBe(false);
 }
 for(const label of ['放大','高清'])expect(canvasToolUnavailable(item(label),()=>[{node,toolbarContext}])).toBeNull();
 const groups=await execution.handle('/canvas/model/group/list',{}),enhancement=groups.find((group:any)=>group.modelGroupId==='IMAGE_ENHANCE');expect(enhancement.nodeTypeList).toEqual(expect.arrayContaining(['IMAGE_GIGAPIXEL','IMAGE_HD']));
});

it.each([{available:false},{testMode:true}])('does not advertise or enable image quality tools from an unusable capability %j',async override=>{
 const rows=await adapter([seed(override)]).handle('/canvas/model/list',{types:primaryTypes}),models=await nativeModels(rows),node={type:'rh-image',data:{}};
 expect(models['image-gigapixel']).toBeUndefined();expect(models['image-hd']).toBeUndefined();
 for(const label of ['放大','高清'])expect(canvasToolUnavailable(item(label),()=>[{node,toolbarContext:{models}}])).toContain('尚未接入');
});

it('does not change narrow selector requests or duplicate explicitly requested enhancement types',async()=>{
 const execution=adapter([seed()]);expect((await execution.handle('/canvas/model/list',{types:['TEXT_IMAGE']})).map((row:any)=>row.type)).toEqual(['TEXT_IMAGE']);
 const rows=await execution.handle('/canvas/model/list',{types:[...primaryTypes,'IMAGE_GIGAPIXEL','IMAGE_HD']});for(const type of ['IMAGE_GIGAPIXEL','IMAGE_HD'])expect(rows.filter((row:any)=>row.type===type)).toHaveLength(1);
});
