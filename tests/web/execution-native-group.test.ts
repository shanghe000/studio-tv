import {expect,it,vi} from 'vitest';
import {ExecutionAdapter} from '../../apps/web/src/service/execution';
import {ProductClient} from '../../apps/web/src/service/product-client';
import {ServiceStorage} from '../../apps/web/src/service/storage';
import {encodeGraph} from '../../apps/web/src/service/graph';

const profile:any={capabilityRef:'z-image-turbo-generate-v1',kind:'TEXT_TO_IMAGE',version:'1',parameterSchemaVersion:'1',available:true,testMode:false,inputKinds:['TEXT','STRUCTURED'],outputKinds:['IMAGE'],model:{providerRef:'comfy',modelRef:'z-image-turbo',title:'Z-Image-Turbo',version:'1'},parameterSchema:{type:'object',properties:{count:{type:'integer',enum:[1],default:1},outputPreset:{type:'string',enum:['1024-square'],default:'1024-square'}}}};
const json=(data:any)=>new Response(JSON.stringify({code:0,data}));

it.each(['normal','storyboard','normal-full-generate','stale-project','stale-manager'])('handles native %s group submission and session changes',async scenario=>{
 const groupType=scenario.startsWith('stale-')?'storyboard':scenario==='normal-full-generate'?'normal':scenario;
 const group={id:'group',type:'group',position:{x:20,y:30},data:{groupType,nodeIds:['one','two']}},members=['one','two'].map((id,i)=>({id,type:'rh-image',position:{x:50+i*400,y:80},data:{groupId:group.id,modelCode:profile.capabilityRef,subType:'text-image',params:{prompt:'USER '+id,outputPreset:'1024-square'}}}));
 const graph:any={nodes:[group,...members],edges:[]},command={nodes:members.map(({id,type,data})=>({id,type,data:structuredClone(data)})),edges:[]},requests:any[]=[],manager={getRemoteData:()=>graph,patchNodeData:vi.fn(),flushOperationQueue:vi.fn()};
 const api=new ProductClient('/api/v1',async(path,init:any)=>{
  const body=init?.body?JSON.parse(init.body):undefined;requests.push({path,body});
  if(path.includes('model-capabilities')){if(scenario==='stale-project')adapter.attach('different',manager);if(scenario==='stale-manager')adapter.attach('p',{...manager});return json({items:[profile],nextCursor:null});}
  if(path==='/api/v2/canvas-runs')return json({id:'task',projectId:'p',state:'SUCCEEDED',revision:1,testMode:false,plans:members.map(n=>({nodeId:n.id,executionId:'ex-'+n.id,state:'SUCCEEDED',outputs:[]}))});
  throw new Error('Unexpected route '+path);
 });api.setAccessToken('owner');const storage=new ServiceStorage(api,vi.fn()),adapter=new ExecutionAdapter(api,storage,async()=>{},vi.fn());
 storage.acceptRemoteSnapshot('p',{projectId:'p',revision:1,graph:encodeGraph(graph),updatedAt:'2026-10-22T04:00:00Z'},'"1"');storage.attachNativeView('p',graph);adapter.attach('p',manager);
 try{
  const pending=scenario==='normal-full-generate'?adapter.generate(group.id):adapter.run({projectId:'p',targetType:'GROUP',targetId:group.id,graph:command});
  if(scenario.startsWith('stale-')){await expect(pending).rejects.toMatchObject({code:'STALE_CANVAS_SESSION'});expect(requests.some(r=>r.path==='/api/v2/canvas-runs')).toBe(false);return;}
  const result=await pending;if(scenario==='normal-full-generate')expect(result).toBe(true);else expect((result as any).taskId).toBe('task');expect(manager.flushOperationQueue).toHaveBeenCalled();
  const submitted=requests.filter(r=>r.path==='/api/v2/canvas-runs');expect(submitted).toHaveLength(1);const body=submitted[0].body;
  expect(body.targetType).toBe('GROUP');expect(body.targetId).toBe(group.id);expect(body.graph.nodes).toHaveLength(3);
  for(const member of members){const frozen=body.graph.nodes.find((n:any)=>n.id===member.id);expect(frozen.parentId).toBe(group.id);expect(frozen.position).toEqual(member.position);expect(frozen.data.params).toEqual(member.data.params);expect(frozen.data.capabilityRef).toBe(profile.capabilityRef);}
  expect(graph.nodes.every((n:any)=>n.parentId===undefined)).toBe(true);expect(command.nodes.every((n:any)=>n.position===undefined)).toBe(true);
 }finally{adapter.clear();}
});
