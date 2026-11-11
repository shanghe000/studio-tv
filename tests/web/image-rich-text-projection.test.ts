// @vitest-environment happy-dom
import {readFileSync} from 'node:fs';
import {URL as FileURL} from 'node:url';
import {runInNewContext} from 'node:vm';
import {expect,it,vi} from 'vitest';
import {nativeImageComposedPrompt,nativeImageComposedReferences,normalizeNativeImagePrompt} from '../../apps/web/src/service/image-prompt-projection';
import {capabilityModel,ExecutionAdapter} from '../../apps/web/src/service/execution';
import {ProductClient} from '../../apps/web/src/service/product-client';
import {ServiceStorage} from '../../apps/web/src/service/storage';
import {encodeGraph} from '../../apps/web/src/service/graph';

const index=readFileSync(new FileURL('../../apps/web/public/project/assets/index-DeyN_Phq.js',import.meta.url),'utf8');
const fn=(name:string,next='function ')=>{const start=index.indexOf('function '+name+'('),end=index.indexOf(next,start+name.length+10);if(start<0||end<0)throw new Error('Frozen text projection seam changed: '+name);return index.slice(start,end);};
const textDeclarations=['zut','l_n','c_n','Vut','dJ'].map(name=>fn(name)).join('\n');
const nativeText=runInNewContext(textDeclarations+';({project:Vut,source:dJ})',{DOMParser,Node});
const types={RANDOM_ID:'randomId',MODEL_VOICE_TYPE:'modelVoiceType',SIZE_ASPECT_RATIO:'sizeAspectRatio',WH_ASPECT_RATIO:'whAspectRatio',IMAGE_URL:'imageUrl',IMAGE_URLS:'imageUrls'};
const modelDeclarations=[fn('MCe','function dNn('),fn('lNn','function cNn('),fn('cNn','function MCe('),fn('sNn')].join('\n');
const project=runInNewContext(textDeclarations+'\n'+modelDeclarations+'\n'+fn('q_','function eQr(')+';q_',{
 DOMParser,Node,ADe:structuredClone,dw:()=>[],nNn:()=> 'prompt',sd:(id:string,nodes:any[],edges:any[])=>edges.filter(edge=>edge.target===id).map(edge=>nodes.find(node=>node.id===edge.source)),As:(type:string)=>type==='rh-text',cJ:()=>[],j8:()=>({images:[],videos:[],audios:[]}),uJ:()=>[],Q0:()=>[],
 oNn:(node:any)=>({images:(node.data.sourceObjects??[]).map((url:string)=>({url,nodeId:node.id})),videos:[],audios:[]}),Np:(values:any[])=>values,eJ:(params:any,_config:any,media:any)=>{params.imageUrls=media.images.map((row:any)=>row.url);},aNn:()=>{},oft:()=>false,rft:()=>false,Ar:()=>false,no:()=>false,
 sft:(value:any)=>value,Yme:(value:string)=>value.trim(),mG:(value:any)=>value,uwe:()=>false,dNn:(value:any)=>value,hM:()=>null,J1e:()=>false,fNn:new Set(),_t:types,
});
const qwen:any={capabilityRef:'qwen-image-edit-2511-v1',version:'1',parameterSchemaVersion:'1',kind:'IMAGE_TO_IMAGE',available:true,testMode:false,executionKind:'JOB',model:{providerRef:'comfy',modelRef:'qwen-image-edit-2511',title:'Qwen-Image-Edit-2511',version:'1'},inputKinds:['TEXT','STRUCTURED','IMAGE'],outputKinds:['IMAGE'],parameterSchema:{type:'object',properties:{outputPreset:{type:'string',enum:['1024-square'],default:'1024-square'}},additionalProperties:false}};
function fixture(html='<p>A porcelain fox rests beside a blue cup.</p>'){
 const raw='A porcelain fox rests beside a blue cup.',model=capabilityModel(qwen),text={id:'text',type:'rh-text',position:{x:-400,y:0},data:{text:html,content:'Deliberately stale content cache',hidePromptInput:true}},uploaded=(id:string)=>({id,type:'rh-image',position:{x:-400,y:200},data:{isUpload:true,sourceObjects:['rhtv-asset:'+id]}});
 const graph:any={nodes:[{id:'target',type:'rh-image',position:{x:0,y:0},data:{modelCode:qwen.capabilityRef,subType:'image-image',prompt:raw,params:{prompt:raw,imageUrls:[],outputPreset:'1024-square'},hasUpstream:true,inheritedFrom:'text',generateNum:1}},text,uploaded('one'),uploaded('two'),uploaded('three'),uploaded('ancestor')],edges:[{source:'text',target:'target'},...['one','two','three'].map(source=>({source,target:'target'})),{source:'ancestor',target:'text'}]};
 graph.edges=graph.edges.map((edge:any,index:number)=>({...edge,id:'edge-'+index}));
 const command=project('target',graph.nodes,graph.edges,{modelConfig:model.config,promptOverride:raw});command.nodes[0].data.userPromptSnapshot={paramName:'prompt',value:raw};command.nodes[0].data.modelType=model.modelType;
 return{graph,command,raw,target:graph.nodes[0],source:text,model};
}
it('uses the frozen dJ/Vut rich-text source instead of rejecting HTML or selecting cached content',()=>{
 expect(index).toContain('Vut as bx');const f=fixture(),nativePrompt=f.command.nodes[0].data.params.prompt;
 expect(nativeText.source(f.source)).toBe(f.raw);expect(nativePrompt).toBe(f.raw+'\n'+f.raw);
 expect(nativeImageComposedPrompt(f.raw,f.target.data,f.target,f.graph)).toBeUndefined();
 expect(nativeImageComposedPrompt(f.raw,f.target.data,f.target,f.graph,nativeText.project)).toBe(nativePrompt);
 expect(normalizeNativeImagePrompt(f.command.nodes[0].data,f.target,f.graph,nativeText.project).params.prompt).toBe(f.raw);
 expect(nativeImageComposedReferences(f.target,f.graph,(value:string)=>value)).toEqual(['rhtv-asset:one','rhtv-asset:two','rhtv-asset:three']);
});
it('keeps frozen native table serialization exact',()=>{
 const f=fixture('<table><thead><tr><th>Subject</th><th>Color</th></tr></thead><tbody><tr><td>Fox | cup</td><td>Blue</td></tr></tbody></table>');
 expect(nativeText.source(f.source)).toBe('| Subject | Color |\n| --- | --- |\n| Fox \\| cup | Blue |');
 expect(nativeImageComposedPrompt(f.raw,f.target.data,f.target,f.graph,nativeText.project)).toBe(f.command.nodes[0].data.params.prompt);
});
it.each([undefined,()=>{throw new Error('broken native parser');},()=>42 as any])('fails closed for missing or invalid native text projection %s',port=>{
 const f=fixture();expect(nativeImageComposedPrompt(f.raw,f.target.data,f.target,f.graph,port)).toBeUndefined();expect(normalizeNativeImagePrompt(f.command.nodes[0].data,f.target,f.graph,port)).toBe(f.command.nodes[0].data);
});
it('does not accept an old rich-text command after the actual source changes',()=>{
 const f=fixture();f.source.data.text='<p>A newly authored instruction.</p>';expect(normalizeNativeImagePrompt(f.command.nodes[0].data,f.target,f.graph,nativeText.project)).toBe(f.command.nodes[0].data);
});
it.each(['conditioned','wrong-handle','unknown-source','selected-history'])('keeps mixed media %s references strict',change=>{
 const f=fixture(),edge=f.graph.edges.find((edge:any)=>edge.source==='one');if(change==='conditioned')edge.conditioningRole='STYLE';if(change==='wrong-handle')edge.sourceHandle='unsupported';if(change==='unknown-source')f.graph.nodes.find((node:any)=>node.id==='one').type='unknown';if(change==='selected-history')f.graph.nodes.find((node:any)=>node.id==='one').data.selectedOutputHistoryId='other';
 expect(nativeImageComposedReferences(f.target,f.graph,(value:string)=>value)).toBeUndefined();
});
it.each(['fresh','historical-text','explicit-text-change'])('guards an ordinary Qwen %s rich-text + three-reference frozen command without invoking a model',async mode=>{
 const f=fixture();if(mode==='historical-text'||mode==='explicit-text-change')f.target.data.params.text='An earlier result prompt';if(mode==='explicit-text-change')f.command.nodes[0].data.params.text='Unexpected command text';
 const requests:any[]=[],json=(data:any)=>new Response(JSON.stringify({code:0,data}),{headers:{ETag:'"'+(data.revision??1)+'"'}}),api=new ProductClient('/api/v1',async(path,options:any)=>{
  const body=options?.body?JSON.parse(options.body):undefined;requests.push({path,body});if(path.includes('model-capabilities'))return json({items:[qwen],nextCursor:null});if(path.startsWith('/api/v1/assets/'))return json({id:path.split('/').at(-1),kind:'IMAGE',state:'READY'});if(path==='/api/v1/projects/p/snapshot')return json({projectId:'p',revision:2,graph:body.graph,updatedAt:'2026-11-02T10:00:00Z'});if(path==='/api/v2/canvas-runs')return json({id:'task',projectId:'p',canvasManaged:true,state:'SUCCEEDED',revision:1,testMode:false,plans:[{nodeId:'target',executionId:'execution',state:'SUCCEEDED',canvasBinding:{applicationState:'APPLIED'},outputs:[]}]});if(path==='/api/v2/generation-diagnostics')return json({logId:'fixture-diagnostic'});throw new Error('Unexpected fixture request '+path);
 });api.setAccessToken('fixture-owner');const storage=new ServiceStorage(api,vi.fn()),execution=new ExecutionAdapter(api,storage,async()=>{},vi.fn());storage.acceptRemoteSnapshot('p',{projectId:'p',revision:1,graph:encodeGraph(f.graph),updatedAt:'2026-11-02T09:00:00Z'},'"1"');storage.attachNativeView('p',f.graph);execution.attach('p',{getRemoteData:()=>f.graph,patchNodeData:vi.fn(),flushOperationQueue:vi.fn()});
 const release=execution.setNativeTextProjection(nativeText.project);try{const run=execution.run({projectId:'p',targetType:'NODE',targetId:'target',graph:f.command});if(mode==='explicit-text-change'){await expect(run).rejects.toMatchObject({code:'STALE_EXECUTION_INPUT'});expect(requests.filter(row=>row.path==='/api/v2/canvas-runs')).toHaveLength(0);return;}await run;expect(requests.filter(row=>row.path==='/api/v2/canvas-runs')).toHaveLength(1);expect(requests.some(row=>row.path.includes('generation-diagnostics'))).toBe(false);const sent=requests.find(row=>row.path==='/api/v2/canvas-runs').body;expect(sent.graph.nodes.some((node:any)=>node.id==='ancestor')).toBe(true);expect(sent.graph.nodes.find((node:any)=>node.id==='target').data.params.prompt).toBe(f.raw);}finally{release();execution.clear();}
});
