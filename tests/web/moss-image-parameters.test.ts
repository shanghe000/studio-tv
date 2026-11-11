import {afterEach,expect,it,vi} from 'vitest';
import raw from './fixtures/router-moss-image-capability.json';
import {capabilityModel,ExecutionAdapter} from '../../apps/web/src/service/execution';
import {routerParameters} from '../../apps/web/src/service/native-parameters';
import {modelSelections,type Capability} from '../../apps/web/src/service/model-catalog';
import {ProductClient} from '../../apps/web/src/service/product-client';
import {ServiceStorage} from '../../apps/web/src/service/storage';

// Mirrors the installed Router manifest's Catalog projection, from
// studio-model-router/internal/adapters/h3/testdata/moss-image-profile.json.
const cap=raw as Capability;
const presets=['1024-square','landscape-1344x768','portrait-768x1344','standard-1152x864','standard-portrait-864x1152','ultrawide-1536x656'];
afterEach(()=>modelSelections.clear());
function fixture(){
 const transport=vi.fn(async(path:string,_options?:any)=>{
  const data=path.includes('/model-capabilities?')?{items:[cap],nextCursor:null}:path==='/api/v2/canvas-runs'?{id:'fixture-task',state:'SUCCEEDED',plans:[],testMode:false}:path==='/api/v1/assets/reference'?{id:'reference',kind:'IMAGE',state:'READY'}:undefined;
  if(!data)throw new Error('Unexpected MOSS fixture request: '+path);
  return new Response(JSON.stringify({code:0,data}),{status:path==='/api/v2/canvas-runs'?202:200});
 });
 const api=new ProductClient('/api/v1',transport);api.setAccessToken('fixture-only');
 const adapter=new ExecutionAdapter(api,new ServiceStorage(api,vi.fn()),vi.fn().mockResolvedValue(undefined),vi.fn(),{allowTestMode:false});
 return{adapter,transport};
}
it('projects required prompt, one image output, no reference media and all six frozen sizes',()=>{
 const model=capabilityModel(cap),prompt=model.config.find(field=>field.paramName==='prompt')!,output=model.config.find(field=>field.paramName==='outputPreset')!;
 expect(prompt).toMatchObject({type:'prompt',required:true});expect(model.generateNum).toEqual([1]);expect(model.inputKinds).toEqual(['TEXT','STRUCTURED']);expect(model.outputKinds).toEqual(['IMAGE']);
 expect(model.config.some(field=>['imageUrls','imageUrl','videoUrls','videoUrl','audioUrls','audioUrl'].includes(field.type))).toBe(false);
 expect(output.optionValue!.map((row:any)=>row.value)).toEqual(presets);
});
it.each(presets)('sends the current MOSS %s native choice ahead of an old frozen default without mutating the node',async preset=>{
 const f=fixture(),data={modelCode:cap.capabilityRef,capabilityRef:cap.capabilityRef,capabilityVersion:'1',parameterSchemaVersion:'1',params:{prompt:'A porcelain teapot on a wooden table',outputPreset:preset},routerParameters:{outputPreset:'1024-square'},generateNum:1},before=structuredClone(data);
 await f.adapter.run({projectId:'project',targetType:'NODE',targetId:'image',graph:{nodes:[{id:'image',type:'rh-image',data}],edges:[]}});
 const submitted=JSON.parse(f.transport.mock.calls.find(([path])=>path==='/api/v2/canvas-runs')![1]!.body as string).graph.nodes[0].data;
 expect(submitted.routerParameters).toEqual({outputPreset:preset});expect(submitted.params.outputPreset).toBe(preset);expect(data).toEqual(before);f.adapter.clear();
});
it.each([null,5,'landscape-2k',{},[]])('rejects invalid MOSS size %j instead of silently reusing a previous default',preset=>{
 expect(()=>routerParameters(cap,{params:{outputPreset:preset},routerParameters:{outputPreset:'1024-square'}})).toThrowError(expect.objectContaining({code:'MODEL_PARAMETER_INVALID'}));
});
it('keeps canonical/default fallback and uses current declared fields for every model identity',()=>{
 expect(routerParameters(cap,{})).toEqual({outputPreset:'1024-square'});
 expect(routerParameters(cap,{routerParameters:{outputPreset:'portrait-768x1344'}})).toEqual({outputPreset:'portrait-768x1344'});
 const data={params:{outputPreset:'ultrawide-1536x656'},routerParameters:{outputPreset:'1024-square'}};
 for(const other of [{...cap,capabilityRef:'another-image-v1'},{...cap,version:'2'},{...cap,model:{...cap.model!,providerRef:'other'}},{...cap,model:{...cap.model!,modelRef:'other'}}])expect(routerParameters(other,data)).toEqual({outputPreset:'ultrawide-1536x656'});
});
it('rejects reference images before submitting a MOSS canvas generation',async()=>{
 const f=fixture();
 await expect(f.adapter.run({projectId:'project',targetType:'NODE',targetId:'image',graph:{nodes:[{id:'image',type:'rh-image',data:{modelCode:cap.capabilityRef,capabilityVersion:'1',params:{prompt:'Paint a teapot',imageUrls:['rhtv-asset:reference']}}}],edges:[]}})).rejects.toMatchObject({code:'MODEL_INPUT_UNSUPPORTED'});
 expect(f.transport.mock.calls.some(([path])=>path==='/api/v2/canvas-runs')).toBe(false);f.adapter.clear();
});
