import {expect,it,vi} from 'vitest';
import {ProductClient} from '../../apps/web/src/service/product-client';
import {ServiceStorage} from '../../apps/web/src/service/storage';
import {encodeGraph} from '../../apps/web/src/service/graph';

it('keeps native-stripped server progress out of autosave drafts across phase changes',()=>{
 const api=new ProductClient('/api/v1',vi.fn());api.setAccessToken('owner');
 const storage=new ServiceStorage(api,vi.fn()),graph:any={nodes:[{id:'node',type:'rh-video',position:{x:0,y:0},data:{taskId:'tsk_current',status:'processing',params:{prompt:'same input'},progress:50,progressDetail:{phase:'sampling',scope:'SAMPLING'}}}],edges:[]};
 const snapshot=(revision:number)=>({projectId:'project',revision,graph:encodeGraph(graph),updatedAt:'2026-10-21T12:00:00Z'});
 const native=structuredClone(graph);delete native.nodes[0].data.progress;delete native.nodes[0].data.progressDetail;
 storage.acceptRemoteSnapshot('project',snapshot(1),'"1"');storage.attachNativeView('project',native);storage.observeNativeDraft('project',native);
 expect(storage.hasDraft('project')).toBe(false);
 graph.nodes[0].data.progress=null;graph.nodes[0].data.progressDetail={phase:'decoding',scope:'SAMPLING'};
 storage.acceptRemoteSnapshot('project',snapshot(2),'"2"');storage.observeNativeDraft('project',native);
 expect(storage.hasDraft('project')).toBe(false);
 storage.remoteNativeViewApplied('project',native);storage.observeNativeDraft('project',native);
 expect(storage.hasDraft('project')).toBe(false);
 expect(storage.mergedNativeView('project').graph.nodes[0].data).toMatchObject({progress:null,progressDetail:{phase:'decoding'}});
 native.nodes[0].data.params.prompt='actual local edit';storage.observeNativeDraft('project',native);
 expect(storage.hasDraft('project')).toBe(true);
});

it('does not restore a previous task observation into a new task or recreated node',()=>{
 const api=new ProductClient('/api/v1',vi.fn());api.setAccessToken('owner');const storage=new ServiceStorage(api,vi.fn());
 const graph:any={nodes:[{id:'node',type:'rh-video',position:{x:0,y:0},data:{taskId:'tsk_old',status:'processing',progress:50,progressDetail:{phase:'sampling',scope:'SAMPLING'}}}],edges:[]};
 storage.acceptRemoteSnapshot('p',{projectId:'p',revision:1,graph:encodeGraph(graph),updatedAt:'2026-10-21T12:00:00Z'},'"1"');storage.attachNativeView('p',graph);
 const recreated=structuredClone(graph);recreated.nodes[0].data={taskId:'tsk_new',status:'processing'};storage.observeNativeDraft('p',recreated);
 expect(storage.mergedNativeView('p').graph.nodes[0].data.progressDetail).toBeUndefined();
});
