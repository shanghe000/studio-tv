import {readFileSync} from 'node:fs';
import {expect,it,vi} from 'vitest';
import {decodeGraph,encodeGraph} from '../../apps/web/src/service/graph';
import {ProductClient} from '../../apps/web/src/service/product-client';
import {ServiceStorage} from '../../apps/web/src/service/storage';
import {restoreNativeH3InputSerialization} from '../../apps/web/src/service/native-h3-input-serialization';
import captured from './fixtures/native-h3-late-autosave.json';
import productionCaps from './fixtures/native-storyboard-h3-capabilities.json';

// Compare the data considered by the actual PostgreSQL lifecycle trigger,
// independently of the frontend normalizer's own list.
const sql=readFileSync(new URL('../../apps/api-go/migrations/024_measured_generation_progress.sql',import.meta.url),'utf8'),ignored=new Set([...sql.match(/ARRAY\[([\s\S]*?)\]/)![1].matchAll(/'([^']+)'/g)].map(m=>m[1]));
const semantic=(node:any)=>({type:node.type,data:Object.fromEntries(Object.entries(node.data).filter(([key])=>!ignored.has(key)))});
const json=(data:any)=>new Response(JSON.stringify({code:0,data}),{headers:{ETag:'"'+(data.revision??1)+'"'}});
function setup(ref='h3-action-reference-v1',preset='landscape-480p-5s',ratio='16:9',version='1'){
 const fixture=structuredClone(captured),prior=fixture.serverPrior,native=fixture.nativeAfter;
 for(const node of [prior,native]){node.data.params.outputPreset=preset;node.data.aspectRatio=ratio;if(node.data.params.aspectRatio)node.data.params.aspectRatio=ratio;if(node.data.routerParameters)node.data.routerParameters.outputPreset=preset;node.data.modelCode=ref;if(node.data.capabilityRef)node.data.capabilityRef=ref;if(node.data.capabilityVersion)node.data.capabilityVersion=version;if(node.data.parameterSchemaVersion)node.data.parameterSchemaVersion=version;if(node.data.params.rhModel)node.data.params.rhModel=ref;}
 const server={nodes:[prior],edges:[]},graph={nodes:[structuredClone(prior)],edges:[]},writes:any[]=[];
 const api=new ProductClient('/api/v1',async(path,init:any)=>{if(path==='/api/v1/projects/p/snapshot'){const body=JSON.parse(init.body);writes.push(body);return json({projectId:'p',revision:2,graph:body.graph,updatedAt:'2026-10-22T06:30:00Z'});}throw new Error('Unexpected '+path);});api.setAccessToken('owner');
 const storage=new ServiceStorage(api,vi.fn());storage.acceptRemoteSnapshot('p',{projectId:'p',revision:1,graph:encodeGraph(server),updatedAt:'2026-10-22T06:29:00Z'},'"1"');storage.attachNativeView('p',graph);
 // The initially coherent view is then replaced by the actual captured late
 // native serialization. This transition, not a fresh mount of the bad view,
 // is what turns those changes into a real autosave diff.
 graph.nodes[0]=native;
 return{fixture,prior,native,server,graph,writes,storage};
}
it.each(['h3-drama-reference-v1','h3-action-reference-v1'])('keeps the actual late native autosave input semantics for %s',async ref=>{
 const c=setup(ref),original=structuredClone(c.native);await c.storage.save('p',c.graph);expect(c.writes).toHaveLength(1);const saved=decodeGraph(c.writes[0].graph).nodes[0];expect(semantic(saved)).toEqual(semantic(c.prior));expect(saved.data.routerParameters).toEqual({outputPreset:'landscape-480p-5s'});expect(saved.data.userPromptSnapshot).toEqual(c.prior.data.userPromptSnapshot);expect(saved.data.params).not.toHaveProperty('rhModel');expect(saved.data.params).not.toHaveProperty('aspectRatio');expect(c.native).toEqual(original);expect(c.storage.isBlocked('p')).toBe(false);
});
it.each(['prompt','reference','model','preset','row','shot','style','source','history','output','unknown','snapshot','router','selector','ratio','version','ordinary'])('preserves a real changed or unsupported input: %s',async change=>{
 const c=setup(),data=c.native.data as any;
 if(change==='prompt'){data.params.prompt=data.params.text=data.prompt='A different user request';}if(change==='reference')data.params.imageUrls=['rhtv-asset:other'];if(change==='model')data.modelCode='h3-drama-reference-v1';if(change==='preset')data.params.outputPreset='portrait-768p-10s';if(change==='row')data.storyboardRowId='other';if(change==='shot')data.storyboardShot='other';if(change==='style')data.stylePrompt='other style';if(change==='source')data.toolsSourceUrl=['rhtv-asset:other'];if(change==='history')data.historyStorage.historyId='other';if(change==='output')data.output[0].assetId='other';if(change==='unknown')data.newSemanticField='must survive';if(change==='snapshot')data.userPromptSnapshot={paramName:'prompt',value:'other'};if(change==='router')data.routerParameters={outputPreset:'other'};if(change==='selector')data.params.rhModel='other';if(change==='ratio')data.params.aspectRatio='9:16';if(change==='version')data.capabilityVersion='2';if(change==='ordinary')data.isStoryboard=false;
 const bound=c.storage.restoreModelBindings('p',c.graph).nodes[0],restored=restoreNativeH3InputSerialization(bound,c.prior);expect(restored).toBe(bound);
 await c.storage.save('p',c.graph);const saved=decodeGraph(c.writes.at(-1).graph).nodes[0];expect(semantic(saved)).not.toEqual(semantic(c.prior));
 if(change==='prompt')expect(saved.data.params.prompt).toBe('A different user request');if(change==='reference')expect(saved.data.params.imageUrls).toEqual(['rhtv-asset:other']);if(change==='unknown')expect(saved.data.newSemanticField).toBe('must survive');
});
it.each(['before','after'])('normalizes observed draft projection and repeat autosave without accumulating metadata edits: %s',async stage=>{
 const c=setup(),original=structuredClone(c.native);if(stage==='before')c.storage.observeNativeDraft('p',c.graph);await c.storage.save('p',c.graph);
 expect(c.writes).toHaveLength(1);const acknowledged=structuredClone(c.storage.snapshots.get('p'));
 if(stage==='after')c.storage.observeNativeDraft('p',c.graph);
 expect(c.storage.hasDraft('p')).toBe(false);
 // Repeated native omissions normalize to the exact accepted content. The
 // ordinary no-op save barrier must not invent another revision or metadata
 // edit; actual prompt/reference/model changes remain guarded above.
 await c.storage.save('p',c.graph);expect(c.writes).toHaveLength(1);expect(c.storage.snapshots.get('p')).toEqual(acknowledged);expect(c.storage.hasDraft('p')).toBe(false);
 const saved=decodeGraph(c.writes[0].graph).nodes[0];expect(semantic(saved)).toEqual(semantic(c.prior));expect(saved.data.routerParameters).toEqual(c.prior.data.routerParameters);expect(saved.data.userPromptSnapshot).toEqual(c.prior.data.userPromptSnapshot);expect(saved.data.params).not.toHaveProperty('rhModel');expect(saved.data.params).not.toHaveProperty('aspectRatio');expect(c.native).toEqual(original);expect(c.storage.isBlocked('p')).toBe(false);
});
it('compares registered asset identity while retaining native display URLs in the returned copy',()=>{
 const c=setup(),bound=c.storage.restoreModelBindings('p',c.graph).nodes[0],ref=bound.data.params.imageUrls[0];bound.data.params.imageUrls[0]='https://owned.invalid/display';const original=structuredClone(bound),result=restoreNativeH3InputSerialization(bound,c.prior,value=>value==='https://owned.invalid/display'?ref:value);expect(result).not.toBe(bound);expect(result.data.params.imageUrls[0]).toBe('https://owned.invalid/display');expect(result.data.userPromptSnapshot).toEqual(c.prior.data.userPromptSnapshot);expect(bound).toEqual(original);
});

it.each([['h3-drama-reference-v1','landscape-480p-5s'],['h3-action-reference-v1','landscape-480p-5s'],['h3-drama-reference-v1','portrait-768p-10s'],['h3-drama-reference-v1','landscape-736p-10s']])('normalizes source-projected accepted %s/%s preset state without claiming a real render',async(ref,preset)=>{
 const cap=(productionCaps as any)[ref],spec=cap.parameterSchema['x-output-presets'].find((row:any)=>row.value===preset),c=setup(ref,preset,spec.aspectRatio);
 // Controlled projection of the captured autosave shape onto exact current
 // advertised presets; this test makes no 10-second GPU/output claim.
 await c.storage.save('p',c.graph);expect(semantic(decodeGraph(c.writes[0].graph).nodes[0])).toEqual(semantic(c.prior));
});
it.each([['h3-action-reference-v1','portrait-768p-10s','24:43'],['h3-drama-reference-v1','portrait-768p-10s','16:9'],['h3-drama-reference-v1','landscape-736p-10s','16:9'],['h3-drama-reference-v1','future-preset','9:5']])('does not normalize unsupported preset/ratio combinations %s/%s/%s',(ref,preset,ratio)=>{
 const c=setup(ref,preset,ratio),bound=c.storage.restoreModelBindings('p',c.graph).nodes[0];expect(restoreNativeH3InputSerialization(bound,c.prior)).toBe(bound);
});

const resolutionRatios=[['landscape-480p-5s','9:5'],['portrait-480p-5s','5:9'],['square-480p-5s','1:1'],['standard-480p-5s','4:3'],['standard-portrait-480p-5s','3:4'],['ultrawide-480p-5s','7:3'],['landscape-768p-5s','7:4'],['portrait-768p-5s','4:7'],['square-768p-5s','1:1'],['standard-768p-5s','4:3'],['standard-portrait-768p-5s','3:4'],['ultrawide-768p-5s','7:3']];
it.each(['h3-drama-reference-v2','h3-action-reference-v2'])('preserves all twelve exact %s receipt-bound inputs through late native save and reload projection',async ref=>{
 // Synthetic candidate receipts exercise serialization only. No GPU output
 // or candidate availability is established by these fixtures.
 for(const [preset,ratio]of resolutionRatios){
  const c=setup(ref,preset,ratio,'2'),before=structuredClone(c.native);await c.storage.save('p',c.graph);const saved=decodeGraph(c.writes[0].graph).nodes[0];expect(semantic(saved)).toEqual(semantic(c.prior));expect(saved.data).toMatchObject({capabilityRef:ref,capabilityVersion:'2',parameterSchemaVersion:'2',aspectRatio:ratio,routerParameters:{outputPreset:preset}});expect(c.native).toEqual(before);expect(c.storage.isBlocked('p')).toBe(false);
 }
});
it.each(['old-version','old-schema','wrong-ratio','nominal-ratio','unknown-preset','unknown-profile','changed-prompt','changed-reference','changed-router','extra-field'])('does not normalize an unproven candidate input: %s',change=>{
 const c=setup('h3-drama-reference-v2','landscape-768p-5s','7:4','2'),bound=c.storage.restoreModelBindings('p',c.graph).nodes[0],prior=c.prior;
 if(change==='old-version')bound.data.capabilityVersion=prior.data.capabilityVersion='1';if(change==='old-schema')bound.data.parameterSchemaVersion=prior.data.parameterSchemaVersion='1';if(change==='wrong-ratio')bound.data.aspectRatio=prior.data.aspectRatio='9:5';if(change==='nominal-ratio')bound.data.aspectRatio=prior.data.aspectRatio='16:9';if(change==='unknown-preset'){bound.data.params.outputPreset=prior.data.params.outputPreset='future-preset';prior.data.routerParameters.outputPreset='future-preset';}if(change==='unknown-profile'){bound.data.modelCode=bound.data.capabilityRef=prior.data.modelCode=prior.data.capabilityRef='h3-other-reference-v2';}if(change==='changed-prompt')bound.data.params.prompt='changed';if(change==='changed-reference')bound.data.params.imageUrls=['rhtv-asset:other'];if(change==='changed-router')bound.data.routerParameters={outputPreset:'other'};if(change==='extra-field')bound.data.unreviewed='must survive';
 expect(restoreNativeH3InputSerialization(bound,prior)).toBe(bound);
});
