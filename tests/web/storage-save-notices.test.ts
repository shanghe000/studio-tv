import {expect,it,vi} from 'vitest';
import {ProductClient} from '../../apps/web/src/service/product-client';
import {ServiceStorage} from '../../apps/web/src/service/storage';
import {encodeGraph,type NativeGraph} from '../../apps/web/src/service/graph';

const initial=():NativeGraph=>({nodes:[{id:'node',type:'rh-image',position:{x:0,y:0},data:{title:'Synthetic original'}}],edges:[]});
const reply=(data:any,status=200,revision?:number)=>new Response(JSON.stringify({code:status<400?0:'VERSION_CONFLICT',message:status<400?'OK':'Synthetic refusal',data}),{status,headers:revision?{ETag:'"'+revision+'"'}:{}});

it.each([true,false])('does not announce paused saving during definitive CAS catch-up (newer proof=%s)',async newerProof=>{
 let revision=1,storage!:ServiceStorage,puts=0;const graph=initial(),notices=vi.fn(),snapshot=()=>({projectId:'p',revision,graph:encodeGraph(graph),updatedAt:'2026-11-04T06:55:00Z'});
 const transport=vi.fn(async(path:string,init:any)=>{
  if(path.endsWith('/snapshot')&&init.method==='PUT'){
   puts++;if(newerProof){revision++;storage.acceptRemoteSnapshot('p',snapshot(),'"'+revision+'"');}return reply({},412);
  }
  if(path.endsWith('/snapshot'))return reply(snapshot(),200,revision);
  throw Error('Unexpected synthetic CAS notice route');
 });
 storage=new ServiceStorage(new ProductClient('/api/v1',transport),notices);storage.acceptRemoteSnapshot('p',snapshot(),'"1"');storage.attachNativeView('p',initial());const local=initial();local.nodes[0].data.title='Synthetic local edit';
 await expect(storage.queueSave('p',local)).rejects.toMatchObject({status:412});expect(puts).toBe(newerProof?3:1);expect(storage.draft('p')!.nodes[0].data.title).toBe('Synthetic local edit');expect(storage.isBlocked('p')).toBe(!newerProof);expect(notices).not.toHaveBeenCalled();
});

it('describes a real overlapping edit without asserting a second editor caused it',async()=>{
 const notices=vi.fn(),transport=vi.fn(async()=>{throw Error('Conflicted draft must not write');}),storage=new ServiceStorage(new ProductClient('/api/v1',transport),notices),graph=initial();
 storage.acceptRemoteSnapshot('p',{projectId:'p',revision:1,graph:encodeGraph(graph),updatedAt:'2026-11-04T06:55:00Z'},'"1"');storage.attachNativeView('p',graph);const remote=initial();remote.nodes[0].data.title='Synthetic remote edit';storage.acceptRemoteSnapshot('p',{projectId:'p',revision:2,graph:encodeGraph(remote),updatedAt:'2026-11-04T06:55:01Z'},'"2"');const local=initial();local.nodes[0].data.title='Synthetic local edit';
 await expect(storage.queueSave('p',local)).rejects.toMatchObject({code:'LOCAL_DRAFT_CONFLICT'});expect(storage.isBlocked('p')).toBe(true);expect(storage.draft('p')!.nodes[0].data.title).toBe('Synthetic local edit');expect(notices).toHaveBeenCalledWith('部分修改尚未同步，内容已保留，请重试同步。');expect(notices.mock.calls.flat().join(' ')).not.toContain('另一处');expect(transport).not.toHaveBeenCalled();
});
