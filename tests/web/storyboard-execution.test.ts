import {expect,it,vi} from 'vitest';
import fixture from './fixtures/storyboard-ui.json';
import {ExecutionAdapter} from '../../apps/web/src/service/execution';
import {ProductClient} from '../../apps/web/src/service/product-client';
import {ServiceStorage} from '../../apps/web/src/service/storage';

const json=(data:any)=>new Response(JSON.stringify({code:0,data}));
function setup(route:(path:string,init:any)=>Response|Promise<Response>){
 const transport=vi.fn(route),api=new ProductClient('/api/v1',transport);api.setAccessToken('owner');
 const notice=vi.fn(),adapter=new ExecutionAdapter(api,new ServiceStorage(api,vi.fn()),vi.fn().mockResolvedValue(undefined),notice);
 const graph={nodes:[structuredClone(fixture.node)],edges:[]};
 const patch=vi.fn((id:string,data:any)=>Object.assign(graph.nodes.find(node=>node.id===id)!.data,data));
 const manager={getRemoteData:()=>graph,patchNodeData:patch,flushOperationQueue:vi.fn()};
 return{transport,adapter,graph,patch,manager,notice};
}

it('repairs the already persisted successful cloned script using one read-only receipt, preserving raw data and current styles',async()=>{
 const control=setup(()=>json(fixture.task)),prior=structuredClone(control.graph.nodes[0].data);
 const live:any=control.graph.nodes[0].data;live.params.scene='comic';live.stylePrompt='new unsent user style';live.globalStyles='new unsent label';live.customBadgeText='正在生成分镜表，请稍后';live.pendingOutputScene='film';
 control.adapter.attach(fixture.task.projectId,control.manager);
 await vi.waitFor(()=>expect((live.output as any).rows).toHaveLength(2));
 expect(control.transport).toHaveBeenCalledOnce();expect(control.transport.mock.calls[0][0]).toBe('/api/v2/tasks/'+fixture.task.id);expect(control.transport.mock.calls[0][1]?.method??'GET').toBe('GET');
 expect(live.output.outputScene).toBe('film');expect(live.output.stylePrompt).toBe(fixture.task.plans[0].nodeSnapshot.data.stylePrompt);
 expect(live.output.globalStyles).toBe('电影写实');expect(live.stylePrompt).toBe('new unsent user style');expect(live.params.scene).toBe('comic');
 expect(live.presetSelections).toEqual(prior.presetSelections);expect(live.structuredOutput).toEqual(fixture.task.plans[0].outputs[0].data);expect(live.executionOutputs[0].data).toEqual(fixture.task.plans[0].outputs[0].data);
 expect(live.testMode).toBe(false);expect(live.customBadgeText).toBe('');expect(live.pendingOutputScene).toBeNull();expect(live.presentationError).toBeNull();
 const terminal=vi.fn();control.adapter.onTerminal(terminal);expect(terminal).toHaveBeenCalledOnce();expect(terminal.mock.calls[0][0]).toMatchObject({nodeId:fixture.node.id,taskId:fixture.task.id,status:'SUCCESS',manager:control.manager});
 expect(control.patch.mock.calls.every(([id])=>id===fixture.node.id)).toBe(true);expect(control.notice).not.toHaveBeenCalled();control.adapter.clear();
});

it('retains every unknown structured field and reports an unsupported display without making fake rows',async()=>{
 const task:any=structuredClone(fixture.task);task.plans[0].outputs[0].data={unexpected:{custom:['all','retained'],reference:{url:'https://untrusted.invalid/image.png'}}};
 const control=setup(()=>json(task)),live:any=control.graph.nodes[0].data;live.customBadgeText='用户自定义徽标';control.adapter.attach(task.projectId,control.manager);
 await vi.waitFor(()=>expect(live.presentationError?.code).toBe('STORYBOARD_PRESENTATION_UNSUPPORTED'));
 expect(Array.isArray(live.output)).toBe(true);expect(live.structuredOutput).toEqual(task.plans[0].outputs[0].data);expect(live.executionOutputs[0].data).toEqual(task.plans[0].outputs[0].data);expect(live.customBadgeText).toBe('用户自定义徽标');expect(live.status).toBe('finished');expect(control.notice).toHaveBeenCalledOnce();expect(control.transport).toHaveBeenCalledOnce();control.adapter.clear();
});

it('preserves authoritative TEST MODE when clearing a former script stage badge',async()=>{
 const task:any=structuredClone(fixture.task);task.testMode=true;task.plans[0].testMode=true;task.plans[0].outputs[0].testMode=true;
 const control=setup(()=>json(task)),live:any=control.graph.nodes[0].data;live.customBadgeText='正在生成分镜表，请稍后';control.adapter.attach(task.projectId,control.manager);
 await vi.waitFor(()=>expect(live.output.rows).toHaveLength(2));expect(live.testMode).toBe(true);expect(live.customBadgeText).toBe('TEST MODE');expect(live.title).toMatch(/^\[TEST MODE\]/);expect(live.executionOutputs[0].testMode).toBe(true);control.adapter.clear();
});

it('fences old restored receipt after a newer task changes the same live node',async()=>{
 let resolve!:(response:Response)=>void;const control=setup(()=>new Promise(done=>resolve=done)),terminal=vi.fn();control.adapter.onTerminal(terminal);control.adapter.attach(fixture.task.projectId,control.manager);
 (control.graph.nodes[0].data as any).taskId='new-task';(control.graph.nodes[0].data as any).status='processing';
 resolve(json(fixture.task));await new Promise(done=>setTimeout(done,0));expect(control.patch).not.toHaveBeenCalled();expect(terminal).not.toHaveBeenCalled();expect(control.graph.nodes[0].data.taskId).toBe('new-task');control.adapter.clear();
});

it('does not replace a newer persisted revision with an older task snapshot',async()=>{
 const task=structuredClone(fixture.task);task.revision=5;const control=setup(()=>json(task));control.adapter.attach(task.projectId,control.manager);
 await vi.waitFor(()=>expect(control.transport).toHaveBeenCalledOnce());await new Promise(done=>setTimeout(done,0));expect(control.patch).not.toHaveBeenCalled();expect(Array.isArray(control.graph.nodes[0].data.output)).toBe(true);control.adapter.clear();
});

it('does not apply an aborted restored read to another manager on the same project',async()=>{
 let resolve!:(response:Response)=>void;const control=setup(()=>new Promise(done=>resolve=done));control.adapter.attach(fixture.task.projectId,control.manager);
 const nextGraph={nodes:[{...structuredClone(fixture.node),data:{status:'idle'}}],edges:[]},nextPatch=vi.fn(),next={getRemoteData:()=>nextGraph,patchNodeData:nextPatch};control.adapter.attach(fixture.task.projectId,next);
 resolve(json(fixture.task));await new Promise(done=>setTimeout(done,0));expect(control.patch).not.toHaveBeenCalled();expect(nextPatch).not.toHaveBeenCalled();control.adapter.clear();
});
