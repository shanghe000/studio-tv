import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {expect,it,vi} from 'vitest';
import {completeNativeImageToolCommand,restoreCapturedImageResultMetadata} from '../../apps/web/src/service/image-tool-command';
const frozen=readFileSync(new URL('../../apps/web/public/project/assets/index-DeyN_Phq.js',import.meta.url),'utf8');
const slice=(start:string,end:string)=>frozen.slice(frozen.indexOf(start),frozen.indexOf(end,frozen.indexOf(start)+start.length));
const node=(id:string,data:any={})=>({id,type:'rh-image',position:{x:0,y:0},data});
const source=node('source',{sourceObjects:['rhtv-asset:owned']}),ancestor=node('ancestor',{sourceObjects:['rhtv-asset:earlier']});
const baseline=(target:any)=>({nodes:[ancestor,source,target],edges:[{id:'earlier',source:'ancestor',target:'source',sourceHandle:'output',targetHandle:'input'},{id:'current',source:'source',target:target.id,sourceHandle:'output',targetHandle:'input'}]});
async function nativeCommand(target:any,pair:boolean){
 let command:any;const code=[slice('async function uEt(','function $f(')].join('\n');
 const send=runInNewContext(code+';'+(pair?'uEt':'o_'),{cEt:async(_project:string,_target:string,graph:any)=>{command=graph;return true;},lEt:(node:any)=>node,Qye:(node:any)=>structuredClone(node)});
 if(pair)await send('p',target.id,source,target,'test');else await send('p',target,'test');return command;
}
it('recovers the actual frozen DEr/o_ panorama envelope and all captured source ancestors',async()=>{
 const target=node('result',{toolsType:'image-image',sceneCode:'canvas-image-panorama-image',panorama:{isPanoramaNode:true,locked:true}}),graph=baseline(target),command=await nativeCommand(target,false),completed=completeNativeImageToolCommand(command,graph,'result');
 expect(command.nodes).toHaveLength(1);expect(command.edges).toEqual([]);expect(completed).toEqual(graph);expect(command.nodes).toHaveLength(1);
});
it.each(['cutout','remove-text','quick-scene'])('recovers the actual frozen uEt %s envelope with default handles and deeper ancestry',async kind=>{
 const target=node('result',kind==='quick-scene'?{toolsType:'image-image',sceneCode:'canvas-image-quick-create-character-tri-view'}:{toolsType:kind==='cutout'?'image-cutout':'image-cutout-text'}),graph=baseline(target),command=await nativeCommand(target,true),completed=completeNativeImageToolCommand(command,graph,'result');
 expect(command.nodes).toHaveLength(2);expect(command.edges).toEqual([{source:'source',target:'result'}]);expect(completed).toEqual(graph);expect(command.edges[0]).not.toHaveProperty('sourceHandle');
});
it.each(['ordinary','unknown-scene','panorama-disabled','unknown-panorama'])('does not expand %s commands into a tool graph',async kind=>{
 const target=node('result',kind==='ordinary'?{toolsType:'image-image'}:kind==='unknown-scene'?{toolsType:'image-image',sceneCode:'canvas-image-quick-create-unknown'}:{toolsType:'image-image',sceneCode:kind==='unknown-panorama'?'canvas-image-panorama-unknown':'canvas-image-panorama-image',panorama:{isPanoramaNode:kind!=='panorama-disabled'}}),command=await nativeCommand(target,kind==='unknown-scene');
 expect(completeNativeImageToolCommand(command,baseline(target),'result')).toBe(command);
});
it.each(['wrong-source','conditioned','changed-handle','extra-edge-field','missing-source','duplicate-source'])('does not repair a forged or ambiguous %s native envelope',async change=>{
 const target=node('result',{toolsType:'image-cutout'}),graph:any=baseline(target),command:any=await nativeCommand(target,true);
 if(change==='wrong-source')command.edges[0].source='ancestor';if(change==='conditioned')graph.edges[1].conditioningRole='STYLE';if(change==='changed-handle')graph.edges[1].sourceHandle='mask';if(change==='extra-edge-field')command.edges[0].conditioningRole='STYLE';if(change==='missing-source')command.nodes[1].id='unmounted';if(change==='duplicate-source')graph.edges.push({...graph.edges[1],id:'ambiguous'});
 expect(completeNativeImageToolCommand(command,graph,'result')).toBe(command);
});
it('preserves submitted source changes for the managed semantic checker to reject',async()=>{
 const target=node('result',{toolsType:'image-cutout'}),graph=baseline(target),command=await nativeCommand(target,true);command.nodes[1].data.sourceObjects=['rhtv-asset:forged'];
 const completed=completeNativeImageToolCommand(command,graph,'result')!;expect(completed.nodes.find(node=>node.id==='source')!.data.sourceObjects).toEqual(['rhtv-asset:forged']);expect(graph.nodes[1].data.sourceObjects).toEqual(['rhtv-asset:owned']);
});

it('executes the frozen DEr builder and o_ sender before recovering its actual panorama graph',async()=>{
 let command:any,graph:any;const model={modelCode:'image-image-rhart-image-n-g31-flash-official',config:[{type:'prompt',paramName:'prompt'},{type:'imageUrls',paramName:'imageUrls'}]};
 const code=[slice('function GF(','function jd('),slice('function fEt(','function xEr('),slice('function xTe(','const wEr='),slice('async function uEt(','function $f('),slice('async function DEr(','const OEr=')].join('\n');
 const run=runInNewContext(code+';DEr',{nke:model.modelCode,Sye:'canvas-image-panorama-image',rn:{IMAGE_IMAGE:'image-image'},_t:{PROMPT:'prompt',IMAGE_URL:'imageUrl',IMAGE_URLS:'imageUrls'},nv:(row:any,type:string)=>row.config.find((field:any)=>field.type===type)?.paramName,Ie:{warning:vi.fn(),error:vi.fn()},sn:{t:(key:string)=>key},mS:()=>({w:380,h:280}),Vee:(height:number)=>Math.round(height*21/9),pEt:()=>0,dEt:()=>({x:500,y:0}),jd:()=> 'result',qp:(_source:any,target:any)=>{graph=baseline(target);},$f:vi.fn(),Qye:(node:any)=>structuredClone(node),lEt:(node:any)=>node,cEt:async(_project:string,_target:string,value:any)=>{command=value;return true;}});
 expect(await run({models:{'image-image':[model]},canvasId:'p',canvasName:'test'},source,'rhtv-asset:owned')).toBe(true);expect(command.nodes[0].data).toMatchObject({toolsType:'image-image',sceneCode:'canvas-image-panorama-image',panorama:{isPanoramaNode:true,locked:true},params:{prompt:'',imageUrls:['rhtv-asset:owned'],resolution:'2k'}});expect(completeNativeImageToolCommand(command,graph,'result')).toEqual(graph);
});

it('keeps native image parsing on its existing full-graph callback instead of expanding ordinary text envelopes',async()=>{
 const shell=readFileSync(new URL('../../apps/web/public/project/assets/CanvasEditorShell-Dt_89lTt.js',import.meta.url),'utf8'),start=shell.indexOf('Ia=p.useCallback(async(F,ge)=>'),end=shell.indexOf(',Ta=p.useMemo(',start),expression=shell.slice(start+3,end),target={id:'parsed',type:'rh-text',position:{x:500,y:0},data:{hidePromptInput:true,subType:'multimodal-text',params:{prompt:'original native parser',imageUrls:['rhtv-asset:owned']}}},graph=baseline(target),jr=vi.fn(async()=>true);
 const run=runInNewContext(expression,{p:{useCallback:(callback:any)=>callback},t:'p',q:{current:graph.nodes},W:{current:graph.edges},w:{name:'test'},Ae:{},de:vi.fn(),Nn:vi.fn(),o:(key:string)=>key,jr});
 expect(await run(target,source)).toBe(true);expect(jr.mock.calls[0][0]).toMatchObject({nodeId:'parsed',nodes:graph.nodes,edges:graph.edges,ctx:{params:target.data.params,subType:'multimodal-text'}});
 const omitted={nodes:[target],edges:[]};expect(completeNativeImageToolCommand(omitted,graph,'parsed')).toBe(omitted);
});


it('restores only captured generated-source metadata omitted by the native view',()=>{
 const result=node('generated',{sourceObjects:['rhtv-asset:current'],params:{prompt:'original'}}),target=node('target'),command={nodes:[result,target],edges:[]};
 const metadata={assetIds:['current'],batchOrigin:{taskId:'previous'},routerParameters:{count:1},testMode:false,userPromptSnapshot:{text:'old request'}},captured={...command,nodes:[{...result,data:{...result.data,...metadata}},target]};
 const restored=restoreCapturedImageResultMetadata(command,structuredClone(captured),captured,'target');expect(restored.nodes[0].data).toEqual({...result.data,...metadata});expect(command.nodes[0]).toBe(result);expect(restored.nodes[1]).toBe(target);
 for(const key of Object.keys(metadata)){const changed=structuredClone(captured);changed.nodes[0].data[key]='changed';const patched=restoreCapturedImageResultMetadata(command,changed,captured,'target');expect(patched.nodes[0].data[key]).toBeUndefined();}
 const changedImage={...command,nodes:[node('generated',{sourceObjects:['rhtv-asset:other']}),target]};expect(restoreCapturedImageResultMetadata(changedImage,captured,captured,'target')).toEqual(changedImage);
 expect(restoreCapturedImageResultMetadata(command,captured,undefined,'target')).toBe(command);
 const explicit={...command,nodes:[node('generated',{...result.data,routerParameters:{count:4}}),target]};expect(restoreCapturedImageResultMetadata(explicit,captured,captured,'target').nodes[0].data.routerParameters).toEqual({count:4});
});

it.each(['flux1-dev-generate-v1','flux2-klein-9b-generate-v1','qwen-image-edit-2511-v1'])('restores only unchanged execution metadata on the same historical %s source image',ref=>{
 const data:any={modelCode:ref,capabilityRef:ref,capabilityVersion:'1',parameterSchemaVersion:'1',historyStorage:{source:'remote',historyId:'exe_original'},sourceObjects:['rhtv-asset:current'],imageUrl:'rhtv-asset:current',output:[{url:'rhtv-asset:current',assetId:'current'}],params:{prompt:'original image request'}};
 const metadata={routerParameters:{outputPreset:'1024-square'},userPromptSnapshot:{paramName:'prompt',value:'original image request'}},target={id:'video',type:'rh-video',data:{modelCode:'h3-drama-reference-v1'}},command={nodes:[node('source',data),target],edges:[{source:'source',target:'video'}]},captured={...command,nodes:[node('source',{...data,...metadata}),target]};
 expect(restoreCapturedImageResultMetadata(command,structuredClone(captured),captured,'video').nodes[0].data).toEqual({...data,...metadata});
 for(const key of ['modelCode','capabilityRef','capabilityVersion','parameterSchemaVersion','historyStorage','sourceObjects','imageUrl','output','selectedHistoryOutputId','selectedOutputHistoryId']){
  const changed=structuredClone(command);changed.nodes[0].data[key]='changed';expect(restoreCapturedImageResultMetadata(changed,captured,captured,'video').nodes[0].data.routerParameters).toBeUndefined();
 }
 for(const key of Object.keys(metadata)){
  const changed=structuredClone(captured);changed.nodes[0].data[key]='new server value';expect(restoreCapturedImageResultMetadata(command,changed,captured,'video').nodes[0].data[key]).toBeUndefined();
 }
 const explicit=structuredClone(command);explicit.nodes[0].data.routerParameters={outputPreset:'changed'};expect(restoreCapturedImageResultMetadata(explicit,captured,captured,'video').nodes[0].data.routerParameters).toEqual({outputPreset:'changed'});
 expect(restoreCapturedImageResultMetadata(command,captured,captured,'source').nodes[0].data.routerParameters).toBeUndefined();
});

it.each(['flux1-dev-generate-v1','flux2-klein-9b-generate-v1','qwen-image-edit-2511-v1','z-image-turbo-generate-v1','flux2-klein4b-generate-v1'])('restores only native omitted result-selection defaults when reopening %s',ref=>{
 const data:any={modelCode:ref,capabilityRef:ref,capabilityVersion:'1',parameterSchemaVersion:'1',params:{prompt:'original USER prompt'},historyStorage:{source:'remote',schemaVersion:1,historyId:'exe_owned'},sourceObjects:['rhtv-asset:current'],imageUrl:'rhtv-asset:current',output:[{assetId:'current',outputId:'output1'}],nodeOutputHistory:[],selectedOutputHistoryIndex:0};
 const mounted=node('owner',data),saved={nodes:[mounted],edges:[]},omitted=structuredClone(data);delete omitted.nodeOutputHistory;delete omitted.selectedOutputHistoryIndex;
 const command={nodes:[node('owner',omitted)],edges:[]},restored=completeNativeImageToolCommand(command,saved,'owner')!;
 expect(restored.nodes[0].data).toEqual(data);expect(command.nodes[0].data).not.toHaveProperty('nodeOutputHistory');expect(restored.nodes[0].data.params).toEqual({prompt:'original USER prompt'});
 for(const key of ['historyStorage','sourceObjects','output']){
  const changed=structuredClone(command);changed.nodes[0].data[key]=key==='historyStorage'?{source:'remote',historyId:'exe_other'}:[];
  expect(completeNativeImageToolCommand(changed,saved,'owner')!.nodes[0].data).not.toHaveProperty('selectedOutputHistoryIndex');
 }
 const explicit=structuredClone(command);explicit.nodes[0].data.selectedOutputHistoryIndex=2;
 expect(completeNativeImageToolCommand(explicit,saved,'owner')!.nodes[0].data.selectedOutputHistoryIndex).toBe(2);
 const invalid=structuredClone(saved),invalidCommand=structuredClone(command);delete invalid.nodes[0].data.historyStorage.schemaVersion;delete invalidCommand.nodes[0].data.historyStorage.schemaVersion;
 expect(completeNativeImageToolCommand(invalidCommand,invalid,'owner')!.nodes[0].data).not.toHaveProperty('nodeOutputHistory');
});

const selectedTextFixture=JSON.parse(readFileSync(new URL('./fixtures/native-selected-text-image-command.json',import.meta.url),'utf8'));
it('restores the captured selected-text command ancestor while retaining its exact submitted inputs',()=>{
 const {command,baseline,targetId}=structuredClone(selectedTextFixture),completed=completeNativeImageToolCommand(command,baseline,targetId)!;
 expect(command.nodes).toHaveLength(2);expect(command.edges).toHaveLength(1);expect(completed.nodes).toHaveLength(3);expect(completed.edges).toEqual(baseline.edges);
 expect(completed.nodes.find(n=>n.id===targetId)).toEqual(command.nodes[0]);expect(completed.nodes.find(n=>n.id===command.nodes[1].id)).toEqual(command.nodes[1]);
 expect(completed.nodes.find(n=>n.id===baseline.nodes[0].id)).toEqual(baseline.nodes[0]);
});
it.each(['tool','conditioned','changed-source-handle','extra-edge-field','missing-source','duplicate-edge','wrong-source-type'])('does not expand a %s text-source command',change=>{
 const {command,baseline,targetId}=structuredClone(selectedTextFixture),target=command.nodes[0],source=command.nodes[1],edge=baseline.edges.find((e:any)=>e.target===targetId);
 if(change==='tool')target.data.toolsType='IMAGE_CUTOUT';
 if(change==='conditioned')edge.conditioningRole='REFERENCE';
 if(change==='changed-source-handle')edge.sourceHandle='mask';
 if(change==='extra-edge-field')command.edges[0].id='forged';
 if(change==='missing-source')baseline.nodes=baseline.nodes.filter((n:any)=>n.id!==source.id);
 if(change==='duplicate-edge')baseline.edges.push({...edge,id:'another'});
 if(change==='wrong-source-type')baseline.nodes.find((n:any)=>n.id===source.id).type='rh-image';
 expect(completeNativeImageToolCommand(command,baseline,targetId)).toBe(command);
});
it('retains changed submitted text for the semantic checker instead of replacing it with captured text',()=>{
 const {command,baseline,targetId}=structuredClone(selectedTextFixture);command.nodes[1].data.text='newer source input';
 expect(completeNativeImageToolCommand(command,baseline,targetId)!.nodes.find(n=>n.id===command.nodes[1].id)!.data.text).toBe('newer source input');
});
it('restores only missing execution metadata of the exact captured historical text source',()=>{
 const textNode:any={id:'text',type:'rh-text',data:{modelCode:'codex-6-1-text-v1',capabilityRef:'codex-6-1-text-v1',capabilityVersion:'2',parameterSchemaVersion:'1',params:{prompt:'write original'},text:'current edited text',content:'current edited text',output:[{text:'original generated text'}],historyStorage:{source:'remote',historyId:'exe_original'}}},target=node('target'),command={nodes:[textNode,target],edges:[{source:'text',target:'target'}]},metadata={routerParameters:{reasoning_effort:'low'},userPromptSnapshot:{paramName:'prompt',value:'write original'}},captured={...command,nodes:[{...textNode,data:{...textNode.data,...metadata}},target]};
 expect(restoreCapturedImageResultMetadata(command,structuredClone(captured),captured,'target').nodes[0].data).toEqual({...textNode.data,...metadata});
 for(const key of ['modelCode','capabilityRef','capabilityVersion','parameterSchemaVersion','params','text','content','output','historyStorage','selectedHistoryOutputId','selectedOutputHistoryId','selectedOutputHistoryIndex']){
  const changed=structuredClone(command);changed.nodes[0].data[key]='changed';expect(restoreCapturedImageResultMetadata(changed,captured,captured,'target').nodes[0].data.routerParameters).toBeUndefined();
 }
 for(const key of Object.keys(metadata)){
  const changed=structuredClone(captured);changed.nodes[0].data[key]='new receipt';expect(restoreCapturedImageResultMetadata(command,changed,captured,'target').nodes[0].data[key]).toBeUndefined();
 }
 const explicit=structuredClone(command);explicit.nodes[0].data.routerParameters={reasoning_effort:'high'};expect(restoreCapturedImageResultMetadata(explicit,captured,captured,'target').nodes[0].data.routerParameters).toEqual({reasoning_effort:'high'});
 expect(restoreCapturedImageResultMetadata(command,captured,captured,'text').nodes[0].data.routerParameters).toBeUndefined();
 const parser=structuredClone(command);parser.nodes[0].data.hidePromptInput=true;expect(restoreCapturedImageResultMetadata(parser,captured,captured,'target').nodes[0].data.routerParameters).toBeUndefined();
});
