import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {it,expect,vi} from 'vitest';
import catalog from './fixtures/canvas-catalog-audit-20261104.json';
import {nodeToolReason} from '../../apps/web/src/service/node-tool-contract';
import {ExecutionAdapter} from '../../apps/web/src/service/execution';
import {ProductClient} from '../../apps/web/src/service/product-client';
import {ServiceStorage} from '../../apps/web/src/service/storage';
import {exportNodeAction} from './helpers/export-node-action';
const shell=readFileSync(new URL('../../apps/web/public/project/assets/CanvasEditorShell-Dt_89lTt.js',import.meta.url),'utf8');
const caps=catalog.filter(c=>c.parameterSchema?.['x-reference-requirement']==='ANY_MEDIA'&&c.outputKinds.includes('VIDEO'));
it('offers the audio shortcut for the five audio-only profiles, not visual-only profiles or unconfigured accounts',()=>{
 expect(caps).toHaveLength(5);expect(nodeToolReason('audio-video',catalog)).toContain('当前账号');
 for(const c of catalog.filter(c=>c.model&&c.outputKinds.includes('VIDEO')))
  expect(nodeToolReason('audio-video',[{...c,available:true}])===null,c.capabilityRef).toBe(caps.includes(c));
});
it.each(caps)('submits the frozen audio-to-video shortcut with only the connected audio via $capabilityRef',async row=>{
 const cap=structuredClone(row);cap.available=true;cap.reason=undefined;const schema=cap.parameterSchema as any;schema['x-model-source'].credentialConfigured=true;delete schema['x-model-source'].unavailableCode;
 const source={id:'source',type:'rh-audio',position:{x:0,y:0},data:{isUpload:true,sourceObjects:['rhtv-asset:a-audio']}},graph:any={nodes:[source],edges:[]};
 const native={addNode:(node:any)=>graph.nodes.push(node),addEdge:(edge:any)=>graph.edges.push(edge)};
 const shortcut=runInNewContext(shell.slice(shell.indexOf('function Fv(t)'),shell.indexOf('const T8=new Set'))+';I8',{cn:(type:string,position:any,{data}:any)=>({id:'result',type,position,data}),Fe:()=>native,ES:(fn:()=>void)=>fn(),ft:{getState:()=>({setSelectedNodeIds:()=>{}})}});
 shortcut('audio-to-video',source,(s:string)=>s);
 const target=graph.nodes.at(-1);
 expect(target.data.generationMode).toBe('audio-to-video');expect(graph.edges).toMatchObject([{source:'source',target:'result',sourceHandle:'output',targetHandle:'input'}]);
 // As in a normal video node, the user selects the eligible omni model and a preset.
 Object.assign(target.data,{modelCode:cap.capabilityRef,capabilityVersion:cap.version,subType:'multimodal-video',params:{prompt:'镜头跟随节奏',outputPreset:schema.properties.outputPreset.default}});
 let body:any;const ok=(data:any)=>new Response(JSON.stringify({code:0,data}));
 const api=new ProductClient('/api/v1',async(path,init:any)=>{
  if(path.includes('/model-capabilities'))return ok({items:[cap],nextCursor:null});
  if(path==='/api/v1/assets/a-audio')return ok({id:'a-audio',state:'READY',kind:'AUDIO',durationSeconds:6,byteSize:30000,mimeType:'audio/wav'});
  if(path==='/api/v2/canvas-runs'){body=JSON.parse(init.body);exportNodeAction(init);return ok({id:'task',state:'SUCCEEDED',plans:[]});}
  throw Error(path);
 });
 api.setAccessToken('test');const ex=new ExecutionAdapter(api,new ServiceStorage(api,vi.fn()),async()=>{},vi.fn());
 try{await ex.run({projectId:'p',targetType:'NODE',targetId:'result',graph});expect(body.graph.nodes.find((n:any)=>n.id==='result').data).toMatchObject({capabilityRef:cap.capabilityRef,promptSelection:{referenceBindings:[{assetId:'a-audio',role:'REFERENCE_AUDIO'}]}});}
 finally{ex.clear();}
});
